'use strict';
// 测试桩：模拟 srvprice CLI 的 host list 输出；并断言客户端强制注入了只读环境变量。
if (process.env.SRVPRICE_READONLY !== '1') {
  process.stderr.write('SRVPRICE_READONLY not set\n');
  process.exit(3);
}
process.stdout.write(JSON.stringify({
  count: 1,
  items: [{ id: 'fake:i-1', provider: 'fake', instance_id: 'i-1', status: 'running', public_ipv4: '203.0.113.1' }],
  errors: [],
  note: ''
}));
