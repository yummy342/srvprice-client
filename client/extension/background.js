'use strict';

// 扩展后台：连本地桥（127.0.0.1:8790），做鉴权、转发 exec、回传 state、播报 voice。
// 安全：只连 127.0.0.1；hello 带每次安装的 token + chrome-extension:// 来源；
//       收到的 state 只含 {url,page,step_id,visible_text_hash}。

const DEFAULT_PORT = 8790;
let ws = null;

// 记录模式（P1 自学习）：开关 + 语义事件缓冲
let recorder = null;
const recEvents = [];
const REC_MAX = 300;

async function recordBroadcast(type) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return; }
  for (const t of tabs) {
    if (!t.id || !t.url || !/^https?:/.test(t.url)) continue;
    try {
      await chrome.tabs.sendMessage(t.id, { type });
    } catch (_) {
      // 扩展热载后旧 content script 已失效：记录开始前补注入一次
      if (type === 'srvprice:record-start') {
        try {
          await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
          await chrome.tabs.sendMessage(t.id, { type });
        } catch (_) { /* 非厂商页或注入受限，忽略 */ }
      }
    }
  }
}
let reconnectTimer = null;
let pingTimer = null;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function getConn() {
  const d = await storageGet(['bridgeToken', 'bridgePort']);
  return { token: d.bridgeToken || '', port: Number(d.bridgePort || DEFAULT_PORT) };
}

function setBadge(on) {
  try { chrome.action.setBadgeText({ text: on ? 'ON' : '' }); } catch (_) {}
}

