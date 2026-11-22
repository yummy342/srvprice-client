# srvprice-client · Muse 宿主适配（第一期骨架）

> 这是宿主侧的**接入说明**，不是 agent 运行逻辑。客户端核心在仓库根目录，浏览器扩展在 `extension/`。

## 一句话触发（确定性路由，2026-11-21）

```bash
node bin/srvprice-client.js say "<用户原话>"        # 返回建议命令（JSON）
node bin/srvprice-client.js say "<用户原话>" --run  # 直接执行建议命令
```

支持：查资源（可按厂商）、建只读账号（需厂商）、开端口（需厂商+端口+来源 IP）、开服务器（需厂商，默认火山）、推广/返佣查询、购买链接、选型推荐。
返回里的 `human_gate`：`none` / `flow`（流程内人机门）/ `payment`（只给链接，不代付款）/ `destroy`（终端二次确认 + 页面最终确认）。
删除类流程必须：`flow run <id> --execute --confirm <实例ID>`（值必须与流程 `confirm_value` 完全一致），且不做自动快照。
路由是规则匹配，不调 LLM；认不出时 `intent=unknown` 并给出示例问法。

## 触发（自然语言优先，不用斜杠命令）

用户说以下意思时调用本客户端：

- “找服务器 / 查一下服务器 / 我该买什么服务器” → `list`
- “我有哪些机器 / 资源列表” → `list`
- “建只读账号 / 配一下火山（阿里/腾讯/百度）的 key” → `flow run <vendor>.create_readonly_user`
- “买服务器 / 看到 9.9 的那台” → 第一期只引导 + 给购买链接，不代下单

斜杠命令只是兜底：`/srvprice`。

## 客户端命令

```bash
node bin/srvprice-client.js status
node bin/srvprice-client.js list --json
node bin/srvprice-client.js flow run volcengine.create_readonly_user --dry-run
node bin/srvprice-client.js flow run aliyun.open_port --var group_name=srvprice-x --var source_cidr=1.2.3.4/32 --dry-run
# run_command 默认不执行；要执行加 --allow-commands；破坏性动词还要 --allow-destructive
node bin/srvprice-client.js record start --id aliyun.open_port   # 开始记录用户操作
node bin/srvprice-client.js record stop                          # 停止
node bin/srvprice-client.js flow save aliyun.open_port --vendor aliyun --success   # 固化成 draft（带成功信号）
node bin/srvprice-client.js flow promote aliyun.open_port --var group_name=... --var source_cidr=... --yes  # 校验后升 active
node bin/srvprice-client.js flow publish aliyun.open_port --account <你的账号标签>  # 投递成功样本到共享库（只存 hash）
node bin/srvprice-client.js flow lib aliyun.open_port   # 看多账号收敛状态
node bin/srvprice-client.js flow pull aliyun.open_port --yes  # 拉取合并结果写回本地
# 远端共享库：设 SRVPRICE_FLOWLIB_URL + SRVPRICE_FLOWLIB_TOKEN 后，publish/lib/pull 自动走远端
# 本机已部署到 https://www.srvprice.com/flowlib，token 在 vault：
#   node vault-cli.js run "FLOWLIB_TOKEN,FLOWLIB_URL" "node bin/srvprice-client.js flow lib"
#   带 {{变量}} 的流程必须先补参：--var k=v（可重复）或 --vars k=v,k2=v2；缺参时 dry-run 会列清单
node bin/srvprice-client.js start --pair      # 起桥并自动打开配对页（无需手输 token）
```

- 所有主机操作**只读**：`SRVPRICE_READONLY=1` 由客户端强制注入；`host start/stop/reboot` 一律拒绝。
- `list` 可能较慢（腾讯 19 个地域约 30 秒）——**每 5 秒给用户播报一次进度**，不要静默等待。

## 语音

- 只有三类会出声：`human`（要人操作）、`done`（关键节点完成）、`fail`（失败）。
- 宿主有语音通道就用宿主的；没有就调 edge-tts 播报（`voice.js`），系统 SAPI 只作兜底。
- **用户说话转文字**：`node bin/srvprice-client.js listen --mic --text`（说一句，静默 2 秒自动收尾；没说话最多等 30 秒）。
  默认 Python 采集 + faster-whisper 转写；`--device N` 换麦克风，`listen --devices` 看设备。
  **与规格 v1.1 的偏差**：规格写的是 whisper.cpp，实际路线已改为 faster-whisper；stream.exe / whisper.cpp 仅作兜底，规格待更新。
  也可以用现成音频文件：`listen --file <wav> --lang zh`。**不要自建 STT。**
- 人机门（登录 / 短信验证码 / 滑块 / 最终确认）必须停下来等，**不代过**。

## 流程执行

1. 先用 `flow run <id> --dry-run` 给出计划（步数、人机门、未物化凭据）。
2. 浏览器扩展连上本地桥（`start` 打印 token，扩展弹窗粘贴）后，才允许 `--execute`。
3. 页面状态只认扩展回传的 `{url, page, step_id, visible_text_hash}`；**不猜页面**。
4. 密钥/验证码/密码永不进对话、不进日志、不进截图；读到后只进 vault。

## 第一期范围

- 七家只读查询（UCloud / 京东 / 天翼 / 火山 / 阿里 / 腾讯 / 百度）
- 凭据引导（四家流程 steps 已落盘，状态 draft）
- 语音提醒 + 人机门
- 流程落盘与校验
- 购买 pipeline、西部数码代理、Claude Code / Codex 宿主 → 第二/三期
