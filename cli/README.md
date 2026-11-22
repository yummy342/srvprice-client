# srvprice CLI

跨厂商服务器**选购比价**与**主机操作**的命令行工具，为 AI agent 设计。

两条线，一套命令：

| 线 | 命令 | 凭据 | 做什么 |
|---|---|---|---|
| 选购线 | `plan` `recommend` `deal` `provider` `buy` `setup` `config` | 无 | 查套餐 / 比价 / 按需求推荐 / 看优惠 / 跳官网购买 / 购后指引 |
| 主机线 | `host` `vendor` | 用户自己的厂商账号 | 经适配层把 `list / status / start / stop / reboot` 转发给厂商官方 CLI |

设计原则来自对 AWS CLI、百炼 CLI 与 19 个同类 CLI 的调研（见 `../srvprice 集成 CLI 调研`）：

- **默认非交互**，交互（`recommend wizard`）只是可选增强
- **非 TTY 时默认输出 JSON**，stdout 只放业务结果，诊断走 stderr
- **退出码固定**：0 成功 / 1 通用失败 / 2 参数错误 / 3 数据过期 / 4 未找到 / 5 凭据缺失 / 6 厂商错误 / 7 写操作未确认 / 130 中断
- **每条价格带 `verified_at` + `source_url`**，拿不到就标未知，不猜价
- **写操作默认确认**，`--dry-run` 先看将执行的厂商命令，`--yes` 必须显式写且不能持久化

## 安装

需要 Node.js ≥ 18.17。零外部依赖。

```bash
cd srvprice-cli
npm link            # 之后可直接用 srvprice 或 sp
# 或者不安装，直接跑：
node bin/srvprice.js --help
```

## 给 agent 的用法

```bash
# 结构化输出（管道下默认就是 JSON，不用加参数）
srvprice plan list --budget-max 200 --region cn
srvprice recommend --use-case blog --budget 150 --explain
srvprice buy url --plan-id aliyun-ecs-e-2c2g-cn
srvprice buy url --provider vultr       # 无套餐数据的厂商：推广入口（DO / Vultr 已核实）

# 首次调用先读契约，别猜
srvprice --introspect
```

解析约定：

- `stdout`：业务结果。`--output json`（或 stdout 不是 TTY）时是**完整可 `JSON.parse` 的单个对象**
- `stderr`：警告与诊断；JSON 模式下是 **JSONL**，每行一个 `{level, message, ...}`，可以直接逐行解析
- 退出码是唯一可靠的失败信号——不要靠 grep 输出判断成败

典型 agent 循环：

```bash
srvprice host list                                  # 拿 <provider>:<instance-id>
srvprice host status --id west:786164               # 单台详情（西部会补一次真实运行状态）
srvprice host snapshots --id west:786164            # 云快照列表（目前仅西部，只读）
srvprice host stop --id aliyun:i-xxx --dry-run      # 预览将执行的厂商命令
srvprice host stop --id aliyun:i-xxx --yes --wait   # 执行并等待到 stopped
```

## 主机线的前提

srvprice **自己没有控制面**。`host start/stop` 能生效，是因为你机器上装好的厂商 CLI 本来就能停——srvprice 只做统一命令、统一输出、统一凭据入口。

先确认装了什么：

```bash
srvprice vendor list
```

| 厂商 | 需要的 CLI | 登录方式 |
|---|---|---|
| 阿里云 | `aliyun`（3.3.0+ 需先 `aliyun plugin install --names ecs`） | `aliyun configure` |
| AWS | `aws` | `aws configure sso` |
| 腾讯云 | `tccli` | `tccli configure` |
| 火山引擎 | `ve` | `ve configure set --profile default --region cn-beijing --access-key … --secret-key …` |
| 百度智能云 | `bce` | `bce configure set` |
| UCloud | `ucloud` | `ucloud config` |
| 京东云 | `jdc` | `jdc configure add --access-key … --secret-key …` |
| 天翼云 | `ctyun-cli` | `ctyun-cli configure`（**只读接入**：写命令未核实） |
| 西部数码 | **无官方 CLI**（适配器直接调 HTTP API v2） | 环境变量 `SRVPRICE_WEST_USER` / `SRVPRICE_WEST_API_PASSWORD`（vault 注入）；需在「API接口配置」把客户端公网 IP 加白名单 |
| DigitalOcean | `doctl` | `doctl auth init` |
| Hetzner | `hcloud` | `hcloud context create` |
| Vultr | `vultr-cli` | `VULTR_API_KEY` 或 `--config` |
| Linode | `linode-cli` | `linode-cli configure` |

