'use strict';

// 配对页（http://127.0.0.1:8790/pair）上运行：把页面里的一次性 nonce 交给后台换 token。
// 用户不需要复制任何东西——打开配对页即完成。

(function () {
  const meta = document.querySelector('meta[name="srvprice-pair-nonce"]');
  if (!meta) return;
  const nonce = meta.getAttribute('content');
  const port = location.port || '8790';
  const msg = document.getElementById('msg');
  if (msg) msg.textContent = '正在配对…';

  chrome.runtime.sendMessage({ type: 'srvprice:pair', nonce, port }, (r) => {
    void chrome.runtime.lastError;
    if (!msg) return;
    if (r && r.ok) {
      msg.textContent = '✅ 配对成功，可以关闭此页。';
      document.title = '✅ srvprice 配对成功';
    } else {
      msg.textContent = '❌ 配对失败：' + ((r && r.error) || '扩展后台无响应') +
        '（请确认扩展已启用，然后刷新此页重试）';
      document.title = '❌ srvprice 配对失败';
    }
  });
})();
