'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { speak } = require('../lib/voice');

test('只有三类触发会出声，其余静默', () => {
  assert.deepStrictEqual(speak('hi', 'idle'), { spoken: false, reason: 'silent' });
  assert.deepStrictEqual(speak('hi', 'progress'), { spoken: false, reason: 'silent' });
});

test('空文本不出声', () => {
  assert.deepStrictEqual(speak('  ', 'done'), { spoken: false, reason: 'empty' });
});

test('测试模式不 spawn 进程', () => {
  assert.deepStrictEqual(speak('hi', 'done', { noSpawn: true }), { spoken: false, reason: 'test' });
});
