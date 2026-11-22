'use strict';

// 语音播报（规格 §4.7，2026-11-20 修正）：
//   1) edge-tts 优先（本机已装；免费、中文自然）
//   2) 系统 SAPI 只作兜底（本机 0 个语音包，实测不出声，不依赖）
// 静默规则：只有 human / done / fail 三类会出声，其余一律静默。

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { appDir, ensureDir } = require('./config');

const SPEAK_CATEGORIES = new Set(['human', 'done', 'fail']);
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

let _edge = null;
function edgeAvailable() {
  if (_edge !== null) return _edge;
  try {
    const r = spawnSync('edge-tts', ['--version'], { timeout: 8000, windowsHide: true });
    _edge = r.status === 0;
  } catch (_) {
    _edge = false;
  }
  return _edge;
}

let _sapi = null;
function sapiVoiceCount() {
  if (_sapi !== null) return _sapi;
  try {
    const script = 'Add-Type -AssemblyName System.Speech; try { (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count } catch { 0 }';
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { timeout: 15000, windowsHide: true });
    _sapi = Number(String(r.stdout || '0').trim()) || 0;
  } catch (_) {
    _sapi = 0;
  }
  return _sapi;
}

function playMp3(file, textLength) {
  // WMPlayer COM：能播 mp3，不需要 ffmpeg
  const approx = Math.min(180, Math.max(4, Math.ceil(textLength * 0.35)));
  const script = [
    '$p = New-Object -ComObject WMPlayer.OCX',
    `$p.URL = ${psQuote(file)}`,
    '$p.controls.play()',
    `for ($i = 0; $i -lt ${approx * 2}; $i++) { if ($p.playState -eq 1) { break }; Start-Sleep -Milliseconds 500 }`,
    '$p.close()'
  ].join('; ');
  try {
    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
  } catch (_) {}
}

function sapiSpeak(t) {
  if (process.platform !== 'win32' || sapiVoiceCount() === 0) {
    return { spoken: false, reason: 'no_tts' };
  }
  const script =
    'Add-Type -AssemblyName System.Speech; ' +
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    `$s.Speak(${psQuote(t)});`;
  try {
    const child = spawn('powershell', ['-NoProfile', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: true
    });
    child.unref();
    return { spoken: true, engine: 'sapi' };
  } catch (e) {
    return { spoken: false, reason: 'error', error: e.message };
  }
}

function speak(text, category = 'done', opts = {}) {
  if (!SPEAK_CATEGORIES.has(category)) return { spoken: false, reason: 'silent' };
  const t = String(text || '').trim();
  if (!t) return { spoken: false, reason: 'empty' };
  if (opts.noSpawn) return { spoken: false, reason: 'test' };

  if (edgeAvailable()) {
    try {
      ensureDir(appDir());
      const file = path.join(appDir(), `tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
      const voice = process.env.SRVPRICE_TTS_VOICE || DEFAULT_VOICE;
      const synth = spawn('edge-tts', ['--voice', voice, '--text', t, '--write-media', file], {
        windowsHide: true, stdio: 'ignore'
      });
      synth.on('close', (code) => {
        if (code === 0 && fs.existsSync(file)) {
          playMp3(file, t.length);
          setTimeout(() => { try { fs.unlinkSync(file); } catch (_) {} }, 120000);
        } else {
          sapiSpeak(t);
        }
      });
      synth.on('error', () => sapiSpeak(t));
      return { spoken: true, engine: 'edge-tts', voice };
    } catch (_) {
      /* 落到 SAPI */
    }
  }
  return sapiSpeak(t);
}

// 检查本机语音栈：edge-tts / SAPI 语音 / 识别器
function check() {
  const out = {
    platform: process.platform,
    edge_tts: edgeAvailable(),
    sapi_voices: 0,
    sapi_recognizers: [],
    error: ''
  };
  if (process.platform !== 'win32') {
    out.error = 'not windows';
    return Promise.resolve(out);
  }
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$o = @{ voices = @(); recognizers = @(); error = "" }',
    'try { $o.voices = @((New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Culture.Name + " " + $_.VoiceInfo.Name }) } catch { $o.error = $_.Exception.Message }',
    'try { $o.recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }) } catch {}',
    'ConvertTo-Json -InputObject $o -Compress'
  ].join('; ');
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout || '{}'));
        out.sapi_voices = (j.voices || []).length;
        out.sapi_recognizers = j.recognizers || [];
        out.error = j.error || '';
      } catch (_) {
        out.error = err ? err.message : 'parse failed';
      }
      resolve(out);
    });
  });
}

module.exports = { SPEAK_CATEGORIES, speak, check };
