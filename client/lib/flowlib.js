'use strict';

// 共享流程库（P4 自学习）：按 flow id 收各账号的成功样本，做多账号收敛。
// 存储：本机 appDir/flowlib.json（未来可换成服务端 URL，接口不变）。
// 隐私：只存账号 hash，不存账号明文；样本不含任何输入值（值已被参数化）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appDir, ensureDir } = require('./config');

const SHARED_AFTER_ACCOUNTS = 3;

function file() {
  return path.join(appDir(), 'flowlib.json');
}

// 远端（可选）：设 SRVPRICE_FLOWLIB_URL + SRVPRICE_FLOWLIB_TOKEN 即走远端，
// 否则落本机文件。远端只存每流程的样本数组，合并仍在本机做。
function remoteCfg() {
  const url = process.env.SRVPRICE_FLOWLIB_URL;
  if (!url) return null;
  return { url: String(url).replace(/\/+$/, ''), token: String(process.env.SRVPRICE_FLOWLIB_TOKEN || '') };
}

function isRemote() {
  return !!remoteCfg();
}

async function remoteJson(pathname, init) {
  const c = remoteCfg();
  if (!c) throw new Error('未配置 SRVPRICE_FLOWLIB_URL');
  const res = await fetch(c.url + pathname, Object.assign({
    headers: Object.assign(
      { 'content-type': 'application/json' },
      c.token ? { authorization: `Bearer ${c.token}` } : {}
    ),
    signal: AbortSignal.timeout(10000)
  }, init || {}));
  if (!res.ok) throw new Error(`flowlib 远端 HTTP ${res.status}`);
  return res.json();
}

async function getSamples(id) {
  if (isRemote()) {
    const j = await remoteJson(`/lib/${encodeURIComponent(id)}`);
    return Array.isArray(j.samples) ? j.samples : [];
  }
  return (load().flows[id] || {}).samples || [];
}

async function putSample(id, sample) {
  if (isRemote()) {
    const j = await remoteJson(`/lib/${encodeURIComponent(id)}/samples`, {
      method: 'POST',
      body: JSON.stringify({ sample })
    });
    return Array.isArray(j.samples) ? j.samples : [];
  }
  const lib = load();
  const entry = lib.flows[id] || { samples: [] };
  entry.samples = entry.samples.filter((s) => s.account_hash !== sample.account_hash);
  entry.samples.push(sample);
  lib.flows[id] = entry;
  save(lib);
  return entry.samples;
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!j || typeof j !== 'object' || !j.flows) return { version: 1, flows: {} };
    return j;
  } catch (_) {
    return { version: 1, flows: {} };
  }
}

function save(lib) {
  ensureDir(appDir());
  fs.writeFileSync(file(), JSON.stringify(lib, null, 2) + '\n', { mode: 0o600 });
}

function accountHash(label) {
  return crypto.createHash('sha256').update(String(label || 'unknown')).digest('hex').slice(0, 16);
}

function stepSignature(step) {
  return JSON.stringify(step && step.do || null);
}

