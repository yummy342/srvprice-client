# 上传前答复（修订版，2026-11-23）

> 本文件按代码实际行为重写；写了"未实现"的就是代码里真的没有。

## Q1 安装：下载后是不是预安装？

不是，也没有 npm 全局安装这条路。

- 前提：Node.js ≥ 18.17。
- **CLI**（包名 `srvprice-cli`，不是 `srvprice`）：
  1. 解压；
  2. `cd srvprice-cli && npm link`（之后可用 `srvprice` 或 `sp`），
  3. 或者不安装，直接 `node bin/srvprice.js --help`。
  - 没有 `npm i -g srvprice` 这条命令；npm 包尚未发布。
  - 两个 `package.json` 已去掉 `private: true`，具备发布条件，但"是否发布到 npm"仍未定。
- **client**：解压 → `npm install`（唯一依赖 `ws`）→ `node bin/srvprice-client.js start --pair`。
- **extension**：Chrome/Edge 扩展管理 → 开发者模式 → 加载已解压的 `extension/`。
- 可选：语音需要 `pip install sounddevice faster-whisper`。

## Q2 什么时候重新下载、怎么重装？

- 触发：版本更新、新增厂商适配、修 bug、换机器、配置损坏。
- 数据目录（重装时保留，不需要先卸载）：
  - client：`%LOCALAPPDATA%\srvprice-client`（`SRVPRICE_CLIENT_HOME` 可覆盖），存 `bridge-token`、`state.json`、`events.jsonl`。
  - CLI：`~/.srvprice`（`SRVPRICE_HOME` 可覆盖），存 `config.json`、`credentials.json`。
- **vault 不在上述目录**：它是独立的 srv-vault 程序，默认路径 `C:\project\srv-vault\srv-vault-bundle\vault-cli.js`，可用 `SRVPRICE_VAULT_CLI` 覆盖。代码里**没有"vault 主密钥"这个概念**，也没有单独的备份流程；换机器时 vault 目录/凭据要另行搬走或重新录入。
- 重装流程：停桥 → 替换程序目录 → `npm install` → `start --pair`；扩展重新加载。

## Q3 新增一个厂商/网站怎么做？

四件套：

1. CLI 适配器（只读列表/状态，写操作被闸门拦住）；
2. `flows/<vendor>.<task>.json`（每步带 `verify` + `fail_when`，人机门标记）；
3. 测试 fixture + 真机只读验证；
4. 凭据：`srvprice vendor add --name <厂商>` → 写入 **`~/.srvprice/credentials.json`**（本地文件，**不是 vault**）。

vault 只在一个可选步骤里用到：`vault-materialize` 把凭据物化给厂商 CLI（`SRVPRICE_VAULT_CLI` 指向 srv-vault）。不配 vault 时，CLI 仍可用 `credentials.json` 里的凭据。

## Q4 extension 首次使用

已实现：

- 弹窗显示桥连接状态；桥启动后自动配对；手动「一键配对」。
- 连不上桥时显示**完整命令**：`node bin/srvprice-client.js start --pair`。
- 未连上桥时显示「下载客户端」链接：`https://www.srvprice.com/download/`。
- 扩展 0.1.24：`debugger` 是可选权限，弹窗有「启用高级操作」按钮，未授权时真实点击/输入会给出明确提示。

未实现：

- 厂商登录/授权的新手向导（登录仍由用户在各厂商控制台完成，扩展只提示状态）。
- 未装 client 时的自动跳转引导（目前只给链接）。

## Q5 client 和 extension 怎么更新

**未实现**（代码里没有）：

- 启动时检查新版本；
- major 版本不一致提示；
- `srvprice update` 命令。

已实现：

- 扩展弹窗显示扩展版本号；
- client 与扩展之间没有版本协商；未知 action 一律拒绝执行。

手动更新方式：替换程序文件 → `npm install` → 重新 `start --pair`；扩展重新加载。

## 中继方案（需 zhao 明确拍板）

方向：client 主动连一个受控中继，muse 通过中继投递任务。三点必须写清：

1. **中继能看到任务原文**（可能含服务器地址、命令）→ 需要最小字段化 + 端到端加密，或每一步在本地再确认；
2. **token 谁签发、谁保管、怎么吊销**——未定；
3. **接通后 muse 不经用户消息即可推送任务**——默认关闭，必须 zhao 明确授权（一次性任务 / 长期开关两种模式）。

## 仍未定

- GitHub 仓库地址与名称；
- npm 是否发布、包名；
- 安装器与更新方式；
- 中继部署位置与鉴权模型。

## 推广码注入（本次新增）

仓库只存占位符，运行时从环境变量注入：

- `YOUR_CPS_KEY` ← `SRVPRICE_TENCENT_CPS_KEY`（腾讯 CPS）
- `YOUR_REFERENCE_ID` ← `SRVPRICE_WEST_REFERENCE_ID`（西部数码推荐/代理 ID）

未注入时链接保持占位，并在 stderr 输出一条 warn；可用 `vault-cli run ...` 提供这两个环境变量。