未安装的厂商在 `host list` 里会作为**独立错误条目**出现，不会拖垮整表，也不会让「没装」看起来像「没有服务器」。

### 国外五家：安装与只读 key（2026-11-20 实机核对）

五家都在 Windows 11 上实装过；装前对过 SHA256（AWS 官方不公布 MSI 校验和，改验 Authenticode 签名）。

| 厂商 | 安装 | 只读机制 | 凭据 |
|---|---|---|---|
| AWS | 官方 MSI `https://awscli.amazonaws.com/AWSCLIV2.msi`（静默：`msiexec /i … /qn`），装到 `C:\Program Files\Amazon\AWSCLIV2` | 托管策略 `AmazonEC2ReadOnlyAccess`；**没有** Lightsail 版托管策略，Lightsail 只读用自定义 `lightsail:Get*` | `aws configure` / `AWS_PROFILE`；EC2 是地域型，不配地域会报 NoRegion |
| DigitalOcean | `doctl-2.7.0-windows-amd64.zip` 解压 → `%ProgramFiles%\doctl` 并加 PATH | 令牌选 **Read Only**（`api:read`）或自定义 `droplet:read` + 配套 `regions/sizes/actions/image/snapshot:read` | `doctl auth init`；环境变量 `DIGITALOCEAN_ACCESS_TOKEN` |
| Hetzner | `hcloud-windows-amd64.zip` 解压到 PATH 目录 | 令牌只有 **Read** / Read & Write 两档，建 **Read** 即可（结构上开关不了机） | `hcloud context create` 或 `HCLOUD_TOKEN`（无状态，推荐）；地域用 `hcloud location list` |
| Vultr | `vultr-cli_v3.11.0_windows_amd64.zip` 解压到 PATH | **普通 API key 没有只读档**；只读须走 IAM 自定义策略 `compute.instance.List` + `compute.instance.Read`（service account 用户） | `VULTR_API_KEY` 或配置文件 `vultr-cli.yaml` |
| Linode | 无官方 Windows 二进制：`pip3 install linode-cli --upgrade`（需 Python ≥3.9） | 令牌 scope 选 `linodes:read_only`（创建后不可改） | `linode-cli configure --token` 或 `LINODE_CLI_TOKEN` |

- `vendor status` 的凭据探测目前只覆盖国内厂商；国外五家用 `host list` 本身验证——未登录会明确报 `auth_failed`（退出码 5），不会静默当成「没有服务器」。
- **AWS 跨地域**：`host list` 不给 `--region` 时会先取 `describe-regions`（账号已启用的地域），再逐地域并发查实例（并发 6；`SRVPRICE_PROGRESS=1` 时 stderr 输出进度 JSONL）。给了 `--region` 就只查那一个。开关机仍需 `--region`（或 `aws configure` 的默认地域）指向实例所在地域。
- Linode 没 configure 时 CLI 会先起交互向导；srvprice 调用时已关掉 stdin，会直接报「尚未配置」而不是挂住。
- Vultr 的实例动作是 `instance start|stop|restart`（没有 `halt`/`reboot` 子命令），srvprice 已按真机命令树映射。

`vendor add` 存的是**用户自己的厂商 API 密钥**（`~/.srvprice/credentials.json`，0600，永不上传），用于 `vendor status` 体检和将来的直调 API；**主机操作走的是厂商 CLI 自己的登录态**（`ucloud config add` / `aws configure` 等），不是这个文件。

`vendor status` 会顺带探测厂商 CLI 有没有配好凭据（`ucloud config list`、`aliyun configure list`、`ve configure list`、`bce configure list`、`tccli configure list`），输出 `cli_configured`。

### 只读模式（配只读 key 时建议开）

```bash
srvprice config set --key read_only --value true   # 或 SRVPRICE_READONLY=1
```

