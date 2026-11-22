'use strict';

// 离线语音识别（whisper.cpp）。规格 §4.7：第一期不依赖系统语音包。
// 约定：
//   SRVPRICE_WHISPER_CLI   whisper.cpp 可执行文件（默认 whisper-cli / main.exe）
//   SRVPRICE_WHISPER_MODEL 模型路径（ggml-*.bin，必填）
// 只做「音频文件 → 文本」；录音需要单独的采集器（ffmpeg / sox），不在本模块里。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { appDir, ensureDir } = require('./config');

// 本机语音配置（非密钥）：%LOCALAPPDATA%\srvprice-client\stt.json {cli, model}
let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  try {
    _cfg = JSON.parse(fs.readFileSync(path.join(appDir(), 'stt.json'), 'utf8')) || {};
  } catch (_) {
    _cfg = {};
  }
  return _cfg;
}

function setConfig(patch) {
  const cur = Object.assign({}, cfg(), patch || {});
  ensureDir(appDir());
  fs.writeFileSync(path.join(appDir(), 'stt.json'), JSON.stringify(cur, null, 2));
  _cfg = cur;
  return cur;
}

function cliPath() {
  return process.env.SRVPRICE_WHISPER_CLI || cfg().cli || 'whisper-cli';
}

function modelPath() {
  return process.env.SRVPRICE_WHISPER_MODEL || cfg().model || '';
}

function available() {
  try {
    const r = spawnSync(cliPath(), ['--help'], { timeout: 8000, windowsHide: true });
    return r.status === 0 || r.status === 1;
  } catch (_) {
    return false;
  }
}

function status() {
  return {
    cli: cliPath(),
    cli_found: available(),
    model: modelPath() || null,
    model_found: modelPath() ? fs.existsSync(modelPath()) : false
  };
}

// transcribe(file, {lang}) -> {ok, text, error}
function transcribe(file, opts = {}) {
  return new Promise((resolve) => {
    if (!file || !fs.existsSync(file)) {
      resolve({ ok: false, error: '音频文件不存在：' + (file || '') });
      return;
    }
    const model = modelPath();
    if (!model || !fs.existsSync(model)) {
      resolve({
        ok: false,
        error: '缺少模型：设置 SRVPRICE_WHISPER_MODEL 指向 ggml-*.bin（whisper.cpp 模型）'
      });
      return;
    }
    if (!available()) {
      resolve({
        ok: false,
        error: 'whisper.cpp 未安装：把 whisper-cli 放进 PATH，或设置 SRVPRICE_WHISPER_CLI'
      });
      return;
    }
    const args = ['-m', model, '-f', file, '-l', String(opts.lang || 'zh'), '-nt'];
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(cliPath(), args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      resolve({ ok: false, error: '识别超时（180s）' });
    }, opts.timeoutMs || 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: (err || out || ('exit ' + code)).slice(0, 500) });
        return;
      }
      resolve({ ok: true, text: out.trim() });
    });
  });
}

module.exports = { transcribe, status, available, setConfig, cfg, cliPath, modelPath };
