'use strict';

// 多厂商安全组「开端口」适配器（2026-11-21 第二期）。
// 红线（派单）：只新建专用安全组 + 加规则；不修改现有组、不绑定实例、不 deploy。
// 所有写操作默认不执行，由 bin 的 --dry-run/--yes 闸门控制；本模块只提供命令构造与解析。
//
// 三家 CLI 均以 JSON 输出；参数名按 2026-11-21 的 --help 核实。

const { spawn } = require('child_process');
const fs = require('fs');

// Windows 上 jdc 是 .cmd 包了一层 py311 的 jdc.exe；直接 spawn .cmd 会 ENOENT。
// 路径因机器而异，这里只留可执行名兜底，实际路径用环境变量指定：
//   SRVPRICE_JDC_BIN / SRVPRICE_CTYUN_BIN
const KNOWN_BIN = {
  jdc: process.env.SRVPRICE_JDC_BIN ? [process.env.SRVPRICE_JDC_BIN] : ['jdc'],
  'ctyun-cli': process.env.SRVPRICE_CTYUN_BIN ? [process.env.SRVPRICE_CTYUN_BIN] : ['ctyun-cli']
};

function resolveBin(bin) {
  if (process.env[`SRVPRICE_BIN_${String(bin).toUpperCase()}`]) {
    return process.env[`SRVPRICE_BIN_${String(bin).toUpperCase()}`];
  }
  for (const c of KNOWN_BIN[bin] || []) {
    if (fs.existsSync(c)) return c;
  }
  return bin;
}

