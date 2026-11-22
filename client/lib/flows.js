'use strict';

// 流程库：加载 / 校验 / 生成执行计划 / 骨架执行器。
// 规格：voice-webcontrol-client-spec-20261120.md §5.1。
// 第一阶段只做到「校验 + 计划 + 把人机门停下来」，真正执行由扩展 + 后续版本补齐。

const fs = require('fs');
const path = require('path');

const ACTIONS = new Set([
  'open', 'navigate', 'click', 'real_click', 'real_type', 'press_key', 'click_at', 'dom_click', 'fill_form', 'attach_policy',
  'read_fields', 'run_command', 'wait', 'scroll_container', 'check_row', 'check_by_label',
  'fill_by_placeholder', 'type_at', 'row_click'
]);

// 步骤文件里出现这些形状 = 大概率把真实密钥写进去了
const SECRET_PATTERNS = [
  /LTAI[0-9A-Za-z]{12,}/,
  /AKID[0-9A-Za-z]{10,}/,
  /ALTA[0-9A-Za-z]{10,}/,
  /AKLT[0-9A-Za-z]{10,}/,
  /"secret[_-]?(access[_-]?)?key"\s*:\s*"[^"{<]/i
];

function loadFlows(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const raw = fs.readFileSync(file, 'utf8');
    let flow = null;
    let errors = [];
    try {
      flow = JSON.parse(raw);
      errors = validateFlow(flow, raw);
    } catch (e) {
      errors = [`JSON 解析失败：${e.message}`];
    }
    out.push({ file, flow, errors });
  }
  return out;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function validateFlow(flow, raw) {
  const errors = [];
  if (!flow || typeof flow !== 'object') return ['流程必须是 JSON 对象'];
  for (const k of ['id', 'vendor', 'title', 'entry']) {
    if (!isNonEmptyString(flow[k])) errors.push(`缺字段或为空：${k}`);
  }
  if (!Number.isInteger(flow.version) || flow.version < 1) errors.push('version 必须是 >=1 的整数');
  if (!['draft', 'active', 'deprecated'].includes(flow.status)) {
    errors.push('status 只能是 draft / active / deprecated');
  }
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    errors.push('steps 必须是非空数组');
    return errors;
  }
  const seen = new Set();
  flow.steps.forEach((s, i) => {
    const where = `steps[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${where} 不是对象`); return; }
    if (!isNonEmptyString(s.step_id)) errors.push(`${where} 缺 step_id`);
    else if (seen.has(s.step_id)) errors.push(`${where} step_id 重复：${s.step_id}`);
    else seen.add(s.step_id);
    if (!s.do || typeof s.do !== 'object' || !ACTIONS.has(s.do.action)) {
      errors.push(`${where}.do.action 非法（允许：${[...ACTIONS].join(' / ')}）`);
    }
    if (!s.verify || typeof s.verify !== 'object' || Object.keys(s.verify).length === 0) {
      errors.push(`${where} 缺 verify（怎么算成功）`);
    }
    if (!s.fail_when || typeof s.fail_when !== 'object') {
      errors.push(`${where} 缺 fail_when（什么情况停）`);
    }
    if (typeof s.human !== 'boolean') errors.push(`${where}.human 必须是布尔`);
    if (typeof s.sensitive !== 'boolean') errors.push(`${where}.sensitive 必须是布尔`);
  });
  if (typeof raw === 'string') {
    for (const re of SECRET_PATTERNS) {
      if (re.test(raw)) {
        errors.push('步骤文件里出现了疑似真实密钥（应为 {{credential.*}} 占位符）');
        break;
      }
    }
  }
  return errors;
}

