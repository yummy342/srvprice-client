#!/usr/bin/env node
'use strict';
// 按 doctl 2.7.0 真机行为：未登录时把错误 JSON 打在 **stdout**、退出码 1
const args = process.argv.slice(2);
if (args[0] === 'version') { process.stdout.write('doctl version 2.7.0-release\n'); process.exit(0); }
if (args[0] === 'compute' && args[1] === 'droplet' && args[2] === 'list') {
  process.stdout.write(JSON.stringify({
    errors: [{ detail: "Unable to initialize DigitalOcean API client: access token is required. (hint: run 'doctl auth init')" }]
  }) + '\n');
  process.exit(1);
}
process.stderr.write('fake-doctl: 未模拟 ' + JSON.stringify(args) + '\n');
process.exit(2);
