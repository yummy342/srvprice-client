'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'srvprice.js');
const FAKE_ALIYUN = path.join(__dirname, 'fixtures', 'fake-aliyun.js');

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], {
      env: Object.assign({}, process.env, env || {}),
      timeout: 60000,
      windowsHide: true
    }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout, stderr });
    });
  });
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'srvprice-test-'));
}

let HOME;
test.beforeEach(() => { HOME = tmpHome(); });

// ---------------------------------------------------------------------------
// 基础契约
// ---------------------------------------------------------------------------

test('--version 输出语义化版本', async () => {
  const r = await run(['--version']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('未知命令退出码 2', async () => {
  const r = await run(['bogus'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /未知命令/);
});

test('plan get 不存在的 ID 退出码 4', async () => {
  const r = await run(['plan', 'get', '--id', 'nope'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 4);
});

test('plan list 管道输出是纯 JSON，警告走 stderr', async () => {
  const r = await run(['plan', 'list', '--page-size', '3'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);       // stdout 必须可整体解析
  assert.ok(Array.isArray(payload.items));
  assert.strictEqual(payload.items.length, 3);
  assert.ok(payload.total >= payload.items.length);
  for (const item of payload.items) {
    assert.ok(item.verified_at, '每条价格必须有 verified_at');
    assert.ok(item.source_url, '每条价格必须有 source_url');
  }
  // 数据过期警告是 JSONL 写到 stderr，不污染 stdout
  const warn = r.stderr.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(warn.some((w) => w.level === 'warn'), '过期数据应在 stderr 给出警告');
});

test('--output text 输出表格', async () => {
  const r = await run(['plan', 'list', '--output', 'text', '--page-size', '2'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /ID\s+厂商/);
  assert.match(r.stdout, /共 \d+ 条/);
});

test('plan list 按预算过滤', async () => {
  const r = await run(['plan', 'list', '--budget-max', '100'], { SRVPRICE_HOME: HOME });
  const payload = JSON.parse(r.stdout);
  assert.ok(payload.items.length > 0);
  for (const p of payload.items) assert.ok(p.price.first_year_cny <= 100);
});

test('plan compare 需要至少两个 --id', async () => {
  const r = await run(['plan', 'compare', '--id', 'aliyun-ecs-e-2c2g-cn'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
});

test('plan compare 正常返回两个', async () => {
  const r = await run(['plan', 'compare',
    '--id', 'aliyun-ecs-e-2c2g-cn', '--id', 'tencent-light-rc-2c2g-cn'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.items.length, 2);
});

test('recommend 返回推荐与理由', async () => {
  const r = await run(['recommend', '--use-case', 'blog', '--explain'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.ok(payload.items.length >= 1);
  assert.ok(payload.items[0].reasons.length >= 1);
});

test('recommend wizard 在非 TTY 下拒绝并给替代方案', async () => {
  const r = await run(['recommend', 'wizard'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /--use-case/);
});

test('deal list 默认不列过期活动', async () => {
  const r = await run(['deal', 'list'], { SRVPRICE_HOME: HOME });
  const payload = JSON.parse(r.stdout);
  const today = new Date().toISOString().slice(0, 10);
  for (const d of payload.items) {
    assert.ok(!d.ends_at || d.ends_at >= today, `${d.id} 不应是过期活动`);
  }
});

test('buy url 在 text 模式下 stdout 只有 URL', async () => {
  const r = await run(['buy', 'url', '--plan-id', 'ucloud-kj-o-2c4g-hk-new', '--output', 'text'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const line = r.stdout.trim();
  assert.match(line, /^https:\/\//);
  assert.match(line, /ucloud/);
});

test('buy url 附带价格快照与免责提示', async () => {
  const r = await run(['buy', 'url', '--plan-id', 'aliyun-ecs-e-2c2g-cn'], { SRVPRICE_HOME: HOME });
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.price_snapshot_cny, 99);
  assert.ok(payload.verified_at);
  assert.match(payload.warning, /以厂商官网实时价为准/);
});

test('setup show 未知主题退出码 4', async () => {
  const r = await run(['setup', 'show', 'nope'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 4);
});

test('setup show 输出步骤且标明不远程执行', async () => {
  const r = await run(['setup', 'show', 'ssh-key', '--output', 'text'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /ssh-keygen/);
});

test('--introspect 输出机器可读契约', async () => {
  const r = await run(['--introspect'], { SRVPRICE_HOME: HOME });
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.name, 'srvprice');
  assert.strictEqual(payload.exit_codes.UNCONFIRMED, 7);
  assert.ok(payload.commands.host.subcommands.includes('stop'));
  assert.match(payload.agent_contract.write_ops, /--yes/);
});

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

test('config set/get 写入独立 SRVPRICE_HOME', async () => {
  const a = await run(['config', 'set', '--key', 'default_region', '--value', 'hk'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(a.code, 0);
  const b = await run(['config', 'show'], { SRVPRICE_HOME: HOME });
  const payload = JSON.parse(b.stdout);
  assert.strictEqual(payload.values.default_region, 'hk');
  const saved = path.join(HOME, 'config.json');
  assert.ok(fs.existsSync(saved));
});

test('config set 拒绝把密钥写进选购偏好', async () => {
  const r = await run(['config', 'set', '--key', 'api_key', '--value', 'x'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /vendor add/);
});

test('config use 不存在的 profile 退出码 4', async () => {
  const r = await run(['config', 'use', '--name', 'nope'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 4);
});

// ---------------------------------------------------------------------------
// 主机线：护栏与适配器
// ---------------------------------------------------------------------------

function fakeEnv(extra) {
  const state = path.join(HOME, 'aliyun-state.json');
  fs.writeFileSync(state, JSON.stringify({ status: 'Running' }));
  return Object.assign({
    SRVPRICE_HOME: HOME,
    SRVPRICE_BIN_ALIYUN: FAKE_ALIYUN,
    FAKE_STATE: state
  }, extra || {});
}

test('host list 用适配器解析厂商 JSON 并归一化', async () => {
  const r = await run(['host', 'list', '--provider', 'aliyun'], fakeEnv());
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.items.length, 1);
  const h = payload.items[0];
  assert.strictEqual(h.id, 'aliyun:i-fake001');
  assert.strictEqual(h.status, 'running');
  assert.strictEqual(h.public_ipv4, '203.0.113.7');
});

test('host status 查单台', async () => {
  const r = await run(['host', 'status', '--id', 'aliyun:i-fake001'], fakeEnv());
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).host.name, 'web-01');
});

test('--dry-run 只打印厂商命令，不改状态', async () => {
  const env = fakeEnv();
  const r = await run(['host', 'stop', '--id', 'aliyun:i-fake001', '--dry-run'], env);
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.dry_run, true);
  assert.match(payload.vendor_command, /StopInstance/);
  const state = JSON.parse(fs.readFileSync(env.FAKE_STATE, 'utf8'));
  assert.strictEqual(state.status, 'Running', '--dry-run 不应真的执行');
});

test('非交互环境写操作未确认 → 退出码 7', async () => {
  const env = fakeEnv();
  const r = await run(['host', 'stop', '--id', 'aliyun:i-fake001'], env);
  assert.strictEqual(r.code, 7);
  assert.match(r.stderr, /--yes/);
  const state = JSON.parse(fs.readFileSync(env.FAKE_STATE, 'utf8'));
  assert.strictEqual(state.status, 'Running', '未确认时不应执行');
});

test('--yes 执行写操作并回读状态', async () => {
  const env = fakeEnv();
  const r = await run(['host', 'stop', '--id', 'aliyun:i-fake001', '--yes'], env);
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.action, 'stop');
  assert.strictEqual(payload.status_after, 'stopped', '执行后应回读真实状态，而不是只报已受理');
  const state = JSON.parse(fs.readFileSync(env.FAKE_STATE, 'utf8'));
  assert.strictEqual(state.status, 'Stopped');
});

test('主机 ID 格式错误退出码 2', async () => {
  const r = await run(['host', 'status', '--id', 'i-fake001'], fakeEnv());
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /provider/);
});

test('单厂商失败不拖垮整表，且明确报出是哪家', async () => {
  // 显式指向不存在的可执行文件，避免本机真装了 aws 时这条「未装」用例失真
  const r = await run(['host', 'list', '--provider', 'aliyun', '--provider', 'aws'],
    fakeEnv({ SRVPRICE_BIN_AWS: path.join(HOME, 'missing-aws') }));
  assert.strictEqual(r.code, 0, '有一家成功就该返回 0');
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.items.length, 1);
  assert.ok(payload.errors.some((e) => e.provider === 'aws' && e.reason === 'cli_missing'));
});

test('vendor list 报告 CLI 未装', async () => {
  const r = await run(['vendor', 'list', '--output', 'text'], { SRVPRICE_HOME: HOME, SRVPRICE_BIN_ALIYUN: path.join(HOME, 'missing-bin') });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /未装/);
});

test('vendor add 拒绝命令行传密钥', async () => {
  const r = await run(['vendor', 'add', '--name', 'aliyun', '--key', 'secret-value'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /shell 历史/);
});

test('vendor add 从环境变量录入并只显示 masked', async () => {
  // 假密钥分片拼接：避免像真 AK 一样被 GitHub secret scanning 报警
  const FAKE_AK = 'LTAI' + '0000TEST0000';
  const FAKE_SK = 'secret-' + 'test-0000';
  const r = await run(['vendor', 'add', '--name', 'aliyun'], Object.assign({ SRVPRICE_HOME: HOME }, {
    SRVPRICE_ALIYUN_KEY: FAKE_AK,
    SRVPRICE_ALIYUN_SECRET: FAKE_SK
  }));
  assert.strictEqual(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.ok(!payload.masked.includes('0000TEST0000'), '输出只能是 masked');
  assert.match(payload.masked, /^LTAI…/);
  const creds = JSON.parse(fs.readFileSync(path.join(HOME, 'credentials.json'), 'utf8'));
  assert.strictEqual(creds.vendors.aliyun.key, FAKE_AK);
});

test('非交互 vendor remove 未确认 → 退出码 7', async () => {
  await run(['vendor', 'add', '--name', 'hcloud'], { SRVPRICE_HOME: HOME, SRVPRICE_HCLOUD_TOKEN: 'tok123456789' });
  const r = await run(['vendor', 'remove', '--name', 'hcloud'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 7);
});

// ---- 国内厂商适配器 ----
const FAKE_UCLOUD = path.join(__dirname, 'fixtures', 'fake-ucloud.js');
const FAKE_JDC = path.join(__dirname, 'fixtures', 'fake-jdc.js');
const FAKE_CTYUN = path.join(__dirname, 'fixtures', 'fake-ctyun.js');

test('UCloud 适配器解析 uhost list 并归一化', async () => {
  const r = await run(['host', 'list', '--provider', 'ucloud'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_UCLOUD: FAKE_UCLOUD });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items[0].id, 'ucloud:uhost-abc123');
  assert.strictEqual(p.items[0].name, 'web-uc');
  assert.strictEqual(p.items[0].region, 'sg-02');
  assert.strictEqual(p.items[0].status, 'running');
  assert.strictEqual(p.items[0].public_ipv4, '203.0.113.13');
  assert.strictEqual(p.items[0].type, 'O/N4');
});

test('UCloud stop 的厂商命令是 ucloud uhost stop --uhost-id', async () => {
  const r = await run(['host', 'stop', '--id', 'ucloud:uhost-abc123', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_UCLOUD: FAKE_UCLOUD });
  assert.strictEqual(r.code, 0);
  assert.match(JSON.parse(r.stdout).vendor_command, /uhost stop --uhost-id uhost-abc123/);
});

test('京东云适配器解析 describe-instances', async () => {
  const r = await run(['host', 'list', '--provider', 'jdcloud'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_JDCLOUD: FAKE_JDC });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items[0].id, 'jdcloud:i-jd001');
  assert.strictEqual(p.items[0].status, 'running');
});

test('天翼云不给 region 时自动遍历资源池', async () => {
  const r = await run(['host', 'list', '--provider', 'ctyun'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_CTYUN: FAKE_CTYUN });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items.length, 1);
  assert.strictEqual(p.items[0].region, 'cn-test-1');
});

test('天翼云按官方命令列出并归一化', async () => {
  const r = await run(['host', 'list', '--provider', 'ctyun', '--region', 'reg-a'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_CTYUN: FAKE_CTYUN });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items[0].id, 'ctyun:i-ct001');
  assert.strictEqual(p.items[0].name, 'web-ct');
  assert.strictEqual(p.items[0].status, 'running');
});

test('天翼云 stop 命令是 StopEcsInstance --instanceID + --regionID', async () => {
  const r = await run(['host', 'stop', '--id', 'ctyun:i-ct001', '--region', 'reg-a', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_CTYUN: FAKE_CTYUN });
  assert.strictEqual(r.code, 0);
  const cmd = JSON.parse(r.stdout).vendor_command;
  assert.match(cmd, /StopEcsInstance --instanceID i-ct001/);
  assert.match(cmd, /--regionID reg-a/);
});

test('vendor list 标出命令未全部核实的厂商', async () => {
  const r = await run(['vendor', 'list', '--output', 'text'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_CTYUN: FAKE_CTYUN });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /天翼云/);
});

test('UCloud 未配置凭据时识别为 auth_failed（真机退出码是 0）', async () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-ucloud-nocreds.js');
  const r = await run(['host', 'list', '--provider', 'ucloud'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_UCLOUD: fake });
  assert.strictEqual(r.code, 5);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.errors[0].reason, 'auth_failed');
  assert.match(p.errors[0].message, /ucloud init/);
});

test('京东云 reboot 用的是单数 reboot-instance（官方骨架核对）', async () => {
  const r = await run(['host', 'reboot', '--id', 'jdcloud:i-jd001', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_JDCLOUD: FAKE_JDC });
  assert.strictEqual(r.code, 0);
  assert.match(JSON.parse(r.stdout).vendor_command, /vm reboot-instance --instance-id i-jd001/);
});

test('只读模式：写操作即使 --yes 也拒绝，list 仍可用', async () => {
  const env = fakeEnv();
  const set = await run(['config', 'set', '--key', 'read_only', '--value', 'true'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(set.code, 0);
  const w = await run(['host', 'stop', '--id', 'aliyun:i-fake001', '--yes'], env);
  assert.strictEqual(w.code, 2);
  assert.match(w.stderr, /read_only/);
  const l = await run(['host', 'list', '--provider', 'aliyun'], env);
  assert.strictEqual(l.code, 0);
  assert.strictEqual(JSON.parse(l.stdout).items.length, 1);
});

test('SRVPRICE_READONLY=1 同样拦写操作', async () => {
  const env = fakeEnv({ SRVPRICE_READONLY: '1' });
  const w = await run(['host', 'stop', '--id', 'aliyun:i-fake001', '--yes'], env);
  assert.strictEqual(w.code, 2);
  assert.match(w.stderr, /read_only/);
});

test('UCloud IAM 权限不足识别为 permission_denied（不是厂商故障）', async () => {
  const fake = path.join(__dirname, 'fixtures', 'fake-ucloud-perm.js');
  const r = await run(['host', 'list', '--provider', 'ucloud'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_UCLOUD: fake });
  assert.strictEqual(r.code, 5);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.errors[0].reason, 'permission_denied');
  assert.match(p.errors[0].message, /只读策略/);
});

// ---- 第二批厂商：火山引擎 / 百度智能云（2026-11-19 真机 --help 核对）----
const FAKE_VE = path.join(__dirname, 'fixtures', 'fake-ve.js');
const FAKE_BCE = path.join(__dirname, 'fixtures', 'fake-bce.js');
const FAKE_TCCLI = path.join(__dirname, 'fixtures', 'fake-tccli.js');

test('火山引擎适配器解析 Result.Instances 并归一化', async () => {
  const r = await run(['host', 'list', '--provider', 'volcengine'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_VOLCENGINE: FAKE_VE });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items.length, 1, '不给 region 时应遍历 DescribeRegions 的全部地域，且不重复');
  const h = p.items[0];
  assert.strictEqual(h.id, 'volcengine:i-ve001');
  assert.strictEqual(h.name, 'web-ve');
  assert.strictEqual(h.region, 'cn-beijing', '实例落在它自己的地域');
  assert.strictEqual(h.status, 'running', '大写 RUNNING 应归一化为 running');
  assert.strictEqual(h.public_ipv4, '198.51.100.9');
  assert.strictEqual(h.type, 'ecs.g1.large');
});

test('火山引擎给了 --region 时只查该地域', async () => {
  const r = await run(['host', 'list', '--provider', 'volcengine', '--region', 'cn-shanghai'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_VOLCENGINE: FAKE_VE });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).items.length, 0, 'cn-shanghai 没有实例，不应把别的地域的算进来');
});

test('火山引擎 stop 命令是 ve ecs StopInstance --InstanceId + --region', async () => {
  const r = await run(['host', 'stop', '--id', 'volcengine:i-ve001', '--region', 'cn-beijing', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_VOLCENGINE: FAKE_VE });
  assert.strictEqual(r.code, 0);
  const cmd = JSON.parse(r.stdout).vendor_command;
  assert.match(cmd, /ecs StopInstance --InstanceId i-ve001/);
  assert.match(cmd, /--region cn-beijing/);
});

test('火山引擎未配置凭据识别为 auth_failed（真机退出码 1）', async () => {
  const r = await run(['host', 'list', '--provider', 'volcengine'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_VOLCENGINE: FAKE_VE, FAKE_VE_AUTH_FAIL: '1' });
  assert.strictEqual(r.code, 5);
  assert.strictEqual(JSON.parse(r.stdout).errors[0].reason, 'auth_failed');
});

// ---- 腾讯云：2026-11-20 补多地域遍历（真机 19 个地域）----
test('腾讯云不给 region 时遍历 DescribeRegions 的地域', async () => {
  const r = await run(['host', 'list', '--provider', 'tencent'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_TENCENT: FAKE_TCCLI });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items.length, 1, '假桩只有 ap-beijing 有实例，其余地域应为空且不算失败');
  const h = p.items[0];
  assert.strictEqual(h.id, 'tencent:i-tc001');
  assert.strictEqual(h.name, 'web-tc');
  assert.strictEqual(h.region, 'ap-beijing-3', '地域取 Placement.Zone');
  assert.strictEqual(h.status, 'running');
  assert.strictEqual(h.public_ipv4, '203.0.113.31');
  assert.strictEqual(h.type, 'S5.MEDIUM4');
});

test('腾讯云给了 --region 时只查该地域', async () => {
  const r = await run(['host', 'list', '--provider', 'tencent', '--region', 'ap-guangzhou'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_TENCENT: FAKE_TCCLI });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).items.length, 0, 'ap-guangzhou 没有实例');
});

test('腾讯云 stop 命令是 tccli cvm StopInstances --InstanceIds + --region', async () => {
  const r = await run(['host', 'stop', '--id', 'tencent:i-tc001', '--region', 'ap-beijing', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_TENCENT: FAKE_TCCLI });
  assert.strictEqual(r.code, 0);
  const cmd = JSON.parse(r.stdout).vendor_command;
  assert.match(cmd, /cvm StopInstances --InstanceIds \["i-tc001"\]/);
  assert.match(cmd, /--region ap-beijing/);
});

test('腾讯云无凭据识别为 auth_failed（真机 secretId is invalid）', async () => {
  const r = await run(['host', 'list', '--provider', 'tencent'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_TENCENT: FAKE_TCCLI, FAKE_TCCLI_AUTH_FAIL: '1' });
  assert.strictEqual(r.code, 5);
  assert.strictEqual(JSON.parse(r.stdout).errors[0].reason, 'auth_failed');
});

test('百度智能云不给 region 时遍历 bj/gz/su/bd/hkg', async () => {
  const r = await run(['host', 'list', '--provider', 'baidu'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_BAIDU: FAKE_BCE });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items.length, 1, '假桩只有 bj 有实例，其余地域应为空且不算失败');
  assert.strictEqual(p.items[0].id, 'baidu:i-bce001');
  assert.strictEqual(p.items[0].name, 'web-bce');
  assert.strictEqual(p.items[0].public_ipv4, '203.0.113.21');
  assert.strictEqual(p.items[0].status, 'running');
});

test('百度智能云 reboot 命令是 bce bcc RebootInstance --instanceId', async () => {
  const r = await run(['host', 'reboot', '--id', 'baidu:i-bce001', '--region', 'bj', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_BAIDU: FAKE_BCE });
  assert.strictEqual(r.code, 0);
  const cmd = JSON.parse(r.stdout).vendor_command;
  assert.match(cmd, /bcc RebootInstance --instanceId i-bce001/);
  assert.match(cmd, /--region bj/);
});

test('百度智能云未配置凭据识别为 auth_failed（真机退出码 1）', async () => {
  const r = await run(['host', 'list', '--provider', 'baidu'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_BAIDU: FAKE_BCE, FAKE_BCE_AUTH_FAIL: '1' });
  assert.strictEqual(r.code, 5);
  assert.strictEqual(JSON.parse(r.stdout).errors[0].reason, 'auth_failed');
});

test('vendor status 探到火山/百度 CLI 未建配置档案', async () => {
  const r = await run(['vendor', 'status', '--name', 'volcengine'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_VOLCENGINE: FAKE_VE, FAKE_VE_NO_CREDS: '1' });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(r.stdout).items[0].cli_configured, false);
});

// ---- 西部数码（2026-11-20，直接 HTTP API / 只读 list）----
const west = require('../lib/west');

test('西部数码 token = md5(username+password+time)，32 位小写', () => {
  assert.strictEqual(west.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.strictEqual(west.tokenFor('u', 'p', '123'), west.md5('up123'));
  assert.match(west.tokenFor('example-account', 'x', '1700000000000'), /^[0-9a-f]{32}$/);
});

test('西部数码列表映射：我司编号/ip/免费域名，状态不猜', () => {
  const rows = west.mapItems([{
    id: 211, ip: '203.0.113.10', freedomain: 'demo.west.cn', roomname: '绵阳电信'
  }], null);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 'west:211');
  assert.strictEqual(rows[0].instance_id, '211');
  assert.strictEqual(rows[0].public_ipv4, '203.0.113.10');
  assert.strictEqual(rows[0].name, 'demo.west.cn');
  assert.strictEqual(rows[0].region, '绵阳电信');
  assert.strictEqual(rows[0].status, null, '列表接口没有运行状态，不能猜');
});

test('西部数码缺凭据时明确报错', async () => {
  const oldU = process.env.SRVPRICE_WEST_USER;
  const oldP = process.env.SRVPRICE_WEST_API_PASSWORD;
  delete process.env.SRVPRICE_WEST_USER;
  delete process.env.SRVPRICE_WEST_API_PASSWORD;
  await assert.rejects(() => west.listServers({}), /缺西部数码凭据/);
  if (oldU !== undefined) process.env.SRVPRICE_WEST_USER = oldU;
  if (oldP !== undefined) process.env.SRVPRICE_WEST_API_PASSWORD = oldP;
});

test('西部数码真机字段：allocateip 是公网 IP，serverroom 用机房表解析', () => {
  const rows = west.mapItems([{
    id: 786164, os: 'windows2016_x64_clean', allocateip: '203.0.113.10', serverroom: 38
  }], null, { 38: '绵阳电信' });
  assert.strictEqual(rows[0].id, 'west:786164');
  assert.strictEqual(rows[0].public_ipv4, '203.0.113.10');
  assert.strictEqual(rows[0].region, '绵阳电信');
  assert.strictEqual(rows[0].type, 'windows2016_x64_clean');
  assert.strictEqual(rows[0].status, null);
});

test('西部数码运行状态码映射（0 正常/1 关机/2 管理员关机/3 暂停）', () => {
  assert.strictEqual(west.mapStatus({ status: 0 }).status, 'running');
  assert.strictEqual(west.mapStatus({ status: 1 }).status, 'stopped');
  assert.strictEqual(west.mapStatus({ status: 2 }).status_info, '管理员关机');
  assert.strictEqual(west.mapStatus({ status: 3 }).status_info, '暂停');
  assert.strictEqual(west.mapStatus({}).status, null, '未知状态不猜');
});

test('西部数码快照映射（类型/周期/到期/磁盘）', () => {
  const s = west.mapSnapshots({
    snapadv: 0, snapperiod: 7, leftmonth: 5, expiredate: '2027-01-01',
    snapadvtime: '2026-11-01', os: ['win2016'], data: ['D:'], size: 100, nopaysize: 20,
    snappolicy: 0, snaprules: { keepday: '3' }
  });
  assert.strictEqual(s.type, '普通');
  assert.strictEqual(s.type_code, 0);
  assert.strictEqual(s.period, 7);
  assert.strictEqual(s.left_month, 5);
  assert.strictEqual(s.expires_at, '2027-01-01');
  assert.deepStrictEqual(s.data_disk, ['D:']);
  assert.strictEqual(s.keep_days, '3');
});

test('多地域进度 JSONL 写到 stderr（SRVPRICE_PROGRESS=1）', async () => {
  const r = await run(['host', 'list', '--provider', 'tencent'], {
    SRVPRICE_HOME: HOME, SRVPRICE_BIN_TENCENT: FAKE_TCCLI, SRVPRICE_PROGRESS: '1'
  });
  const prog = r.stderr.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((x) => x && x.level === 'progress');
  assert.ok(prog.length >= 2, '应至少两条地域进度');
  assert.strictEqual(prog[prog.length - 1].total, 2);
  assert.ok(prog.some((p) => p.region === 'ap-beijing'));
  JSON.parse(r.stdout); // stdout 仍必须是纯 JSON
});

// ---- 国外五家：AWS / DigitalOcean / Hetzner / Vultr / Linode
//      （2026-11-20 按 brief 真机核对：装包、版本、命令树、无凭据报错）----
const FAKE_AWS = path.join(__dirname, 'fixtures', 'fake-aws.js');
const FAKE_DOCTL = path.join(__dirname, 'fixtures', 'fake-doctl.js');
const FAKE_HCLOUD = path.join(__dirname, 'fixtures', 'fake-hcloud.js');
const FAKE_VULTR = path.join(__dirname, 'fixtures', 'fake-vultr.js');
const FAKE_LINODE = path.join(__dirname, 'fixtures', 'fake-linode.js');

test('Hetzner 从 location 取地域（datacenter 属性已移除）', async () => {
  const r = await run(['host', 'list', '--provider', 'hcloud'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_HCLOUD: FAKE_HCLOUD });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items[0].id, 'hcloud:42');
  assert.strictEqual(p.items[0].name, 'web-hz');
  assert.strictEqual(p.items[0].region, 'fsn1', '地域必须来自 location，不是已消失的 datacenter');
  assert.strictEqual(p.items[0].public_ipv4, '203.0.113.42');
});

