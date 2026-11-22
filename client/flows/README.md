# srvprice 客户端流程库 · 第一批（草稿）

对应规格 `voice-webcontrol-client-spec-20261120.md` §5.1。这些是**机器可执行的 steps JSON**，不是给人看的说明书。

## 文件

| 文件 | 流程 |
|---|---|
| `volcengine.create_readonly_user.json` | 火山引擎：建只读子账号 + 配 `ve` |
| `aliyun.create_readonly_user.json` | 阿里云：建只读子账号 + 配 `aliyun` |
| `tencent.create_readonly_user.json` | 腾讯云：建只读子账号 + 配 `tccli` |
| `baidu.create_readonly_user.json` | 百度智能云：建只读子账号 + 配 `bce` |

来源：2026-11-20 首次人工跑通记录（zhao 操作控制台，cc 配置 CLI 并验证）。
**状态一律 `draft`**：控制台的真实按钮文案 / 角色名 / 页面结构尚未上机逐一校准，校准时只改 `version` 加一并记录 diff。

## 字段约定

- `id` / `version` / `status` / `vendor` / `title` / `entry`
- `steps[].step_id`：稳定标识，改版时保持
- `do`：要做的事（`open` / `click` / `fill_form` / `attach_policy` / `read_fields` / `run_command` / `navigate`）
- `verify`：**怎么算这一步成功**（文本出现、JSON 字段存在、Secret 只显示一次等）
- `fail_when`：**什么情况直接停**（无权限、策略不存在、Forbidden 等）
- `human`：是否必须停下等人（登录、短信码、最终确认）
- `sensitive`：这一步涉及密钥/密码/验证码——**永不进回传、日志、截图**

## 匹配规则（硬性）

1. 只用**文本 / 可访问性树**（role + name + 文本）匹配，**不用 CSS 选择器**。
2. 每步必须有 `verify` 和 `fail_when`。
3. 某步找不到就停，语音告诉用户，不硬猜、不跳过。
4. 页面改版导致某步失效时：回退到搜索，找到后更新步骤并 `version + 1`。

## 占位符

- `{{region}}`：本次操作的默认地域（如 `cn-beijing` / `ap-guangzhou` / `bj`）
- `{{credential.access_key_id}}` / `{{credential.secret_access_key}}` 等：**运行时从 vault 物化**，steps 文件里永远不出现真实密钥
- 业务代码不得把替换后的值写回 steps 文件、日志或 stderr

## 安全要求（摘自规格 §7.4 / §7.5）

- 状态回传只允许 `{url, page, step_id, visible_text_hash}`。
- 密钥框、验证码、密码字段：页面侧黑名单 + 客户端侧二次过滤。
- 浏览器扩展 ↔ 客户端：本地 WebSocket 只绑 `127.0.0.1`，每次安装独立 token，校验 `chrome-extension://<id>` 来源。

## 待补

- 新增流程模板：买机（选机 → 确认 → 付款）、查实例、CLI 安装。
- 真实控制台校准记录（改 version 时写在 `notes`）。
- steps 的版本化与分发方式（规格 §12.3 待决）。
