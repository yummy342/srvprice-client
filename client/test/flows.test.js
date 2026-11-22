'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadFlows, validateFlow, planFlow, runFlow, resolveFlowVars } = require('../lib/flows');

const DIR = path.join(__dirname, '..', 'flows');

function baseFlow(overrides) {
  return Object.assign({
    id: 'demo.vendor',
    version: 1,
    status: 'draft',
    vendor: 'demo',
    title: 'demo',
    entry: 'https://example.com',
    steps: [
      {
        step_id: 's1',
        do: { action: 'click', match: { text: '下一步' } },
        verify: { text: '完成' },
        fail_when: { text: '失败' },
        human: false,
        sensitive: false
      }
    ]
  }, overrides || {});
}

test('流程库全部通过校验（含国外五家）', () => {
  const flows = loadFlows(DIR);
  // 不断言总数：流程库会持续增加；断言关键厂商都在、且每份都合法
  const ids = flows.map((f) => f.flow && f.flow.id);
  for (const id of ['aliyun.create_readonly_user', 'tencent.create_readonly_user',
    'volcengine.create_readonly_user', 'baidu.create_readonly_user',
    'aws.create_readonly_user', 'digitalocean.create_readonly_user',
    'hetzner.create_readonly_user', 'vultr.create_readonly_user',
    'linode.create_readonly_user']) {
    assert.ok(ids.includes(id), `流程库缺 ${id}`);
  }
  for (const f of flows) {
    assert.deepStrictEqual(f.errors, [], `${path.basename(f.file)} 应该没有错误`);
    assert.ok(['draft', 'active'].includes(f.flow.status), `${f.flow.id} status 非法`);
  }
  // 已真机跑通的两家必须是 active（2026-11-20）
  for (const id of ['digitalocean.create_readonly_user', 'vultr.create_readonly_user']) {
    const hit = flows.find((f) => f.flow && f.flow.id === id);
    assert.strictEqual(hit.flow.status, 'active', `${id} 应标 active`);
  }
});

test('缺 verify / fail_when 会被拒', () => {
  const bad = baseFlow({
    steps: [{ step_id: 's', do: { action: 'click' }, human: false, sensitive: false }]
  });
  const errors = validateFlow(bad, JSON.stringify(bad));
  assert.ok(errors.some((e) => /verify/.test(e)));
  assert.ok(errors.some((e) => /fail_when/.test(e)));
});

test('step_id 重复 / 非法 action 会被拒', () => {
  const f = baseFlow({
    steps: [
      { step_id: 'a', do: { action: 'click' }, verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false },
      { step_id: 'a', do: { action: 'rm_rf' }, verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false }
    ]
  });
  const errors = validateFlow(f, JSON.stringify(f));
  assert.ok(errors.some((e) => /重复/.test(e)));
  assert.ok(errors.some((e) => /action/.test(e)));
});

test('步骤文件里出现真实密钥形状会被拒', () => {
  const f = baseFlow();
  // 分片拼接：运行时仍是真实形状，但源码里不出现连续 AK 字面量（避免 secret scanning 误报）
  const raw = JSON.stringify(f) + ' ' + 'LTAI' + '1234567890abcdef';
  assert.ok(validateFlow(f, raw).some((e) => /疑似真实密钥/.test(e)));
});

test('planFlow 标出人机门、敏感步骤、未物化占位符', () => {
  const f = baseFlow({
    steps: [
      { step_id: 'a', do: { action: 'click' }, verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false },
      { step_id: 'b', do: { action: 'run_command', command: 'cfg --key {{credential.a}}' }, verify: { text: 'x' }, fail_when: {}, human: false, sensitive: true },
      { step_id: 'c', do: { action: 'read_fields', fields: ['k'] }, verify: { text: 'x' }, fail_when: {}, human: true, sensitive: true }
    ]
  });
  const p = planFlow(f);
  assert.deepStrictEqual(p.gates, ['b', 'c']);
  assert.deepStrictEqual(p.sensitive, ['b', 'c']);
  assert.deepStrictEqual(p.unresolved_placeholders, ['b']);
});

