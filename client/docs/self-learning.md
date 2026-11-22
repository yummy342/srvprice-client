# 自学习：成功操作自动固化（设计草案 v1，2026-11-21）

目标：任何一次被验证成功的操作，都能自动变成可重放的 `flows/<vendor>.<task>.json`；
多次、多人成功后，自动收敛成共享流程库，而不是每次都从零点。

## 1. 记录什么

扩展在**记录模式**下只记语义动作，不记坐标、不记明文：

| 记录项 | 例子 |
|---|---|
| 页面 | `{url, title}` |
| 动作 | `click / fill_form / check_row / select / press_key` |
| 目标描述 | `{text:"增加规则", role:"button"}`、`{id_hint:"SecurityGroupName"}`、`{near_text:"访问来源"}` |
| 输入值 | 参数化后的变量（`{{source_cidr}}`），或脱敏标记 |
| 成功信号 | 点击后出现的文本/URL（`访问规则（1`、`安全组创建成功`） |

**硬规则**
- 密码/验证码/AccessKey/Secret 一律不记录，遇到敏感输入框直接终止记录。
- 坐标只作为兜底备注，不作为主匹配（今天 `type_at` 就是因为坐标不稳才补了语义动作）。
- 登录、短信、滑块、付款四类人为门只记“停下”，不记操作。

## 2. 什么时候算“成功”（固化闸门）

一次操作只在满足下面全部条件时升级为 `active`：

1. 用户显式点“本次成功”（或识别到成功提示，如 `创建成功`、`访问规则（1 条）`）；
2. 最后一步有可重放的 verify 文本；
3. 复盘时没有命中 fail_when、没有走人工补救；
4. 不包含任何敏感输入。

否则落成 `draft`，只进本机库，不进共享库。

## 3. 从一次操作到一条流程

```
记录片段 → 归一化（合并连续输入/滚动）→ 参数化（IP/端口/名称 → 变量）
        → 生成 steps[] → 本机 flows/<id>.json（draft）
        → 本地重放一次成功 → active
```

参数化规则：
- 与本次目标强相关的值（组名、CIDR、端口）→ `{{group_name}} {{source_cidr}} {{port}}`；
- 账号/地域从上下文取，不写死；
- 模板步骤（如阿里默认 5 条规则）标成“模板校验步骤”，模板变化即失败，触发重新校准。

## 4. 多用户共享与收敛

流程库按 `vendor + task` 建键，例如 `aliyun.open_port`。

收敛策略：
- 同一步在多个成功样本里 `action + matcher` 一致 → 提为公共步骤；
- 匹配器出现分叉 → 生成多个候选（如 `text` 与 `id_hint`），回放时按命中率排序；
- 每次失败上报（vendor、step_id、页面片段哈希、错误）→ 自动降低该步骤置信度，连续失败 2 次转 `draft` 并挂起共享；
- 版本：任何步骤变更 `version + 1`，旧版本保留 N 个版本用于回滚。

推广门槛（建议）：`≥3 个不同账号成功` 才标 `shared`；单人多次成功最多标 `verified`。

## 5. 与现有执行器的接法

- 现在：`runFlow` 自动执行 + 人机门停下 + `verifyTab` 轮询。
- 新增：
  - `flow record start|stop <vendor>.<task>`：开关记录；
  - `flow save <vendor>.<task>`：从记录生成 draft；
  - `flow promote <id>`：本地重放通过后升 active；
  - 失败上报：`runFlow` 在 step_failed 时自动写一条 `flow_events` 记录。
- 扩展侧需要新消息：`record_start` / `record_stop` / `record_event`（后台转发给桥），只发语义字段。

## 6. 隐私与边界

- 记录默认只在本机，不进共享库；用户可一键删除。
- 共享库只存步骤与匹配器，不含 URL 查询参数里的 token、不含任何输入值。
- “所有用户成功就固化”= 共享库的收敛，不等于自动替用户执行写操作；执行仍需 `--yes`，四类人机门永不自动。

## 7. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 记录模式 + `flow save`（draft） | 今天这条阿里开端口能被记录并生成 JSON |
| P2 | 成功闸门 + 本地重放升 active | 同一环境重放一次通过 |
| P3 | 失败上报与自动降级 | 故意改页面结构，流程自动转 draft |
| P4 | 共享库与多账号收敛 | ≥3 账号成功 → shared |

## 8. P1 落地记录（2026-11-21）

已实现：
- 扩展 content.js：`srvprice:record-start/stop` 消息开关记录；捕获 click / change（fill_form），只记语义 match + 页面标题/URL；密码、验证码、密钥类输入直接跳过。
- 扩展 background.js：转发 `record_event` 到桥；`recordBroadcast` 给所有 http 页面发开关消息。
- 桥：`/record/start`、`/record/stop`、`/record/status`（带 token），事件上限 300。
- CLI：`record start|stop|status`、`flow save <vendor.task>`（生成 draft，verify 用页面标题占位）。
- 测试：42 全过；真机闭环验证（阿里页面录 2 条 → 生成 2 步 draft → 测试文件已删除）。

已知限制：
- **CDP 合成点击（real_click / click_at）不会被 content script 的 DOM click 监听捕获**；真人点击、`el.click()` 注入点击可以。→ 记录模式面向“人在页面操作”，不是回放自身。
- 记录值未参数化（P2 做）；verify 是页面标题占位，必须人工校准后才能升 active。
- 只覆盖 click / change；下拉选择、hover、键盘操作暂未记录。

