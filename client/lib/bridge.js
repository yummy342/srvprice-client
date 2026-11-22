'use strict';

// 本地桥：127.0.0.1 上的 WebSocket，只接受带 token + chrome-extension:// 来源的扩展。
// 协议（JSON）：
//   扩展 → 桥： {type:"hello", token, origin}
//               {type:"state", state:{url,page,step_id,visible_text_hash}}
//               {type:"step_result", id, ok, error?}
//   桥 → 扩展： {type:"hello_ok", ...} / {type:"exec", id, step} / {type:"voice", text}
// 规格：§7.4 / §7.5。

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { appDir, ensureDir } = require('./config');
const pkg = require('../package.json');

const DEFAULT_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function createBridge(opts = {}) {
  // ★ 0 是合法端口（测试用临时端口），不能写成 `opts.port || 8790`
  const port = Number.isFinite(opts.port) ? Number(opts.port) : 8790;
  const token = opts.token || '';
  const originRegex = opts.originRegex || DEFAULT_ORIGIN;
  const helloTimeoutMs = opts.helloTimeoutMs || 5000;
  const log = opts.log || (() => {});

  const state = {
    latest: null, client: null, lastAck: null,
    record: { recording: false, id: null, started_at: null, events: [] }
  };
  const pending = new Map();
  const pendingProbe = new Map();
  const pendingShot = new Map();
  const pendingMisc = new Map();
  let seq = 0;
  let seqProbe = 0;
  let seqShot = 0;
  let seqMisc = 0;

  // 一键配对：一次性 nonce（120 秒有效、用后即焚）。
  // 扩展在 127.0.0.1 的配对页里读到 nonce → 换到 token → 自动连接。
  // 页面本身不返回 token；换 token 必须带有效 nonce（且只从回环地址可达）。
  const pairNonces = new Map();
  function newPairNonce() {
    const n = crypto.randomBytes(16).toString('hex');
    pairNonces.set(n, Date.now() + 120000);
    return n;
  }
  function consumePairNonce(n) {
    const exp = pairNonces.get(n);
    pairNonces.delete(n);
    return !!exp && Date.now() <= exp;
  }

  // ★ 请求体必须**收集 buffer 后一次性 UTF-8 解码**：逐 chunk `body += d` 会在
  //   多字节汉字跨 chunk 边界时劈开字符，页面上就变成乱码（现场 2026-11-20）。
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (!ok) return reject(new Error('bad_utf8'));
        resolve(Buffer.concat(chunks).toString('utf8'));
      };
      req.on('data', (d) => {
        size += d.length;
        if (size > limit) { req.destroy(); finish(false); return; }
        chunks.push(d);
      });
      req.on('end', () => {
        // ★ 严格 UTF-8 校验：GBK 等别的编码送进来直接 400，别静默变成 � 再显示给用户
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          finish(true);
        } catch (_) {
          finish(false);
        }
      });
      req.on('error', () => finish(false));
    });
  }

  function badBody(res) {
    try {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求体不是合法 UTF-8' }));
    } catch (_) {}
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, connected: !!state.client }));
      return;
    }
    // 只读的最近状态（本地排障/自测用；只含 state 白名单字段）
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: state.latest }));
      return;
    }
    // 一键配对页：扩展的 127.0.0.1 content script 会读走页面里的 nonce
    if (req.method === 'GET' && req.url === '/pair') {
      const nonce = newPairNonce();
      log('配对页已打开，nonce 已发出');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end([
        '<!doctype html><meta charset="utf-8">',
        '<title>srvprice 客户端配对</title>',
        `<meta name="srvprice-pair-nonce" content="${nonce}">`,
        '<body style="font:14px/1.7 system-ui,sans-serif;margin:40px">',
        '<h3>srvprice 客户端配对</h3>',
        '<p id="msg">正在配对…（如果一直停在这里，请确认扩展已安装并启用）</p>',
        '</body>'
      ].join(''));
      return;
    }
    // 用 nonce 换 token（一次性、120 秒）
    if (req.method === 'POST' && req.url === '/pair') {
      readBody(req, 4096).then((body) => {
        let nonce = '';
        try { nonce = String(JSON.parse(body).nonce || ''); } catch (_) {}
        if (!consumePairNonce(nonce)) {
          log('配对失败：nonce 无效或已过期');
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid or expired nonce' }));
          return;
        }
        log('配对成功：已把 token 交给扩展');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token, port: server.address().port }));
      }).catch(() => badBody(res));
      return;
    }
    // 通知扩展自载（token 必须匹配）
    if (req.method === 'POST' && req.url === '/reload-extension') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      const sent = reloadExtension();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: sent, error: sent ? null : 'extension not connected' }));
      return;
    }
    // 列出厂商标签页 / 指定目标标签页（token 必须匹配）
    if (req.method === 'GET' && req.url === '/tabs') {
      vendorTabs().then((r) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/use-tab') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      readBody(req, 4096).then((body) => {
        let tabId = 0;
        try { tabId = Number(JSON.parse(body).tabId) || 0; } catch (_) {}
        useTab(tabId).then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        });
      }).catch(() => badBody(res));
      return;
    }
    // 抓取页面密钥并直接写入 vault（token 必须匹配；响应只返回打码值）
    if (req.method === 'POST' && req.url === '/capture-vault') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      readBody(req, 16384).then((body) => {
        let payload = {};
        try { payload = JSON.parse(body); } catch (_) {}
        captureVault(payload).then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        });
      }).catch(() => badBody(res));
      return;
    }
    // 截图（token 必须匹配）→ 保存 PNG，返回路径
    if (req.method === 'POST' && req.url === '/screenshot') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      screenshot().then((r) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      });
      return;
    }
    // 页面探针（token 必须匹配）
    if (req.method === 'POST' && req.url === '/probe') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      probe().then((r) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      });
      return;
    }
    // 用户最近一次浮层确认
    if (req.method === 'GET' && req.url === '/ack') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ack: state.lastAck || null }));
      return;
    }
    // 推浮层内容（进度 / 人机门），token 必须匹配
    if (req.method === 'POST' && req.url === '/overlay') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      readBody(req, 16384).then((body) => {
        let payload = {};
        try { payload = JSON.parse(body).overlay || {}; } catch (_) {}
        const sent = overlay(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: sent, error: sent ? null : 'extension not connected' }));
      }).catch(() => badBody(res));
      return;
    }
    // ---- 记录模式控制面（P1）：start / stop / status，token 必须匹配 ----
    if (req.method === 'POST' && req.url === '/record/start') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      readBody(req, 4096).then((body) => {
        let payload = {};
        try { payload = JSON.parse(body) || {}; } catch (_) {}
        const id = String(payload.id || '');
        state.record = { recording: true, id, started_at: new Date().toISOString(), events: [] };
        const sent = !!(state.client && state.client.readyState === 1);
        if (sent) state.client.send(JSON.stringify({ type: 'record_start', id }));
        else state.record.recording = false; // 扩展没连上就不算“正在记录”
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: sent, id, error: sent ? null : 'extension not connected' }));
      }).catch(() => badBody(res));
      return;
    }
    if (req.method === 'POST' && req.url === '/record/stop') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      const rec = state.record || { events: [] };
      rec.recording = false;
      if (state.client && state.client.readyState === 1) {
        state.client.send(JSON.stringify({ type: 'record_stop' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: rec.id || null, count: rec.events.length, events: rec.events }));
      return;
    }
    if (req.method === 'GET' && req.url === '/record/status') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      const rec = state.record || { recording: false, events: [] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, recording: !!rec.recording, id: rec.id || null,
        started_at: rec.started_at || null, count: rec.events.length, events: rec.events
      }));
      return;
    }
    // 本地控制面：让 CLI/宿主把单个 step 交给扩展执行（token 必须匹配桥 token）
    if (req.method === 'POST' && req.url === '/exec') {
      if (!safeEqual(req.headers['x-srvprice-token'] || '', token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      readBody(req, 65536).then((body) => {
        let step = null;
        try { step = JSON.parse(body).step; } catch (_) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad json' }));
          return;
        }
        exec(step).then((r) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        });
      }).catch(() => badBody(res));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'hello timeout');
    }, helloTimeoutMs);

    ws.on('message', (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch (_) {
        ws.close(4002, 'bad json');
        return;
      }
      if (!authed) {
        const good = msg && msg.type === 'hello' &&
          safeEqual(msg.token || '', token) &&
          originRegex.test(String(msg.origin || ''));
        if (!good) {
          ws.close(4003, 'unauthorized');
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        if (state.client && state.client !== ws) {
          try { state.client.close(4004, 'replaced'); } catch (_) {}
        }
        state.client = ws;
        ws.send(JSON.stringify({ type: 'hello_ok', server: 'srvprice-client', version: pkg.version }));
        log(`扩展已连接：${msg.origin}`);
        return;
      }
      if (msg.type === 'state') {
        // ★ 客户端侧二次过滤：即便扩展被改坏/被冒充，桥也只存白名单字段
        const raw = msg.state || {};
        const safe = {
          url: String(raw.url || '').slice(0, 2048),
          page: String(raw.page || '').slice(0, 200),
          step_id: String(raw.step_id || '').slice(0, 200),
          visible_text_hash: String(raw.visible_text_hash || '').slice(0, 128)
        };
        const prev = state.latest;
        state.latest = safe;
        // 只在页面/步骤变化时记一行，避免每秒刷屏
        if (!prev || prev.url !== state.latest.url || prev.step_id !== state.latest.step_id) {
          log(`页面状态：${state.latest.url} ｜ ${state.latest.page} ｜ step=${state.latest.step_id || '-'}`);
        }
        return;
      }
      if (msg.type === 'record_event') {
        const r = state.record || (state.record = { recording: false, events: [] });
        if (r.recording && msg.event) {
          r.events.push(msg.event);
          if (r.events.length > 300) r.events.shift();
        }
        return;
      }
      if (msg.type === 'record_started') {
        if (state.record) state.record.recording = true;
        return;
      }
      if (msg.type === 'record_stopped') {
        if (state.record) state.record.recording = false;
        return;
      }
      if (msg.type === 'step_result') {
        const p = pending.get(String(msg.id));
        if (p) {
          pending.delete(String(msg.id));
          p(msg);
        }
        return;
      }
      if (msg.type === 'tabs_result' || msg.type === 'use_tab_result') {
        const p = pendingMisc.get(String(msg.id));
        if (p) {
          pendingMisc.delete(String(msg.id));
          p(msg);
        }
        return;
      }
      if (msg.type === 'screenshot_result') {
        const p = pendingShot.get(String(msg.id));
        if (p) {
          pendingShot.delete(String(msg.id));
          p(msg);
        }
        return;
      }
      if (msg.type === 'probe_result') {
        const p = pendingProbe.get(String(msg.id));
        if (p) {
          pendingProbe.delete(String(msg.id));
          p(msg);
        }
        return;
      }
      if (msg.type === 'prompt_result') {
        state.lastAck = { id: String(msg.id || ''), action: msg.action || 'ack', at: Date.now() };
        log(`用户确认：${state.lastAck.id || '(无 id)'}`);
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (state.client === ws) {
        state.client = null;
        log('扩展已断开');
      }
    });
    ws.on('error', () => {});
  });

  function exec(step, options = {}) {
    // 步骤可能包含导航后 verify 轮询（最长 20s），默认要给够
    const timeoutMs = options.timeoutMs || 40000;
    return new Promise((resolve) => {
      if (!state.client || state.client.readyState !== 1) {
        resolve({ ok: false, error: 'extension not connected' });
        return;
      }
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'exec timeout' });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ok: !!msg.ok, error: msg.error || null, detail: msg.detail || null });
      });
      state.client.send(JSON.stringify({ type: 'exec', id, step }));
    });
  }

  // 页面探针：让扩展用 scripting.executeScript 现取页面信息（不依赖 content script 版本）
  function probe(options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    return new Promise((resolve) => {
      if (!state.client || state.client.readyState !== 1) {
        resolve({ ok: false, error: 'extension not connected' });
        return;
      }
      const id = String(++seqProbe);
      const timer = setTimeout(() => {
        pendingProbe.delete(id);
        resolve({ ok: false, error: 'probe timeout' });
      }, timeoutMs);
      pendingProbe.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ok: !!msg.ok, error: msg.error || null, detail: msg.detail || null });
      });
      state.client.send(JSON.stringify({ type: 'probe', id }));
    });
  }

  // 通用请求（标签页列表 / 指定目标标签页）
  function miscRpc(type, extra = {}, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (!state.client || state.client.readyState !== 1) {
        resolve({ ok: false, error: 'extension not connected' });
        return;
      }
      const id = String(++seqMisc);
      const timer = setTimeout(() => {
        pendingMisc.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      pendingMisc.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      state.client.send(JSON.stringify({ type, id, ...extra }));
    });
  }

  function vendorTabs() {
    return miscRpc('tabs').then((r) => (r && r.tabs ? { ok: true, tabs: r.tabs } : { ok: false, error: (r && r.error) || 'no tabs' }));
  }

  function useTab(tabId) {
    return miscRpc('use-tab', { tabId: Number(tabId) })
      .then((r) => ({ ok: !!(r && r.ok), tabId: r && r.tabId }));
  }

  // 把页面上的密钥值直接写进本地 vault（值只走 stdin，不落日志/不返回明文）
  function vaultAdd(name, envName, value, reason) {
    const vaultAddJs = process.env.SRVPRICE_VAULT_ADD ||
      path.join('C:', 'project', 'srv-vault', 'srv-vault-bundle', 'vault-add.js');
    return new Promise((resolve) => {
      try {
        const child = spawn(process.execPath, [vaultAddJs, name, '--env', envName,
          '--escape', reason || 'srvprice client 按用户要求把厂商只读密钥存入 vault'],
        { windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => resolve({ ok: false, message: e.message }));
        child.on('close', (code) => resolve({
          ok: code === 0,
          message: (out || err || '').slice(0, 300)
        }));
        child.stdin.write(String(value == null ? '' : value));
        child.stdin.end();
      } catch (e) {
        resolve({ ok: false, message: e.message });
      }
    });
  }

  function maskValue(v) {
    const s = String(v || '');
    if (!s) return '';
    if (s.length <= 8) return '*'.repeat(s.length);
    return s.slice(0, 4) + '…' + s.slice(-4);
  }

  // payload: {fields:[{name, matcher}], items:[{field,name,env}], reason}
  async function captureVault(payload) {
    const step = {
      step_id: 'vault-capture',
      do: {
        action: payload.mode === 'regex' ? 'read_secret_text'
          : payload.mode === 'text' ? 'read_labeled_text'
            : (payload.mode === 'dialog' ? 'read_dialog_pair' : 'read_secret_values'),
        fields: payload.fields || [],
        regex: payload.regex,
        ak_label: payload.ak_label,
        sk_label: payload.sk_label
      }
    };
    const r = await exec(step);
    if (!r.ok || !r.detail) {
      return { ok: false, error: r.error || 'capture failed' };
    }
    const values = r.detail;
    const items = [];
    for (const it of payload.items || []) {
      const v = values[it.field];
      if (!v) {
        items.push({ name: it.name, ok: false, error: 'field missing' });
        continue;
      }
      const w = await vaultAdd(it.name, it.env, v, payload.reason);
      items.push({ name: it.name, ok: w.ok, masked: maskValue(v), message: w.ok ? null : w.message });
    }
    return { ok: items.every((x) => x.ok), items };
  }

  // 截图当前厂商控制台标签页，落盘为 PNG，返回路径
  function screenshot(options = {}) {
    const timeoutMs = options.timeoutMs || 20000;
    return new Promise((resolve) => {
      if (!state.client || state.client.readyState !== 1) {
        resolve({ ok: false, error: 'extension not connected' });
        return;
      }
      const id = String(++seqShot);
      const timer = setTimeout(() => {
        pendingShot.delete(id);
        resolve({ ok: false, error: 'screenshot timeout' });
      }, timeoutMs);
      pendingShot.set(id, (msg) => {
        clearTimeout(timer);
        if (!msg.ok || !msg.dataUrl) {
          resolve({ ok: false, error: msg.error || 'capture failed' });
          return;
        }
        try {
          const dir = ensureDir(appDir());
          const file = path.join(dir, `shot-${Date.now()}.png`);
          const b64 = String(msg.dataUrl).replace(/^data:image\/png;base64,/, '');
          fs.writeFileSync(file, Buffer.from(b64, 'base64'));
          resolve({ ok: true, path: file });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
      state.client.send(JSON.stringify({ type: 'screenshot', id }));
    });
  }

  // 让扩展自己 chrome.runtime.reload()（开发期热载，不需要用户点刷新）
  function reloadExtension() {
    if (!state.client || state.client.readyState !== 1) return false;
    state.client.send(JSON.stringify({ type: 'reload' }));
    log('已通知扩展重载');
    return true;
  }

  function voice(text) {
    if (state.client && state.client.readyState === 1) {
      state.client.send(JSON.stringify({ type: 'voice', text: String(text || '') }));
    }
  }

  // 页面内浮层：{title, step, message, status, ack, id}
  function overlay(payload) {
    if (state.client && state.client.readyState === 1) {
      state.client.send(JSON.stringify({ type: 'overlay', overlay: payload || {} }));
      return true;
    }
    return false;
  }

  function close() {
    for (const [, resolve] of pending) resolve({ ok: false, error: 'bridge closed' });
    pending.clear();
    for (const c of wss.clients) {
      try { c.terminate(); } catch (_) {}
    }
    return new Promise((resolve) => {
      try { wss.close(); } catch (_) {}
      try { server.close(() => resolve()); } catch (_) { resolve(); }
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`本地桥监听 127.0.0.1:${server.address().port}`);
      resolve({
        server,
        wss,
        port: server.address().port,
        exec,
        probe,
        screenshot,
        vendorTabs,
        useTab,
        captureVault,
        reloadExtension,
        voice,
        overlay,
        close,
        connected: () => !!state.client && state.client.readyState === 1,
        getState: () => state.latest
      });
    });
  });
}

module.exports = { createBridge, DEFAULT_ORIGIN };
