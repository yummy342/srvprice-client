'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { listHosts } = require('../lib/inventory');

const FAKE = path.join(__dirname, 'fixtures', 'fake-cli.js');
const BAD = path.join(__dirname, 'fixtures', 'bad-cli.js');

// 单测里不走 vault（机器上真有 vault 时也能保持确定性/速度）
process.env.SRVPRICE_VAULT_CLI = path.join(__dirname, 'fixtures', 'no-such-vault-cli.js');

test('只读列出资源，并强制注入 SRVPRICE_READONLY=1', async () => {
  const res = await listHosts({ cli: FAKE, timeoutMs: 15000 });
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.items.length, 1);
  assert.strictEqual(res.items[0].id, 'fake:i-1');
  assert.deepStrictEqual(res.errors, []);
});

test('输出不是 JSON 时明确报错（不猜）', async () => {
  await assert.rejects(() => listHosts({ cli: BAD, timeoutMs: 15000 }), /不是 JSON/);
});
