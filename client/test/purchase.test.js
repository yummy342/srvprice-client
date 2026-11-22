'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srvprice-purchase-'));
process.env.SRVPRICE_CLIENT_HOME = tmp;

const purchase = require('../lib/purchase');

const CLI = path.join(__dirname, 'fixtures', 'fake-purchase-cli.js');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

test('解析时剥掉 CLI 的 JSONL warn 行', () => {
  const raw = '{"level":"warn","message":"w1"}\n{"level":"warn","message":"w2"}\n{\n  "plan": {"id": "x"}\n}\n';
  const r = purchase.parseOutput(raw);
  assert.strictEqual(r.data.plan.id, 'x');
  assert.strictEqual(r.warnings.length, 2);
});

test('plan get：返回套餐与警告', () => {
  const r = purchase.getPlan('ali-ecs99', { cli: CLI });
  assert.strictEqual(r.plan.id, 'ali-ecs99');
  assert.strictEqual(r.plan.price.first_year_cny, 99);
  assert.strictEqual(r.plan.confidence, 'needs_browser');
  assert.strictEqual(r.warnings.length, 2);
});

test('plan list / buy url', () => {
  const l = purchase.listPlans({}, { cli: CLI });
  assert.strictEqual(l.total, 1);
  assert.strictEqual(l.items[0].id, 'ali-ecs99');
  const b = purchase.getBuy('ali-ecs99', { cli: CLI });
  assert.strictEqual(b.url, 'https://example.com/buy');
});

test('未知套餐：明确报错', () => {
  assert.throws(() => purchase.getPlan('nope-123', { cli: CLI }), /不是 JSON|报错/);
});

test('买前基线：写入 / 取出即清', () => {
  purchase.recordBefore('ali-ecs99', 'aliyun', ['a:1', 'a:2']);
  const s = JSON.parse(fs.readFileSync(path.join(tmp, 'purchase-state.json'), 'utf8'));
  assert.deepStrictEqual(s['ali-ecs99'].ids, ['a:1', 'a:2']);
  const got = purchase.takeBefore('ali-ecs99');
  assert.deepStrictEqual(got.ids, ['a:1', 'a:2']);
  assert.strictEqual(purchase.takeBefore('ali-ecs99'), null);
});

test('caveats：未核实置信度与快照日期都要提示', () => {
  const c = purchase.caveats(
    { confidence: 'needs_browser', verified_at: '2026-10-30' },
    [{ message: '快照已超过 24 小时' }]
  );
  assert.ok(c.some((x) => x.includes('needs_browser')));
  assert.ok(c.some((x) => x.includes('2026-10-30')));
  assert.ok(c.some((x) => x.includes('超过 24 小时')));
});
