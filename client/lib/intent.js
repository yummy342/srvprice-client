'use strict';

// 一句话意图路由（确定性规则，无 LLM）。
// 输出：{intent, target:'client'|'srvprice', args, human_gate, needs, reason}
// 只做“建议命令”，不在这里执行；执行由 CLI 的 `say --run` 或宿主决定。

const VENDORS = [
  ['火山', 'volcengine'], ['volcengine', 'volcengine'],
  ['阿里', 'aliyun'], ['阿里云', 'aliyun'], ['aliyun', 'aliyun'],
  ['腾讯', 'tencent'], ['tencent', 'tencent'],
  ['百度', 'baidu'], ['baidu', 'baidu'],
  ['京东', 'jdcloud'], ['jdcloud', 'jdcloud'],
  ['天翼', 'ctyun'], ['ctyun', 'ctyun'],
  ['ucloud', 'ucloud'], ['云极', 'ucloud'],
  ['西部', 'west'], ['西部数码', 'west'], ['west', 'west']
];

function detectVendor(text) {
  const t = String(text || '').toLowerCase();
  let best = null;
  for (const [word, id] of VENDORS) {
    if (t.includes(word.toLowerCase())) {
      if (!best || word.length > best.word.length) best = { word, id };
    }
  }
  return best ? best.id : null;
}

function detectCidr(text) {
  const m = String(text || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/);
  return m ? m[0] : null;
}

function detectPort(text) {
  const t = String(text || '');
  const m = t.match(/(?:端口|放通|开放|开)\s*[:：]?\s*(\d{2,5})/) || t.match(/(\d{2,5})\s*(?:端口|端口号)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 65535 ? n : null;
}

// 只看带常见后缀的域名，避免把版本号/IP 误当域名
function detectDomain(text) {
  const m = String(text || '').toLowerCase()
    .match(/\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|cn|net|org|io|xyz|top|site|cc|ai|dev|app|co))\b/);
  return m ? m[1] : null;
}

