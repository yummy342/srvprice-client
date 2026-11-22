'use strict';

// 在 vault-cli run <AK,SK> 的注入环境里执行厂商 CLI 的 configure 命令。
// 用法：node materialize-run.js <vendor> <profile> <region>
// 明文只存在于本进程 env 与子进程 argv（瞬时），不打印、不落盘日志。

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vendor = String(process.argv[2] || '');
const profile = String(process.argv[3] || 'default');
const region = String(process.argv[4] || '');

// 单令牌厂商（2026-11-20）：DigitalOcean / Hetzner / Linode 都只有一把 token
const TOKEN = {
  doctl: { bin: 'doctl', env: 'SRVPRICE_DOCTL_TOKEN' },
  hcloud: { bin: 'hcloud', env: 'SRVPRICE_HCLOUD_TOKEN' },
  linode: { env: 'SRVPRICE_LINODE_TOKEN' },
  // 注意：vault 条目 env 别名按 <VENDOR>_<PROFILE>_TOKEN 生成 → SRVPRICE_VULTR_TOKEN
  vultr: { env: 'SRVPRICE_VULTR_TOKEN' }
};

if (TOKEN[vendor]) {
  const t = process.env[TOKEN[vendor].env] || '';
  if (!t) {
    console.error(`vault 注入缺环境变量：${TOKEN[vendor].env}`);
    process.exit(3);
  }
  // vault-cli run 的注入环境可能只带白名单变量；Windows 的 CLI 找配置目录要用 APPDATA/USERPROFILE
  const winEnv = Object.assign({}, process.env, {
    APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    USERPROFILE: process.env.USERPROFILE || os.homedir(),
    HOME: process.env.HOME || os.homedir()
  });
  let ok = false;
  let code = null;
  let message = '';
  if (vendor === 'doctl') {
    // --access-token 只作用于默认 context（doctl 文档原文）；单账号够用
    const r = spawnSync('doctl', ['auth', 'init', '--access-token', t], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: winEnv });
    ok = r.status === 0;
    code = r.status;
    message = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 300);
  } else if (vendor === 'hcloud') {
    // 官方非交互方式：HCLOUD_TOKEN 环境变量 + --token-from-env
    const r = spawnSync('hcloud', ['context', 'create', '--token-from-env', profile || 'muse-readonly'], {
      encoding: 'utf8', windowsHide: true, timeout: 60000,
      env: Object.assign({}, winEnv, { HCLOUD_TOKEN: t })
    });
    ok = r.status === 0;
    code = r.status;
    message = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 300);
  } else if (vendor === 'vultr') {
    // vultr-cli 读 %APPDATA%\vultr-cli.yaml（单字段 api-key）
    try {
      const file = path.join(winEnv.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'vultr-cli.yaml');
      fs.writeFileSync(file, `api-key: ${t}\n`, { mode: 0o600 });
      ok = true;
      code = 0;
      message = `wrote ${file}`;
    } catch (e) {
      ok = false;
      code = 1;
      message = String(e.message || e).slice(0, 300);
    }
  } else {
    // linode-cli 没有非交互 configure：按官方配置格式直接写 ~/.config/linode-cli
    //   [DEFAULT] default-user = <profile>
    //   [<profile>] token = … region = …
    try {
      const dir = path.join(os.homedir(), '.config');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'linode-cli');
      const body = `[DEFAULT]\ndefault-user = ${profile}\n\n[${profile}]\ntoken = ${t}\nregion = ${region || 'us-east'}\n`;
      fs.writeFileSync(file, body, { mode: 0o600 });
      ok = true;
      code = 0;
      message = `wrote ${file}`;
    } catch (e) {
      ok = false;
      code = 1;
      message = String(e.message || e).slice(0, 300);
    }
  }
  console.log(JSON.stringify({ ok, vendor, profile, region: region || null, code, message }));
  process.exit(ok ? 0 : 1);
}

const MAP = {
  volcengine: {
    bin: 've',
    ak: 'SRVPRICE_VOLCENGINE_ACCESS_KEY',
    sk: 'SRVPRICE_VOLCENGINE_SECRET_KEY',
    args: (ak, sk) => ['configure', 'set', '--profile', profile, '--region', region || 'cn-beijing',
      '--access-key', ak, '--secret-key', sk]
  },
  aliyun: {
    bin: 'aliyun',
    ak: 'SRVPRICE_ALIYUN_ACCESS_KEY',
    sk: 'SRVPRICE_ALIYUN_SECRET_KEY',
    args: (ak, sk) => ['configure', 'set', '--profile', profile, '--mode', 'AK',
      '--access-key-id', ak, '--access-key-secret', sk, '--region', region || 'cn-beijing']
  },
  tencent: {
    bin: 'tccli',
    ak: 'SRVPRICE_TENCENT_SECRET_ID',
    sk: 'SRVPRICE_TENCENT_SECRET_KEY',
    args: (ak, sk) => ['configure', 'set', 'secretId', ak, 'secretKey', sk,
      'region', region || 'ap-guangzhou', 'output', 'json', '--profile', profile || 'default']
  },
  baidu: {
    bin: 'bce',
    ak: 'SRVPRICE_BAIDU_ACCESS_KEY',
    sk: 'SRVPRICE_BAIDU_SECRET_KEY',
    args: (ak, sk) => ['configure', 'set', profile || 'default',
      '--access-key-id', ak, '--secret-access-key', sk, '--region', region || 'bj']
  }
};

const m = MAP[vendor];
if (!m) {
  console.error(`不支持的厂商：${vendor}`);
  process.exit(2);
}
const ak = process.env[m.ak] || '';
const sk = process.env[m.sk] || '';
if (!ak || !sk) {
  console.error(`vault 注入缺环境变量：${!ak ? m.ak : m.sk}`);
  process.exit(3);
}

const r = spawnSync(m.bin, m.args(ak, sk), {
  encoding: 'utf8',
  windowsHide: true
});
// 只回长度与退出码，不打印任何含密钥的输出
const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
console.log(JSON.stringify({
  ok: r.status === 0,
  vendor,
  profile,
  region: region || null,
  code: r.status,
  message: out.slice(0, 300)
}));
process.exit(r.status === 0 ? 0 : 1);
