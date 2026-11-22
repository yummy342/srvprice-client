'use strict';

// 厂商适配层：srvprice 不做控制面，把统一命令转发给厂商自己的 CLI 执行。
// 适配器契约统一：输入统一参数，输出统一 host 结构；厂商差异消化在这里。
// 消化不了的（CLI 没装、版本不够、凭据失效、厂商报错）一律明确报出，不吞错。

const { execFile } = require('child_process');
const { CliError, EXIT } = require('./core');

const DEFAULT_TIMEOUT = 120000;

// 测试 / 特殊环境可直接指定某厂商 CLI 的可执行路径
function binFor(vendor, fallback) {
  return process.env[`SRVPRICE_BIN_${vendor.toUpperCase()}`] || fallback;
}

// 多地域查询进度：SRVPRICE_PROGRESS=1 时向 stderr 写 JSONL
//   {"level":"progress","provider":"tencent","done":3,"total":19,"region":"ap-beijing"}
function emitProgress(vendor, done, total, region) {
  if (process.env.SRVPRICE_PROGRESS !== '1') return;
  try {
    process.stderr.write(JSON.stringify({
      level: 'progress', provider: vendor, done, total, region: region || null
    }) + '\n');
  } catch (_) { /* 进度写不出去不影响主流程 */ }
}

