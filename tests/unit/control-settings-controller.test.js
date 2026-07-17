'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');

async function loadModule() {
  return import('../../control/settings-controller.mjs');
}

function createSnapshot(revision = 0, config = defaultConfig) {
  return {
    config,
    defaults: defaultConfig,
    revision,
    notice: null,
  };
}

function createHarness(apiOverrides = {}) {
  const calls = {
    busy: [],
    errors: [],
    logoAssets: [],
    standbyBackgroundAssets: [],
    snapshots: [],
    statuses: [],
  };
  const api = {
    async getSettings() {
      return { ok: true, data: createSnapshot() };
    },
    async saveSettings(config, expectedRevision) {
      return {
        ok: true,
        data: createSnapshot(expectedRevision + 1, config),
      };
    },
    async chooseLogo() {
      return {
        ok: true,
        data: {
          canceled: false,
          assetPath: 'logos/0123456789abcdef01234567.png',
        },
      };
    },
    async chooseStandbyBackground() {
      return {
        ok: true,
        data: {
          canceled: false,
          assetPath:
            'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
        },
      };
    },
    ...apiOverrides,
  };
  const view = {
    setSettingsBusy(value, operation) {
      calls.busy.push({ value, operation });
    },
    renderSettingsError(message, field) {
      calls.errors.push({ message, field });
    },
    renderLogoSelection(assetPath) {
      calls.logoAssets.push(assetPath);
    },
    renderStandbyBackgroundSelection(assetPath) {
      calls.standbyBackgroundAssets.push(assetPath);
    },
    renderSettingsSnapshot(snapshot) {
      calls.snapshots.push(snapshot);
    },
    renderSettingsStatus(message) {
      calls.statuses.push(message);
    },
  };

  return { api, calls, view };
}

test('載入設定時驗證 snapshot，再交給 view 建立基準與預設值', async () => {
  const { createSettingsController } = await loadModule();
  const harness = createHarness();
  const controller = createSettingsController(harness);

  const loaded = await controller.loadSettings();

  assert.equal(loaded, true);
  assert.equal(harness.calls.snapshots.length, 1);
  assert.equal(harness.calls.snapshots[0].revision, 0);
  assert.equal(harness.calls.snapshots[0].config.configVersion, 5);
  assert.deepEqual(
    harness.calls.snapshots[0].config.playback,
    defaultConfig.playback,
  );
  assert.equal(
    Object.isFrozen(harness.calls.snapshots[0].config.playback),
    true,
  );
  assert.deepEqual(harness.calls.busy, [
    { value: true, operation: 'load' },
    { value: false, operation: 'load' },
  ]);
  assert.deepEqual(harness.calls.statuses, ['設定已載入。']);
  assert.deepEqual(harness.calls.errors, []);
});

test('儲存設定在 await 前鎖定，連點只送出一筆並採用回傳 revision', async () => {
  const { createSettingsController } = await loadModule();
  let resolveSave;
  const saveCalls = [];
  const harness = createHarness({
    saveSettings(config, expectedRevision) {
      saveCalls.push({ config, expectedRevision });
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    },
  });
  const controller = createSettingsController(harness);
  const config = structuredClone(defaultConfig);
  config.marquee.enabled = false;
  config.playback = {
    pageDurationSeconds: 9,
    repeatMode: 'continuous',
    roundCount: 12,
  };

  const first = controller.saveSettings(config, 4);
  const second = controller.saveSettings(config, 4);

  assert.equal(await second, false);
  assert.equal(saveCalls.length, 1);
  assert.deepEqual(saveCalls[0], { config, expectedRevision: 4 });
  resolveSave({ ok: true, data: createSnapshot(5, config) });
  assert.equal(await first, true);
  assert.equal(harness.calls.snapshots.at(-1).revision, 5);
  assert.deepEqual(
    harness.calls.snapshots.at(-1).config.playback,
    config.playback,
  );
  assert.notEqual(harness.calls.snapshots.at(-1).config.playback, config.playback);
  assert.equal(
    Object.isFrozen(harness.calls.snapshots.at(-1).config.playback),
    true,
  );
  assert.deepEqual(harness.calls.statuses, [
    '設定已儲存並即時套用到顯示畫面。',
  ]);
});

test('儲存成功 envelope 仍必須是完整 standby/playback v5 snapshot', async () => {
  const { createSettingsController } = await loadModule();
  const invalidConfigs = [
    { ...defaultConfig, configVersion: 4 },
    { ...defaultConfig, standby: { backgroundImagePath: 'C:\\private.png' } },
    { ...defaultConfig, playback: { ...defaultConfig.playback, roundCount: 0 } },
    { ...defaultConfig, playback: { ...defaultConfig.playback, extra: true } },
  ];

  for (const invalidConfig of invalidConfigs) {
    const harness = createHarness({
      async saveSettings() {
        return {
          ok: true,
          data: createSnapshot(1, invalidConfig),
        };
      },
    });
    const controller = createSettingsController(harness);

    assert.equal(await controller.saveSettings(defaultConfig, 0), false);
    assert.deepEqual(harness.calls.errors, [{
      message: '主程序回傳無效設定資料，請重新啟動 DisplayCore。',
      field: undefined,
    }]);
    assert.equal(harness.calls.snapshots.length, 0);
  }
});