test('Vultr stop/reboot 用真机子命令 stop / restart（没有 halt / reboot）', async () => {
  const env = { SRVPRICE_HOME: HOME, SRVPRICE_BIN_VULTR: FAKE_VULTR };
  const id = 'vultr:cb1f9c3e-0000-0000-0000-000000000001';
  const s = await run(['host', 'stop', '--id', id, '--dry-run'], env);
  assert.strictEqual(s.code, 0);
  assert.match(JSON.parse(s.stdout).vendor_command,
    /instance stop cb1f9c3e-0000-0000-0000-000000000001/);
  const b = await run(['host', 'reboot', '--id', id, '--dry-run'], env);
  assert.strictEqual(b.code, 0);
  assert.match(JSON.parse(b.stdout).vendor_command, /instance restart /);
});

test('DigitalOcean 未登录（错误 JSON 打在 stdout）识别为 auth_failed', async () => {
  const r = await run(['host', 'list', '--provider', 'doctl'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_DOCTL: FAKE_DOCTL });
  assert.strictEqual(r.code, 5);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.errors[0].reason, 'auth_failed');
});

test('Linode 适配器用 --json --all-rows 并解析对象数组', async () => {
  const r = await run(['host', 'list', '--provider', 'linode'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_LINODE: FAKE_LINODE });
  assert.strictEqual(r.code, 0);
  const h = JSON.parse(r.stdout).items[0];
  assert.strictEqual(h.id, 'linode:123');
  assert.strictEqual(h.region, 'us-east');
  assert.strictEqual(h.public_ipv4, '203.0.113.5');
});