function run(bin, args, opts = {}) {
  bin = resolveBin(bin);
  const timeout = opts.timeout || 60000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: Object.assign({}, process.env, opts.env || {}),
      windowsHide: true
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      reject(new Error(`${bin} ${args[0] || ''} 超时（${timeout}ms）`));
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = (err || out || '').trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
        reject(new Error(`${bin} 退出码 ${code}：${msg || '(无输出)'}`));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

function parseJson(text, what) {
  const t = String(text || '').trim();
  if (!t) throw new Error(`${what} 没有输出`);
  try { return JSON.parse(t); } catch (_) {
    throw new Error(`${what} 返回非 JSON：${t.slice(0, 200)}`);
  }
}

function normalizeCidr(source) {
  return source.includes('/') ? source : `${source}/32`;
}

// 组名/描述只允许 ASCII（火山/阿里对中文名有限制，且跨 CLI 解析易出问题）
function groupNameFor(ip, port) {
  return `srvprice-${ip.replace(/\./g, '-')}-${port}`;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// 阿里云
// ---------------------------------------------------------------------------
const aliyun = {
  id: 'aliyun',
  bin: 'aliyun',
  needsRegion: true,
  _base(ctx) {
    return ctx.vendorProfile ? ['--profile', ctx.vendorProfile] : [];
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('aliyun', [
      'ecs', 'DescribeInstances',
      '--RegionId', ctx.region,
      '--PageSize', '100',
      ...this._base(ctx)
    ], ctx);
    const j = parseJson(stdout, 'aliyun DescribeInstances');
    const list = arr(j.Instances && j.Instances.Instance);
    const hit = list.find((it) => {
      const pub = arr(it.PublicIpAddress && it.PublicIpAddress.IpAddress);
      const eip = it.EipAddress && it.EipAddress.IpAddress;
      return pub.includes(ip) || eip === ip;
    });
    if (!hit) return null;
    return {
      id: hit.InstanceId,
      name: hit.InstanceName || hit.InstanceId,
      region: hit.RegionId || ctx.region,
      vpcId: hit.VpcAttributes && hit.VpcAttributes.VpcId || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('aliyun', [
      'ecs', 'DescribeSecurityGroups',
      '--RegionId', ctx.region,
      '--PageSize', '100',
      ...this._base(ctx)
    ], ctx);
    const j = parseJson(stdout, 'aliyun DescribeSecurityGroups');
    return arr(j.SecurityGroups && j.SecurityGroups.SecurityGroup).map((g) => ({
      id: g.SecurityGroupId,
      name: g.SecurityGroupName,
      vpcId: g.VpcId || null
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('aliyun', [
      'ecs', 'DescribeSecurityGroupAttribute',
      '--RegionId', ctx.region,
      '--SecurityGroupId', gid,
      ...this._base(ctx)
    ], ctx);
    const j = parseJson(stdout, 'aliyun DescribeSecurityGroupAttribute');
    return arr(j.Permissions && j.Permissions.Permission).map((r) => ({
      proto: String(r.IpProtocol || '').toLowerCase(),
      port: String(r.PortRange || '').split('/')[0],
      source: r.SourceCidrIp || null,
      action: String(r.Policy || '').toLowerCase(),
      priority: r.Priority !== undefined ? Number(r.Priority) : null
    }));
  },
  createArgs(ctx, server, name, description) {
    const a = ['ecs', 'CreateSecurityGroup', '--RegionId', ctx.region, '--VpcId', server.vpcId];
    if (name) a.push('--SecurityGroupName', name);
    if (description) a.push('--Description', description);
    return a.concat(this._base(ctx));
  },
  addRuleArgs(ctx, gid, rule) {
    return [
      'ecs', 'AuthorizeSecurityGroup',
      '--RegionId', ctx.region,
      '--SecurityGroupId', gid,
      '--Permissions.0.IpProtocol', rule.proto,
      '--Permissions.0.PortRange', `${rule.port}/${rule.port}`,
      '--Permissions.0.SourceCidrIp', normalizeCidr(rule.source),
      '--Permissions.0.Policy', 'accept',
      // 数字越小优先级越高：默认放低（100），避免抢占现有规则
      '--Permissions.0.Priority', String(Math.min(100, Math.max(1, rule.priority || 100))),
      ...this._base(ctx)
    ];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 'aliyun CreateSecurityGroup');
    return j.SecurityGroupId || null;
  }
};

// ---------------------------------------------------------------------------
// 腾讯云
// ---------------------------------------------------------------------------
const tencent = {
  id: 'tencent',
  bin: 'tccli',
  needsRegion: true,
  _base(ctx) {
    const a = [];
    if (ctx.region) a.push('--region', ctx.region);
    if (ctx.vendorProfile) a.push('--profile', ctx.vendorProfile);
    return a;
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('tccli', [
      'cvm', 'DescribeInstances', '--Limit', '100', ...this._base(ctx)
    ], ctx);
    const j = parseJson(stdout, 'tccli DescribeInstances');
    const hit = arr(j.InstanceSet).find((it) => arr(it.PublicIpAddresses).includes(ip));
    if (!hit) return null;
    return {
      id: hit.InstanceId,
      name: hit.InstanceName || hit.InstanceId,
      region: hit.Placement && hit.Placement.Zone ? String(hit.Placement.Zone).replace(/\d+$/, '') : ctx.region,
      vpcId: hit.VirtualPrivateCloud && hit.VirtualPrivateCloud.VpcId || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('tccli', ['vpc', 'DescribeSecurityGroups', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'tccli DescribeSecurityGroups');
    return arr(j.SecurityGroupSet).map((g) => ({
      id: g.SecurityGroupId,
      name: g.SecurityGroupName,
      vpcId: g.VpcId || null
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('tccli', ['vpc', 'DescribeSecurityGroupPolicies', '--SecurityGroupId', gid, ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'tccli DescribeSecurityGroupPolicies');
    const set = j.SecurityGroupPolicySet || {};
    return arr(set.Ingress).map((r) => ({
      proto: String(r.Protocol || '').toLowerCase(),
      port: String(r.Port || '').split(/[-/]/)[0],
      source: r.CidrBlock || null,
      action: String(r.Action || '').toLowerCase(),
      priority: r.PolicyIndex !== undefined ? Number(r.PolicyIndex) : null
    }));
  },
  createArgs(ctx, server, name, description) {
    const a = ['vpc', 'CreateSecurityGroup', '--GroupName', name, '--GroupDescription', description, ...this._base(ctx)];
    return a;
  },
  addRuleArgs(ctx, gid, rule) {
    const set = {
      Ingress: [{
        Protocol: rule.proto,
        Port: String(rule.port),
        CidrBlock: normalizeCidr(rule.source),
        Action: 'ACCEPT',
        PolicyDescription: 'srvprice open-port'
      }]
    };
    return ['vpc', 'CreateSecurityGroupPolicies', '--SecurityGroupId', gid,
      '--SecurityGroupPolicySet', JSON.stringify(set), ...this._base(ctx)];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 'tccli CreateSecurityGroup');
    return (j.SecurityGroup && j.SecurityGroup.SecurityGroupId) || null;
  }
};

// ---------------------------------------------------------------------------
// 火山引擎
// ---------------------------------------------------------------------------
const volcengine = {
  id: 'volcengine',
  bin: 've',
  needsRegion: true,
  _base(ctx) {
    const a = [];
    if (ctx.region) a.push('--region', ctx.region);
    if (ctx.vendorProfile) a.push('--profile', ctx.vendorProfile);
    return a;
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('ve', ['ecs', 'DescribeInstances', '--MaxResults', '100', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 've DescribeInstances');
    const res = j.Result || j.result || {};
    const hit = arr(res.Instances).find((it) => {
      const eip = it.EipAddress && it.EipAddress.IpAddress;
      const pub = it.PublicIpAddress || null;
      return eip === ip || pub === ip;
    });
    if (!hit) return null;
    return {
      id: hit.InstanceId,
      name: hit.InstanceName || hit.InstanceId,
      region: hit.RegionId || ctx.region,
      vpcId: hit.VpcId || null,
      zoneId: hit.ZoneId || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('ve', ['vpc', 'DescribeSecurityGroups', '--MaxResults', '100', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 've DescribeSecurityGroups');
    const res = j.Result || j.result || {};
    return arr(res.SecurityGroups || res.SecurityGroupSet).map((g) => ({
      id: g.SecurityGroupId,
      name: g.SecurityGroupName,
      vpcId: g.VpcId || null
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('ve', ['vpc', 'DescribeSecurityGroupAttributes', '--SecurityGroupId', gid, ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 've DescribeSecurityGroupAttributes');
    const res = j.Result || j.result || {};
    return arr(res.Permissions).map((r) => ({
      proto: String(r.Protocol || '').toLowerCase(),
      port: r.PortStart !== undefined ? String(r.PortStart) : null,
      source: r.CidrIp || null,
      action: String(r.Policy || '').toLowerCase(),
      priority: r.Priority !== undefined ? Number(r.Priority) : null
    }));
  },
  createArgs(ctx, server, name, description) {
    const a = ['vpc', 'CreateSecurityGroup', '--VpcId', server.vpcId];
    if (name) a.push('--SecurityGroupName', name);
    if (description) a.push('--Description', description);
    return a.concat(this._base(ctx));
  },
  addRuleArgs(ctx, gid, rule) {
    return [
      'vpc', 'AuthorizeSecurityGroupIngress',
      '--SecurityGroupId', gid,
      '--Protocol', rule.proto,
      '--PortStart', String(rule.port),
      '--PortEnd', String(rule.port),
      '--CidrIp', normalizeCidr(rule.source),
      '--Policy', 'accept',
      '--Priority', String(Math.min(100, Math.max(1, rule.priority || 100))),
      ...this._base(ctx)
    ];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 've CreateSecurityGroup');
    const res = j.Result || j.result || {};
    return res.SecurityGroupId || null;
  }
};

// ---------------------------------------------------------------------------
// 百度智能云（bce vpc）
// ---------------------------------------------------------------------------
const baidu = {
  id: 'baidu',
  bin: 'bce',
  needsRegion: true,
  _base(ctx) {
    const a = ['--region', ctx.region];
    if (ctx.vendorProfile) a.push('--profile', ctx.vendorProfile);
    return a;
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('bce', ['bcc', 'ListInstances', '--maxKeys', '100', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'bce ListInstances');
    const list = arr(j.instances || (j.result && j.result.instances));
    const hit = list.find((it) => (it.publicIp || it.publicIpAddress) === ip);
    if (!hit) return null;
    return {
      id: String(hit.id || hit.instanceId),
      name: hit.name || '',
      region: ctx.region,
      vpcId: hit.vpcId || (hit.vpc && hit.vpc.id) || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('bce', ['vpc', 'QuerySecurityGroupsList', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'bce QuerySecurityGroupsList');
    return arr(j.securityGroups || j.securityGroupList).map((g) => ({
      id: g.securityGroupId,
      name: g.name || g.securityGroupName,
      vpcId: g.vpcId || null
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('bce', ['vpc', 'GetSecurityGroupDetails', '--securityGroupId', gid, ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'bce GetSecurityGroupDetails');
    return arr(j.rules || j.securityGroupRules).map((r) => ({
      proto: String(r.protocol || '').toLowerCase(),
      port: String(r.portRange || '').split('-')[0],
      source: r.sourceIp || null,
      action: 'accept',
      priority: null
    }));
  },
  createArgs(ctx, server, name, description) {
    return ['vpc', 'CreateSecurityGroup', '--vpcId', server.vpcId,
      '--name', name, '--desc', description, ...this._base(ctx)];
  },
  addRuleArgs(ctx, gid, rule) {
    const r = {
      direction: 'ingress',
      ethertype: 'IPv4',
      portRange: String(rule.port),
      protocol: rule.proto,
      sourceIp: normalizeCidr(rule.source),
      remark: 'srvprice open-port'
    };
    return ['vpc', 'AuthorizeSecurityGroupRules', '--securityGroupId', gid,
      '--rule', JSON.stringify(r), ...this._base(ctx)];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 'bce CreateSecurityGroup');
    return j.securityGroupId || (j.result && j.result.securityGroupId) || null;
  }
};

// ---------------------------------------------------------------------------
// 京东云（jdc vpc）
// 注意：规则字段名按 jdc help 的示意写成 best-effort，首次真写前需核对响应。
// ---------------------------------------------------------------------------
const jdcloud = {
  id: 'jdcloud',
  bin: 'jdc',
  needsRegion: true,
  _base(ctx) {
    return ['--region-id', ctx.region];
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('jdc', ['vm', 'describe-instances', '--page-size', '100', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'jdc describe-instances');
    const res = j.result || j;
    const list = arr(res.instances);
    const hit = list.find((it) => (it.publicIpAddress || it.elasticIpAddress || it.privateIpAddress) === ip);
    if (!hit) return null;
    return {
      id: String(hit.instanceId),
      name: hit.instanceName || hit.instanceId,
      region: ctx.region,
      vpcId: hit.vpcId || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('jdc', ['vpc', 'describe-network-security-groups', '--page-size', '100', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'jdc describe-network-security-groups');
    const res = j.result || j;
    return arr(res.networkSecurityGroups).map((g) => ({
      id: g.networkSecurityGroupId,
      name: g.networkSecurityGroupName,
      vpcId: g.vpcId || null
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('jdc', ['vpc', 'describe-network-security-group', '--network-security-group-id', gid, ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'jdc describe-network-security-group');
    const res = j.result || j;
    const g = res.networkSecurityGroup || res;
    return arr(g.securityGroupRules || g.rules).map((r) => ({
      proto: String(r.protocol || '').toLowerCase(),
      port: String(r.portRangeMin != null ? r.portRangeMin : '').split('-')[0],
      source: r.addressPrefix || r.sourceIp || null,
      action: String(r.ruleAction || '').toLowerCase(),
      priority: null
    }));
  },
  createArgs(ctx, server, name, description) {
    return ['vpc', 'create-network-security-group',
      '--network-security-group-name', name,
      '--vpc-id', server.vpcId,
      '--description', description, ...this._base(ctx)];
  },
  addRuleArgs(ctx, gid, rule) {
    const specs = [{
      protocol: rule.proto,
      portRangeMin: rule.port,
      portRangeMax: rule.port,
      direction: 'ingress',
      addressPrefix: normalizeCidr(rule.source),
      ruleAction: 'allow'
    }];
    return ['vpc', 'add-network-security-group-rules',
      '--network-security-group-id', gid,
      '--network-security-group-rule-specs', JSON.stringify(specs), ...this._base(ctx)];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 'jdc create-network-security-group');
    const res = j.result || j;
    return res.networkSecurityGroupId || (res.networkSecurityGroup && res.networkSecurityGroup.networkSecurityGroupId) || null;
  }
};

// ---------------------------------------------------------------------------
// 天翼云（ctyun-cli vpc）
// ---------------------------------------------------------------------------
const ctyun = {
  id: 'ctyun',
  bin: 'ctyun-cli',
  needsRegion: true,
  _base(ctx) {
    const a = ['--regionID', ctx.region, '--output', 'json'];
    if (ctx.vendorProfile) a.push('--cli-profile', ctx.vendorProfile);
    return a;
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('ctyun-cli', ['ecs', 'ListEcsInstances', '--pageSize', '50', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'ctyun ListEcsInstances');
    const body = j.returnObj || j.result || j;
    const list = arr(body.results || body.instances);
    const hit = list.find((it) => (it.publicIP || it.eipAddress || it.publicIp) === ip);
    if (!hit) return null;
    return {
      id: String(hit.instanceID || hit.instanceId || hit.id),
      name: hit.displayName || hit.instanceName || '',
      region: ctx.region,
      vpcId: hit.vpcID || hit.vpcId || (hit.vpc && hit.vpc.vpcID) || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('ctyun-cli', ['vpc', 'QueryVpcSecurityGroups', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'ctyun QueryVpcSecurityGroups');
    const body = j.returnObj || j.result || j;
    return arr(body.securityGroups || body.results).map((g) => ({
      id: g.securityGroupID || g.securityGroupId,
      name: g.securityGroupName || g.name,
      vpcId: g.vpcID || g.vpcId || null
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('ctyun-cli', ['vpc', 'DescribeVpcSecurityGroupRules', '--securityGroupID', gid, ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'ctyun DescribeVpcSecurityGroupRules');
    const body = j.returnObj || j.result || j;
    return arr(body.securityGroupRules || body.results).map((r) => ({
      proto: String(r.protocol || '').toLowerCase(),
      port: String(r.range || '').split('-')[0],
      source: r.destCidrIp || r.srcCidrIp || null, // 官方字段名 destCidrIp 表示远端地址
      action: String(r.action || '').toLowerCase(),
      priority: r.priority !== undefined ? Number(r.priority) : null
    }));
  },
  createArgs(ctx, server, name, description) {
    const token = require('crypto').randomBytes(16).toString('hex');
    const a = ['vpc', 'CreateVpcSecurityGroup',
      '--clientToken', token,
      '--name', name,
      '--vpcID', server.vpcId,
      '--regionID', ctx.region, '--output', 'json'];
    if (description) a.push('--description', description);
    if (ctx.vendorProfile) a.push('--cli-profile', ctx.vendorProfile);
    return a;
  },
  addRuleArgs(ctx, gid, rule) {
    const token = require('crypto').randomBytes(16).toString('hex');
    const rules = [{
      direction: 'ingress',
      remoteType: 0,
      action: 'accept',
      priority: Math.min(100, Math.max(1, rule.priority || 100)),
      protocol: String(rule.proto || 'tcp').toUpperCase(),
      ethertype: 'IPv4',
      destCidrIp: normalizeCidr(rule.source),
      range: String(rule.port),
      description: 'srvprice open-port'
    }];
    return ['vpc', 'CreateVpcSecurityGroupIngress',
      '--clientToken', token,
      '--regionID', ctx.region,
      '--securityGroupID', gid,
      '--securityGroupRules', JSON.stringify(rules),
      '--output', 'json',
      ...(ctx.vendorProfile ? ['--cli-profile', ctx.vendorProfile] : [])];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 'ctyun CreateVpcSecurityGroup');
    const body = j.returnObj || j.result || j;
    return body.securityGroupID || body.securityGroupId || null;
  }
};

// ---------------------------------------------------------------------------
// UCloud（公共云 VPC API，经 ucloud api 调用）
// 注意：UCloud 有两套 API，这里用的是公共云 VPC：CreateSecGroup / DescribeSecGroup / CreateSecGroupRule
// ---------------------------------------------------------------------------
const ucloud = {
  id: 'ucloud',
  bin: 'ucloud',
  needsRegion: true,
  _base(ctx) {
    const a = ['--region', ctx.region, '--output', 'json'];
    if (ctx.vendorProfile) a.push('--profile', ctx.vendorProfile);
    return a;
  },
  async serverByIp(ctx, ip) {
    const { stdout } = await run('ucloud', ['uhost', 'list', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'ucloud uhost list');
    const list = arr(j.UHostSet);
    const hit = list.find((it) => {
      const ips = arr(it.IPSet).map((x) => x.IP);
      return it.PublicIP === ip || ips.includes(ip);
    });
    if (!hit) return null;
    return {
      id: String(hit.UHostId || hit.ResourceID || hit.Id),
      name: hit.UHostName || hit.Name || '',
      region: ctx.region,
      vpcId: hit.VPCId || hit.VPCID || null
    };
  },
  async listGroups(ctx) {
    const { stdout } = await run('ucloud', ['api', '--Action', 'DescribeSecGroup', '--Limit', '100', ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'ucloud DescribeSecGroup');
    return arr(j.DataSet).map((g) => ({
      id: g.SecGroupId || g.SecGroupID,
      name: g.SecGroupName || g.Name,
      vpcId: g.VPCId || g.VPCID || null,
      raw: g
    }));
  },
  async listRules(ctx, gid) {
    const { stdout } = await run('ucloud', ['api', '--Action', 'DescribeSecGroup', '--SecGroupId.0', gid, ...this._base(ctx)], ctx);
    const j = parseJson(stdout, 'ucloud DescribeSecGroup');
    const g = arr(j.DataSet).find((x) => (x.SecGroupId || x.SecGroupID) === gid) || {};
    const rules = arr(g.SGRuleInfo || g.Rules);
    return rules.map((r) => ({
      proto: String(r.ProtocolType || '').toLowerCase(),
      port: String(r.DstPort || '').split(',')[0],
      source: r.SrcIP || null,
      action: String(r.RuleAction || '').toLowerCase(),
      priority: r.Priority !== undefined ? r.Priority : null
    }));
  },
  createArgs(ctx, server, name, description) {
    const a = ['api', '--Action', 'CreateSecGroup', '--Name', name, '--VPCID', server.vpcId,
      ...this._base(ctx)];
    if (description) a.push('--Remark', description);
    return a;
  },
  addRuleArgs(ctx, gid, rule) {
    const priority = Math.min(200, Math.max(1, rule.priority || 100));
    return ['api', '--Action', 'CreateSecGroupRule',
      '--SecGroupId', gid,
      '--Rule.0.Direction', 'Ingress',
      '--Rule.0.IPRange', normalizeCidr(rule.source),
      '--Rule.0.Priority', String(priority),
      '--Rule.0.ProtocolType', String(rule.proto || 'tcp').toUpperCase(),
      '--Rule.0.DstPort', String(rule.port),
      '--Rule.0.RuleAction', 'Accept',
      '--Rule.0.Remark', 'srvprice open-port',
      '--Rule.0.IPVersion', 'IPv4',
      ...this._base(ctx)];
  },
  groupIdFrom(createOut) {
    const j = parseJson(createOut, 'ucloud CreateSecGroup');
    return j.SecGroupId || j.SecGroupID || null;
  }
};

const ADAPTERS = { aliyun, tencent, volcengine, baidu, jdcloud, ctyun, ucloud };

function get(id) {
  return ADAPTERS[id] || null;
}

function ids() {
  return Object.keys(ADAPTERS);
}

module.exports = { get, ids, groupNameFor, normalizeCidr, run };
