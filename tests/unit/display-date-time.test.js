'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/date-time.mjs');
}

test('時間加上離線校時偏移後只顯示本機 24 小時 HH:mm', async () => {
  const { formatDisplayDateTime } = await loadModule();
  const morning = new Date(2026, 6, 16, 8, 5, 14, 322);
  const midnight = new Date(2026, 6, 17, 0, 0, 0, 7);

  assert.equal(formatDisplayDateTime(morning), '08:05');
  assert.equal(formatDisplayDateTime(midnight), '00:00');
  assert.equal(formatDisplayDateTime(morning, 3_661), '09:06');
  assert.equal(
    formatDisplayDateTime(new Date(2026, 6, 17, 23, 59, 59), 1),
    '00:00',
  );
  assert.equal(formatDisplayDateTime(midnight, -1), '23:59');

  assert.throws(
    () => formatDisplayDateTime(new Date('invalid')),
    { name: 'TypeError', message: '日期時間格式化參數不正確。' },
  );
  assert.throws(
    () => formatDisplayDateTime(morning, -43_200),
    { name: 'TypeError', message: '日期時間格式化參數不正確。' },
  );
});

test('Clock 立即顯示並依校時偏移對齊下一個整分鐘', async () => {
  const { createDisplayClock } = await loadModule();
  let currentDate = new Date('2026-07-16T08:05:14.322+08:00');
  const renders = [];
  const timers = [];
  const clock = createDisplayClock({
    render(value) {
      renders.push(value);
    },
    now: () => new Date(currentDate),
    setTimer(callback, delay) {
      const handle = { callback, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
  });

  assert.equal(clock.update({ enabled: true, offsetSeconds: 3_661 }), true);
  assert.equal(renders.length, 1);
  assert.equal(renders[0].text, '09:06');
  assert.equal(renders[0].dateTime, '09:06');
  assert.equal(timers[0].delay, 44_678);

  currentDate = new Date('2026-07-16T08:05:59.007+08:00');
  timers[0].callback();
  assert.equal(renders.length, 2);
  assert.notEqual(renders[0].text, renders[1].text);
  assert.equal(renders[1].text, '09:07');
  assert.equal(timers[1].delay, 59_993);
});

test('Clock 停用、重新設定與 dispose 都會精確清除 timer', async () => {
  const { createDisplayClock } = await loadModule();
  const renders = [];
  const timers = [];
  const clock = createDisplayClock({
    render(value) {
      renders.push(value);
    },
    now: () => new Date('2026-07-16T08:05:30+08:00'),
    setTimer(callback, delay) {
      const handle = { callback, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
  });

  assert.equal(clock.update({ enabled: true, offsetSeconds: 0 }), true);
  assert.equal(clock.update({ enabled: true, offsetSeconds: 60 }), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, false);
  assert.equal(renders.at(-1).text, '08:06');

  assert.equal(clock.update({ enabled: false, offsetSeconds: 60 }), true);
  assert.equal(timers[1].cleared, true);
  assert.equal(renders.at(-1), null);

  assert.equal(clock.update({ enabled: 'yes', offsetSeconds: 0 }), false);
  assert.equal(clock.update({ enabled: true, offsetSeconds: 43_201 }), false);
  clock.dispose();
  clock.dispose();
  assert.equal(clock.update({ enabled: true, offsetSeconds: 0 }), false);
});
