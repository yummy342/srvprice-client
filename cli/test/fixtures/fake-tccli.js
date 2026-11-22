#!/usr/bin/env node
'use strict';

// 测试桩：模拟腾讯云 CLI（tccli 3.1.202.1）。
// 真机调用：tccli cvm DescribeInstances --Limit 100 --region ap-guangzhou
// 响应：InstanceSet[]（InstanceState 大写 RUNNING/STOPPED；Placement.Zone 是可用区）。
// 地域表：tccli cvm DescribeRegions -> RegionSet[].Region。

const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { status: 'RUNNING' }; }
}
function writeState(s) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s));
}
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('3.1.202.1 (fake)\n');
  process.exit(0);
}

// 真机无凭据：secretId is invalid，退出码 255
if (process.env.FAKE_TCCLI_AUTH_FAIL && args[0] === 'cvm') {
  process.stderr.write('secretId is invalid\n');
  process.exit(255);
}

if (args[0] === 'configure' && args[1] === 'list') {
  if (process.env.FAKE_TCCLI_NO_CREDS) {
    process.stdout.write('credential:\nconfigure:\nregion = ap-guangzhou\n');
    process.exit(0);
  }
  process.stdout.write('credential:\nsecretId = FAKE_SECRET_ID\nsecretKey = FAKE_SECRET_KEY\nconfigure:\nregion = ap-guangzhou\noutput = json\n');
  process.exit(0);
}

if (args[0] === 'cvm' && args[1] === 'DescribeRegions') {
  process.stdout.write(JSON.stringify({
    TotalCount: 2,
    RegionSet: [{ Region: 'ap-guangzhou' }, { Region: 'ap-beijing' }],
    RequestId: 'fake-regions'
  }));
  process.exit(0);
}

if (args[0] === 'cvm' && args[1] === 'DescribeInstances') {
  const region = flag('--region') || 'ap-guangzhou';
  const st = readState();
  // 和真机一致：实例只出现在它自己的地域（多地域遍历时不能每个地域都返回同一台）
  const set = region === 'ap-beijing'
    ? [{
        InstanceId: 'i-tc001',
        InstanceName: 'web-tc',
        Placement: { Zone: 'ap-beijing-3' },
        InstanceState: st.status,
        PublicIpAddresses: ['203.0.113.31'],
        InstanceType: 'S5.MEDIUM4'
      }]
    : [];
  process.stdout.write(JSON.stringify({ TotalCount: set.length, InstanceSet: set, RequestId: 'fake-list' }));
  process.exit(0);
}

if (args[0] === 'cvm' && args[1] === 'StopInstances') {
  writeState({ status: 'STOPPED' });
  process.stdout.write(JSON.stringify({ RequestId: 'fake-stop' }));
  process.exit(0);
}

if (args[0] === 'cvm' && args[1] === 'StartInstances') {
  writeState({ status: 'RUNNING' });
  process.stdout.write(JSON.stringify({ RequestId: 'fake-start' }));
  process.exit(0);
}

if (args[0] === 'cvm' && args[1] === 'RebootInstances') {
  process.stdout.write(JSON.stringify({ RequestId: 'fake-reboot' }));
  process.exit(0);
}

process.stderr.write(`fake-tccli: 未模拟的子命令 ${JSON.stringify(args)}\n`);
process.exit(2);
