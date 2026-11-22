# srvprice client · 浏览器扩展（骨架 0.1.0）

MV3，Chrome / Edge 同一套。作用：把页面状态回传给本地客户端，并按 steps 执行浏览器动作。

## 安装

1. `chrome://extensions`（或 `edge://extensions`）→ 打开开发者模式
2. 加载已解压的扩展程序 → 选本目录
3. 客户端先 `node bin/srvprice-client.js start`
4. 点扩展图标 →「打开配对页」→ 页面自动完成配对（不用复制 token）

## 做什么 / 不做什么

- 做：连接 `ws://127.0.0.1:8790/ws`，hello 带 token + `chrome-extension://` 来源；每秒回传 `{url, page, step_id, visible_text_hash}`；按 `exec` 执行 open/click/fill_form/attach_policy/read_fields/wait。
- 不做：不读任何密钥/验证码/密码输入框的值（`read_fields` 只回 presence）；不执行 shell；不代登录、不代过验证码、不代付款。

## 文件

- `background.js`：桥连接、鉴权、exec 转发、voice 播报、断线重连（5s）与 20s ping
- `content.js`：状态回传（SHA-256 截断文本哈希）、文本/可访问性树匹配、动作执行、敏感输入黑名单
- `popup.html/js`：token/端口设置与连接状态

## 安全

- 只连 127.0.0.1；token 存 `chrome.storage.local`
- 服务端（本地桥）还会校验 token 与来源，扩展被反冒充不了
- 状态回传只发白名单字段；页面侧不发 innerText 原文，只发哈希