打开后 `host start/stop/reboot` **无论有没有 `--yes` 一律拒绝**（退出码 2，reason `read_only`），
`host list` / `status` 不受影响。和只读 AK/SK 形成双保险：策略层拦一次，厂商侧再拦一次。

## 数据与新鲜度

`data/*.json` 是从 srvprice.com/servers 各厂商页实读的快照（2026-10-28 / 10-30），每条记录带：

```json
{ "verified_at": "2026-10-30", "source_url": "https://www.srvprice.com/servers/aliyun/" }
```

超过 `stale_hours`（默认 24）时每次查询都会在 stderr 警告。

**`--refresh` 直接读站点公开接口**（数据同源）：

```
srvprice plan list --refresh        # GET /api/server-snapshot → 转换后写入 ~/.srvprice/cache/
```

30 条周快照会被转成 CLI 的 plan 结构（价格、规格、资格都解析；解析不出来的字段留 `null`，不猜）。
`deals` 暂无公开接口，继续用内置快照并在 stderr 说明。
链接来源：`/links.json`（厂商推广入口唯一来源）。

价格口径：

- 首年价、续费价、活动价分字段，不混成一个数字
- `confidence` 标明来源：`page`（活动页原文）/ `calculator`（价格计算器）/ `unverified`
- 新用户专享在 `eligibility` 里单独标出，推荐理由里会明说「已买过该厂商就用不了」

## 安全边界

- **不代下单**：`buy` 只打印 / 打开官方渠道 URL
- **不接管服务器**：`setup` 只给文本指引，从不 SSH、不改你的服务器
- **不收账号密码、不收 SSH 私钥**：只收厂商 API 密钥
- **写操作不静默**：确认前回显厂商 / 实例 / IP / 当前状态；非 TTY 无 `--yes` 一律退出码 7；执行后回读状态，不凭「已受理」报成功

## 已知限制

- 十二个厂商适配器的命令与输出解析以各厂商 CLI 文档与实机 `--help` 为准；测试用桩覆盖 aliyun / 火山引擎 / 百度智能云 / ucloud / 京东云 / 天翼云，其余厂商的字段映射需接入真实账号时以实际输出核对
- 第二批（2026-11-19 安装核对，**2026-11-20 用只读子账号真机接入**）：
  - 火山引擎 `ve` 2.0.2：`ve ecs DescribeInstances --MaxResults/--NextToken`；动作 `StartInstance/StopInstance/RebootInstance --InstanceId`；返回 `Result.Instances[]`；无凭据退出码 1，提示 `credentials not configured…`；官方二进制另带 `ve configure safety-policy preset deny-writes` 只读闸。**不给 `--region` 时先 `ve ecs DescribeRegions` 再逐地域列**（2026-11-20 补，原来只查默认地域会漏机器）
  - 阿里云 `aliyun` 3.5.4：3.3.0+ 需先 `aliyun plugin install --names ecs`；列表用 `NextToken + MaxResults`（PageNumber/PageSize 即将废弃）；无凭据时 **`aliyun configure list` 也返回 ConfigurationError JSON**（退出码 0），适配器按文本识别。⚠️ 仍按配置/`--region` 的**单个地域**查（33 个地域逐个查太慢），别的地域有机器要显式 `--region`
  - 腾讯云 `tccli` 3.1.202.1：**Python 3.12 实测可用**；数组参数 JSON 字符串与 `--cli-unfold-argument` 两种写法都验证可解析；无凭据 `secretId is invalid`（退出码 255）。**不给 `--region` 时先 `tccli cvm DescribeRegions` 再逐地域列**（真机 19 个地域、并发 6，约 30 秒）
  - 百度智能云 `bce` 0.1.148：`bcc ListInstances --region bj|gz|su|bd|hkg --marker/--maxKeys`，返回 `instances[] / isTruncated / nextMarker`；不给 `--region` 时适配器遍历五个 BCC 地域；动作 `--instanceId`（Stop/Reboot 另有 `--forceStop`）；无 `--version`，用 `bce version`；无凭据 `no profile configured`（退出码 1）
  - **西部数码（2026-11-20 接入，只读）**：无官方 CLI，`lib/west.js` 直调 API v2（token=`md5(username+api_password+time)`，返回 GBK）。已接入三个接口：
    - 列表 `GET /server/?act=list` —— 真机字段 `id`（我司编号）/`allocateip`（公网 IP）/`serverroom`（机房 ID，经 `/server/config/?act=base` 解析名称）/`os`/`expdate`；列表**没有运行状态字段，status 留 null**
    - 详情/状态 `host status` → `GET /server/manager/?act=info` + `GET /server/system/?act=status`（状态码 0 正常 / 1 关机 / 2 管理员关机 / 3 暂停）
    - 快照 `host snapshots` → `GET /server/hostsnap/?act=list`（类型 0 普通 / 1 高级 / 2 自定义、周期、剩余月、系统盘/数据盘快照）
    - 写操作在适配器层直接拒绝。⚠️ 西部按**客户端公网 IP 白名单**放行，家里动态 IP 变了要重新加。凭据走 vault：`WEST_USERNAME` / `WEST_API_PASSWORD`（也认 `SRVPRICE_WEST_*`）。
  - 只读接入实测（2026-11-20）：火山 0 台；腾讯 19 地域 0 台；百度 5 地域 0 台；阿里云 2 台
