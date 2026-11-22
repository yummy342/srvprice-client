#!/usr/bin/env node
'use strict';

// srvprice 集成 CLI — 两条线：
//   选购线（只读，零凭据）：plan / recommend / deal / provider / buy / setup / config
//   主机线（经适配层转发厂商 CLI）：host / vendor
//
// 为 agent 设计：默认非交互；非 TTY 时默认输出 JSON；stdout 只放业务结果，
// 诊断与警告走 stderr（JSON 模式下为 JSONL）；退出码固定。


const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const core = require('../lib/core');
const hostlib = require('../lib/host');
const westlib = require('../lib/west');
const firewall = require('../lib/firewall');
const smslib = require('../lib/sms');

const { EXIT, CliError, asArray } = core;

const HELP = `srvprice ${core.VERSION} — 跨厂商服务器选购比价与主机操作

用法：srvprice <命令> [子命令] [选项]

选购线（只读，无需凭据）
  plan list            列出套餐（--provider --cpu --mem --region --budget-max --new-user-only）
  plan get --id        查看单个套餐
  plan compare --id    并排对比多个套餐（--id 可重复）
  recommend            按需求推荐（--use-case blog|app|game|ai --budget --region --visitors --explain）
  recommend wizard     交互式问答（仅终端可用）
  deal list            优惠活动（--provider --new-user-only --ends-before --include-expired）
  deal get --id        查看单个活动
  provider list        厂商与渠道入口
  provider get --name  单家厂商详情
  promo list           变现线概览：联盟推广 / 代理商（--line affiliate|agent --status ready|apply|none|unknown）
  promo get --name     单家厂商的变现线详情、待办与未核实项
  promo actions        汇总待办动作（--line --status），与 providers.json 的链接对账
  promo sync           拉站点 /api/promos 到本机缓存；无接口时降级为本地对账（--local-only --stale-days N）
  promo link show|set|unset   维护客户侧推广链接（默认写本机缓存；--bundled 写仓库数据并自动备份）
  buy url --plan-id|--provider   只打印购买/推广链接（--provider 用于无套餐数据的厂商）
  buy open --plan-id|--provider  打印摘要并打开浏览器（--no-open 只打印）
  setup list           购后维护指引目录
  setup show <主题>    查看指引步骤（open-port / ssh-key / swap / docker-install / icp-filing）
  config show|list|use|set|reset   选购偏好 profile（不含厂商凭据）

主机线（经适配层转发厂商 CLI，用用户自己的厂商账号）
  vendor list          各厂商 CLI 安装情况与接入方式
  vendor add --name    录入厂商 API 密钥（交互输入或环境变量，不走命令行参数）
  vendor status        逐厂商校验 CLI 与凭据
  vendor remove --name 删除某厂商凭据（需确认）
  host list            跨厂商列出服务器（--provider --region --status）
  host status --id     单台详情
  host start|stop|reboot --id [--wait] [--yes] [--dry-run]
  host wait --id --until running|stopped
  host snapshots --id  云快照列表（目前仅西部数码，只读）
  host open-port --ip --port --source   开端口：west（可 --deploy）/ aliyun / tencent / volcengine / baidu / jdcloud / ctyun
                                        默认只出计划；写操作需 --yes；三家新云不绑定实例

通知线（需短信服务商凭据）
  sms status          查看短信配置（~/.srvprice/sms.json 或 SMS_* 环境变量）
  sms send --text     发送短信（--to 手机号，可重复；默认配置里的 phones；--dry-run 只签名不发送）
  sms config          打印配置模板与路径

全局选项
  --output json|text|auto   默认 auto：终端 text、管道 json
  --page N --page-size N    分页
  --refresh                 尝试从站点刷新数据快照
  --profile <名>            选购偏好 profile（也可用 SRVPRICE_PROFILE）
  --vendor-profile <名>     透传给厂商 CLI 的 profile / context（如 aws --profile）
  --region <地域>           主机操作地域
  --dry-run                 只校验并打印将要执行的厂商命令，不真执行
  --yes                     跳过写操作确认（仅供脚本，必须显式写）
  read_only 偏好            config set --key read_only --value true，或 SRVPRICE_READONLY=1：一律拒绝写操作
  --introspect              输出机器可读的命令结构
  -h, --help / -v, --version

${core.EXIT_HELP}
`;

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(argv) {
  process.on('SIGINT', () => process.exit(EXIT.INTERRUPT));

  const { words, opts } = core.parseArgs(argv);

  if (opts.version) { process.stdout.write(core.VERSION + '\n'); return EXIT.OK; }
  if (opts.json) opts.output = 'json';

  const config = core.loadConfig();
  const io = core.makeIO(opts, config);

  if (opts.introspect) { io.data(introspect()); return EXIT.OK; }

  if (opts.help || words.length === 0) {
    process.stdout.write(HELP);
    return words.length === 0 && !opts.help ? EXIT.USAGE : EXIT.OK;
  }

  const [cmd, sub, ...rest] = words;
  const profilePick = () => core.resolveProfile(config, opts);

  switch (cmd) {
    case 'plan': return cmdPlan(io, opts, profilePick, sub, rest);
    case 'recommend': return cmdRecommend(io, opts, profilePick, sub);
    case 'deal': return cmdDeal(io, opts, profilePick, sub);
    case 'provider': return cmdProvider(io, opts, profilePick, sub);
    case 'promo': return cmdPromo(io, opts, profilePick, sub, rest);
    case 'buy': return cmdBuy(io, opts, profilePick, sub);
    case 'setup': return cmdSetup(io, opts, profilePick, sub, rest);
    case 'config': return cmdConfig(io, opts, config, sub);
    case 'host': return cmdHost(io, opts, profilePick, sub);
    case 'vendor': return cmdVendor(io, opts, config, sub);
    case 'sms': return cmdSms(io, opts, sub);
    default:
      throw new CliError(EXIT.USAGE, `未知命令：${cmd}（srvprice --help 查看全部命令）`);
  }
}

function need(sub, allowed, cmdName) {
  if (!sub || !allowed.includes(sub)) {
    throw new CliError(EXIT.USAGE, `用法：srvprice ${cmdName} ${allowed.join('|')}`);
  }
  return sub;
}

function val(opts, key, flag) {
  const v = opts[key];
  if (v === undefined || v === true) return null;
  return String(v);
}

// ---------------------------------------------------------------------------
// 选购线
// ---------------------------------------------------------------------------

function dataFor(io, opts, table) {
  return core.loadData(table);
}

function freshness(io, opts, profile, records, label) {
  return core.checkFreshness(io, records, Number(profile.stale_hours) || 24, label);
}

function priceText(p) {
  if (!p) return '—';
  if (p.first_year_cny != null) return `${p.first_year_cny} 元`;
  if (p.monthly_cny != null) return `${p.monthly_cny} 元/月`;
  return '未知';
}

function planRow(p) {
  return {
    id: p.id,
    provider: p.provider_label,
    name: p.name,
    region: p.region_label,
    first_year: p.price && p.price.first_year_cny != null ? p.price.first_year_cny : null,
    eligibility: p.eligibility
  };
}

function matchProvider(p, wanted) {
  return !wanted.length || wanted.includes(p.provider);
}

function matchRegion(p, region) {
  if (!region) return true;
  const r = String(region).toLowerCase();
  if (['cn', '大陆', 'china'].includes(r)) return p.region === 'cn';
  if (['hk', '香港'].includes(r)) return p.region === 'hk';
  if (['overseas', '海外', '海外/台'].includes(r)) return p.region === 'overseas';
  return p.region_label.includes(region) || p.provider === r;
}

async function cmdPlan(io, opts, profilePick, sub) {
  need(sub, ['list', 'get', 'compare'], 'plan');
  const { values: profile } = profilePick();
  // ★ 先刷新再装载：否则 --refresh 这一次仍然读旧的内置快照
  if (opts.refresh) await core.refreshData(io, 'plans');
  const data = dataFor(io, opts, 'plans');
  // 站点快照里 source_status=needs_browser 的条目是 JS 渲染页读数，提醒一次
  const nb = (data.plans || []).filter((p) => p.confidence === 'needs_browser').length;
  if (nb) io.warn(`快照里有 ${nb} 条来自 JS 渲染页，需浏览器复核后才算现价`);

  if (sub === 'get') {
    const id = Array.isArray(opts.id) ? String(opts.id[0]) : val(opts, 'id');
    if (!id) throw new CliError(EXIT.USAGE, '用法：srvprice plan get --id <plan-id>');
    const p = data.plans.find((x) => x.id === id);
    if (!p) throw new CliError(EXIT.NOT_FOUND, `未找到套餐：${id}`, { plan_id: id });
    const fresh = freshness(io, opts, profile, [p], '该套餐');
    io.data(Object.assign({ plan: p, data_freshness: fresh }, { data_source: data._source }));
    return EXIT.OK;
  }

  if (sub === 'compare') {
    const ids = asArray(opts.id).map(String);
    if (ids.length < 2) throw new CliError(EXIT.USAGE, '用法：srvprice plan compare --id <id1> --id <id2> [--id <id3>]');
    const items = ids.map((id) => {
      const p = data.plans.find((x) => x.id === id);
      if (!p) throw new CliError(EXIT.NOT_FOUND, `未找到套餐：${id}`, { plan_id: id });
      return p;
    });
    freshness(io, opts, profile, items, '对比数据');
    io.data({ items, compared_at: core.nowIso() });
    return EXIT.OK;
  }

  // list
  const providers = val(opts, 'provider') ? asArray(opts.provider).map(String) : profile.providers;
  const region = val(opts, 'region') || profile.default_region;
  const cpu = opts.cpu ? Number(opts.cpu) : null;
  const mem = opts.mem ? Number(opts.mem) : null;
  const budgetMax = opts.budgetMax ? Number(opts.budgetMax) : null;
  const newUserOnly = !!opts.newUserOnly || profile.new_user_only === true;

  let rows = data.plans.slice();
  if (providers && providers.length) rows = rows.filter((p) => matchProvider(p, providers));
  if (region) rows = rows.filter((p) => matchRegion(p, region));
  if (cpu) rows = rows.filter((p) => p.specs.cpu === cpu);
  if (mem) rows = rows.filter((p) => p.specs.mem_gb === mem);
  if (budgetMax != null) rows = rows.filter((p) => p.price.first_year_cny != null && p.price.first_year_cny <= budgetMax);
  if (newUserOnly) rows = rows.filter((p) => p.eligibility !== 'all');

  rows.sort((a, b) => (a.price.first_year_cny ?? Infinity) - (b.price.first_year_cny ?? Infinity));
  const fresh = freshness(io, opts, profile, rows, '价格');

  if (io.json) {
    const pg = core.paging(rows, opts);
    io.data({
      query: { providers, region, cpu, mem, budget_max: budgetMax, new_user_only: newUserOnly },
      page: pg.page, page_size: pg.page_size, total: pg.total, has_more: pg.has_more,
      items: pg.items, data_freshness: fresh, data_source: data._source
    });
  } else {
    const pg = core.paging(rows, opts);
    io.data({
      rows: pg.items.map(planRow),
      columns: [
        { key: 'id', label: 'ID' },
        { key: 'provider', label: '厂商' },
        { key: 'name', label: '方案' },
        { key: 'region', label: '地域' },
        { key: 'first_year', label: '首年(元)', null: '未知' },
        { key: 'eligibility', label: '资格' }
      ],
      footer: `共 ${pg.total} 条，第 ${pg.page} 页（--page/--page-size 翻页）。价格核验于 ${fresh.newest || '未知'}，以官网实时价为准。`
    });
  }
  return EXIT.OK;
}

