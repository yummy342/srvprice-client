'use strict';

// 流程健康度（P3 自学习）：按 flow id + version 记成功/失败次数。
// 连续失败达到阈值 → 由调用方把 active 降回 draft（本模块只记账，不碰流程文件）。

const fs = require('fs');
const path = require('path');
const { appDir, ensureDir } = require('./config');

const DOWNGRADE_AFTER = 2;

function file() {
  return path.join(appDir(), 'flow_health.json');
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!j || typeof j !== 'object' || !j.flows) return { flows: {} };
    return j;
  } catch (_) {
    return { flows: {} };
  }
}

function save(h) {
  ensureDir(appDir());
  fs.writeFileSync(file(), JSON.stringify(h, null, 2) + '\n', { mode: 0o600 });
}

function get(id) {
  return load().flows[id] || null;
}

function success(id, version) {
  const h = load();
  const e = h.flows[id] || { version, failures: 0, successes: 0 };
  if (e.version !== version) { e.version = version; e.failures = 0; }
  e.successes = (e.successes || 0) + 1;
  e.failures = 0;
  e.last_ok_at = new Date().toISOString();
  delete e.last_error;
  h.flows[id] = e;
  save(h);
  return e;
}

function failure(id, version, info = {}) {
  const h = load();
  const e = h.flows[id] || { version, failures: 0, successes: 0 };
  if (e.version !== version) { e.version = version; e.failures = 0; }
  e.failures = (e.failures || 0) + 1;
  e.last_error = {
    reason: info.reason || null,
    step_id: info.stoppedAt || null,
    at: new Date().toISOString()
  };
  h.flows[id] = e;
  save(h);
  return e;
}

function shouldDowngrade(entry) {
  return !!(entry && entry.failures >= DOWNGRADE_AFTER);
}

function reset(id) {
  const h = load();
  delete h.flows[id];
  save(h);
}

module.exports = { load, get, success, failure, shouldDowngrade, reset, DOWNGRADE_AFTER };
