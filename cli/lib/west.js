'use strict';

// 西部数码 弹性云服务器 API v2（https://api.west.cn/api/v2）
// 鉴权：token = md5(username + api_password + time)，time 为毫秒时间戳，token 10 分钟有效。
// 凭据只从环境变量读取（由 vault 注入），不落盘、不打印。
// 文档：https://www.west.cn/CustomerCenter/doc/server_v2.html（服务器业务 11 组接口）

const https = require('https');
const crypto = require('crypto');

const BASE = 'https://api.west.cn/api/v2';
const USER_ENV = 'SRVPRICE_WEST_USER';
const PASS_ENV = 'SRVPRICE_WEST_API_PASSWORD';

function creds() {
  // 兼容两种注入名：SRVPRICE_WEST_*（约定的物化变量）与 WEST_*（vault 条目原名）
  return {
    user: process.env[USER_ENV] || process.env.WEST_USERNAME || '',
    pass: process.env[PASS_ENV] || process.env.WEST_API_PASSWORD || ''
  };
}

function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function tokenFor(user, pass, time) {
  return md5(`${user}${pass}${time}`);
}

function decodeBody(buf) {
  // 文档：请求/返回使用 GB2312/GBK；取不到 gbk 解码器时退回 utf-8（关键字段是 ASCII）
  try { return new TextDecoder('gbk').decode(buf); } catch (_) { return buf.toString('utf8'); }
}