const USE_CASES = {
  blog: { label: '个人博客 / 小站', mem: 2, bw: 3, budget: 150, note: '低预算优先，带宽够访问即可' },
  app: { label: '应用 / API 服务', mem: 2, bw: 5, budget: 600, note: '稳定性与续费价要比首年价更看重' },
  game: { label: '游戏服 / 定时任务', mem: 4, bw: 5, budget: 800, note: '内存与带宽优先，注意不限流量档' },
  ai: { label: 'AI 推理 / 数据处理', mem: 4, bw: 5, budget: 1500, note: '内存与 CPU 优先，海外机型可免备案' }
};

async function cmdRecommend(io, opts, profilePick, sub) {
  const { values: profile } = profilePick();
  const data = dataFor(io, opts, 'plans');

  if (sub === 'wizard') {
    if (!process.stdin.isTTY) {
      throw new CliError(EXIT.USAGE,
        'recommend wizard 需要交互终端；非交互环境请用带参数的 recommend --use-case ... （交互是可选增强，默认不打扰）');
    }
    return wizard(io, opts, profile, data);
  }
  if (sub) throw new CliError(EXIT.USAGE, '用法：srvprice recommend [--use-case ...] 或 srvprice recommend wizard');

  const useCase = val(opts, 'useCase') || null;
  const budget = opts.budget ? Number(opts.budget) : (useCase && USE_CASES[useCase] ? USE_CASES[useCase].budget : null);
  const region = val(opts, 'region') || profile.default_region;
  const visitors = opts.visitors ? Number(opts.visitors) : null;
  const explain = !!opts.explain;

  if (useCase && !USE_CASES[useCase]) {
    throw new CliError(EXIT.USAGE, `--use-case 支持：${Object.keys(USE_CASES).join(' | ')}`);
  }

  const result = recommend(data.plans, { useCase, budget, region, visitors, profile });
  if (result.items.length) freshness(io, opts, profile, result.items.map((i) => i.plan), '推荐依据的价格');

  if (io.json) {
    io.data(Object.assign({ query: { use_case: useCase, budget, region, visitors } }, result));
  } else {
    const lines = [];
    const best = result.items[0];
    if (!best) {
      lines.push('没有符合条件的套餐。放宽 --budget 或去掉 --region 再试。');
    } else {
      lines.push(`推荐：${best.plan.provider_label} ${best.plan.name} — ${priceText(best.plan.price)}`);
      for (const r of best.reasons) lines.push(`  · ${r}`);
      if (result.items.length > 1) {
        lines.push('', '备选：');
        for (const alt of result.items.slice(1)) {
          lines.push(`  · ${alt.plan.id}  ${alt.plan.provider_label} ${alt.plan.name}  ${priceText(alt.plan.price)}`);
        }
      }
      if (!explain) lines.push('', '（--explain 可看每条理由与备选）');
    }
    io.data({ text: lines.join('\n') });
  }
  return EXIT.OK;
}

function recommend(plans, q) {
  const uc = q.useCase ? USE_CASES[q.useCase] : null;
  const budget = q.budget;
  const scored = [];

  for (const p of plans) {
    if (q.region && !matchRegion(p, q.region)) continue;
    const price = p.price.first_year_cny;
    if (budget != null && price != null && price > budget) continue;

    const reasons = [];
    let score = 0;

    if (price != null) {
      score += Math.max(0, 100 - Math.log10(Math.max(price, 1)) * 25);
      if (uc && price <= uc.budget) { score += 25; reasons.push(`首年 ${price} 元，在 ${uc.label} 的常见预算内`); }
      else if (budget != null) reasons.push(`首年 ${price} 元，未超预算 ${budget} 元`);
    } else {
      reasons.push('首年价未知，按未核实处理');
    }

    const mem = p.specs.mem_gb;
    if (uc && mem != null) {
      if (mem >= uc.mem) { score += 20; reasons.push(`${mem}G 内存满足「${uc.label}」的最小建议 ${uc.mem}G`); }
      else { score -= 15; reasons.push(`${mem}G 内存低于「${uc.label}」建议的 ${uc.mem}G`); }
    }

    if (p.eligibility === 'new_user') {
      reasons.push('新用户专享：已买过该厂商服务则用不了');
      if (q.profile && q.profile.new_user_only === false) score -= 8;
    }
    if (p.eligibility === 'enterprise') { reasons.push('需企业实名'); score -= 10; }

    if (/续费同价|续费同价/.test(p.price.renew || '')) { score += 10; reasons.push('续费同价，不是首年诱饵价'); }
    else if (/续费待核|未写|未找到|回归原价/.test(p.price.renew || '')) { reasons.push(`续费口径：${p.price.renew}`); }

    if (p.region === 'cn') reasons.push('大陆节点：建站需要 ICP 备案');
    if (p.region !== 'cn' && p.requires_icp === false) reasons.push('非大陆节点：不需工信部 ICP 备案（个别厂商另有公安联网备案要求）');
    if (p.confidence === 'calculator') reasons.push('价格为计算器读数，非活动页原文');

    if (q.visitors && q.visitors > 50000 && p.specs.mem_gb && p.specs.mem_gb <= 2) {
      score -= 10;
      reasons.push(`日访 ${q.visitors} 偏高，2G 内存可能吃紧`);
    }

    scored.push({ plan: p, score: Math.round(score * 10) / 10, reasons });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  return {
    items: top,
    note: '推荐是规则打分（预算 / 内存 / 资格 / 续费口径），不是实时比价；下单前请核对官网价。'
  };
}

async function wizard(io, opts, profile, data) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(String(a).trim())));
  try {
    io.info('用途？ blog=个人博客 / app=应用服务 / game=游戏服 / ai=AI 推理');
    const useCase = (await ask('用途 [blog]: ')) || 'blog';
    const budgetRaw = await ask('预算（元/年，回车跳过）: ');
    const regionRaw = await ask('地域 cn=大陆 / hk=香港 / overseas=海外（回车不限）: ');
    rl.close();

    const q = {
      useCase: USE_CASES[useCase] ? useCase : 'blog',
      budget: budgetRaw ? Number(budgetRaw) : null,
      region: regionRaw || null,
      profile
    };
    const result = recommend(data.plans, q);
    freshness(io, opts, profile, result.items.map((i) => i.plan), '推荐依据的价格');
    const best = result.items[0];
    if (!best) { io.data({ text: '没有符合条件的套餐。' }); return EXIT.OK; }
    const lines = [`推荐：${best.plan.provider_label} ${best.plan.name} — ${priceText(best.plan.price)}`];
    for (const r of best.reasons) lines.push(`  · ${r}`);
    io.data({ text: lines.join('\n') });
    return EXIT.OK;
  } finally {
    rl.close();
  }
}

async function cmdDeal(io, opts, profilePick, sub) {
  need(sub, ['list', 'get'], 'deal');
  const { values: profile } = profilePick();
  if (opts.refresh) await core.refreshData(io, 'deals');
  const data = dataFor(io, opts, 'deals');

  if (sub === 'get') {
    const id = Array.isArray(opts.id) ? opts.id[0] : val(opts, 'id');
    if (!id) throw new CliError(EXIT.USAGE, '用法：srvprice deal get --id <deal-id>');
    const d = data.deals.find((x) => x.id === id);
    if (!d) throw new CliError(EXIT.NOT_FOUND, `未找到活动：${id}`, { deal_id: id });
    freshness(io, opts, profile, [d], '活动数据');
    io.data({ deal: Object.assign({}, d, { expired: isExpired(d) }) });
    return EXIT.OK;
  }

  const providers = val(opts, 'provider') ? asArray(opts.provider).map(String) : [];
  const endsBefore = val(opts, 'endsBefore');
  const newUserOnly = !!opts.newUserOnly;

  let rows = data.deals.slice();
  if (providers.length) rows = rows.filter((d) => providers.includes(d.provider));
  if (!opts.includeExpired) rows = rows.filter((d) => !isExpired(d));
  if (endsBefore) rows = rows.filter((d) => d.ends_at && d.ends_at <= endsBefore);
  if (newUserOnly) rows = rows.filter((d) => /新用户|新人|新客/.test(`${d.eligibility} ${d.summary}`));

  freshness(io, opts, profile, rows, '活动数据');
  if (io.json) { io.data({ count: rows.length, items: rows }); return EXIT.OK; }
  io.data({
    rows: rows.map((d) => ({
      id: d.id, provider: d.provider_label, title: d.title,
      ends_at: d.ends_at || '未写', status: isExpired(d) ? '已过期' : '进行中'
    })),
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'provider', label: '厂商' },
      { key: 'title', label: '活动' },
      { key: 'ends_at', label: '截止' },
      { key: 'status', label: '状态' }
    ],
    footer: '已过期活动默认不列出（--include-expired 查看）。'
  });
  return EXIT.OK;
}

