'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const site = require('../lib/site');

// 起一个临时站点，断言客户端只读解析、错误不猜
function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, baseUrl: 'http://127.0.0.1:' + srv.address().port });
    });
  });
}

test('快照：解析 items 并保留 stale / verified_this_week 口径', async (t) => {
  const { srv, baseUrl } = await serve((req, res) => {
    assert.strictEqual(req.url, '/api/server-snapshot');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      as_of: '2026-10-30',
      generated_at: '2026-11-16T09:41:31',
      counts: { items: 2, verified_this_week: 1 },
      items: [
        { id: 'ali-ecs99', vendor: '阿里云', product: 'ECS 经济型 e', spec: '2C2G', price: '99 元/年', stale: true, verified_this_week: false, source_date: '2026-10-30' },
        { id: 'ten-lh', vendor: '腾讯云', product: '轻量锐驰型', spec: '2C2G', price: '45 元/月', stale: false, verified_this_week: true, source_date: '2026-11-10' }
      ]
    }));
  });
  t.after(() => srv.close());
  const s = await site.snapshot({ baseUrl, timeoutMs: 5000 });
  assert.strictEqual(s.as_of, '2026-10-30');
  assert.strictEqual(s.items.length, 2);
  assert.strictEqual(s.items[0].stale, true);
  assert.strictEqual(s.items[0].verified_this_week, false);
  assert.strictEqual(s.items[1].vendor, '腾讯云');
});

test('比价：域名进 query（编码），channels 原样返回', async (t) => {
  const { srv, baseUrl } = await serve((req, res) => {
    assert.strictEqual(req.url, '/api/compare?domain=srvprice.com');
    res.end(JSON.stringify({
      ok: true,
      report: {
        domain: 'srvprice.com',
        generated_at: '2026-11-22T00:00:00Z',
        channels: [{ channel: 'porkbun', name: 'Porkbun', first: 11.81, renew: 11.81, verified: true }]
      }
    }));
  });
  t.after(() => srv.close());
  const r = await site.compare('SRVPRICE.COM', { baseUrl, timeoutMs: 5000 });
  assert.strictEqual(r.domain, 'srvprice.com');
  assert.strictEqual(r.channels.length, 1);
  assert.strictEqual(r.channels[0].name, 'Porkbun');
});

test('非 200 / 非 JSON / ok:false 都明确报错（不猜数据）', async (t) => {
  const { srv, baseUrl } = await serve((req, res) => {
    if (req.url.includes('missing')) { res.statusCode = 404; return res.end('nope'); }
    if (req.url.includes('badjson')) return res.end('<html>oops</html>');
    res.end(JSON.stringify({ ok: false, error: 'upstream down' }));
  });
  t.after(() => srv.close());
  await assert.rejects(() => site.fetchJson('/x/missing', { baseUrl, timeoutMs: 5000 }), /HTTP 404/);
  await assert.rejects(() => site.fetchJson('/x/badjson', { baseUrl, timeoutMs: 5000 }), /不是 JSON/);
  await assert.rejects(() => site.fetchJson('/x/fail', { baseUrl, timeoutMs: 5000 }), /upstream down/);
});

test('超时：不挂死，按超时时间报错', async (t) => {
  const { srv, baseUrl } = await serve(() => { /* 故意不响应 */ });
  t.after(() => srv.close());
  await assert.rejects(() => site.fetchJson('/slow', { baseUrl, timeoutMs: 300 }), /超时/);
});

test('比价不接受空域名', async () => {
  await assert.rejects(() => site.compare(''), /需要域名/);
});
