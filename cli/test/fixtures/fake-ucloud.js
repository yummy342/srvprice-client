#!/usr/bin/env node
'use strict';
// 按 v0.3.10 真机输出形状（ResourceID / UHostName / State / Zone / PublicIP / Type）
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('ucloud cli 0.3.10 (fake)\n'); process.exit(0); }
if (args[0] === 'config' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'project' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ ProjectId: 'org-test', ProjectName: 'Default', IsDefault: true }]));
  process.exit(0);
}
if (args[0] === 'uhost' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    UHostName: 'web-uc', ResourceID: 'uhost-abc123', State: 'Running',
    Zone: 'sg-02', PublicIP: '203.0.113.13', PrivateIP: '10.0.0.2',
    Type: 'O/N4', Config: 'cpu:2 memory:4G disk:0G'
  }]));
  process.exit(0);
}
if (args[0] === 'ulhost' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0); }
if (args[0] === 'uhost' && ['start', 'stop', 'restart'].includes(args[1])) {
  process.stdout.write('{}'); process.exit(0);
}
process.stderr.write('fake-ucloud: 未模拟 ' + JSON.stringify(args) + '\n'); process.exit(2);