function isExpired(deal) {
  if (!deal.ends_at) return false;
  return deal.ends_at < core.todayIso();
}

async function cmdProvider(io, opts, profilePick, sub) {
  need(sub, ['list', 'get'], 'provider');
  const { values: profile } = profilePick();
  const data = dataFor(io, opts, 'providers');
  freshness(io, opts, profile, data.providers, '渠道入口');

  if (sub === 'get') {
    const name = val(opts, 'name');
    if (!name) throw new CliError(EXIT.USAGE, '用法：srvprice provider get --name <provider-id>');
    const p = data.providers.find((x) => x.id === name);
    if (!p) throw new CliError(EXIT.NOT_FOUND, `未找到厂商：${name}`, { provider: name });
    io.data({ provider: p });
    return EXIT.OK;
  }

  if (io.json) {
    io.data({ count: data.providers.length, items: data.providers, overseas_credits: data.overseas_credits });
    return EXIT.OK;
  }
  io.data({
    rows: data.providers.map((p) => ({ id: p.id, label: p.label, kind: p.kind, url: p.channel_url })),
    columns: [
      { key: 'id', label: 'ID' },
      { key: 'label', label: '厂商' },
      { key: 'kind', label: '类型' },
      { key: 'url', label: '渠道入口' }
    ],
    footer: '渠道链接含归因参数；站内与 CLI 都不代下单、不收款。'
  });
  return EXIT.OK;
}

// ---- 变现线：联盟推广 / 代理商（只读，不做申请/签约）----

const PROMO_STATUS_LABEL = { ready: '已就绪', apply: '待申请', none: '无路', unknown: '待核' };
const PROMO_LINES = ['affiliate', 'agent'];
const PROMO_STATUSES = Object.keys(PROMO_STATUS_LABEL);

function promoValidate(opts) {
  const line = val(opts, 'line');
  if (line && !PROMO_LINES.includes(line)) {
    throw new CliError(EXIT.USAGE, `--line 支持：${PROMO_LINES.join(' | ')}`);
  }
  const status = val(opts, 'status');
  if (status && !PROMO_STATUSES.includes(status)) {
    throw new CliError(EXIT.USAGE, `--status 支持：${PROMO_STATUSES.join(' | ')}`);
  }
  return { line, status };
}

async function cmdPromo(io, opts, profilePick, sub, rest) {
  need(sub, ['list', 'get', 'actions', 'sync', 'link'], 'promo');
  if (sub === 'sync') return promoRunSync(io, opts);
  if (sub === 'link') return promoLink(io, opts, rest || []);
  const { line: lineFilter, status: statusFilter } = promoValidate(opts);
  const data = dataFor(io, opts, 'promos');
  const provs = dataFor(io, opts, 'providers');

  // 与 providers.json 对账：变现线有没有已配置的渠道链接
  const cliLink = (id) => {
    const p = provs.providers.find((x) => x.id === id);
    if (!p) return null;
    return {
      url: p.channel_url || null,
      note: p.entry_note || null,
      verified_at: p.verified_at || null
    };
  };
  const enrich = (p) => Object.assign({}, p, { cli_link: cliLink(p.id) });

  if (sub === 'get') {
    const name = val(opts, 'name');
    if (!name) throw new CliError(EXIT.USAGE, '用法：srvprice promo get --name <provider-id>');
    const p = data.providers.find((x) => x.id === name || x.label === name);
    if (!p) throw new CliError(EXIT.NOT_FOUND, `未找到厂商：${name}`, { provider: name });
    io.data({
      provider: enrich(p),
      snapshot_date: data.snapshot_date,
      count_rule: data.count_rule,
      status_help: data.status_help,
      note: data.note
    });
    return EXIT.OK;
  }

  if (sub === 'actions') {
    const items = [];
    for (const p of data.providers) {
      const st = p.status || {};
      for (const t of p.todo || []) {
        if (lineFilter && t.line !== lineFilter) continue;
        const lineStatus = st[t.line] || 'unknown';
        if (statusFilter && lineStatus !== statusFilter) continue;
        items.push({
          provider: p.id,
          label: p.label,
          line: t.line,
          line_status: lineStatus,
          action: t.action,
          blocker: t.blocker || null,
          url: t.url || (p.lines && p.lines[t.line] && p.lines[t.line].url) || null,
          materials: t.materials || []
        });
      }
    }
    if (io.json) {
      io.data({ count: items.length, items, snapshot_date: data.snapshot_date });
      return EXIT.OK;
    }
    io.data({
      rows: items.map((i, n) => ({
        n: n + 1,
        provider: i.label,
        line: i.line === 'affiliate' ? '联盟' : '代理',
        action: i.action,
        blocker: i.blocker || '—'
      })),
      columns: [
        { key: 'n', label: '#' },
        { key: 'provider', label: '厂商' },
        { key: 'line', label: '线' },
        { key: 'action', label: '待办' },
        { key: 'blocker', label: '卡点' }
      ],
      footer: 'CLI 不代申请/代签约；链接与材料仅作指引，最终以厂商官方页面为准。'
    });
    return EXIT.OK;
  }

  // list
  let items = data.providers.map(enrich);
  if (lineFilter) items = items.filter((p) => p.lines && p.lines[lineFilter]);
  if (statusFilter) {
    items = items.filter((p) => Object.values(p.status || {}).includes(statusFilter));
  }

  if (io.json) {
    io.data({
      count: items.length,
      items,
      snapshot_date: data.snapshot_date,
      count_rule: data.count_rule,
      status_help: data.status_help
    });
    return EXIT.OK;
  }

  const cell = (p, line) => {
    const st = (p.status || {})[line] || 'unknown';
    const l = (p.lines || {})[line];
    const label = PROMO_STATUS_LABEL[st] || st;
    return l && l.verified === false ? `${label}*` : label;
  };
  io.data({
    rows: items.map((p) => ({
      label: p.label,
      affiliate: cell(p, 'affiliate'),
      agent: cell(p, 'agent'),
      link: p.cli_link && p.cli_link.url ? '有' : '—'
    })),
    columns: [
      { key: 'label', label: '厂商' },
      { key: 'affiliate', label: '联盟推广' },
      { key: 'agent', label: '代理商' },
      { key: 'link', label: '本机链接' }
    ],
    footer: '* = 该线官方来源未核实（数字不可当作已核实口径）。「本机链接」指 providers.json 是否已配渠道入口；详情用 promo get --name。'
  });
  return EXIT.OK;
}

// ---- promo sync：站点拉取（可选）+ 本地对账 ----

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return null; }
}

function registrable(host) {
  if (!host) return null;
  const parts = host.split('.').filter(Boolean);
  return parts.length < 2 ? host : parts.slice(-2).join('.');
}

// 官方域：official + promos.json 里该厂商各线的程序页；用于发现「链接跑到别的域」
function officialDomains(provider, entry) {
  const set = new Set();
  const push = (u) => { const h = hostOf(u); if (h) set.add(registrable(h)); };
  if (provider && provider.official) push(provider.official);
  if (entry && entry.lines) {
    for (const line of PROMO_LINES) {
      const l = entry.lines[line];
      if (l && l.url) push(l.url);
    }
  }
  return [...set].filter(Boolean);
}

// 写入允许域：官方域 + 现有渠道链接所在域（已知生态内可继续用）
function writableDomains(provider, provs, entry) {
  const set = new Set(officialDomains(provider, entry));
  const push = (u) => { const h = hostOf(u); if (h) set.add(registrable(h)); };
  if (provider) {
    push(provider.channel_url);
    if (provider.channel_urls) Object.values(provider.channel_urls).forEach(push);
  }
  return [...set].filter(Boolean);
}

function promoFindings(promos, provs, staleDays) {
  const findings = [];
  const now = Date.now();
  for (const p of promos.providers) {
    const prov = provs.providers.find((x) => x.id === p.id) || null;
    const link = prov ? (prov.channel_url || (prov.channel_urls && Object.values(prov.channel_urls)[0])) : null;

    for (const line of PROMO_LINES) {
      const l = p.lines && p.lines[line];
      if (!l) continue;

      // providers.json 的渠道链接是客户购买入口，只和联盟推广线对账；
      // 代理商线是伙伴注册入口，不该进 providers.json。
      if (line === 'affiliate' && link && l.verified === false) {
        findings.push({
          provider: p.id, line, kind: 'link_present_but_unverified',
          message: '本机已有渠道链接，但该线官方来源未核实（providers.json 与调研结论对不上，需登录后台确认归属）'
        });
      }

      const st = (p.status || {})[line];
      if (line === 'affiliate' && !link && (st === 'ready' || st === 'apply')) {
        findings.push({
          provider: p.id, line, kind: 'missing_link',
          message: `状态为 ${st}，但 providers.json 没有客户侧推广链接`
        });
      }

      if (l.verified_at) {
        const age = Math.floor((now - new Date(`${l.verified_at}T00:00:00Z`).getTime()) / 86400000);
        if (age > staleDays) {
          findings.push({
            provider: p.id, line, kind: 'stale', age_days: age,
            message: `核验于 ${l.verified_at}，已 ${age} 天（阈值 ${staleDays}）`
          });
        }
      }
    }

    if (prov && link && p.kind === 'domestic') {
      const allowed = officialDomains(prov, p);
      const h = registrable(hostOf(link));
      if (h && allowed.length && !allowed.includes(h)) {
        findings.push({
          provider: p.id, line: 'affiliate', kind: 'link_host_mismatch',
          message: `渠道链接在 ${h}，不在官方域（${allowed.join(', ')}）`
        });
      }
    }
  }
  return findings;
}

