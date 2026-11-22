'use strict';

// 录音采集器：用 whisper.cpp 自带的 stream.exe 抓麦克风（不用另装 ffmpeg/sox）。
// 规格 §4.7：识别只用现成 whisper.cpp，客户端不自建 STT。
//
// 工作方式：
//   stream.exe 是「滑动窗口」模式（默认 --step 3000）：每约 2–3 秒把最近 ~10 秒音频转写一次，
//   用 ESC[2K\r 清行后打印最新全文。所以 stdout 里每一段都是一份「到目前为止的完整快照」，
//   不是增量——我们只留最后一份，不拼接。
//   注意：-sa 写出的 wav 不是原始麦克风音频，而是每次迭代把约 10 秒的滑动窗口重复追加
//   （实测 6 秒运行得到 30 秒音频），再转写只会触发 whisper 的静默幻听循环。
//   所以默认**不**用 wav；只有显式 --final-wav / --keep-wav 时才开 -sa。
//
// 停止条件：说了话以后静默 N 毫秒（默认 4s）自动停；否则到 --max 秒（默认 30s）停；Ctrl+C 也能停。
// 只回文本；wav 默认不生成。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const stt = require('./stt');

const CLEAR = '\u001b[2K\r';

// stream.exe 路径：env > stt.json 的 stream 字段 > 与 whisper main.exe 同目录 > PATH
function streamPath() {
  if (process.env.SRVPRICE_WHISPER_STREAM) return process.env.SRVPRICE_WHISPER_STREAM;
  const cfg = stt.cfg ? stt.cfg() : {};
  if (cfg.stream) return cfg.stream;
  const cli = (stt.cliPath && stt.cliPath()) || '';
  if (cli) {
    const guess = path.join(path.dirname(cli), 'stream.exe');
    if (fs.existsSync(guess)) return guess;
  }
  return 'stream.exe';
}

function status() {
  const p = streamPath();
  const found = fs.existsSync(p);
  const py = pythonAvailable();
  return {
    backend: py ? 'python' : 'stream',
    python: pythonBin(),
    python_found: py,
    faster_whisper: py ? fwAvailable() : false,
    fw_model: process.env.SRVPRICE_FW_MODEL || 'base',
    stream: p,
    stream_found: found,
    mic_command: 'listen --mic [--lang zh] [--max 30] [--silence 2000] [--device N] [--backend python|stream] [--debug]'
  };
}

// 把 stream.exe 到目前为止的 stdout 拆成快照，取最后一条干净文本。
// 过滤：清行控制符、100 空格占位、[Start speaking]、VAD 标记、空音频占位。
function parseSnapshots(buf) {
  const snaps = [];
  for (const part of String(buf || '').split(CLEAR)) {
    const t = part
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) continue;
    if (t === '[Start speaking]') continue;
    if (/^### Transcription/.test(t)) continue;
    // 已知的静默幻听产物：空音频标记、字幕组署名、鼓掌/音乐/笑声等音效
    if (/^\[BLANK_AUDIO\]$|^\(no speech\)$|^\[MUSIC\]$/i.test(t)) continue;
    if (/^[（(][^）)]{1,8}[）)]$/.test(t)) continue; // 整条只有括号音效：(笑) (音乐) (掌声) ...
    if (/字幕|Amara\.org|^Thanks for watching|谢谢观看|请不吝点赞|谢谢大家观看/i.test(t)) continue;
    snaps.push(t);
  }
  return snaps;
}

// stream.exe 被强杀时 wav 头里的两个长度字段还是 0，按实际文件长度补齐。
// 返回补好的 data 字节数；不是合法 RIFF/WAVE 或找不到 data 块返回 -1。
function repairWavHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return -1;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return -1;
  let off = 12;
  let dataOff = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; break; }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0 || dataOff > buf.length) return -1;
  const dataSize = buf.length - dataOff;
  if (dataSize <= 0) return -1;
  buf.writeUInt32LE(dataSize, dataOff - 4);
  buf.writeUInt32LE(buf.length - 8, 4);
  return dataSize;
}

