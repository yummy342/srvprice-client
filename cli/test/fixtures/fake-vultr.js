#!/usr/bin/env node
'use strict';
// 按 vultr-cli 3.11.0 真机行为：`instance` 只有 start / stop / restart，没有 halt / reboot
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write('Vultr-CLI v3.11.0\n'); process.exit(0); }
if (args[0] === 'instance' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    id: 'cb1f9c3e-0000-0000-0000-000000000001',
    label: 'v-ws',
    hostname: 'v-ws',
    region: 'atl',
    plan: 'vc2-1c-1gb',
    power_status: 'running',
    status: 'active',
    main_ip: '203.0.113.9'
  }]));
  process.exit(0);
}
if (args[0] === 'instance' && ['start', 'stop', 'restart'].includes(args[1])) {
  process.stdout.write('{}');
  process.exit(0);
}
if (args[0] === 'instance' && ['halt', 'reboot'].includes(args[1])) {
  process.stderr.write('Error: unknown command "' + args[1] + '" for "vultr-cli instance"\n');
  process.exit(1);
}
process.stderr.write('fake-vultr: 未模拟 ' + JSON.stringify(args) + '\n');
process.exit(2);