async function promoRunSync(io, opts) {
  const staleDays = Math.max(1, parseInt(opts.staleDays || '30', 10) || 30);
  let source = 'local';
  let siteNote = null;

  if (!opts.localOnly) {
    const apiBase = (process.env.SRVPRICE_API || 'https://www.srvprice.com').replace(/\/+$/, '');
    const url = `${apiBase}/api/promos`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      if (!doc || !Array.isArray(doc.providers) || !doc.providers.length) {
        throw new Error('返回结构不对（缺少 providers）');
      }
      const bad = doc.providers.find((p) => !p || !p.id || !p.lines);
      if (bad) throw new Error('返回里有缺少 id/lines 的条目');
      core.ensureDir(path.dirname(core.cachePath('promos')), 0o700);
      core.writeJson0600(core.cachePath('promos'), doc);
      source = 'site';
      siteNote = `已从 ${url} 更新 ${doc.providers.length} 家`;
    } catch (e) {
      siteNote = `站点暂无可用 promos 接口（${url}：${e.message}），本次只做本地对账`;
      io.warn(siteNote, { source: 'local', url });
    }
  } else {
    siteNote = '--local-only：跳过站点同步';
  }

  const promos = dataFor(io, opts, 'promos');
  const provs = dataFor(io, opts, 'providers');
  const findings = promoFindings(promos, provs, staleDays);

  if (io.json) {
    io.data({
      source,
      site_note: siteNote,
      snapshot_date: promos.snapshot_date,
      stale_days: staleDays,
      count: findings.length,
      findings
    });
    return EXIT.OK;
  }

  io.data({
    rows: findings.map((f, n) => ({
      n: n + 1,
      provider: f.provider,
      line: f.line === 'affiliate' ? '联盟' : '代理',
      kind: f.kind,
      message: f.message
    })),
    columns: [
      { key: 'n', label: '#' },
      { key: 'provider', label: '厂商' },
      { key: 'line', label: '线' },
      { key: 'kind', label: '类型' },
      { key: 'message', label: '说明' }
    ],
    footer: `数据源：${source}；核验阈值 ${staleDays} 天。findings 是提示不是错误；确认后可用 promo link set 更新链接。`
  });
  return EXIT.OK;
}

// ---- promo link：维护客户侧推广链接（默认写本机缓存，--bundled 写仓库并备份）----

function stripPrivate(obj) {
  const out = Object.assign({}, obj);
  delete out._source;
  return out;
}

function readRawJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

async function promoLink(io, opts, rest) {
  const action = rest[0];
  if (!['show', 'set', 'unset'].includes(action)) {
    throw new CliError(EXIT.USAGE, '用法：srvprice promo link show|set|unset（--name --url --key --bundled）');
  }

  const bundledFile = path.join(core.dataOrigin('providers'), 'providers.json');
  const cacheFile = core.cachePath('providers');
  const bundledRaw = readRawJson(bundledFile);
  if (!bundledRaw) throw new CliError(EXIT.GENERAL, `数据表缺失：${bundledFile}`);
  const cacheRaw = readRawJson(cacheFile);
  const effective = stripPrivate(core.loadData('providers'));

  if (action === 'show') {
    const name = val(opts, 'name');
    const items = [];
    for (const p of effective.providers) {
      if (name && p.id !== name) continue;
      const source = cacheRaw && cacheRaw.providers.some((x) => x.id === p.id) ? 'cache' : 'bundled';
      if (p.channel_url) {
        items.push({ provider: p.id, label: p.label, key: null, url: p.channel_url, source, verified_at: p.verified_at || null, note: p.entry_note || null });
      }
      for (const [key, url] of Object.entries(p.channel_urls || {})) {
        items.push({ provider: p.id, label: p.label, key, url, source, verified_at: p.verified_at || null, note: p.entry_note || null });
      }
    }
    if (name && !items.length) {
      throw new CliError(EXIT.NOT_FOUND, `未找到厂商或其链接：${name}`, { provider: name });
    }
    if (io.json) {
      io.data({ count: items.length, items });
      return EXIT.OK;
    }
    io.data({
      rows: items.map((i) => ({ provider: i.label, key: i.key || '(主链接)', url: i.url, source: i.source })),
      columns: [
        { key: 'provider', label: '厂商' },
        { key: 'key', label: '位置' },
        { key: 'url', label: '链接' },
        { key: 'source', label: '来源' }
      ],
      footer: '来源 cache = 本机覆盖（promo link set 写入）；bundled = 仓库内置数据。'
    });
    return EXIT.OK;
  }

  const name = val(opts, 'name');
  if (!name) throw new CliError(EXIT.USAGE, `用法：srvprice promo link ${action} --name <provider-id>`);

  if (action === 'set') {
    const url = val(opts, 'url');
    const key = val(opts, 'key');
    if (!url) throw new CliError(EXIT.USAGE, '用法：srvprice promo link set --name <id> --url <https://...> [--key <子键>]');
    if (!/^https:\/\//i.test(url)) throw new CliError(EXIT.USAGE, '只接受 https 链接');

    const promos = dataFor(io, opts, 'promos');
    const entry = promos.providers.find((x) => x.id === name);
    const provider = effective.providers.find((x) => x.id === name);
    if (!provider && !entry) throw new CliError(EXIT.NOT_FOUND, `未找到厂商：${name}`, { provider: name });

    const allowed = writableDomains(provider, effective, entry);
    const host = registrable(hostOf(url));
    if (allowed.length && !allowed.includes(host)) {
      throw new CliError(EXIT.USAGE,
        `链接域 ${host || '(无法解析)'} 不在该厂商允许域（${allowed.join(', ')}）；确认无误可先手工改 providers.json`);
    }

    if (opts.bundled && !opts.yes && !process.stdin.isTTY) {
      throw new CliError(EXIT.UNCONFIRMED, '写仓库数据需要确认：非交互环境请显式加 --yes');
    }

    const base = opts.bundled ? JSON.parse(JSON.stringify(bundledRaw)) : stripPrivate(effective);
    let target = base.providers.find((x) => x.id === name);
    if (!target) {
      target = {
        id: name,
        label: entry ? entry.label : name,
        kind: entry ? entry.kind : 'domestic',
        official: entry && entry.lines && entry.lines.affiliate && entry.lines.affiliate.url
          ? new URL(entry.lines.affiliate.url).origin + '/'
          : null,
        verified_at: core.todayIso()
      };
      base.providers.push(target);
    }
    const previous = key
      ? (target.channel_urls && target.channel_urls[key]) || null
      : (target.channel_url || null);

    if (key) {
      target.channel_urls = Object.assign({}, target.channel_urls);
      target.channel_urls[key] = url;
    } else {
      target.channel_url = url;
    }
    target.entry_note = val(opts, 'note') || `promo link set（${core.todayIso()}）`;
    target.verified_at = val(opts, 'verifiedAt') || core.todayIso();

    const file = opts.bundled ? bundledFile : cacheFile;
    core.ensureDir(path.dirname(file), 0o700);
    let backup = null;
    if (opts.bundled && fs.existsSync(file)) {
      backup = `${file}.bak-${core.nowIso().replace(/[-:T]/g, '').slice(0, 15)}`;
      fs.copyFileSync(file, backup);
    }
    core.writeJson0600(file, base);

    const summary = {
      provider: name,
      key: key || null,
      url,
      previous,
      target: opts.bundled ? 'bundled' : 'cache',
      file,
      backup,
      verified_at: target.verified_at,
      note: opts.bundled ? '已写入仓库数据；缓存若存在会覆盖它，必要时清理本机 cache/providers.json' : '已写入本机覆盖；仓库数据未改'
    };
    if (io.json) io.data(summary);
    else io.data({ text: `${opts.bundled ? '仓库数据' : '本机缓存'}已更新：${name}${key ? '.' + key : ''} → ${url}` });
    return EXIT.OK;
  }

  // unset：只回滚本机覆盖
  if (!cacheRaw) {
    const out = { provider: name, removed: false, reason: '没有本机覆盖，链接本来就是仓库数据' };
    if (io.json) io.data(out); else io.data({ text: out.reason });
    return EXIT.OK;
  }
  const key = val(opts, 'key');
  const cp = cacheRaw.providers.find((x) => x.id === name);
  if (!cp) {
    const out = { provider: name, removed: false, reason: '本机覆盖里没有这家厂商' };
    if (io.json) io.data(out); else io.data({ text: out.reason });
    return EXIT.OK;
  }
  const before = key ? (cp.channel_urls && cp.channel_urls[key]) : cp.channel_url;
  const bp0 = bundledRaw.providers.find((x) => x.id === name);
  const restored = key
    ? (bp0 && bp0.channel_urls ? bp0.channel_urls[key] : undefined)
    : (bp0 ? bp0.channel_url : undefined);
  if (key) {
    cp.channel_urls = Object.assign({}, cp.channel_urls);
    if (restored) cp.channel_urls[key] = restored;
    else delete cp.channel_urls[key];
  } else if (restored) {
    cp.channel_url = restored;
  } else {
    delete cp.channel_url;
  }
  if (!cp.channel_url && (!cp.channel_urls || !Object.keys(cp.channel_urls).length)) {
    cacheRaw.providers = cacheRaw.providers.filter((x) => x.id !== name);
  } else {
    // 覆盖时改过的元数据（entry_note / verified_at 等）一并回到仓库口径
    const bp = bundledRaw.providers.find((x) => x.id === name);
    if (bp) {
      for (const k of Object.keys(bp)) {
        if (k === 'channel_url' || k === 'channel_urls') continue;
        cp[k] = bp[k];
      }
    }
  }
  const sameAsBundled = JSON.stringify(cacheRaw) === JSON.stringify(bundledRaw);
  if (sameAsBundled) {
    fs.unlinkSync(cacheFile);
  } else {
    core.writeJson0600(cacheFile, cacheRaw);
  }
  const out = { provider: name, key: key || null, removed_value: before || null, cache_kept: !sameAsBundled };
  if (io.json) io.data(out);
  else io.data({ text: `已恢复仓库链接：${name}${key ? '.' + key : ''}${before ? `（移除覆盖 ${before}）` : ''}` });
  return EXIT.OK;
}

async function cmdBuy(io, opts, profilePick, sub) {
  need(sub, ['url', 'open'], 'buy');
  const { values: profile } = profilePick();
  const planId = val(opts, 'planId') || val(opts, 'id');
  const providerId = val(opts, 'provider');

  const provs = dataFor(io, opts, 'providers');
  // ★ 2026-11-20 第二期「走优惠」：没有套餐数据的厂商（DO/Vultr 等）按 provider 级入口
  if (!planId && providerId) {
    return buyProvider(io, opts, provs, providerId, sub);
  }
  if (!planId) throw new CliError(EXIT.USAGE,
    '用法：srvprice buy url|open --plan-id <plan-id>（或 --provider <provider-id>）');

  const plans = dataFor(io, opts, 'plans');
  const plan = plans.plans.find((x) => x.id === planId);
  if (!plan) throw new CliError(EXIT.NOT_FOUND, `未找到套餐：${planId}`, { plan_id: planId });
  const provider = provs.providers.find((p) => p.id === plan.provider);
  const url = pickChannel(provider, plan.region);
  if (!url) throw new CliError(EXIT.NOT_FOUND, `厂商 ${plan.provider} 没有可用的渠道入口`, { provider: plan.provider });

  const summary = {
    plan_id: plan.id,
    provider: plan.provider_label,
    name: plan.name,
    region: plan.region_label,
    price_snapshot_cny: plan.price.first_year_cny,
    price_note: plan.price.note,
    verified_at: plan.verified_at,
    url,
    promo_note: (provider && provider.entry_note) || null,
    attribution: ATTRIBUTION_NOTE,
    warning: '价格以厂商官网实时价为准；CLI 显示的是核验时间的快照。CLI 不代下单、不收款。'
  };

  if (sub === 'url' || opts.noOpen) {
    if (io.json) io.data(summary);
    else io.data({ text: url });
    return EXIT.OK;
  }

  // open：先打印摘要（含厂商/机型/价格/地域/链接），再开浏览器
  io.data(summary);
  if (!process.stdout.isTTY && !opts.yes) {
    io.warn('非交互环境不会自动打开浏览器；需要 URL 请用 buy url，或显式加 --yes 打开');
    return EXIT.OK;
  }
  openBrowser(url);
  return EXIT.OK;
}

// 归因说明统一口径：第二期「走优惠」只做链接引导，不做 API 埋链（腾讯明确禁止，且归因不认）。
const ATTRIBUTION_NOTE = '链接含推荐归因：只有从该链接进入厂商官网、在官网注册并购买才计入推荐；API 下单带不上归因，客户端不会在 API 调用里埋链接。';

// provider 级入口：给没有套餐数据的厂商（DO / Vultr 等）一个「走优惠」入口
async function buyProvider(io, opts, provs, providerId, sub) {
  const p = provs.providers.find((x) => x.id === providerId);
  if (!p) throw new CliError(EXIT.NOT_FOUND, `未找到厂商：${providerId}`, { provider: providerId });
  const url = pickChannel(p, null);
  if (!url) throw new CliError(EXIT.NOT_FOUND, `厂商 ${providerId} 没有已核实的渠道入口`, { provider: providerId });

  const summary = {
    provider: p.id,
    provider_label: p.label,
    kind: p.kind || null,
    url,
    promo_note: p.entry_note || null,
    promo_verified_at: p.verified_at || null,
    official: p.official || null,
    attribution: ATTRIBUTION_NOTE,
    warning: 'CLI 只打印/打开链接，不代下单、不收款；优惠口径以官网实时页面为准。'
  };

  if (sub === 'url' || opts.noOpen) {
    if (io.json) io.data(summary);
    else io.data({ text: url });
    return EXIT.OK;
  }

  io.data(summary);
  if (!process.stdout.isTTY && !opts.yes) {
    io.warn('非交互环境不会自动打开浏览器；需要 URL 请用 buy url，或显式加 --yes 打开');
    return EXIT.OK;
  }
  openBrowser(url);
  return EXIT.OK;
}

function pickChannel(provider, region) {
  if (!provider) return null;
  // 厂商级入口（不给地域）：主链接优先——promo link set 改的就是它
  if (region == null && provider.channel_url) return provider.channel_url;
  if (provider.channel_urls) {
    const key = region === 'hk' ? 'hk' : region === 'overseas' ? 'overseas' : 'cn';
    if (provider.channel_urls[key]) return provider.channel_urls[key];
  }
  return provider.channel_url || null;
}

function openBrowser(url) {
  const p = process.platform;
  const args = p === 'win32' ? ['/c', 'start', '""', url]
    : p === 'darwin' ? [url] : [url];
  const bin = p === 'win32' ? 'cmd' : p === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    // 打开失败不影响已打印的 URL
  }
}