test('設定驗證與 revision 衝突保留 Main 的安全欄位錯誤', async () => {
  const { createSettingsController } = await loadModule();
  const scenarios = [
    {
      error: {
        code: 'VALIDATION_FAILED',
        message: '請輸入六位十六進位色碼。',
        field: 'appearance.fontColor',
      },
    },
    {
      error: {
        code: 'CONFIG_CONFLICT',
        message: '設定已由另一個操作更新，請重新載入後再儲存。',
      },
    },
  ];

  for (const scenario of scenarios) {
    const harness = createHarness({
      async saveSettings() {
        return { ok: false, error: scenario.error };
      },
    });
    const controller = createSettingsController(harness);

    assert.equal(await controller.saveSettings(defaultConfig, 0), false);
    assert.deepEqual(harness.calls.errors, [{
      message: scenario.error.message,
      field: scenario.error.field,
    }]);
    assert.equal(harness.calls.snapshots.length, 0);
  }
});

test('Logo 取消不改草稿；成功只回傳受管理 asset path', async () => {
  const { createSettingsController } = await loadModule();
  const canceledHarness = createHarness({
    async chooseLogo() {
      return { ok: true, data: { canceled: true, assetPath: null } };
    },
  });
  const canceledController = createSettingsController(canceledHarness);

  assert.equal(await canceledController.chooseLogo(), true);
  assert.deepEqual(canceledHarness.calls.logoAssets, []);
  assert.deepEqual(canceledHarness.calls.statuses, ['已取消選擇 Logo。']);

  const selectedHarness = createHarness();
  const selectedController = createSettingsController(selectedHarness);
  assert.equal(await selectedController.chooseLogo(), true);
  assert.deepEqual(selectedHarness.calls.logoAssets, [
    'logos/0123456789abcdef01234567.png',
  ]);
  assert.deepEqual(selectedHarness.calls.statuses, [
    'Logo 已匯入；儲存設定後才會採用。',
  ]);
});

test('待機背景取消不改草稿；成功只接受專用受管理路徑', async () => {
  const { createSettingsController } = await loadModule();
  const canceledHarness = createHarness({
    async chooseStandbyBackground() {
      return { ok: true, data: { canceled: true, assetPath: null } };
    },
  });
  const canceledController = createSettingsController(canceledHarness);

  assert.equal(await canceledController.chooseStandbyBackground(), true);
  assert.deepEqual(canceledHarness.calls.standbyBackgroundAssets, []);
  assert.deepEqual(canceledHarness.calls.statuses, [
    '已取消選擇待機背景圖片。',
  ]);

  const selectedHarness = createHarness();
  const selectedController = createSettingsController(selectedHarness);
  assert.equal(await selectedController.chooseStandbyBackground(), true);
  assert.deepEqual(selectedHarness.calls.standbyBackgroundAssets, [
    'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
  ]);
  assert.deepEqual(selectedHarness.calls.statuses, [
    '待機背景圖片已匯入；儲存設定後才會採用。',
  ]);

  for (const assetPath of [
    'logos/abcdefabcdefabcdefabcdef.webp',
    'standby-backgrounds/operator.webp',
    'C:\\Users\\Operator\\private.webp',
  ]) {
    const invalidHarness = createHarness({
      async chooseStandbyBackground() {
        return { ok: true, data: { canceled: false, assetPath } };
      },
    });
    const controller = createSettingsController(invalidHarness);
    assert.equal(await controller.chooseStandbyBackground(), false);
    assert.deepEqual(invalidHarness.calls.standbyBackgroundAssets, []);
    assert.doesNotMatch(JSON.stringify(invalidHarness.calls.errors), /Users/);
  }
});

test('畸形成功 envelope 與 IPC rejection 使用固定錯誤，不洩漏路徑', async () => {
  const { createSettingsController } = await loadModule();
  const scenarios = [
    {
      api: {
        async getSettings() {
          return { ok: true, data: { config: defaultConfig } };
        },
      },
      method: 'loadSettings',
      expected: '主程序回傳無效設定資料，請重新啟動 DisplayCore。',
    },
    {
      api: {
        async chooseLogo() {
          throw new Error('C:\\Users\\Operator\\private-logo.png');
        },
      },
      method: 'chooseLogo',
      expected: '無法連接主程序，請重新啟動 DisplayCore。',
    },
    {
      api: {
        async chooseStandbyBackground() {
          throw new Error('C:\\Users\\Operator\\private-background.png');
        },
      },
      method: 'chooseStandbyBackground',
      expected: '無法連接主程序，請重新啟動 DisplayCore。',
    },
  ];

  for (const scenario of scenarios) {
    const harness = createHarness(scenario.api);
    const controller = createSettingsController(harness);
    const result = await controller[scenario.method]();

    assert.equal(result, false);
    assert.deepEqual(harness.calls.errors, [{
      message: scenario.expected,
      field: undefined,
    }]);
    assert.doesNotMatch(JSON.stringify(harness.calls.errors), /Users|private-logo/i);
  }
});

test('dispose 後所有設定操作安全失敗且不再呼叫 bridge', async () => {
  const { createSettingsController } = await loadModule();
  let calls = 0;
  const harness = createHarness({
    async getSettings() {
      calls += 1;
      return { ok: true, data: createSnapshot() };
    },
  });
  const controller = createSettingsController(harness);
  controller.dispose();

  assert.equal(await controller.loadSettings(), false);
  assert.equal(await controller.saveSettings(defaultConfig, 0), false);
  assert.equal(await controller.chooseLogo(), false);
  assert.equal(await controller.chooseStandbyBackground(), false);
  assert.equal(calls, 0);
});