function planFlow(flow) {
  const steps = flow.steps || [];
  const gates = steps.filter((s) => s.human || s.sensitive).map((s) => s.step_id);
  const sensitive = steps.filter((s) => s.sensitive).map((s) => s.step_id);
  const unresolved = steps
    .filter((s) => s.do && s.do.action === 'run_command' && /\{\{/.test(String(s.do.command || '')))
    .map((s) => s.step_id);
  return {
    id: flow.id,
    version: flow.version,
    status: flow.status,
    steps: steps.length,
    gates,
    sensitive,
    destructive: !!flow.destructive,
    confirm_value: flow.confirm_value || null,
    commands: steps.filter((s) => s.do && s.do.action === 'run_command')
      .map((s) => ({ step_id: s.step_id, command: s.do.command })),
    unresolved_placeholders: unresolved
  };
}

// 骨架执行器：只做“走到人机门就停”；不执行 shell、不代填密钥。
// 真正执行顺序：浏览器动作 → 扩展；run_command → vault 物化后由受控 runner 执行（第二期）。
async function runFlow(flow, opts = {}) {
  const bridge = opts.bridge || null;
  const emit = opts.onEvent || (() => {});
  const steps = flow.steps || [];
  // 破坏性流程：必须由人在终端亲手输入确认值（二次人工确认的第一道）
  if (flow.destructive) {
    if (!opts.confirmValue) {
      return { ok: false, reason: 'confirm_required', expected: flow.confirm_value || null };
    }
    if (flow.confirm_value && String(opts.confirmValue) !== String(flow.confirm_value)) {
      return { ok: false, reason: 'confirm_mismatch', expected: flow.confirm_value };
    }
  }
  const stop = (s, i, reason, extra) => {
    const out = Object.assign({ ok: false, stoppedAt: s.step_id, index: i, reason }, extra || {});
    emit({ type: 'step_failed', step_id: s.step_id, index: i, reason });
    return out;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.human || s.sensitive) {
      emit({ type: 'needs_human', step_id: s.step_id, index: i });
      return { ok: false, stoppedAt: s.step_id, index: i, reason: 'human_gate' };
    }
    const action = s.do && s.do.action;
    if (action === 'run_command') {
      const cmd = String(s.do.command || '');
      if (/\{\{/.test(cmd)) return stop(s, i, 'unresolved_credentials');
      if (!opts.runCommand) return stop(s, i, 'command_runner_not_implemented');
      emit({ type: 'exec', step_id: s.step_id, index: i });
      let r;
      try {
        r = await opts.runCommand(cmd, { allowDestructive: !!opts.allowDestructive });
      } catch (e) {
        return stop(s, i, 'command_rejected', { detail: { error: String((e && e.message) || e) } });
      }
      if (!r || !r.ok) return stop(s, i, 'command_failed', { detail: r });
      continue;
    }
    if (!bridge || !bridge.connected()) {
      return stop(s, i, 'bridge_not_connected');
    }
    emit({ type: 'exec', step_id: s.step_id, index: i });
    const res = await bridge.exec(s);
    if (!res || !res.ok) {
      return stop(s, i, 'step_failed', { detail: res });
    }
  }
  return { ok: true, completed: steps.length };
}

// ---------------------------------------------------------------------------
// 流程变量：{{name}} 替换
//   flow.variables = { name: {default?, description?} } 或 { name: '默认值' }
// ---------------------------------------------------------------------------
const VAR_RE = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;

function collectVarNames(node, out) {
  if (typeof node === 'string') {
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(node))) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  } else if (Array.isArray(node)) {
    node.forEach((n) => collectVarNames(n, out));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((n) => collectVarNames(n, out));
  }
  return out;
}

function substitute(node, vars) {
  if (typeof node === 'string') {
    return node.replace(VAR_RE, (whole, name) =>
      vars[name] !== undefined ? String(vars[name]) : whole);
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, vars));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, vars);
    return out;
  }
  return node;
}

