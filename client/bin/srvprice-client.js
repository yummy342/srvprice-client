#!/usr/bin/env node
'use strict';

// srvprice 客户端 · 第一期骨架 CLI
//   node bin/srvprice-client.js start          起本地桥（127.0.0.1:8790）
//   node bin/srvprice-client.js status         看配置/桥/流程库状态
//   node bin/srvprice-client.js token [--show] 看桥 token（默认打码）
//   node bin/srvprice-client.js list [--provider X] [--json]  只读列资源
//   node bin/srvprice-client.js flows           校验流程库
//   node bin/srvprice-client.js flow run <id> [--dry-run]     生成执行计划
//   node bin/srvprice-client.js voice "<text>" 说话测试
//   node bin/srvprice-client.js listen --mic   麦克风录音 + whisper 识别

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const cfg = require('../lib/config');
const { createBridge } = require('../lib/bridge');
const { listHosts } = require('../lib/inventory');
const site = require('../lib/site');
const purchase = require('../lib/purchase');
const { loadFlows, planFlow, runFlow, resolveFlowVars, validateFlow, eventsToFlow } = require('../lib/flows');
const flowhealth = require('../lib/flowhealth');
const flowlib = require('../lib/flowlib');
const commandlib = require('../lib/command');
const intentlib = require('../lib/intent');
const { speak, check: voiceCheck } = require('../lib/voice');
const stt = require('../lib/stt');
const recorder = require('../lib/recorder');
const vaultlib = require('../lib/vault');
const models = require('../lib/models');
const state = require('../lib/state');

const args = process.argv.slice(2);
const cmd = args[0];

function has(flag) { return args.includes(flag); }
function val(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}
function vals(flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]);
  }
  return out;
}
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function printPlan(plan, warnings) {
  const price = plan.price || {};
  console.log(`${plan.provider_label || plan.provider} ${plan.name}`);
  console.log(`  套餐 ID：${plan.id}`);
  if (price.first_year_cny != null) console.log(`  首年：¥${price.first_year_cny}`);
  if (price.monthly_cny != null) console.log(`  月付：¥${price.monthly_cny}`);
  if (price.renew) console.log(`  续费：${price.renew}`);
  if (plan.eligibility && plan.eligibility !== 'all') console.log(`  资格：${plan.eligibility}`);
  if (plan.purchase_limit) console.log(`  限购：${plan.purchase_limit}`);
  if (plan.requires_icp) console.log('  备案：大陆机房需要实名与备案（人工办理）');
  if (plan.deadlines) console.log(`  截止：${plan.deadlines}`);
  if (plan.source_url) console.log(`  来源：${plan.source_url}`);
  for (const c of purchase.caveats(plan, warnings)) console.log(`  注意：${c}`);
}

// 把单个 step 交给正在运行的本地桥（桥再转给扩展执行）。token 必须匹配。
// 超时要覆盖扩展侧最坏情况：注入超时 8s + 导航后 verify 轮询（步骤自带，最长 20s）
function daemonExec(step, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ step });
    const req = http.request({
      host: '127.0.0.1',
      port: cfg.defaultPort(),
      path: '/exec',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-srvprice-token': cfg.readToken(),
        'content-length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (_) {
          resolve({ ok: false, error: '桥返回的不是 JSON' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: '连不上本地桥：' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '执行超时' }); });
    req.write(body);
    req.end();
  });
}

function daemonPost(pathname, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port: cfg.defaultPort(),
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-srvprice-token': cfg.readToken(),
        'content-length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ ok: false, error: 'bad response' }); } });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function daemonOverlay(overlay) {
  return daemonPost('/overlay', { overlay });
}

function parseVars() {
  const provided = {};
  for (const s of vals('--var')) {
    const i = String(s).indexOf('=');
    if (i < 1) return { error: '--var 需要 k=v 形式' };
    provided[String(s).slice(0, i)] = String(s).slice(i + 1);
  }
  const varsArg = val('--vars');
  if (varsArg) {
    for (const part of String(varsArg).split(',')) {
      if (!part) continue;
      const i = part.indexOf('=');
      if (i < 1) return { error: '--vars 需要 k=v,k2=v2 形式' };
      provided[part.slice(0, i)] = part.slice(i + 1);
    }
  }
  return { provided };
}

