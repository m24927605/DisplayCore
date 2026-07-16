'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/date-time.mjs');
}

test('日期時間依 locale 與 12／24 小時設定在 Renderer 本機格式化', async () => {
  const { formatDisplayDateTime } = await loadModule();
  const date = new Date('2026-07-16T08:05:00+08:00');
  const twentyFourHour = formatDisplayDateTime(date, {
    locale: 'zh-TW',
    hour12: false,
  });
  const twelveHour = formatDisplayDateTime(date, {
    locale: 'zh-TW',
    hour12: true,
  });

  assert.match(twentyFourHour, /2026/);
  assert.match(twentyFourHour, /07|7/);
  assert.match(twentyFourHour, /16/);
  assert.match(twentyFourHour, /08|8/);
  assert.match(twentyFourHour, /05/);
  assert.notEqual(twentyFourHour, twelveHour);
  assert.match(twelveHour, /上午|AM/i);

  assert.throws(
    () => formatDisplayDateTime(new Date('invalid'), {
      locale: 'zh-TW',
      hour12: false,
    }),
    { name: 'TypeError', message: '日期時間格式化參數不正確。' },
  );
});

test('Clock 立即顯示並對齊下一個整分鐘，callback 後重新校時', async () => {
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

  assert.equal(clock.update({ enabled: true, locale: 'zh-TW', hour12: false }), true);
  assert.equal(renders.length, 1);
  assert.match(renders[0].text, /2026/);
  assert.equal(renders[0].dateTime, currentDate.toISOString());
  assert.equal(timers[0].delay, 45_678);

  currentDate = new Date('2026-07-16T08:06:00.007+08:00');
  timers[0].callback();
  assert.equal(renders.length, 2);
  assert.notEqual(renders[0].text, renders[1].text);
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

  assert.equal(clock.update({ enabled: true, locale: 'zh-TW', hour12: false }), true);
  assert.equal(clock.update({ enabled: true, locale: 'en-US', hour12: true }), true);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, false);

  assert.equal(clock.update({ enabled: false, locale: 'zh-TW', hour12: false }), true);
  assert.equal(timers[1].cleared, true);
  assert.equal(renders.at(-1), null);

  assert.equal(clock.update({ enabled: 'yes', locale: 'zh-TW', hour12: false }), false);
  clock.dispose();
  clock.dispose();
  assert.equal(clock.update({ enabled: true, locale: 'zh-TW', hour12: false }), false);
});

