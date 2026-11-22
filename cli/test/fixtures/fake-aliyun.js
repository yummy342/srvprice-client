#!/usr/bin/env node
'use strict';

// 测试桩：模拟 aliyun CLI 的三个子命令（--version / DescribeInstances / StopInstance 等）。
// 状态存在 FAKE_STATE 指向的文件里，用来验证执行后回读。

const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { status: 'Running' }; }
}
function writeState(s) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s));
}

if (args.includes('--version')) {
  process.stdout.write('aliyun 3.0.0 (fake)\n');
  process.exit(0);
}

if (args.includes('DescribeInstances')) {
  const st = readState();
  process.stdout.write(JSON.stringify({
    TotalCount: 1,
    Instances: {
      Instance: [{
        InstanceId: 'i-fake001',
        InstanceName: 'web-01',
        RegionId: 'cn-hangzhou',
        Status: st.status,
        InstanceType: 'ecs.e-c1m2.large',
        PublicIpAddress: { IpAddress: ['203.0.113.7'] }
      }]
    }
  }));
  process.exit(0);
}

if (args.includes('StopInstance')) {
  writeState({ status: 'Stopped' });
  process.stdout.write(JSON.stringify({ RequestId: 'fake-stop' }));
  process.exit(0);
}

if (args.includes('StartInstance')) {
  writeState({ status: 'Running' });
  process.stdout.write(JSON.stringify({ RequestId: 'fake-start' }));
  process.exit(0);
}

if (args.includes('RebootInstance')) {
  process.stdout.write(JSON.stringify({ RequestId: 'fake-reboot' }));
  process.exit(0);
}

process.stderr.write(`fake-aliyun: 未模拟的子命令 ${JSON.stringify(args)}\n`);
process.exit(2);
