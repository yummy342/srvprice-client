'use strict';

// 购买 pipeline：选机 → 确认 → 付款（人工） → 接进列表。
// 只读 srvprice CLI 的套餐/链接数据；不代下单、不收款。
// 打开厂商页面必须显式 --yes；付款、实名、备案、登录全部由人在厂商官网完成。

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');

// srvprice CLI 在纯 JSON 前面会打 JSONL warn 行，先剥掉再解析
function parseOutput(stdout) {
  const kept = [];
  const warnings = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const j = JSON.parse(t);
        if (j && j.level) { warnings.push(j); continue; }
      } catch (_) { /* 多行 JSON 的片段，留给整体解析 */ }
    }
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  if (!text) throw new Error('CLI 没有输出');
  return { data: JSON.parse(text), warnings };
}

function runJson(args, opts = {}) {
  const cli = opts.cli || cfg.defaultCli();
  const r = spawnSync(process.execPath, [cli, ...args, '--json'], {
    encoding: 'utf8', timeout: opts.timeoutMs || 90000, windowsHide: true
  });
  if (r.error) throw new Error('调用 srvprice CLI 失败：' + r.error.message);
  const out = String(r.stdout || '');
  let parsed;
  try {
    parsed = parseOutput(out);
  } catch (_) {
    throw new Error(`srvprice CLI 输出不是 JSON（exit=${r.status}）：${(String(r.stderr || '') || out).slice(0, 200)}`);
  }
  if (r.status !== 0) {
    const msg = String(r.stderr || '').trim() || `exit=${r.status}`;
    throw new Error('srvprice CLI 报错：' + msg);
  }
  return parsed;
}

function getPlan(id, opts) {
  if (!id) throw new Error('需要套餐 ID，例如 ali-ecs99（用 purchase list 看）');
  const { data, warnings } = runJson(['plan', 'get', '--id', id], opts);
  if (!data || !data.plan) throw new Error(`没有找到套餐：${id}`);
  return { plan: data.plan, warnings };
}

function listPlans(filter = {}, opts) {
  const args = ['plan', 'list'];
  if (filter.provider) args.push('--provider', filter.provider);
  const { data, warnings } = runJson(args, opts);
  return { items: data.items || [], total: data.total || 0, warnings };
}

function getBuy(id, opts) {
  const { data } = runJson(['buy', 'url', '--plan-id', id], opts);
  return data;
}

// 打开浏览器（人工付款入口）；调用方必须先拿到用户明确的 --yes
function openBuy(id, opts) {
  const { data } = runJson(['buy', 'open', '--plan-id', id], opts);
  return data;
}

// ---- 买前基线：记录当前资源 ID，买完用 done 对差集 ----
function stateFile() {
  return path.join(cfg.appDir(), 'purchase-state.json');
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function writeState(s) {
  cfg.ensureDir(cfg.appDir());
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}
function recordBefore(planId, provider, ids) {
  const s = readState();
  s[planId] = { provider, ids: ids.slice(), at: new Date().toISOString() };
  writeState(s);
}
function takeBefore(planId) {
  const s = readState();
  const hit = s[planId] || null;
  if (hit) { delete s[planId]; writeState(s); }
  return hit;
}

function caveats(plan, warnings) {
  const out = [];
  if (plan.confidence && plan.confidence !== 'verified') {
    out.push(`价格置信度：${plan.confidence}（页面可能是 JS 渲染，须以厂商页面为准）`);
  }
  if (plan.verified_at) out.push(`快照核验日：${plan.verified_at}`);
  for (const w of warnings || []) if (w.message) out.push(w.message);
  return out;
}

module.exports = {
  parseOutput, runJson, getPlan, listPlans, getBuy, openBuy,
  recordBefore, takeBefore, caveats
};
