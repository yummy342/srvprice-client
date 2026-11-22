'use strict';

// 资源列表：只读调用 srvprice CLI 的 host list。
// 永远注入 SRVPRICE_READONLY=1（第二层保险），且只解析 stdout 的 JSON。
// 西部数码没有 CLI、凭据要 vault 注入：列表含西部时改走 `vault-cli run`。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { defaultCli } = require('./config');

function vaultCliPath() {
  return process.env.SRVPRICE_VAULT_CLI ||
    path.join('C:', 'project', 'srv-vault', 'srv-vault-bundle', 'vault-cli.js');
}

let _westReady = null;
function westVaultReady() {
  if (_westReady !== null) return _westReady;
  const vc = vaultCliPath();
  if (!fs.existsSync(vc)) { _westReady = false; return false; }
  try {
    const r = spawnSync(process.execPath, [vc, 'list'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const j = JSON.parse(String(r.stdout || '[]'));
    const names = new Set((Array.isArray(j) ? j : (j.items || [])).map((i) => i.name));
    _westReady = names.has('WEST_USERNAME') && names.has('WEST_API_PASSWORD');
  } catch (_) {
    _westReady = false;
  }
  return _westReady;
}

function listHosts(opts = {}) {
  const cli = opts.cli || defaultCli();
  const timeoutMs = opts.timeoutMs || 300000;
  const provider = opts.provider ? String(opts.provider) : '';
  const args = [cli, 'host', 'list', '--output', 'json'];
  if (provider) args.push('--provider', provider);

  const env = { ...process.env, SRVPRICE_READONLY: '1', SRVPRICE_PROGRESS: '1' };
  // 含西部的列表要 vault 注入（WEST_USERNAME / WEST_API_PASSWORD）；条目不齐就退回直跑
  const useVault = (!provider || provider === 'west') && westVaultReady();
  let cmd = process.execPath;
  let cmdArgs = args;
  if (useVault) {
    // vault run 会重建子进程 env（不透传 SRVPRICE_READONLY）——在 shell 里显式补上
    const innerBase = `node "${String(cli).replace(/\\/g, '/')}" host list --output json` +
      (provider ? ` --provider ${provider}` : '');
    const inner = `set SRVPRICE_READONLY=1&& set SRVPRICE_PROGRESS=1&& ${innerBase}`;
    cmd = process.execPath;
    cmdArgs = [vaultCliPath(), 'run', 'WEST_USERNAME,WEST_API_PASSWORD', inner];
  }

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let stderrBuf = '';
    // stderr 里混着 JSONL 进度与普通诊断：进度回调，其余留作错误信息
    const onLine = (line) => {
      if (!line) return;
      let j = null;
      try { j = JSON.parse(line); } catch (_) {}
      if (j && j.level === 'progress') {
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(j); } catch (_) {}
        }
        return;
      }
      err += line + '\n';
    };
    let done = false;
    const child = spawn(cmd, cmdArgs, { env, windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      reject(new Error(`srvprice host list 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      stderrBuf += d;
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        onLine(line);
      }
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      onLine(stderrBuf.trim());
      let data = null;
      try {
        data = JSON.parse(out);
      } catch (_) {
        return reject(new Error(
          `srvprice host list 输出不是 JSON（exit=${code}）：${(err || out).slice(0, 300)}`));
      }
      resolve({
        code,
        items: data.items || [],
        errors: data.errors || [],
        note: data.note || '',
        stderr: err.trim(),
        via_vault: useVault
      });
    });
  });
}

module.exports = { listHosts, westVaultReady };