function wavDurationSec(dataSize) {
  return dataSize > 0 ? dataSize / (16000 * 2) : 0; // 16kHz / 16-bit / mono
}

function newestWav(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.wav$/i.test(f));
    if (!files.length) return null;
    let best = null;
    for (const f of files) {
      const full = path.join(dir, f);
      const s = fs.statSync(full);
      if (!best || s.size > best.size) best = { file: full, size: s.size };
    }
    return best ? best.file : null;
  } catch (_) {
    return null;
  }
}

// whisper 在静默/噪声上会复读同一句（“我没想到你会做的事吗?” × N）。长度够长且短句连续重复就判为幻听。
function looksLikeLoop(text) {
  const t = String(text || '');
  if (t.length < 120) return false;
  for (let len = 6; len <= 40; len++) {
    for (let i = 0; i + len * 4 <= t.length; i += Math.max(1, len)) {
      const unit = t.slice(i, i + len);
      if (unit.trim().length < 4) continue;
      let n = 1;
      while (t.slice(i + n * len, i + (n + 1) * len) === unit) n++;
      if (n >= 4) return true;
    }
  }
  return false;
}

function pickText(latest, wavText) {
  const a = (latest || '').trim();
  if (a) return { text: a, source: 'live' };
  const b = (wavText || '').trim();
  if (b) return { text: b, source: 'wav' };
  return { text: '', source: 'none' };
}

// ---------- Python 采集（首选）：sounddevice + VAD，整段录完一次性转写 ----------

function pythonBin() {
  return process.env.SRVPRICE_PYTHON || 'python';
}

function vadScript() {
  return path.join(__dirname, '..', 'tools', 'recorder_vad.py');
}

let _pyOk = null;
function pythonAvailable() {
  if (_pyOk !== null) return _pyOk;
  try {
    if (!fs.existsSync(vadScript())) return (_pyOk = false);
    const r = spawnSync(pythonBin(), ['-c', 'import sounddevice'], { timeout: 15000, windowsHide: true });
    return (_pyOk = r.status === 0);
  } catch (_) {
    return (_pyOk = false);
  }
}

function fwScript() {
  return path.join(__dirname, '..', 'tools', 'transcribe_fw.py');
}

let _fwOk = null;
function fwAvailable() {
  if (_fwOk !== null) return _fwOk;
  try {
    if (!fs.existsSync(fwScript())) return (_fwOk = false);
    const r = spawnSync(pythonBin(), ['-c', 'import faster_whisper'], { timeout: 30000, windowsHide: true });
    return (_fwOk = r.status === 0);
  } catch (_) {
    return (_fwOk = false);
  }
}

// faster-whisper 转写（CPU int8，约 2 秒 / 3 秒音频）
function transcribeFw(wav, opts = {}) {
  const args = [fwScript(), '--file', wav, '--lang', opts.lang || 'zh'];
  if (opts.model) args.push('--model', String(opts.model));
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), args, {
      windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => {
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const r = JSON.parse(lines[i]);
          return resolve(r.ok ? r : { ok: false, error: r.error || '转写失败' });
        } catch (_) {}
      }
      resolve({ ok: false, error: (err || out || 'faster-whisper 没有输出').slice(0, 300) });
    });
  });
}

