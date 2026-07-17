'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/standby-background-player.mjs');
}

function createFakeTimers() {
  const handles = [];

  return {
    handles,
    setTimer(callback, delay) {
      const handle = { callback, cleared: false, delay };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    fire(handle) {
      handle.callback();
    },
    active() {
      return handles.filter(({ cleared }) => !cleared);
    },
  };
}

function createHarness() {
  const timers = createFakeTimers();
  const sources = [];
  let player;

  return loadModule().then(({ createStandbyBackgroundPlayer }) => {
    player = createStandbyBackgroundPlayer({
      onSourceChange: (url) => sources.push(url),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    return { player, sources, timers };
  });
}

const FIRST =
  'displaycore://app/managed/standby-background/000000000000000000000001.png';
const SECOND =
  'displaycore://app/managed/standby-background/000000000000000000000002.jpg';
const THIRD =
  'displaycore://app/managed/standby-background/000000000000000000000003.webp';

function createSettings(overrides = {}) {
  return {
    active: true,
    backgroundMode: 'slideshow',
    backgroundImageUrls: [FIRST, SECOND, THIRD],
    slideDurationSeconds: 3,
    ...overrides,
  };
}

test('輪播僅於待機圖片載入成功後計時，切換來源後重新等待 load', async () => {
  const { player, sources, timers } = await createHarness();

  player.update(createSettings());
  assert.deepEqual(sources, [FIRST]);
  assert.equal(timers.active().length, 0);

  assert.equal(player.handleLoad(FIRST), true);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 3_000);

  timers.fire(timers.active()[0]);
  assert.deepEqual(sources, [FIRST, SECOND]);
  assert.equal(timers.active().length, 0);

  assert.equal(player.handleLoad(SECOND), true);
  assert.equal(timers.active().length, 1);
  timers.fire(timers.active()[0]);
  assert.deepEqual(sources, [FIRST, SECOND, THIRD]);
});

test('固定模式、零張或一張圖片不建立輪播計時器', async () => {
  for (const settings of [
    createSettings({ backgroundMode: 'fixed' }),
    createSettings({ backgroundImageUrls: [] }),
    createSettings({ backgroundImageUrls: [FIRST] }),
  ]) {
    const { player, sources, timers } = await createHarness();

    player.update(settings);
    assert.deepEqual(sources, [settings.backgroundImageUrls[0] ?? null]);
    if (settings.backgroundImageUrls.length > 0) {
      assert.equal(player.handleLoad(settings.backgroundImageUrls[0]), true);
    }
    assert.equal(timers.active().length, 0);
  }
});

test('離開待機與設定更新取消 stale timer，回待機一律從第一張重設', async () => {
  const { player, sources, timers } = await createHarness();

  player.update(createSettings());
  player.handleLoad(FIRST);
  const firstTimer = timers.active()[0];

  player.update(createSettings({ active: false }));
  assert.equal(firstTimer.cleared, true);
  timers.fire(firstTimer);
  assert.deepEqual(sources, [FIRST]);

  player.update(createSettings());
  player.handleLoad(FIRST);
  const secondTimer = timers.active()[0];
  timers.fire(secondTimer);
  assert.equal(sources.at(-1), SECOND);

  player.update(createSettings({
    backgroundImageUrls: [THIRD, FIRST],
    slideDurationSeconds: 8,
  }));
  assert.equal(secondTimer.cleared, true);
  assert.equal(sources.at(-1), THIRD);
  player.handleLoad(THIRD);
  assert.equal(timers.active()[0].delay, 8_000);

  player.update(createSettings({ active: false }));
  player.update(createSettings({
    backgroundImageUrls: [THIRD, FIRST],
    slideDurationSeconds: 8,
  }));
  assert.equal(sources.at(-1), THIRD);
});

test('圖片錯誤有界跳過；全數失敗後停用且不形成零延遲迴圈', async () => {
  const { player, sources, timers } = await createHarness();

  player.update(createSettings());
  assert.equal(player.handleError(FIRST), true);
  assert.equal(sources.at(-1), SECOND);
  assert.equal(player.handleError(SECOND), true);
  assert.equal(sources.at(-1), THIRD);
  assert.equal(player.handleError(THIRD), true);
  assert.equal(sources.at(-1), null);
  assert.equal(timers.active().length, 0);
  assert.equal(sources.length, 4);

  assert.equal(player.handleError(FIRST), false);
  assert.equal(player.handleLoad(SECOND), false);
  assert.equal(sources.length, 4);
});

test('單張失敗會略過但健康圖片仍依成功載入時間輪播', async () => {
  const { player, sources, timers } = await createHarness();

  player.update(createSettings());
  player.handleError(FIRST);
  player.handleLoad(SECOND);
  timers.fire(timers.active()[0]);
  assert.equal(sources.at(-1), THIRD);

  player.handleLoad(THIRD);
  timers.fire(timers.active()[0]);
  assert.equal(sources.at(-1), SECOND);
  assert.equal(sources.includes(FIRST, 1), false);
});

test('dispose 取消計時器、清除來源並拒絕後續 stale 事件', async () => {
  const { player, sources, timers } = await createHarness();

  player.update(createSettings());
  player.handleLoad(FIRST);
  const timer = timers.active()[0];

  player.dispose();
  assert.equal(timer.cleared, true);
  assert.equal(sources.at(-1), null);
  timers.fire(timer);
  assert.equal(player.handleLoad(FIRST), false);
  assert.equal(player.handleError(FIRST), false);
  assert.equal(sources.at(-1), null);
});