test('runFlow 遇到人机门就停，并发出 needs_human', async () => {
  const f = baseFlow({
    steps: [
      { step_id: 'a', do: { action: 'click' }, verify: { text: 'x' }, fail_when: {}, human: true, sensitive: false },
      { step_id: 'b', do: { action: 'click' }, verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false }
    ]
  });
  const events = [];
  const res = await runFlow(f, { bridge: null, onEvent: (e) => events.push(e) });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stoppedAt, 'a');
  assert.strictEqual(res.reason, 'human_gate');
  assert.deepStrictEqual(events, [{ type: 'needs_human', step_id: 'a', index: 0 }]);
});

test('变量替换：必填缺参、默认值、替换后无残留', () => {
  const f = baseFlow({
    variables: { name: { description: 'n' }, cidr: '1.2.3.4/32' },
    steps: [
      { step_id: 's1', do: { action: 'fill_form', fields: [{ match: { label: 'x' }, value: '{{name}}' }] },
        verify: { text: '{{cidr}}' }, fail_when: {}, human: false, sensitive: false }
    ]
  });
  const miss = resolveFlowVars(f, {});
  assert.deepStrictEqual(miss.missing, ['name']);
  assert.ok(miss.unresolved.includes('name'));

  const ok = resolveFlowVars(f, { name: 'sg-demo' });
  assert.deepStrictEqual(ok.missing, []);
  assert.deepStrictEqual(ok.unresolved, []);
  assert.strictEqual(ok.flow.steps[0].do.fields[0].value, 'sg-demo');
  assert.strictEqual(ok.flow.steps[0].verify.text, '1.2.3.4/32');
});

test('变量替换只动字符串值，不动对象键名', () => {
  const f = baseFlow({ variables: {}, steps: [
    { step_id: 's1', do: { action: 'click', match: { '{{k}}': 'v' } }, verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false }
  ] });
  const r = resolveFlowVars(f, { k: 'changed' });
  assert.deepStrictEqual(Object.keys(r.flow.steps[0].do.match), ['{{k}}']);
});

test('记录事件转流程草稿：去重、保留语义 match、verify 占位', async () => {
  const { eventsToFlow } = require('../lib/flows');
  const events = [
    { action: 'click', match: { text: '创建安全组' }, page_title: '安全组', url: 'https://x/a' },
    { action: 'click', match: { text: '创建安全组' }, page_title: '安全组', url: 'https://x/a' },
    { action: 'fill_form', match: { text: 'SecurityGroupName' }, value: 'sg-demo', page_title: '创建安全组', url: 'https://x/create' },
    { action: 'nope' }
  ];
  const flow = eventsToFlow(events, { id: 'demo.recorded', vendor: 'demo', title: 'T' });
  assert.strictEqual(flow.status, 'draft');
  assert.strictEqual(flow.steps.length, 2);
  assert.deepStrictEqual(flow.steps[0].do, { action: 'click', match: { text: '创建安全组' } });
  assert.strictEqual(flow.steps[1].do.fields[0].value, 'sg-demo');
  assert.strictEqual(flow.steps[1].verify.text, '创建安全组');
  assert.strictEqual(flow.entry, 'https://x/a');
  assert.deepStrictEqual(validateFlow(flow), []);
});