- UCloud 已**真机跑通**（v0.3.10，只读子账号）：
  - `uhost list` 默认只看 profile/region，**必须加 `--all-region`（或 `--region`）**，否则会漏掉别的地域（165 在 `sg-02` 就是这么漏掉的）
  - 返回字段是 `ResourceID` / `UHostName` / `State` / `Zone` / `PublicIP` / `Type`，不是 API 文档里的 `UHostId` / `Name`
  - 子账号策略常是**项目级**：不带 `--project-id` 直接 `RetCode 299`；适配器用 `ucloud project list` 自动取默认项目
  - 云主机（uhost）与轻量（ulhost）是**两条独立策略**，适配器两个都列
  - 未配置凭据 / 权限不足时**退出码都是 0**，适配器按输出文本区分 `auth_failed` / `permission_denied`
- 京东云已**真机跑通到凭据层**（jdcloud-cli 1.2.12）：
  - 包不支持 Python 3.12（`SafeConfigParser`、`imp` 都已移除）→ 装在隔离的 Python 3.11（`~/tools/py311`），`Scripts` 目录已加入用户 PATH
  - `--output` 是**全局参数**，必须放在子命令前：`jdc --output json vm describe-instances`
  - 动作参数是 `--instance-id`（带连字符），命令是单数 `start-instance` / `stop-instance` / `reboot-instance`
  - 未配置凭据时**退出码也是 0**，只打印 `Please use jdc configure add…`，适配器识别为 `auth_failed`
- 天翼云已装官方 `ctyun-cli` 0.4.0（`~/.ctyun-cli/bin`，已加入 PATH，zip 与内置 checksums 校验通过），**已真机跑通**：
  - 命令是 API 式 PascalCase：`ecs ListEcsInstances` / `StartEcsInstance` / `StopEcsInstance` / `RebootEcsInstance`
  - 参数是 `--instanceID` / `--regionID`（**列表也必填 regionID**），全局 `-o/--output json`（默认已是 json）
  - 没给 `--region` 时用 `common ListRegions` 自动遍历全部资源池（并发 6；27 个池约 1 分钟）
  - 海外/非大陆公有云资源池会报「仅支持中国大陆公有云资源池」——跳过，不算失败
  - 列表返回是 `returnObj.results`（不是 `instances`）
  - 未配置凭据时中文报错、退出码 1，适配器识别为 `auth_failed`
- 选购线数据是快照，不是实时接口
- 单文件静态二进制（Go/Rust）本轮未做——本机 Rust 工具链缺 `dlltool.exe`，Node 无此问题

## 开发

```bash
npm test        # 105 个用例：退出码、JSON 契约、护栏、适配器解析、凭据脱敏
```

目录：

```
bin/srvprice.js     命令分发与实现
lib/core.js         参数解析 / 输出契约 / 配置与凭据 / 数据装载
lib/host.js         厂商适配器 + 主机操作
data/*.json         选购数据快照
test/               测试与厂商 CLI 测试桩
```
