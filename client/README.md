# srvprice 客户端 · 第一期骨架

语音 + 网页控制客户端。规格见仓库内 `docs/spec-v1.1-20261120.md`（v1.1）。

第一期范围：**Muse 宿主 + 七家服务器只读查询 + 凭据引导 + 语音提醒 + 流程落盘**。
本仓库只搭骨架：桥、流程校验、只读查询、扩展骨架、语音降级、宿主接入说明；真正的浏览器执行与 vault 物化在后续版本补齐。

## 组成

```
bin/srvprice-client.js   本地客户端 CLI（start / list / flows / flow run / voice）
lib/config.js            路径、端口、桥 token（每次安装生成一次）
lib/bridge.js            127.0.0.1 WebSocket 桥：token + chrome-extension:// 来源校验
lib/inventory.js         只读查询 srvprice CLI（强制 SRVPRICE_READONLY=1）
lib/flows.js             流程加载 / 校验 / 计划 / 骨架执行器（人机门停下）
lib/voice.js             edge-tts 播报（SAPI 兜底）；只在 human/done/fail 出声
lib/recorder.js          麦克风录音（Python sounddevice + VAD）+ faster-whisper 转写（whisper.cpp 兜底）
lib/stt.js               whisper.cpp 音频文件 → 文本
lib/state.js             运行状态 + 事件日志（敏感字段脱敏）
flows/                   机器可执行 steps 流程库（四家建只读账号，draft）
extension/               Chrome/Edge MV3 扩展骨架（状态回传 + 动作执行）
hosts/muse/SKILL.md      Muse 宿主接入说明（触发词 / 命令 / 语音 / 人机门）
```

## 快速开始

```bash
cd C:\project\srvprice-client
npm install                     # 只有 ws 一个依赖
pip install sounddevice faster-whisper   # 语音输入需要（可选）
node bin/srvprice-client.js start        # 打印配对页；加 --pair 自动打开
# → 配对页：http://127.0.0.1:8790/pair   （在浏览器打开即自动配对，不用手输 token）

node bin/srvprice-client.js list --json      # 七家只读资源
node bin/srvprice-client.js prices           # 网站周快照（优惠价，标出本周未复核的）
node bin/srvprice-client.js compare x.com    # 域名各渠道首年/续费比价
node bin/srvprice-client.js purchase list    # 可买套餐（30 条快照）
node bin/srvprice-client.js purchase show ali-ecs99
node bin/srvprice-client.js purchase open ali-ecs99 --yes   # 打开厂商官网（付款人工）
node bin/srvprice-client.js purchase done ali-ecs99         # 买完对差集，确认新机器进列表
node bin/srvprice-client.js flows            # 流程库校验
node bin/srvprice-client.js flow run volcengine.create_readonly_user --dry-run
node bin/selftest.js                         # 桥协议自测（另开一个终端；模拟扩展握手）
```

装扩展：Chrome/Edge → 扩展管理 → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`。
配对：扩展弹窗点「打开配对页」（或直接打开 `http://127.0.0.1:8790/pair`），页面会显示「✅ 配对成功」；
弹窗状态每 1.5 秒刷新，显示「● 已连接本地桥」即完成。**不需要复制 token**。

## 硬规则（与规格一致）

- **只读**：`list` 永远注入 `SRVPRICE_READONLY=1`；`host start/stop/reboot` 由 CLI 和厂商只读 AK 双保险拦住。
- **桥只绑 127.0.0.1**：token 每次安装生成；只接受 `chrome-extension://<id>` 来源。
- **状态回传白名单**：`{url, page, step_id, visible_text_hash}`；密钥/验证码/密码字段永不回传、不写日志。
- **人机门**：登录、短信码、滑块、最终确认必须停；骨架执行器遇到 `human` / `sensitive` 立即返回 `human_gate`。
- **语音**：只播报 `human` / `done` / `fail`；宿主有语音用宿主的，没有走系统 TTS，不自建 STT。
- **流程**：文本/可访问性树匹配，不用 CSS；每步必须有 `verify` + `fail_when`；找不到就停。

