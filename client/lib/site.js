'use strict';

// 站点数据层：只读消费 srvprice 的公开接口（快照 / 域名比价 / 推荐）。
// 这两个接口无鉴权，和网站共用同一份数据，不另起一套。
// 登录后的记录接口需要会话/令牌，不在这一层，见规格 §4。

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 测试或私有部署可用 SRVPRICE_SITE 覆盖
function baseUrl(opts = {}) {
  return opts.baseUrl || process.env.SRVPRICE_SITE || 'https://www.srvprice.com';
}

function fetchJson(pathAndQuery, opts = {}) {
  const url = new URL(pathAndQuery, baseUrl(opts));
  const timeoutMs = opts.timeoutMs || 20000;
  const mod = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => { if (settled) return; settled = true; fn(); };
    const req = mod.get(url, {
      timeout: timeoutMs,
      headers: { accept: 'application/json', 'user-agent': 'srvprice-client/0.1' }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => done(() => {
        if (res.statusCode !== 200) {
          return reject(new Error(`站点接口 ${url.pathname} 返回 HTTP ${res.statusCode}`));
        }
        let j;
        try { j = JSON.parse(body); } catch (_) {
          return reject(new Error(`站点接口 ${url.pathname} 返回的不是 JSON：${body.slice(0, 120)}`));
        }
        if (j && j.ok === false) {
          return reject(new Error(`站点接口 ${url.pathname} 报错：${j.error || 'unknown'}`));
        }
        resolve(j);
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      done(() => reject(new Error(`站点接口 ${url.pathname} 超时（${timeoutMs}ms）`)));
    });
    req.on('error', (e) => done(() => reject(new Error(`连不上站点（${e.code || e.message}）`))));
  });
}

// 周快照：items 里 stale/verified_this_week 是口径，调用方不要自己猜价
async function snapshot(opts = {}) {
  const j = await fetchJson('/api/server-snapshot', opts);
  const items = Array.isArray(j.items) ? j.items : [];
  return {
    generated_at: j.generated_at || null,
    as_of: j.as_of || null,
    counts: j.counts || null,
    items: items.map((it) => ({
      id: it.id,
      vendor: it.vendor,
      region: it.region,
      product: it.product,
      spec: it.spec,
      price: it.price,
      price_type: it.price_type,
      renewal: it.renewal,
      deadline: it.deadline,
      note: it.note,
      stale: !!it.stale,
      verified_this_week: !!it.verified_this_week,
      source: it.source,
      source_date: it.source_date,
      source_status: it.source_status
    }))
  };
}

// 域名实时比价：report.channels 是各渠道首年/续费（人民币换算字段 cny_*）
async function compare(domain, opts = {}) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) throw new Error('需要域名，例如：compare srvprice.com');
  const j = await fetchJson('/api/compare?domain=' + encodeURIComponent(d), opts);
  const r = j.report || {};
  return {
    domain: r.domain || d,
    generated_at: r.generated_at || null,
    channels: Array.isArray(r.channels) ? r.channels : []
  };
}

module.exports = { baseUrl, fetchJson, snapshot, compare };