// 录音 → wav → 一次性转写（faster-whisper 优先，whisper.cpp 兜底）。没有滑动窗口，不会中途丢词。
function listenPython(opts = {}) {
  const debug = !!(opts.debug || process.env.SRVPRICE_DEBUG === '1');
  const startedAt = Date.now();
  const dbg = (m) => { if (debug) process.stderr.write('[recorder ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's] ' + m + '\n'); };
  const model = opts._model || stt.modelPath();
  if (!model || (!opts._model && !fs.existsSync(model))) {
    return Promise.resolve({ ok: false, error: '缺少 whisper 模型：stt-set --model <ggml-*.bin>' });
  }
  const customTranscribe = opts._transcribe;
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : 30000;
  const silenceSec = Math.max(0.8, Math.min(3, (Number(opts.silenceMs) > 0 ? Number(opts.silenceMs) : 2000) / 1000));
  const lang = opts.lang || 'zh';

  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srvprice-mic-'));
  } catch (e) {
    return Promise.resolve({ ok: false, error: '建临时目录失败：' + e.message });
  }
  const wav = path.join(tmp, 'mic.wav');

  const args = [vadScript(), '--out', wav, '--max', String(maxMs / 1000), '--silence', String(silenceSec)];
  if (opts.device !== undefined && opts.device !== null && opts.device !== '') args.push('--device', String(opts.device));
  if (debug) args.push('--debug');

  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let child;
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} };
    const finish = async (rec) => {
      if (settled) return;
      settled = true;
      dbg('finish rec=' + (rec ? rec.ok : 'null'));
      clearTimeout(killer);
      if (sigint) process.removeListener('SIGINT', sigint);
      let result;
      if (!rec || !rec.ok) {
        result = { ok: false, text: '', source: 'python', seconds: Math.round((Date.now() - startedAt) / 100) / 10,
          reason: rec && rec.error ? ('录音失败：' + rec.error) : '没听到说话' };
        if (rec && rec.noise_rms !== undefined) result.noise_rms = rec.noise_rms;
      } else {
        dbg('transcribe start');
        let tr;
        if (customTranscribe) {
          tr = await customTranscribe(wav, { lang });
        } else if (fwAvailable()) {
          tr = await transcribeFw(wav, { lang, model: opts.model });
          dbg('faster-whisper ok=' + (tr && tr.ok));
          if (!tr.ok && stt.available()) {
            dbg('faster-whisper 失败，退回 whisper.cpp：' + (tr && tr.error));
            tr = await stt.transcribe(wav, { lang });
          }
        } else {
          tr = await stt.transcribe(wav, { lang });
        }
        dbg('transcribe done ok=' + (tr && tr.ok));
        let text = tr && tr.ok ? String(tr.text || '').trim() : '';
        text = text.replace(/\[BLANK_AUDIO\]|\(no speech\)/gi, '').trim();
        if (text && looksLikeLoop(text)) text = '';
        result = {
          ok: !!text,
          text,
          source: 'python',
          seconds: Math.round((Date.now() - startedAt) / 100) / 10,
          audio_seconds: rec.seconds,
          peak: rec.peak,
          gain: rec.gain
        };
        if (!text) result.reason = tr && !tr.ok ? ('转写失败：' + tr.error) : '没有识别出内容';
      }
      dbg('result ' + JSON.stringify({ ok: result.ok, reason: result.reason || '', text: result.text && result.text.slice(0, 40) }));
      cleanup();
      resolve(result);
    };

    try {
      dbg('spawn ' + pythonBin() + ' ' + vadScript());
      child = spawn(pythonBin(), args, {
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
      });
    } catch (e) {
      cleanup();
      resolve({ ok: false, error: '启动录音器失败：' + e.message });
      return;
    }

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (debug) process.stderr.write(d.toString('utf8')); });
    child.on('error', (e) => { if (!settled) { settled = true; cleanup(); resolve({ ok: false, error: '启动录音器失败：' + e.message }); } });
    child.on('close', () => {
      let rec = null;
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { rec = JSON.parse(lines[i]); break; } catch (_) {}
      }
      finish(rec);
    });

    const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, maxMs + 30000);
    const sigint = () => {
      try { child.kill(); } catch (_) {}
      // 录音器被杀后 close 事件会来；没有 JSON 就按「没听到说话」收尾
    };
    process.once('SIGINT', sigint);
  });
}