// 限制并发数地跑一批任务（多地域查询用：腾讯 19 个地域同时起 19 个 tccli 太重）
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function run(bin, args, opts) {
  const timeout = ((opts && opts.timeout) || DEFAULT_TIMEOUT);
  // 允许把某厂商 CLI 指向一个 JS 脚本（测试桩 / 自封装 wrapper）
  const isScript = /\.(c|m)?js$/i.test(bin);
  const cmd = isScript ? process.execPath : bin;
  const cmdArgs = isScript ? [bin, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, cmdArgs, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      if (err.code === 'ENOENT') {
        return reject(new CliError(EXIT.CRED,
          `厂商 CLI 未安装：${bin}`,
          { vendor: opts && opts.vendor, reason: 'cli_missing', bin }));
      }
      if (err.killed || err.signal) {
        return reject(new CliError(EXIT.VENDOR,
          `${bin} 执行超时（${timeout}ms）`,
          { vendor: opts && opts.vendor, reason: 'timeout' }));
      }
      const text = `${stderr || ''} ${stdout || ''}`.trim();
      // ★ 凭据在、但子账号没绑资源策略：UCloud 返回 RetCode 299「IAM permission error」。
      //   归到凭据/权限类（5），别让用户以为是厂商故障或 CLI 版本问题。
      if (/IAM permission error|RetCode:\s*299/i.test(text)) {
        return reject(new CliError(EXIT.CRED,
          `${bin} 权限不足（RetCode 299）：请给该子账号绑定资源只读策略或加入项目授予只读角色`,
          { vendor: opts && opts.vendor, reason: 'permission_denied', stderr: text.slice(0, 2000) }));
      }
      // 中文厂商的提示也要识别（天翼云：access_key 未配置，请通过…设置）
      // ★ 真机核对（2026-11-19）：火山 `credentials not configured, please run 've login' or 've configure set'`；
      //   百度 `Error: no profile configured; run \`bce configure set\``；腾讯 `secretId is invalid`（退出码 255）；
      //   火山缺地域 `region not set, please set it via profile, --region flag, or VOLCENGINE_REGION…`。
      // ★ 真机核对（2026-11-20，国外五家，退出码都是非 0）：
      //   AWS `NoRegion: You must specify a region`（253）/ 有地域时 `NoCredentials: Unable to locate credentials`；
      //   doctl 把错误 JSON 打在 **stdout**：`access token is required. (hint: run 'doctl auth init')`；
      //   hcloud `no active context or token (see \`hcloud context --help\`)`；
      //   vultr `set VULTR_API_KEY as an environment variable or add 'api-key' to your config file`；
      //   linode-cli 没 configure 时直接起交互向导（非 TTY 下 EOFError 崩栈）——同样归为「凭据/配置缺失」。
      const authLike = /InvalidAccessKeyId|SignatureDoesNotMatch|Unauthorized|Authentication failed|not logged in|No credential|credential.*not found|credentials not configured|no profile configured|secretId is invalid|region not set|profile configuration failed|ConfigurationError|Please run.*configure|run `?bce configure set|load current configuration failed|403 Forbidden|access_key\s*未配置|secret_key\s*未配置|CTYUN_AK|NoRegion|Unable to locate credentials|NoCredentials|AuthFailure|not able to validate|InvalidClientTokenId|access token is required|no active context or token|VULTR_API_KEY|Welcome to the Linode CLI|EOFError/i;
      if (authLike.test(text)) {
        return reject(new CliError(EXIT.CRED,
          `${bin} 凭据缺失或失效：${describeError(text)}`,
          { vendor: opts && opts.vendor, reason: 'auth_failed', stderr: text.slice(0, 4000) }));
      }
      return reject(new CliError(EXIT.VENDOR,
        `${bin} 执行失败：${describeError(text)}`,
        { vendor: opts && opts.vendor, reason: 'vendor_error', stderr: text.slice(0, 4000), code: err.code }));
    });
    // ★ 真机核对（2026-11-20）：linode-cli 没 configure 时会起交互向导问
    //   「Try it anyway? [y/N]:」，stdin 不关就**挂到超时**（stdio:'ignore' 在 Windows 上也照样挂）。
    //   这里立刻关掉 stdin 发 EOF：它随即 EOFError，按凭据缺失报出。
    //   本 CLI 所有厂商命令都是非交互的（写操作确认由 srvprice 自己做），不需要 stdin。
    if (child.stdin) child.stdin.end();
  });
}

function firstLine(s) {
  const l = String(s || '').split(/\r?\n/).find((x) => x.trim());
  return (l || '').trim().slice(0, 300);
}

// 有些新版 CLI 把错误打成单行 JSON（阿里云 3.5.4 就是），直接取 message 比截断整段 JSON 可读。
function describeError(s) {
  const t = String(s || '').trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j && j.message) {
        const hint = j.recovery && j.recovery.hint;
        return `${j.message}${hint ? '（' + hint + '）' : ''}`.slice(0, 300);
      }
      // doctl 的未登录错误：{"errors":[{"detail":"…access token is required…"}]}
      if (j && Array.isArray(j.errors) && j.errors[0] && j.errors[0].detail) {
        return String(j.errors[0].detail).slice(0, 300);
      }
    } catch (_) { /* 不是 JSON 就回落到首行 */ }
  }
  // linode-cli 没 configure：先打欢迎语、再因 EOF 崩栈，首行是 traceback，对用户没有信息量
  if (/Welcome to the Linode CLI/i.test(t)) {
    return 'linode-cli 尚未配置：先运行 `linode-cli configure --token` 录入个人令牌';
  }
  return firstLine(s);
}

function parseJson(text, vendor, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(EXIT.VENDOR,
      `${vendor} 的 ${what} 输出不是合法 JSON（可能 CLI 版本差异）`,
      { vendor, reason: 'parse_error', preview: String(text).slice(0, 500) });
  }
}

function normStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (/^(running|active|on|started|ok)$/.test(s)) return 'running';
  if (/^(stopped|off|offline|halted|shutdown)$/.test(s)) return 'stopped';
  if (/^(pending|starting|provisioning|rebooting|stopping|shutting-down|terminated|deleting)$/.test(s)) return s === 'stopping' || s === 'shutting-down' ? 'stopping' : (s === 'pending' || s === 'starting' || s === 'provisioning' ? 'starting' : s);
  return s || 'unknown';
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

// UCloud 的策略常是**项目级**的：不带 --project-id 会直接 RetCode 299。
// 这里按 profile 里有没有默认项目，回落到 `ucloud project list` 的第一个/默认项目。
const _ucloudProjectCache = new Map();

async function ucloudProject(bin, ctx) {
  if (ctx && ctx.projectId) return ctx.projectId;
  if (process.env.SRVPRICE_UCLOUD_PROJECT) return process.env.SRVPRICE_UCLOUD_PROJECT;
  if (_ucloudProjectCache.has(bin)) return _ucloudProjectCache.get(bin);
  let id = null;
  try {
    const { stdout } = await run(bin, ['project', 'list', '--output', 'json'], { vendor: 'ucloud', timeout: 20000 });
    const arr = JSON.parse(stdout);
    const pick = (arr || []).find((p) => p.IsDefault) || (arr || [])[0];
    id = (pick && pick.ProjectId) || null;
  } catch (_) { id = null; }
  _ucloudProjectCache.set(bin, id);
  return id;
}

// 天翼云的资源池（region）ID 不是猜出来的：用官方 `common ListRegions` 取。
const _ctyunRegionCache = new Map();

async function ctyunRegions(bin, ctx) {
  if (ctx && ctx.region) return [{ id: ctx.region, code: null }];
  if (_ctyunRegionCache.has(bin)) return _ctyunRegionCache.get(bin);
  try {
    const { stdout } = await run(bin, ['common', 'ListRegions', '--output', 'json'],
      { vendor: 'ctyun', timeout: 30000 });
    const j = JSON.parse(stdout);
    const list = (j.returnObj && j.returnObj.regionList) || j.regionList || [];
    const out = list.filter((r) => r && r.regionID && r.openapiAvailable !== false)
      .map((r) => ({ id: r.regionID, code: r.regionCode || r.regionName || null }));
    _ctyunRegionCache.set(bin, out);
    return out;
  } catch (e) {
    throw new CliError(EXIT.CRED,
      '天翼云取资源池失败（检查凭据）：' + e.message,
      { vendor: 'ctyun', reason: e.reason || 'auth_failed' });
  }
}

// ★ 2026-11-20：火山/腾讯的 ECS 接口是**按地域**查的，适配器原来只查配置的默认地域
//   （火山 cn-beijing、腾讯 ap-guangzhou）——别的地域有机器会被静默漏掉。这里跟百度
//   一样：没给 --region 就先取官方地域表，再逐个地域列（并发限 6）。

// 官方地域表的兜底值：DescribeRegions 本身失败时（权限异常等）仍能查主地域。
const VOLC_FALLBACK_REGIONS = ['cn-beijing', 'cn-shanghai', 'cn-guangzhou',
  'cn-hongkong', 'ap-southeast-1', 'ap-southeast-3'];
const TENCENT_FALLBACK_REGIONS = ['ap-guangzhou', 'ap-beijing', 'ap-shanghai',
  'ap-hongkong', 'ap-singapore', 'na-ashburn'];
// AWS：describe-regions 取不到时的兜底（商用分区的主要地域）
const AWS_FALLBACK_REGIONS = ['us-east-1', 'us-west-1', 'us-west-2', 'eu-west-1',
  'eu-central-1', 'ap-northeast-1', 'ap-southeast-1', 'ap-south-1', 'ca-central-1', 'sa-east-1'];

async function volcRegions(bin, ctx) {
  try {
    const args = ['ecs', 'DescribeRegions'];
    if (ctx.vendorProfile) args.push('--profile', ctx.vendorProfile);
    const { stdout } = await run(bin, args, { vendor: 'volcengine', timeout: ctx.timeout });
    const j = parseJson(stdout, 'volcengine', 'DescribeRegions');
    const list = (j.Result && j.Result.Regions) || [];
    const ids = list.map((r) => r && r.RegionId).filter(Boolean);
    return ids.length ? ids : VOLC_FALLBACK_REGIONS;
  } catch (_) {
    return VOLC_FALLBACK_REGIONS;
  }
}

async function awsRegions(bin, ctx) {
  try {
    // describe-regions 自己也是地域型调用，必须带一个地域；us-east-1 在任何商用账号都可用。
    // 不加 --all-regions：默认只返回账号已启用的地域，避免往 opt-in 地域发无谓请求。
    const args = ['ec2', 'describe-regions', '--region', 'us-east-1', '--output', 'json'];
    if (ctx.vendorProfile) args.push('--profile', ctx.vendorProfile);
    const { stdout } = await run(bin, args, { vendor: 'aws', timeout: ctx.timeout });
    const j = parseJson(stdout, 'aws', 'describe-regions');
    const ids = (j.Regions || []).map((r) => r && r.RegionName).filter(Boolean);
    return ids.length ? ids : AWS_FALLBACK_REGIONS;
  } catch (e) {
    // 未登录就别退化成「N 个地域各报一次」——直接把凭据错误抛给上层
    if (e && e.reason === 'auth_failed') throw e;
    return AWS_FALLBACK_REGIONS;
  }
}

async function tencentRegions(bin, ctx) {
  try {
    const args = ['cvm', 'DescribeRegions'];
    if (ctx.vendorProfile) args.push('--profile', ctx.vendorProfile);
    const { stdout } = await run(bin, args, { vendor: 'tencent', timeout: ctx.timeout });
    const j = parseJson(stdout, 'tccli', 'DescribeRegions');
    const ids = (j.RegionSet || []).map((r) => r && r.Region).filter(Boolean);
    return ids.length ? ids : TENCENT_FALLBACK_REGIONS;
  } catch (_) {
    return TENCENT_FALLBACK_REGIONS;
  }
}

const ADAPTERS = {
  aliyun: {
    id: 'aliyun',
    label: '阿里云',
    bin: 'aliyun',
    contextFlag: '--Profile',
    // 3.3.0+ 插件化：需先 `aliyun plugin install --names ecs`；旧 PascalCase 命令仍可用。
    spec_verified: 'verified',
    async list(ctx) {
      const bin = binFor('aliyun', 'aliyun');
      const base = ['ecs', 'DescribeInstances', '--MaxResults', '100'];
      if (ctx.region) base.push('--RegionId', ctx.region);
      if (ctx.vendorProfile) base.push('--Profile', ctx.vendorProfile);
      // PageNumber/PageSize 即将废弃，按官方推荐用 NextToken + MaxResults 翻页
      const out = [];
      let nextToken = null;
      for (let page = 0; page < 10; page++) {
        const args = nextToken ? [...base, '--NextToken', nextToken] : base;
        const { stdout } = await run(bin, args, { vendor: 'aliyun', timeout: ctx.timeout });
        const j = parseJson(stdout, 'aliyun', 'DescribeInstances');
        const set = (j.Instances && j.Instances.Instance) || [];
        for (const it of set) {
          out.push({
            id: `aliyun:${it.InstanceId}`,
            provider: 'aliyun',
            instance_id: it.InstanceId,
            name: it.InstanceName || '',
            region: it.RegionId || ctx.region || null,
            status: normStatus(it.Status),
            public_ipv4: (it.PublicIpAddress && it.PublicIpAddress.IpAddress && it.PublicIpAddress.IpAddress[0]) || null,
            type: it.InstanceType || null
          });
        }
        nextToken = j.NextToken || null;
        if (!nextToken) break;
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'StartInstance', stop: 'StopInstance', reboot: 'RebootInstance' };
      return ['ecs', map[kind], '--InstanceId', instanceId];
    }
  },

  aws: {
    id: 'aws',
    label: 'AWS',
    bin: 'aws',
    async list(ctx) {
      const bin = binFor('aws', 'aws');
      // ★ 2026-11-20（zhao 派单）：EC2 是地域型服务，原来只查默认地域，别的地域的实例会**静默漏掉**。
      //   照腾讯/火山/百度的做法：没给 --region 就先取 describe-regions，再逐地域并发查（限 6）。
      const regions = ctx.region ? [ctx.region] : await awsRegions(bin, ctx);
      const failures = [];
      let doneCount = 0;
      const results = await mapLimit(regions, 6, async (region) => {
        try {
          const args = ['ec2', 'describe-instances', '--output', 'json', '--region', region,
            '--filters', 'Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped'];
          if (ctx.vendorProfile) args.push('--profile', ctx.vendorProfile);
          const { stdout } = await run(bin, args, { vendor: 'aws', timeout: ctx.timeout });
          const j = parseJson(stdout, 'aws', 'describe-instances');
          const rows = [];
          for (const r of j.Reservations || []) {
            for (const it of r.Instances || []) {
              const nameTag = (it.Tags || []).find((t) => t.Key === 'Name');
              rows.push({
                id: `aws:${it.InstanceId}`,
                provider: 'aws',
                instance_id: it.InstanceId,
                name: (nameTag && nameTag.Value) || '',
                region: (it.Placement && it.Placement.AvailabilityZone) || region,
                status: normStatus(it.State && it.State.Name),
                public_ipv4: it.PublicIpAddress || null,
                type: it.InstanceType || null
              });
            }
          }
          return rows;
        } catch (e) {
          failures.push({ region, message: e.message, reason: e.reason || 'error' });
          return [];
        } finally {
          emitProgress('aws', ++doneCount, regions.length, region);
        }
      });
      const out = results.flat();
      if (!out.length && failures.length) {
        const reasons = failures.map((f) => f.reason);
        const reason = reasons.includes('auth_failed') ? 'auth_failed'
          : (reasons.includes('permission_denied') ? 'permission_denied' : reasons[0]);
        throw new CliError(reason === 'auth_failed' ? EXIT.CRED : EXIT.VENDOR,
          `AWS ${failures.length} 个地域查询失败：${failures[0].message}`,
          { vendor: 'aws', reason });
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'start-instances', stop: 'stop-instances', reboot: 'reboot-instances' };
      return ['ec2', map[kind], '--instance-ids', instanceId];
    }
  },

  tencent: {
    id: 'tencent',
    label: '腾讯云',
    bin: 'tccli',
    // 真机核对（tccli 3.1.202.1 / Python 3.12）：`tccli cvm DescribeInstances help` 与参数展开均可用
    spec_verified: 'verified',
    async list(ctx) {
      const bin = binFor('tencent', 'tccli');
      // ★ 2026-11-20：同火山——没给 --region 就遍历 DescribeRegions 的全部地域，
      //   否则别的地域的 CVM 会被静默漏掉（真机 19 个地域）。
      const regions = ctx.region ? [ctx.region] : await tencentRegions(bin, ctx);
      const failures = [];
      let doneCount = 0;
      const results = await mapLimit(regions, 6, async (region) => {
        try {
          const args = ['cvm', 'DescribeInstances', '--Limit', '100', '--region', region];
          if (ctx.vendorProfile) args.push('--profile', ctx.vendorProfile);
          const { stdout } = await run(bin, args, { vendor: 'tencent', timeout: ctx.timeout });
          const j = parseJson(stdout, 'tccli', 'DescribeInstances');
          return (j.InstanceSet || []).map((it) => ({
            id: `tencent:${it.InstanceId}`,
            provider: 'tencent',
            instance_id: it.InstanceId,
            name: it.InstanceName || '',
            region: (it.Placement && it.Placement.Zone) || region,
            status: normStatus(it.InstanceState),
            public_ipv4: (it.PublicIpAddresses && it.PublicIpAddresses[0]) || null,
            type: it.InstanceType || null
          }));
        } catch (e) {
          failures.push({ region, message: e.message, reason: e.reason || 'error' });
          return [];
        } finally {
          emitProgress('tencent', ++doneCount, regions.length, region);
        }
      });
      const out = results.flat();
      if (!out.length && failures.length) {
        const reasons = failures.map((f) => f.reason);
        const reason = reasons.includes('auth_failed') ? 'auth_failed'
          : (reasons.includes('permission_denied') ? 'permission_denied' : reasons[0]);
        throw new CliError(reason === 'auth_failed' ? EXIT.CRED : EXIT.VENDOR,
          `腾讯云 ${failures.length} 个地域查询失败：${failures[0].message}`,
          { vendor: 'tencent', reason });
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'StartInstances', stop: 'StopInstances', reboot: 'RebootInstances' };
      return ['cvm', map[kind], '--InstanceIds', JSON.stringify([instanceId])];
    }
  },

  doctl: {
    id: 'doctl',
    label: 'DigitalOcean',
    bin: 'doctl',
    async list(ctx) {
      const args = ['compute', 'droplet', 'list', '--output', 'json'];
      const { stdout } = await run(binFor('doctl', 'doctl'), args, { vendor: 'doctl', timeout: ctx.timeout });
      const j = parseJson(stdout, 'doctl', 'droplet list');
      return (Array.isArray(j) ? j : []).map((d) => ({
        id: `doctl:${d.id}`,
        provider: 'doctl',
        instance_id: String(d.id),
        name: d.name || '',
        region: (d.region && d.region.slug) || null,
        status: normStatus(d.status),
        public_ipv4: ((d.networks && d.networks.v4) || []).find((n) => n.type === 'public') ? ((d.networks.v4.find((n) => n.type === 'public')).ip_address) : null,
        type: (d.size && d.size.slug) || d.size_slug || null
      }));
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'power-on', stop: 'shutdown', reboot: 'reboot' };
      return ['compute', 'droplet-action', map[kind], instanceId];
    }
  },

  hcloud: {
    id: 'hcloud',
    label: 'Hetzner',
    bin: 'hcloud',
    async list(ctx) {
      const args = ['server', 'list', '-o', 'json'];
      if (ctx.vendorProfile) args.push('--context', ctx.vendorProfile);
      const { stdout } = await run(binFor('hcloud', 'hcloud'), args, { vendor: 'hcloud', timeout: ctx.timeout });
      const j = parseJson(stdout, 'hcloud', 'server list');
      return (Array.isArray(j) ? j : []).map((s) => ({
        id: `hcloud:${s.id}`,
        provider: 'hcloud',
        instance_id: String(s.id),
        name: s.name || '',
        // ★ 真机核对（hcloud 1.70.2，2026-11-20）：`server list` 列里只有 location，没有 datacenter；
        //   datacenter 属性已于 2026-07-01 从 API 响应移除，旧字段只作低版本回退。
        region: (s.location && s.location.name) ||
          (s.datacenter && s.datacenter.location && s.datacenter.location.name) || null,
        status: normStatus(s.status),
        public_ipv4: (s.public_net && s.public_net.ipv4 && s.public_net.ipv4.ip) || null,
        type: (s.server_type && s.server_type.name) || null
      }));
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'poweron', stop: 'shutdown', reboot: 'reboot' };
      return ['server', map[kind], instanceId];
    }
  },

  vultr: {
    id: 'vultr',
    label: 'Vultr',
    bin: 'vultr-cli',
    async list(ctx) {
      const args = ['instance', 'list', '-o', 'json'];
      const { stdout } = await run(binFor('vultr', 'vultr-cli'), args, { vendor: 'vultr', timeout: ctx.timeout });
      const j = parseJson(stdout, 'vultr-cli', 'instance list');
      const arr = Array.isArray(j) ? j : (j.instances || []);
      return arr.map((s) => ({
        id: `vultr:${s.id}`,
        provider: 'vultr',
        instance_id: String(s.id),
        name: s.label || s.hostname || '',
        region: s.region || null,
        status: normStatus(s.power_status || s.status),
        public_ipv4: s.main_ip || null,
        type: s.plan || null
      }));
    },
    actionArgs(kind, instanceId) {
      // ★ 真机核对（vultr-cli 3.11.0 `instance --help`，2026-11-20）：子命令只有 start / stop / restart，
      //   **没有 halt / reboot**（那是裸金属的命令）。stop 底层就是 POST /halt，restart 底层是 /reboot。
      const map = { start: 'start', stop: 'stop', reboot: 'restart' };
      return ['instance', map[kind], instanceId];
    }
  },

  ucloud: {
    id: 'ucloud',
    label: 'UCloud',
    bin: 'ucloud',
    spec_verified: 'verified',   // 2026-11-19 真机核对 v0.3.10：--output json 可用
    async list(ctx) {
      // ★ 真机核对（ucloud-cli 0.3.10）：-j/--json 与 --output json 都存在；
      //   显式用 --output json，比 --json 更确定。
      // ★ UCloud 分两种实例：uhost（云主机）与 ulhost（轻量应用服务器），
      //   权限也是分开的两条策略；这里两个都列，合并成一个列表。
      const bin = binFor('ucloud', 'ucloud');
      const projectId = await ucloudProject(bin, ctx);
      const out = [];
      const errs = [];
      for (const kind of ['uhost', 'ulhost']) {
        try {
          const args = [kind, 'list', '--output', 'json'];
          if (projectId) args.push('--project-id', projectId);
          // ★ 真机：uhost 默认只看 profile/region（cn-bj2），**不加 --all-region 会漏掉别的地域**
          //   （165 在 sg-02，就是这么被漏掉的）。没显式给 region 时按全地域列。
          if (ctx.region) args.push('--region', ctx.region);
          else args.push('--all-region', 'true');
          const res = await run(bin, args, { vendor: 'ucloud', timeout: ctx.timeout });
          const rawAll = `${res.stdout || ''}${res.stderr || ''}`;
          // ★ 真机：未配凭据时退出码仍是 0，只打印一句提示（见 auth_failed 测试）
          if (/private-key is empty|Execute command 'ucloud init\|config'|public-key is empty/i.test(rawAll)) {
            throw new CliError(EXIT.CRED,
              'UCloud 未配置凭据：先运行 `ucloud init` 或 `ucloud config add`，或用 SRVPRICE_UCLOUD_PUBLIC_KEY / _PRIVATE_KEY 注入',
              { vendor: 'ucloud', reason: 'auth_failed' });
          }
          // ★ 真机：权限不足时也是退出码 0 + 一行 RetCode 299
          if (/IAM permission error|RetCode:\s*299/i.test(rawAll)) {
            throw new CliError(EXIT.CRED,
              `${bin} 权限不足（RetCode 299）：请给该子账号绑定资源只读策略或加入项目授予只读角色`,
              { vendor: 'ucloud', reason: 'permission_denied' });
          }
          const raw = String(res.stdout || '').trim();
          if (!raw || raw === '[]') continue;
          const j = parseJson(raw, 'ucloud', kind + ' list');
          const set = j.UHostSet || j.ULHostSet || (Array.isArray(j) ? j : []);
          for (const s of set) {
            // ★ 真机字段（v0.3.10 --all-region）：ResourceID / UHostName / State / Zone / PublicIP / Type
            //   ——不是 API 文档里的 UHostId / Name。
            const iid = s.ResourceID || s.UHostId || s.ULHostId || s.Id || s.id;
            if (!iid) continue;
            const ips = s.IPs || s.IPSet || [];
            const pub = (Array.isArray(ips) ? ips : []).find((x) => x && (x.Type === 'International' || x.Type === 'Bgp' || x.Type === 'Public'));
            out.push({
              id: `ucloud:${iid}`,
              provider: 'ucloud',
              instance_id: iid,
              name: s.UHostName || s.ULHostName || s.Name || s.name || '',
              region: s.Zone || s.Region || s.region || null,
              status: normStatus(s.State || s.Status || s.status),
              public_ipv4: (pub && pub.IP) || s.PublicIP || s.public_ip || null,
              type: kind === 'ulhost' ? 'ULHost' : (s.Type || s.UHostType || s.MachineType || null)
            });
          }
        } catch (e) {
          // 一条策略没给不会拖垮另一条；但如果一条主机都没有，就如实报出来
          errs.push({ kind, message: e.message, reason: e.reason || 'error', code: e.exitCode });
        }
      }
      if (!out.length && errs.length) {
        const reasons = errs.map((e) => e.reason);
        const reason = reasons.includes('permission_denied') ? 'permission_denied'
          : (reasons.includes('auth_failed') ? 'auth_failed' : reasons[0]);
        throw new CliError(EXIT.CRED,
          errs.map((e) => e.message).join('；') + '（云主机与轻量是两条独立策略，缺哪条就在 IAM 补哪条）',
          { vendor: 'ucloud', reason });
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      // 官方文档：uhost/ulhost 都是 start|stop|restart，参数名各是 --uhost-id / --ulhost-id
      const map = { start: 'start', stop: 'stop', reboot: 'restart' };
      if (String(instanceId).startsWith('ulhost-')) {
        return ['ulhost', map[kind], '--ulhost-id', instanceId];
      }
      return ['uhost', map[kind], '--uhost-id', instanceId];
    }
  },

  jdcloud: {
    id: 'jdcloud',
    label: '京东云',
    bin: 'jdc',
    spec_verified: 'verified',
    async list(ctx) {
      // ★ 真机核对（jdcloud-cli 1.2.12）：--output 是**全局参数**，必须放在子命令之前；
      //   放后面会报 "unrecognized arguments"。
      const args = ['--output', 'json', 'vm', 'describe-instances'];
      if (ctx.region) args.push('--region-id', ctx.region);
      const res = await run(binFor('jdcloud', 'jdc'), args, { vendor: 'jdcloud', timeout: ctx.timeout });
      const rawAll = `${res.stdout || ''}${res.stderr || ''}`;
      // 真机：未配置时打印一句提示、**退出码仍是 0**
      if (/jdc configure add|add cli configure/i.test(rawAll)) {
        throw new CliError(EXIT.CRED,
          '京东云未配置凭据：先运行 `jdc configure add --access-key … --secret-key …`',
          { vendor: 'jdcloud', reason: 'auth_failed' });
      }
      const j = parseJson(res.stdout, 'jdc', 'describe-instances');
      const set = (j.result && j.result.instances) || j.instances || [];
      return set.map((s) => ({
        id: `jdcloud:${s.instanceId}`,
        provider: 'jdcloud',
        instance_id: s.instanceId,
        name: s.instanceName || s.name || '',
        region: s.az || s.region || ctx.region || null,
        status: normStatus(s.status),
        public_ipv4: (s.publicIpAddress || (s.elasticIpAddress && s.elasticIpAddress.ipAddress)) || null,
        type: s.instanceType || null
      }));
    },
    actionArgs(kind, instanceId) {
      // ★ 真机核对（1.2.12 --help）：单数命令 + `--instance-id`（带连字符），
      //   不是博客里的 reboot-instances / --instanceId。
      const map = { start: 'start-instance', stop: 'stop-instance', reboot: 'reboot-instance' };
      return ['vm', map[kind], '--instance-id', instanceId];
    }
  },

  ctyun: {
    id: 'ctyun',
    label: '天翼云',
    bin: 'ctyun-cli',
    spec_verified: 'verified',   // 2026-11-19 按官方 ctyun-cli 0.4.0 --help 与真机输出核对
    async list(ctx) {
      // ★ 官方 CLI 是 API 式操作名（ListEcsInstances），且 --regionID 必填；
      //   但 `common ListRegions` 可以自取资源池，所以不给 region 就全量遍历。
      const bin = binFor('ctyun', 'ctyun-cli');
      const regions = await ctyunRegions(bin, ctx);
      const failures = [];
      const out = [];
      // ★ 真机：27 个资源池同时起进程会把 TLS 握手打超时，限制并发到 4
      const LIMIT = 6;
      let doneCount = 0;
      const results = [];
      for (let i = 0; i < regions.length; i += LIMIT) {
        const batch = regions.slice(i, i + LIMIT);
        results.push(...await Promise.all(batch.map(async (r) => {
        try {
          const args = ['ecs', 'ListEcsInstances', '--regionID', r.id,
            '--pageSize', '50', '--output', 'json'];
          const res = await run(bin, args, { vendor: 'ctyun', timeout: ctx.timeout });
          const j = parseJson(String(res.stdout || '').trim(), 'ctyun-cli', 'ListEcsInstances');
          const body = j.returnObj || j.result || j;
          // ★ 真机字段：returnObj.results（不是 instances）
          const set = body.results || body.instances || body.instanceList || (Array.isArray(body) ? body : []);
          return (set || []).map((it) => ({
            id: `ctyun:${it.instanceID || it.instanceId || it.id}`,
            provider: 'ctyun',
            instance_id: String(it.instanceID || it.instanceId || it.id),
            name: it.displayName || it.instanceName || it.name || '',
            region: r.code || it.regionID || r.id,
            status: normStatus(it.instanceStatus || it.status || it.state),
            public_ipv4: it.publicIP || it.publicIp || it.eipAddress || null,
            type: it.flavorName || it.flavorID || it.instanceType || null
          }));
        } catch (e) {
          // 真机：海外/非大陆公有云资源池会报「仅支持中国大陆公有云资源池」——跳过，不算失败
          if (/仅支持中国大陆公有云资源池|不在支持范围内/.test(e.message)) return [];
          failures.push({ region: r.code || r.id, message: e.message, reason: e.reason || 'error' });
          return [];
        } finally {
          emitProgress('ctyun', ++doneCount, regions.length, r.id);
        }
        })));
      }
      for (const arr of results) out.push(...arr);
      if (!out.length && failures.length) {
        const reasons = failures.map((f) => f.reason);
        const reason = reasons.includes('auth_failed') ? 'auth_failed'
          : (reasons.includes('permission_denied') ? 'permission_denied' : reasons[0]);
        throw new CliError(reason === 'auth_failed' ? EXIT.CRED : EXIT.VENDOR,
          `天翼云 ${failures.length} 个资源池查询失败：${failures[0].message}`,
          { vendor: 'ctyun', reason });
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      // 官方：StartEcsInstance / StopEcsInstance / RebootEcsInstance --instanceID（regionID 由调用层补）
      const map = { start: 'StartEcsInstance', stop: 'StopEcsInstance', reboot: 'RebootEcsInstance' };
      return ['ecs', map[kind], '--instanceID', instanceId];
    }
  },

  volcengine: {
    id: 'volcengine',
    label: '火山引擎',
    bin: 've',
    // 真机核对（ve 2.0.2，2026-11-19 `--help`）：
    //   `ve ecs DescribeInstances [--InstanceIds.N] [--MaxResults] [--NextToken]`，JSON 信封 ResponseMetadata + Result
    //   `ve ecs StartInstance|StopInstance|RebootInstance --InstanceId i-xxx`；Stop 另有 --ForceStop / --StoppedMode
    spec_verified: 'verified',
    async list(ctx) {
      const bin = binFor('volcengine', 've');
      const regions = ctx.region ? [ctx.region] : await volcRegions(bin, ctx);
      const failures = [];
      let doneCount = 0;
      const results = await mapLimit(regions, 6, async (region) => {
        try {
          const rows = [];
          const base = ['ecs', 'DescribeInstances', '--MaxResults', '100', '--region', region];
          if (ctx.vendorProfile) base.push('--profile', ctx.vendorProfile);
          let nextToken = null;
          for (let page = 0; page < 10; page++) {
            const args = nextToken ? [...base, '--NextToken', nextToken] : base;
            const { stdout } = await run(bin, args, { vendor: 'volcengine', timeout: ctx.timeout });
            const j = parseJson(stdout, 'volcengine', 'DescribeInstances');
            const result = j.Result || j.result || j;
            const set = result.Instances || (Array.isArray(result) ? result : []);
            for (const it of set) {
              const iid = it.InstanceId;
              if (!iid) continue;
              rows.push({
                id: `volcengine:${iid}`,
                provider: 'volcengine',
                instance_id: iid,
                name: it.InstanceName || '',
                region: it.RegionId || region,
                // 真机状态值是大写：RUNNING / STOPPED / STARTING / STOPPING / REBOOTING
                status: normStatus(it.Status),
                public_ipv4: (it.EipAddress && it.EipAddress.IpAddress) || it.PublicIpAddress || null,
                type: it.InstanceTypeId || it.InstanceType || null
              });
            }
            nextToken = result.NextToken || null;
            if (!nextToken) break;
          }
          return rows;
        } catch (e) {
          failures.push({ region, message: e.message, reason: e.reason || 'error' });
          return [];
        } finally {
          emitProgress('volcengine', ++doneCount, regions.length, region);
        }
      });
      const out = results.flat();
      if (!out.length && failures.length) {
        const reasons = failures.map((f) => f.reason);
        const reason = reasons.includes('auth_failed') ? 'auth_failed'
          : (reasons.includes('permission_denied') ? 'permission_denied' : reasons[0]);
        throw new CliError(reason === 'auth_failed' ? EXIT.CRED : EXIT.VENDOR,
          `火山引擎 ${failures.length} 个地域查询失败：${failures[0].message}`,
          { vendor: 'volcengine', reason });
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'StartInstance', stop: 'StopInstance', reboot: 'RebootInstance' };
      return ['ecs', map[kind], '--InstanceId', instanceId];
    }
  },

  baidu: {
    id: 'baidu',
    label: '百度智能云',
    bin: 'bce',
    // 真机核对（bce 0.1.148，2026-11-19 `--help`）：
    //   `bce bcc ListInstances --region bj --marker … --maxKeys 100`；`isTruncated / nextMarker / instances[]`
    //   `bce bcc StartInstance|StopInstance|RebootInstance --instanceId i-xxx`（Stop/Reboot 另有 --forceStop）
    spec_verified: 'verified',
    async list(ctx) {
      const bin = binFor('baidu', 'bce');
      // BCC 的 endpoint 表：bj / gz / su / bd / hkg；没给 --region 就按这五个地域全量列。
      const regions = ctx.region ? [ctx.region] : ['bj', 'gz', 'su', 'bd', 'hkg'];
      const failures = [];
      let doneCount = 0;
      const results = await Promise.all(regions.map(async (region) => {
        try {
          const rows = [];
          let marker = null;
          for (let page = 0; page < 10; page++) {
            const args = ['bcc', 'ListInstances', '--region', region, '--maxKeys', '100'];
            if (ctx.vendorProfile) args.push('--profile', ctx.vendorProfile);
            if (marker) args.push('--marker', marker);
            const { stdout } = await run(bin, args, { vendor: 'baidu', timeout: ctx.timeout });
            const j = parseJson(stdout, 'bce', 'ListInstances');
            const set = j.instances || (j.result && j.result.instances) || [];
            for (const it of set) {
              const iid = it.id || it.instanceId;
              if (!iid) continue;
              rows.push({
                id: `baidu:${iid}`,
                provider: 'baidu',
                instance_id: String(iid),
                name: it.name || it.instanceName || '',
                region: it.zoneName || region,
                status: normStatus(it.status),
                public_ipv4: it.publicIp || it.publicIpAddress || null,
                type: it.type || it.instanceType || null
              });
            }
            marker = j.nextMarker || null;
            if (!j.isTruncated || !marker) break;
          }
          return rows;
        } catch (e) {
          failures.push({ region, message: e.message, reason: e.reason || 'error' });
          return [];
        } finally {
          emitProgress('baidu', ++doneCount, regions.length, region);
        }
      }));
      const out = results.flat();
      if (!out.length && failures.length) {
        const reasons = failures.map((f) => f.reason);
        const reason = reasons.includes('auth_failed') ? 'auth_failed'
          : (reasons.includes('permission_denied') ? 'permission_denied' : reasons[0]);
        throw new CliError(reason === 'auth_failed' ? EXIT.CRED : EXIT.VENDOR,
          `百度智能云 ${failures.length} 个地域查询失败：${failures[0].message}`,
          { vendor: 'baidu', reason });
      }
      return out;
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'StartInstance', stop: 'StopInstance', reboot: 'RebootInstance' };
      return ['bcc', map[kind], '--instanceId', instanceId];
    }
  },

  west: {
    id: 'west',
    label: '西部数码',
    bin: 'west-api',          // 无官方 CLI：适配器直接调 HTTP API
    direct: true,
    spec_verified: 'verified', // 2026-11-20 客服确认银牌代理可用服务器接口；只核对接口名
    async list(ctx) {
      const west = require('./west');
      // GET /server/?act=list&pageno=&limit=&serverroom=
      const data = await west.listServers({
        pageno: 1,
        limit: 100,
        serverroom: ctx.region || undefined,
        timeout: ctx.timeout
      });
      const rooms = await west.roomNames({ timeout: ctx.timeout });
      return west.mapItems(data && data.items, ctx.region, rooms);
    },
    // host status 用：按 ip 查真实运行状态（列表接口没有状态字段）
    async getStatus(ctx, host) {
      const west = require('./west');
      if (!host || !host.public_ipv4) return host;
      const d = await west.serverStatus({ ip: host.public_ipv4, timeout: ctx.timeout });
      return Object.assign({}, host, west.mapStatus(d));
    },
    // host snapshots 用（只读）
    async snapshots(ctx, host) {
      const west = require('./west');
      if (!host || !host.public_ipv4) throw new CliError(EXIT.NOT_FOUND, '该实例没有公网 IP，无法查询快照');
      const d = await west.snapshots({ ip: host.public_ipv4, timeout: ctx.timeout });
      return west.mapSnapshots(d);
    },
    actionArgs() {
      // 第一期只读：写操作一律拒绝（CLI 层 read_only 闸之外的第二道）
      throw new CliError(EXIT.USAGE, '西部数码第一期只读：不支持 start/stop/reboot', {
        vendor: 'west', reason: 'read_only'
      });
    }
  },

  linode: {
    id: 'linode',
    label: 'Linode',
    bin: 'linode-cli',
    async list(ctx) {
      // ★ 真机核对（linode-cli 5.70.0 `--help`，2026-11-20）：CLI 有 --page/--page-size，
      //   --all-rows 关闭分页一次取全；--json 输出对象数组。
      const args = ['linodes', 'list', '--json', '--all-rows'];
      const { stdout } = await run(binFor('linode', 'linode-cli'), args, { vendor: 'linode', timeout: ctx.timeout });
      const j = parseJson(stdout, 'linode-cli', 'linodes list');
      return (Array.isArray(j) ? j : []).map((s) => ({
        id: `linode:${s.id}`,
        provider: 'linode',
        instance_id: String(s.id),
        name: s.label || '',
        region: s.region || null,
        status: normStatus(s.status),
        public_ipv4: (s.ipv4 && s.ipv4[0]) || null,
        type: s.type || null
      }));
    },
    actionArgs(kind, instanceId) {
      const map = { start: 'boot', stop: 'shutdown', reboot: 'reboot' };
      return ['linodes', map[kind], instanceId];
    }
  }
};

const VENDOR_IDS = Object.keys(ADAPTERS);

function getAdapter(name) {
  const a = ADAPTERS[name];
  if (!a) {
    throw new CliError(EXIT.USAGE,
      `不支持的厂商：${name}（已支持：${VENDOR_IDS.join(', ')}）`);
  }
  return a;
}

// 探测厂商 CLI 自身有没有配置凭据（主机操作走的是它的登录态，不是我们的 credentials.json）
// 返回 {checked: bool, configured: bool|null, detail: str}
async function probeCreds(vendor, timeout) {
  if (vendor === 'west') {
    const c = require('./west').creds();
    return {
      checked: true,
      configured: !!(c.user && c.pass),
      detail: '西部 API 凭据来自环境变量（由 vault 注入）'
    };
  }
  const bin = binFor(vendor, (ADAPTERS[vendor] || {}).bin || vendor);
  try {
    if (vendor === 'ucloud') {
      const { stdout } = await run(bin, ['config', 'list'], { vendor, timeout: timeout || 15000 });
      const txt = String(stdout || '').trim();
      let n = null;
      try { n = JSON.parse(txt).length; } catch (_) { n = txt && txt !== '[]' ? 1 : 0; }
      return { checked: true, configured: n > 0, detail: `ucloud config list: ${n} 个配置` };
    }
    // ★ 真机核对（2026-11-19）：阿里云/火山/百度在**没有任何配置档案**时退出码仍是 0，
    //   只能靠输出文本判断（阿里云是 JSON ConfigurationError）。腾讯 credential 段为空表示没配 AK。
    if (vendor === 'aliyun') {
      // 阿里云把 ConfigurationError 打到 stderr，run() 会按 authLike 抛 auth_failed——这里当作“未配置”
      try {
        const res = await run(bin, ['configure', 'list'], { vendor, timeout: timeout || 15000 });
        const text = `${res.stdout || ''}\n${res.stderr || ''}`;
        const configured = !/ConfigurationError|profile configuration failed/i.test(text) &&
          String(res.stdout || '').trim().length > 0;
        return { checked: true, configured, detail: 'aliyun configure list: ' + (configured ? '有可用 profile' : '无可用 profile') };
      } catch (e) {
        if (e.reason === 'auth_failed') {
          return { checked: true, configured: false, detail: 'aliyun configure list: 无可用 profile' };
        }
        throw e;
      }
    }
    if (vendor === 'volcengine') {
      const res = await run(bin, ['configure', 'list'], { vendor, timeout: timeout || 15000 });
      const text = `${res.stdout || ''}\n${res.stderr || ''}`;
      const configured = !/尚未创建配置档案|no profiles?/i.test(text) && String(res.stdout || '').trim().length > 0;
      return { checked: true, configured, detail: 've configure list: ' + (configured ? '有配置档案' : '尚未创建配置档案') };
    }
    if (vendor === 'baidu') {
      const res = await run(bin, ['configure', 'list'], { vendor, timeout: timeout || 15000 });
      const text = `${res.stdout || ''}\n${res.stderr || ''}`;
      const configured = !/暂无 profile|no profile/i.test(text) && String(res.stdout || '').trim().length > 0;
      return { checked: true, configured, detail: 'bce configure list: ' + (configured ? '有 profile' : '暂无 profile') };
    }
    if (vendor === 'tencent') {
      const res = await run(bin, ['configure', 'list'], { vendor, timeout: timeout || 15000 });
      const text = `${res.stdout || ''}\n${res.stderr || ''}`;
      const configured = /secretId\s*=/i.test(text);
      return { checked: true, configured, detail: 'tccli configure list: ' + (configured ? '已配置 secretId' : 'credential 段为空') };
    }
  } catch (e) {
    return { checked: true, configured: null, detail: e.message.slice(0, 160) };
  }
  return { checked: false, configured: null, detail: '' };
}

// 检测某厂商 CLI 是否可用（装没装、版本）
async function probe(vendor, timeout) {
  const a = getAdapter(vendor);
  // 直连 API 的厂商标配器（如西部数码）没有 CLI：“已装”= 适配器可用
  if (a.direct) {
    return { id: vendor, label: a.label, bin: '(HTTP API)', installed: true, version: 'HTTP API' };
  }
  const bin = binFor(vendor, a.bin);
  // ★ 真机核对（2026-11-19）：阿里云 `--version` 会打印整棵命令树 JSON，要用 `version` 子命令；
  //   百度 bce 没有 `--version`（报 unknown flag），同样用 `version` 子命令。
  // ★ 真机核对（2026-11-20）：doctl / hcloud / vultr-cli 都不认 `--version`（unknown flag），
  //   分别是 `doctl version` / `hcloud version` / `vultr-cli version`；aws 与 linode-cli 认 `--version`。
  const versionArgs = {
    vultr: [['version'], ['--version']],
    doctl: [['version']],
    hcloud: [['version']],
    aliyun: [['version']],
    baidu: [['version']]
  };
  const attempts = versionArgs[vendor] || [['--version']];
  try {
    let out = null;
    let lastErr = null;
    for (const args of attempts) {
      try {
        out = await run(bin, args, { vendor, timeout: Math.min(timeout || 15000, 20000) });
        break;
      } catch (e) {
        lastErr = e;
        if (e.reason === 'cli_missing') throw e;
      }
    }
    if (!out) throw lastErr;
    const text = `${out.stdout}\n${out.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ');
    return { id: vendor, label: a.label, bin, installed: true, version: text.replace(/\s+/g, ' ').slice(0, 120) };
  } catch (e) {
    return {
      id: vendor,
      label: a.label,
      bin,
      installed: false,
      version: null,
      error: e.message,
      reason: e.reason || 'cli_missing'
    };
  }
}

// 解析 "provider:instance-id"
function parseHostId(raw) {
  const s = String(raw || '');
  const idx = s.indexOf(':');
  if (idx <= 0) {
    throw new CliError(EXIT.USAGE,
      `主机 ID 必须是 <provider>:<instance-id> 形式（如 aliyun:i-0123abcd），收到：${s}`);
  }
  return { provider: s.slice(0, idx), instanceId: s.slice(idx + 1) };
}

// ★ 2026-11-20：跨地域列出的实例，写命令必须带对地域（AWS 不给 --region 会 NoRegion / NotFound；
//   腾讯跨地域后停在默认地域）。从列表里的 AZ/可用区反推地域：
//     aws      us-west-2a   → us-west-2
//     tencent  ap-beijing-3 → ap-beijing（ap-shanghai-fsi-1 → ap-shanghai-fsi）
//   其它厂商列表里存的就是可直接用的地域/机房标识，或 CLI 自带默认地域，不额外推导。
function regionForHost(host) {
  if (!host || !host.region) return null;
  const r = String(host.region);
  if (host.provider === 'aws') return /[a-z]$/.test(r) ? r.replace(/[a-z]$/, '') : r;
  if (host.provider === 'tencent') return /-\d+$/.test(r) ? r.replace(/-\d+$/, '') : r;
  return null;
}

// 显式 --region / profile 默认地域优先；没有时用实例所在地域补齐，供 actionCommand/runAction/waitFor 使用。
function actionCtx(ctx, host) {
  if (ctx.region) return ctx;
  const region = regionForHost(host);
  return region ? Object.assign({}, ctx, { region }) : ctx;
}

function hostCtx(opts, profile) {
  return {
    region: opts.region && opts.region !== true ? String(opts.region) : (profile && profile.default_region) || null,
    vendorProfile: opts.vendorProfile && opts.vendorProfile !== true ? String(opts.vendorProfile) : null,
    projectId: opts.project && opts.project !== true ? String(opts.project) : null,
    timeout: opts.timeout ? (parseInt(opts.timeout, 10) * 1000) : DEFAULT_TIMEOUT
  };
}

async function listAcross(opts, profile, io) {
  const only = opts.provider && opts.provider !== true ? require('./core').asArray(opts.provider) : [];
  const ids = only.length ? only.map((p) => { getAdapter(p); return p; }) : VENDOR_IDS;
  const ctx = hostCtx(opts, profile);
  const results = [];
  const errors = [];

  for (const id of ids) {
    try {
      const hosts = await getAdapter(id).list(ctx);
      results.push(...hosts);
    } catch (e) {
      // 单厂商失败不拖垮整表：记录错误，明确报出是哪家、哪一层
      errors.push({ provider: id, message: e.message, reason: e.reason || 'error', exit_code: e.exitCode || EXIT.GENERAL });
    }
  }

  for (const err of errors) {
    io.warn(`${err.provider} 未纳入本次结果：${err.message}`, err);
  }
  return { hosts: results, errors };
}

async function findHost(rawId, opts, profile) {
  const { provider, instanceId } = parseHostId(rawId);
  const adapter = getAdapter(provider);
  const ctx = hostCtx(opts, profile);
  const hosts = await adapter.list(ctx);
  const host = hosts.find((h) => h.instance_id === instanceId);
  if (!host) {
    throw new CliError(EXIT.NOT_FOUND,
      `在 ${provider} 账号下未找到实例 ${instanceId}` +
      (ctx.region ? `（当前 region=${ctx.region}）` : `（未指定 --region，部分厂商默认地域可能不含该实例）`),
      { provider, instance_id: instanceId });
  }
  return { adapter, ctx, host };
}

// 把「一次写操作要执行的厂商命令」拼出来（dry-run 打印与真执行共用同一份，避免预览和实际不一致）
function actionCommand(vendor, kind, instanceId, ctx) {
  const adapter = getAdapter(vendor);
  const args = adapter.actionArgs(kind, instanceId);
  const bin = binFor(vendor, adapter.bin);
  const extra = [];
  if (ctx.region) {
    if (vendor === 'aliyun') extra.push('--RegionId', ctx.region);
    else if (vendor === 'aws' || vendor === 'tencent' || vendor === 'ucloud' ||
      vendor === 'volcengine' || vendor === 'baidu') extra.push('--region', ctx.region);
    else if (vendor === 'jdcloud') extra.push('--region-id', ctx.region);
    else if (vendor === 'ctyun') extra.push('--regionID', ctx.region);
  }
  if (ctx.vendorProfile) {
    if (vendor === 'aws') extra.push('--profile', ctx.vendorProfile);
    else if (vendor === 'tencent') extra.push('--profile', ctx.vendorProfile);
    else if (vendor === 'aliyun') extra.push('--Profile', ctx.vendorProfile);
    else if (vendor === 'hcloud') extra.push('--context', ctx.vendorProfile);
    else if (vendor === 'volcengine' || vendor === 'baidu') extra.push('--profile', ctx.vendorProfile);
  }
  return { bin, args: [...args, ...extra] };
}

async function runAction(vendor, kind, instanceId, ctx) {
  const adapter = getAdapter(vendor);
  const args = adapter.actionArgs(kind, instanceId);
  const bin = binFor(vendor, adapter.bin);
  const extra = [];
  if (ctx.region) {
    if (vendor === 'aliyun') extra.push('--RegionId', ctx.region);
    else if (vendor === 'aws' || vendor === 'tencent' || vendor === 'ucloud' ||
      vendor === 'volcengine' || vendor === 'baidu') extra.push('--region', ctx.region);
    else if (vendor === 'jdcloud') extra.push('--region-id', ctx.region);
    else if (vendor === 'ctyun') extra.push('--regionID', ctx.region);
    // doctl / hcloud / vultr / linode 的实例操作不需要地域参数
  }
  if (ctx.vendorProfile) {
    if (vendor === 'aws') extra.push('--profile', ctx.vendorProfile);
    else if (vendor === 'tencent') extra.push('--profile', ctx.vendorProfile);
    else if (vendor === 'aliyun') extra.push('--Profile', ctx.vendorProfile);
    else if (vendor === 'hcloud') extra.push('--context', ctx.vendorProfile);
    else if (vendor === 'volcengine' || vendor === 'baidu') extra.push('--profile', ctx.vendorProfile);
  }
  const display = [bin, ...args, ...extra].join(' ');
  const { stdout, stderr } = await run(bin, [...args, ...extra], { vendor, timeout: ctx.timeout });
  return { command: display, stdout, stderr };
}

const TARGET_STATUS = { start: 'running', stop: 'stopped', reboot: 'running' };

async function waitFor(adapter, ctx, instanceId, until, io, opts) {
  const timeoutMs = (parseInt(opts.timeout || '300', 10) || 300) * 1000;
  const intervalMs = (parseInt(opts.pollInterval || '5', 10) || 5) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const hosts = await adapter.list(ctx);
    const h = hosts.find((x) => x.instance_id === instanceId);
    last = h ? h.status : null;
    if (h && h.status === until) return h;
    io.info(`等待 ${instanceId} 进入 ${until} …（当前 ${last || '未知'}）`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new CliError(EXIT.VENDOR,
    `等待超时：${instanceId} 未在 ${timeoutMs / 1000}s 内进入 ${until}（最后状态 ${last || '未知'}）`,
    { instance_id: instanceId, last_status: last, reason: 'wait_timeout' });
}

module.exports = {
  ADAPTERS,
  actionCommand,
  probeCreds,
  VENDOR_IDS,
  getAdapter,
  probe,
  parseHostId,
  hostCtx,
  actionCtx,
  regionForHost,
  listAcross,
  findHost,
  runAction,
  waitFor,
  TARGET_STATUS
};
