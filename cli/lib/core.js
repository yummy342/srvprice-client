'use strict';

// srvprice CLI 公共层：参数解析 / 输出契约 / 退出码 / 配置与凭据 / 数据装载。
// 零外部依赖，Node >= 18.17。

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = require('../package.json').version;

// 退出码表（v1 定死，见调研第 05 节）
const EXIT = {
  OK: 0,
  GENERAL: 1,        // 通用失败
  USAGE: 2,          // 参数 / 用法错误
  STALE: 3,          // 数据过期或不可用（可重试）
  NOT_FOUND: 4,      // 未找到
  CRED: 5,           // 凭据缺失或失效（指明哪家厂商）
  VENDOR: 6,         // 厂商侧拒绝 / 厂商错误
  UNCONFIRMED: 7,    // 写操作未确认而阻断
  INTERRUPT: 130     // 中断
};

class CliError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'CliError';
    this.exitCode = code;
    Object.assign(this, extra || {});
  }
}

const EXIT_HELP = `退出码：0 成功 / 1 通用失败 / 2 参数错误 / 3 数据过期或不可用 / 4 未找到 /
5 凭据缺失或失效 / 6 厂商侧错误 / 7 写操作未确认而阻断 / 130 中断`;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set([
  'yes', 'dry-run', 'refresh', 'explain', 'no-open', 'new-user-only', 'include-expired',
  'wait', 'no-color', 'help', 'version', 'introspect', 'verbose', 'quiet', 'json',
  'force', 'all-providers', 'no-header', 'local-only', 'bundled', 'deploy'
]);

const SHORT_FLAGS = { '-o': 'output', '-h': 'help', '-v': 'version', '-y': 'yes', '-q': 'quiet' };

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function parseArgs(argv) {
  const words = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    let a = argv[i];
    if (a === '--') { words.push(...argv.slice(i + 1)); break; }
    if (SHORT_FLAGS[a]) { a = '--' + SHORT_FLAGS[a]; }
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      const key = camel(name);
      if (BOOL_FLAGS.has(name)) {
        opts[key] = value === undefined ? true : value !== 'false';
        i += 1;
        continue;
      }
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) { value = next; i += 2; } else { value = true; i += 1; }
      } else {
        i += 1;
      }
      // 重复的 --id / --provider 收集为数组
      if (key === 'id' || key === 'provider') {
        if (opts[key] === undefined) opts[key] = [];
        else if (!Array.isArray(opts[key])) opts[key] = [opts[key]];
        opts[key].push(value);
      } else {
        opts[key] = value;
      }
      continue;
    }
    words.push(a);
    i += 1;
  }
  return { words, opts };
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// 输出契约：--output auto|json|text
// ---------------------------------------------------------------------------

function outMode(opts, config) {
  const want = opts.output && opts.output !== true ? String(opts.output).toLowerCase() : null;
  if (want && want !== 'auto') {
    if (want !== 'json' && want !== 'text') {
      throw new CliError(EXIT.USAGE, `--output 只接受 json / text / auto（收到 ${want}）`);
    }
    return want;
  }
  if (want === 'auto') return process.stdout.isTTY ? 'text' : 'json';
  const configured = config.output || 'auto';
  if (configured !== 'auto') return configured;
  // 默认：管道/重定向走 json，终端走 text——agent 拿到的永远是结构化输出
  return process.stdout.isTTY ? 'text' : 'json';
}

function makeIO(opts, config) {
  const mode = outMode(opts, config);
  const json = mode === 'json';
  const color = !opts.noColor && process.stdout.isTTY && !!process.env.TERM && !process.env.NO_COLOR;

  return {
    mode,
    json,
    color,
    // stdout 只放业务结果
    data(payload) {
      if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      else process.stdout.write(renderText(payload) + '\n');
    },
    raw(text) {
      process.stdout.write(text + '\n');
    },
    // stderr：诊断 / 警告 / 进度，JSON 模式走 JSONL
    warn(message, extra) {
      if (json) {
        process.stderr.write(JSON.stringify(Object.assign({ level: 'warn', message }, extra || {})) + '\n');
      } else if (!opts.quiet) {
        process.stderr.write(`warning: ${message}\n`);
      }
    },
    info(message, extra) {
      if (json) {
        process.stderr.write(JSON.stringify(Object.assign({ level: 'info', message }, extra || {})) + '\n');
      } else if (!opts.quiet) {
        process.stderr.write(`${message}\n`);
      }
    }
  };
}

// text 模式下把统一对象渲染成可读表格。列表型 payload 约定 { rows, columns }。
function renderText(payload) {
  if (payload && Array.isArray(payload.rows) && Array.isArray(payload.columns)) {
    return renderTable(payload.rows, payload.columns, payload.footer);
  }
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && typeof payload.text === 'string') return payload.text;
  return JSON.stringify(payload, null, 2);
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    // CJK 及全角符号按 2 列
    w += (cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}

