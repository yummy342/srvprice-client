'use strict';

// vault 物化：vault 是唯一真源，用时才把凭据注入给厂商 CLI。
// 做法：node vault-cli.js run <AK,SK> "node materialize-run.js <vendor> <profile> <region>"
//   —— 凭据只在 vault 子进程的 env 里，客户端进程不接触明文。

const path = require('path');
const { spawnSync } = require('child_process');

function vaultCli() {
  return process.env.SRVPRICE_VAULT_CLI ||
    path.join('C:', 'project', 'srv-vault', 'srv-vault-bundle', 'vault-cli.js');
}

function materializeRunner() {
  return path.join(__dirname, 'materialize-run.js').replace(/\\/g, '/');
}

function slug(vendor, profile) {
  return `${String(vendor).toUpperCase()}_${String(profile || 'default').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

// 单令牌厂商：只有一把 token（2026-11-20 加，DigitalOcean / Hetzner / Linode）
const SINGLE_TOKEN = new Set(['doctl', 'hcloud', 'linode', 'vultr']);

function items(vendor, profile) {
  // 西部数码：无 CLI，凭据是「用户名 + API 密码」两个条目（条目 env 名即条目名）
  if (vendor === 'west') {
    return { ak: 'WEST_USERNAME', sk: 'WEST_API_PASSWORD' };
  }
  const s = slug(vendor, profile);
  if (SINGLE_TOKEN.has(vendor)) return { token: `${s}_TOKEN` };
  return { ak: `${s}_AK`, sk: `${s}_SK` };
}

function srvpriceCli() {
  const path = require('path');
  return process.env.SRVPRICE_CLI ||
    path.join('C:', 'project', 'srvprice-cli', 'bin', 'srvprice.js');
}

function listItems() {
  const r = spawnSync(process.execPath, [vaultCli(), 'list'], { encoding: 'utf8', windowsHide: true });
  try {
    const j = JSON.parse(String(r.stdout || '[]'));
    return Array.isArray(j) ? j : (j.items || []);
  } catch (_) {
    return [];
  }
}

function status(vendor, profile) {
  const names = items(vendor, profile);
  const all = listItems();
  const names_all = new Set(all.map((i) => i.name));
  const out = {};
  for (const [k, name] of Object.entries(names)) out[k] = { name, exists: names_all.has(name) };
  return { vendor, profile, items: out };
}

function materialize(vendor, profile, region) {
  // 西部数码没有 CLI：物化 = 用 vault 注入的凭据跑一次只读 list，证明链路可用
  if (vendor === 'west') {
    const st = status(vendor, profile);
    if (!st.items.ak.exists || !st.items.sk.exists) {
      return { ok: false, error: 'vault 缺条目：WEST_USERNAME / WEST_API_PASSWORD' };
    }
    const cmd = `node "${srvpriceCli().replace(/\\/g, '/')}" host list --provider west`;
    const r = spawnSync(process.execPath,
      [vaultCli(), 'run', 'WEST_USERNAME,WEST_API_PASSWORD', cmd],
      { encoding: 'utf8', windowsHide: true, timeout: 180000 });
    // stdout 是完整 JSON（可能前面有 JSONL 告警）；stderr 只做错误提示
    const rawOut = String(r.stdout || '').trim();
    const cut = rawOut.indexOf('{');
    let detail = null;
    if (cut >= 0) {
      try { detail = JSON.parse(rawOut.slice(cut)); } catch (_) {}
    }
    const errs = (detail && detail.errors) || [];
    const count = detail && typeof detail.count === 'number' ? detail.count : null;
    const out = `${rawOut}${String(r.stderr || '')}`.trim();
    return {
      ok: r.status === 0 && count !== null && errs.length === 0,
      code: r.status,
      detail: { vendor, profile, servers: count, errors: errs, note: '西部无 CLI：物化=凭据注入可读通' },
      message: errs.length ? errs[0].message : (count === null ? out.slice(0, 200) : '')
    };
  }
  const names = items(vendor, profile);
  const st = status(vendor, profile);
  // 单令牌厂商：物化只要一把 token
  if (SINGLE_TOKEN.has(vendor)) {
    if (!st.items.token.exists) {
      return { ok: false, error: 'vault 缺条目：' + names.token };
    }
    const cmd = `node "${materializeRunner()}" ${vendor} ${profile} ${region || ''}`.trim();
    const r = spawnSync(process.execPath,
      [vaultCli(), 'run', names.token, cmd],
      { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    let detail = null;
    try { detail = JSON.parse(out.split(/\r?\n/).filter(Boolean).pop()); } catch (_) {}
    return {
      ok: r.status === 0 && (!detail || detail.ok !== false),
      code: r.status,
      detail,
      message: detail ? detail.message : out.slice(0, 300)
    };
  }
  if (!st.items.ak.exists || !st.items.sk.exists) {
    const missing = [];
    if (!st.items.ak.exists) missing.push(names.ak);
    if (!st.items.sk.exists) missing.push(names.sk);
    return { ok: false, error: 'vault 缺条目：' + missing.join(', ') };
  }
  const cmd = `node "${materializeRunner()}" ${vendor} ${profile} ${region || ''}`.trim();
  const r = spawnSync(process.execPath,
    [vaultCli(), 'run', `${names.ak},${names.sk}`, cmd],
    { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  let detail = null;
  try { detail = JSON.parse(out.split(/\r?\n/).filter(Boolean).pop()); } catch (_) {}
  return {
    ok: r.status === 0 && (!detail || detail.ok !== false),
    code: r.status,
    detail,
    message: detail ? detail.message : out.slice(0, 300)
  };
}

function purgeInfo(vendor) {
  const paths = {
    volcengine: ['~/.volcengine'],
    aliyun: ['~/.aliyun'],
    tencent: ['~/.tccli'],
    baidu: ['~/.bce'],
    doctl: ['%APPDATA%\\doctl\\config.yaml'],
    hcloud: ['%APPDATA%\\hcloud\\cli.toml'],
    linode: ['~/.config/linode-cli'],
    west: []
  };
  return {
    vendor,
    note: vendor === 'west'
      ? '西部无 CLI 配置：物化=运行时 env 注入；清理=删除 vault 条目 WEST_USERNAME / WEST_API_PASSWORD'
      : '厂商 CLI 配置只是物化缓存；清理请手动删除对应目录（vault 真源不受影响）',
    paths: paths[vendor] || []
  };
}

module.exports = { vaultCli, slug, items, listItems, status, materialize, purgeInfo };