function daemonGet(pathname, timeoutMs = 8000) {
  return new Promise((resolve) => {
    http.get({
      host: '127.0.0.1',
      port: cfg.defaultPort(),
      path: pathname,
      timeout: timeoutMs,
      headers: { 'x-srvprice-token': cfg.readToken() }
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

function daemonState() {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: cfg.defaultPort(), path: '/state', timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write([
      'srvprice 客户端（第一期骨架）',
      '  start [--pair]            起本地桥（127.0.0.1:8790；--pair 自动打开配对页）',
      '  status                    配置 / 流程库概览',
      '  token [--show]            查看桥 token（默认打码）',
      '  list [--provider X] [--json]',
      '                            只读列出资源（经 srvprice CLI，强制 read-only）',
      '  prices [--vendor X] [--verified] [--json]',
      '                            网站周快照（30 条优惠价；未复核的会标出来源日期）',
      '  compare <domain> [--json] 域名各渠道首年/续费比价（站点实时接口）',
      '  purchase list [--provider X]   列出可买套餐',
      '  purchase show <plan-id>        套餐详情（价格、资格、续费、快照日期）',
      '  purchase open <plan-id> --yes  打开厂商官网购买入口（人工付款；不代下单）',
      '  purchase done <plan-id>        买完对差集，确认新机器已进列表',
      '  say "<一句话>" [--run]    意图路由：返回建议命令；--run 直接执行',
      '  flows                     校验流程库',
      '  flow run <id> [--dry-run] 生成执行计划（骨架默认 dry-run）',
      '  step run <flow-id> <step-id> [--force]',
      '                            让扩展执行单个步骤（需要桥 + 扩展已连接）',
      '  overlay "<text>" [--title T] [--status running|waiting|done|fail] [--ack "按钮"]',
      '                            在页面右下角浮层显示内容',
      '  ack                       查看用户最近一次浮层确认',
      '  probe                     取当前页面的文本样本和按钮文案（校准用）',
      '  shot                      截当前厂商控制台页面，保存 PNG 并给出路径',
      '  reload-ext                通知扩展 chrome.runtime.reload()（开发期热载）',
      '  tabs                      列出厂商控制台标签页（含目标标记）',
      '  use-tab <tabId>           固定目标标签页（多开控制台时用）',
      '  vault-capture [--vendor X] [--profile P]  抓页面密钥直接写入 vault（不打印明文）',
      '  vault-materialize --vendor X --profile P [--region R]',
      '                            vault → 厂商 CLI 物化（凭据不经过客户端进程）',
      '  vault-status --vendor X --profile P      看 vault 条目是否存在',
      '  vault-purge --vendor X                   清理物化缓存指引',
      '  vault-run --items A,B --cmd "<命令>"     用 vault 注入的凭据执行命令',
      '  model vendors [--all]     模型厂商目录（phase 3 BYOK；--all 含 UNVERIFIED）',
      '  model get --id <id>       单个模型厂商的接入事实',
      '  model key list [--all]      查询所有厂商的 key 是否已配置（不显示明文）',
      '  model key add --id <id> [--workspace-id W] [--region R] [--key-type paygo|coding]',
      '                            验证并保存模型 key（key 从 SRVPRICE_MODEL_KEY 或 stdin 读，不走 argv）',
      '  model key set --id <id> ...  add 的别名',
      '  model key status --id <id>  看 vault 里有没有该厂商的 key',
      '  gate [--id X] [--title T] "<说明>" [--timeout 秒]',
      '                            页面右下角弹人工门，CLI 阻塞等你点「我完成了」',
      '  voice "<text>" [--check]  edge-tts 播报（SAPI 仅兜底）；--check 看语音栈',
      '  listen --mic [--lang zh] [--max 30] [--silence 2000] [--text] [--device N] [--model base|small] [--debug]',
      '                            麦克风录音 + whisper 识别（说一句话，静默自动停）',
      '  listen --devices          列出麦克风（Python/sounddevice；退回 stream.exe）',
      '  listen --file <wav>       现成音频文件 → 文本（需 stt-set 配好模型）',
      '  stt-set --cli <exe> --model <bin>  写入本机语音识别配置（非密钥）',
      ''
    ].join('\n'));
    return 0;
  }

  if (cmd === 'start') {
    const token = cfg.ensureToken();
    const port = Number(val('--port', cfg.defaultPort()));
    const bridge = await createBridge({ port, token, log: (m) => console.log(`[bridge] ${m}`) });
    state.writeState({ bridge: { port: bridge.port, started_at: new Date().toISOString() } });
    const pairUrl = `http://127.0.0.1:${bridge.port}/pair`;
    console.log('');
    console.log('本地桥已就绪。');
    console.log(`  配对页：${pairUrl}   ← 在浏览器打开即可自动配对（不用手输 token）`);
    console.log(`  token 文件：${cfg.tokenFile()}（备用）`);
    if (has('--pair') || has('--open-pair')) {
      try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', pairUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch (_) {}
    }
    if (!has('--no-watch')) {
      try {
        const extDir = path.join(__dirname, '..', 'extension');
        let timer = null;
        const trigger = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { bridge.reloadExtension(); }, 800);
        };
        fs.watch(extDir, { recursive: true }, (evt, fn) => {
          if (!fn || /\.(js|json|html)$/.test(String(fn))) trigger();
        });
        console.log('  扩展热载：监听 extension/ 改动后自动 reload（--no-watch 关闭）');
      } catch (e) {
        console.log('  扩展热载不可用：' + e.message);
      }
    }
    console.log('');
    const shutdown = async () => {
      state.appendEvent({ type: 'bridge_stop' });
      await bridge.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise(() => {}); // 常驻
    return 0;
  }

  if (cmd === 'status') {
    const flows = loadFlows(cfg.flowsDir());
    out({
      app_dir: cfg.appDir(),
      token_file: cfg.tokenFile(),
      token_exists: !!cfg.readToken(),
      port: cfg.defaultPort(),
      cli: cfg.defaultCli(),
      flows_dir: cfg.flowsDir(),
      flows: flows.map((f) => ({
        file: path.basename(f.file),
        id: f.flow && f.flow.id,
        version: f.flow && f.flow.version,
        status: f.flow && f.flow.status,
        steps: f.flow && Array.isArray(f.flow.steps) ? f.flow.steps.length : 0,
        errors: f.errors
      }))
    });
    return 0;
  }

  if (cmd === 'token') {
    const t = cfg.readToken();
    if (!t) {
      console.log('还没有 token：先运行 start');
      return 1;
    }
    console.log(has('--show') ? t : `${t.slice(0, 6)}…${t.slice(-4)}（--show 看完整）`);
    return 0;
  }

  if (cmd === 'vault-capture') {
    // 抓当前页面上的厂商密钥并直接写入本地 vault（不打印明文）
    const vendor = String(val('--vendor', 'volcengine')).toLowerCase();
    const profile = String(val('--profile', 'muse-readonly-test'));
    const fieldMap = {
      volcengine: [
        { name: 'ak', matcher: { label: 'AccessKeyId', id_hint: 'AccessKeyId' } },
        { name: 'sk', matcher: { label: 'SecretAccessKey', id_hint: 'SecretAccessKey' } }
      ],
      aliyun: [
        { name: 'ak', matcher: { label: 'AccessKeyId', id_hint: 'AccessKeyId' } },
        { name: 'sk', matcher: { label: 'AccessKeySecret', id_hint: 'AccessKeySecret' } }
      ],
      tencent: [
        { name: 'ak', matcher: { label: 'SecretId', id_hint: 'SecretId' } },
        { name: 'sk', matcher: { label: 'SecretKey', id_hint: 'SecretKey' } }
      ],
      baidu: [
        { name: 'ak', matcher: { label: 'AccessKeyId', id_hint: 'AccessKey' } },
        { name: 'sk', matcher: { label: 'SecretAccessKey', id_hint: 'SecretAccessKey' } }
      ]
    };
    // 单令牌厂商（2026-11-20）：token 只显示一次且多为纯文本，按正则从页面文本里取
    const singleToken = {
      doctl: 'dop_v1_[A-Za-z0-9]{10,}',   // DigitalOcean PAT 前缀 dop_v1_
      hcloud: '[A-Za-z0-9]{64}',          // Hetzner token 固定 64 位（CLI 会校验长度）
      linode: '[A-Za-z0-9]{64}',          // Linode PAT
      vultr: '[A-Z0-9]{36}'               // Vultr API key：36 位大写字母数字（2026-11-20 真机）
    };
    const fields = fieldMap[vendor];
    if (!fields && !singleToken[vendor]) {
      console.log('用法：vault-capture --vendor volcengine|aliyun|tencent|baidu|doctl|hcloud|linode --profile <name>');
      return 2;
    }
    const P = vendor.toUpperCase();
    const slug = profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (singleToken[vendor]) {
      const r = await daemonPost('/capture-vault', {
        mode: 'regex',
        regex: singleToken[vendor],
        items: [{ field: 'token', name: `${P}_${slug}_TOKEN`, env: `SRVPRICE_${P}_TOKEN` }],
        reason: 'srvprice client 按用户要求把厂商只读密钥存入 vault'
      }, 30000);
      out(r);
      return r.ok ? 0 : 6;
    }
    const items = [
      { field: 'ak', name: `${P}_${slug}_AK`, env: `SRVPRICE_${P}_ACCESS_KEY` },
      { field: 'sk', name: `${P}_${slug}_SK`, env: `SRVPRICE_${P}_SECRET_KEY` }
    ];
    const r = await daemonPost('/capture-vault', {
      fields, items,
      reason: 'srvprice client 按用户要求把厂商只读密钥存入 vault'
    }, 30000);
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'vault-capture-dialog') {
    const vendor = String(val('--vendor', 'aliyun')).toLowerCase();
    const profile = String(val('--profile', 'muse-readonly-demo'));
    const akLabel = String(val('--ak-label', 'AccessKey ID'));
    const skLabel = String(val('--sk-label', 'AccessKey Secret'));
    const P = vendor.toUpperCase();
    const slug = profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const r = await daemonPost('/capture-vault', {
      mode: 'dialog',
      ak_label: akLabel, sk_label: skLabel,
      items: [
        { field: 'ak', name: `${P}_${slug}_AK`, env: `SRVPRICE_${P}_ACCESS_KEY` },
        { field: 'sk', name: `${P}_${slug}_SK`, env: `SRVPRICE_${P}_SECRET_KEY` }
      ],
      reason: 'srvprice client 按用户要求把厂商只读密钥存入 vault'
    }, 30000);
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'vault-run') {
    // 用 vault 注入的凭据执行任意命令（如西部数码：无 CLI，直接跑 srvprice host list）
    const items = String(val('--items', ''));
    const command = String(val('--cmd', ''));
    if (!items || !command) {
      console.log('用法：vault-run --items A,B --cmd "<命令>"');
      return 2;
    }
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [vaultlib.vaultCli(), 'run', items, command],
      { encoding: 'utf8', timeout: 180000 });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    return r.status === null ? 1 : r.status;
  }

  if (cmd === 'vault-materialize') {
    const vendor = String(val('--vendor', ''));
    const profile = String(val('--profile', 'default'));
    const region = String(val('--region', ''));
    if (!vendor) {
      console.log('用法：vault-materialize --vendor volcengine|aliyun|tencent|baidu|doctl|hcloud|linode --profile P [--region R]');
      return 2;
    }
    const r = vaultlib.materialize(vendor, profile, region);
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'vault-status') {
    const vendor = String(val('--vendor', ''));
    const profile = String(val('--profile', 'default'));
    if (!vendor) {
      console.log('用法：vault-status --vendor X --profile P');
      return 2;
    }
    out(vaultlib.status(vendor, profile));
    return 0;
  }

  if (cmd === 'vault-purge') {
    const vendor = String(val('--vendor', ''));
    if (!vendor) {
      console.log('用法：vault-purge --vendor X（只给清理指引，不删除）');
      return 2;
    }
    out(vaultlib.purgeInfo(vendor));
    return 0;
  }

  if (cmd === 'vault-capture-text') {
    // 抓“标签 + 文本值”形式的密钥（百度/火山成功弹窗），直接写 vault
    const vendor = String(val('--vendor', 'baidu')).toLowerCase();
    const profile = String(val('--profile', 'muse-readonly-demo'));
    const akLabel = String(val('--ak-label', 'AccessKeyID'));
    const skLabel = String(val('--sk-label', 'AccessKeySecret'));
    const P = vendor.toUpperCase();
    const slug = profile.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const r = await daemonPost('/capture-vault', {
      mode: 'text',
      fields: [{ name: 'ak', label: akLabel }, { name: 'sk', label: skLabel }],
      items: [
        { field: 'ak', name: `${P}_${slug}_AK`, env: `SRVPRICE_${P}_ACCESS_KEY` },
        { field: 'sk', name: `${P}_${slug}_SK`, env: `SRVPRICE_${P}_SECRET_KEY` }
      ],
      reason: 'srvprice client 按用户要求把厂商只读密钥存入 vault'
    }, 30000);
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'tabs') {
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: cfg.defaultPort(), path: '/tabs', timeout: 8000 }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ ok: false, error: 'bad response' }); } });
      }).on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'use-tab') {
    const tabId = Number(val('--id', args[1]));
    if (!tabId) {
      console.log('用法：use-tab <tabId>（先 tabs 看列表）');
      return 2;
    }
    const r = await daemonPost('/use-tab', { tabId });
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'reload-ext') {
    const r = await daemonPost('/reload-extension', {});
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'shot') {
    // 截当前厂商控制台标签页，保存 PNG 并返回路径
    const r = await daemonPost('/screenshot', {}, 30000);
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'gate') {
    // 页面内人工门：右下角弹卡片，CLI 阻塞等用户点「我完成了」
    const id = String(val('--id', 'gate-' + Date.now()));
    const title = String(val('--title', '需要人工操作'));
    const msgFlag = val('--message');
    const untilText = val('--until-text', '');
    const untilNotText = val('--until-not-text', '');
    const untilUrl = val('--until-url', '');
    const FLAGS = new Set(['--id', '--title', '--message', '--timeout',
      '--until-text', '--until-not-text', '--until-url']);
    const positional = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (FLAGS.has(a)) { i++; continue; }
      if (a.startsWith('--')) continue;
      positional.push(a);
    }
    const message = String(msgFlag || positional.join(' '));
    const timeout = Number(val('--timeout', '900'));
    const r = await daemonExec({ step_id: 'gate', do: { action: 'prompt', id, title, message } });
    if (!r.ok) {
      out({ ok: false, error: r.error || 'prompt failed' });
      return 6;
    }
    console.log(`[gate] 已弹出人工门（${id}）：${message}`);
    console.log('[gate] 等你在页面右下角点「我完成了」…');
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 1500));
      const s = await daemonExec({ step_id: 'ack', do: { action: 'ack_status', id } });
      if (s.ok && s.detail && s.detail.acked) {
        out({ ok: true, id, at: s.detail.at, via: 'button' });
        return 0;
      }
      // 条件满足也自动放行（比如登录后页面出现“用户列表”）
      if (untilText) {
        const t = await daemonExec({ step_id: 'until', do: { action: 'has_text', texts: [untilText] } });
        if (t.ok && t.detail && t.detail[untilText]) {
          out({ ok: true, id, via: 'text', matched: untilText });
          return 0;
        }
      }
      if (untilNotText) {
        const t = await daemonExec({ step_id: 'until-not', do: { action: 'has_text', texts: [untilNotText] } });
        if (t.ok && t.detail && t.detail[untilNotText] === false) {
          out({ ok: true, id, via: 'text-gone', matched: untilNotText });
          return 0;
        }
      }
      if (untilUrl) {
        const r2 = await daemonExec({ step_id: 'until-url', do: { action: 'report' } });
        const url = r2 && r2.detail && r2.detail.url;
        if (url && String(url).includes(untilUrl)) {
          out({ ok: true, id, via: 'url', matched: untilUrl });
          return 0;
        }
      }
    }
    out({ ok: false, error: '等待超时', id });
    return 6;
  }

  if (cmd === 'probe') {
    // 页面探针：扩展用 scripting.executeScript 现取，不依赖 content script 版本/页面刷新
    const r = await daemonPost('/probe', {});
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'overlay') {
    const FLAGS = new Set(['--title', '--status', '--ack', '--id']);
    const parts = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (FLAGS.has(a)) { i++; continue; }
      if (a.startsWith('--')) continue;
      parts.push(a);
    }
    const payload = {
      title: val('--title', 'srvprice 客户端'),
      status: val('--status', 'running'),
      ack: val('--ack', ''),
      id: val('--id', ''),
      message: parts.join(' ')
    };
    const r = await daemonOverlay(payload);
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'ack') {
    const ack = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: cfg.defaultPort(), path: '/ack', timeout: 3000 }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    out(ack || { ok: false, error: '连不上本地桥' });
    return 0;
  }

  if (cmd === 'list') {
    // 多地域进度：TTY 下原地刷新；非 TTY 写 JSONL 到 stderr（stdout 保持纯 JSON）
    const onProgress = has('--no-progress') ? undefined : (p) => {
      const text = `[${p.provider}] 正在查第 ${p.done}/${p.total} 个地域${p.region ? '（' + p.region + '）' : ''}`;
      if (process.stderr.isTTY) process.stderr.write('\r' + text + '      ');
      else process.stderr.write(JSON.stringify(Object.assign({ level: 'progress' }, p)) + '\n');
    };
    const res = await listHosts({ provider: val('--provider'), onProgress });
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(64) + '\r');
    if (has('--json') || !process.stdout.isTTY) {
      out(res);
      return res.errors.length ? 5 : 0;
    }
    console.log(`共 ${res.items.length} 台：`);
    for (const it of res.items) {
      console.log(`  ${it.id}  ${it.status}  ${it.public_ipv4 || '-'}  ${it.region || '-'}`);
    }
    if (res.errors.length) {
      console.log('未接通：' + res.errors.map((e) => e.provider).join(', '));
    }
    return res.errors.length ? 5 : 0;
  }

  // ---- 站点数据（只读，公开接口）：周快照 / 域名比价 ----
  if (cmd === 'prices') {
    const timeoutMs = Number(val('--timeout', 20000)) || 20000;
    let s;
    try { s = await site.snapshot({ timeoutMs }); }
    catch (e) { console.error(e.message); return 4; }
    const vendor = val('--vendor');
    // --vendor 收的是 CLI 的厂商 id（aliyun），快照里是人读名字（阿里云）
    const labels = {
      aliyun: '阿里云', tencent: '腾讯云', baidu: '百度云', jdcloud: '京东云',
      ctyun: '天翼云', ucloud: 'UCloud', west: '西部数码', volcengine: '火山引擎',
      aws: 'AWS', digitalocean: 'DigitalOcean', vultr: 'Vultr', linode: 'Linode', hcloud: 'Hetzner'
    };
    let items = s.items;
    if (vendor) {
      const label = labels[vendor] || vendor;
      items = items.filter((i) => String(i.vendor) === label || String(i.vendor).includes(vendor));
    }
    if (has('--verified')) items = items.filter((i) => i.verified_this_week);
    if (has('--json')) {
      out(Object.assign({}, s, { items }));
      return 0;
    }
    console.log(`快照 ${s.as_of || '?'}（生成 ${s.generated_at || '?'}），${items.length} 条` +
      (s.counts ? `｜本周已复核 ${s.counts.verified_this_week}/${s.counts.items}` : ''));
    for (const it of items) {
      const flag = it.verified_this_week ? '' : `  [值来自 ${it.source_date || '旧'}，本周未复核]`;
      console.log(`  ${it.vendor} ${it.product} ${it.spec} — ${it.price}` +
        (it.price_type ? `（${it.price_type}）` : '') + flag);
    }
    return 0;
  }

  if (cmd === 'compare') {
    const domain = args.slice(1).find((a) => !String(a).startsWith('--'));
    if (!domain) { console.log('用法：compare <domain> [--json]'); return 2; }
    const timeoutMs = Number(val('--timeout', 20000)) || 20000;
    let r;
    try { r = await site.compare(domain, { timeoutMs }); }
    catch (e) { console.error(e.message); return 4; }
    if (has('--json')) { out(r); return 0; }
    console.log(`${r.domain}（实时比价 ${r.generated_at || ''}）`);
    const money = (cny, raw, cur) => cny != null ? `¥${cny}`
      : raw == null ? '—' : `${cur === 'USD' ? '$' : (cur || '')}${raw}`;
    for (const c of r.channels) {
      const first = money(c.cny_first, c.first, c.currency);
      const renew = money(c.cny_renew, c.renew, c.currency);
      console.log(`  ${c.name}  首年 ${first}  续费 ${renew}${c.verified ? '' : '（未核实）'}`);
    }
    return 0;
  }

  // ---- 购买 pipeline：选机 → 确认 → 付款（人工）→ 接进列表 ----
  if (cmd === 'purchase') {
    const sub = args[1];
    const planId = args[2] && !String(args[2]).startsWith('--') ? args[2] : val('--id');
    try {
      if (sub === 'list') {
        const r = purchase.listPlans({ provider: val('--provider') });
        if (has('--json')) { out(r); return 0; }
        console.log(`共 ${r.total} 个套餐：`);
        for (const it of r.items) {
          console.log(`  ${it.id}  ${it.provider_label || it.provider}  ${it.name}`);
        }
        return 0;
      }
      if (sub === 'show' || sub === 'get') {
        if (!planId) { console.log('用法：purchase show <plan-id>（套餐 ID 用 purchase list 看）'); return 2; }
        const { plan, warnings } = purchase.getPlan(planId);
        if (has('--json')) { out({ plan, warnings }); return 0; }
        printPlan(plan, warnings);
        return 0;
      }
      if (sub === 'open') {
        if (!planId) { console.log('用法：purchase open <plan-id> --yes'); return 2; }
        const { plan, warnings } = purchase.getPlan(planId);
        const buy = purchase.getBuy(planId);
        if (!has('--yes')) {
          printPlan(plan, warnings);
          console.log('');
          console.log('购买入口：' + buy.url);
          console.log('打开厂商页面需要显式确认：加 --yes 重跑（只打开官网，不代下单、不收款）。');
          return 7;
        }
        // 买前基线：记下当前资源，买完用 done 对差集
        const before = await listHosts({ provider: plan.provider });
        purchase.recordBefore(planId, plan.provider, before.items.map((i) => i.id));
        const opened = purchase.openBuy(planId);
        out({ ok: true, plan_id: planId, url: opened.url, provider: plan.provider, before_count: before.items.length });
        console.log('');
        console.log('已在浏览器打开厂商页面。接下来全部由你完成：');
        console.log('  1) 注册/登录（人工）  2) 实名/备案（人工）  3) 付款（人工）');
        console.log(`  4) 买完回来跑：node bin/srvprice-client.js purchase done ${planId}`);
        return 0;
      }
      if (sub === 'done') {
        if (!planId) { console.log('用法：purchase done <plan-id>'); return 2; }
        const before = purchase.takeBefore(planId);
        if (!before) {
          console.log(`没有 ${planId} 的买前基线：先跑 purchase open ${planId} --yes`);
          return 4;
        }
        const after = await listHosts({ provider: before.provider });
        const seen = new Set(before.ids);
        const fresh = after.items.filter((i) => !seen.has(i.id));
        out({ plan_id: planId, provider: before.provider, new_instances: fresh, total_now: after.items.length });
        if (fresh.length) {
          console.log('');
          console.log('新机器已出现在列表。下一步：');
          console.log(`  开端口：node bin/srvprice-client.js say "给 ${before.provider} 开 22 端口给 <你的IP>"`);
          console.log('  降价提醒：https://www.srvprice.com/subs/');
        } else {
          console.log('还没看到新机器：厂商侧可能还在开通，稍后重跑 purchase done。');
        }
        return 0;
      }
    } catch (e) {
      console.error(e.message);
      return 4;
    }
    console.log('用法：purchase list [--provider X] | purchase show <plan-id> | purchase open <plan-id> --yes | purchase done <plan-id>');
    return 2;
  }

  // ---- 大模型厂商（phase 3，BYOK）：目录 / 单厂商 / key 验证入库 ----
  if (cmd === 'model') {
    const sub = args[1];
    if (!sub || !['vendors', 'get', 'key'].includes(sub)) {
      console.log('用法：model vendors [--all] | model get --id <id> | model key list [--all] | model key add|set|status --id <id>');
      return 2;
    }
    if (sub === 'vendors') {
      const list = models.listVendors({ includeUnverified: has('--all') });
      out({ count: list.length, verified_at: models.loadCatalog().verified_at, items: list });
      return 0;
    }
    if (sub === 'get') {
      const id = val('--id');
      if (!id) { console.log('用法：model get --id <vendor-id>'); return 2; }
      try { out({ vendor: models.getVendor(id) }); return 0; }
      catch (e) { console.error(e.message); return 4; }
    }
    // model key list|add|set|status
    const action = args[2];
    const id = val('--id');
    if (!['list', 'add', 'set', 'status'].includes(action)) {
      console.log('用法：model key list [--all] | model key add|set|status --id <vendor-id>');
      return 2;
    }
    if (action === 'list') {
      const vendors = models.listVendors({ includeUnverified: has('--all') });
      const names = await models.vaultListNames();
      const items = vendors.map((v) => {
        const item = models.keyItem(v);
        return { id: v.id, name: v.name, item: item.name, exists: names.has(item.name), verified: v.verified !== false };
      });
      out({ count: items.length, configured: items.filter((x) => x.exists).length, items });
      return 0;
    }
    if (!id) {
      console.log('用法：model key add|set|status --id <vendor-id>');
      return 2;
    }
    let vendor;
    try { vendor = models.getVendor(id); } catch (e) { console.error(e.message); return 4; }
    const item = models.keyItem(vendor);
    if (action === 'status') {
      const names = await models.vaultListNames();
      out({ vendor: id, item: item.name, exists: names.has(item.name) });
      return 0;
    }
    // set：key 只从环境变量或 stdin 读，绝不接受命令行参数
    let key = process.env.SRVPRICE_MODEL_KEY || '';
    if (!key && !process.stdin.isTTY) {
      try { key = fs.readFileSync(0, 'utf8'); } catch (_) { key = ''; }
    }
    key = String(key || '').trim();
    if (!key) {
      console.error('没有拿到 key：用 SRVPRICE_MODEL_KEY 环境变量或 stdin 传入（不接受命令行参数）');
      return 2;
    }
    let resolved;
    try {
      resolved = models.resolveConfig(vendor, {
        workspace_id: val('--workspace-id'),
        region: val('--region'),
        key_type: val('--key-type')
      });
    } catch (e) {
      console.error(e.message);
      return e.code === 'unknown_vendor' ? 4 : 2;
    }
    const vr = await models.verifyKey(vendor, key, resolved);
    if (!vr.ok) {
      out({
        ok: false, vendor: id, reason: 'verify_failed', status: vr.status, error: vr.error,
        note: '验证失败，未保存；请检查 key / 地域 / WorkspaceId / key 类型（百炼 key 按地域绑定）'
      });
      return 5;
    }
    const w = await models.vaultAdd(item, key, 'srvprice client 保存用户自己的模型 key（已验证）');
    out({
      ok: w.ok, vendor: id, item: item.name, masked: models.maskKey(key),
      model_count: vr.model_count, message: w.ok ? null : w.message
    });
    return w.ok ? 0 : 6;
  }

  if (cmd === 'flows') {
    const flows = loadFlows(cfg.flowsDir());
    let bad = 0;
    for (const f of flows) {
      const ok = f.errors.length === 0;
      if (!ok) bad++;
      console.log(`${ok ? 'OK ' : 'ERR'} ${path.basename(f.file)}` +
        (f.flow ? `  ${f.flow.id}@v${f.flow.version} (${f.flow.status})` : ''));
      for (const e of f.errors) console.log(`    - ${e}`);
    }
    return bad ? 1 : 0;
  }

  if (cmd === 'say') {
    const text = args.slice(1).filter((a) => !String(a).startsWith('--')).join(' ').trim();
    const plan = intentlib.route(text);
    const resolved = plan.target === 'client'
      ? { bin: process.execPath, argv: [__filename, ...plan.args] }
      : plan.target === 'srvprice' ? { bin: process.env.SRVPRICE_CLI_BIN || 'srvprice', argv: plan.args }
        : null;
    const payload = Object.assign({}, plan, {
      command: resolved ? [resolved.bin, ...resolved.argv].join(' ') : null
    });
    if (!has('--run') || !resolved) {
      out(payload);
      return resolved ? 0 : 2;
    }
    const r = spawnSync(resolved.bin, resolved.argv, { stdio: 'inherit', windowsHide: true });
    return r.status == null ? 1 : r.status;
  }

  if (cmd === 'record') {
    const sub = args[1];
    if (sub === 'start') {
      const id = String(val('--id', '') || '');
      const r = await daemonPost('/record/start', { id }, 8000);
      out(r || { ok: false, error: '连不上本地桥' });
      return r && r.ok ? 0 : 6;
    }
    if (sub === 'stop') {
      const r = await daemonPost('/record/stop', {}, 8000);
      const count = (r && r.count) || 0;
      if (r && r.ok && count === 0) {
        process.stderr.write('警告：本次记录 0 条事件（扩展可能未注入，或页面操作未被监听）\n');
      }
      out({ ok: !!(r && r.ok), id: (r && r.id) || null, count });
      return r && r.ok ? 0 : 6;
    }
    if (sub === 'status') {
      const r = await daemonGet('/record/status');
      out(r || { ok: false, error: '连不上本地桥' });
      return 0;
    }
    console.log('用法：record start [--id vendor.task] | record stop | record status');
    return 2;
  }

  if (cmd === 'flow' && args[1] === 'save') {
    const id = args[2];
    if (!id) {
      console.log('用法：flow save <vendor.task> [--vendor x] [--title T]');
      return 2;
    }
    const st = await daemonGet('/record/status');
    const events = (st && Array.isArray(st.events)) ? st.events : [];
    if (!events.length) {
      console.log('没有可保存的记录：先 record start → 在页面操作 → record stop');
      return 4;
    }
    const vendor = String(val('--vendor', String(id).split('.')[0] || ''));
    const flow = eventsToFlow(events, {
      id, vendor,
      title: String(val('--title', id)),
      success: has('--success')
    });
    const errs = validateFlow(flow);
    if (errs.length) {
      out({ ok: false, id, errors: errs, flow });
      return 1;
    }
    const file = path.join(cfg.flowsDir(), `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(flow, null, 2) + '\n');
    out({
      ok: true, file, steps: flow.steps.length, status: flow.status,
      events: events.length, success: !!has('--success'),
      variables: Object.keys(flow.variables || {})
    });
    return 0;
  }

  if (cmd === 'flow' && args[1] === 'health') {
    const id = args[2];
    const h = flowhealth.load();
    out(id ? { id, health: h.flows[id] || null } : h);
    return 0;
  }

  if (cmd === 'flow' && args[1] === 'reset-health') {
    const id = args[2];
    if (!id) { console.log('用法：flow reset-health <id>'); return 2; }
    flowhealth.reset(id);
    out({ ok: true, id, reset: true });
    return 0;
  }

  if (cmd === 'flow' && args[1] === 'publish') {
    const id = args[2];
    if (!id) { console.log('用法：flow publish <id> --account <账号标签>'); return 2; }
    const account = String(val('--account', ''));
    if (!account) { console.log('需要 --account（账号标签，只存 hash）'); return 2; }
    const hit = loadFlows(cfg.flowsDir()).find((f) => f.flow && f.flow.id === id);
    if (!hit) { console.log(`没有找到流程：${id}`); return 4; }
    if (hit.errors.length) { out({ ok: false, id, errors: hit.errors }); return 1; }
    try {
      const r = await flowlib.publish(hit.flow, account);
      out(r);
      return 0;
    } catch (e) {
      console.log('共享库写入失败：' + String((e && e.message) || e));
      return 6;
    }
  }

  if (cmd === 'flow' && args[1] === 'lib') {
    const id = args[2];
    let s;
    try { s = await flowlib.summary(id); } catch (e) {
      console.log('共享库读取失败：' + String((e && e.message) || e));
      return 6;
    }
    if (id && !s) { console.log(`共享库里没有：${id}`); return 4; }
    out(s);
    return 0;
  }

  if (cmd === 'flow' && args[1] === 'pull') {
    const id = args[2];
    if (!id) { console.log('用法：flow pull <id> --yes'); return 2; }
    let merged;
    try { merged = await flowlib.pull(id); } catch (e) {
      console.log('共享库读取失败：' + String((e && e.message) || e));
      return 6;
    }
    if (!merged) { console.log(`共享库里没有：${id}`); return 4; }
    if (!has('--yes')) {
      out({ ok: false, id, status: merged.status, steps: merged.steps.length, error: '写回本地流程需要 --yes' });
      return 7;
    }
    const errs = validateFlow(merged);
    if (errs.length) { out({ ok: false, id, errors: errs }); return 1; }
    const file = path.join(cfg.flowsDir(), `${id}.json`);
    let backup = null;
    if (fs.existsSync(file)) {
      backup = `${file}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
      fs.copyFileSync(file, backup);
    }
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
    out({ ok: true, id, status: merged.status, steps: merged.steps.length, file, backup });
    return 0;
  }

  if (cmd === 'flow' && args[1] === 'promote') {
    const id = args[2];
    if (!id) {
      console.log('用法：flow promote <id> [--var k=v] --yes');
      return 2;
    }
    const flows = loadFlows(cfg.flowsDir());
    const hit = flows.find((f) => f.flow && f.flow.id === id);
    if (!hit) { console.log(`没有找到流程：${id}`); return 4; }
    if (hit.errors.length) { out({ ok: false, id, errors: hit.errors }); return 1; }
    const f = hit.flow;
    if (f.status === 'active') { out({ ok: true, id, status: 'active', note: '已经是 active' }); return 0; }
    if (!f.meta || !f.meta.recorded_success) {
      out({ ok: false, id, error: '没有成功信号：先 flow save --success 重新固化' });
      return 1;
    }
    const pv = parseVars();
    if (pv.error) { console.log(pv.error); return 2; }
    const rf = resolveFlowVars(f, pv.provided);
    if (rf.missing.length) {
      out({ ok: false, id, error: '缺少变量：promote 前先用 --var 做一次校验', missing: rf.missing });
      return 2;
    }
    const plan = planFlow(rf.flow);
    if (plan.unresolved_placeholders.length) {
      out({ ok: false, id, error: '仍有未替换变量', unresolved: plan.unresolved_placeholders });
      return 2;
    }
    if (!has('--yes')) {
      out({ ok: false, id, error: '提升为 active 需要 --yes', plan });
      return 7;
    }
    f.status = 'active';
    f.notes = String(f.notes || '') +
      ` 2026-11-21 promote：记录成功 + 计划校验通过（变量 ${JSON.stringify(rf.vars)}）。`;
    fs.writeFileSync(hit.file, JSON.stringify(f, null, 2) + '\n');
    out({ ok: true, id, status: 'active', file: hit.file, steps: (f.steps || []).length, variables: rf.vars });
    return 0;
  }

  if (cmd === 'flow') {
    const sub = args[1];
    if (sub !== 'run' || !args[2]) {
      console.log('用法：flow run <id> [--dry-run] [--var k=v ...] [--vars k=v,k2=v2]');
      console.log('      --allow-commands 执行 run_command 步骤（默认拒绝）；--allow-destructive 放行破坏性动词');
      console.log('      破坏性流程（destructive:true）必须用 --confirm <实例ID> 二次确认');
      console.log('      flow save <vendor.task> [--vendor x] [--title T]   # 把本机记录固化成草稿');
      return 2;
    }
    const wanted = args[2];
    const flows = loadFlows(cfg.flowsDir());
    const hit = flows.find((f) => f.flow && f.flow.id === wanted);
    if (!hit) {
      console.log(`没有找到流程：${wanted}`);
      return 4;
    }
    if (hit.errors.length) {
      out({ id: wanted, errors: hit.errors });
      return 1;
    }
    // 流程变量：--var k=v（可重复）/ --vars k=v,k2=v2
    const pv = parseVars();
    if (pv.error) { console.log(pv.error); return 2; }
    const rf = resolveFlowVars(hit.flow, pv.provided);
    const decl = hit.flow.variables || {};
    if (rf.missing.length) {
      if (!has('--execute') || has('--dry-run')) {
        out({
          mode: 'dry-run',
          flow: wanted,
          missing: rf.missing,
          variables: decl,
          note: '先用 --var k=v（可重复）或 --vars k=v,k2=v2 补齐参数'
        });
        return 0;
      }
      console.log(`缺参数：${rf.missing.join(', ')}（用 --var k=v 或 --vars k=v,k2=v2）`);
      return 2;
    }
    if (rf.unresolved.length) {
      if (!has('--execute') || has('--dry-run')) {
        out({ mode: 'dry-run', flow: wanted, unresolved: rf.unresolved, note: '仍有未替换变量' });
        return 0;
      }
      console.log(`变量未替换：${rf.unresolved.join(', ')}`);
      return 2;
    }
    const plan = planFlow(rf.flow);
    // 骨架阶段一律 dry-run：真正执行要等扩展连上 + vault 物化（第二期）
    if (!has('--execute')) {
      out({ mode: 'dry-run', plan, variables: rf.vars, note: '骨架阶段不执行；加 --execute 需要扩展已连接且凭据已物化' });
      return 0;
    }
    const total = (rf.flow.steps || []).length;
    const res = await runFlow(rf.flow, {
      bridge: { connected: () => true, exec: daemonExec },
      runCommand: has('--allow-commands')
        ? (cmd, o) => commandlib.run(cmd, o)
        : undefined,
      allowDestructive: has('--allow-destructive'),
      confirmValue: String(val('--confirm', '') || ''),
      onEvent: (e) => {
        state.appendEvent({ flow: hit.flow.id, ...e });
        const stepLabel = `第 ${(e.index || 0) + 1}/${total} 步 · ${e.step_id || ''}`;
        if (e.type === 'exec') {
          daemonOverlay({ title: hit.flow.title, step: stepLabel, message: '正在执行', status: 'running', id: e.step_id });
        } else if (e.type === 'needs_human') {
          daemonOverlay({ title: hit.flow.title, step: stepLabel, message: '需要你完成：' + e.step_id, status: 'waiting', ack: '我已完成', id: e.step_id });
        }
      }
    });
    // P3：健康度记账 + 连续失败自动降级（human_gate 不算失败）
    let entry = null;
    if (res.ok) {
      entry = flowhealth.success(wanted, rf.flow.version);
    } else if (res.reason === 'step_failed') {
      // 只对“页面/步骤真的失败”计数；bridge 未连、凭据缺失等环境问题不降级流程
      entry = flowhealth.failure(wanted, rf.flow.version, res);
    }
    if (entry && flowhealth.shouldDowngrade(entry)) {
      const hit2 = loadFlows(cfg.flowsDir())
        .find((x) => x.flow && x.flow.id === wanted && x.flow.version === rf.flow.version);
      if (hit2 && hit2.flow.status === 'active') {
        hit2.flow.status = 'draft';
        hit2.flow.notes = String(hit2.flow.notes || '') +
          ` 自动降级：v${rf.flow.version} 连续 ${entry.failures} 次失败（${res.reason} @ ${res.stoppedAt || '-'}）。`;
        fs.writeFileSync(hit2.file, JSON.stringify(hit2.flow, null, 2) + '\n');
        res.downgraded = { from: 'active', to: 'draft', failures: entry.failures };
        state.appendEvent({ flow: wanted, type: 'flow_downgraded', failures: entry.failures, reason: res.reason });
      }
    }
    out(res);
    return res.ok ? 0 : 6;
  }

  if (cmd === 'step') {
    const sub = args[1];
    if (sub !== 'run' || !args[2] || !args[3]) {
      console.log('用法：step run <flow-id> <step-id>');
      return 2;
    }
    const flows = loadFlows(cfg.flowsDir());
    const hit = flows.find((f) => f.flow && f.flow.id === args[2]);
    if (!hit) { console.log(`没有找到流程：${args[2]}`); return 4; }
    if (hit.errors.length) { out({ id: args[2], errors: hit.errors }); return 1; }
    const step = (hit.flow.steps || []).find((s) => s.step_id === args[3]);
    if (!step) { console.log(`没有找到步骤：${args[3]}`); return 4; }
    const total = (hit.flow.steps || []).length;
    const index = (hit.flow.steps || []).findIndex((s) => s.step_id === step.step_id);
    const label = `第 ${index + 1}/${total} 步 · ${step.step_id}`;

    if (step.human || step.sensitive) {
      // 人机门：在页面浮层里提示，用户点「我已完成」后桥会记下 ack（用 `ack` 查看）
      const ov = await daemonOverlay({
        title: hit.flow.title,
        step: label,
        message: '需要你完成：' + step.step_id,
        status: 'waiting',
        ack: '我已完成',
        id: step.step_id
      });
      out({ waiting: true, step_id: step.step_id, overlay: ov, note: '人机门：请在页面浮层点「我已完成」，然后用 ack 命令查看' });
      return has('--force') ? 0 : 7;
    }

    await daemonOverlay({
      title: hit.flow.title,
      step: label,
      message: '正在执行：' + (step.do && step.do.action),
      status: 'running',
      id: step.step_id
    });
    const before = await daemonState();
    const result = await daemonExec(step);
    // 导航类步骤：等 SPA 把页面渲染出来再往下走（否则下一步会在空页上点）
    if (result.ok && (step.do && (step.do.action === 'open' || step.do.action === 'navigate'))) {
      // 用注入探针判断页面是否渲染出来（不依赖 content script 的状态回传）
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        const p = await daemonPost('/probe', {}, 10000);
        const fr = (p && p.detail && p.detail.frames) || [];
        const top = fr.find((f) => f.frame_id === 0) || fr[0];
        if (top && String(top.text_sample || '').length > 80) break;
      }
      await new Promise((r) => setTimeout(r, 800));
    } else {
      await new Promise((r) => setTimeout(r, 600));
    }
    const after = await daemonState();
    await daemonOverlay({
      title: hit.flow.title,
      step: label,
      message: result.ok ? ('完成：' + (result.detail || '')) : ('失败：' + (result.error || '')),
      status: result.ok ? 'done' : 'fail',
      id: step.step_id
    });
    out({
      flow: hit.flow.id,
      step_id: step.step_id,
      action: step.do && step.do.action,
      result,
      before: before && before.state,
      after: after && after.state
    });
    state.appendEvent({ flow: hit.flow.id, step_id: step.step_id, ok: !!result.ok });
    return result.ok ? 0 : 6;
  }

  if (cmd === 'stt-set') {
    const patch = {};
    if (val('--cli')) patch.cli = String(val('--cli'));
    if (val('--model')) patch.model = String(val('--model'));
    if (!Object.keys(patch).length) {
      console.log('用法：stt-set --cli <whisper-cli/main.exe> --model <ggml-*.bin>');
      return 2;
    }
    out(stt.setConfig(patch));
    return 0;
  }

  if (cmd === 'listen') {
    if (has('--check')) {
      out(Object.assign(stt.status(), { recorder: recorder.status() }));
      return 0;
    }
    if (has('--devices')) {
      const r = await recorder.printDevices();
      out(r);
      return r.ok ? 0 : 6;
    }
    if (has('--mic')) {
      const maxSec = Number(val('--max', '30'));
      const silence = Number(val('--silence', '2000'));
      if (process.stderr.isTTY) {
        process.stderr.write('\u001b[2K🎤 请开始说话…（静默 ' + Math.round(silence / 1000) + ' 秒自动结束，Ctrl+C 停止）\n');
      }
      const dev = val('--device');
      const r = await recorder.listen({
        lang: val('--lang', 'zh'),
        debug: has('--debug'),
        backend: val('--backend'),
        model: val('--model'),
        device: dev === undefined ? undefined : Number(dev),
        maxMs: (Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 30) * 1000,
        silenceMs: Number.isFinite(silence) && silence >= 0 ? silence : 2000,
        finalWav: has('--final-wav'),
        keepWavDir: has('--keep-wav'),
        onPartial: process.stderr.isTTY && !has('--text')
          ? (t) => process.stderr.write('\r\u001b[2K… 识别中：' + t.slice(-60))
          : null
      });
      if (has('--text')) {
        if (r.ok) process.stdout.write(r.text + '\n');
        else console.error(r.error || r.reason || '没有识别出内容');
      } else {
        out(r);
      }
      return r.ok ? 0 : 3;
    }
    const file = val('--file');
    if (!file) {
      console.log('用法：listen --mic [--lang zh] [--max 30] [--silence 4000] [--text]');
      console.log('      listen --devices ｜ listen --file <wav> [--lang zh] ｜ listen --check');
      return 2;
    }
    const r = await stt.transcribe(file, { lang: val('--lang', 'zh') });
    out(r);
    return r.ok ? 0 : 6;
  }

  if (cmd === 'voice') {
    if (has('--check')) {
      out(await voiceCheck());
      return 0;
    }
    const text = args.slice(1).filter((a) => a !== '--check').join(' ').trim();
    if (!text) {
      console.log('用法：voice "<text>" ｜ voice --check');
      return 2;
    }
    const r = speak(text, 'done');
    console.log(JSON.stringify(r));
    return r.spoken ? 0 : 1;
  }

  console.log(`未知命令：${cmd}`);
  return 2;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
