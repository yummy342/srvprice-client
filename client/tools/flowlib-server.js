#!/usr/bin/env node
'use strict';

// flowlib 远端参考实现（零依赖）：只存每个流程的样本数组，合并由客户端做。
// 运行：FLOWLIB_TOKEN=xxx FLOWLIB_DATA=/var/lib/flowlib.json node tools/flowlib-server.js
// 路由：
//   GET  /health
//   GET  /lib                    → {ok, flows:{id:{samples:[]}}}
//   GET  /lib/:id                → {ok, samples:[]}
//   POST /lib/:id/samples  {sample} → 按 account_hash 覆盖 → {ok, samples:[]}

const http = require('http');
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;

function loadData(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || !j.flows) return { version: 1, flows: {} };
    return j;
  } catch (_) {
    return { version: 1, flows: {} };
  }
}

function saveData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > MAX_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(opts = {}) {
  const token = String(opts.token || '');
  const dataFile = opts.dataFile || path.join(process.cwd(), 'flowlib-data.json');

  return http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
      if (!req.url.startsWith('/lib')) return send(404, { ok: false, error: 'not found' });
      if (token) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
      }
      const m = req.url.match(/^\/lib(?:\/([^/?]+))?(?:\/samples)?(?:\?.*)?$/);
      if (!m) return send(404, { ok: false, error: 'not found' });
      const id = m[1] ? decodeURIComponent(m[1]) : null;
      const data = loadData(dataFile);

      if (req.method === 'GET' && !id) return send(200, { ok: true, flows: data.flows });

      if (req.method === 'GET' && id && !/\/samples/.test(req.url)) {
        return send(200, { ok: true, samples: (data.flows[id] || {}).samples || [] });
      }

      if (req.method === 'POST' && id && /\/samples$/.test(req.url)) {
        const body = JSON.parse(await readBody(req) || '{}');
        const sample = body.sample;
        if (!sample || !sample.account_hash || !Array.isArray(sample.steps)) {
          return send(400, { ok: false, error: 'bad sample' });
        }
        const entry = data.flows[id] || { samples: [] };
        entry.samples = entry.samples.filter((s) => s.account_hash !== sample.account_hash);
        entry.samples.push(sample);
        data.flows[id] = entry;
        saveData(dataFile, data);
        return send(200, { ok: true, samples: entry.samples });
      }

      return send(404, { ok: false, error: 'not found' });
    } catch (e) {
      send(500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8791);
  const token = String(process.env.FLOWLIB_TOKEN || '');
  const dataFile = process.env.FLOWLIB_DATA || path.join(process.cwd(), 'flowlib-data.json');
  if (!token) console.error('[flowlib] 警告：FLOWLIB_TOKEN 为空，接口无鉴权，勿暴露公网');
  createServer({ token, dataFile }).listen(port, '127.0.0.1', () => {
    console.log(`[flowlib] listening 127.0.0.1:${port} data=${dataFile}`);
  });
}

module.exports = { createServer };
