'use strict';

const test = require('node:test');
const assert = require('node:assert');
const models = require('../lib/models');

test('模型厂商目录：15 家，12 已核实 + 3 UNVERIFIED', () => {
  const cat = models.loadCatalog();
  assert.strictEqual(cat.vendors.length, 15);
  const verified = cat.vendors.filter((v) => v.status === 'verified');
  const unverified = cat.vendors.filter((v) => v.status === 'unverified');
  assert.strictEqual(verified.length, 12);
  assert.strictEqual(unverified.length, 3);
  for (const v of verified) {
    assert.strictEqual(v.openai_compatible, true, `${v.id} 应声明 OpenAI 兼容`);
    assert.strictEqual(v.auth, 'bearer');
    assert.ok(v.base_url || v.base_url_template || v.base_urls, `${v.id} 缺 base_url`);
  }
  for (const v of unverified) {
    assert.strictEqual(v.base_url, null, `${v.id} 未核实不应有 base_url`);
  }
});

test('模型厂商目录不含硬编码价格字段', () => {
  const cat = models.loadCatalog();
  const bad = [];
  const walk = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (/^(price|pricing|price_cny|monthly_cny|first_year_cny)$/i.test(k)) bad.push(`${path}.${k}`);
      if (v && typeof v === 'object') walk(v, `${path}.${k}`);
    }
  };
  walk(cat, 'catalog');
  assert.deepStrictEqual(bad, [], '不应内置价格，只能链接官方定价页/运行时读');
});

test('百炼：缺 WorkspaceId 或地域不猜，给全后拼出对应域名', () => {
  const v = models.getVendor('aliyun-bailian');
  assert.throws(() => models.resolveConfig(v, {}), (e) => e.code === 'workspace_required');
  assert.throws(() => models.resolveConfig(v, { workspace_id: 'ws1' }), (e) => e.code === 'region_required');
  assert.throws(() => models.resolveConfig(v, { workspace_id: 'ws1', region: 'hk' }), (e) => e.code === 'region_required');
  const r = models.resolveConfig(v, { workspace_id: 'ws1', region: 'cn-beijing' });
  assert.strictEqual(r.base_url, 'https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.match(r.note, /按地域绑定/);
});

test('方舟：按 key 类型选地址，Agent Plan 明确不支持', () => {
  const v = models.getVendor('volcengine-ark');
  assert.strictEqual(models.resolveConfig(v, {}).base_url, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.strictEqual(models.resolveConfig(v, { key_type: 'coding' }).base_url,
    'https://ark.cn-beijing.volces.com/api/coding/v3');
  assert.throws(() => models.resolveConfig(v, { key_type: 'agent' }),
    (e) => e.code === 'agent_plan_unsupported');
  assert.throws(() => models.resolveConfig(v, { key_type: 'nope' }), (e) => e.code === 'key_type_invalid');
});

test('DeepSeek base_url 不带 /v1', () => {
  const r = models.resolveConfig(models.getVendor('deepseek'));
  assert.strictEqual(r.base_url, 'https://api.deepseek.com');
});

test('MiniMax 不发 temperature / top_p，其它厂商不过滤', () => {
  const mm = models.getVendor('minimax');
  assert.deepStrictEqual(models.sanitizeParams(mm, { temperature: 0.7, top_p: 0.9, max_tokens: 8 }),
    { max_tokens: 8 });
  const ds = models.getVendor('deepseek');
  assert.deepStrictEqual(models.sanitizeParams(ds, { temperature: 0.7, top_p: 0.9, max_tokens: 8 }),
    { temperature: 0.7, top_p: 0.9, max_tokens: 8 });
});

test('UNVERIFIED 厂商拒绝接入调用', () => {
  for (const id of ['baichuan', 'qianfan', 'tencent-tokenhub']) {
    const v = models.getVendor(id);
    assert.throws(() => models.resolveConfig(v, {}), (e) => e.code === 'unverified_vendor');
  }
});

test('key 打码只显示前缀 + 长度', () => {
  // 分片拼接，避免像真 key 一样被 GitHub secret scanning 报警
  const FAKE = 'sk-' + 'TEST0000000000';
  assert.strictEqual(models.maskKey(FAKE), 'sk-T…（17 位）');
  assert.strictEqual(models.maskKey('short'), '*…（5 位）');
});

test('vault 条目命名稳定', () => {
  assert.deepStrictEqual(models.keyItem(models.getVendor('aliyun-bailian')),
    { name: 'MODEL_ALIYUN_BAILIAN_KEY', env: 'DASHSCOPE_API_KEY' });
  assert.deepStrictEqual(models.keyItem(models.getVendor('kimi')),
    { name: 'MODEL_KIMI_KEY', env: 'MOONSHOT_API_KEY' });
});
