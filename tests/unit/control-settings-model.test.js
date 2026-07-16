'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');
const { validateConfig } = require('../../config/config-schema');

async function loadModule() {
  return import('../../control/settings-model.mjs');
}

function createSnapshot(overrides = {}) {
  return {
    config: defaultConfig,
    defaults: defaultConfig,
    revision: 0,
    notice: null,
    ...overrides,
  };
}

test('Control 接受完整設定 snapshot，建立深層凍結副本', async () => {
  const { acceptSettingsSnapshot } = await loadModule();
  const source = createSnapshot({
    notice: {
      code: 'INVALID_USER_CONFIG',
      message: '使用者設定檔無法讀取，目前使用安全預設值；儲存後可修復。',
    },
  });

  const result = acceptSettingsSnapshot(source);

  assert.equal(result.ok, true);
  assert.notEqual(result.snapshot, source);
  assert.notEqual(result.snapshot.config, source.config);
  assert.notEqual(result.snapshot.defaults, source.defaults);
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.config.appearance), true);
  assert.equal(Object.isFrozen(result.snapshot.notice), true);
});

test('Control 拒絕未知欄位、畸形 notice、revision 與設定內容', async () => {
  const { acceptSettingsSnapshot } = await loadModule();
  const invalidCandidates = [
    null,
    {},
    { ...createSnapshot(), unknown: true },
    createSnapshot({ revision: -1 }),
    createSnapshot({ revision: 1.5 }),
    createSnapshot({ notice: { code: 'UNKNOWN', message: '任意文字' } }),
    createSnapshot({ notice: { code: 'INVALID_USER_CONFIG' } }),
    createSnapshot({ config: { ...defaultConfig, unknown: true } }),
    createSnapshot({
      defaults: {
        ...defaultConfig,
        appearance: { ...defaultConfig.appearance, fontColor: 'white' },
      },
    }),
  ];

  for (const candidate of invalidCandidates) {
    assert.equal(acceptSettingsSnapshot(candidate).ok, false);
  }
});

test('設定草稿只修改顯示內容，原樣保留相容用輸出欄位與 locale', async () => {
  const { buildSettingsDraft } = await loadModule();
  const baseline = structuredClone(defaultConfig);
  baseline.display = {
    selectionMode: 'manual',
    defaultDisplayId: 42,
    fullscreen: false,
  };

  const result = buildSettingsDraft({
    baseline,
    logoEnabled: true,
    logoPath: 'logos/0123456789abcdef01234567.png',
    backgroundColor: '#102a3c',
    fontFamily: 'Arial, sans-serif',
    fontColor: '#f0e0d0',
    minimumFontSizeRem: '3.25',
    dateTimeEnabled: true,
    hour12: true,
    marqueeEnabled: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config, {
    configVersion: 1,
    logo: {
      enabled: true,
      path: 'logos/0123456789abcdef01234567.png',
    },
    appearance: {
      backgroundColor: '#102A3C',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#F0E0D0',
      minimumFontSizeRem: 3.25,
    },
    dateTime: { enabled: true, locale: 'zh-TW', hour12: true },
    marquee: { enabled: false },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
    },
  });
  assert.equal(validateConfig(result.config).ok, true);
});

test('Renderer 草稿驗證與 Main schema 的主要邊界一致', async () => {
  const { buildSettingsDraft } = await loadModule();
  const validRaw = {
    baseline: defaultConfig,
    logoEnabled: false,
    logoPath: null,
    backgroundColor: '#000000',
    fontFamily: defaultConfig.appearance.fontFamily,
    fontColor: '#FFFFFF',
    minimumFontSizeRem: '2.5',
    dateTimeEnabled: false,
    hour12: false,
    marqueeEnabled: true,
  };
  const invalidPartials = [
    { logoEnabled: true, logoPath: null },
    { logoPath: 'C:\\logo.png' },
    { logoPath: 'logos/operator-logo.png' },
    { backgroundColor: '#000' },
    { fontColor: 'white' },
    { fontFamily: '   ' },
    { minimumFontSizeRem: '2.6' },
    { minimumFontSizeRem: '1e2' },
    { minimumFontSizeRem: '0.75' },
    { minimumFontSizeRem: '12.25' },
    { dateTimeEnabled: 'true' },
    { hour12: 0 },
    { marqueeEnabled: 1 },
  ];

  for (const partial of invalidPartials) {
    const result = buildSettingsDraft({ ...validRaw, ...partial });
    assert.equal(result.ok, false, JSON.stringify(partial));
    assert.equal(typeof result.error.field, 'string');
  }
});

test('已移除的輸出草稿參數無法改變 baseline 相容欄位', async () => {
  const { buildSettingsDraft } = await loadModule();
  const result = buildSettingsDraft({
    baseline: defaultConfig,
    logoEnabled: false,
    logoPath: null,
    backgroundColor: '#000000',
    fontFamily: defaultConfig.appearance.fontFamily,
    fontColor: '#FFFFFF',
    minimumFontSizeRem: '2.5',
    dateTimeEnabled: false,
    hour12: false,
    marqueeEnabled: true,
    displaySelectionMode: 'manual',
    defaultDisplayId: '42',
    displayFullscreen: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config.display, {
    selectionMode: 'auto',
    defaultDisplayId: null,
    fullscreen: true,
  });
});

test('dirty 比較涵蓋所有固定欄位，不受物件參照與 key 順序影響', async () => {
  const { settingsEqual } = await loadModule();
  const same = structuredClone(defaultConfig);
  const changed = structuredClone(defaultConfig);
  changed.marquee.enabled = false;

  assert.equal(settingsEqual(defaultConfig, same), true);
  assert.equal(settingsEqual(defaultConfig, changed), false);
  assert.equal(settingsEqual(defaultConfig, null), false);
});
