#!/usr/bin/env node
'use strict';
// 模拟 jdcloud-cli 1.2.12：--output 是全局参数，放在子命令之前
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) { process.stdout.write('1.2.12 (fake)\n'); process.exit(0); }
const i = args.indexOf('vm');
const sub = i >= 0 ? args[i + 1] : null;
if (sub === 'describe-instances') {
  process.stdout.write(JSON.stringify({ result: { instances: [{
    instanceId: 'i-jd001', instanceName: 'web-jd', status: 'running',
    az: 'cn-north-1a', instanceType: 'g.n2.medium', publicIpAddress: '203.0.113.12'
  }]}}));
  process.exit(0);
}
if (['start-instance', 'stop-instance', 'reboot-instance'].includes(sub)) {
  process.stdout.write(JSON.stringify({ result: {} })); process.exit(0);
}
process.stderr.write('fake-jdc: 未模拟 ' + JSON.stringify(args) + '\n'); process.exit(2);