// 多账号收敛：按步序取多数动作；verify 取多数文本；门槛≥3 账号才算 shared
function merge(id, samples) {
  const okSamples = (samples || []).filter((s) => s && Array.isArray(s.steps) && s.steps.length);
  const accounts = new Set(okSamples.map((s) => s.account_hash));
  const libStatus = accounts.size >= SHARED_AFTER_ACCOUNTS ? 'shared'
    : accounts.size >= 1 ? 'verified' : 'draft';
  // 流程文件的 status 只认 draft/active/deprecated：shared 映射为 active，收敛状态放 meta
  const status = libStatus === 'shared' ? 'active' : 'draft';

  const maxLen = okSamples.reduce((m, s) => Math.max(m, s.steps.length), 0);
  const steps = [];
  const vars = {};
  for (let i = 0; i < maxLen; i++) {
    const counts = new Map();
    for (const s of okSamples) {
      const st = s.steps[i];
      if (!st) continue;
      const key = stepSignature(st);
      const cur = counts.get(key) || { n: 0, step: st };
      cur.n += 1;
      counts.set(key, cur);
    }
    if (!counts.size) continue;
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    const verifyCounts = new Map();
    for (const s of okSamples) {
      const st = s.steps[i];
      if (!st || stepSignature(st) !== stepSignature(best.step)) continue;
      const vt = String((st.verify && st.verify.text) || '');
      verifyCounts.set(vt, (verifyCounts.get(vt) || 0) + 1);
    }
    const vbest = [...verifyCounts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    steps.push({
      step_id: `m${i + 1}`,
      do: JSON.parse(JSON.stringify(best.step.do)),
      verify: { text: vbest[0] || 'srvprice', timeout_ms: 8000 },
      fail_when: {},
      human: false,
      sensitive: false,
      note: `收敛自 ${best.n}/${counts.size ? okSamples.length : 0} 个样本（第 ${i + 1} 步）`
    });
  }
  for (const s of okSamples) {
    for (const k of Object.keys(s.variables || {})) vars[k] = s.variables[k];
  }
  const first = okSamples[0] || {};
  return {
    id,
    version: 1,
    status,
    vendor: first.vendor || '',
    title: first.title || id,
    variables: vars,
    entry: first.entry || '',
    preconditions: ['由多账号样本收敛生成；首次执行前仍需核对 verify'],
    steps,
    meta: { accounts: accounts.size, samples: okSamples.length, lib_status: libStatus },
    notes: `多账号收敛：${accounts.size} 个账号 / ${okSamples.length} 个成功样本；` +
      `门槛 ${SHARED_AFTER_ACCOUNTS} 账号（当前 ${libStatus}）。`
  };
}

const VAR_ONLY = /^\{\{[A-Za-z0-9_.-]+\}\}$/;

// 共享样本不允许出现未参数化的输入值（防止把用户数据传到远端）
function literalFillValues(flow) {
  const out = [];
  for (const st of (flow && flow.steps) || []) {
    const d = st.do || {};
    if (d.action !== 'fill_form') continue;
    for (const f of d.fields || []) {
      const v = String(f.value == null ? '' : f.value);
      if (v && !VAR_ONLY.test(v)) out.push({ step_id: st.step_id, value_len: v.length });
    }
  }
  return out;
}

async function publish(flow, accountLabel) {
  const id = String(flow.id || '');
  if (!id) throw new Error('flow 缺 id');
  const literals = literalFillValues(flow);
  if (literals.length) {
    const ids = literals.map((x) => x.step_id).join(', ');
    throw new Error(
      `拒绝上传：${literals.length} 个填表值未参数化（步骤 ${ids}）。` +
      '请先把这些值改成 {{变量}}（可用 flow save 后手工参数化）');
  }
  const sample = {
    account_hash: accountHash(accountLabel),
    at: new Date().toISOString(),
    version: flow.version,
    vendor: flow.vendor || '',
    title: flow.title || id,
    entry: flow.entry || '',
    variables: flow.variables || {},
    steps: Array.isArray(flow.steps) ? flow.steps : [],
    recorded_success: !!(flow.meta && flow.meta.recorded_success)
  };
  const samples = await putSample(id, sample);
  const merged = merge(id, samples);
  return {
    id,
    accounts: new Set(samples.map((s) => s.account_hash)).size,
    samples: samples.length,
    status: (merged.meta && merged.meta.lib_status) || merged.status,
    remote: isRemote()
  };
}

async function summary(id) {
  if (id) {
    const samples = await getSamples(id);
    if (!samples.length) return null;
    const merged = merge(id, samples);
    return {
      id, samples: samples.length,
      accounts: new Set(samples.map((s) => s.account_hash)).size,
      status: (merged.meta && merged.meta.lib_status) || merged.status,
      steps: merged.steps.length,
      accounts_hint: [...new Set(samples.map((s) => s.account_hash.slice(0, 8)))]
    };
  }
  const all = isRemote()
    ? (await remoteJson('/lib')).flows || {}
    : load().flows;
  const out = [];
  for (const [fid, e] of Object.entries(all)) {
    const samples = e.samples || [];
    if (!samples.length) continue;
    const merged = merge(fid, samples);
    out.push({
      id: fid, samples: samples.length,
      accounts: new Set(samples.map((s) => s.account_hash)).size,
      status: (merged.meta && merged.meta.lib_status) || merged.status,
      steps: merged.steps.length
    });
  }
  return out;
}

async function pull(id) {
  const samples = await getSamples(id);
  if (!samples.length) return null;
  return merge(id, samples);
}

module.exports = {
  load, publish, merge, summary, pull, accountHash, literalFillValues,
  isRemote, SHARED_AFTER_ACCOUNTS
};
