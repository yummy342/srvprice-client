'use strict';

// 页面侧：回传状态（白名单字段）+ 执行 steps 里的浏览器动作。
// 硬规则：密钥/验证码/密码输入框的值永远不读、不回传、不写日志。

(function () {
  let stepId = '';
  let reporting = false;

  // ---- 页面内浮层（Shadow DOM，不污染页面样式）----
  let ui = null;
  function ensureOverlay() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = 'srvprice-client-overlay';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = [
      '<style>',
      '.card{position:fixed;right:16px;bottom:16px;width:300px;z-index:2147483647;',
      'background:#1f2430;color:#e8eaed;border-radius:10px;padding:12px 14px;',
      'font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}',
      '.t{font-weight:600;font-size:13px;margin-bottom:2px}',
      '.s{color:#9aa4b2;font-size:12px;margin-bottom:6px}',
      '.m{white-space:pre-wrap;word-break:break-word}',
      '.row{display:flex;gap:8px;margin-top:10px}',
      'button{flex:1;padding:6px 10px;border-radius:6px;border:0;cursor:pointer;font:inherit}',
      '.ack{background:#3b82f6;color:#fff}.close{background:#374151;color:#cbd5e1}',
      '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}',
      '</style>',
      '<div class="card">',
      '<div class="t"><span class="dot" id="dot" style="background:#3b82f6"></span><span id="title">srvprice</span></div>',
      '<div class="s" id="step"></div>',
      '<div class="m" id="msg"></div>',
      '<div class="row"><button class="ack" id="ack" style="display:none">我已完成</button>',
      '<button class="close" id="close">收起</button></div>',
      '</div>'
    ].join('');
    document.documentElement.appendChild(host);
    const refs = {
      host,
      dot: root.getElementById('dot'),
      title: root.getElementById('title'),
      step: root.getElementById('step'),
      msg: root.getElementById('msg'),
      ack: root.getElementById('ack'),
      close: root.getElementById('close')
    };
    refs.close.addEventListener('click', () => { host.style.display = 'none'; });
    ui = refs;
    return ui;
  }

  function showOverlay(p) {
    const o = ensureOverlay();
    o.host.style.display = '';
    if (p.title) o.title.textContent = p.title;
    o.step.textContent = p.step ? String(p.step) : '';
    o.msg.textContent = p.message ? String(p.message) : '';
    const color = p.status === 'fail' ? '#ef4444'
      : (p.status === 'waiting' || p.status === 'human') ? '#f59e0b'
      : p.status === 'done' ? '#22c55e' : '#3b82f6';
    o.dot.style.background = color;
    const ackText = p.ack || '';
    if (ackText) {
      o.ack.style.display = '';
      o.ack.textContent = ackText;
      o.ack.onclick = () => {
        chrome.runtime.sendMessage({ type: 'srvprice:prompt_result', id: p.id || '', action: 'ack' },
          () => void chrome.runtime.lastError);
        o.ack.style.display = 'none';
        o.msg.textContent = '已确认，等待下一步…';
      };
    } else {
      o.ack.style.display = 'none';
    }
  }

  const SENSITIVE_HINT = /(secret|password|passwd|verify|captcha|otp|sms|验证码|密钥|密码)/i;

  function isSensitiveInput(el) {
    if (!el) return false;
    if (String(el.type || '').toLowerCase() === 'password') return true;
    return SENSITIVE_HINT.test(String(el.name || '') + ' ' + String(el.id || '') +
      ' ' + String(el.getAttribute && el.getAttribute('placeholder') || ''));
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  }

  function textOf(el) {
    return ((el.innerText || el.textContent || '') + '').trim();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 穿透 shadow root：火山控制台等内容可能是 Web Components
  function allRoots() {
    const roots = [document];
    const walk = (root) => {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of els) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  }

  function bodyText() {
    let t = document.body ? String(document.body.innerText || '') : '';
    for (const r of allRoots()) {
      if (r !== document) t += ' ' + (r.textContent || '');
    }
    return t;
  }

  function matchesPattern(pattern) {
    const parts = String(pattern || '').split('|').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return false;
    const t = bodyText();
    return parts.some((p) => t.includes(p));
  }

  // 每一步执行后按 verify / fail_when 判定（派单 §1：做完跑 verify，命中 fail_when 就停）
  async function evaluateVerify(step) {
    const v = (step && step.verify) || {};
    const f = (step && step.fail_when) || {};
    const timeout = Math.max(500, Number(v.timeout_ms || 8000));
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (f.text && matchesPattern(f.text)) return { ok: false, error: 'fail_when 命中：' + f.text };
      if (!v.text || matchesPattern(v.text)) return { ok: true, detail: 'verified' };
      await sleep(400);
    }
    return { ok: false, error: 'verify 未命中：' + (v.text || '') };
  }

  function candidates() {
    const sel = 'button, a, [role="button"], [role="radio"], input[type="button"], input[type="submit"], label, li, td, th, span, div';
    const out = [];
    for (const r of allRoots()) {
      try { out.push(...r.querySelectorAll(sel)); } catch (_) {}
    }
    return out;
  }

  // 文本 / 可访问性树匹配（不用 CSS 选择器）
  function findElement(match) {
    if (!match) return null;
    const wanted = String(match.text || match.label || match.name || '')
      .split('|').map((s) => s.trim()).filter(Boolean);
    if (!wanted.length) return null;
    const role = match.role ? String(match.role).toLowerCase() : '';
    const list = candidates().filter(visible);
    let best = null;
    for (const el of list) {
      const aria = String(el.getAttribute('aria-label') || el.getAttribute('title') || '');
      const label = String(el.value || '') + ' ' + aria + ' ' + textOf(el);
      if (role) {
        const elRole = String(el.getAttribute('role') || '').toLowerCase() ||
          (el.tagName === 'BUTTON' ? 'button' : (el.tagName === 'A' ? 'link' : ''));
        if (elRole && elRole !== role) continue;
      }
      for (const w of wanted) {
        if (label.trim() === w) return el;
        if (label.includes(w)) { if (!best) best = el; }
      }
    }
    return best;
  }

  function findInput(field) {
    const m = field.match || {};
    const wanted = String(m.label || m.text || m.name || '').toLowerCase();
    const inputs = [];
    for (const r of allRoots()) {
      try { inputs.push(...r.querySelectorAll('input, textarea, select')); } catch (_) {}
    }
    const visibleInputs = inputs.filter(visible);
    for (const el of visibleInputs) {
      const hay = [
        el.getAttribute('placeholder'), el.getAttribute('aria-label'),
        el.getAttribute('name'), el.id,
        el.labels && el.labels.length ? el.labels[0].innerText : ''
      ].map((x) => String(x || '').toLowerCase()).join(' ');
      if (wanted && hay.includes(wanted)) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function executeStep(step) {
    const d = step && step.do || {};
    const action = d.action;
    if (step && step.step_id) stepId = step.step_id;
    // 每执行一步自动显示当前动作（内部轮询/探针不显示，避免刷屏）
    const VISIBLE = new Set(['open', 'navigate', 'click', 'fill_form', 'attach_policy', 'read_fields', 'wait', 'scroll', 'overlay']);
    if (VISIBLE.has(action)) {
      showOverlay({
        title: 'srvprice 客户端',
        step: step && step.step_id ? '步骤：' + step.step_id : '',
        message: '正在执行：' + action,
        status: 'running'
      });
    }

    if (action === 'open' || action === 'navigate') {
      const url = d.url || (step.entry) || '';
      if (!url) return { ok: false, error: 'no url' };
      setTimeout(() => { location.href = url; }, 30);
      return { ok: true, detail: 'navigating' };
    }

    if (action === 'click') {
      const el = findElement(d.match);
      if (!el) return { ok: false, error: 'element not found' };
      el.click();
      await sleep(300);
      const v = await evaluateVerify(step);
      return v.ok ? { ok: true, detail: textOf(el).slice(0, 60) } : v;
    }

    if (action === 'fill_form') {
      const done = [];
      for (const f of d.fields || []) {
        const el = findInput(f);
        if (!el) return { ok: false, error: 'input not found: ' + JSON.stringify(f.match || {}) };
        if (f.action === 'check') {
          if (!el.checked) el.click();
          done.push('check:' + (textOf(el.labels && el.labels[0]) || el.name || ''));
        } else {
          if (isSensitiveInput(el)) return { ok: false, error: 'refuse to fill sensitive input' };
          setNativeValue(el, String(f.value || ''));
          done.push('fill:' + (el.name || el.id || 'input'));
        }
      }
      const v = await evaluateVerify(step);
      return v.ok ? { ok: true, detail: done } : v;
    }

    if (action === 'attach_policy') {
      const inputs = [];
      for (const r of allRoots()) {
        try { inputs.push(...r.querySelectorAll('input')); } catch (_) {}
      }
      const visibleInputs = inputs.filter(visible);
      const box = visibleInputs.find((el) => /搜索|search|策略/.test(
        String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '')));
      if (box) {
        setNativeValue(box, String(d.search || ''));
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
      }
      const target = findElement({ text: String(d.select || d.search || '') });
      if (!target) return { ok: false, error: 'policy not found: ' + (d.select || d.search) };
      target.click();
      await sleep(300);
      const v = await evaluateVerify(step);
      return v.ok ? { ok: true, detail: 'clicked ' + textOf(target).slice(0, 60) } : v;
    }

    if (action === 'read_fields') {
      // 只回“有没有”，**绝不回值**；敏感框连 presence 都标出来，值一律不读。
      const res = [];
      for (const name of d.fields || []) {
        const el = findInput({ match: { label: name } });
        const sens = isSensitiveInput(el);
        res.push({ name, present: !!el, sensitive: sens });
      }
      return { ok: true, detail: res };
    }

    if (action === 'wait') {
      await new Promise((r) => setTimeout(r, Number(d.ms || 1000)));
      return { ok: true, detail: 'waited' };
    }

    if (action === 'report') {
      // 排障用：立刻回传一次页面状态
      await reportState();
      return { ok: true, detail: 'reported' };
    }

    if (action === 'page_info') {
      // 校准排障：回传页面文本样本和可见按钮/链接文案（不读输入框的值）
      const seen = new Set();
      const buttons = [];
      for (const el of candidates().filter(visible)) {
        const t = textOf(el).replace(/\s+/g, ' ').slice(0, 40);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        buttons.push(t);
        if (buttons.length >= 80) break;
      }
      return {
        ok: true,
        detail: {
          url: location.href,
          title: document.title,
          text_sample: bodyText().replace(/\s+/g, ' ').slice(0, 1200),
          buttons
        }
      };
    }

    if (action === 'overlay') {
      // 排障/直达：直接显示浮层（不经过广播）
      showOverlay(d.overlay || { title: 'srvprice 客户端', message: '测试浮层', status: 'running' });
      return { ok: true, detail: 'overlay shown' };
    }

    if (action === 'run_command') {
      // 命令由本地客户端执行，页面侧不执行任何 shell
      return { ok: false, error: 'run_command is daemon-side' };
    }

    return { ok: false, error: 'unsupported action: ' + action };
  }

  // 客户端推来的浮层内容（进度 / 人机门）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'srvprice:overlay') {
      showOverlay(msg.overlay || {});
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'srvprice:exec') return;
    executeStep(msg.step).then((r) => {
      sendResponse(r || { ok: false, error: 'empty result' });
    }).catch((e) => {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true; // 异步响应
  });

  async function sha256Hex(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return '';
    }
  }

  async function reportState() {
    if (reporting) return;
    reporting = true;
    try {
      const body = document.body ? String(document.body.innerText || '') : '';
      const hash = await sha256Hex(body.slice(0, 50000));
      chrome.runtime.sendMessage({
        type: 'srvprice:state',
        state: {
          url: location.href,
          page: document.title,
          step_id: stepId,
          visible_text_hash: hash
        }
      }, () => void chrome.runtime.lastError);
    } finally {
      reporting = false;
    }
  }

  reportState();
  setInterval(reportState, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reportState();
  });

  // ---- 记录模式（P1 自学习）：只记语义动作，不记坐标；密码/验证码类输入直接跳过 ----
  let recording = false;
  let recInstalled = false;
  function recText(el) {
    return String((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }
  function recSensitive(el) {
    if (!el) return false;
    if (String(el.type || '').toLowerCase() === 'password') return true;
    return /(secret|password|passwd|verify|captcha|otp|sms|验证码|密码|密钥)/i.test(
      String(el.name || '') + ' ' + String(el.id || '') + ' ' +
      String((el.getAttribute && el.getAttribute('placeholder')) || ''));
  }
  let lastRec = { key: '', t: 0 };
  function recSend(ev, key) {
    const now = Date.now();
    // 同一目标 800ms 内只记一次：容器/子元素会连续触发 click
    if (key && key === lastRec.key && now - lastRec.t < 800) return;
    lastRec = { key: key || '', t: now };
    try { chrome.runtime.sendMessage({ type: 'srvprice:record', event: ev }); } catch (_) {}
  }
  function installRecorder() {
    if (recInstalled) return;
    recInstalled = true;
    document.addEventListener('click', (e) => {
      if (!recording) return;
      let el = e.target;
      for (let i = 0; i < 5 && el; i++) {
        if (recText(el)) break;
        el = el.parentElement;
      }
      if (!el) return;
      const text = recText(el) ||
        String((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').trim();
      if (!text) return;
      recSend({ action: 'click', match: { text }, page_title: document.title, url: location.href, t: Date.now() },
        'click|' + text);
    }, true);
    document.addEventListener('change', (e) => {
      if (!recording) return;
      const el = e.target;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (recSensitive(el)) return;
      const value = String(el.value == null ? '' : el.value).slice(0, 200);
      if (!value) return;
      const hint = el.getAttribute('name') || el.id || el.getAttribute('placeholder') || '';
      recSend({ action: 'fill_form', match: { text: hint }, value, page_title: document.title, url: location.href, t: Date.now() });
    }, true);
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'srvprice:record-start') { recording = true; installRecorder(); sendResponse({ ok: true }); return true; }
    if (msg.type === 'srvprice:record-stop') { recording = false; sendResponse({ ok: true }); return true; }
  });
})();
