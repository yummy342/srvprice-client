'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const r = require('../lib/recorder');

const ESC = '\u001b';

// stream.exe 真实输出样式：每份快照前是 ESC[2K\r + 100 空格 + ESC[2K\r
function snapshot(text) {
  return ESC + '[2K\r' + ' '.repeat(100) + ESC + '[2K\r' + text;
}

test('parseSnapshots 只取最后一份快照，不拼接', () => {
  const buf = '[Start speaking]\r\n'
    + snapshot('我要找')
    + snapshot('我要找一个便宜的服务器');
  assert.deepStrictEqual(r.parseSnapshots(buf), ['我要找', '我要找一个便宜的服务器']);
});

test('parseSnapshots 过滤空音频 / 字幕组 / 括号音效', () => {
  const buf = snapshot('[BLANK_AUDIO]')
    + snapshot('(字幕:J Chong)')
    + snapshot('(音乐)')
    + snapshot('（笑）')
    + snapshot('正常的一句话');
  assert.deepStrictEqual(r.parseSnapshots(buf), ['正常的一句话']);
});

test('looksLikeLoop 认出复读幻听，不误伤正常命令', () => {
  assert.strictEqual(r.looksLikeLoop('我没想到你会做的事吗?'.repeat(12)), true);
  assert.strictEqual(r.looksLikeLoop('帮我找一个两核四G的便宜服务器，最好在华北'), false);
});

test('repairWavHeader 补上被强杀时缺失的长度字段', () => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0, 40);
  const buf = Buffer.concat([header, Buffer.alloc(32000, 1)]); // 1 秒 16k/16bit/mono
  const n = r.repairWavHeader(buf);
  assert.strictEqual(n, 32000);
  assert.strictEqual(buf.readUInt32LE(40), 32000);
  assert.strictEqual(buf.readUInt32LE(4), buf.length - 8);
  assert.strictEqual(r.wavDurationSec(n), 1);
  assert.strictEqual(r.repairWavHeader(Buffer.from('not a wav')), -1);
});

test('pickText 实时快照优先，其次 wav', () => {
  assert.deepStrictEqual(r.pickText('实时', '文件'), { text: '实时', source: 'live' });
  assert.deepStrictEqual(r.pickText('', '文件'), { text: '文件', source: 'wav' });
  assert.deepStrictEqual(r.pickText('', ''), { text: '', source: 'none' });
});

// 假 stream.exe：手动发 stdout，kill 只发 exit
function fakeStream(script) {
  return function spawnFake() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true;
      setImmediate(() => child.emit('exit', null));
    };
    script(child);
    return child;
  };
}

test('listen：说一句 → 静默自动停，回实时文本并杀掉子进程', async () => {
  let killed = false;
  const spawnFake = fakeStream((child) => {
    setTimeout(() => child.stdout.emit('data', Buffer.from(snapshot('帮我找一个便宜的服务器'), 'utf8')), 40);
    child.on('exit', () => { killed = true; });
  });
  const res = await r.listen({ _spawn: spawnFake, _model: 'fake.bin', maxMs: 5000, silenceMs: 300 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.text, '帮我找一个便宜的服务器');
  assert.strictEqual(res.source, 'live');
  assert.strictEqual(killed, true);
});

test('listen：全程没声音 → 到 max 秒停，返回没听到说话', async () => {
  const res = await r.listen({ _spawn: fakeStream(() => {}), _model: 'fake.bin', maxMs: 700, silenceMs: 300 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, '没听到说话');
  assert.ok(res.seconds < 3, '应该在 max 附近停下');
});

test('listen：后续短快照不能覆盖前面更完整的句子', async () => {
  const res = await r.listen({
    _spawn: fakeStream((child) => {
      setTimeout(() => child.stdout.emit('data', Buffer.from(snapshot('帮我找一个便宜的服务器'), 'utf8')), 40);
      setTimeout(() => child.stdout.emit('data', Buffer.from(snapshot('帮我找你'), 'utf8')), 160);
    }),
    _model: 'fake.bin', maxMs: 5000, silenceMs: 300
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.text, '帮我找一个便宜的服务器');
});

test('listen：幻听复读不当作识别结果', async () => {
  const loop = '我没想到你会做的事吗?'.repeat(12);
  const res = await r.listen({
    _spawn: fakeStream((child) => {
      setTimeout(() => child.stdout.emit('data', Buffer.from(snapshot(loop), 'utf8')), 40);
    }),
    _model: 'fake.bin', maxMs: 700, silenceMs: 300
  });
  assert.strictEqual(res.ok, false);
});