test('记录值参数化：IP/CIDR、srvprice 组名、端口', () => {
  const { eventsToFlow } = require('../lib/flows');
  const events = [
    { action: 'fill_form', match: { text: 'SecurityGroupName' }, value: 'srvprice-1-2-3-4-3389', page_title: 'A', url: 'u' },
    { action: 'fill_form', match: { text: '访问来源' }, value: '203.0.113.5/32', page_title: 'A', url: 'u' },
    { action: 'fill_form', match: { text: '端口范围' }, value: '3389', page_title: 'A', url: 'u' }
  ];
  const flow = eventsToFlow(events, { id: 'demo.p', vendor: 'demo' });
  assert.deepStrictEqual(Object.keys(flow.variables).sort(), ['group_name', 'port', 'source_cidr']);
  assert.strictEqual(flow.steps[0].do.fields[0].value, '{{group_name}}');
  assert.strictEqual(flow.steps[1].do.fields[0].value, '{{source_cidr}}');
  assert.strictEqual(flow.steps[2].do.fields[0].value, '{{port}}');
  // 未提供成功信号时不应带 meta
  assert.strictEqual(flow.meta, undefined);
});

test('flow save --success 会写成功信号', () => {
  const { eventsToFlow } = require('../lib/flows');
  const flow = eventsToFlow([{ action: 'click', match: { text: 'x' }, page_title: 'P', url: 'u' }],
    { id: 'demo.s', success: true });
  assert.deepStrictEqual(flow.meta.recorded_success, true);
});

test('流程健康度：连续两次失败触发降级，成功清零，版本变更重置', () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-'));
  const prev = process.env.SRVPRICE_CLIENT_HOME;
  process.env.SRVPRICE_CLIENT_HOME = home;
  try {
    const h = require('../lib/flowhealth');
    h.reset('x.y');
    h.failure('x.y', 1, { reason: 'step_failed' });
    assert.strictEqual(h.shouldDowngrade(h.get('x.y')), false);
    h.failure('x.y', 1, { reason: 'step_failed' });
    assert.strictEqual(h.shouldDowngrade(h.get('x.y')), true);
    h.success('x.y', 1);
    assert.strictEqual(h.get('x.y').failures, 0);
    h.failure('x.y', 1, {});
    h.failure('x.y', 2, {});
    assert.strictEqual(h.get('x.y').failures, 1, '版本变更应重置失败计数');
  } finally {
    if (prev === undefined) delete process.env.SRVPRICE_CLIENT_HOME;
    else process.env.SRVPRICE_CLIENT_HOME = prev;
  }
});

const mkSharedFlow = (text) => ({
  id: 'demo.shared', version: 1, status: 'active', vendor: 'demo', title: 'T',
  variables: {}, entry: 'u',
  steps: [{ step_id: 's1', do: { action: 'click', match: { text } },
    verify: { text: 'P', timeout_ms: 8000 }, fail_when: {}, human: false, sensitive: false }],
  meta: { recorded_success: true }
});

test('多账号收敛（本机库）：3 个账号升 shared，同账号覆盖，多数动作胜出', async () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
  const prevHome = process.env.SRVPRICE_CLIENT_HOME;
  const prevUrl = process.env.SRVPRICE_FLOWLIB_URL;
  process.env.SRVPRICE_CLIENT_HOME = home;
  delete process.env.SRVPRICE_FLOWLIB_URL;
  try {
    const lib = require('../lib/flowlib');
    await lib.publish(mkSharedFlow('创建安全组'), 'acct-a');
    await lib.publish(mkSharedFlow('创建安全组'), 'acct-a');
    let s = await lib.summary('demo.shared');
    assert.strictEqual(s.accounts, 1, '同账号覆盖，不重复计');
    await lib.publish(mkSharedFlow('创建安全组'), 'acct-b');
    s = await lib.summary('demo.shared');
    assert.strictEqual(s.status, 'verified');
    await lib.publish(mkSharedFlow('创建'), 'acct-c');
    s = await lib.summary('demo.shared');
    assert.strictEqual(s.status, 'shared');
    const merged = await lib.pull('demo.shared');
    assert.strictEqual(merged.steps[0].do.match.text, '创建安全组');
  } finally {
    if (prevHome === undefined) delete process.env.SRVPRICE_CLIENT_HOME;
    else process.env.SRVPRICE_CLIENT_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.SRVPRICE_FLOWLIB_URL;
    else process.env.SRVPRICE_FLOWLIB_URL = prevUrl;
  }
});