test('Linode 未 configure 的交互向导崩栈识别为 auth_failed', async () => {
  const r = await run(['host', 'list', '--provider', 'linode'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_LINODE: FAKE_LINODE, FAKE_LINODE_NOCFG: '1' });
  assert.strictEqual(r.code, 5);
  assert.strictEqual(JSON.parse(r.stdout).errors[0].reason, 'auth_failed');
});

test('AWS 未登录时干净报 auth_failed（不按地域刷一堆错误）', async () => {
  const r = await run(['host', 'list', '--provider', 'aws'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_AWS: FAKE_AWS, FAKE_AWS_NO_CREDS: '1' });
  assert.strictEqual(r.code, 5);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.errors.length, 1, 'describe-regions 失败应直接报错，而不是每地域一条');
  assert.strictEqual(p.errors[0].reason, 'auth_failed');
});

test('AWS 密钥无效（真实 API 的 AuthFailure）也归为 auth_failed', async () => {
  const r = await run(['host', 'list', '--provider', 'aws'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_AWS: FAKE_AWS, FAKE_AWS_BAD_CREDS: '1' });
  assert.strictEqual(r.code, 5);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.errors.length, 1);
  assert.strictEqual(p.errors[0].reason, 'auth_failed');
});

test('AWS 给了 --region 时只查该地域并解析 Reservations', async () => {
  const r = await run(['host', 'list', '--provider', 'aws', '--region', 'us-east-1'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_AWS: FAKE_AWS });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.items.length, 1, '指定地域时不应遍历');
  const h = p.items[0];
  assert.strictEqual(h.id, 'aws:i-0fake');
  assert.strictEqual(h.name, 'aws-web');
  assert.strictEqual(h.region, 'us-east-1a');
  assert.strictEqual(h.status, 'running');
});

