# AGENTS.md — 给 agent 的使用说明

这个仓库提供一个 CLI：`srvprice`（别名 `sp`）。你（agent）调它，不要直接读 `data/*.json` 或自己拼价格。

## 三条铁律

1. **先 `srvprice --introspect`**，拿到命令树、选项与退出码，再决定怎么调。不要猜命令名。
2. **只信退出码，不信输出文本**。失败时读 stderr（JSON 模式下为 JSONL）。
3. **写操作必须先 `--dry-run`**，把将执行的厂商命令与目标状态展示给用户；征得同意后再 `--yes`。

## 输出契约

- stdout 只有业务结果。管道/非 TTY 下默认 `--output json`，可整体 `JSON.parse`。
- stderr 是诊断。JSON 模式下每行一个 `{level, message, ...}`。
- 退出码：`0` 成功 / `1` 通用失败 / `2` 参数错误 / `3` 数据过期 / `4` 未找到 / `5` 凭据缺失或厂商 CLI 未装 / `6` 厂商错误 / `7` 写操作未确认 / `130` 中断。
- `5` 的错误里带 `reason`：`cli_missing` 表示厂商 CLI 没装，`auth_failed` 表示登录失效——这两种要转述给用户，不要自行重试。
- `7` 不是错误，是护栏：你要么补 `--yes`（用户已同意时），要么把确认问题交回用户。

## 常用调用

选购（只读，无凭据）：

```bash
srvprice plan list --budget-max <元> --region cn|hk|overseas --new-user-only --refresh
srvprice plan get --id <plan-id>
srvprice plan compare --id <a> --id <b>
srvprice recommend --use-case blog|app|game|ai --budget <元> --region <r> --explain
srvprice deal list --provider <厂商> --ends-before 2026-12-31
srvprice provider get --name <厂商>
srvprice promo list --line affiliate|agent --status ready|apply|none|unknown
srvprice promo get --name <厂商>              # 变现线详情 + 待办 + 未核实项
srvprice promo actions                        # 汇总待办，与 providers.json 链接对账
srvprice promo sync --local-only              # 本地对账；不加 --local-only 会先试站点 /api/promos
srvprice promo link show --name <厂商>        # 当前链接与来源（cache/bundled）
srvprice promo link set --name <厂商> --url <https://...> [--key <子键>]   # 默认写本机缓存
srvprice promo link unset --name <厂商>       # 回滚本机覆盖
srvprice buy url --plan-id <plan-id>          # 只打印链接，不打开浏览器
srvprice buy url --provider vultr|digitalocean # 无套餐数据的厂商：打印推广入口（带归因说明）
srvprice setup show open-port|ssh-key|swap|docker-install|icp-filing
```

主机（需要用户自己的厂商 CLI 已安装并登录）：

```bash
srvprice vendor list                          # 先看哪家能用
srvprice host list                            # 跨厂商；失败厂商单列在 errors[]
srvprice host status --id <provider>:<instance-id>
srvprice host stop --id <id> --dry-run
srvprice host stop --id <id> --yes --wait     # --wait 轮询到目标状态
srvprice host open-port --ip <公网IP> --port 3389 --source <你的IP>          # 默认只出计划（west）
srvprice host open-port --ip <公网IP> --port 3389 --source <你的IP> --deploy --yes  # west 真部署安全组
srvprice host open-port --provider aliyun|tencent|volcengine|baidu|jdcloud|ctyun|ucloud --region <r> --ip <IP> --port 3389 --source <你的IP>  # 只新建专用组+规则，不绑定实例
```

## 解读结果时

- **每个价格都带 `verified_at` 和 `source_url`**。把它们一起转述给用户，不要只报数字。
- `confidence: "calculator"` 表示计算器读数、`"page"` 表示活动页原文；引用时说明。
- `eligibility: "new_user"` 表示新用户专享——用户若已在该厂商买过服务，这个价拿不到。
- `price.renew` 是续费口径。**不要把首年价说成年成本**；写「续费待核 / 回归原价」时要明说。
- 数据过期警告出现在 stderr，说明快照超过 24 小时；`--refresh` 会重新拉 `/api/server-snapshot`，照常返回结果，但要提示用户下单前核对官网。
- 天翼云只接了读（`host list` / `status`），写操作会明确报「命令未核实」并退出码 2——不要重试，转告用户去看 `ctyuncli ecs help`。
- `host list` 的 `errors[]` 非空不代表整体失败：某厂商未接入 / 未登录时该段跳过，其余照常返回。

## 不要做

- `host open-port` 只支持西部数码，且只接受「来源限 IP」；`--source 0.0.0.0` 必须显式加 `--yes`。首次 `--deploy` 会让安全组接管出入站，部署前必须确认 22/25 等现网端口已放通。
- 不要替用户下单或付款。`buy` 只给链接；链接含推荐归因，**必须让用户自己从链接进官网买**（API 下单带不上归因，也不要在 API 调用里埋链）。
- 转述优惠时只用 `promo_note` 里的已核实口径，不要补充未核实的数字。
- `promo` 的变现线：`verified=false` 的行（文本里带 `*`）数字一律是 UNVERIFIED，不能当已核实口径转述；`status: apply` 只表示「有路可申请」，不代表已具备资格。
- `promo link set` 只放**客户侧推广链接**。代理商/合作伙伴的注册入口不是客户购买链接，不要写进 providers.json。链接必须是 https 且在该厂商允许域内。
- 不要在命令行参数里传密钥（会被拒绝）。让用户自己跑 `srvprice vendor add --name <厂商>`，或用环境变量。
- 不要对用户服务器执行 `setup` 里的示例命令——那是指引，由用户自己跑。
- 不要假设 `host stop` 立即生效；需要确定结果就加 `--wait` 或 `srvprice host wait`。
