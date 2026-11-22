#!/usr/bin/env node
'use strict';

// 测试桩：模拟百度智能云官方 CLI（bce 0.1.148）。
// 真机调用：bce bcc ListInstances --region bj --maxKeys 100；响应含 instances[] / isTruncated / nextMarker。

const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { status: 'Running' }; }
}
function writeState(s) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s));
}

if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('bce 0.1.148 (fake)\n');
  process.exit(0);
}

// 真机无凭据：exit 1 + 下面这句（2026-11-19 实测）
if (process.env.FAKE_BCE_AUTH_FAIL && args[0] === 'bcc') {
  process.stderr.write('Error: no profile configured; run `bce configure set` to set up your credentials\n');
  process.exit(1);
}

if (args[0] === 'configure' && args[1] === 'list') {
  if (process.env.FAKE_BCE_NO_CREDS) {
    process.stdout.write('暂无 profile，请运行 `bce configure set` 创建\n');
    process.exit(0);
  }
  process.stdout.write('default *\n');
  process.exit(0);
}

if (args[0] === 'bcc' && args[1] === 'ListInstances') {
  const ri = args.indexOf('--region');
  const region = ri >= 0 ? args[ri + 1] : null;
  if (!region) {
    process.stderr.write('Error: region is required\n');
    process.exit(1);
  }
  const st = readState();
  const list = region === 'bj'
    ? [{
        id: 'i-bce001', name: 'web-bce', status: st.status,
        publicIp: '203.0.113.21', internalIp: '10.0.0.21',
        cpuCount: 2, memoryCapacityInGB: 4, zoneName: 'cn-bj-a', vpcId: 'vpc-fake'
      }]
    : [];
  process.stdout.write(JSON.stringify({
    marker: '', isTruncated: false, nextMarker: '', maxKeys: 1000, instances: list
  }));
  process.exit(0);
}

if (args[0] === 'bcc' && args[1] === 'StopInstance') {
  writeState({ status: 'Stopped' });
  process.stdout.write(JSON.stringify({ requestId: 'fake-stop' }));
  process.exit(0);
}

if (args[0] === 'bcc' && args[1] === 'StartInstance') {
  writeState({ status: 'Running' });
  process.stdout.write(JSON.stringify({ requestId: 'fake-start' }));
  process.exit(0);
}

if (args[0] === 'bcc' && args[1] === 'RebootInstance') {
  process.stdout.write(JSON.stringify({ requestId: 'fake-reboot' }));
  process.exit(0);
}

process.stderr.write(`fake-bce: 未模拟的子命令 ${JSON.stringify(args)}\n`);
process.exit(2);
