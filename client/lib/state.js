'use strict';

// 运行状态 + 事件日志。事件日志里敏感字段一律脱敏（规格 §7.4）。

const fs = require('fs');
const { ensureDir, appDir, stateFile, eventLog } = require('./config');

const SENSITIVE_KEY = /(secret|token|password|passwd|credential|access[_-]?key|private[_-]?key|api[_-]?key)/i;

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { return {}; }
}

function writeState(patch) {
  ensureDir(appDir());
  const s = { ...readState(), ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function appendEvent(event) {
  ensureDir(appDir());
  fs.appendFileSync(eventLog(), JSON.stringify(redact(event)) + '\n');
}

module.exports = { readState, writeState, redact, appendEvent };
