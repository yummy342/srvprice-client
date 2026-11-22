'use strict';

// 短信通知（阿里云 dysmsapi）。零外部依赖。
// 配置优先级：环境变量 SMS_* > ~/.srvprice/sms.json（或 SRVPRICE_SMS_CONFIG）。
// 阿里云要求“已审核签名 + 已审核模板”，这里只负责调用，不绕过审核。

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CONFIG_PATH = () =>
  process.env.SRVPRICE_SMS_CONFIG || path.join(process.env.SRVPRICE_HOME || path.join(os.homedir(), '.srvprice'), 'sms.json');

const EXAMPLE = {
  provider: 'aliyun',
  access_key_id: '',
  access_key_secret: '',
  sign_name: '',
  template_code: '',
  param_name: 'content',
  phones: ['13800000000'],
};

function fromEnv() {
  const e = {
    access_key_id: process.env.SMS_ACCESS_KEY,
    access_key_secret: process.env.SMS_ACCESS_SECRET,
    sign_name: process.env.SMS_SIGN_NAME,
    template_code: process.env.SMS_TEMPLATE_CODE,
    param_name: process.env.SMS_PARAM_NAME || 'content',
    phones: process.env.SMS_PHONE ? [process.env.SMS_PHONE] : [],
  };
  const has = ['access_key_id', 'access_key_secret', 'sign_name', 'template_code'].some((k) => e[k])
    || (Array.isArray(e.phones) && e.phones.length > 0);
  return has ? e : null;
}

function load() {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
  } catch (e) {
    file = null;
  }
  const env = fromEnv();
  if (!file && !env) return null;
  const merged = Object.assign({ provider: 'aliyun', param_name: 'content' }, file || {});
  if (env) {
    for (const k of Object.keys(env)) {
      if (env[k] !== undefined && env[k] !== '') merged[k] = env[k];
    }
    if (env.phones && env.phones.length) merged.phones = env.phones;
  }
  return merged;
}

function missing(conf) {
  if (!conf) return ['配置文件或 SMS_* 环境变量'];
  return ['access_key_id', 'access_key_secret', 'sign_name', 'template_code']
    .filter((k) => !conf[k])
    .concat((conf.phones && conf.phones.length) ? [] : ['phones']);
}

function mask(v) {
  const s = String(v || '');
  return s.length <= 8 ? (s ? '***' : '') : s.slice(0, 4) + '…' + s.slice(-4);
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length === 11 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

function status() {
  const conf = load();
  const miss = missing(conf);
  return {
    config_path: CONFIG_PATH(),
    exists: !!conf,
    provider: (conf && conf.provider) || 'aliyun',
    access_key_id: conf ? mask(conf.access_key_id) : '',
    sign_name: (conf && conf.sign_name) || '',
    template_code: (conf && conf.template_code) || '',
    param_name: (conf && conf.param_name) || 'content',
    phones: ((conf && conf.phones) || []).map(maskPhone),
    ready: miss.length === 0,
    missing: miss,
  };
}

function encode(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function signParams(params, secret) {
  const q = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k])}`)
    .join('&');
  const sts = `GET&%2F&${encode(q)}`;
  const sig = crypto.createHmac('sha1', `${secret}&`).update(sts).digest('base64');
  return `${q}&Signature=${encode(sig)}`;
}

function send(opts) {
  const conf = load();
  const miss = missing(conf);
  if (miss.length) {
    return Promise.resolve({ ok: false, error: 'sms_config_missing', missing: miss, config_path: CONFIG_PATH() });
  }
  const phones = (opts.to && opts.to.length ? opts.to : conf.phones || [])
    .map((p) => String(p).replace(/[^0-9]/g, ''))
    .filter((p) => p.length === 11);
  if (!phones.length) return Promise.resolve({ ok: false, error: 'bad_phone' });
  const text = String(opts.text || '');
  if (!text) return Promise.resolve({ ok: false, error: 'empty_text' });

  const params = {
    AccessKeyId: conf.access_key_id,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phones.join(','),
    RegionId: 'cn-hangzhou',
    SignName: conf.sign_name,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID().replace(/-/g, ''),
    SignatureVersion: '1.0',
    TemplateCode: conf.template_code,
    TemplateParam: JSON.stringify({ [conf.param_name || 'content']: text }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2017-05-25',
  };
  const query = signParams(params, conf.access_key_secret);
  const url = `https://dysmsapi.aliyuncs.com/?${query}`;
  if (opts.dryRun) {
    return Promise.resolve({
      ok: true,
      dry_run: true,
      provider: 'aliyun',
      phones: phones.map(maskPhone),
      sign_name: conf.sign_name,
      template_code: conf.template_code,
      param_name: conf.param_name,
      text,
    });
  }
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(body); } catch (e) { /* keep empty */ }
        resolve({
          ok: j.Code === 'OK',
          provider: 'aliyun',
          code: j.Code || `HTTP_${res.statusCode}`,
          message: j.Message || '',
          biz_id: j.BizId || '',
          request_id: j.RequestId || '',
          phones: phones.map(maskPhone),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, provider: 'aliyun', error: e.message }));
  });
}

module.exports = { CONFIG_PATH, EXAMPLE, load, status, send, mask };
