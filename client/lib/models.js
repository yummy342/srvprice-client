'use strict';

// 大模型厂商（phase 3，BYOK）：厂商目录 + 统一 OpenAI 兼容调用配置解析。
// 事实来源：Downloads\srvprice-model-vendors-spec-20261120.md（官方页直读）。
// 硬规则：不转售、key 只进 vault、不硬编码价格、UNVERIFIED 厂商不接入。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DATA = path.join(__dirname, '..', 'data', 'model-vendors.json');

class ModelConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ModelConfigError';
    this.code = code;
  }
}

function loadCatalog() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

function listVendors(opts = {}) {
  const all = loadCatalog().vendors;
  return opts.includeUnverified ? all : all.filter((v) => v.status === 'verified');
}

function getVendor(id) {
  const v = loadCatalog().vendors.find((x) => x.id === id);
  if (!v) throw new ModelConfigError(`未知模型厂商：${id}`, 'unknown_vendor');
  return v;
}

// 解析实际调用的 base_url（处理三处特殊形态：百炼 WorkspaceId、方舟 key 类型、DeepSeek 不带 /v1）
function resolveConfig(vendor, opts = {}) {
  if (!vendor) throw new ModelConfigError('缺少厂商', 'unknown_vendor');
  if (vendor.status !== 'verified') {
    throw new ModelConfigError(`${vendor.label} 的 endpoint 尚未核实，暂不接入`, 'unverified_vendor');
  }
  if (vendor.id === 'aliyun-bailian') {
    const ws = String(opts.workspace_id || opts.workspaceId || '').trim();
    const region = String(opts.region || '').trim();
    if (!ws) {
      throw new ModelConfigError('百炼需要业务空间 ID（WorkspaceId），客户端不猜默认值', 'workspace_required');
    }
    if (!vendor.regions.includes(region)) {
      throw new ModelConfigError(`百炼地域必须是 ${vendor.regions.join(' / ')} 之一`, 'region_required');
    }
    const base = vendor.base_url_template
      .replace('{workspace_id}', ws)
      .replace('{region}', region);
    return {
      base_url: base,
      workspace_id: ws,
      region,
      note: '百炼 key 按地域绑定：跨地域调用会返回 401 invalid_api_key，不是 key 失效'
    };
  }
  if (vendor.id === 'volcengine-ark') {
    const keyType = String(opts.key_type || opts.keyType || 'paygo');
    if (!vendor.key_types.includes(keyType)) {
      throw new ModelConfigError('方舟 key 类型只能是 paygo / coding / agent', 'key_type_invalid');
    }
    if (!vendor.base_urls[keyType]) {
      throw new ModelConfigError(
        'Agent Plan key 只有 Anthropic 兼容地址，客户端目前只实现 OpenAI 形态，不支持',
        'agent_plan_unsupported'
      );
    }
    return { base_url: vendor.base_urls[keyType], key_type: keyType };
  }
  if (!vendor.base_url) throw new ModelConfigError('该厂商缺少 base_url', 'no_base_url');
  return { base_url: vendor.base_url };
}

// 厂商差异：参数过滤（MiniMax 不支持 temperature / top_p）
function sanitizeParams(vendor, params = {}) {
  const out = Object.assign({}, params);
  for (const p of vendor.unsupported_params || []) delete out[p];
  return out;
}

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return `*…（${s.length} 位）`;
  return `${s.slice(0, 4)}…（${s.length} 位）`;
}

// 最小验证：读模型列表。成功才允许存 vault。（spec §4.6）
async function verifyKey(vendor, key, config, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 15000);
  const url = config.base_url.replace(/\/+$/, '') + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal
    });
    let body = '';
    try { body = await res.text(); } catch (_) {}
    if (!res.ok) {
      let detail = body.slice(0, 200);
      try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch (_) {}
      return { ok: false, status: res.status, error: String(detail).slice(0, 300) };
    }
    let modelCount = null;
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j.data)) modelCount = j.data.length;
    } catch (_) {}
    return { ok: true, status: res.status, model_count: modelCount };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? '验证超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function vaultAddPath() {
  return process.env.SRVPRICE_VAULT_ADD ||
    path.join('C:', 'project', 'srv-vault', 'srv-vault-bundle', 'vault-add.js');
}

function vaultCliPath() {
  return process.env.SRVPRICE_VAULT_CLI ||
    path.join('C:', 'project', 'srv-vault', 'srv-vault-bundle', 'vault-cli.js');
}

function slug(vendorId) {
  return String(vendorId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function keyItem(vendor) {
  return { name: `MODEL_${slug(vendor.id)}_KEY`, env: vendor.env || 'MODEL_API_KEY' };
}

// 写入 vault：值只经 stdin 传给 vault-add，不落日志
function vaultAdd(item, value, reason) {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [vaultAddPath(), item.name, '--env', item.env,
        '--escape', reason || 'srvprice client 保存用户自己的模型 API key'], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => resolve({ ok: false, message: e.message }));
      child.on('close', (code) => resolve({ ok: code === 0, message: (out || err || '').slice(0, 300) }));
      child.stdin.write(String(value));
      child.stdin.end();
    } catch (e) {
      resolve({ ok: false, message: e.message });
    }
  });
}

function vaultListNames() {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, [vaultCliPath(), 'list'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => {
        try {
          const j = JSON.parse(String(out || '[]'));
          const arr = Array.isArray(j) ? j : (j.items || []);
          resolve(new Set(arr.map((x) => x.name)));
        } catch (_) { resolve(new Set()); }
      });
      child.on('error', () => resolve(new Set()));
    } catch (_) {
      resolve(new Set());
    }
  });
}

module.exports = {
  ModelConfigError,
  loadCatalog,
  listVendors,
  getVendor,
  resolveConfig,
  sanitizeParams,
  maskKey,
  verifyKey,
  keyItem,
  vaultAdd,
  vaultListNames
};