async function cmdSetup(io, opts, profilePick, sub, rest) {
  need(sub, ['list', 'show'], 'setup');
  const { values: profile } = profilePick();
  const data = dataFor(io, opts, 'setup');
  freshness(io, opts, profile, data.topics, '指引');

  if (sub === 'show') {
    const topic = rest[0] || val(opts, 'name') || val(opts, 'topic');
    if (!topic) throw new CliError(EXIT.USAGE, `用法：srvprice setup show <主题>（可用：${data.topics.map((t) => t.id).join(', ')}）`);
    const t = data.topics.find((x) => x.id === topic);
    if (!t) throw new CliError(EXIT.NOT_FOUND, `未找到主题：${topic}`, { topic, available: data.topics.map((x) => x.id) });
    const provider = val(opts, 'provider');
    if (io.json) {
      io.data({ topic: t, provider_filter: provider, note: '只给指引，不远程执行；命令由用户在自己服务器上运行。' });
      return EXIT.OK;
    }
    const lines = [`${t.title} — ${t.summary}`, ''];
    for (const s of t.steps) lines.push(`${s.n}. ${s.text}`);
    lines.push('', `验证：${t.verify}`);
    if (t.confidence === 'generic') lines.push('（通用指引，未绑定厂商原文；与厂商控制台文案对不上时以厂商文档为准）');
    io.data({ text: lines.join('\n') });
    return EXIT.OK;
  }

  const provider = val(opts, 'provider');
  const os = val(opts, 'os');
  let topics = data.topics.slice();
  if (provider) topics = topics.filter((t) => t.applies_to.includes(provider) || t.applies_to.includes('*'));
  if (os) topics = topics.filter((t) => t.os.includes(os) || t.os.includes('*'));

  if (io.json) { io.data({ count: topics.length, items: topics }); return EXIT.OK; }
  io.data({
    rows: topics.map((t) => ({ id: t.id, title: t.title, os: t.os.join(','), confidence: t.confidence })),
    columns: [
      { key: 'id', label: '主题' },
      { key: 'title', label: '标题' },
      { key: 'os', label: '系统' },
      { key: 'confidence', label: '证据' }
    ],
    footer: 'setup 只给文本指引，不 SSH、不改你的服务器。'
  });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

async function cmdSms(io, opts, sub) {
  need(sub, ['status', 'send', 'config'], 'sms');

  if (sub === 'status') {
    const st = smslib.status();
    io.data(st);
    return st.ready ? EXIT.OK : EXIT.CRED;
  }

  if (sub === 'config') {
    io.data({
      config_path: smslib.CONFIG_PATH(),
      template: smslib.EXAMPLE,
      note: '阿里云需已审核签名和模板；也可用 SMS_ACCESS_KEY / SMS_ACCESS_SECRET / SMS_SIGN_NAME / SMS_TEMPLATE_CODE / SMS_PHONE 环境变量',
    });
    return EXIT.OK;
  }

  const text = val(opts, 'text');
  if (!text) throw new CliError(EXIT.USAGE, '用法：srvprice sms send --text "..." [--to 手机号] [--dry-run]');
  const to = asArray(opts.to).filter(Boolean);
  const r = await smslib.send({ text, to, dryRun: !!opts.dryRun });
  io.data(r);
  if (r.error === 'sms_config_missing') {
    throw new CliError(EXIT.CRED, `短信配置缺失：${r.config_path}；缺少 ${(r.missing || []).join(', ')}`);
  }
  if (r.error) throw new CliError(EXIT.GENERAL, `短信发送失败：${r.error}`);
  return r.ok ? EXIT.OK : EXIT.VENDOR;
}

async function cmdConfig(io, opts, config, sub) {
  need(sub, ['show', 'list', 'use', 'set', 'reset'], 'config');

  if (sub === 'list') {
    const names = Object.keys(config.profiles);
    io.data(io.json
      ? { active: config.active_profile, profiles: names.map((n) => ({ name: n, active: n === config.active_profile, values: config.profiles[n] })) }
      : {
        rows: names.map((n) => ({ name: n, active: n === config.active_profile ? '*' : '', currency: config.profiles[n].currency, region: config.profiles[n].default_region || '—' })),
        columns: [{ key: 'name', label: '名字' }, { key: 'active', label: '激活' }, { key: 'currency', label: '币种' }, { key: 'region', label: '默认地域' }],
        footer: `配置文件：${core.CONFIG_PATH()}`
      });
    return EXIT.OK;
  }

  if (sub === 'show') {
    const pick = core.resolveProfile(config, opts);
    io.data({ profile: pick.name, source: pick.source, values: pick.values, config_path: core.CONFIG_PATH() });
    return EXIT.OK;
  }

  if (sub === 'use') {
    const name = val(opts, 'name');
    if (!name) throw new CliError(EXIT.USAGE, '用法：srvprice config use --name <profile>');
    if (!config.profiles[name]) throw new CliError(EXIT.NOT_FOUND, `profile 不存在：${name}`);
    config.active_profile = name;
    core.saveConfig(config);
    io.data({ active_profile: name, config_path: core.CONFIG_PATH() });
    return EXIT.OK;
  }

  if (sub === 'set') {
    const key = val(opts, 'key');
    const value = val(opts, 'value');
    if (!key) throw new CliError(EXIT.USAGE, '用法：srvprice config set --key <key> --value <value>');
    if (/key|secret|token|password/i.test(key)) {
      throw new CliError(EXIT.USAGE,
        '厂商密钥不放选购偏好：用 srvprice vendor add --name <厂商>（凭据单独存 ~/.srvprice/credentials.json）');
    }
    const pick = core.resolveProfile(config, opts);
    const allowed = Object.keys(core.DEFAULT_PROFILE);
    if (!allowed.includes(key)) {
      throw new CliError(EXIT.USAGE, `不支持的配置键：${key}（可用：${allowed.join(', ')}）`);
    }
    let parsed = value;
    if (value === 'true') parsed = true;
    else if (value === 'false') parsed = false;
    else if (/^\d+$/.test(String(value))) parsed = Number(value);
    else if (key === 'providers') parsed = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    config.profiles[pick.name][key] = parsed;
    core.saveConfig(config);
    io.data({ profile: pick.name, key, value: parsed });
    return EXIT.OK;
  }

  // reset
  const name = val(opts, 'name') || config.active_profile;
  if (!config.profiles[name]) throw new CliError(EXIT.NOT_FOUND, `profile 不存在：${name}`);
  config.profiles[name] = Object.assign({}, core.DEFAULT_PROFILE);
  core.saveConfig(config);
  io.data({ profile: name, reset: true });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// 主机线
// ---------------------------------------------------------------------------

function hostRow(h) {
  return {
    id: h.id,
    provider: h.provider,
    name: h.name || '—',
    region: h.region || '—',
    status: h.status,
    ip: h.public_ipv4 || '—'
  };
}

const HOST_COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: '名称' },
  { key: 'region', label: '地域' },
  { key: 'status', label: '状态' },
  { key: 'ip', label: '公网 IP' }
];