test('多账号收敛（远端）：走 flowlib-server，token 鉴权生效', async () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flr-'));
  const prevUrl = process.env.SRVPRICE_FLOWLIB_URL;
  const prevTok = process.env.SRVPRICE_FLOWLIB_TOKEN;
  const { createServer } = require('../tools/flowlib-server');
  const srv = createServer({ token: 'tok-1', dataFile: path.join(home, 'remote.json') });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  process.env.SRVPRICE_FLOWLIB_URL = `http://127.0.0.1:${port}`;
  process.env.SRVPRICE_FLOWLIB_TOKEN = 'tok-1';
  try {
    const lib = require('../lib/flowlib');
    for (const a of ['a1', 'a2', 'a3']) await lib.publish(mkSharedFlow('创建安全组'), a);
    const s = await lib.summary('demo.shared');
    assert.strictEqual(s.status, 'shared');
    assert.strictEqual(s.accounts, 3);
    const all = await lib.summary();
    assert.strictEqual(all.length, 1);
    process.env.SRVPRICE_FLOWLIB_TOKEN = 'wrong';
    await assert.rejects(() => lib.summary('demo.shared'), /HTTP 401/);
  } finally {
    await new Promise((r) => srv.close(r));
    if (prevUrl === undefined) delete process.env.SRVPRICE_FLOWLIB_URL;
    else process.env.SRVPRICE_FLOWLIB_URL = prevUrl;
    if (prevTok === undefined) delete process.env.SRVPRICE_FLOWLIB_TOKEN;
    else process.env.SRVPRICE_FLOWLIB_TOKEN = prevTok;
  }
});

test('publish 拒绝未参数化的填表值（隐私红线）', async () => {
  const fs = require('fs');
  const os = require('os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-'));
  const prevHome = process.env.SRVPRICE_CLIENT_HOME;
  const prevUrl = process.env.SRVPRICE_FLOWLIB_URL;
  process.env.SRVPRICE_CLIENT_HOME = home;
  delete process.env.SRVPRICE_FLOWLIB_URL;
  try {
    const lib = require('../lib/flowlib');
    const base = (value) => ({
      id: 'demo.lit', version: 1, status: 'draft',
      steps: [{ step_id: 's1', do: { action: 'fill_form', fields: [{ match: { text: '显示名称' }, value }] },
        verify: { text: 'x' }, fail_when: {} }],
      meta: { recorded_success: true }
    });
    await assert.rejects(() => lib.publish(base('张三'), 'acct-a'), /未参数化/);
    const ok = await lib.publish(base('{{display_name}}'), 'acct-a');
    assert.strictEqual(ok.samples, 1);
  } finally {
    if (prevHome === undefined) delete process.env.SRVPRICE_CLIENT_HOME;
    else process.env.SRVPRICE_CLIENT_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.SRVPRICE_FLOWLIB_URL;
    else process.env.SRVPRICE_FLOWLIB_URL = prevUrl;
  }
});

test('run_command 安全校验：shell 元字符/非白名单/破坏性动词', () => {
  const cmd = require('../lib/command');
  assert.deepStrictEqual(cmd.splitArgv('ve configure set --profile "a b"'), ['ve', 'configure', 'set', '--profile', 'a b']);
  assert.throws(() => cmd.check('ve ecs DescribeInstances; rm -rf /'), /shell 元字符/);
  assert.throws(() => cmd.check('powershell -c whoami'), /白名单/);
  assert.throws(() => cmd.check('ve ecs DeleteInstance --InstanceId i-1'), /破坏性/);
  assert.deepStrictEqual(cmd.check('ve ecs DescribeInstances --MaxResults 1'), ['ve', 'ecs', 'DescribeInstances', '--MaxResults', '1']);
  assert.deepStrictEqual(cmd.check('ve ecs DeleteInstance --InstanceId i-1', { allowDestructive: true }),
    ['ve', 'ecs', 'DeleteInstance', '--InstanceId', 'i-1']);
});

