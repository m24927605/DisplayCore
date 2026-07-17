'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/settings-controller.mjs');
}

function createSnapshot(
  revision = 0,
  backgroundColor = '#000000',
  backgroundImageUrls = [],
  logoSizePercent = 100,
) {
  return {
    configVersion: 7,
    logo: { enabled: false, url: null, sizePercent: logoSizePercent },
    standby: {
      backgroundMode: backgroundImageUrls.length > 1 ? 'slideshow' : 'fixed',
      backgroundImageUrls,
      slideDurationSeconds: 10,
    },
    appearance: {
      backgroundColor,
      fontFamily: 'Microsoft JhengHei UI, sans-serif',
      fontColor: '#FFFFFF',
      minimumFontSizeRem: 2.5,
      fontSizePercent: 100,
      lineSpacingPercent: 100,
    },
    dateTime: { enabled: false, offsetSeconds: 0 },
    emergency: {
      inspectionBackgroundColor: '#000000',
      releaseBackgroundColor: '#000000',
    },
    marquee: { enabled: true },
    display: { renderResolution: 'auto' },
    revision,
  };
}

function createHarness(apiOverrides = {}) {
  const calls = [];
  let listener = null;
  let unsubscribeCalls = 0;
  const api = {
    onSettingsChanged(nextListener) {
      calls.push('subscribe');
      listener = nextListener;
      return () => {
        unsubscribeCalls += 1;
        listener = null;
      };
    },
    async getSettings() {
      calls.push('get');
      return { ok: true, data: createSnapshot() };
    },
    ...apiOverrides,
  };
  const applied = [];

  return {
    api,
    applied,
    calls,
    emit(snapshot) {
      listener?.(snapshot);
    },
    get unsubscribeCalls() {
      return unsubscribeCalls;
    },
    view: {
      applyDisplaySettings(snapshot) {
        applied.push(snapshot);
      },
    },
  };
}

test('設定啟動先訂閱再 GET，較舊 GET 不覆蓋較新 event', async () => {
  const { createDisplaySettingsController } = await loadModule();
  let resolveGet;
  const harness = createHarness({
    getSettings() {
      harness.calls.push('get');
      return new Promise((resolve) => {
        resolveGet = resolve;
      });
    },
  });
  const controller = createDisplaySettingsController(harness);
  const startPromise = controller.start();

  assert.deepEqual(harness.calls, ['subscribe', 'get']);
  harness.emit(createSnapshot(2, '#223344'));
  resolveGet({ ok: true, data: createSnapshot(1, '#111111') });

  assert.equal(await startPromise, true);
  assert.deepEqual(
    harness.applied.map(({ revision }) => revision),
    [2],
  );
  assert.equal(harness.applied[0].appearance.backgroundColor, '#223344');
  assert.deepEqual(harness.applied[0].standby.backgroundImageUrls, []);
});

test('快速設定事件只套用最高 revision，畸形資料保留最後有效值', async () => {
  const { createDisplaySettingsController } = await loadModule();
  const harness = createHarness();
  const controller = createDisplaySettingsController(harness);
  assert.equal(await controller.start(), true);

  const managedBackgroundUrl =
    'displaycore://app/managed/standby-background/fedcba987654321001234567.webp';
  harness.emit(createSnapshot(3, '#333333', [managedBackgroundUrl], 1_000));
  harness.emit(createSnapshot(2, '#222222'));
  harness.emit({ ...createSnapshot(4), unknown: true });
  harness.emit({
    ...createSnapshot(4),
    playback: {
      pageDurationSeconds: 3,
      repeatMode: 'finite',
      roundCount: 1,
    },
  });
  harness.emit(createSnapshot(5, '#555555'));
  harness.emit(createSnapshot(5, '#FFFFFF'));

  assert.deepEqual(
    harness.applied.map(({ revision }) => revision),
    [0, 3, 5],
  );
  assert.equal(harness.applied.at(-1).appearance.backgroundColor, '#555555');
  assert.deepEqual(
    harness.applied[1].standby.backgroundImageUrls,
    [managedBackgroundUrl],
  );
  assert.equal(harness.applied[1].logo.sizePercent, 1_000);
});

test('畸形待機背景 URL 不覆蓋最後有效設定', async () => {
  const { createDisplaySettingsController } = await loadModule();
  const harness = createHarness();
  const controller = createDisplaySettingsController(harness);
  assert.equal(await controller.start(), true);

  const managedBackgroundUrl =
    'displaycore://app/managed/standby-background/0123456789abcdef01234567.png';
  harness.emit(createSnapshot(1, '#112233', [managedBackgroundUrl]));
  harness.emit(createSnapshot(2, '#445566', ['file:///C:/private/background.png']));
  harness.emit({
    ...createSnapshot(3),
    standby: {
      backgroundMode: 'fixed',
      backgroundImageUrls: [],
      slideDurationSeconds: 10,
      extra: true,
    },
  });

  assert.deepEqual(
    harness.applied.map(({ revision }) => revision),
    [0, 1],
  );
  assert.deepEqual(
    harness.applied.at(-1).standby.backgroundImageUrls,
    [managedBackgroundUrl],
  );
});

test('GET 失敗不套用錯誤文字，保留訂閱供後續事件恢復', async () => {
  const { createDisplaySettingsController } = await loadModule();
  const harness = createHarness({
    async getSettings() {
      throw new Error('C:\\Users\\Operator\\config.json');
    },
  });
  const controller = createDisplaySettingsController(harness);

  assert.equal(await controller.start(), false);
  assert.deepEqual(harness.applied, []);
  harness.emit(createSnapshot(7, '#123456'));
  assert.deepEqual(harness.applied.map(({ revision }) => revision), [7]);
});

test('畸形 envelope、缺少 unsubscribe 與 dispose 後事件皆安全失敗', async () => {
  const { createDisplaySettingsController } = await loadModule();
  const invalidResponseHarness = createHarness({
    async getSettings() {
      return { ok: true, data: { revision: 0 } };
    },
  });
  assert.equal(
    await createDisplaySettingsController(invalidResponseHarness).start(),
    false,
  );

  const missingUnsubscribeHarness = createHarness({
    onSettingsChanged() {
      return undefined;
    },
  });
  assert.equal(
    await createDisplaySettingsController(missingUnsubscribeHarness).start(),
    false,
  );

  const harness = createHarness();
  const controller = createDisplaySettingsController(harness);
  assert.equal(await controller.start(), true);
  controller.dispose();
  controller.dispose();
  harness.emit(createSnapshot(9));
  assert.equal(harness.unsubscribeCalls, 1);
  assert.deepEqual(harness.applied.map(({ revision }) => revision), [0]);
  assert.equal(await controller.start(), false);
});