// listen({lang, maxMs, silenceMs, device, backend, debug, _spawn, _transcribe})
// -> {ok, text, source, seconds, ...} 或 {ok:false, error}
function listen(opts = {}) {
  // 默认走 Python（能看电平、无窗口丢词）；--backend stream 或测试注入 _spawn 时走 stream.exe
  const wantStream = !!opts._spawn || !!opts._stream || opts.backend === 'stream'
    || (opts.backend !== 'python' && !pythonAvailable());
  return wantStream ? listenStream(opts) : listenPython(opts);
}

function listenStream(opts = {}) {
  const debug = !!(opts.debug || process.env.SRVPRICE_DEBUG === '1');
  const dbg = (m) => { if (debug) process.stderr.write('[recorder ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's] ' + m + '\n'); };
  const doSpawn = opts._spawn || spawn;
  const model = opts._model || stt.modelPath();
  if (!model || (!opts._model && !fs.existsSync(model))) {
    return Promise.resolve({ ok: false, error: '缺少 whisper 模型：stt-set --model <ggml-*.bin>' });
  }
  if (!opts._spawn && !stt.available()) {
    return Promise.resolve({ ok: false, error: 'whisper.cpp 未安装：stt-set --cli <main.exe>' });
  }
  const streamCli = opts._stream || streamPath();
  // 测试注入 _spawn 时不走真实子进程，也不要求本机存在 stream.exe（跨平台跑测试）
  if (!opts._stream && !opts._spawn && !fs.existsSync(streamCli)) {
    return Promise.resolve({ ok: false, error: '找不到 stream.exe（whisper.cpp 同目录）：' + streamCli });
  }

  const doTranscribe = opts._transcribe || stt.transcribe;
  const lang = opts.lang || 'zh';
  const useWav = !!(opts.finalWav || opts.keepWavDir);
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : 30000;
  const silenceMs = Number(opts.silenceMs) >= 0 ? Number(opts.silenceMs) : 4000;
  const startedAt = Date.now();

  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srvprice-listen-'));
  } catch (e) {
    return Promise.resolve({ ok: false, error: '建临时目录失败：' + e.message });
  }

  return new Promise((resolve) => {
    let child;
    let buf = '';
    let latest = '';
    let best = ''; // 滑动窗口里出现过的最长快照：后续窗口偶尔会丢掉前半句，别让短句覆盖长句
    let lastChangeAt = 0;
    let settled = false;
    let ticker = null;
    let sigintHandler = null;

    const cleanupTmp = () => {
      if (opts.keepWavDir) return;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    };

    const finish = async (reason) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
      try { if (child && !child.killed) child.kill(); } catch (_) {}
      // 给 stream.exe 最多 1.5s 退出，避免孤儿进程
      await new Promise((done) => {
        if (!child) return done();
        const t = setTimeout(done, 1500);
        child.once('exit', () => { clearTimeout(t); done(); });
      });

      let wavSeconds = 0;
      let wavText = '';
      const wav = useWav ? newestWav(tmp) : null;
      if (wav) {
        try {
          const b = fs.readFileSync(wav);
          const n = repairWavHeader(b);
          if (n > 0) {
            wavSeconds = wavDurationSec(n);
            if (opts.finalWav) {
              fs.writeFileSync(wav, b); // 补好头再交给 main.exe
              const r = await doTranscribe(wav, { lang });
              if (r && r.ok) wavText = r.text || '';
            }
          }
        } catch (_) {}
      }

      const liveText = best.length > latest.length ? best : latest;
      dbg('stop(' + reason + ') latest=' + JSON.stringify(latest.slice(-40)) + ' best=' + JSON.stringify(best.slice(-40)));
      const picked = pickText(liveText, wavText);
      const result = {
        ok: !!picked.text,
        text: picked.text,
        source: picked.source,
        seconds: Math.round((Date.now() - startedAt) / 100) / 10,
        wav_seconds: Math.round(wavSeconds * 10) / 10
      };
      if (opts.keepWavDir && wav) result.wav = wav;
      if (!result.ok) {
        result.reason = (latest || best) ? '没有识别出内容' : '没听到说话';
      }
      cleanupTmp();
      resolve(result);
    };

    try {
      dbg('spawn ' + streamCli + ' model=' + path.basename(model));
      const streamArgs = ['-m', model, '-l', lang, '-t', '4',
        '--step', '2000', '--length', '10000', '--keep', '200'];
      if (useWav) streamArgs.push('-sa');
      child = doSpawn(streamCli, streamArgs, { cwd: tmp, windowsHide: true });
    } catch (e) {
      cleanupTmp();
      resolve({ ok: false, error: '启动 stream.exe 失败：' + e.message });
      return;
    }

    const consume = () => {
      const snaps = parseSnapshots(buf);
      const last = snaps.length ? snaps[snaps.length - 1] : '';
      if (debug && last && last !== latest) dbg('snapshot: ' + last.slice(0, 80));
      if (last && looksLikeLoop(last)) return; // 静默幻听，不当作识别结果
      if (last && last.length > best.length) best = last;
      if (last && last !== latest) {
        latest = last;
        lastChangeAt = Date.now();
        if (opts.onPartial) {
          try { opts.onPartial(latest); } catch (_) {}
        }
      }
    };

    child.stdout.on('data', (d) => { buf += d.toString('utf8'); consume(); });
    child.stderr.on('data', () => {}); // 进度日志丢掉，不回显
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
      cleanupTmp();
      resolve({ ok: false, error: 'stream.exe 启动失败：' + e.message });
    });
    child.on('exit', () => {
      if (!settled) finish('exit');
    });

    // 静默检测：说过话之后 N 毫秒没有新文本就收尾；没说话到 max 秒超时
    ticker = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      if (latest && now - lastChangeAt >= silenceMs) return finish('silence');
      if (now - startedAt >= maxMs) return finish('max');
    }, 250);

    sigintHandler = () => finish('interrupt');
    process.once('SIGINT', sigintHandler);
  });
}