## 模型厂商（phase 3，BYOK，第一期骨架）

规格：`Downloads\srvprice-model-vendors-spec-20261120.md`（官方页直读，2026-11-20）。
目录：`data/model-vendors.json` —— **12 家已核实**（百炼、方舟、Kimi、智谱、DeepSeek、MiniMax、阶跃、混元、Gemini、Groq、OpenRouter、Mistral），**3 家 UNVERIFIED 只登记不接入**（百川、千帆、TokenHub）。

```bash
node bin/srvprice-client.js model vendors          # 已核实的 12 家
node bin/srvprice-client.js model vendors --all    # 含 UNVERIFIED（只登记）
node bin/srvprice-client.js model get --id volcengine-ark
SRVPRICE_MODEL_KEY=<key> node bin/srvprice-client.js model key set --id deepseek
node bin/srvprice-client.js model key status --id deepseek
```

硬规则：

- **key 只进 vault**（条目 `MODEL_<VENDOR>_KEY`，env 别名用厂商标准名）；key 只从 `SRVPRICE_MODEL_KEY` 或 stdin 读，**不接受命令行参数**；输出只显示前缀＋长度。
- 保存前先做最小验证（GET `{base_url}/models`），失败当场报错、不存坏 key。
- **不内置价格**：目录里没有价格字段，只维护接入事实；定价展示方式待定（规格 §8 #7）。
- 特殊形态已编码：百炼 `{WorkspaceId}.{region}` 模板（缺 WorkspaceId 不猜）、方舟三套地址按 key 类型选（Agent Plan 明确不支持 OpenAI 形态）、DeepSeek base_url 不带 `/v1`、MiniMax 不发 `temperature`/`top_p`。

## vault 物化（vault 是唯一真源）

厂商 CLI 的配置只是物化缓存，凭据**不经过客户端进程**：

```bash
node bin/srvprice-client.js vault-status --vendor baidu --profile muse-readonly-demo
node bin/srvprice-client.js vault-materialize --vendor baidu --profile muse-readonly-demo --region bj
node bin/srvprice-client.js vault-materialize --vendor volcengine --profile muse-readonly-test --region cn-beijing
node bin/srvprice-client.js vault-purge --vendor baidu     # 只给清理指引
```

- 条目约定：`<VENDOR>_<PROFILE大写/非字母数字转_>_AK` / `_SK`（如 `BAIDU_MUSE_READONLY_DEMO_AK`）
- 原理：`vault-cli run <AK,SK> "node lib/materialize-run.js <vendor> <profile> <region>"`
  —— 两个条目同时注入 env，helper 再用它们执行厂商 `configure set`；客户端只看到退出码
- 轮换：在 vault 更新条目后重跑 `vault-materialize` 即可
- 已验证：火山 `muse-readonly-test`、百度 `muse-readonly-demo`、阿里云 `muse-readonly-demo`、腾讯 `muse-readonly-demo2`
- **西部数码（无 CLI）**：物化=用 vault 注入的 `WEST_USERNAME` / `WEST_API_PASSWORD` 跑一次只读 `host list` 验证链路：
  `node bin/srvprice-client.js vault-materialize --vendor west`（返回 servers 数量）
- 通用：`vault-run --items A,B --cmd "<命令>"` 用 vault 注入的凭据执行任意命令

## 语音（edge-tts 播报 + Python 录音 + faster-whisper 转写）

- **播报**：`voice "<text>"` → edge-tts（本机已装 7.3.1；系统 SAPI 0 语音包，只作兜底）。edge-tts 旧版会 403，升级到最新即可。
- **采集（默认 Python）**：`tools/recorder_vad.py`（`pip install sounddevice`）抓默认麦克风。
  - 等开口（连续 2 块超阈值才算），说完静默 2 秒自动停；裁掉首尾静音；麦克风偏小时自动增益（最多 10 倍）。
  - 优点：整段录完一次性转写，**没有滑动窗口丢词问题**；调试时能直接看到峰值/底噪。
