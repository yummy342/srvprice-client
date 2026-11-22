'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { createBridge } = require('../lib/bridge');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

function httpPostJson(url, obj, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, extraHeaders || {})
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function nextClose(ws) {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

function hello(token, origin) {
  return JSON.stringify({ type: 'hello', token, origin });
}

test('token 不对被拒（4003）', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const ws = await open(`ws://127.0.0.1:${bridge.port}/ws`);
  const closed = nextClose(ws);
  ws.send(hello('wrong', ORIGIN));
  assert.strictEqual(await closed, 4003);
  await bridge.close();
});

test('来源不是 chrome-extension:// 被拒（4003）', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const ws = await open(`ws://127.0.0.1:${bridge.port}/ws`);
  const closed = nextClose(ws);
  ws.send(hello('right', 'https://evil.example'));
  assert.strictEqual(await closed, 4003);
  await bridge.close();
});

test('正确 token + 扩展来源可连；state 只收白名单；exec 有回包', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const ws = await open(`ws://127.0.0.1:${bridge.port}/ws`);
  const got = { hello: null, exec: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'hello_ok') got.hello = m;
    if (m.type === 'exec') {
      got.exec = m;
      ws.send(JSON.stringify({ type: 'step_result', id: m.id, ok: true, detail: 'clicked' }));
    }
  });
  ws.send(hello('right', ORIGIN));

  const t0 = Date.now();
  while (!got.hello && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.hello, '应收到 hello_ok');
  assert.strictEqual(got.hello.server, 'srvprice-client');

  ws.send(JSON.stringify({
    type: 'state',
    state: { url: 'https://console.volcengine.com/iam/user', page: '用户管理', step_id: 's1', visible_text_hash: 'abc' }
  }));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(bridge.getState().step_id, 's1');

  const res = await bridge.exec({ step_id: 's1', do: { action: 'click' } });
  assert.strictEqual(res.ok, true);
  assert.ok(got.exec && got.exec.step.step_id === 's1');

  await bridge.close();
});

test('浮层消息推给扩展；用户确认记为 ack', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const ws = await open(`ws://127.0.0.1:${bridge.port}/ws`);
  let overlayMsg = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'overlay') overlayMsg = m.overlay;
  });
  ws.send(hello('right', ORIGIN));
  await new Promise((r) => setTimeout(r, 80));

  const sent = bridge.overlay({ title: 't', message: '需要你完成', status: 'waiting', ack: '我已完成', id: 's1' });
  assert.strictEqual(sent, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(overlayMsg.message, '需要你完成');

  ws.send(JSON.stringify({ type: 'prompt_result', id: 's1', action: 'ack' }));
  await new Promise((r) => setTimeout(r, 80));
  const ack = JSON.parse(await httpGet(`http://127.0.0.1:${bridge.port}/ack`));
  assert.strictEqual(ack.ok, true);
  assert.strictEqual(ack.ack.id, 's1');

  await bridge.close();
});

test('浮层中文经 HTTP 传输不乱码', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const ws = await open(`ws://127.0.0.1:${bridge.port}/ws`);
  let got = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'overlay') got = m.overlay;
  });
  ws.send(hello('right', ORIGIN));
  await new Promise((r) => setTimeout(r, 80));
  const res = await httpPostJson(`http://127.0.0.1:${bridge.port}/overlay`,
    { overlay: { title: '火山助手', message: '中文测试：需要你完成', ack: '我已完成' } },
    { 'x-srvprice-token': 'right' });
  assert.strictEqual(res.ok, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(got.title, '火山助手');
  assert.strictEqual(got.message, '中文测试：需要你完成');
  await bridge.close();
});

test('非 UTF-8 请求体被 400 拒绝（不再静默变成 �）', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const gbk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]); // “中文”的 GBK 字节
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: bridge.port,
      path: '/overlay',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-srvprice-token': 'right',
        'content-length': gbk.length
      }
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(gbk);
    req.end();
  });
  assert.strictEqual(status, 400);
  await bridge.close();
});

test('配对页发一次性 nonce，换 token 一次后失效', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const base = `http://127.0.0.1:${bridge.port}`;
  const html = await httpGet(`${base}/pair`);
  const m = html.match(/name="srvprice-pair-nonce" content="([a-f0-9]{32})"/);
  assert.ok(m, '配对页应包含 nonce meta');
  const first = await httpPostJson(`${base}/pair`, { nonce: m[1] });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.token, 'right');
  const second = await httpPostJson(`${base}/pair`, { nonce: m[1] });
  assert.strictEqual(second.ok, false, 'nonce 必须一次性');
  await bridge.close();
});

test('执行接口必须带桥 token', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const base = `http://127.0.0.1:${bridge.port}`;
  const noAuth = await httpPostJson(`${base}/exec`, { step: { step_id: 'x' } });
  assert.strictEqual(noAuth.ok, false);
  assert.match(noAuth.error, /unauthorized/);
  await bridge.close();
});

test('/record/status 必须带桥 token', async () => {
  const bridge = await createBridge({ port: 0, token: 'tk', log: () => {} });
  const base = `http://127.0.0.1:${bridge.port}`;
  try {
    const no = JSON.parse(await httpGet(`${base}/record/status`));
    assert.strictEqual(no.ok, false);
    assert.match(no.error, /unauthorized/);

    const yes = await new Promise((resolve, reject) => {
      http.get(`${base}/record/status`, { headers: { 'x-srvprice-token': 'tk' } }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    assert.strictEqual(yes.ok, true);
    assert.strictEqual(yes.recording, false);
  } finally {
    await bridge.close();
  }
});

test('没有扩展连接时 exec 直接返回错误', async () => {
  const bridge = await createBridge({ port: 0, token: 'right', log: () => {} });
  const res = await bridge.exec({ step_id: 'x' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /not connected/);
  await bridge.close();
});
