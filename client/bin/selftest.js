#!/usr/bin/env node
'use strict';

// 桥协议自测：模拟扩展连上正在运行的本地桥，验证 token + 来源 + state 回传。
// 用法：先 `node bin/srvprice-client.js start`，再 `node bin/selftest.js`

const http = require('http');
const WebSocket = require('ws');
const cfg = require('../lib/config');

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const token = cfg.readToken();
const port = cfg.defaultPort();

if (!token) {
  console.error('还没有桥 token：先运行 node bin/srvprice-client.js start');
  process.exit(1);
}

function getState() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/state', timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const timer = setTimeout(() => {
  console.error('FAIL: 5 秒内没收到 hello_ok');
  process.exit(1);
}, 5000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', token, origin: ORIGIN }));
});

ws.on('message', async (raw) => {
  let msg = null;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
  if (msg.type !== 'hello_ok') return;

  const state = {
    url: 'https://selftest.local/',
    page: 'selftest',
    step_id: 'selftest',
    visible_text_hash: 'deadbeef'
  };
  ws.send(JSON.stringify({ type: 'state', state }));

  await new Promise((r) => setTimeout(r, 150));
  let seen = null;
  try { seen = await getState(); } catch (e) {
    console.error('FAIL: /state 读不到：' + e.message);
    process.exit(1);
  }
  const ok = seen && seen.state && seen.state.step_id === 'selftest';
  clearTimeout(timer);
  console.log(ok
    ? `OK: 桥协议通（${msg.server}@${msg.version}，state 回传已确认）`
    : 'FAIL: 桥收到了 hello，但没收到/没存住 state');
  ws.close();
  process.exit(ok ? 0 : 1);
});

ws.on('error', (e) => {
  clearTimeout(timer);
  console.error('FAIL: 连不上桥（' + e.message + '）——先运行 start');
  process.exit(1);
});