// ---- 开端口（目前仅西部数码安全组 API）----
function asList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  if (v && Array.isArray(v.data)) return v.data;
  if (v && v.data && Array.isArray(v.data.items)) return v.data.items;
  return [];
}

function openPortError(e) {
  const msg = String((e && e.message) || e);
  if (/IAM permission|RetCode:\s*299|permission error/i.test(msg)) {
    return new CliError(EXIT.CRED, `厂商权限不足：${msg}`, { reason: 'permission_denied' });
  }
  if (/auth|credential|Unauthorized|InvalidAccessKey|AuthFailure|not logged in|No credential|InvalidClientTokenId|secretId is invalid|access token is required/i.test(msg)) {
    return new CliError(EXIT.CRED, `厂商鉴权失败：${msg}`, { reason: 'auth_failed' });
  }
  return new CliError(EXIT.VENDOR, msg);
}

// 阿里 / 腾讯 / 火山：只新建专用组 + 加规则，不绑实例（派单红线）
async function cmdOpenPortVendor(io, opts, adapter, provider) {
  const ip = val(opts, 'ip');
  if (!ip) throw new CliError(EXIT.USAGE, '用法：srvprice host open-port --provider <aliyun|tencent|volcengine> --region <r> --ip <公网IP> --port <n> --source <IP>');
  const port = Number(val(opts, 'port'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(EXIT.USAGE, '--port 需要 1-65535');
  const proto = String(val(opts, 'proto') || 'tcp').toLowerCase();
  if (!['tcp', 'udp', 'icmp'].includes(proto)) throw new CliError(EXIT.USAGE, '--proto 只支持 tcp/udp/icmp');
  const source = val(opts, 'source');
  if (!source) throw new CliError(EXIT.USAGE, '必须给 --source 限来源 IP；确要放开所有来源请显式 --source 0.0.0.0 --yes');
  if (source === '0.0.0.0' && !opts.yes) throw new CliError(EXIT.UNCONFIRMED, '放开所有来源需要 --yes');
  const region = val(opts, 'region');
  if (!region) throw new CliError(EXIT.USAGE, '--region 必填（查实例与安全组都要地域）');
  if (val(opts, 'group')) {
    throw new CliError(EXIT.USAGE, '本轮红线：只新建专用安全组，不接受 --group 去改现有组');
  }
  const priority = Number(val(opts, 'priority') || 100);
  if (!Number.isInteger(priority) || priority < 1 || priority > 100) throw new CliError(EXIT.USAGE, '--priority 须在 1-100（数字越小优先级越高）');

  const ctx = { region, vendorProfile: val(opts, 'vendorProfile'), timeout: 120000 };
  let server;
  let groups;
  try {
    server = await adapter.serverByIp(ctx, ip);
    if (!server) {
      throw new CliError(EXIT.NOT_FOUND, `没在 ${provider}（${region}）账号下找到 IP 为 ${ip} 的实例`, { ip, region });
    }
    if (!server.vpcId) throw new CliError(EXIT.VENDOR, '实例缺少 VpcId，无法新建安全组', { ip });
    groups = await adapter.listGroups(ctx);
  } catch (e) {
    throw e instanceof CliError ? e : openPortError(e);
  }

  const name = val(opts, 'name') || firewall.groupNameFor(ip, port);
  if (/[^\x00-\x7F]/.test(name)) throw new CliError(EXIT.USAGE, '安全组名只能用 ASCII');
  const description = `srvprice open-port ${port} ${core.todayIso()}`;
  const existing = groups.find((g) => g.name === name) || null;
  const rule = { proto, port, source, priority };
  const createArgs = adapter.createArgs(ctx, server, name, description);
  const addArgs = existing ? adapter.addRuleArgs(ctx, existing.id, rule) : null;

  const plan = {
    provider,
    region,
    server,
    rule,
    group: {
      create: { name, description, vpc_id: server.vpcId },
      existing: existing ? { id: existing.id, name: existing.name } : null
    },
    deploy: { skipped: '本轮红线：只建组加规则，不绑定实例' },
    commands: [
      { step: existing ? 'skip_create' : 'create_group', argv: existing ? null : [adapter.bin, ...createArgs] },
      { step: 'add_rule', argv: [adapter.bin, ...(addArgs || adapter.addRuleArgs(ctx, '<新安全组ID-创建后回填>', rule))] }
    ]
  };

  if (opts.dryRun || !opts.yes) {
    if (io.json) io.data({ mode: 'dry-run', plan });
    else io.data({ text: `计划：${proto}/${port} ← ${source}；新建安全组 ${name}（VPC ${server.vpcId}）；不绑定实例` });
    return EXIT.OK;
  }

  const done = [];
  let gid = existing ? existing.id : null;
  try {
    if (!gid) {
      const r = await firewall.run(adapter.bin, createArgs, ctx);
      gid = adapter.groupIdFrom(r.stdout);
      if (!gid) throw new CliError(EXIT.VENDOR, '安全组已创建但取不到 groupid，请到控制台确认', { name });
      done.push({ step: 'create_group', groupid: gid, name });
    } else {
      done.push({ step: 'create_group', skipped: 'exists', groupid: gid });
    }
    await firewall.run(adapter.bin, adapter.addRuleArgs(ctx, gid, rule), ctx);
    done.push({ step: 'add_rule', groupid: gid, port, source });
  } catch (e) {
    throw e instanceof CliError ? e : openPortError(e);
  }
  io.data({ ok: true, plan, done });
  return EXIT.OK;
}

async function cmdOpenPort(io, opts) {
  const provider = val(opts, 'provider') || 'west';
  if (provider !== 'west') {
    const adapter = firewall.get(provider);
    if (!adapter) {
      throw new CliError(EXIT.USAGE, `--provider 支持 west / ${firewall.ids().join(' / ')}`);
    }
    return cmdOpenPortVendor(io, opts, adapter, provider);
  }
  const ip = val(opts, 'ip');
  if (!ip) {
    throw new CliError(EXIT.USAGE,
      '用法：srvprice host open-port --ip <服务器公网IP> --port <n> --source <允许来源IP> [--proto tcp] [--group <id>] [--deploy --yes]');
  }
  const port = Number(val(opts, 'port'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(EXIT.USAGE, '--port 需要 1-65535');
  }
  const proto = String(val(opts, 'proto') || 'tcp').toLowerCase();
  if (!['tcp', 'udp', 'icmp'].includes(proto)) {
    throw new CliError(EXIT.USAGE, '--proto 只支持 tcp/udp/icmp');
  }
  const source = val(opts, 'source');
  if (!source) {
    throw new CliError(EXIT.USAGE, '必须给 --source 限来源 IP；确要放开所有来源请显式 --source 0.0.0.0 --yes');
  }
  if (source === '0.0.0.0' && !opts.yes) {
    throw new CliError(EXIT.UNCONFIRMED, '放开所有来源需要 --yes');
  }
  const priority = Number(val(opts, 'priority') || 10);
  if (!Number.isInteger(priority) || priority < 1 || priority > 1024) {
    throw new CliError(EXIT.USAGE, '--priority 须在 1-1024');
  }

  const creds = westlib.creds();
  if (!creds.user || !creds.pass) {
    throw new CliError(EXIT.CRED,
      '缺西部数码凭据：请用 vault 注入 WEST_USERNAME / WEST_API_PASSWORD 后运行（vault-cli run ...）',
      { reason: 'auth_failed', provider: 'west' });
  }

  // 只允许对自己账号下的服务器动安全组
  const servers = asList(await westlib.listServers({ limit: 200 }));
  const server = servers.find((s) => String(s.allocateip || s.ip || '') === ip);
  if (!server) {
    throw new CliError(EXIT.NOT_FOUND,
      `没在西部数码账号下找到 IP 为 ${ip} 的服务器（不替你给别处开端口）`, { ip });
  }

  const groups = asList(await westlib.listFirewallGroups());
  const wantedGroup = val(opts, 'group');
  let group = null;
  if (wantedGroup) {
    group = groups.find((g) => String(g.sysid || g.groupid || g.id) === String(wantedGroup));
    if (!group) throw new CliError(EXIT.NOT_FOUND, `安全组不存在：${wantedGroup}`, { group: wantedGroup });
  } else {
    group = groups.find((g) => JSON.stringify(g).includes(ip)) ||
      groups.find((g) => String(g.group_name || '').includes(ip.replace(/\./g, '-'))) || null;
  }
  const gid = group ? String(group.sysid || group.groupid || group.id || '') : null;

  let duplicate = null;
  if (gid) {
    const rules = asList(await westlib.groupRules({ groupid: gid }));
    duplicate = rules.find((r) =>
      Number(r.dstport) === port &&
      String(r.proto || '').toLowerCase() === proto &&
      (String(r.srcip || '') === source ||
        (source === '0.0.0.0' && String(r.srcip_type) === '0'))
    ) || null;
  }

  const plan = {
    provider: 'west',
    server: {
      id: server.id !== undefined ? String(server.id) : null,
      ip,
      os: server.os || null,
      room: server.serverroom || null
    },
    rule: { proto, port, source, priority, action: 'pass' },
    group: group
      ? { groupid: gid, name: group.group_name || group.name || null, memo: group.group_memo || group.memo || null }
      : {
          create: {
            name: val(opts, 'name') || `srvprice-${ip.replace(/\./g, '-')}-${port}`,
            memo: val(opts, 'memo') || `srvprice open-port ${port} ${core.todayIso()}`
          }
        },
    duplicate: duplicate ? { sysid: duplicate.sysid || null } : null,
    deploy: opts.deploy
      ? { sip: ip, note: '部署后安全组接管该机出入站' }
      : { skipped: '未加 --deploy：只建规则，不生效' }
  };

  if (opts.dryRun || !opts.yes) {
    if (io.json) {
      io.data({
        mode: 'dry-run',
        plan,
        warning: '西部数码安全组首次部署会接管出入站：先确认 22/25 等现网端口已在规则里放通；本命令默认不部署。'
      });
    } else {
      io.data({
        text: `计划：${proto} ${port} ← ${source}` +
          `（${plan.group.groupid ? '安全组 ' + plan.group.groupid : '新建安全组'}）；` +
          `${plan.deploy.skipped || '将部署到 ' + ip}`
      });
    }
    return EXIT.OK;
  }

  const done = [];
  let finalGid = gid;
  if (!finalGid) {
    const c = await westlib.addFirewallGroup({
      name: plan.group.create.name || undefined,
      memo: plan.group.create.memo
    });
    finalGid = String((c && (c.sysid || c.groupid || c.id)) ||
      (c && c.data && (c.data.sysid || c.data.groupid || c.data.id)) || '');
    if (!finalGid) {
      const again = asList(await westlib.listFirewallGroups());
      const g = again.find((x) =>
        String(x.group_name || x.name || '') === String(plan.group.create.name || '') ||
        String(x.group_memo || x.memo || '') === String(plan.group.create.memo || ''));
      finalGid = g ? String(g.sysid || g.groupid || g.id) : '';
    }
    if (!finalGid) {
      throw new CliError(EXIT.VENDOR, '安全组已创建但取不到 groupid，请到控制台确认', {
        memo: plan.group.create.memo
      });
    }
    done.push({ step: 'create_group', groupid: finalGid });
  }

  if (!duplicate) {
    await westlib.addGroupRule({
      groupid: finalGid, proto, port, srcip: source,
      srcip_type: source === '0.0.0.0' ? 0 : 1,
      allow_all: source === '0.0.0.0', priority, action: 'pass'
    });
    done.push({ step: 'add_rule', groupid: finalGid, port, source });
  } else {
    done.push({ step: 'add_rule', skipped: 'duplicate', sysid: duplicate.sysid || null });
  }

  if (opts.deploy) {
    await westlib.deployGroup({ groupid: finalGid, sip: ip, enable: true });
    done.push({ step: 'deploy', groupid: finalGid, sip: ip });
  }

  io.data({ ok: true, plan, done });
  return EXIT.OK;
}

async function cmdHost(io, opts, profilePick, sub) {
  need(sub, ['list', 'status', 'start', 'stop', 'reboot', 'wait', 'snapshots', 'open-port'], 'host');
  const { values: profile } = profilePick();

  if (sub === 'open-port') return cmdOpenPort(io, opts);

  if (sub === 'list') {
    const { hosts, errors } = await hostlib.listAcross(opts, profile, io);
    const statusFilter = val(opts, 'status');
    const filtered = statusFilter ? hosts.filter((h) => h.status === statusFilter) : hosts;
    filtered.sort((a, b) => a.id.localeCompare(b.id));
    if (io.json) {
      io.data({ count: filtered.length, items: filtered, errors, note: '每行 ID 形如 <provider>:<instance-id>，直接用于 host status/start/stop。' });
      return errors.length && filtered.length === 0 ? EXIT.CRED : EXIT.OK;
    }
    io.data({
      rows: filtered.map(hostRow),
      columns: HOST_COLUMNS,
      footer: filtered.length ? `共 ${filtered.length} 台。未接入 / 未登录的厂商见 stderr。` : '没有可列出的主机。'
    });
    return errors.length && filtered.length === 0 ? EXIT.CRED : EXIT.OK;
  }

  if (sub === 'status') {
    const id = requireId(opts);
    const { adapter, ctx, host } = await hostlib.findHost(id, opts, profile);
    // ★ 有自己的状态接口的厂商（西部数码）：列表里没有状态，这里补一次真实状态
    let h = host;
    if (adapter && adapter.getStatus) {
      try {
        h = await adapter.getStatus(ctx, host);
      } catch (e) {
        h = Object.assign({}, host, { status_info: '状态查询失败：' + e.message });
      }
    }
    io.data({ host: h, checked_at: core.nowIso() });
    return EXIT.OK;
  }

  // 云快照列表（目前仅西部数码；只读）
  if (sub === 'snapshots') {
    const id = requireId(opts);
    const { adapter, ctx, host } = await hostlib.findHost(id, opts, profile);
    if (!adapter || !adapter.snapshots) {
      throw new CliError(EXIT.USAGE,
        `${host.provider} 适配器暂不支持 snapshots（当前支持：west）`);
    }
    const snap = await adapter.snapshots(ctx, host);
    io.data({ host_id: host.id, provider: host.provider, snapshots: snap, checked_at: core.nowIso() });
    return EXIT.OK;
  }

  if (sub === 'wait') {
    const id = requireId(opts);
    const until = val(opts, 'until');
    if (!until || !['running', 'stopped'].includes(until)) {
      throw new CliError(EXIT.USAGE, '用法：srvprice host wait --id <id> --until running|stopped');
    }
    const { adapter, ctx, host } = await hostlib.findHost(id, opts, profile);
    if (host.status === until) { io.data({ host, waited: false }); return EXIT.OK; }
    // 跨地域列出的实例：轮询也用实例所在地域，避免每个地域都查一遍
    const actx = hostlib.actionCtx(ctx, host);
    const final = await hostlib.waitFor(adapter, actx, host.instance_id, until, io, opts);
    io.data({ host: final, waited: true });
    return EXIT.OK;
  }

  // 写操作：start / stop / reboot
  const id = requireId(opts);
  // ★ 只读模式：profile.read_only 或 SRVPRICE_READONLY=1 时，写操作无论 --yes 一律拒绝。
  //   配只读 AK/SK 时用它兜底，避免「忘了」变成误操作；凭据本身也会在厂商侧拒绝。
  const readOnly = profile.read_only === true || process.env.SRVPRICE_READONLY === '1';
  if (readOnly) {
    throw new CliError(EXIT.USAGE,
      `只读模式已开启，拒绝执行 ${sub}：${id}。验证用 host list / status 即可；` +
      '要开关机请先关掉只读（srvprice config set --key read_only --value false，或去掉 SRVPRICE_READONLY）',
      { action: sub, host_id: id, reason: 'read_only' });
  }
  const { adapter, ctx: baseCtx, host } = await hostlib.findHost(id, opts, profile);
  // ★ 跨地域列出的实例：没显式给 --region 时，用实例所在地域（AWS 的 AZ、腾讯的可用区反推）
  const ctx = hostlib.actionCtx(baseCtx, host);
  const target = hostlib.TARGET_STATUS[sub];

  if (opts.dryRun) {
    const plan = {
      dry_run: true,
      action: sub,
      host,
      target_status: target,
      vendor_command: (() => {
        const c = hostlib.actionCommand(host.provider, sub, host.instance_id, ctx);
        return [c.bin, ...c.args].join(' ');
      })(),
      note: '--dry-run 已校验凭据以外的一切；加 --yes 或交互确认后去掉 --dry-run 执行。'
    };
    io.data(plan);
    return EXIT.OK;
  }

  const summary = `${host.provider} / ${host.name || host.instance_id}（${host.public_ipv4 || '无公网 IP'}，当前 ${host.status}）→ 目标 ${target}`;
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new CliError(EXIT.UNCONFIRMED,
        `写操作未确认而阻断：${sub} ${host.id}。非交互环境必须显式加 --yes，或先用 --dry-run 预览。`,
        { action: sub, host_id: host.id, target_status: target });
    }
    io.info(`即将执行：${summary}`);
    const ok = await core.confirmPrompt(`确认 ${sub}？`);
    if (!ok) {
      throw new CliError(EXIT.UNCONFIRMED, '用户取消，未执行', { action: sub, host_id: host.id });
    }
  }

  const res = await hostlib.runAction(host.provider, sub, host.instance_id, ctx);
  io.info(`已提交：${res.command}`);

  // 执行后回读状态，不凭「已受理」就报成功
  let after;
  try {
    const hosts = await adapter.list(ctx);
    after = hosts.find((h) => h.instance_id === host.instance_id) || null;
  } catch (e) {
    after = null;
    io.warn(`执行后回读状态失败：${e.message}`);
  }

  if (opts.wait && target) {
    const final = await hostlib.waitFor(adapter, ctx, host.instance_id, target, io, opts);
    io.data({ action: sub, host: final, previous_status: host.status, vendor_command: res.command });
    return EXIT.OK;
  }

  io.data({
    action: sub,
    submitted: true,
    host_id: host.id,
    previous_status: host.status,
    status_after: after ? after.status : '未知（回读失败）',
    vendor_command: res.command,
    note: '厂商通常异步处理；需要确定结果请加 --wait 或运行 srvprice host wait。'
  });
  return EXIT.OK;
}

function requireId(opts) {
  const id = Array.isArray(opts.id) ? opts.id[0] : val(opts, 'id');
  if (!id) throw new CliError(EXIT.USAGE, '用法：需要 --id <provider>:<instance-id>（先运行 srvprice host list）');
  return id;
}

// ---------------------------------------------------------------------------
// vendor
// ---------------------------------------------------------------------------

const VENDOR_ENV = {
  aliyun: ['SRVPRICE_ALIYUN_KEY', 'SRVPRICE_ALIYUN_SECRET'],
  aws: ['SRVPRICE_AWS_ACCESS_KEY_ID', 'SRVPRICE_AWS_SECRET_ACCESS_KEY'],
  tencent: ['SRVPRICE_TENCENT_SECRET_ID', 'SRVPRICE_TENCENT_SECRET_KEY'],
  ucloud: ['SRVPRICE_UCLOUD_PUBLIC_KEY', 'SRVPRICE_UCLOUD_PRIVATE_KEY'],
  jdcloud: ['SRVPRICE_JDCLOUD_ACCESS_KEY', 'SRVPRICE_JDCLOUD_SECRET_KEY'],
  volcengine: ['SRVPRICE_VOLCENGINE_ACCESS_KEY', 'SRVPRICE_VOLCENGINE_SECRET_KEY'],
  baidu: ['SRVPRICE_BAIDU_ACCESS_KEY_ID', 'SRVPRICE_BAIDU_SECRET_ACCESS_KEY'],
  west: ['SRVPRICE_WEST_USER', 'SRVPRICE_WEST_API_PASSWORD'],
  ctyun: ['SRVPRICE_CTYUN_AK', 'SRVPRICE_CTYUN_SK'],
  doctl: ['SRVPRICE_DOCTL_TOKEN'],
  hcloud: ['SRVPRICE_HCLOUD_TOKEN'],
  vultr: ['SRVPRICE_VULTR_API_KEY'],
  linode: ['SRVPRICE_LINODE_TOKEN']
};

async function cmdVendor(io, opts, config, sub) {
  need(sub, ['list', 'add', 'status', 'remove'], 'vendor');
  const creds = core.loadCreds();

  if (sub === 'list' || sub === 'status') {
    const only = val(opts, 'name');
    const ids = only ? [only] : hostlib.VENDOR_IDS;
    for (const id of ids) hostlib.getAdapter(id);
    const probes = [];
    for (const id of ids) probes.push(await hostlib.probe(id, opts.timeout ? Number(opts.timeout) * 1000 : 15000));

    const items = [];
    for (const p of probes) {
      const credProbe = p.installed ? await hostlib.probeCreds(p.id, 15000) : { checked: false, configured: null, detail: '' };
      const stored = creds.vendors[p.id];
      const envKeys = VENDOR_ENV[p.id] || [];
      items.push({
        id: p.id,
        label: p.label,
        bin: p.bin,
        installed: p.installed,
        version: p.version,
        cli_configured: credProbe.configured,
        cli_cred_detail: credProbe.detail || null,
        credential: {
          stored: !!stored,
          masked: stored ? core.mask(stored.key || stored.token || null) : null,
          env_present: envKeys.some((k) => !!process.env[k]),
          added_at: stored ? stored.added_at : null
        },
        spec_verified: hostlib.getAdapter(p.id).spec_verified || 'verified',
        mode: 'wrap-vendor-cli',
        note: '主机操作走厂商 CLI 自己的登录态；本机凭据文件用于将来直调 API 与授权记录。'
      });
    }

    if (io.json) { io.data({ count: items.length, items }); return EXIT.OK; }
    io.data({
      rows: items.map((i) => ({
        id: i.id,
        label: i.label,
        installed: i.installed ? '已装' : '未装',
        version: i.version || '—',
        cred: i.credential.stored ? i.credential.masked : (i.credential.env_present ? 'env' : '无'),
        spec: i.spec_verified === 'verified' ? '' : (i.spec_verified === 'read_only' ? '只读（写命令未核实）' : '输出格式待核')
      })),
      columns: [
        { key: 'id', label: '厂商' },
        { key: 'label', label: '名称' },
        { key: 'installed', label: 'CLI' },
        { key: 'version', label: '版本' },
        { key: 'cred', label: '凭据' },
        { key: 'spec', label: '备注' }
      ],
      footer: '未装的厂商：先按其官方文档安装 CLI 并登录，再运行 srvprice host list。'
    });
    return EXIT.OK;
  }

  if (sub === 'add') {
    const name = val(opts, 'name');
    if (!name) throw new CliError(EXIT.USAGE, `用法：srvprice vendor add --name <${hostlib.VENDOR_IDS.join('|')}>`);
    hostlib.getAdapter(name);

    if (opts.key !== undefined) {
      throw new CliError(EXIT.USAGE,
        '密钥不接受命令行参数（会进 shell 历史与进程列表）。请用交互输入，或设环境变量后重跑。');
    }

    const envKeys = VENDOR_ENV[name] || [];
    const fromEnv = {};
    for (const k of envKeys) if (process.env[k]) fromEnv[k] = process.env[k];

    let record;
    if (Object.keys(fromEnv).length) {
      const firstKey = envKeys[0];
      record = {
        key: fromEnv[firstKey],
        secret: envKeys[1] ? fromEnv[envKeys[1]] || null : null,
        added_at: core.nowIso(),
        source: 'env'
      };
      io.info(`从环境变量读取 ${name} 凭据`);
    } else if (process.stdin.isTTY) {
      const v1 = await core.readSecretHidden(`${name} 凭据（输入不回显）: `);
      if (!v1) throw new CliError(EXIT.USAGE, '未输入凭据，已取消');
      let v2 = null;
      if (envKeys.length > 1) {
        v2 = await core.readSecretHidden(`${name} 第二段凭据（如 secret，输入不回显；无则回车）: `);
        v2 = v2 || null;
      }
      record = { key: v1, secret: v2, added_at: core.nowIso(), source: 'prompt' };
    } else {
      throw new CliError(EXIT.USAGE,
        `非交互环境请通过环境变量注入：${envKeys.join(' / ')}（不落盘、不进 shell 历史）`);
    }

    creds.vendors[name] = record;
    core.saveCreds(creds);
    io.data({
      vendor: name,
      stored: true,
      masked: core.mask(record.key),
      path: core.CREDS_PATH(),
      mode: core.fileMode(core.CREDS_PATH()),
      note: '凭据只存本机、不上传；主机操作仍走厂商 CLI 自己的登录态。'
    });
    return EXIT.OK;
  }

  // remove
  const name = val(opts, 'name');
  if (!name) throw new CliError(EXIT.USAGE, '用法：srvprice vendor remove --name <vendor>');
  hostlib.getAdapter(name);
  if (!creds.vendors[name]) throw new CliError(EXIT.NOT_FOUND, `没有 ${name} 的本机凭据`);

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new CliError(EXIT.UNCONFIRMED, '删除凭据需要确认：非交互环境请显式加 --yes');
    }
    const ok = await core.confirmPrompt(`删除 ${name} 的本机凭据？`);
    if (!ok) throw new CliError(EXIT.UNCONFIRMED, '用户取消，未删除');
  }
  delete creds.vendors[name];
  core.saveCreds(creds);
  io.data({ vendor: name, removed: true });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// introspect：机器可读命令结构