function pad(s, width) {
  const d = width - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function renderTable(rows, columns, footer) {
  if (!rows.length) return '（无结果）';
  const widths = columns.map((c) => Math.max(
    displayWidth(c.label),
    ...rows.map((r) => displayWidth(cellText(r, c)))
  ));
  const lines = [];
  lines.push(columns.map((c, i) => pad(c.label, widths[i])).join('  ').replace(/\s+$/, ''));
  lines.push(columns.map((c, i) => '-'.repeat(widths[i])).join('  '));
  for (const r of rows) {
    lines.push(columns.map((c, i) => pad(cellText(r, c), widths[i])).join('  ').replace(/\s+$/, ''));
  }
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

function cellText(row, col) {
  const v = col.get ? col.get(row) : row[col.key];
  if (v === undefined || v === null || v === '') return col.null || '—';
  return String(v);
}

// ---------------------------------------------------------------------------
// 配置（选购偏好）与凭据（厂商密钥）——两个文件，语义严格分开
// ---------------------------------------------------------------------------

function homeDir() {
  return process.env.SRVPRICE_HOME || path.join(os.homedir(), '.srvprice');
}

const CONFIG_PATH = () => path.join(homeDir(), 'config.json');
const CREDS_PATH = () => path.join(homeDir(), 'credentials.json');
const CACHE_DIR = () => path.join(homeDir(), 'cache');

const DEFAULT_PROFILE = {
  currency: 'CNY',
  default_region: null,
  providers: [],
  default_term: '1y',
  new_user_only: false,
  read_only: false,        // true = 任何厂商写操作一律拒绝（配只读 key 时用，凭据 + 策略双保险）
  output: 'auto',
  language: 'zh',
  stale_hours: 24
};

function ensureDir(dir, mode) {
  fs.mkdirSync(dir, { recursive: true });
  if (mode) { try { fs.chmodSync(dir, mode); } catch (_) { /* Windows 上无实际效果 */ } }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CliError(EXIT.GENERAL, `配置文件读取失败：${file}（${e.message}）`);
  }
}

function writeJson0600(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows */ }
}

function loadConfig() {
  const raw = readJsonSafe(CONFIG_PATH()) || {};
  const profiles = Object.assign({ default: Object.assign({}, DEFAULT_PROFILE) }, raw.profiles || {});
  if (!profiles.default) profiles.default = Object.assign({}, DEFAULT_PROFILE);
  for (const k of Object.keys(profiles)) {
    profiles[k] = Object.assign({}, DEFAULT_PROFILE, profiles[k]);
  }
  return {
    version: raw.version || 1,
    active_profile: raw.active_profile || 'default',
    profiles
  };
}

function saveConfig(cfg) {
  writeJson0600(CONFIG_PATH(), cfg);
}

// 优先级：--profile > SRVPRICE_PROFILE > 激活配置 > default
function resolveProfile(config, opts) {
  const name = (opts.profile && opts.profile !== true ? String(opts.profile) : null)
    || process.env.SRVPRICE_PROFILE
    || config.active_profile
    || 'default';
  const source = (opts.profile && opts.profile !== true) ? 'flag'
    : (process.env.SRVPRICE_PROFILE ? 'env' : (name === config.active_profile ? 'active' : 'default'));
  const values = config.profiles[name];
  if (!values) {
    throw new CliError(EXIT.NOT_FOUND, `选购 profile 不存在：${name}（用 srvprice config list 查看）`);
  }
  return { name, source, values };
}

function loadCreds() {
  const raw = readJsonSafe(CREDS_PATH()) || {};
  return { version: raw.version || 1, vendors: raw.vendors || {} };
}

function saveCreds(creds) {
  writeJson0600(CREDS_PATH(), creds);
}

function fileMode(file) {
  try { return (fs.statSync(file).mode & 0o777).toString(8); } catch (_) { return null; }
}

function mask(secret) {
  if (!secret) return null;
  const s = String(secret);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 数据装载（内置快照 + 本机缓存）
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILES = { plans: 'plans.json', deals: 'deals.json', providers: 'providers.json', promos: 'promos.json', setup: 'setup.json' };

function dataOrigin(name) {
  return process.env[`SRVPRICE_DATA_DIR`] || DATA_DIR;
}

function cachePath(name) {
  return path.join(CACHE_DIR(), DATA_FILES[name]);
}

// 推广码占位符：仓库里只存占位符，真实值运行时从环境变量注入（可由 vault-cli run 提供）
const URL_PLACEHOLDERS = {
  YOUR_CPS_KEY: { env: 'SRVPRICE_TENCENT_CPS_KEY', label: '腾讯 CPS key' },
  YOUR_REFERENCE_ID: { env: 'SRVPRICE_WEST_REFERENCE_ID', label: '西部数码代理/推荐 ID' }
};
const _warnedPlaceholders = new Set();

function resolvePlaceholders(value) {
  if (typeof value === 'string') {
    let s = value;
    for (const [ph, meta] of Object.entries(URL_PLACEHOLDERS)) {
      if (!s.includes(ph)) continue;
      const injected = process.env[meta.env];
      if (injected) {
        s = s.split(ph).join(injected);
      } else if (!_warnedPlaceholders.has(ph)) {
        _warnedPlaceholders.add(ph);
        process.stderr.write(JSON.stringify({
          level: 'warn',
          message: `${meta.label} 未注入（环境变量 ${meta.env}），链接中的 ${ph} 保持占位`
        }) + '\n');
      }
    }
    return s;
  }
  if (Array.isArray(value)) return value.map(resolvePlaceholders);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v);
    return out;
  }
  return value;
}

