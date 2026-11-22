#!/usr/bin/env node
'use strict';
// 按 linode-cli 5.70.0 真机形状：--json 输出对象数组；--all-rows 关分页
// 环境变量 FAKE_LINODE_NOCFG=1 模拟「没 configure」：起交互向导、EOFError 崩栈
const args = process.argv.slice(2);
if (process.env.FAKE_LINODE_NOCFG === '1') {
  process.stdout.write('Welcome to the Linode CLI.  This will walk you through some initial setup.\n' +
    'This tool defaults to web-based authentication,\n' +
    'however no known-working browsers were found.\n' +
    'Try it anyway? [y/N]: ');
  process.stderr.write('Traceback (most recent call last):\n  ...\nEOFError: EOF when reading a line\n');
  process.exit(1);
}
if (args[0] === '--version') { process.stdout.write('linode-cli v5.70.0\nBuilt from spec version 4.229.1\n'); process.exit(0); }
if (args[0] === 'linodes' && args[1] === 'list') {
  if (!args.includes('--json') || !args.includes('--all-rows')) {
    process.stderr.write('fake-linode: 缺少 --json / --all-rows（' + JSON.stringify(args) + '）\n');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify([{
    id: 123,
    label: 'lin-1',
    region: 'us-east',
    type: 'g6-nanode-1',
    status: 'running',
    ipv4: ['203.0.113.5']
  }]));
  process.exit(0);
}
process.stderr.write('fake-linode: 未模拟 ' + JSON.stringify(args) + '\n');
process.exit(2);
