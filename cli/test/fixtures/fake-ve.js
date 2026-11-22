#!/usr/bin/env node
'use strict';

// 测试桩：模拟 volcengine-cli（ve 2.0.2）。
// 真机输出信封：ResponseMetadata + Result.Instances[]；状态值是大写 RUNNING/STOPPED。
// 状态存在 FAKE_STATE 指向的文件里，用来验证执行后回读。

const fs = require('fs');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_STATE;

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { status: 'RUNNING' }; }
}
function writeState(s) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(s));
}

if (args.includes('--version') || args[0] === 'version') {
  process.stdout.write('ve 2.0.2 (fake)\n');
  process.exit(0);
}

// 真机无凭据：exit 1 + 下面这句（2026-11-19 实测）
if (process.env.FAKE_VE_AUTH_FAIL && args[0] === 'ecs') {
  process.stderr.write("credentials not configured, please run 've login' or 've configure set', or set VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY environment variables\n");
  process.exit(1);
}

// probeCreds: ve configure list
if (args[0] === 'configure' && args[1] === 'list') {
  if (process.env.FAKE_VE_NO_CREDS) {
    process.stdout.write('尚未创建配置档案\n');
    process.exit(0);
  }
  process.stdout.write('当前配置档案：default\n');
  process.exit(0);
}

if (args[0] === 'ecs' && args[1] === 'DescribeRegions') {
  process.stdout.write(JSON.stringify({
    ResponseMetadata: { RequestId: 'fake-regions', Action: 'DescribeRegions', Version: '2020-04-01' },
    Result: {
      NextToken: '',
      Regions: [{ RegionId: 'cn-beijing' }, { RegionId: 'cn-shanghai' }]
    }
  }));
  process.exit(0);
}

if (args[0] === 'ecs' && args[1] === 'DescribeInstances') {
  const st = readState();
  const regionIdx = args.indexOf('--region');
  const region = regionIdx >= 0 ? args[regionIdx + 1] : 'cn-beijing';
  // 和真机一致：实例只出现在它自己的地域（多地域遍历时不能每个地域都返回同一台）
  const instances = region === 'cn-beijing'
    ? [{
        InstanceId: 'i-ve001',
        InstanceName: 'web-ve',
        RegionId: region,
        ZoneId: region + '-a',
        Status: st.status,
        InstanceTypeId: 'ecs.g1.large',
        EipAddress: { IpAddress: '198.51.100.9' }
      }]
    : [];
  process.stdout.write(JSON.stringify({
    ResponseMetadata: { RequestId: 'fake-req', Action: 'DescribeInstances', Version: '2020-04-01' },
    Result: { TotalCount: instances.length, NextToken: '', Instances: instances }
  }));
  process.exit(0);
}

if (args[0] === 'ecs' && args[1] === 'StopInstance') {
  writeState({ status: 'STOPPED' });
  process.stdout.write(JSON.stringify({ ResponseMetadata: { RequestId: 'fake-stop' }, Result: {} }));
  process.exit(0);
}

if (args[0] === 'ecs' && args[1] === 'StartInstance') {
  writeState({ status: 'RUNNING' });
  process.stdout.write(JSON.stringify({ ResponseMetadata: { RequestId: 'fake-start' }, Result: {} }));
  process.exit(0);
}

if (args[0] === 'ecs' && args[1] === 'RebootInstance') {
  process.stdout.write(JSON.stringify({ ResponseMetadata: { RequestId: 'fake-reboot' }, Result: {} }));
  process.exit(0);
}

process.stderr.write(`fake-ve: 未模拟的子命令 ${JSON.stringify(args)}\n`);
process.exit(2);