function loadData(name) {
  const file = DATA_FILES[name];
  if (!file) throw new CliError(EXIT.GENERAL, `未知数据表：${name}`);
  const cached = readJsonSafe(cachePath(name));
  const origin = cached || readJsonSafe(path.join(dataOrigin(name), file));
  if (!origin) throw new CliError(EXIT.STALE, `数据表缺失：${file}`);
  return resolvePlaceholders(Object.assign({ _source: cached ? 'cache' : 'bundled' }, origin));
}

// 价格数据新鲜度检查：超过 stale_hours 在 stderr 警告，不阻断
function checkFreshness(io, records, staleHours, label) {
  const dates = records.map((r) => r.verified_at).filter(Boolean).sort();
  if (!dates.length) return { newest: null, age_hours: null, stale: true };
  const newest = dates[dates.length - 1];
  const ageMs = Date.now() - new Date(`${newest}T00:00:00Z`).getTime();
  const ageHours = Math.round(ageMs / 3600000);
  const stale = ageHours > staleHours;
  if (stale) {
    io.warn(
      `${label}数据最新核验于 ${newest}，已超过 ${staleHours} 小时；价格以厂商官网实时价为准，可用 --refresh 尝试更新`,
      { verified_at: newest, age_hours: ageHours, stale_hours: staleHours }
    );
  }
  return { newest, age_hours: ageHours, stale };
}

const API_BASE = (process.env.SRVPRICE_API || 'https://www.srvprice.com').replace(/\/+$/, '');

// 数据同源：客户端不另起一套数据源，直接读站点的公开接口。
// plans → /api/server-snapshot（30 条周快照）；deals/其他表暂无接口，保留内置快照。
async function refreshData(io, name) {
  if (name !== 'plans') {
    io.warn(`「${name}」暂无可刷新的公开接口，继续使用内置快照`);
    return false;
  }
  const url = `${API_BASE}/api/server-snapshot`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.items) || !doc.items.length) {
      throw new Error('快照返回结构不对');
    }
    const { snapshotToPlans } = require('./snapshot');
    const out = snapshotToPlans(doc);
    ensureDir(CACHE_DIR(), 0o700);
    writeJson0600(path.join(CACHE_DIR(), DATA_FILES.plans), out);
    io.info(`已从站点快照更新 ${out.plans.length} 条（数据日 ${out.snapshot_date || '未知'}）`);
    return true;
  } catch (e) {
    // 降级必须说清楚用的是哪天的快照，不能只报「继续使用内置快照」
    let snap = null;
    try { snap = loadData('plans').snapshot_date || null; } catch (_) { /* 数据也读不到时只报地址 */ }
    io.warn(
      `数据刷新失败（${url}）：${e.message}；继续使用内置/缓存快照` +
      (snap ? `（数据日 ${snap}，可能已过期，下单前请核对官网）` : ''),
      { stale_snapshot: snap, url }
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function paging(rows, opts) {
  const page = Math.max(1, parseInt(opts.page || '1', 10) || 1);
  const size = Math.max(1, parseInt(opts.pageSize || '20', 10) || 20);
  const start = (page - 1) * size;
  return {
    page,
    page_size: size,
    total: rows.length,
    has_more: start + size < rows.length,
    items: rows.slice(start, start + size)
  };
}

function confirmPrompt(question) {
  // 只在 TTY 下调；非 TTY 一律视为未确认，由调用方转成退出码 7
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(false);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer).trim()));
    });
  });
}

function readSecretHidden(promptText) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(wasRaw || false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') { // Ctrl-C
          stdin.setRawMode(wasRaw || false);
          process.stderr.write('\n');
          process.exit(EXIT.INTERRUPT);
        }
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

module.exports = {
  VERSION,
  EXIT,
  EXIT_HELP,
  CliError,
  parseArgs,
  asArray,
  makeIO,
  outMode,
  renderTable,
  homeDir,
  CONFIG_PATH,
  CREDS_PATH,
  CACHE_DIR,
  DEFAULT_PROFILE,
  loadConfig,
  saveConfig,
  resolveProfile,
  loadCreds,
  saveCreds,
  fileMode,
  mask,
  loadData,
  dataOrigin,
  cachePath,
  checkFreshness,
  refreshData,
  nowIso,
  todayIso,
  paging,
  confirmPrompt,
  readSecretHidden,
  ensureDir,
  writeJson0600
};
