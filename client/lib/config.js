'use strict';

// 本地配置与路径。第一期骨架：路径用环境变量可覆盖，token 每次安装生成一次。

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function appDir() {
  if (process.env.SRVPRICE_CLIENT_HOME) return process.env.SRVPRICE_CLIENT_HOME;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'srvprice-client');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function tokenFile() {
  return path.join(appDir(), 'bridge-token');
}

// 每次安装生成一次；扩展弹窗里粘贴它才能连上（配合 chrome-extension:// 来源校验）。
function ensureToken() {
  ensureDir(appDir());
  const f = tokenFile();
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  } catch (_) { /* 不存在就生成 */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

function readToken() {
  try { return fs.readFileSync(tokenFile(), 'utf8').trim(); } catch (_) { return ''; }
}

function defaultCli() {
  return process.env.SRVPRICE_CLI ||
    path.join('C:', 'project', 'srvprice-cli', 'bin', 'srvprice.js');
}

function defaultPort() {
  return Number(process.env.SRVPRICE_CLIENT_PORT || 8790);
}

function flowsDir() {
  return process.env.SRVPRICE_CLIENT_FLOWS || path.join(__dirname, '..', 'flows');
}

function stateFile() {
  return path.join(appDir(), 'state.json');
}

function eventLog() {
  return path.join(appDir(), 'events.jsonl');
}

module.exports = {
  appDir, ensureDir, ensureToken, readToken, tokenFile,
  defaultCli, defaultPort, flowsDir, stateFile, eventLog
};
