'use strict';

// 把站点的 /api/server-snapshot 转成 CLI 的 plans 结构。
// 口径：不猜。价格解析不出来就给 null；快照里没有的字段留空。

const REGION_MAP = [
  [/^大陆/, 'cn'],
  [/港台|香港|台北|海外/, 'hk'],
  [/全球/, 'overseas']
];

function mapRegion(raw) {
  const s = String(raw || '');
  for (const [re, key] of REGION_MAP) if (re.test(s)) return key;
  return null;
}

function num(m) {
  return m ? Number(m[1]) : null;
}

// "45 元/月、459 元/年" / "158 元/1 年" / "207.36 元/月、1 年 2134.02 元" / "831 元/年起"
function parsePrice(text) {
  const s = String(text || '');
  const monthly = num(s.match(/([\d.]+)\s*元\s*\/\s*月/));
  let yearly = num(s.match(/([\d.]+)\s*元\s*\/\s*(?:1\s*)?年/));
  if (yearly == null) yearly = num(s.match(/1\s*年\s*([\d.]+)\s*元/));
  if (yearly == null) yearly = num(s.match(/([\d.]+)\s*元\s*\/\s*首年/));
  if (yearly == null && monthly == null) yearly = num(s.match(/([\d.]+)\s*元/));
  return { first_year_cny: yearly, monthly_cny: monthly };
}

// "2C2G/3M/40G ESSD" → {cpu:2, mem_gb:2, bandwidth_mbps:3, disk_gb:40}
function parseSpec(text) {
  const s = String(text || '');
  // 先抓 "2C2G" / "2 核 4G" 这种连写，避免把后面的 40G 盘当成内存
  const pair = s.match(/(\d+)\s*[C核]\s*(\d+)\s*G/);
  const cpu = pair ? Number(pair[1]) : num(s.match(/(\d+)\s*[C核]/));
  const mem = pair ? Number(pair[2]) : null;
  const bw = num(s.match(/(\d+)\s*M(?:bps)?(?=\s|\/|$)/));
  const disk = num(s.match(/(\d+)\s*G\s*(?:ESSD|SSD|系统盘|数据盘|盘)/));
  return { cpu, mem_gb: mem, bandwidth_mbps: bw, disk_gb: disk };
}

function eligibilityOf(item) {
  const text = `${item.eligibility || ''} ${item.note || ''} ${item.limit || ''}`;
  // ★ 先认「个人/企业均可」：那说明不是 enterprise-only
  const mentionsPersonal = /个人/.test(text);
  if (!mentionsPersonal && /须企业实名|仅企业|企业实名/.test(text)) return 'enterprise';
  if (!/新老同享/.test(text) && /新用户|新客|新人|新手|首台/.test(text)) return 'new_user';
  return 'all';
}

function toPlan(it) {
  const price = parsePrice(it.price);
  const specs = parseSpec(it.spec);
  return {
    id: it.id,
    provider: providerId(it.vendor),
    provider_label: it.vendor || null,
    name: [it.product, it.spec].filter(Boolean).join(' / ') || it.product || it.id,
    region: mapRegion(it.region),
    region_label: it.region || null,
    specs: {
      cpu: specs.cpu,
      mem_gb: specs.mem_gb,
      disk_gb: specs.disk_gb,
      bandwidth_mbps: specs.bandwidth_mbps,
      traffic: null
    },
    price: {
      first_year_cny: price.first_year_cny,
      monthly_cny: price.monthly_cny,
      renew: it.renewal || null,
      note: it.note || null
    },
    eligibility: eligibilityOf(it),
    requires_icp: mapRegion(it.region) === 'cn',
    purchase_limit: it.limit || null,
    source_url: it.source || null,
    verified_at: it.source_date || null,
    confidence: it.source_status === 'needs_browser' ? 'needs_browser' : (it.verified_this_week ? 'page' : 'unverified'),
    deadlines: it.deadline || null
  };
}

const VENDOR_IDS = {
  '阿里云': 'aliyun', 'UCloud': 'ucloud', '西部数码': 'westcn',
  '腾讯云': 'tencent', '京东云': 'jdcloud', '百度智能云': 'baidu',
  '天翼云': 'ctyun', 'DigitalOcean': 'digitalocean', 'Vultr': 'vultr'
};

function providerId(vendor) {
  return VENDOR_IDS[vendor] || String(vendor || '').toLowerCase();
}

function snapshotToPlans(doc) {
  const items = (doc && doc.items) || [];
  return {
    schema: 2,
    source: 'api:/api/server-snapshot',
    snapshot_date: doc.as_of || null,
    generated_at: doc.generated_at || null,
    note: doc.usage || null,
    plans: items.map(toPlan)
  };
}

module.exports = { snapshotToPlans, parsePrice, parseSpec, mapRegion, providerId };
