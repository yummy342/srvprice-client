#!/usr/bin/env python3
"""flowlib 远端参考实现（零依赖，Python 3.8+）。

只存每个流程的成功样本（按 account_hash 覆盖）；合并由客户端做。

环境变量：
  FLOWLIB_TOKEN_FILE  令牌文件（优先）
  FLOWLIB_TOKEN       或者直接给令牌（不推荐，会进环境）
  FLOWLIB_DATA        数据文件路径（默认 ./flowlib-data.json）
  PORT                监听端口（默认 8791，绑 127.0.0.1）

路由：
  GET  /health                    无鉴权
  GET  /lib                       鉴权 → {ok, flows}
  GET  /lib/<id>                  鉴权 → {ok, samples}
  POST /lib/<id>/samples          鉴权，body {"sample": {...}} → {ok, samples}
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

MAX_BYTES = 512 * 1024
LOCK = threading.Lock()


def data_file():
    return os.environ.get("FLOWLIB_DATA") or os.path.join(os.getcwd(), "flowlib-data.json")


def token():
    f = os.environ.get("FLOWLIB_TOKEN_FILE")
    if f:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        except OSError:
            return ""
    return os.environ.get("FLOWLIB_TOKEN", "")


def load_data():
    try:
        with open(data_file(), "r", encoding="utf-8") as fh:
            j = json.load(fh)
        if isinstance(j, dict) and isinstance(j.get("flows"), dict):
            return j
    except (OSError, ValueError):
        pass
    return {"version": 1, "flows": {}}


def audit(entry):
    """写入审计：只记 id/账号 hash/字节数/时间，不记样本内容。"""
    path = os.environ.get("FLOWLIB_AUDIT") or os.path.join(
        os.path.dirname(data_file()) or ".", "audit.log")
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass


def save_data(data):
    path = data_file()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


class Handler(BaseHTTPRequestHandler):
    server_version = "flowlib/1.0"

    def log_message(self, fmt, *args):  # 静默访问日志，避免刷屏
        return

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        tok = token()
        if not tok:
            return True  # 未配置令牌时不鉴权（仅限内网）
        return self.headers.get("authorization", "") == f"Bearer {tok}"

    def _route(self):
        return urlparse(self.path).path

    def do_GET(self):
        p = self._route()
        if p == "/health":
            return self._send(200, {"ok": True, "t": int(time.time())})
        if not p.startswith("/lib"):
            return self._send(404, {"ok": False, "error": "not found"})
        if not self._authed():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        parts = [x for x in p.split("/") if x][1:]  # 去掉空段和 "lib"
        with LOCK:
            data = load_data()
        if not parts:
            return self._send(200, {"ok": True, "flows": data["flows"]})
        fid = unquote(parts[0])
        entry = data["flows"].get(fid) or {}
        return self._send(200, {"ok": True, "samples": entry.get("samples", [])})

    def do_POST(self):
        p = self._route()
        m = None
        if p.startswith("/lib/"):
            parts = [x for x in p.split("/") if x]
            if len(parts) == 3 and parts[2] == "samples":
                m = unquote(parts[1])
        if not m:
            return self._send(404, {"ok": False, "error": "not found"})
        if not self._authed():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BYTES:
            return self._send(400, {"ok": False, "error": "bad length"})
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except ValueError:
            return self._send(400, {"ok": False, "error": "bad json"})
        sample = body.get("sample") if isinstance(body, dict) else None
        if (not isinstance(sample, dict) or not sample.get("account_hash")
                or not isinstance(sample.get("steps"), list)):
            return self._send(400, {"ok": False, "error": "bad sample"})
        with LOCK:
            data = load_data()
            entry = data["flows"].get(m) or {"samples": []}
            samples = [s for s in entry.get("samples", [])
                       if s.get("account_hash") != sample["account_hash"]]
            samples.append(sample)
            entry["samples"] = samples
            data["flows"][m] = entry
            save_data(data)
        audit({"t": int(time.time()), "id": m,
               "account": sample["account_hash"][:16], "bytes": n})
        return self._send(200, {"ok": True, "samples": samples})


def main():
    port = int(os.environ.get("PORT", "8791"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[flowlib] listening 127.0.0.1:{port} data={data_file()}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
