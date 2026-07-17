'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../control/time-calibration.mjs');
}

test('24 小時時間只接受完整且補零的 HH:mm:ss', async () => {
  const { parseClockTime } = await loadModule();

  assert.equal(parseClockTime('00:00:00'), 0);
  assert.equal(parseClockTime('08:05:09'), 8 * 3_600 + 5 * 60 + 9);
  assert.equal(parseClockTime('23:59:59'), 86_399);

  for (const value of [
    null,
    undefined,
    80509,
    '',
    '0:00:00',
    '00:0:00',
    '00:00:0',
    ' 08:05:09',
    '08:05:09 ',
    '24:00:00',
    '23:60:00',
    '23:59:60',
    '08：05：09',
    '08:05',
    '08:05:09.000',
  ]) {
    assert.equal(parseClockTime(value), null, JSON.stringify(value));
  }
});

test('秒數只格式化為固定 24 小時 HH:mm:ss', async () => {
  const { formatClockTime } = await loadModule();

  assert.equal(formatClockTime(0), '00:00:00');
  assert.equal(formatClockTime(8 * 3_600 + 5 * 60 + 9), '08:05:09');
  assert.equal(formatClockTime(86_399), '23:59:59');

  for (const value of [-1, 86_400, 1.5, NaN, Infinity, '0', null]) {
    assert.equal(formatClockTime(value), null, JSON.stringify(value));
  }
});

test('校時偏移以最短日內距離跨越午夜', async () => {
  const { calculateClockOffsetSeconds } = await loadModule();

  assert.equal(calculateClockOffsetSeconds(0, 86_399), 1);
  assert.equal(calculateClockOffsetSeconds(86_399, 0), -1);
  assert.equal(calculateClockOffsetSeconds(0, 1), -1);
  assert.equal(calculateClockOffsetSeconds(1, 0), 1);
});

test('校時偏移 canonical 範圍固定為 -43199 至 43200 秒', async () => {
  const { calculateClockOffsetSeconds } = await loadModule();

  assert.equal(calculateClockOffsetSeconds(43_200, 0), 43_200);
  assert.equal(calculateClockOffsetSeconds(0, 43_200), 43_200);
  assert.equal(calculateClockOffsetSeconds(1, 43_200), -43_199);
  assert.equal(calculateClockOffsetSeconds(43_200, 1), 43_199);

  for (const current of [0, 1, 21_599, 43_200, 64_801, 86_399]) {
    for (const target of [0, 1, 21_599, 43_200, 64_801, 86_399]) {
      const offset = calculateClockOffsetSeconds(target, current);
      assert.equal(Number.isSafeInteger(offset), true);
      assert.ok(offset >= -43_199 && offset <= 43_200);
      assert.equal(
        (current + offset + 86_400) % 86_400,
        target,
        `current=${current}, target=${target}`,
      );
    }
  }

  for (const [target, current] of [
    [-1, 0],
    [86_400, 0],
    [0, -1],
    [0, 86_400],
    [1.5, 0],
    [0, NaN],
    ['0', 0],
  ]) {
    assert.equal(calculateClockOffsetSeconds(target, current), null);
  }
});