function request(pathname, query, timeout = 20000) {
  const { user, pass } = creds();
  if (!user || !pass) {
    return Promise.reject(new Error(
      `缺西部数码凭据：设置 ${USER_ENV} / ${PASS_ENV}（vault 物化时注入）`));
  }
  const time = String(Date.now());
  const params = new URLSearchParams(Object.assign({}, query, {
    username: user,
    time,
    token: tokenFor(user, pass, time)
  }));
  const url = `${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}${params.toString()}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = decodeBody(Buffer.concat(chunks));
        let j = null;
        try { j = JSON.parse(text); } catch (_) {
          reject(new Error(`西部 API 返回非 JSON：${text.slice(0, 200)}`));
          return;
        }
        if (Number(j.result) !== 200) {
          reject(new Error(`西部 API 失败：${j.msg || ('result=' + j.result)}`));
          return;
        }
        resolve(j.data === undefined ? j : j.data);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('西部 API 超时')); });
    req.on('error', reject);
  });
}

// 获取服务器列表：GET /server/?act=list&pageno=&limit=&serverroom=
function listServers(opts = {}) {
  const q = { act: 'list', pageno: String(opts.pageno || 1), limit: String(opts.limit || 100) };
  if (opts.serverroom) q.serverroom = String(opts.serverroom);
  return request('/server/', q, opts.timeout);
}

// 机房 ID → 名称（GET /server/config/?act=base 的 data.room[]）；失败不影响列表
let _roomCache = null;
async function roomNames(opts = {}) {
  if (_roomCache) return _roomCache;
  try {
    const d = await request('/server/config/', { act: 'base' }, opts.timeout);
    const map = {};
    for (const r of (d && d.room) || []) map[String(r.roomid)] = r.roomname;
    _roomCache = map;
    return map;
  } catch (_) {
    return {};
  }
}

// 服务器详情：GET /server/manager/?act=info（ip 或 id 二选一，优先 id）
function detail(opts = {}) {
  const q = { act: 'info' };
  if (opts.id) q.id = String(opts.id);
  else if (opts.ip) q.ip = String(opts.ip);
  else return Promise.reject(new Error('detail 需要 id 或 ip'));
  return request('/server/manager/', q, opts.timeout);
}

// ---- 安全组（防火墙）API v2 ----
// 文档：server_v2.html「安全组相关」；全部为 GET
//   act=list          安全组列表
//   act=add           name(可空) + memo(必填)
//   act=gropurules    按 groupid 取规则
//   act=addgrouprule  加规则（proto 小写；srcip_type 0=所有/1=指定IP/2=IP段；
//                     porttype 0=指定端口/1=端口范围；action=pass|block；priority 1-1024）
//   act=setgroupip    groupid + sip(服务器IP) + actcmd 1=部署/0=取消部署
function listFirewallGroups(opts = {}) {
  return request('/server/firewallgroup/', {
    act: 'list',
    pageno: String(opts.pageno || 1),
    limit: String(opts.limit || 100)
  }, opts.timeout);
}

function addFirewallGroup(opts = {}) {
  if (!opts.name) return Promise.reject(new Error('addFirewallGroup 需要 name（文档写可选，实测必填）'));
  // 注意：该 API 按 GBK 解析 query；参数里出现中文会把后面的 username/token 一并带崩
  if (/[^\x00-\x7F]/.test(String(opts.name)) || /[^\x00-\x7F]/.test(String(opts.memo || ''))) {
    return Promise.reject(new Error('安全组 name/memo 只能用 ASCII（中文会让接口丢鉴权参数）'));
  }
  const q = { act: 'add', name: String(opts.name) };
  if (opts.memo) q.memo = String(opts.memo);
  return request('/server/firewallgroup/', q, opts.timeout);
}

function groupRules(opts = {}) {
  const q = { act: 'gropurules' };
  if (opts.groupid) q.groupid = String(opts.groupid);
  return request('/server/firewallgroup/', q, opts.timeout);
}

function addGroupRule(opts = {}) {
  if (!opts.groupid) return Promise.reject(new Error('addGroupRule 需要 groupid'));
  const proto = String(opts.proto || 'tcp').toLowerCase();
  if (!['tcp', 'udp', 'icmp'].includes(proto)) {
    return Promise.reject(new Error(`proto 只支持 tcp/udp/icmp（收到 ${opts.proto}）`));
  }
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(new Error(`port 非法：${opts.port}`));
  }
  const srcType = Number(opts.srcip_type === undefined ? 1 : opts.srcip_type);
  if (![0, 1, 2].includes(srcType)) return Promise.reject(new Error('srcip_type 只能是 0/1/2'));
  if (srcType === 1 && !opts.srcip) return Promise.reject(new Error('srcip_type=1 需要 srcip'));
  if (srcType === 0 && !opts.allow_all) {
    return Promise.reject(new Error('拒绝默认放开所有来源：显式传 allow_all=true 并确认'));
  }
  const action = String(opts.action || 'pass').toLowerCase();
  if (!['pass', 'block'].includes(action)) return Promise.reject(new Error('action 只能是 pass/block'));
  const priority = Number(opts.priority || 10);
  if (!Number.isInteger(priority) || priority < 1 || priority > 1024) {
    return Promise.reject(new Error('priority 须在 1-1024'));
  }
  return request('/server/firewallgroup/', {
    act: 'addgrouprule',
    groupid: String(opts.groupid),
    proto,
    srcip_type: String(srcType),
    srcip: String(opts.srcip || '0.0.0.0'),
    porttype: '0',
    srcport: '0',
    srcport_max: '0',
    dstport: String(port),
    dstport_max: '0',
    priority: String(priority),
    action
  }, opts.timeout);
}

function deployGroup(opts = {}) {
  if (!opts.groupid) return Promise.reject(new Error('deployGroup 需要 groupid'));
  if (!opts.sip) return Promise.reject(new Error('deployGroup 需要 sip（服务器 IP）'));
  return request('/server/firewallgroup/', {
    act: 'setgroupip',
    groupid: String(opts.groupid),
    sip: String(opts.sip),
    actcmd: opts.enable === false ? '0' : '1'
  }, opts.timeout);
}

// 运行状态：GET /server/system/?act=status（按 ip）
// 状态码（文档原文）：0 正常运行 / 1 关机 / 2 管理员关机 / 3 暂停
function serverStatus(opts = {}) {
  if (!opts.ip) return Promise.reject(new Error('status 需要 ip'));
  return request('/server/system/', { act: 'status', ip: String(opts.ip) }, opts.timeout);
}

const STATUS_MAP = { 0: 'running', 1: 'stopped', 2: 'stopped', 3: 'stopped' };
const STATUS_LABEL = { 0: '正常运行', 1: '关机', 2: '管理员关机', 3: '暂停' };

function mapStatus(data) {
  const code = data && data.status !== undefined ? Number(data.status) : NaN;
  return {
    status: STATUS_MAP[code] !== undefined ? STATUS_MAP[code] : null,
    status_code: Number.isNaN(code) ? null : code,
    status_info: (data && data.info) || STATUS_LABEL[code] || null
  };
}

// 云快照列表：GET /server/hostsnap/?act=list（按 ip）
function snapshots(opts = {}) {
  if (!opts.ip) return Promise.reject(new Error('snapshots 需要 ip'));
  return request('/server/hostsnap/', { act: 'list', ip: String(opts.ip) }, opts.timeout);
}

// 快照归一化（只读展示，不猜）：类型 0-普通 1-高级 2-自定义
function mapSnapshots(data) {
  const d = data || {};
  const type = Number(d.snapadv);
  const TYPES = { 0: '普通', 1: '高级', 2: '自定义' };
  return {
    type: TYPES[type] || null,
    type_code: Number.isNaN(type) ? null : type,
    period: d.snapperiod !== undefined ? Number(d.snapperiod) : null,
    left_month: d.leftmonth !== undefined ? Number(d.leftmonth) : null,
    expires_at: d.expiredate || null,
    activated_at: d.snapadvtime || null,
    os: Array.isArray(d.os) ? d.os : [],
    data_disk: Array.isArray(d.data) ? d.data : [],
    size: d.size !== undefined ? Number(d.size) : null,
    free_size: d.nopaysize !== undefined ? Number(d.nopaysize) : null,
    policy: d.snappolicy !== undefined ? Number(d.snappolicy) : null,
    keep_days: d.snaprules && d.snaprules.keepday ? String(d.snaprules.keepday) : null
  };
}

// 归一化成 srvprice host 结构（纯函数，便于测试）
// 真机字段（2026-11-20）：id / os / allocateip(公网IP) / serverroom(机房ID) / expdate / cpu / memory
function mapItems(items, fallbackRegion, rooms) {
  const roomMap = rooms || {};
  return (items || []).map((it) => {
    const id = it && it.id !== undefined && it.id !== null ? String(it.id) : '';
    const ip = (it && (it.allocateip || it.ip)) || null;
    const room = it && it.serverroom !== undefined ? String(it.serverroom) : '';
    return {
      id: `west:${id}`,
      provider: 'west',
      instance_id: id,
      name: (it && (it.freedomain || it.framedomain)) || ip || `west-${id}`,
      region: roomMap[room] || (it && it.roomname) || room || fallbackRegion || null,
      // 列表接口没有运行状态字段 —— 不猜，留空（详情接口可补）
      status: null,
      public_ipv4: ip,
      type: (it && it.os) || null
    };
  });
}

module.exports = {
  BASE, USER_ENV, PASS_ENV, creds, md5, tokenFor, request,
  listServers, roomNames, mapItems,
  detail, serverStatus, mapStatus, snapshots, mapSnapshots,
  listFirewallGroups, addFirewallGroup, groupRules, addGroupRule, deployGroup
};
