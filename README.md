# srvprice-client

srvprice 的 agent 工具集，两个包放在同一个仓库：

| 目录 | 内容 | 许可 |
|---|---|---|
| [`client/`](client/) | agent 宿主客户端 + 浏览器扩展 + 本地桥（127.0.0.1:8790）+ 流程库 | MIT |
| [`cli/`](cli/) | 跨厂商服务器 CLI：选购比价、只读资源、开关机、流程执行 | MIT |

## 快速开始

**CLI**（Node ≥ 18.17，包名 `srvprice-cli`）：

```bash
cd cli
npm link                 # 之后可用 srvprice / sp
# 或者不安装：node bin/srvprice.js --help
```

**client**：

```bash
cd client
npm install              # 唯一依赖 ws
node bin/srvprice-client.js start --pair
```

**浏览器扩展**：Chrome/Edge → 扩展管理 → 开发者模式 → 加载已解压的 `client/extension/`。

一句话调用（意图路由，不调 LLM）：

```bash
node client/bin/srvprice-client.js say "查一下服务器"
node client/bin/srvprice-client.js say "查一下服务器" --run
```

## 状态与边界

- 服务器只读查询已接国内 8 家 + 国外 5 家；写操作默认需要显式确认。
- 登录、短信验证码、人脸、付款四类人工关口永远停住，由用户自己完成。
- 价格带来源与日期；未复核的条目会标注，不以旧价充当现价。
- 推广码不在仓库里：运行时由 `SRVPRICE_TENCENT_CPS_KEY` / `SRVPRICE_WEST_REFERENCE_ID` 注入。

## 未定

- 是否发布到 npm；
- 安装器与自动更新；
- 两个包是否拆成独立仓库。

## 许可

MIT，见各目录下的 `LICENSE`。