test('AWS 不给 --region 时遍历 describe-regions 的全部地域（有实例的不漏、空的返回空）', async () => {
  const r = await run(['host', 'list', '--provider', 'aws'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_AWS: FAKE_AWS });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  const ids = p.items.map((h) => h.id).sort();
  assert.deepStrictEqual(ids, ['aws:i-0fake', 'aws:i-0west'], '两个地域的实例都要出现（eu-west-1 为空）');
  const west = p.items.find((h) => h.id === 'aws:i-0west');
  assert.strictEqual(west.region, 'us-west-2a');
  assert.strictEqual(west.public_ipv4, '203.0.113.20');
  assert.deepStrictEqual(p.errors, [], '空地域不是错误');
});

test('AWS 遍历地域时写进度 JSONL（SRVPRICE_PROGRESS=1）', async () => {
  const r = await run(['host', 'list', '--provider', 'aws'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_AWS: FAKE_AWS, SRVPRICE_PROGRESS: '1' });
  const prog = r.stderr.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter((x) => x && x.level === 'progress' && x.provider === 'aws');
  assert.strictEqual(prog.length, 3, '三个地域各一条进度');
  assert.strictEqual(prog[prog.length - 1].total, 3);
  assert.ok(prog.some((x) => x.region === 'us-west-2'));
  JSON.parse(r.stdout); // stdout 仍必须是纯 JSON
});

