'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { route, detectDomain } = require('../lib/intent');

test('域名比价：带域名的价格类问法路由到 compare', () => {
  const p = route('srvprice.com 比价');
  assert.strictEqual(p.intent, 'compare');
  assert.strictEqual(p.target, 'client');
  assert.deepStrictEqual(p.args, ['compare', 'srvprice.com', '--json']);
});

test('价格快照：价格类问法路由到 prices，可带厂商', () => {
  const p = route('阿里云服务器现在什么价格');
  assert.strictEqual(p.intent, 'prices');
  assert.deepStrictEqual(p.args, ['prices', '--json', '--vendor', 'aliyun']);
});

test('优惠链接仍走购买路径（不被 prices 抢走）', () => {
  const p = route('买服务器的优惠链接');
  assert.strictEqual(p.intent, 'buy');
});

test('不误伤既有问法：资源列表 / 选型', () => {
  assert.strictEqual(route('我有哪些机器').intent, 'list');
  assert.strictEqual(route('找一台便宜的服务器').intent, 'recommend');
});

test('带套餐 ID 的购买问法路由到 purchase show（不直接打开官网）', () => {
  const p = route('买阿里云的 ali-ecs99');
  assert.strictEqual(p.intent, 'purchase');
  assert.deepStrictEqual(p.args, ['purchase', 'show', 'ali-ecs99']);
  assert.strictEqual(p.human_gate, 'payment');
  // 没有套餐 ID 仍走原来的购买链接
  assert.strictEqual(route('买阿里云的服务器').intent, 'buy');
});

test('detectDomain 只认常见后缀，不把 IP/版本号当域名', () => {
  assert.strictEqual(detectDomain('查一下 srvprice.com'), 'srvprice.com');
  assert.strictEqual(detectDomain('给 1.2.3.4 开 3389 端口'), null);
  assert.strictEqual(detectDomain('版本 1.2'), null);
});
