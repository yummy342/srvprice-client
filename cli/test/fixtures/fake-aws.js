#!/usr/bin/env node
'use strict';
// 按 aws-cli 2.41.2 真机行为：
//   - 没地域 → NoRegion（退出码 253）；有地域但无凭据 → NoCredentials（退出码 253）
//   - 设 FAKE_AWS_NO_CREDS=1 模拟未登录（describe-regions 也失败）
//   - 设 FAKE_AWS_BAD_CREDS=1 模拟密钥无效（真实 API 返回 AuthFailure）
// 地域表：us-east-1 / us-west-2 有实例，eu-west-1 为空
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('aws-cli/2.41.2 Python/3.14.10 Windows/11 exe/AMD64\n'); process.exit(0); }

function noCreds() {
  process.stderr.write('\naws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials. You can configure credentials by running "aws login".\n');
  process.exit(253);
}

function badCreds() {
  process.stderr.write('\naws: [ERROR]: An error occurred (AuthFailure) when calling the DescribeRegions operation: AWS was not able to validate the provided access credentials\n');
  process.exit(253);
}

if (args[0] === 'ec2' && args[1] === 'describe-regions') {
  if (process.env.FAKE_AWS_NO_CREDS === '1') noCreds();
  if (process.env.FAKE_AWS_BAD_CREDS === '1') badCreds();
  process.stdout.write(JSON.stringify({
    Regions: [{ RegionName: 'us-east-1' }, { RegionName: 'us-west-2' }, { RegionName: 'eu-west-1' }]
  }));
  process.exit(0);
}

if (args[0] === 'ec2' && args[1] === 'describe-instances') {
  const regionIdx = args.indexOf('--region');
  if (regionIdx === -1) {
    process.stderr.write('\naws: [ERROR]: An error occurred (NoRegion): You must specify a region. You can also configure your region by running "aws configure".\n');
    process.exit(253);
  }
  if (process.env.FAKE_AWS_NO_CREDS === '1') noCreds();
  const region = args[regionIdx + 1];
  const fixtures = {
    'us-east-1': { id: 'i-0fake', name: 'aws-web' },
    'us-west-2': { id: 'i-0west', name: 'aws-west' }
  };
  const f = fixtures[region];
  const instances = f ? [{
    InstanceId: f.id,
    InstanceType: region === 'us-west-2' ? 'm5.large' : 't3.micro',
    State: { Code: 16, Name: 'running' },
    PublicIpAddress: region === 'us-west-2' ? '203.0.113.20' : '203.0.113.8',
    Placement: { AvailabilityZone: region + 'a' },
    Tags: [{ Key: 'Name', Value: f.name }]
  }] : [];
  process.stdout.write(JSON.stringify({
    Reservations: instances.length ? [{ OwnerId: '123456789012', ReservationId: 'r-' + region, Instances: instances }] : []
  }));
  process.exit(0);
}

process.stderr.write('fake-aws: 未模拟 ' + JSON.stringify(args) + '\n');
process.exit(2);