// ---------------------------------------------------------------------------

function introspect() {
  return {
    name: 'srvprice',
    version: core.VERSION,
    binary_aliases: ['srvprice', 'sp'],
    agent_contract: {
      stdout: 'only business result (JSON when --output json or stdout is not a TTY)',
      stderr: 'diagnostics; JSONL in json mode',
      default_output: 'auto: TTY→text, pipe→json',
      default_interactive: false,
      price_freshness: 'every price/deal carries verified_at and source_url; stale data warns on stderr',
      write_ops: 'host start/stop/reboot require confirmation; non-TTY without --yes exits 7; --dry-run prints vendor command only'
    },
    exit_codes: EXIT,
    vendored_clis: hostlib.VENDOR_IDS,
    commands: {
      plan: { subcommands: ['list', 'get', 'compare'], options: ['--provider', '--cpu', '--mem', '--region', '--budget-max', '--new-user-only', '--page', '--page-size'] },
      recommend: { subcommands: [null, 'wizard'], options: ['--use-case', '--budget', '--region', '--visitors', '--explain'] },
      deal: { subcommands: ['list', 'get'], options: ['--provider', '--new-user-only', '--ends-before', '--include-expired'] },
      provider: { subcommands: ['list', 'get'], options: ['--name'] },
      promo: {
        subcommands: ['list', 'get', 'actions', 'sync', 'link'],
        options: ['--name', '--line', '--status', '--local-only', '--stale-days', '--url', '--key', '--bundled', '--yes'],
        safety: 'never applies to or signs programs; promo link only edits provider URLs (https + vendor domain allowlist); --bundled writes repo data with a .bak backup'
      },
      buy: { subcommands: ['url', 'open'], options: ['--plan-id', '--no-open'], safety: 'never places orders; prints/opens official channel URLs only' },
      setup: { subcommands: ['list', 'show'], options: ['--provider', '--os'], safety: 'text guidance only; never executes remotely' },
      config: { subcommands: ['show', 'list', 'use', 'set', 'reset'], options: ['--name', '--key', '--value', '--profile'] },
      host: {
        subcommands: ['list', 'status', 'start', 'stop', 'reboot', 'wait', 'snapshots', 'open-port'],
        options: ['--id', '--provider', '--region', '--status', '--wait', '--yes', '--dry-run', '--until', '--ip', '--port', '--proto', '--source', '--group', '--priority', '--deploy', '--memo', '--name'],
        safety: 'open-port defaults to a dry-run plan; writes require --yes; --deploy is opt-in because a first-time security group takes over inbound/outbound'
      },
      vendor: { subcommands: ['list', 'add', 'status', 'remove'], options: ['--name'] }
    }
  };
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((e) => {
  if (e instanceof CliError) {
    const io = safeWarn();
    io(e.message, { reason: e.reason, exit_code: e.exitCode });
    process.exitCode = e.exitCode;
  } else {
    process.stderr.write(`错误：${e && e.message ? e.message : e}\n`);
    if (process.env.SRVPRICE_DEBUG) process.stderr.write(`${e && e.stack ? e.stack : ''}\n`);
    process.exitCode = EXIT.GENERAL;
  }
});

function safeWarn() {
  // 出错时按当前 argv 判断输出模式，避免重复解析失败
  const jsonMode = process.argv.includes('--json') ||
    (process.argv.includes('--output') && process.argv[process.argv.indexOf('--output') + 1] === 'json') ||
    !process.stdout.isTTY;
  return (message, extra) => {
    if (jsonMode) process.stderr.write(JSON.stringify(Object.assign({ level: 'error', message }, extra || {})) + '\n');
    else process.stderr.write(`错误：${message}\n`);
  };
}