test('vendor list 用 version 子命令探测 doctl/hcloud（它们不认 --version）', async () => {
  const r = await run(['vendor', 'list', '--output', 'text'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_DOCTL: FAKE_DOCTL, SRVPRICE_BIN_HCLOUD: FAKE_HCLOUD });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /2\.7\.0/, 'doctl 版本应通过 `doctl version` 探到');
  assert.match(r.stdout, /1\.70\.2/, 'hcloud 版本应通过 `hcloud version` 探到');
});

test('AWS 跨地域实例 stop 未给 --region 时自动带实例所在地域（AZ 反推）', async () => {
  const r = await run(['host', 'stop', '--id', 'aws:i-0west', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_AWS: FAKE_AWS });
  assert.strictEqual(r.code, 0);
  assert.match(JSON.parse(r.stdout).vendor_command, /ec2 stop-instances --instance-ids i-0west --region us-west-2$/);
});

test('腾讯云跨地域实例 stop 未给 --region 时自动带可用区所属地域', async () => {
  const r = await run(['host', 'stop', '--id', 'tencent:i-tc001', '--dry-run'],
    { SRVPRICE_HOME: HOME, SRVPRICE_BIN_TENCENT: FAKE_TCCLI });
  assert.strictEqual(r.code, 0);
  assert.match(JSON.parse(r.stdout).vendor_command, /StopInstances .*--region ap-beijing$/);
});

