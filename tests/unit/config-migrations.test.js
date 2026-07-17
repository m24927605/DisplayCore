'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');

function createV1Config() {
  return {
    configVersion: 1,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#123abc',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#fedcba',
      minimumFontSizeRem: 3.25,
    },
    dateTime: { enabled: true, locale: 'zh-TW', hour12: true },
    marquee: { enabled: false },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
    },
  };
}

function createV2Config() {
  return {
    configVersion: 2,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#234bcd',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#edcb98',
      minimumFontSizeRem: 3.5,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
    },
    dateTime: { enabled: false },
    emergency: {
      inspectionBackgroundColor: '#7f1d1d',
      releaseBackgroundColor: '#14532d',
    },
    marquee: { enabled: true },
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
    },
  };
}

function createV3Config() {
  return {
    configVersion: 3,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#345cde',
      fontFamily: 'Noto Sans TC, sans-serif',
      fontColor: '#dcba87',
      minimumFontSizeRem: 3.75,
      fontSizePercent: 130,
      lineSpacingPercent: 155,
    },
    dateTime: { enabled: true, offsetSeconds: 3_661 },
    emergency: {
      inspectionBackgroundColor: '#6f1c1c',
      releaseBackgroundColor: '#13522c',
    },
    marquee: { enabled: false },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
      renderResolution: '2560x1440',
    },
  };
}

test('合法 v1 設定保留舊值並由 v4 預設補上新欄位', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(createV1Config(), defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 4);
  assert.deepEqual(result.value, {
    ...defaultConfig,
    logo: { enabled: false, path: null },
    appearance: {
      ...defaultConfig.appearance,
      backgroundColor: '#123ABC',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#FEDCBA',
      minimumFontSizeRem: 3.25,
    },
    dateTime: { enabled: true, offsetSeconds: 0 },
    marquee: { enabled: false },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
      renderResolution: 'auto',
    },
  });
});

test('合法 v2 設定嚴格遷移為 v4，保留舊值並只補上新欄位', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(createV2Config(), defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...defaultConfig,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#234BCD',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#EDCB98',
      minimumFontSizeRem: 3.5,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
    },
    dateTime: { enabled: false, offsetSeconds: 0 },
    emergency: {
      inspectionBackgroundColor: '#7F1D1D',
      releaseBackgroundColor: '#14532D',
    },
    marquee: { enabled: true },
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
      renderResolution: 'auto',
    },
  });
});

test('合法 v3 設定嚴格遷移為 v4，只補上預設播放設定', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV3Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 4,
    appearance: {
      ...legacy.appearance,
      backgroundColor: '#345CDE',
      fontColor: '#DCBA87',
    },
    emergency: {
      inspectionBackgroundColor: '#6F1C1C',
      releaseBackgroundColor: '#13522C',
    },
    playback: defaultConfig.playback,
  });
});

test('canonical v4 設定不會被誤判為遷移資料', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(defaultConfig, defaultConfig);

  assert.equal(defaultConfig.configVersion, 4);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.value, defaultConfig);
});

test('遷移拒絕畸形 v1／v2／v3、未知欄位與未知版本', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const v1 = createV1Config();
  const v2 = createV2Config();
  const v3 = createV3Config();

  for (const candidate of [
    { ...v1, unexpected: true },
    { ...v1, appearance: { ...v1.appearance, unexpected: true } },
    { ...v1, dateTime: { enabled: true } },
    { ...v2, unexpected: true },
    { ...v2, dateTime: { enabled: false, offsetSeconds: 0 } },
    { ...v2, display: { ...v2.display, renderResolution: 'auto' } },
    { ...v2, emergency: { inspectionBackgroundColor: '#000000' } },
    { ...v3, unexpected: true },
    { ...v3, playback: defaultConfig.playback },
    { ...v3, display: { ...v3.display, unexpected: true } },
    { ...defaultConfig, configVersion: 99 },
  ]) {
    assert.equal(migrateStoredConfig(candidate, defaultConfig).ok, false);
  }
});