// 列出麦克风：优先 Python（sounddevice），退回 stream.exe（设备名是本地编码，继承 stdio）。
function printDevicesPython() {
  const code = [
    'import json, sounddevice as sd',
    'out = {"default": list(sd.default.device), "devices": []}',
    'for i, d in enumerate(sd.query_devices()):',
    '    if d["max_input_channels"] > 0:',
    '        out["devices"].append({"index": i, "name": d["name"], "channels": d["max_input_channels"], "rate": int(d["default_samplerate"])})',
    'print(json.dumps(out, ensure_ascii=True))'
  ].join('\n');
  const r = spawnSync(pythonBin(), ['-c', code], {
    timeout: 20000,
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
  });
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'python 列出设备失败').trim().slice(0, 300) };
  try {
    const parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    const def = Array.isArray(parsed.default) ? parsed.default[0] : parsed.default;
    for (const d of parsed.devices) d.default = d.index === def;
    return { ok: true, backend: 'python', default: def, devices: parsed.devices };
  } catch (e) {
    return { ok: false, error: '解析设备列表失败：' + e.message };
  }
}

function printDevices(opts = {}) {
  if (!opts._spawn && pythonAvailable()) {
    return Promise.resolve(printDevicesPython());
  }
  const model = stt.modelPath();
  const cli = streamPath();
  if (!fs.existsSync(cli)) {
    return Promise.resolve({ ok: false, error: '找不到 stream.exe：' + cli });
  }
  const doSpawn = opts._spawn || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = doSpawn(cli, ['-m', model || 'missing.bin', '-l', 'zh'], { stdio: 'inherit', windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    const t = setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, 2500);
    child.on('exit', () => { clearTimeout(t); resolve({ ok: true }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
  });
}

module.exports = {
  listen,
  listenPython,
  listenStream,
  status,
  pythonAvailable,
  pythonBin,
  fwAvailable,
  transcribeFw,
  vadScript,
  streamPath,
  printDevices,
  parseSnapshots,
  repairWavHeader,
  wavDurationSec,
  pickText,
  looksLikeLoop
};
