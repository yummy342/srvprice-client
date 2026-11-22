'use strict';

// run_command 执行器（安全版）：
// - 不开 shell（拒绝 ; & | ` $ > < 等元字符）
// - 只允许厂商 CLI 白名单
// - 破坏性动词默认拒绝，需显式 allowDestructive
// - 不经手密钥：带 {{...}} 的命令由调用方判定为未解析，不在这里拼明文

const { spawn } = require('child_process');
const path = require('path');

const ALLOWED = new Set([
  've', 'aliyun', 'tccli', 'bce', 'ucloud', 'jdc', 'ctyuncli',
  'doctl', 'hcloud', 'vultr', 'linode-cli', 'aws', 'srvprice'
]);

const SHELL_META = /[;&|`$><\n\r]/;
// 匹配 token 开头（如 DeleteInstance / stop / rm），不误伤 warm 这类普通单词
const DESTRUCTIVE = /(?:^|[^a-z])(?:delete|destroy|terminate|remove|rm|mkfs|shutdown|reboot|stop|poweroff|format|drop)/i;

// 简单 argv 解析：支持单/双引号，不支持转义链
function splitArgv(raw) {
  const s = String(raw || '');
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
      continue;
    }
    cur += c;
  }
  if (quote) throw new Error('命令引号未闭合');
  if (cur) out.push(cur);
  return out;
}

function check(raw, opts = {}) {
  const cmd = String(raw || '').trim();
  if (!cmd) throw new Error('空命令');
  if (SHELL_META.test(cmd)) throw new Error('命令包含 shell 元字符，已拒绝');
  const argv = splitArgv(cmd);
  if (!argv.length) throw new Error('空命令');
  const bin = path.basename(argv[0]).replace(/\.exe$/i, '').toLowerCase();
  if (!ALLOWED.has(bin)) {
    throw new Error(`二进制不在白名单：${argv[0]}（允许：${[...ALLOWED].join(', ')}）`);
  }
  if (!opts.allowDestructive && DESTRUCTIVE.test(cmd)) {
    throw new Error('命令含破坏性动词（delete/stop/reboot 等），需 --allow-destructive');
  }
  return argv;
}

function run(raw, opts = {}) {
  const argv = check(raw, opts); // 白名单/元字符校验失败会同步抛出
  const timeout = opts.timeout || 60000;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(argv[0], argv.slice(1), {
      windowsHide: true,
      env: process.env,
      cwd: opts.cwd
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) { /* noop */ }
      resolve({ ok: false, code: null, timeout: true, stdout: out.slice(0, 4000), stderr: 'timeout' });
    }, timeout);
    child.stdout.on('data', (d) => { if (out.length < 20000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out.slice(0, 4000), stderr: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: out.slice(0, 4000),
        stderr: err.slice(0, 4000)
      });
    });
  });
}

module.exports = { ALLOWED, splitArgv, check, run };