- **转写（默认 faster-whisper）**：CPU int8 `base` 模型 + 领域热词（服务器/两核/四核/内存/带宽/云服务器/便宜…），
  3–5 秒音频约 2–4 秒出结果（含模型加载）。模型缓存在 `~/tools/fw-models`，已缓存时强制离线，不联网。
- **兜底**：whisper.cpp（`~/tools/whisper-cpp/main.exe` + `ggml-base.bin`）；`--backend stream` 走 `stream.exe` 滑动窗口（旧路径）。

```bash
pip install sounddevice faster-whisper          # 一次性
node bin/srvprice-client.js listen --check      # 采集/转写后端、模型、设备
node bin/srvprice-client.js listen --devices    # 列麦克风（默认设备打 default）
node bin/srvprice-client.js listen --mic --text # 说一句话 → 文本
node bin/srvprice-client.js listen --mic --text --device 5 --debug   # 换麦克风 + 看快照/电平
node bin/srvprice-client.js listen --mic --text --model small        # 更准但慢一倍
node bin/srvprice-client.js listen --file <16k-mono.wav> --lang zh   # 现成音频（走 whisper.cpp）
```

- 配置：`%LOCALAPPDATA%\srvprice-client\stt.json`（非密钥）；`SRVPRICE_PYTHON` / `SRVPRICE_FW_MODEL` / `SRVPRICE_HOTWORDS` / `SRVPRICE_WHISPER_CLI|MODEL|STREAM` 可覆盖。
- 踩过的坑：
  - **stream.exe 的 `-sa` wav 不能用**：它把约 10 秒滑动窗口重复追加（实测 6 秒运行 = 30 秒音频），转写会幻听复读。
  - whisper.cpp `main.exe` 对短音频也要编码 30 秒窗口（实测 2.5 秒音频编码 5.2 秒），所以改用 faster-whisper。
  - 本机曾因**系统扬声器音量为 0**导致「放音给麦克风」的测试全部是静音，排查时先看音量。
  - 中文默认输出可能是繁体，`initial_prompt` 加「以下是简体中文普通话。」可固定简体。

## 命令

| 命令 | 说明 |
|---|---|
| `start [--port 8790]` | 起本地桥（常驻） |
| `status` | token / 端口 / 流程库概览 |
| `token [--show]` | 查看桥 token（默认打码） |
| `list [--provider X] [--json]` | 只读列出资源 |
| `flows` | 校验流程库，任何错误退出码 1 |
| `flow run <id> [--dry-run]` | 默认 dry-run 出计划；`--execute` 需要扩展已连接 |
| `voice "<text>"` | edge-tts 播报测试（`--check` 看语音栈） |
| `listen --mic [--text]` | 麦克风录音 + whisper 识别（说一句自动停） |
| `listen --devices` | 列麦克风 |
| `listen --file <wav>` | 现成音频文件 → 文本 |

## 测试

```bash
npm test
```

共 71 个用例。**71/71 是 2026-11-23 在 Windows 机器上实测的结果**；Linux/macOS 上 recorder 相关用例通过注入 `_spawn` 运行，不依赖本机存在 `stream.exe`。

覆盖：流程 schema / 真实密钥形状拦截 / 人机门停止 / 桥 token 与来源校验 / state 白名单 / exec 回包 / 只读环境变量注入 / 语音静默规则 / 录音快照解析 / 幻听过滤 / wav 头修补 / 静默自动停。

## 下一步（第二期）

- 扩展动作的真实控制台校准（flows 从 `draft` 升 `active`）
- 语音输入接入宿主对话循环（Muse 宿主语音验证；唤醒词/按住说话）
- `run_command` 受控执行器（凭据只经 stdin/env 注入）
- 购买 pipeline（选机 → 确认 → 付款 → 接进列表）