test('runFlow 执行 run_command：无执行器则拒绝，有执行器则调用', async () => {
  const f = baseFlow({ steps: [
    { step_id: 'c1', do: { action: 'run_command', command: 've --version' },
      verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false }
  ] });
  const off = await runFlow(f, { bridge: null });
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.reason, 'command_runner_not_implemented');

  let seen = null;
  const on = await runFlow(f, {
    bridge: null,
    runCommand: async (c, o) => { seen = c; return { ok: true }; }
  });
  assert.strictEqual(on.ok, true);
  assert.strictEqual(seen, 've --version');

  const rejected = await runFlow(f, {
    bridge: null,
    runCommand: async () => { throw new Error('白名单拒绝'); }
  });
  assert.strictEqual(rejected.reason, 'command_rejected');
});

test('一句话意图路由：列表/开端口/建只读账号/推广/未知', () => {
  const { route } = require('../lib/intent');
  let r = route('我有哪些机器');
  assert.strictEqual(r.intent, 'list');
  assert.deepStrictEqual(r.args, ['list', '--json']);

  r = route('阿里有哪些服务器');
  assert.deepStrictEqual(r.args, ['list', '--json', '--provider', 'aliyun']);

  r = route('给阿里开 3389 端口给 203.0.113.5');
  assert.strictEqual(r.intent, 'open_port');
  assert.ok(r.args.includes('aliyun.open_port'));
  assert.ok(r.args.includes('group_name=srvprice-203-0-113-5-3389'));
  assert.ok(r.args.includes('source_cidr=203.0.113.5/32'));

  r = route('给火山建一个只读账号');
  assert.strictEqual(r.intent, 'create_readonly_user');
  assert.ok(r.args.includes('volcengine.create_readonly_user'));

  r = route('在火山开一台服务器');
  assert.strictEqual(r.intent, 'create_instance');
  assert.ok(r.args.includes('volcengine.create_instance'));

  r = route('看看联盟推广返佣');
  assert.strictEqual(r.intent, 'promo');

  r = route('你好');
  assert.strictEqual(r.intent, 'unknown');
});

test('破坏性流程：必须 --confirm 且值匹配', async () => {
  const f = baseFlow({
    destructive: true,
    confirm_value: 'i-abc123',
    steps: [{ step_id: 's1', do: { action: 'click', match: { text: '删除' } },
      verify: { text: 'x' }, fail_when: {}, human: false, sensitive: false }]
  });
  const bridge = { connected: () => true, exec: async () => ({ ok: true }) };
  const none = await runFlow(f, { bridge });
  assert.strictEqual(none.reason, 'confirm_required');

  const wrong = await runFlow(f, { bridge, confirmValue: 'i-other' });
  assert.strictEqual(wrong.reason, 'confirm_mismatch');

  const ok = await runFlow(f, { bridge, confirmValue: 'i-abc123' });
  assert.strictEqual(ok.ok, true);
});

test('删除意图：需要实例 ID 并给出 dry-run 命令', () => {
  const { route } = require('../lib/intent');
  let r = route('删掉火山的 i-2zeabc123');
  assert.strictEqual(r.intent, 'destroy_instance');
  assert.ok(r.args.includes('volcengine.destroy_instance'));
  assert.ok(r.args.includes('instance_id=i-2zeabc123'));
  assert.strictEqual(r.human_gate, 'destroy');

  r = route('删掉火山那台服务器');
  assert.strictEqual(r.intent, 'destroy_instance');
  assert.strictEqual(r.args, null);
});

test('没有扩展连接时停在 bridge_not_connected', async () => {
  const f = baseFlow();
  const res = await runFlow(f, { bridge: null });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.stoppedAt, 's1');
  assert.strictEqual(res.reason, 'bridge_not_connected');
});
