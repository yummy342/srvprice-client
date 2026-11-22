#!/usr/bin/env node
'use strict';
// 测试用：模拟 srvprice CLI 的 plan/buy 输出（含 JSONL warn 行）

const args = process.argv.slice(2);
const warns = [
  { level: 'warn', message: '快照里有 8 条来自 JS 渲染页，需浏览器复核后才算现价' },
  { level: 'warn', message: '该套餐数据最新核验于 2026-10-30，已超过 24 小时' }
];

function emit(obj) {
  for (const w of warns) console.log(JSON.stringify(w));
  console.log(JSON.stringify(obj, null, 2));
}

if (args[0] === 'plan' && args[1] === 'list') {
  emit({ total: 1, items: [{ id: 'ali-ecs99', provider: 'aliyun', provider_label: '阿里云', name: 'ECS 经济型 e' }] });
} else if (args[0] === 'plan' && args[1] === 'get') {
  const id = args[args.indexOf('--id') + 1];
  if (id !== 'ali-ecs99') {
    console.error('没有找到套餐');
    process.exit(4);
  }
  emit({
    plan: {
      id, provider: 'aliyun', provider_label: '阿里云',
      name: 'ECS 经济型 e / 2C2G/3M/40G ESSD', region_label: '大陆',
      price: { first_year_cny: 99, renew: '同价' },
      eligibility: 'all', requires_icp: true,
      source_url: '阿里云 99 计划活动页',
      verified_at: '2026-10-30', confidence: 'needs_browser', deadlines: '2029-03-31'
    }
  });
} else if (args[0] === 'buy' && args[1] === 'url') {
  emit({ plan_id: 'ali-ecs99', provider: '阿里云', url: 'https://example.com/buy', warning: '不代下单' });
} else if (args[0] === 'buy' && args[1] === 'open') {
  emit({ plan_id: 'ali-ecs99', url: 'https://example.com/buy', opened: true });
} else {
  console.error('unsupported');
  process.exit(2);
}
