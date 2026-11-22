#!/usr/bin/env node
'use strict';
// 按 hcloud 1.70.2 `server list -o json` 真机形状：location 对象、**没有** datacenter 字段
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write('hcloud 1.70.2\n'); process.exit(0); }
if (args[0] === 'server' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    id: 42,
    name: 'web-hz',
    status: 'running',
    location: { id: 1, name: 'fsn1' },
    public_net: { ipv4: { ip: '203.0.113.42' } },
    server_type: { name: 'cx22' }
  }]));
  process.exit(0);
}
process.stderr.write('fake-hcloud: 未模拟 ' + JSON.stringify(args) + '\n');
process.exit(2);