// 返回 {flow(替换后), vars, missing(必填缺参), unresolved(替换后仍存在的变量)}
function resolveFlowVars(flow, provided = {}) {
  const decl = flow.variables && typeof flow.variables === 'object' && !Array.isArray(flow.variables)
    ? flow.variables : {};
  const vars = {};
  const missing = [];
  for (const [name, spec] of Object.entries(decl)) {
    if (provided[name] !== undefined) vars[name] = provided[name];
    else if (spec && typeof spec === 'object' && spec.default !== undefined) vars[name] = spec.default;
    else if (spec !== null && typeof spec !== 'object') vars[name] = spec; // 简写：name: '默认值'
    else missing.push(name);
  }
  for (const [name, v] of Object.entries(provided)) {
    if (vars[name] === undefined) vars[name] = v;
  }
  const resolved = substitute(flow, vars);
  return { flow: resolved, vars, missing, unresolved: collectVarNames(resolved, []) };
}

// 记录值参数化（P2）：明显是用户特定的值 → 变量，原值不写进流程
function useVar(vars, name, description) {
  if (!vars[name]) vars[name] = { description };
  return `{{${name}}}`;
}

function paramValue(hint, raw, vars) {
  const h = String(hint || '').toLowerCase();
  const v = String(raw == null ? '' : raw);
  if (/^srvprice-/i.test(v)) {
    return useVar(vars, 'group_name', '新建资源名称（原值已剥离）');
  }
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) {
    const isSource = /source|来源|cidr|ip/.test(h);
    return isSource
      ? useVar(vars, 'source_cidr', '允许访问的来源 CIDR，例如 1.2.3.4/32')
      : useVar(vars, 'ip', '目标 IP');
  }
  if (/^\d{1,5}$/.test(v) && /port|端口/.test(h)) {
    return useVar(vars, 'port', '目标端口');
  }
  return v;
}

// 记录事件 → 流程草稿（P1/P2）。只保留可重放的语义动作；verify 用页面标题占位。
function eventsToFlow(events, meta = {}) {
  const steps = [];
  const vars = {};
  let lastKey = null;
  let n = 0;
  for (const ev of events || []) {
    if (!ev || !ev.action) continue;
    let doObj = null;
    if (ev.action === 'click' && ev.match) {
      const text = String(ev.match.text || ev.match.label || '').slice(0, 40);
      if (text) doObj = { action: 'click', match: { text } };
    } else if (ev.action === 'fill_form' && ev.match) {
      const hint = String(ev.match.text || '');
      doObj = {
        action: 'fill_form',
        fields: [{ match: { text: hint }, value: paramValue(hint, ev.value, vars) }]
      };
    }
    if (!doObj) continue;
    const key = JSON.stringify(doObj);
    if (key === lastKey) continue; // 连点 / 重复输入合并
    lastKey = key;
    n += 1;
    steps.push({
      step_id: 'r' + n,
      do: doObj,
      verify: { text: String(ev.page_title || 'srvprice').slice(0, 40), timeout_ms: 8000 },
      fail_when: {},
      human: false,
      sensitive: false,
      note: '自动记录：verify 用页面标题占位，执行前需人工校准'
    });
  }
  const flow = {
    id: String(meta.id || 'recorded.flow'),
    version: 1,
    status: 'draft',
    vendor: String(meta.vendor || ''),
    title: String(meta.title || '自动记录流程'),
    variables: vars,
    entry: (events && events[0] && events[0].url) || '',
    preconditions: ['由记录模式生成；执行前需人工校准 verify 与参数'],
    steps,
    notes: `2026-11-21 记录生成：事件 ${(events || []).length} 条，去重后 ${steps.length} 步；` +
      `自动参数化 ${Object.keys(vars).length} 个变量。`
  };
  if (meta.success) {
    flow.meta = { recorded_success: true, recorded_at: new Date().toISOString() };
  }
  return flow;
}

module.exports = {
  ACTIONS, loadFlows, validateFlow, planFlow, runFlow, resolveFlowVars, eventsToFlow
};
