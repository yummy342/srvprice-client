#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""录音 + 语音活动检测（VAD）采集器。

用 sounddevice 抓默认麦克风（或 --device），等用户开口，说完静默 N 秒自动停，
裁掉首尾静音、做一次自动增益（麦克风偏小时补音量），写成 16k/mono/s16 的 wav。

只负责「音频 → wav」；转写交给 whisper.cpp（客户端 lib/stt.js）。
stdout 打一行 JSON（ensure_ascii），stderr 只放调试信息。
退出码：0 有语音已写 wav；3 没听到说话；2 参数/设备错误。
"""

import argparse
import collections
import json
import sys
import time
import wave

import numpy as np
import sounddevice as sd

RATE = 16000
BLOCK_MS = 100
BLOCK = RATE * BLOCK_MS // 1000


def rms(x):
    if len(x) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x.astype(np.float64)))) / 32768.0)


def peak(x):
    if len(x) == 0:
        return 0.0
    return float(np.max(np.abs(x.astype(np.float64))) / 32768.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--max', type=float, default=30.0)
    ap.add_argument('--silence', type=float, default=1.5, help='说完后静默多少秒收尾')
    ap.add_argument('--device', type=int, default=-1)
    ap.add_argument('--debug', action='store_true')
    args = ap.parse_args()

    def dbg(m):
        if args.debug:
            sys.stderr.write('[vad %.1fs] %s\n' % (time.time() - t0, m))
            sys.stderr.flush()

    t0 = time.time()
    chunks = []
    tail = collections.deque(maxlen=5)          # 近 500ms，用来估底噪
    noise = []                                   # 前 1 秒非语音块的 rms
    speech_started = False
    last_voice = 0.0
    th = 0.012
    consec = 0  # 连续超过阈值的块数：必须 >=2 才算开口，避免一声噪声误触发

    try:
        with sd.InputStream(samplerate=RATE, channels=1, dtype='int16',
                            blocksize=BLOCK, device=None if args.device < 0 else args.device) as stream:
            dbg('device=%r rate=%d' % (stream.device, int(stream.samplerate)))
            while True:
                data, overflowed = stream.read(BLOCK)
                if overflowed:
                    dbg('overflow')
                x = data[:, 0].copy()
                chunks.append(x)
                r = rms(x)
                elapsed = time.time() - t0

                if not speech_started:
                    tail.append(r)
                    # 用开始阶段的底噪估阈值（说话前），并留一个下限，防止把环境噪声当人声
                    if len(noise) < 10 and r < 0.02:
                        noise.append(r)
                    base = float(np.median(noise)) if noise else 0.005
                    th = min(0.05, max(0.012, base * 3.0))
                    consec = consec + 1 if r > th else 0
                    if consec >= 2 and len(chunks) > 3:
                        speech_started = True
                        last_voice = elapsed
                        dbg('speech start, rms=%.3f th=%.3f' % (r, th))
                        continue
                else:
                    if r > th:
                        last_voice = elapsed
                    if elapsed - last_voice >= args.silence:
                        dbg('silence stop')
                        break

                if elapsed >= args.max:
                    dbg('max stop')
                    break
    except Exception as e:  # 设备被占用 / 无麦克风
        print(json.dumps({'ok': False, 'reason': 'audio_error', 'error': str(e)}, ensure_ascii=True))
        return 2

    audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
    if not speech_started or len(audio) == 0:
        print(json.dumps({'ok': False, 'reason': 'no_speech',
                          'noise_rms': round(float(np.median(noise)) if noise else 0, 4)},
                         ensure_ascii=True))
        return 3

    # 按 20ms 帧找首尾语音，各留 200ms 余量
    f = 320
    n = len(audio) // f
    frames = audio[:n * f].reshape(n, f).astype(np.float64)
    e = np.sqrt(np.mean(frames ** 2, axis=1)) / 32768.0
    loud = np.where(e > th)[0]
    if len(loud) == 0:
        print(json.dumps({'ok': False, 'reason': 'no_speech'}, ensure_ascii=True))
        return 3
    pad = 10  # 10 帧 = 200ms
    a = max(0, loud[0] - pad) * f
    b = min(n, loud[-1] + 1 + pad) * f
    audio = audio[a:b]

    pk = peak(audio)
    gain = 1.0
    if pk > 0.0001:
        gain = min(10.0, max(1.0, 0.25 / pk))
    if gain > 1.0:
        audio = np.clip(audio.astype(np.float64) * gain, -32768, 32767).astype(np.int16)

    with wave.open(args.out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(audio.tobytes())

    out = {
        'ok': True,
        'file': args.out,
        'seconds': round(len(audio) / RATE, 2),
        'peak': round(peak(audio), 4),
        'rms': round(rms(audio), 4),
        'noise_rms': round(float(np.median(noise)) if noise else 0, 4),
        'gain': round(gain, 2),
        'threshold': round(th, 4)
    }
    dbg('saved %(seconds)ss peak=%(peak)s rms=%(rms)s gain=%(gain)s' % out)
    print(json.dumps(out, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
