#!/usr/bin/env node
'use strict';
// 模拟官方 ctyun-cli 0.4.0：common ListRegions 取资源池；ecs ListEcsInstances 必填 --regionID
const args = process.argv.slice(2);
if (args.includes('--version') || args[0] === 'version') { process.stdout.write('ctyun-cli 0.4.0 (fake)\n'); process.exit(0); }
if (args[0] === 'common' && args[1] === 'ListRegions') {
  process.stdout.write(JSON.stringify({ returnObj: { regionList: [
    { regionID: 'reg-a', regionCode: 'cn-test-1', openapiAvailable: true },
    { regionID: 'reg-b', regionCode: 'cn-test-2', openapiAvailable: true }
  ]}}));
  process.exit(0);
}
if (args[0] === 'ecs' && args[1] === 'ListEcsInstances') {
  const i = args.indexOf('--regionID');
  const region = i >= 0 ? args[i + 1] : null;
  if (!region) { process.stderr.write('错误: 必填参数未提供: regionID\n'); process.exit(1); }
  const list = region === 'reg-a'
    ? [{ instanceID: 'i-ct001', displayName: 'web-ct', instanceStatus: 'ACTIVE', publicIP: '203.0.113.11', flavorName: 's7.medium' }]
    : [];
  process.stdout.write(JSON.stringify({ returnObj: { instances: list } }));
  process.exit(0);
}
if (args[0] === 'ecs' && /^(StartEcsInstance|StopEcsInstance|RebootEcsInstance)$/.test(args[1] || '')) {
  process.stdout.write(JSON.stringify({ returnObj: {} })); process.exit(0);
}
process.stderr.write('fake-ctyun: 未模拟 ' + JSON.stringify(args) + '\n'); process.exit(2);