// ---- 第二期「走优惠」：provider 级推广链接（2026-11-20 派单）----
test('buy url --provider vultr 输出 providers.json 里的推广链接', async () => {
  const r = await run(['buy', 'url', '--provider', 'vultr', '--output', 'text'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), 'https://www.vultr.com/?ref=9932021');
});

test('buy url --provider digitalocean 带已核实优惠口径与归因说明', async () => {
  const r = await run(['buy', 'url', '--provider', 'digitalocean'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.url, 'https://m.do.co/c/dc9d152a1289');
  assert.match(p.promo_note, /\$25/, '要摆出已核实的推荐口径');
  assert.match(p.promo_verified_at, /^2026-/);
  assert.match(p.attribution, /API 下单带不上归因/);
  assert.match(p.warning, /不代下单/);
});

test('buy url --provider 未知厂商退出码 4', async () => {
  const r = await run(['buy', 'url', '--provider', 'nope'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 4);
});

test('buy url --plan-id 也带 promo_note（套餐入口同样摆优惠口径）', async () => {
  const r = await run(['buy', 'url', '--plan-id', 'ucloud-kj-o-2c4g-hk-new'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.ok(p.promo_note, '套餐购买摘要应带厂商渠道口径');
  assert.match(p.attribution, /推荐归因/);
});

// ---- host open-port（2026-11-21，西部数码安全组）----
test('host open-port 必须给 --source，否则参数错误', async () => {
  const r = await run(['host', 'open-port', '--ip', '203.0.113.10', '--port', '3389'],
    { SRVPRICE_HOME: HOME, WEST_USERNAME: '', WEST_API_PASSWORD: '' });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /--source/);
});

test('host open-port 端口非法退出码 2', async () => {
  const r = await run(['host', 'open-port', '--ip', '203.0.113.10', '--port', '99999', '--source', '1.2.3.4'],
    { SRVPRICE_HOME: HOME, WEST_USERNAME: '', WEST_API_PASSWORD: '' });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /65535/);
});

test('host open-port 放开所有来源必须 --yes', async () => {
  const r = await run(['host', 'open-port', '--ip', '203.0.113.10', '--port', '3389', '--source', '0.0.0.0'],
    { SRVPRICE_HOME: HOME, WEST_USERNAME: '', WEST_API_PASSWORD: '' });
  assert.strictEqual(r.code, 7);
  assert.match(r.stderr, /放开所有来源/);
});

test('host open-port 缺凭据退出码 5 且不发网络请求', async () => {
  const r = await run(['host', 'open-port', '--ip', '203.0.113.10', '--port', '3389', '--source', '1.2.3.4'],
    { SRVPRICE_HOME: HOME, WEST_USERNAME: '', WEST_API_PASSWORD: '' });
  assert.strictEqual(r.code, 5);
  assert.match(r.stderr, /西部数码凭据/);
});

test('host open-port 未实现的厂商退出码 2', async () => {
  const r = await run(['host', 'open-port', '--provider', 'aws', '--ip', '1.2.3.4', '--port', '22', '--source', '1.2.3.4'],
    { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /--provider 支持/);
});

test('host open-port 百度/京东/天翼/UCloud 也需要 --region', async () => {
  for (const p of ['baidu', 'jdcloud', 'ctyun', 'ucloud']) {
    const r = await run(['host', 'open-port', '--provider', p, '--ip', '1.2.3.4', '--port', '22', '--source', '1.2.3.4'],
      { SRVPRICE_HOME: HOME });
    assert.strictEqual(r.code, 2, p);
    assert.match(r.stderr, /--region 必填/, p);
  }
});


test('host open-port 阿里/腾讯/火山必须给 --region', async () => {
  const r = await run(['host', 'open-port', '--provider', 'aliyun', '--ip', '1.2.3.4', '--port', '22', '--source', '1.2.3.4'],
    { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /--region 必填/);
});

test('host open-port 三家不接受 --group（红线：只新建专用组）', async () => {
  const r = await run(['host', 'open-port', '--provider', 'aliyun', '--region', 'cn-beijing', '--ip', '1.2.3.4', '--port', '22', '--source', '1.2.3.4', '--group', 'sg-123'],
    { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /只新建专用安全组/);
});

test('安全组名生成只用 ASCII', async () => {
  const fw = require('../lib/firewall');
  assert.strictEqual(fw.groupNameFor('203.0.113.10', 3389), 'srvprice-203-0-113-10-3389');
});

// ---- 变现线 promo：联盟推广 / 代理商（2026-11-21）----
test('promo list 输出八家厂商与两条变现线', async () => {
  const r = await run(['promo', 'list'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.count, 8);
  for (const item of p.items) {
    assert.ok(item.lines.affiliate && item.lines.agent, `${item.id} 两条线都要有`);
    assert.ok(item.status && item.status.affiliate && item.status.agent, `${item.id} 两条线都要有状态`);
  }
});

test('promo list --status apply --line agent 命中已核实的火山代理商线', async () => {
  const r = await run(['promo', 'list', '--status', 'apply', '--line', 'agent'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  const volc = p.items.find((x) => x.id === 'volcengine');
  assert.ok(volc, '火山代理商线应可申请');
  assert.strictEqual(volc.lines.agent.verified, true);
  assert.match(volc.lines.agent.url, /partner\.volcengine\.com/);
});

test('promo get 西部数码带银牌代理身份与两条已核实线', async () => {
  const r = await run(['promo', 'get', '--name', 'westcn'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout).provider;
  assert.match(p.identity, /银牌/);
  assert.strictEqual(p.lines.affiliate.verified, true);
  assert.strictEqual(p.lines.agent.verified, true);
  assert.match(p.lines.affiliate.rate, /25%/);
  assert.ok(p.conflicts.some((c) => /云数据库/.test(c)), '口径不一致要如实列出');
});

test('promo get 与 providers.json 对账：腾讯 CPS 渠道链接可见', async () => {
  const r = await run(['promo', 'get', '--name', 'tencent'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout).provider;
  assert.ok(p.cli_link && p.cli_link.url, '本机已有 CPS 渠道链接');
  assert.match(p.cli_link.url, /cps_key=/);
});

test('promo get 未知厂商退出码 4', async () => {
  const r = await run(['promo', 'get', '--name', 'nope'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 4);
});

test('promo actions 汇总待办，条目带动作与厂商', async () => {
  const r = await run(['promo', 'actions'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.ok(p.count > 0);
  for (const item of p.items) {
    assert.ok(item.action, '每条待办必须有动作');
    assert.ok(['affiliate', 'agent'].includes(item.line));
  }
  assert.ok(p.items.some((i) => i.provider === 'tencent' && /互斥/.test(i.action)),
    '腾讯的身份互斥要作为待办前提摆出来');
});

test('promo actions --line affiliate 只出联盟推广线', async () => {
  const r = await run(['promo', 'actions', '--line', 'affiliate'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.ok(p.items.length > 0);
  for (const item of p.items) assert.strictEqual(item.line, 'affiliate');
});

test('promo list --output text 表格带星号图例', async () => {
  const r = await run(['promo', 'list', '--output', 'text'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /厂商\s+联盟推广\s+代理商/);
  assert.match(r.stdout, /\* = 该线官方来源未核实/);
});

test('promo 未核实行不得出现已核实数字：verified=false 的 rate 必须标 UNVERIFIED', async () => {
  const r = await run(['promo', 'list'], { SRVPRICE_HOME: HOME });
  const p = JSON.parse(r.stdout);
  for (const item of p.items) {
    for (const line of ['affiliate', 'agent']) {
      const l = item.lines[line];
      if (l.verified === false) {
        assert.ok(l.rate == null || /^UNVERIFIED/.test(l.rate),
          `${item.id}.${line} 未核实却给了数字：${l.rate}`);
      }
    }
  }
});

test('promo 非法 --line 退出码 2', async () => {
  const r = await run(['promo', 'list', '--line', 'bogus'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /--line 支持/);
});

// ---- --refresh 降级要说清快照日期（2026-11-21 muse 派单）----
test('--refresh 失败时 stderr 明说是哪天的快照，不静默降级', async () => {
  const r = await run(['plan', 'list', '--refresh', '--page-size', '1'],
    { SRVPRICE_HOME: HOME, SRVPRICE_API: 'http://127.0.0.1:9' });
  assert.strictEqual(r.code, 0, '刷新失败不阻断，仍返回数据');
  assert.match(r.stderr, /数据刷新失败/);
  assert.match(r.stderr, /数据日 \d{4}-\d{2}-\d{2}/, '降级要带快照日期');
  const payload = JSON.parse(r.stdout);
  assert.ok(payload.items.length >= 1);
});

// ---- promo sync / link（2026-11-21）----
test('promo sync --local-only 能打出三处链接与结论对不上的问题', async () => {
  const r = await run(['promo', 'sync', '--local-only'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.source, 'local');
  assert.ok(p.findings.some((f) => f.provider === 'baidu' && f.kind === 'link_present_but_unverified'));
  assert.ok(p.findings.some((f) => f.provider === 'jdcloud' && f.kind === 'link_host_mismatch'));
});

test('promo sync 站点不可用时降级为本地对账而不是假报成功', async () => {
  const r = await run(['promo', 'sync'], { SRVPRICE_HOME: HOME, SRVPRICE_API: 'http://127.0.0.1:9' });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.strictEqual(p.source, 'local');
  assert.match(r.stderr, /站点暂无可用 promos 接口/);
});

test('promo link show 列出腾讯的 CPS 渠道链接', async () => {
  const r = await run(['promo', 'link', 'show', '--name', 'tencent'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 0);
  const p = JSON.parse(r.stdout);
  assert.ok(p.count >= 1);
  for (const item of p.items) {
    assert.strictEqual(item.source, 'bundled');
    assert.match(item.url, /^https:\/\/cloud\.tencent\.com\//);
  }
});

test('promo link set 写缓存后 buy url 立即用新链接，unset 恢复', async () => {
  const newUrl = 'https://www.ucloud.cn/site/active/u-ambassador.html?cps_code=TESTNEW';
  const set = await run(['promo', 'link', 'set', '--name', 'ucloud', '--url', newUrl], { SRVPRICE_HOME: HOME });
  assert.strictEqual(set.code, 0);
  assert.strictEqual(JSON.parse(set.stdout).target, 'cache');

  const buy = await run(['buy', 'url', '--provider', 'ucloud', '--output', 'text'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(buy.stdout.trim(), newUrl);

  const show = await run(['promo', 'link', 'show', '--name', 'ucloud'], { SRVPRICE_HOME: HOME });
  const item = JSON.parse(show.stdout).items.find((x) => !x.key);
  assert.strictEqual(item.source, 'cache');

  const unset = await run(['promo', 'link', 'unset', '--name', 'ucloud'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(unset.code, 0);
  const back = await run(['buy', 'url', '--provider', 'ucloud', '--output', 'text'], { SRVPRICE_HOME: HOME });
  assert.match(back.stdout, /kuaijiesale\.html/, '回滚后应回到仓库里的原链接');
});

test('promo link set 拒绝不在厂商允许域的链接', async () => {
  const r = await run(['promo', 'link', 'set', '--name', 'ucloud', '--url', 'https://evil.example.com/x'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /不在该厂商允许域/);
});

test('promo link set 拒绝 http 链接', async () => {
  const r = await run(['promo', 'link', 'set', '--name', 'ucloud', '--url', 'http://www.ucloud.cn/x'], { SRVPRICE_HOME: HOME });
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /只接受 https/);
});

test('promo link set --bundled 写仓库数据并留备份（非交互必须 --yes）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvprice-data-'));
  fs.cpSync(path.join(__dirname, '..', 'data'), dataDir, { recursive: true });
  const env = { SRVPRICE_HOME: HOME, SRVPRICE_DATA_DIR: dataDir };

  const blocked = await run(['promo', 'link', 'set', '--name', 'ucloud', '--url', 'https://www.ucloud.cn/a?cps_code=NEW', '--bundled'], env);
  assert.strictEqual(blocked.code, 7, '非交互写仓库必须拦住');

  const ok = await run(['promo', 'link', 'set', '--name', 'ucloud', '--url', 'https://www.ucloud.cn/a?cps_code=NEW', '--bundled', '--yes'], env);
  assert.strictEqual(ok.code, 0);
  const out = JSON.parse(ok.stdout);
  assert.strictEqual(out.target, 'bundled');
  assert.ok(out.backup && fs.existsSync(out.backup), '写仓库前要留 .bak 备份');

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8'));
  assert.strictEqual(saved.providers.find((p) => p.id === 'ucloud').channel_url, 'https://www.ucloud.cn/a?cps_code=NEW');
});