## 9. P2 落地记录（2026-11-21）

- **记录值参数化**：`srvprice-*` → `{{group_name}}`；IPv4/CIDR → `{{source_cidr}}` 或 `{{ip}}`（看字段提示是否含 source/来源/IP）；端口字段的数字 → `{{port}}`。其余值保持字面量（避免误伤业务数据）。
- **成功闸门**：`flow save --success` 写入 `meta.recorded_success`；`flow promote <id> --yes` 要求有成功信号 + 变量齐全 + 计划无未替换占位符，才把 draft 升 active。
- 演练：录 1 条点击 → save --success → promote 升 active；反向用例（无成功信号）被拒。
- 测试：44 全过。
- 已知限制：搜索框等组件的 change 不一定触发，填表记录可能漏；参数化只覆盖三类高置信模式。

## 10. P3 落地记录（2026-11-21）

- `runFlow` 在非人机门失败时发 `step_failed` 事件（写进事件日志）。
- 健康度 `lib/flowhealth.js`：按 `flow id + version` 记 `failures/successes`；成功清零；版本变更重置；连续 **2** 次失败触发降级。
- `flow run --execute` 结束后自动记账：失败且命中阈值 → 把对应 active 流程改回 **draft**，在 notes 写明次数与原因，并在响应里返回 `downgraded`。
- 人机门（human_gate）不算失败，不计数。
- CLI：`flow health [id]`、`flow reset-health <id>`。
- 真机验证：故意造一条必失败流程，跑两次 → 第二次返回 `downgraded`，文件状态变 draft。
- 测试：45 全过。

## 11. P4 落地记录（2026-11-21）

- 共享库 `lib/flowlib.js`：本机 `appDir/flowlib.json`，按 flow id 收样本；**只存账号 hash**，样本不含输入值（值已参数化）。
- CLI：
  - `flow publish <id> --account <标签>`：把本机流程作为成功样本投递（同账号覆盖）
  - `flow lib [id]`：看账号数 / 样本数 / 收敛状态
  - `flow pull <id> --yes`：合并后写回 `flows/<id>.json`
- 收敛：按步序取多数 `do`；verify 取多数文本；`variables` 取并集；**≥3 个不同账号 → shared**，1~2 个 → verified。
- 状态映射：流程文件的 `status` 只认 draft/active/deprecated，`shared` 映射为 **active**，真实收敛状态写在 `meta.lib_status`。
- 验证：3 个账号 → shared → pull 写回 active；测试 46 全过。

## 12. run_command 执行器（2026-11-21）

- 位置：`lib/command.js`；`runFlow` 通过可选 `runCommand` 注入，CLI 只有加 `--allow-commands` 才启用。
- 安全约束：
  - **不开 shell**：命令里出现 `; & | ` $ > <` 换行 一律拒绝；
  - **二进制白名单**：ve/aliyun/tccli/bce/ucloud/jdc/ctyuncli/doctl/hcloud/vultr/linode-cli/aws/srvprice；
  - **破坏性动词**（delete/destroy/terminate/stop/reboot 等）默认拒绝，需 `--allow-destructive`；
  - **不处理密钥**：命令里仍有 `{{...}}` 直接判未解析，不在这里拼明文；火山 configure_cli 改为人机门，继续走 vault-materialize。
- 默认行为不变：没有 `--allow-commands` 时仍返回 `command_runner_not_implemented`。
- 验证：`ve --version` 执行成功；`DeleteInstance` 被拒；无 flag 被拒。测试 51 全过。
- 限制：**注册表是本机文件，不是服务端**；跨机器共享需要把存储换成远端（接口已按 `load/save` 隔离，替换点明确）。合并结果仍建议先 `--dry-run` 再执行。

### 4.1 远端模式（2026-11-21 已实现）

- 设置 `SRVPRICE_FLOWLIB_URL` + `SRVPRICE_FLOWLIB_TOKEN` 即走远端，否则落本机文件。
- 参考服务端：`tools/flowlib-server.js`（零依赖，文件持久化，Bearer token）：
  ```
  FLOWLIB_TOKEN=xxx FLOWLIB_DATA=/var/lib/flowlib.json PORT=8080 node tools/flowlib-server.js
  ```
- 协议：`GET /health`、`GET /lib`、`GET /lib/:id`、`POST /lib/:id/samples`（按 account_hash 覆盖）。
- 客户端只上传样本（账号 hash + 参数化后的步骤），合并仍在本机做。
- 测试：本机库与远端模式各一组（含 401 鉴权失败）；当前全量为 54（§4.2 后新增用例）。
- 部署状态：已有一个远端部署在运行；**具体主机、端口、systemd 单元、证书与 SSH 细节属于内部运维信息，不随仓库发布**。

### 4.2 远端部署（内部）

- 远端 flow lib 的部署方式、主机代号、监听端口、token 文件路径、nginx 配置与 SSH 访问方式全部不写进本仓库。
- 对外只需要知道接口约定：设置 `SRVPRICE_FLOWLIB_URL` + `SRVPRICE_FLOWLIB_TOKEN` 后，`flow lib` / `flow pull` / `flow publish` 会走远端；未设置时落本机文件。
- 凭据一律从 vault 注入（`FLOWLIB_TOKEN`→`SRVPRICE_FLOWLIB_TOKEN`，`FLOWLIB_URL`→`SRVPRICE_FLOWLIB_URL`），仓库里不出现 URL 或 token。
