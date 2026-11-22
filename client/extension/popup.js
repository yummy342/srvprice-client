'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_PORT = 8790;

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

function getStorage() {
  return new Promise((resolve) => chrome.storage.local.get(['bridgePort', 'bridgeToken'], resolve));
}

function health(port) {
  return fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null);
}

function showInstallHint(show) {
  const el = $('installHint');
  if (el) el.style.display = show ? '' : 'none';
}

async function refresh() {
  const d = await getStorage();
  const port = Number(d.bridgePort || DEFAULT_PORT);
  const h = await health(port);
  showInstallHint(!h);
  chrome.runtime.sendMessage({ type: 'srvprice:status' }, (r) => {
    void chrome.runtime.lastError;
    if (h && h.connected) {
      // 桥只会在 token+来源校验通过后置 connected —— 这是权威信号
      setStatus('● 已连接本地桥', 'on');
    } else if (r && r.connected) {
      setStatus('● 已连接本地桥', 'on');
    } else if (!d.bridgeToken) {
      setStatus('还没配对：点「打开配对页」完成配对', 'off');
    } else if (h && h.connected) {
      setStatus('● 桥已连接，扩展正在重连…', 'wait');
    } else if (!h) {
      setStatus('连不上本地桥：在客户端目录运行 node bin/srvprice-client.js start --pair', 'off');
    } else {
      setStatus('未连接：稍等自动重连，或点「打开配对页」重新配对', 'off');
    }
  });
}

$('pair').addEventListener('click', () => {
  setStatus('正在配对…', 'wait');
  chrome.runtime.sendMessage({ type: 'srvprice:autopair' }, (r) => {
    void chrome.runtime.lastError;
    if (r && r.ok) {
      setStatus('● 配对成功，已连接本地桥', 'on');
      setTimeout(refresh, 500);
    } else {
      setStatus((r && r.error) || '配对失败：确认客户端 start 在运行', 'off');
    }
  });
});

$('check').addEventListener('click', refresh);

// debugger 是可选权限：只在需要真实点击/输入（CDP）时按用户点击授权
function refreshPerm() {
  chrome.permissions.contains({ permissions: ['debugger'] }, (has) => {
    void chrome.runtime.lastError;
    $('perm').style.display = has ? 'none' : '';
  });
}
$('perm').addEventListener('click', () => {
  chrome.permissions.request({ permissions: ['debugger'] }, (ok) => {
    void chrome.runtime.lastError;
    if (!ok) setStatus('未授权调试权限：真实点击/输入不可用，其余功能正常', 'off');
    refreshPerm();
  });
});
refreshPerm();

$('ver').textContent = '扩展 v' + chrome.runtime.getManifest().version;

refresh();
setInterval(refresh, 1500);