// 套餐 ID 形如 ali-ecs99 / uc-kj-cn-new：字母开头、带连字符
function detectPlanId(text) {
  const m = String(text || '').match(/(?:^|\s)([a-z]{2,12}(?:-[a-z0-9]{1,20}){1,4})(?=\s|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function groupNameFor(ip, port) {
  return `srvprice-${String(ip || '').replace(/[^0-9a-zA-Z]+/g, '-').replace(/^-|-$/g, '')}-${port}`;
}

function route(text) {
  const t = String(text || '').trim();
  const vendor = detectVendor(t);
  const cidr = detectCidr(t);
  const port = detectPort(t);
  const domain = detectDomain(t);

  const out = (intent, target, args, extra) => Object.assign({
    intent, target, args, vendor, cidr, port,
    human_gate: 'none',
    reason: ''
  }, extra || {});

  if (!t) return out('unknown', null, null, { reason: '空输入' });

  // 资源列表
  if (/(有哪些|列表|列出|看看|查一下|查看).*(机器|服务器|实例|资源)|(机器|服务器|实例|资源).*(列表|有哪些)/.test(t)) {
    const args = ['list', '--json'];
    if (vendor) args.push('--provider', vendor);
    return out('list', 'client', args, { reason: vendor ? `查 ${vendor} 资源` : '查资源列表' });
  }

  // 域名比价（站点实时接口）
  if (domain && /(比价|域名|价格|多少钱|续费|注册)/.test(t)) {
    return out('compare', 'client', ['compare', domain, '--json'],
      { reason: `域名 ${domain} 各渠道首年/续费比价` });
  }

  // 买某个具体套餐：话里带套餐 ID 时走购买 pipeline（只出摘要，打开官网要 --yes）
  const planId = detectPlanId(t);
  if (planId && /(买|购买|下单|开通)/.test(t)) {
    return out('purchase', 'client', ['purchase', 'show', planId],
      { human_gate: 'payment', reason: `购买套餐 ${planId}：先看摘要，打开厂商官网要再加 --yes` });
  }

  // 服务器价格快照（本周优惠价；不含“买/链接”，那是购买路径）
  if (/(价格|多少钱|特价|秒杀|降价|优惠)/.test(t) &&
      /(服务器|云|主机|套餐)/.test(t) &&
      !/(买|购买|链接|下单)/.test(t)) {
    const args = ['prices', '--json'];
    if (vendor) args.push('--vendor', vendor);
    return out('prices', 'client', args, { reason: vendor ? `查 ${vendor} 价格快照` : '查本周快照价格' });
  }

  // 开端口
  if (/(开端口|放通|开放.*端口|端口.*开放|开\s*\d{1,5}\s*端口)/.test(t)) {
    if (!vendor) return out('open_port', null, null, { reason: '需要厂商，例如：阿里开 3389 端口给 1.2.3.4' });
    if (!port) return out('open_port', null, null, { reason: '需要端口号，例如：开 3389 端口' });
    if (!cidr) return out('open_port', null, null, { reason: '需要来源 IP/CIDR，例如：给 1.2.3.4 开' });
    const flowId = `${vendor}.open_port`;
    const args = ['flow', 'run', flowId, '--dry-run',
      '--var', `group_name=${groupNameFor(cidr.split('/')[0], port)}`,
      '--var', `source_cidr=${cidr.includes('/') ? cidr : cidr + '/32'}`];
    return out('open_port', 'client', args, {
      human_gate: 'flow', reason: '浏览器流程：新建安全组 + 限源端口（默认 dry-run）'
    });
  }

  // 建只读账号 / 配 key
  if (/(只读|子账号|建账号|新建用户|配.*key|凭据)/.test(t)) {
    if (!vendor) return out('create_readonly_user', null, null, { reason: '需要厂商，例如：给火山建一个只读账号' });
    return out('create_readonly_user', 'client',
      ['flow', 'run', `${vendor}.create_readonly_user`, '--dry-run'],
      { human_gate: 'flow', reason: '浏览器流程：建只读子账号（人工只做登录/短信）' });
  }

  // 删机 / 释放实例
  if (/(删|释放|销毁|退掉)/.test(t) &&
      (/(机|实例|服务器)/.test(t) || /\b(?:i|ins)-[0-9a-z]{6,}\b/i.test(t))) {
    const v = vendor || 'volcengine';
    const iid = (t.match(/\b(?:i|ins)-[0-9a-z]{6,}\b/i) || [])[0] || '';
    if (!iid) return out('destroy_instance', null, null, { reason: '需要实例 ID，例如：删掉火山的 i-xxxx' });
    return out('destroy_instance', 'client',
      ['flow', 'run', `${v}.destroy_instance`, '--dry-run', '--var', `instance_id=${iid}`],
      { human_gate: 'destroy', reason: '删除实例：终端二次确认 + 页面最终确认，不自动做快照' });
  }

  // 开服务器 / 创建实例
  if (/(开|创建|新建|建).*(服务器|实例|机器)/.test(t)) {
    const v = vendor || 'volcengine';
    return out('create_instance', 'client',
      ['flow', 'run', `${v}.create_instance`, '--dry-run'],
      { human_gate: 'flow', reason: '创建实例：配置到付款前，密码与付款由人完成' });
  }

  // 推广 / 返佣
  if (/(推广|返佣|联盟|代理|大使)/.test(t)) {
    return out('promo', 'srvprice', ['promo', 'list'], { reason: '变现线只读查询' });
  }

  // 购买链接 / 走优惠
  if (/(买|购买|优惠|链接|下单)/.test(t)) {
    const args = ['buy', 'url'];
    if (vendor) args.push('--provider', vendor);
    return out('buy', 'srvprice', args, { human_gate: 'payment', reason: '只给推广链接，不代下单' });
  }

  // 找服务器 / 选型
  if (/(找|选|推荐|便宜|性价比).*(服务器|机器|主机)|服务器.*(推荐|怎么选)/.test(t)) {
    return out('recommend', 'srvprice', ['recommend', '--explain'], { reason: '选型推荐' });
  }

  return out('unknown', null, null, { reason: '没听懂：可以问“我有哪些机器”“给阿里开 3389 端口给 1.2.3.4”' });
}

module.exports = { route, detectVendor, detectCidr, detectPort, detectDomain, groupNameFor };