// 一键配对：扩展自己读配对页的 nonce → 换 token（不依赖页面里的 content script）。
// 客户端在跑就自动完成；用户不需要复制任何东西。
async function autoPair(port) {
  try {
    const p = Number(port || DEFAULT_PORT);
    const html = await fetch(`http://127.0.0.1:${p}/pair`, { cache: 'no-store' }).then((r) => r.text());
    const m = html.match(/name="srvprice-pair-nonce" content="([a-f0-9]{32})"/);
    if (!m) return '';
    const j = await fetch(`http://127.0.0.1:${p}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: m[1] })
    }).then((r) => r.json());
    if (!j || !j.ok) return '';
    await new Promise((resolve) => {
      chrome.storage.local.set({ bridgeToken: j.token, bridgePort: j.port || p }, resolve);
    });
    return j.token;
  } catch (_) {
    return '';
  }
}

let connecting = false;

async function connect() {
  // ★ 防重入：两次 connect 并发时，第一个 socket 的 onopen 会对着被第二个
  //   覆盖后的 ws 发 hello —— 那个还处于 CONNECTING，直接抛
  //   InvalidStateError: Still in CONNECTING state（现场 2026-11-20）。
  if (connecting) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  connecting = true;
  try {
    let { token, port } = await getConn();
    if (!token) {
      token = await autoPair(port);
      if (!token) {
        scheduleReconnect();
        return;
      }
    }
    let sock;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    } catch (_) {
      scheduleReconnect();
      return;
    }
    ws = sock;
    // ★ 所有回调都用自己这个 sock，不用全局 ws（全局随时可能被下一次连接替换）
    sock.onopen = () => {
      if (sock.readyState !== 1) return;
      sock.send(JSON.stringify({
        type: 'hello',
        token,
        origin: chrome.runtime.getURL('').replace(/\/$/, '')
      }));
    };
    sock.onmessage = async (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'hello_ok') {
        setBadge(true);
        startPing();
        return;
      }
      if (msg.type === 'exec') {
        let res;
        try { res = await forwardExec(msg.step); } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
        res = res || { ok: false, error: 'empty result' };
        if (sock.readyState === 1) {
          sock.send(JSON.stringify({
            type: 'step_result',
            id: msg.id,
            ok: !!res.ok,
            error: res.error || null,
            detail: res.detail || null
          }));
        }
        return;
      }
      if (msg.type === 'record_start') {
        recorder = { id: String(msg.id || ''), started_at: Date.now() };
        recEvents.length = 0;
        recordBroadcast('srvprice:record-start');
        if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'record_started', id: recorder.id }));
        return;
      }
      if (msg.type === 'record_stop') {
        recorder = null;
        recordBroadcast('srvprice:record-stop');
        if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'record_stopped', count: recEvents.length }));
        return;
      }
      if (msg.type === 'reload') {
        // 开发期自载：客户端改完扩展文件后发这条，扩展自己重载，不用用户点刷新
        setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 300);
        return;
      }
      if (msg.type === 'tabs') {
        listVendorTabs().then((rows) => {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({ type: 'tabs_result', id: msg.id, tabs: rows }));
          }
        });
        return;
      }
      if (msg.type === 'use-tab') {
        targetTabId = Number(msg.tabId) || null;
        if (sock.readyState === 1) {
          sock.send(JSON.stringify({ type: 'use_tab_result', id: msg.id, ok: !!targetTabId, tabId: targetTabId }));
        }
        return;
      }
      if (msg.type === 'screenshot') {
        captureVendorTab().then((r) => {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({
              type: 'screenshot_result',
              id: msg.id,
              ok: !!r.ok,
              error: r.error || null,
              dataUrl: r.dataUrl || null
            }));
          }
        });
        return;
      }
      if (msg.type === 'probe') {
        probeActiveTab().then((r) => {
          if (sock.readyState === 1) {
            sock.send(JSON.stringify({
              type: 'probe_result',
              id: msg.id,
              ok: !!r.ok,
              error: r.error || null,
              detail: r.detail || null
            }));
          }
        });
        return;
      }
      if (msg.type === 'voice') {
        try {
          chrome.tts.speak(String(msg.text || ''), { enqueue: true });
        } catch (_) {}
      }
      if (msg.type === 'overlay') {
        // 浮层广播到所有标签页（用户可能在控制台的任意一个页签；只发活动页会漏）
        chrome.tabs.query({}, (tabs) => {
          for (const t of tabs || []) {
            if (!t.id) continue;
            chrome.tabs.sendMessage(t.id, { type: 'srvprice:overlay', overlay: msg.overlay }, () => {
              void chrome.runtime.lastError;
            });
          }
        });
      }
    };
    sock.onclose = () => {
      if (ws === sock) {
        setBadge(false);
        stopPing();
        ws = null;
      }
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch (_) {} };
  } finally {
    connecting = false;
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
  }, 20000);
}
function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}

// 选一个厂商控制台标签页（优先 volcengine/aliyun/...，否则当前标签）
let targetTabId = null;
// ★ 2026-11-20：国外五家控制台也纳入（AWS / DigitalOcean / Hetzner / Vultr / Linode-Akamai）
const VENDOR_RE = /volcengine\.com|aliyun\.com|tencent\.com|baidu\.com|ucloud|jdcloud|ctyun|west\.cn|aws\.amazon\.com|digitalocean\.com|hetzner\.(com|cloud)|vultr\.com|linode\.com|akamai\.com/i;

async function pickVendorTab() {
  try {
    // ★ 固定目标标签页：一次选定后，探针/执行/截图都用同一个 tab，
    //   否则多开控制台页签时会一个点、一个截到空白页。
    if (targetTabId) {
      try {
        const t = await chrome.tabs.get(targetTabId);
        if (t && t.url && VENDOR_RE.test(t.url)) return t;
      } catch (_) {}
      targetTabId = null;
    }
    const at = await activeTab();
    if (at && at.url && VENDOR_RE.test(at.url)) {
      targetTabId = at.id;
      return at;
    }
    const tabs = await chrome.tabs.query({});
    const t = (tabs || []).find((x) => x.url && VENDOR_RE.test(x.url));
    if (t) targetTabId = t.id;
    return t || at || null;
  } catch (_) {
    return null;
  }
}

function listVendorTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const rows = (tabs || []).filter((t) => t.url && VENDOR_RE.test(t.url)).map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: !!t.active,
        window_id: t.windowId,
        target: t.id === targetTabId
      }));
      resolve(rows);
    });
  });
}

// CDP 真实点击（受信任事件）：先注入取元素中心坐标，再用 debugger 发鼠标按下/抬起
async function realClick(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const match = (step.do && step.do.match) || {};
  let pt = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [match],
      func: async (m) => {
        const vis = (el) => {
          try {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          } catch (_) { return false; }
        };
        const txt = (el) => ((el.innerText || el.textContent || '') + '').trim();
        const want = String(m.text || m.label || '');
        const cls = m.cls ? String(m.cls).toLowerCase() : '';
        // 优先按钮/链接（“下一步”这种文字可能在步骤条里也出现）
        const prim = Array.from(document.querySelectorAll('button,a,[role="button"]'))
          .filter((el) => vis(el) && (!cls || String(el.className || '').toLowerCase().includes(cls)));
        let best = prim.find((el) => txt(el).trim() === want) ||
          prim.find((el) => txt(el).includes(want)) || null;
        if (!best) {
          const cands = Array.from(document.querySelectorAll('div,label,li,span,strong'));
          for (const el of cands) {
            if (!vis(el)) continue;
            if (cls && !String(el.className || '').toLowerCase().includes(cls)) continue;
            const t = txt(el);
            if (!t.includes(want)) continue;
            if (!best || t.length < txt(best).length) best = el;
          }
        }
        if (!best) return null;
        // 目标可能在视口外：先滚到中间再量坐标（否则 CDP 点空）
        try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
        await new Promise((r) => setTimeout(r, 350));
        const r = best.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: best.id || '' };
      }
    });
    pt = results && results[0] && results[0].result;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!pt) return { ok: false, error: 'element not found' };
  try {
    await dbgAttach(tab.id);
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1
    });
    await new Promise((r) => setTimeout(r, 120));
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1
    });
    return { ok: true, detail: { x: Math.round(pt.x), y: Math.round(pt.y) } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// CDP 真实输入：聚焦目标输入框后用 Input.insertText 输入（React 受控组件也认）
async function realType(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const d = step.do || {};
  let pt = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [d.match || {}, String(d.value == null ? '' : d.value)],
      func: (m, value) => {
        const vis = (el) => {
          try {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          } catch (_) { return false; }
        };
        const ins = Array.from(document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]),textarea')).filter(vis);
        let target = null;
        if (m.id_hint) {
          const h = String(m.id_hint).toLowerCase();
          target = ins.find((el) => String(el.id || '').toLowerCase().includes(h) ||
            String(el.name || '').toLowerCase().includes(h)) || null;
        }
        if (!target && m.near_text) {
          const all = Array.from(document.querySelectorAll('th,label,span,div,strong'));
          let a = null;
          for (const el of all) {
            if (!vis(el)) continue;
            if (!((el.innerText || el.textContent || '').trim().includes(String(m.near_text)))) continue;
            if (!a || (el.innerText || '').length < (a.innerText || '').length) a = el;
          }
          if (a) {
            // 文档顺序最近的下一个可见输入框
            for (const inp of ins) {
              if (a.compareDocumentPosition(inp) & Node.DOCUMENT_POSITION_FOLLOWING) { target = inp; break; }
            }
          }
        }
        if (!target && m.label) {
          const w = String(m.label).toLowerCase();
          target = ins.find((el) => [el.getAttribute('placeholder'), el.getAttribute('aria-label'),
            el.getAttribute('name'), el.id,
            el.labels && el.labels.length ? el.labels[0].innerText : '']
            .map((x) => String(x || '').toLowerCase()).join(' ').includes(w)) || null;
        }
        if (!target) return null;
        target.focus();
        window.__srvpriceTargetId = target.id || target.tagName;
        // 清空旧值（受控组件用原生 setter + input 事件）
        const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(target, '');
        target.dispatchEvent(new Event('input', { bubbles: true }));
        const r = target.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: target.id || '' };
      }
    });
    pt = results && results[0] && results[0].result;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!pt) return { ok: false, error: 'input not found' };
  try {
    await dbgAttach(tab.id);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    // 点坐标可能落在覆盖层上：有 id 时直接 focus 目标输入框
    if (pt.id) {
      try {
        await dbgSend(tab.id, 'Runtime.evaluate', {
          expression: `(function(){var e=document.getElementById(${JSON.stringify(pt.id)}); if(e) e.focus();})()`
        });
      } catch (_) {}
    }
    // 逐字符 char 事件（有些组件忽略 insertText，但认键盘输入）
    const text = String(d.value == null ? '' : d.value);
    for (const ch of text) {
      await dbgSend(tab.id, 'Input.dispatchKeyEvent', {
        type: 'char', text: ch, unmodifiedText: ch, key: ch
      });
    }
    let diag = {};
    try {
      const r = await dbgSend(tab.id, 'Runtime.evaluate', {
        expression: 'JSON.stringify({active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), valueLen: (document.querySelector("#name")||{value:""}).value.length})',
        returnByValue: true
      });
      diag = JSON.parse(r.result.value);
    } catch (_) {}
    return { ok: true, detail: Object.assign({ typed: text.length }, diag) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// CDP 按键（关下拉/弹窗）
async function pressKey(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const key = String((step.do && step.do.key) || 'Escape');
  const codes = { Escape: 27, Enter: 13, Tab: 9 };
  try {
    await dbgAttach(tab.id);
    for (const type of ['keyDown', 'keyUp']) {
      await dbgSend(tab.id, 'Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: codes[key] || 0,
        nativeVirtualKeyCode: codes[key] || 0
      });
    }
    return { ok: true, detail: key };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// 按坐标点击后原生输入（给 antd/arco 这类下拉内嵌输入框用）
async function typeAt(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const d = step.do || {};
  const x = Number(d.x);
  const y = Number(d.y);
  const text = String(d.value == null ? '' : d.value);
  if (!x || !y) return { ok: false, error: 'x/y required' };
  try {
    await dbgAttach(tab.id);
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 200));
    await dbgSend(tab.id, 'Input.insertText', { text });
    return { ok: true, detail: { x, y, typed: text.length } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// 按 placeholder 聚焦并用 CDP 原生输入（受控组件只认键盘事件）
async function fillByPlaceholder(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const d = step.do || {};
  const needle = String(d.placeholder || '');
  const text = String(d.value == null ? '' : d.value);
  if (!needle) return { ok: false, error: 'placeholder required' };
  try {
    await dbgAttach(tab.id);
    const found = await dbgSend(tab.id, 'Runtime.evaluate', {
      expression: `(function(){var ins=document.querySelectorAll('input,textarea');for(var i=0;i<ins.length;i++){var ph=String(ins[i].getAttribute('placeholder')||'');if(ph.indexOf(${JSON.stringify(needle)})>=0){ins[i].focus();try{ins[i].select();}catch(e){}return true;}}return false;})()`,
      returnByValue: true
    });
    if (!(found && found.result && found.result.value)) {
      return { ok: false, error: 'placeholder not found: ' + needle };
    }
    await dbgSend(tab.id, 'Input.insertText', { text });
    return { ok: true, detail: { placeholder: needle } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// CDP 按坐标点击（关闭无文字的 X 等）
async function clickAt(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const x = Number(step.do && step.do.x);
  const y = Number(step.do && step.do.y);
  if (!x || !y) return { ok: false, error: 'x/y required' };
  try {
    await dbgAttach(tab.id);
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, detail: { x, y } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// DOM 直接点击（按钮被视口/容器裁切时用；在页面上下文里调 .click()）
async function domClick(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const text = String((step.do && step.do.text) || '');
  const expr = '(function(){var bs=document.querySelectorAll("button,a");' +
    'for(var i=0;i<bs.length;i++){if((bs[i].textContent||"").trim()===' + JSON.stringify(text) + '){bs[i].click();return true;}}return false;})()';
  try {
    await dbgAttach(tab.id);
    const r = await dbgSend(tab.id, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    return { ok: !!(r && r.result && r.result.value), detail: { clicked: !!(r && r.result && r.result.value) } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// 按行定位：在包含 row_text 的那一行里点指定按钮。
// 表格每行都有同名按钮（如“修改”）时用：先找文字等于 button_text 的按钮，
// 再向上找最近的、文本分词里含 row_text 的祖先，取最短的那个当“行”。
async function rowClick(step) {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  const d = step.do || {};
  const rowText = String(d.row_text || '');
  const btnText = String(d.button_text || '');
  if (!rowText || !btnText) return { ok: false, error: 'row_click 需要 row_text 与 button_text' };
  let pt = null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [rowText, btnText],
      func: (rowText, btnText) => {
        const vis = (el) => {
          try {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          } catch (_) { return false; }
        };
        const txt = (el) => ((el.innerText || el.textContent || '') + '').trim();
        const toks = (t) => t.split(/\s+/).filter(Boolean);
        const btns = Array.from(document.querySelectorAll('button,a,[role="button"]'))
          .filter((el) => vis(el) && txt(el) === btnText);
        let best = null;
        for (const b of btns) {
          let p = b.parentElement;
          for (let i = 0; i < 9 && p; i++, p = p.parentElement) {
            const t = txt(p);
            if (!toks(t).includes(rowText)) continue;
            if (!best || t.length < best.len) best = { el: b, len: t.length };
            break;
          }
        }
        if (!best) return { error: 'row not found: ' + rowText };
        best.el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = best.el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    });
    pt = results && results[0] && results[0].result;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!pt) return { ok: false, error: 'no result' };
  if (pt.error) return { ok: false, error: pt.error };
  try {
    await dbgAttach(tab.id);
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 120));
    await dbgSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    return { ok: true, detail: { x: Math.round(pt.x), y: Math.round(pt.y) } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    await dbgDetach(tab.id);
  }
}

// 在目标标签页上轮询 verify / fail_when（用于导航后，页面上下文已经换过一次）
async function verifyTab(tabId, step) {
  const vt = String((step.verify || {}).text || '').split('|').map((s) => s.trim()).filter(Boolean);
  const ft = String((step.fail_when || {}).text || '').split('|').map((s) => s.trim()).filter(Boolean);
  const to = Math.max(4000, Number((step.verify || {}).timeout_ms || 8000));
  const deadline = Date.now() + to;
  let lastErr = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      // 单次探测也要有上限：页面加载中时 executeScript 可能一直不 settle
      const chk = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId },
          args: [vt, ft],
          func: (vTexts, fTexts) => {
            const t = (document.body && document.body.innerText) || '';
            return { hit: vTexts.length ? vTexts.some((x) => t.includes(x)) : true,
              fail: fTexts.some((x) => t.includes(x)) };
          }
        }),
        new Promise((r) => setTimeout(() => r(null), 2000))
      ]);
      if (!chk) continue;
      const c = (chk[0] && chk[0].result) || {};
      if (c.fail) return { ok: false, error: 'fail_when 命中：' + ft.join('|') };
      if (c.hit) return { ok: true, detail: 'verified' };
    } catch (e) { lastErr = e; }
  }
  return {
    ok: false,
    error: 'verify 未命中：' + (vt.join('|') || '(无 verify)') +
      (lastErr ? '（' + String((lastErr && lastErr.message) || lastErr) + '）' : '')
  };
}

// 按需注入执行器：不依赖 content script，扩展重载后无需刷新页面；穿透 shadow root。
async function execViaScripting(step) {
  // ★ 2026-11-20：按需在**新标签**打开厂商控制台（不打断用户当前页）。
  //   do = { action: 'open', url, new_tab: true }
  if (step && step.do && (step.do.action === 'open' || step.do.action === 'navigate') &&
      (step.do.new_tab || step.new_tab)) {
    const url = step.do.url || step.entry || '';
    if (!url) return { ok: false, error: 'no url' };
    const t = await chrome.tabs.create({ url, active: true });
    targetTabId = t.id;
    return { ok: true, detail: 'new_tab:' + t.id + ' ' + url };
  }
  // 同一标签页内的 open/navigate：由扩展层跳转并等 verify，
  // 避免注入上下文在导航中被销毁导致下一步扑空（2026-11-21 E2E 踩到）。
  if (step && step.do && (step.do.action === 'open' || step.do.action === 'navigate')) {
    const url = step.do.url || step.entry || '';
    if (!url) return { ok: false, error: 'no url' };
    const tab = await pickVendorTab();
    if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
    const norm = (u) => String(u || '').replace(/\/+$/, '');
    if (norm(tab.url) === norm(url)) return { ok: true, detail: 'already_open' };
    await chrome.tabs.update(tab.id, { url });
    targetTabId = tab.id;
    // 先等 URL 到位：verify 文本可能在新旧页面都出现（如面包屑里的“用户管理”）
    const urlDeadline = Date.now() + Math.max(6000, Number((step.verify || {}).timeout_ms || 8000));
    let arrived = false;
    while (Date.now() < urlDeadline) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const t2 = await chrome.tabs.get(tab.id);
        if (t2 && t2.url && norm(t2.url).startsWith(norm(url))) { arrived = true; break; }
      } catch (_) { /* 标签页切换中 */ }
    }
    if (!arrived) return { ok: false, error: '导航未到达目标地址：' + url };
    const v = await verifyTab(tab.id, step);
    return v.ok ? { ok: true, detail: 'navigated' } : v;
  }
  if (step && step.do && step.do.action === 'dom_click') {
    const r = await domClick(step);
    if (!r.ok || !(step.verify && step.verify.text)) return r;
    // 点击可能触发导航：交给 verifyTab 等目标页出现
    const t = await pickVendorTab();
    return t ? verifyTab(t.id, step) : r;
  }
  if (step && step.do && step.do.action === 'row_click') return rowClick(step);
  if (step && step.do && step.do.action === 'click_at') return clickAt(step);
  if (step && step.do && step.do.action === 'real_click') return realClick(step);
  if (step && step.do && step.do.action === 'real_type') return realType(step);
  if (step && step.do && step.do.action === 'press_key') return pressKey(step);
  if (step && step.do && step.do.action === 'fill_by_placeholder') return fillByPlaceholder(step);
  if (step && step.do && step.do.action === 'type_at') return typeAt(step);
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  try {
    // 注入带超时：点击触发整页跳转时 executeScript 的 promise 可能永远不 settle
    const results = await Promise.race([
      chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [step],
      func: async (step) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const roots = () => {
          const out = [document];
          const walk = (root) => {
            let els = [];
            try { els = root.querySelectorAll('*'); } catch (_) { return; }
            for (const el of els) {
              if (el.shadowRoot) { out.push(el.shadowRoot); walk(el.shadowRoot); }
            }
          };
          walk(document);
          return out;
        };
        const all = (sel) => {
          const o = [];
          for (const r of roots()) {
            try { o.push(...r.querySelectorAll(sel)); } catch (_) {}
          }
          return o;
        };
        const vis = (el) => {
          try {
            const b = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          } catch (_) { return false; }
        };
        const txt = (el) => ((el.innerText || el.textContent || '') + '').trim();
        const bodyText = () => {
          let t = document.body ? (document.body.innerText || '') : '';
          for (const r of roots()) if (r !== document) t += ' ' + (r.textContent || '');
          return t;
        };
        const matchText = (pat) => {
          const ps = String(pat || '').split('|').map((s) => s.trim()).filter(Boolean);
          const t = bodyText();
          return ps.some((p) => t.includes(p));
        };
        const findEl = (m) => {
          if (!m) return null;
          const want = String(m.text || m.label || m.name || '').split('|').map((s) => s.trim()).filter(Boolean);
          const role = m.role ? String(m.role).toLowerCase() : '';
          const clsWant = m.cls ? String(m.cls).toLowerCase() : '';
          const cands = all('button,a,[role="button"],[role="radio"],input[type="button"],input[type="submit"],label,li,td,th,span,div').filter(vis);
          let best = null;
          for (const el of cands) {
            if (clsWant && !String(el.className || '').toLowerCase().includes(clsWant)) continue;
            const aria = String(el.getAttribute('aria-label') || el.getAttribute('title') || '');
            const label = String(el.value || '') + ' ' + aria + ' ' + txt(el);
            if (role) {
              const r = String(el.getAttribute('role') || '').toLowerCase() ||
                (el.tagName === 'BUTTON' ? 'button' : (el.tagName === 'A' ? 'link' : ''));
              // 指定了 role 时，没有匹配 role 的元素要跳过（之前空 role 被放过，会点到外层 DIV）
              if (r !== role) continue;
            }
            for (const w of want) {
              if (label.trim() === w) return el;
              if (label.includes(w)) {
                // 取“文本最短”的匹配，避免兜底选到最外层容器（pageWrapper 文本包含一切）
                if (!best || txt(el).length < txt(best).length) best = el;
              }
            }
          }
          return best;
        };
        const findInput = (f) => {
          const m = f.match || {};
          // 0) 按旁边的字段名找：先定位文字，再在同一表单项容器里找输入框
          if (m.near_text) {
            const a = findEl({ text: m.near_text });
            if (a) {
              // 1) 同一行内的输入框（表单行/表格行）
              const row = a.closest && (a.closest('tr') || a.closest('.app-cam-form__item'));
              if (row) {
                const inp = row.querySelector('input:not([type="checkbox"]):not([type="radio"]),textarea');
                if (inp) return inp;
              }
              // 2) 表头 → 下一行同列
              const th = a.closest && a.closest('th');
              if (th) {
                const ths = Array.from(th.parentElement.children);
                const idx = ths.indexOf(th);
                const table = th.closest('table');
                const firstRow = table && table.querySelector('tbody tr');
                if (firstRow && firstRow.children[idx]) {
                  const inp = firstRow.children[idx].querySelector('input,textarea');
                  if (inp) return inp;
                }
              }
              // 3) 只在字段元素自身/父级内找，避免爬到页头全局搜索
              let node = a;
              for (let i = 0; i < 2 && node; i++) {
                const inp = node.querySelector &&
                  node.querySelector('input:not([type="checkbox"]):not([type="radio"]),textarea');
                if (inp) return inp;
                node = node.parentElement;
              }
              // 4) 文档顺序上最近的下一个输入框（div 表格兜底）
              const allIns = all('input:not([type="checkbox"]):not([type="radio"]),textarea').filter(vis);
              for (const inp of allIns) {
                try {
                  if (a.compareDocumentPosition(inp) & Node.DOCUMENT_POSITION_FOLLOWING) return inp;
                } catch (_) {}
              }
            }
          }
          // 1) 显式 id/name 子串提示（云控制台表单常无 label，但有稳定 id）
          if (m.id_hint) {
            const h = String(m.id_hint).toLowerCase();
            for (const el of all('input,textarea,select')) {
              if (String(el.id || '').toLowerCase().includes(h) ||
                  String(el.name || '').toLowerCase().includes(h)) return el;
            }
          }
          // 2) placeholder / aria / name / label 文本
          const want = String(m.label || m.text || m.name || '').toLowerCase();
          for (const el of all('input,textarea,select').filter(vis)) {
            const hay = [el.getAttribute('placeholder'), el.getAttribute('aria-label'),
              el.getAttribute('name'), el.id,
              el.labels && el.labels.length ? el.labels[0].innerText : '']
              .map((x) => String(x || '').toLowerCase()).join(' ');
            if (want && hay.includes(want)) return el;
          }
          return null;
        };
        // 导航后表单渲染有延迟：等输入框出现再填；多字段共用同一个截止时间
        const waitInput = async (f, deadline) => {
          const dl = deadline || (Date.now() + 8000);
          let el = findInput(f);
          while (!el && Date.now() < dl) { await sleep(300); el = findInput(f); }
          return el;
        };
        const setVal = (el, v) => {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const s = Object.getOwnPropertyDescriptor(proto, 'value');
          if (s && s.set) s.set.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const sens = (el) => {
          if (!el) return false;
          if (String(el.type || '').toLowerCase() === 'password') return true;
          return /(secret|password|passwd|verify|captcha|otp|sms|验证码|密钥|密码)/i.test(
            String(el.name || '') + ' ' + String(el.id || '') + ' ' + String(el.getAttribute('placeholder') || ''));
        };
        const evalVerify = async () => {
          const v = step.verify || {};
          const f = step.fail_when || {};
          const to = Math.max(500, Number(v.timeout_ms || 8000));
          const t0 = Date.now();
          while (Date.now() - t0 < to) {
            if (f.text && matchText(f.text)) return { ok: false, error: 'fail_when 命中：' + f.text };
            if (!v.text || matchText(v.text)) return { ok: true, detail: 'verified' };
            await sleep(400);
          }
          return { ok: false, error: 'verify 未命中：' + (v.text || '') };
        };

        const d = (step && step.do) || {};
        const a = d.action;
        if (a === 'open' || a === 'navigate') {
          const url = d.url || step.entry || '';
          if (!url) return { ok: false, error: 'no url' };
          // 已在目标页就不要重载：重载会让下一步的注入上下文被销毁（2026-11-21 E2E 踩到）
          const norm = (u) => String(u).replace(/\/+$/, '');
          try {
            if (norm(location.href.split('#')[0]) === norm(url.split('#')[0])) {
              return { ok: true, detail: 'already_open' };
            }
          } catch (_) {}
          location.href = url;
          return { ok: true, detail: 'navigating' };
        }
        if (a === 'click') {
          // 导航后页面往往还没渲染完：等元素出现，而不是一次扑空就报错
          let el = findEl(d.match);
          const findDeadline = Date.now() + Math.max(3000, Number(d.find_timeout_ms || 8000));
          while (!el && Date.now() < findDeadline) {
            await sleep(300);
            el = findEl(d.match);
          }
          // 指定行：在包含 row_text 的那一行里找目标元素（如某用户行的“添加授权”）
          if (d.match && d.match.row_text) {
            const rowAnchor = findEl({ text: d.match.row_text });
            let row = rowAnchor;
            for (let i = 0; i < 6 && row; i++) {
              if (row.tagName === 'TR' || /row/i.test(String(row.className || ''))) break;
              row = row.parentElement;
            }
            if (row) {
              const t = String(d.match.text || '');
              const hit = Array.from(row.querySelectorAll('button,a,span,div'))
                .find((e) => txt(e).includes(t) && vis(e));
              if (hit) el = hit;
            }
          }
          if (!el) return { ok: false, error: 'element not found' };
          // 卡片式选项：点击外层容器而不是里面的 STRONG/SPAN 文字
          if (d.match && d.match.container && el.closest) {
            el = el.closest('div.item,label,li,[role="radio"],[role="option"]') ||
              (el.parentElement && el.parentElement.parentElement) || el;
          }
          const beforeUrl = location.href;
          if (d.match && d.match.container) {
            // 卡片/单选组常监听 mousedown/mouseup，单纯 .click() 不一定触发
            try {
              const r = el.getBoundingClientRect();
              const opts = {
                bubbles: true, cancelable: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
              };
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent('click', opts));
            } catch (_) {
              el.click();
            }
          } else {
            el.click();
          }
          // 导航类点击：URL 变了就立即返回（页面切换会销毁注入上下文，不能等 verify）
          for (let i = 0; i < 10; i++) {
            await sleep(300);
            if (location.href !== beforeUrl) return { ok: true, detail: 'navigated' };
          }
          return evalVerify();
        }
        if (a === 'fill_form') {
          const done = [];
          const fieldDeadline = Date.now() + 10000; // 多字段共用总预算，避免叠加超时
          for (const f of d.fields || []) {
            if (f.action === 'check') {
              // 先按文字点（arco 等组件把 checkbox 藏在 label 里，input 本身不可见）
              const t = f.match && (f.match.text || f.match.label);
              const target = t ? findEl({ text: t }) : null;
              if (target) {
                // 幂等：先看关联的 checkbox 是否已勾选，避免点两次反选
                const cb = (target.querySelector && target.querySelector('input[type="checkbox"]')) ||
                  (target.control && target.control.type === 'checkbox' ? target.control : null);
                if (cb) {
                  if (!cb.checked) target.click();
                } else {
                  target.click();
                }
                done.push('check:' + t);
                await sleep(150);
                continue;
              }
              const elc = await waitInput(f, fieldDeadline);
              if (!elc) return { ok: false, error: 'checkbox not found: ' + JSON.stringify(f.match || {}) };
              if (!elc.checked) elc.click();
              done.push('check');
              continue;
            }
            const el = await waitInput(f, fieldDeadline);
            if (!el) return { ok: false, error: 'input not found: ' + JSON.stringify(f.match || {}) };
            if (sens(el)) return { ok: false, error: 'refuse to fill sensitive input' };
            setVal(el, String(f.value || ''));
            done.push('fill');
          }
          const v = await evalVerify();
          return v.ok ? { ok: true, detail: done } : v;
        }
        if (a === 'attach_policy') {
          const name = String(d.select || d.search || '');
          const visibleInputs = all('input').filter(vis);
          const ph = (el) => String(el.getAttribute('placeholder') || '') + String(el.getAttribute('aria-label') || '');
          // 优先级：策略专用搜索 > 含“策略” > 通用搜索（避免打到页头全局搜索）
          const box = visibleInputs.find((el) => /策略.*名称|权限策略|策略名|策略描述/.test(ph(el))) ||
            visibleInputs.find((el) => /策略/.test(ph(el))) ||
            visibleInputs.find((el) => /搜索策略|search/i.test(ph(el))) ||
            visibleInputs.find((el) => /搜索|search/i.test(ph(el)));
          if (box) {
            box.focus();
            setVal(box, String(d.search || ''));
            const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
            box.dispatchEvent(new KeyboardEvent('keydown', enter));
            box.dispatchEvent(new KeyboardEvent('keypress', enter));
            box.dispatchEvent(new KeyboardEvent('keyup', enter));
            await sleep(2200);
          }
          // 在结果里找包含策略名的最小元素（排除输入框），再点它所在行/勾选框
          let best = null;
          for (const el of all('span,td,div,label,li').filter(vis)) {
            const t = txt(el);
            if (!t.includes(name)) continue;
            if (!best || t.length < txt(best).length) best = el;
          }
          if (!best) return { ok: false, error: 'policy not found: ' + name };
          const row = best.closest('tr') || best.closest('[role="row"]') || best;
          let clicked = false;
          const cb = row.querySelector && row.querySelector('input[type="checkbox"]');
          if (cb) {
            const lab = cb.closest('label') || (cb.labels && cb.labels[0]);
            if (lab) { lab.click(); clicked = true; }
            else if (!cb.checked) { cb.click(); clicked = true; }
            else clicked = true;
          }
          if (!clicked) { row.click(); clicked = true; }
          await sleep(400);
          return evalVerify();
        }
        if (a === 'read_fields') {
          const res = [];
          for (const name of d.fields || []) {
            const el = findInput({ match: { label: name } });
            res.push({ name, present: !!el, sensitive: sens(el) });
          }
          return { ok: true, detail: res };
        }
        if (a === 'wait') {
          await sleep(Number(d.ms || 1000));
          return { ok: true, detail: 'waited' };
        }
        if (a === 'scroll') {
          const y = Number(d.y || 400);
          window.scrollBy(0, y);
          // 云控制台多是内部滚动容器，window 滚不动
          let n = 0;
          for (const el of all('div,main,section')) {
            try {
              const st = getComputedStyle(el);
              if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(st.overflowY)) {
                el.scrollBy(0, y);
                if (++n >= 6) break;
              }
            } catch (_) {}
          }
          return { ok: true, detail: { scrolled: y, containers: n } };
        }
        if (a === 'report') {
          return { ok: true, detail: { url: location.href, title: document.title, step_id: step.step_id || '' } };
        }
        if (a === 'prompt' || a === 'ack_status') {
          // 页面内人工门：右下角卡片 + 「我完成了」按钮；ack 写 localStorage 供 CLI 轮询
          const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
          }[c]));
          const id = String(d.id || 'gate');
          const key = 'srvprice_ack_' + id;
          if (a === 'ack_status') {
            const v = Number(localStorage.getItem(key) || 0);
            return { ok: true, detail: { id, acked: v > 0, at: v } };
          }
          let host = document.getElementById('srvprice-gate-host');
          if (!host) {
            host = document.createElement('div');
            host.id = 'srvprice-gate-host';
            host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
            document.documentElement.appendChild(host);
          }
          const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
          root.innerHTML = [
            '<style>',
            '.card{width:300px;background:#1f2430;color:#e8eaed;border-radius:10px;padding:14px;',
            'font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4)}',
            '.t{font-weight:600;color:#7eb6ff;margin-bottom:6px}',
            '.m{white-space:pre-wrap;word-break:break-word}',
            'button{width:100%;margin-top:12px;padding:8px;border:0;border-radius:6px;',
            'background:#3b82f6;color:#fff;font:inherit;cursor:pointer}',
            '</style>',
            '<div class="card"><div class="t">' + esc(d.title || '需要人工操作') + '</div>',
            '<div class="m">' + esc(d.message || '') + '</div>',
            '<button id="done">我完成了</button></div>'
          ].join('');
          const btn = root.getElementById('done');
          const msgEl = root.querySelector('.m');
          btn.addEventListener('click', () => {
            localStorage.setItem(key, String(Date.now()));
            if (msgEl) msgEl.textContent = '✔ 已确认，客户端继续…';
            btn.disabled = true;
            btn.textContent = '已确认';
            setTimeout(() => { try { host.remove(); } catch (_) {} }, 1500);
          });
          return { ok: true, detail: 'prompted' };
        }
        if (a === 'outer_html') {
          let el = findEl({ text: String(d.text || ''), cls: d.cls || '' });
          if (el && d.container && el.closest) el = el.closest('div.item,label,li') || el;
          if (!el) return { ok: false, error: 'element not found' };
          return { ok: true, detail: String(el.outerHTML || '').slice(0, Number(d.limit || 1500)) };
        }
        if (a === 'find_clickable') {
          const kw = String(d.text || '');
          const out = [];
          const seen = new Set();
          for (const el of all('*')) {
            const t = txt(el).replace(/\s+/g, ' ');
            if (!t.includes(kw) || t.length > 80) continue;
            if (!vis(el)) continue;
            const key = el.tagName + '|' + t;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              tag: el.tagName,
              cls: String(el.className || '').slice(0, 60),
              role: el.getAttribute('role') || '',
              type: el.getAttribute('type') || '',
              text: t
            });
            if (out.length >= 25) break;
          }
          return { ok: true, detail: out };
        }
        if (a === 'key_candidates') {
          // 只回位置 + 打码值（前 4 + 长度），不回明文
          const rows = [];
          const re = /accesskey|secret|密钥|ak\b|sk\b/i;
          let scanned = 0;
          for (const el of all('input,textarea,span,div,code,pre')) {
            if (++scanned > 20000) break;
            const tag = el.tagName;
            if (!['INPUT', 'TEXTAREA', 'SPAN', 'DIV', 'CODE', 'PRE'].includes(tag)) continue;
            const meta = String(el.id || '') + ' ' + String(el.className || '') + ' ' +
              String(el.getAttribute && el.getAttribute('aria-label') || '') + ' ' +
              String(el.getAttribute && el.getAttribute('name') || '');
            if (!re.test(meta)) continue;
            let v = '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') v = String(el.value || '');
            else v = String(el.textContent || '').trim();
            if (v.length > 200) continue;
            rows.push({
              tag,
              id: String(el.id || '').slice(0, 60),
              cls: String(el.className || '').slice(0, 80),
              type: String(el.getAttribute && el.getAttribute('type') || ''),
              len: v.length,
              masked: v.length ? (v.slice(0, 4) + '…' + (v.length >= 8 ? v.slice(-2) : '')) : '',
              visible: vis(el)
            });
            if (rows.length >= 40) break;
          }
          return { ok: true, detail: rows };
        }
        if (a === 'buttons') {
          const out = [];
          for (const el of all('button')) {
            if (!vis(el)) continue;
            out.push({ text: txt(el).replace(/\s+/g, ' ').slice(0, 30), cls: String(el.className || '').slice(0, 50) });
            if (out.length >= 60) break;
          }
          return { ok: true, detail: out };
        }
        if (a === 'set_textarea') {
          const tas = all('textarea').filter(vis);
          const el = tas[Number(d.index) || 0];
          if (!el) return { ok: false, error: 'textarea not found' };
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
          if (setter && setter.set) setter.set.call(el, String(d.value == null ? '' : d.value));
          else el.value = String(d.value == null ? '' : d.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, detail: { len: String(el.value).length } };
        }
        if (a === 'textareas') {
          const out = [];
          for (const el of all('textarea')) {
            if (!vis(el)) continue;
            out.push({
              placeholder: String(el.getAttribute('placeholder') || '').slice(0, 60),
              len: String(el.value || '').length,
              value: String(el.value || '').slice(0, 500)
            });
            if (out.length >= 10) break;
          }
          return { ok: true, detail: out };
        }
        if (a === 'links') {
          const kw = String(d.q || '').toLowerCase();
          const out = [];
          for (const el of all('a')) {
            const href = String(el.getAttribute('href') || '');
            const t = txt(el).replace(/\s+/g, ' ').slice(0, 40);
            if (kw && !(href.toLowerCase().includes(kw) || t.toLowerCase().includes(kw))) continue;
            out.push({ href, text: t });
            if (out.length >= 80) break;
          }
          return { ok: true, detail: out };
        }
        if (a === 'check_by_label') {
          const anchor = findEl({ text: String(d.label || '') });
          if (!anchor) return { ok: false, error: 'label not found' };
          let box = null;
          let node = anchor;
          for (let i = 0; i < 5 && node && !box; i++) {
            box = node.querySelector && node.querySelector('input[type="checkbox"]');
            node = node.parentElement;
          }
          if (!box && anchor.control) box = anchor.control;
          if (!box) return { ok: false, error: 'checkbox not found' };
          if (!box.checked) box.click();
          await sleep(200);
          return { ok: true, detail: { checked: !!box.checked } };
        }
        if (a === 'check_index') {
          const boxes = all('input[type="checkbox"]');
          const i = Number(d.index);
          const el = boxes[i];
          if (!el) return { ok: false, error: 'no checkbox at ' + i, detail: { total: boxes.length } };
          if (d.ensure !== false && !el.checked) el.click();
          await sleep(200);
          return { ok: true, detail: { index: i, checked: !!el.checked, total: boxes.length } };
        }
        if (a === 'eval_info') {
          const buttons = all('button').filter((b) => txt(b).trim() === '确定').map((b) => ({
            disabled: !!b.disabled,
            aria: b.getAttribute('aria-disabled') || '',
            cls: String(b.className || '').slice(0, 60)
          }));
          const ins = all('input').filter(vis).map((el) => ({
            type: el.type, len: String(el.value || '').length,
            checked: el.type === 'checkbox' ? !!el.checked : undefined,
            ph: String(el.getAttribute('placeholder') || '').slice(0, 16)
          }));
          return { ok: true, detail: { buttons, inputs: ins } };
        }
        if (a === 'rect') {
          let el = findEl({ text: String(d.text || ''), cls: d.cls || '', role: d.role || '' });
          if (!el) return { ok: false, error: 'element not found' };
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
          await sleep(300);
          const r = el.getBoundingClientRect();
          return { ok: true, detail: { tag: el.tagName, cls: String(el.className || '').slice(0, 60),
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            w: Math.round(r.width), h: Math.round(r.height) } };
        }
        if (a === 'read_dialog_pair') {
          // 成功弹窗里成对出现：AccessKey ID <AK> AccessKey Secret <SK>
          const skLabel = String(d.sk_label || 'AccessKey Secret');
          const akLabel = String(d.ak_label || 'AccessKey ID');
          const anchor = findEl({ text: skLabel });
          if (!anchor) return { ok: false, error: 'sk label not found' };
          let node = anchor;
          for (let i = 0; i < 8 && node; i++) {
            const t = String(node.textContent || '').replace(/\s+/g, ' ');
            // 阿里云 LTAI+20（24 位）；腾讯 AKID+20~40（别贪婪吃到后面的标签）
            const akMatch = t.match(/LTAI[A-Za-z0-9]{20}|AKID[A-Za-z0-9]{20,40}/);
            if (akMatch && t.includes(akLabel)) {
              const after = t.split(skLabel)[1] || '';
              const skMatch = after.match(/[A-Za-z0-9]{20,40}/);
              if (skMatch) {
                return { ok: true, detail: { ak: akMatch[0], sk: skMatch[0] } };
              }
            }
            node = node.parentElement;
          }
          return { ok: false, error: 'pair not found' };
        }
        if (a === 'label_context') {
          const anchor = findEl({ text: String(d.label || '') });
          if (!anchor) return { ok: false, error: 'label not found' };
          const rows = [];
          let node = anchor;
          for (let i = 0; i < 6 && node; i++) {
            const t = String(node.textContent || '').replace(/\s+/g, ' ');
            const tokens = (t.match(/[A-Za-z0-9]{10,}/g) || []);
            rows.push({
              level: i,
              tag: node.tagName,
              cls: String(node.className || '').slice(0, 50),
              len: t.length,
              tokens: tokens.slice(0, 3).map((x) => x.slice(0, 4) + '…' + x.length)
            });
            node = node.parentElement;
          }
          return { ok: true, detail: rows };
        }
        if (a === 'read_labeled_text') {
          // 从“标签 + 值”的文本行里取值（百度等控制台的 AK/SK 是文本不是输入框）
          const out = {};
          for (const f of d.fields || []) {
            const anchor = findEl({ text: f.label });
            if (!anchor) continue;
            let node = anchor;
            let text = '';
            for (let i = 0; i < 3 && node; i++) {
              text = String(node.textContent || '');
              if (text.length > f.label.length + 10) break;
              node = node.parentElement;
            }
            const rest = text.split(f.label).join(' ').trim();
            const m = rest.match(/[A-Za-z0-9]{10,}/);
            if (m) out[f.name] = m[0];
          }
          return { ok: true, detail: out };
        }
        if (a === 'read_secret_values') {
          // 只给本地 vault 存储流程用：读取并返回字段值（值不落日志、不进对话）
          const out = {};
          for (const f of d.fields || []) {
            const el = findInput(f);
            if (!el) continue;
            out[f.name || (f.match && (f.match.label || f.match.id_hint)) || 'value'] = String(el.value || '');
          }
          return { ok: true, detail: out };
        }
        if (a === 'check_row') {
          // 在包含指定文字的卡片/行里勾选复选框（Vultr 的 policy/role 列表用）
          const row = findEl({ text: d.text || '' });
          let node = row;
          for (let i = 0; i < 8 && node; i++) {
            const cb = node.querySelector && node.querySelector('input[type="checkbox"]');
            if (cb) { cb.click(); return { ok: true, detail: { checked: !!cb.checked } }; }
            node = node.parentElement;
          }
          return { ok: false, error: 'checkbox not found for: ' + (d.text || '') };
        }
        if (a === 'scroll_container') {
          // 侧边抽屉/模态里内容被裁切时用：从 near_text 所在元素往上找最近的可滚动祖先，滚 dy
          const anchor = findEl({ text: d.near_text || '' });
          let node = anchor || document.body;
          const dy = Number(d.dy || 400);
          while (node && node !== document.body && node !== document.documentElement) {
            try {
              if (node.scrollHeight > node.clientHeight + 20) {
                node.scrollTop += dy;
                return { ok: true, detail: { scrolled: node.scrollTop, dy } };
              }
            } catch (_) {}
            node = node.parentElement;
          }
          window.scrollBy(0, dy);
          return { ok: true, detail: { window: window.scrollY, dy } };
        }
        if (a === 'read_secret_text') {
          // 只给本地 vault 存储流程用：按正则从页面文本里取一次性密钥（如 dop_v1_…），
          // 值只回给本地桥写 vault，不进日志、不做截图。
          let re = null;
          try { re = new RegExp(String(d.regex || '')); } catch (_) { re = null; }
          if (!re) return { ok: false, error: 'bad regex' };
          const m = bodyText().match(re);
          return m ? { ok: true, detail: { token: m[0] } } : { ok: false, error: 'pattern not found' };
        }
        if (a === 'find_input') {
          const el = findInput(d);
          return { ok: true, detail: { found: !!el, id: el ? el.id : null, tag: el ? el.tagName : null } };
        }
        if (a === 'has_text') {
          // 只回布尔，不回原文（创建成功后的密钥页也安全）
          const t = bodyText();
          const res = {};
          for (const x of d.texts || []) res[x] = t.includes(x);
          return { ok: true, detail: res };
        }
        return { ok: false, error: 'unsupported action: ' + a };
      }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('inject_timeout')), 8000))
    ]).catch(() => null);
    const r0 = results && results[0] ? results[0].result : undefined;
    if (r0 !== undefined) return r0;
    // 注入上下文被导航销毁（点击跳转 / 页面刷新）时 result 为空或注入超时：
    // 交给 verifyTab 轮询复核，而不是直接报 no result。
    const vr = await verifyTab(tab.id, step);
    return vr.ok ? { ok: true, detail: 'context_lost_after_action' } : vr;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 截图当前厂商控制台标签页（先把它切到前台，captureVisibleTab 只能截活动标签）
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    // debugger 是可选权限（上架审查更严）：没授权时给出可操作提示，而不是静默失败
    chrome.permissions.contains({ permissions: ['debugger'] }, (has) => {
      if (chrome.runtime.lastError || !has) {
        return reject(new Error('需要「调试权限」才能用真实点击/输入：打开扩展弹窗，点「启用高级操作」授权后重试'));
      }
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message)); else resolve();
      });
    });
  });
}
function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(r);
    });
  });
}
function dbgDetach(tabId) {
  return new Promise((resolve) => {
    try { chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }); } catch (_) { resolve(); }
  });
}

async function captureVendorTab() {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no vendor tab' };
  // 优先 DevTools 协议（窗口最小化/遮挡也能截）
  try {
    await dbgAttach(tab.id);
    try {
      const res = await dbgSend(tab.id, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      if (res && res.data) return { ok: true, dataUrl: 'data:image/png;base64,' + res.data };
    } finally {
      await dbgDetach(tab.id);
    }
  } catch (_) { /* 落到 captureVisibleTab */ }
  try {
    await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
    await chrome.tabs.update(tab.id, { active: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 按需注入页面探针：不依赖 content script 版本，扩展重载后对新旧页面都可用。
async function probeActiveTab() {
  const tab = await pickVendorTab();
  if (!tab || !tab.id) return { ok: false, error: 'no active tab' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const vis = (el) => {
          try {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          } catch (_) { return false; }
        };
        const txt = (el) => ((el.innerText || el.textContent || '') + '').trim().replace(/\s+/g, ' ');
        // 穿透 shadow root（火山控制台是 Web Components 时，普通 querySelectorAll 看不到内容）
        const nodes = [];
        const LIMIT = 15000;
        const walk = (root) => {
          const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (const el of els) {
            if (nodes.length >= LIMIT) return;
            nodes.push(el);
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        const buttons = [];
        const seen = new Set();
        let shadowText = '';
        for (const el of nodes) {
          if (el.shadowRoot) shadowText += ' ' + (el.shadowRoot.textContent || '');
          const tag = el.tagName;
          const role = el.getAttribute ? el.getAttribute('role') : '';
          if (tag === 'BUTTON' || tag === 'A' || role === 'button' || tag === 'LABEL' || tag === 'LI' || tag === 'SPAN') {
            if (!vis(el)) continue;
            const t = txt(el).slice(0, 40);
            if (!t || seen.has(t)) continue;
            seen.add(t);
            buttons.push(t);
            if (buttons.length >= 150) break;
          }
        }
        const body = document.body ? (document.body.innerText || '') : '';
        const sample = (body + ' ' + shadowText).replace(/\s+/g, ' ').slice(0, 3000);
        const iframes = Array.from(document.querySelectorAll('iframe'))
          .map((f) => f.src).filter(Boolean).slice(0, 20);
        const inputs = [];
        for (const el of nodes) {
          const tag = el.tagName;
          if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') continue;
          if (!vis(el)) continue;
          inputs.push({
            tag,
            type: el.getAttribute('type') || '',
            placeholder: el.getAttribute('placeholder') || '',
            aria: el.getAttribute('aria-label') || '',
            name: el.getAttribute('name') || '',
            id: el.id || '',
            label: el.labels && el.labels.length ? el.labels[0].innerText : ''
          });
          if (inputs.length >= 80) break;
        }
        const interesting = [];
        for (const el of nodes) {
          const t = txt(el).replace(/\s+/g, ' ');
          if (t !== '用户' && t !== '用户管理' && t !== '新建用户' && t !== '创建用户') continue;
          interesting.push({
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 100),
            role: el.getAttribute('role') || '',
            href: el.getAttribute('href') || '',
            text: t
          });
          if (interesting.length >= 30) break;
        }
        return {
          url: location.href,
          title: document.title,
          text_sample: sample,
          buttons,
          iframes,
          interesting,
          inputs,
          has_new_user: sample.includes('新建用户') || sample.includes('创建用户'),
          node_count: nodes.length
        };
      }
    });
    const frames = (results || []).map((r) => Object.assign({ frame_id: r.frameId }, r.result || {}));
    return { ok: true, detail: { frames } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function forwardExec(step) {
  // ★ 执行统一走按需注入（execViaScripting）：页面里的 content script 会随扩展重载
  //   变成旧版本，优先它会点到旧逻辑/假成功。content script 只保留状态回传和浮层。
  return execViaScripting(step);
}

// 页面状态 → 桥（只转发白名单字段）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'srvprice:state') {
    const s = msg.state || {};
    const safe = {
      url: String(s.url || ''),
      page: String(s.page || ''),
      step_id: String(s.step_id || ''),
      visible_text_hash: String(s.visible_text_hash || '')
    };
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: safe }));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'srvprice:prompt_result') {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'prompt_result', id: msg.id || '', action: msg.action || 'ack' }));
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'srvprice:record') {
    if (recorder && msg.event) {
      recEvents.push(msg.event);
      if (recEvents.length > REC_MAX) recEvents.shift();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'record_event', event: msg.event }));
      }
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'srvprice:autopair') {
    const port = Number(msg.port || DEFAULT_PORT);
    autoPair(port).then((token) => {
      if (!token) {
        sendResponse({ ok: false, error: '配对失败：确认客户端 start 在运行，然后重试' });
        return;
      }
      try { if (ws) ws.close(); } catch (_) {}
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'srvprice:pair') {
    const port = Number(msg.port || DEFAULT_PORT);
    fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: msg.nonce })
    }).then((r) => r.json()).then((j) => {
      if (!j || !j.ok) {
        sendResponse({ ok: false, error: (j && j.error) || 'pair rejected' });
        return;
      }
      chrome.storage.local.set({ bridgeToken: j.token, bridgePort: j.port || port }, () => {
        try { if (ws) ws.close(); } catch (_) {}
        connect();
        sendResponse({ ok: true });
      });
    }).catch((e) => {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true;
  }
  if (msg.type === 'srvprice:reconnect') {
    try { if (ws) ws.close(); } catch (_) {}
    connect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'srvprice:status') {
    storageGet(['bridgeToken']).then((d) => {
      sendResponse({
        ok: true,
        connected: !!ws && ws.readyState === 1,
        wsState: ws ? ws.readyState : -1,
        hasToken: !!d.bridgeToken
      });
    });
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.alarms.create('srvprice-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'srvprice-keepalive') connect();
});
connect();
