#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""faster-whisper（CTranslate2）转写。比 whisper.cpp CPU 版快 ~3 倍。

只吃 16k/mono/s16 的 wav（recorder_vad.py 的产物）。stdout 一行 JSON。
模型首次运行会从 hf-mirror 下载到 --dir；之后本地加载约 2.5 秒。
"""

import argparse
import json
import os
import sys
import wave

import numpy as np

# 国内直连 huggingface.co 会卡住；模型已缓存时强制离线，绝不在启动时联网。
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')


def read_wav(path):
    with wave.open(path, 'rb') as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError('需要 16k/mono/s16 wav')
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if rate != 16000:
        # 线性插值重采样，够用（我们的录音器固定 16k）
        n = int(round(len(data) * 16000.0 / rate))
        idx = np.linspace(0, len(data) - 1, n)
        data = np.interp(idx, np.arange(len(data)), data).astype(np.float32)
    return data


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', required=True)
    ap.add_argument('--model', default=os.environ.get('SRVPRICE_FW_MODEL', 'base'))
    ap.add_argument('--lang', default='zh')
    ap.add_argument('--dir', default=os.environ.get('SRVPRICE_FW_DIR',
                                                    os.path.join(os.path.expanduser('~'), 'tools', 'fw-models')))
    ap.add_argument('--prompt', default=None)
    ap.add_argument('--hotwords', default=os.environ.get(
        'SRVPRICE_HOTWORDS',
        '服务器,两核,四核,内存,带宽,云服务器,便宜,地域,实例'))
    args = ap.parse_args()

    repo_dir = os.path.join(args.dir, 'models--Systran--faster-whisper-' + args.model)
    if os.path.isdir(repo_dir):
        os.environ['HF_HUB_OFFLINE'] = '1'

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'faster_whisper 未安装：' + str(e)}, ensure_ascii=True))
        return 2

    prompt = args.prompt
    if prompt is None:
        prompt = '以下是简体中文普通话。' if args.lang.startswith('zh') else None

    try:
        audio = read_wav(args.file)
        model = WhisperModel(args.model, device='cpu', compute_type='int8', download_root=args.dir)
        segments, _info = model.transcribe(
            audio,
            language=args.lang,
            initial_prompt=prompt,
            hotwords=args.hotwords,
            beam_size=1,
            vad_filter=True,
            vad_parameters={'min_silence_duration_ms': 400},
            condition_on_previous_text=False
        )
        text = ''.join(s.text for s in segments).strip()
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=True))
        return 2

    print(json.dumps({'ok': True, 'text': text, 'model': args.model}, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
