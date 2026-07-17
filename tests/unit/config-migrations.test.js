'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');
const DEFAULT_STANDBY = Object.freeze({ backgroundImagePath: null });
const DEFAULT_LOGO_SIZE_PERCENT = 100;

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

function createV4Config() {
  return {
    configVersion: 4,
    logo: {
      enabled: true,
      path: 'logos/0123456789abcdef01234567.png',
    },
    appearance: {
      backgroundColor: '#456def',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#cba987',
      minimumFontSizeRem: 4,
      fontSizePercent: 135,
      lineSpacingPercent: 160,
    },
    dateTime: { enabled: false, offsetSeconds: -3_661 },
    emergency: {
      inspectionBackgroundColor: '#5f1b1b',
      releaseBackgroundColor: '#12512b',
    },
    marquee: { enabled: true },
    playback: {
      pageDurationSeconds: 9,
      repeatMode: 'continuous',
      roundCount: 23,
    },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 84,
      fullscreen: false,
      renderResolution: '3840x2160',
    },
  };
}

function createV5Config() {
  return {
    ...createV4Config(),
    configVersion: 5,
    standby: {
      backgroundImagePath:
        'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
    },
  };
}

test('合法 v1 設定保留舊值並由 v6 預設補上新欄位', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(createV1Config(), defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 6);
  assert.deepEqual(result.value, {
    ...defaultConfig,
    logo: {
      enabled: false,
      path: null,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
    appearance: {
      ...defaultConfig.appearance,
      backgroundColor: '#123ABC',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#FEDCBA',
      minimumFontSizeRem: 3.25,
    },
    dateTime: { enabled: true, offsetSeconds: 0 },
    marquee: { enabled: false },
    standby: DEFAULT_STANDBY,
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
      renderResolution: 'auto',
    },
  });
});

test('合法 v2 設定嚴格遷移為 v6，保留舊值並只補上新欄位', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(createV2Config(), defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...defaultConfig,
    logo: {
      enabled: false,
      path: null,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
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
    standby: DEFAULT_STANDBY,
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
      renderResolution: 'auto',
    },
  });
});

test('合法 v3 設定嚴格遷移為 v6，只補上預設播放、待機與 Logo 尺寸', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV3Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 6,
    logo: {
      ...legacy.logo,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
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
    standby: DEFAULT_STANDBY,
  });
});

test('合法 v4 設定嚴格遷移為 v6，保留所有舊值並補待機與 Logo 尺寸', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV4Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 6,
    logo: {
      ...legacy.logo,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
    appearance: {
      ...legacy.appearance,
      backgroundColor: '#456DEF',
      fontColor: '#CBA987',
    },
    emergency: {
      inspectionBackgroundColor: '#5F1B1B',
      releaseBackgroundColor: '#12512B',
    },
    standby: { backgroundImagePath: null },
  });
  assert.deepEqual(result.value.playback, legacy.playback);
  assert.equal(Object.isFrozen(result.value.standby), true);
});

test('合法 v5 設定嚴格遷移為 v6，只補上預設 Logo 尺寸', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV5Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 6,
    logo: {
      ...legacy.logo,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
    appearance: {
      ...legacy.appearance,
      backgroundColor: '#456DEF',
      fontColor: '#CBA987',
    },
    emergency: {
      inspectionBackgroundColor: '#5F1B1B',
      releaseBackgroundColor: '#12512B',
    },
  });
  assert.equal(Object.isFrozen(result.value.logo), true);
});

test('canonical v6 設定不會被誤判為遷移資料', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(defaultConfig, defaultConfig);

  assert.equal(defaultConfig.configVersion, 6);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.value, defaultConfig);
});

test('遷移拒絕畸形 v1／v2／v3／v4／v5、未知欄位與未知版本', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const v1 = createV1Config();
  const v2 = createV2Config();
  const v3 = createV3Config();
  const v4 = createV4Config();
  const v5 = createV5Config();

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
    { ...v3, logo: { ...v3.logo, sizePercent: 100 } },
    { ...v3, display: { ...v3.display, unexpected: true } },
    { ...v4, unexpected: true },
    { ...v4, standby: { backgroundImagePath: null } },
    { ...v4, logo: { ...v4.logo, sizePercent: 100 } },
    { ...v4, playback: { ...v4.playback, unexpected: true } },
    { ...v4, configVersion: 5 },
    { ...v5, logo: { ...v5.logo, sizePercent: 100 } },
    { ...v5, standby: { ...v5.standby, unexpected: true } },
    { ...v5, configVersion: 6 },
    { ...defaultConfig, configVersion: 99 },
  ]) {
    assert.equal(migrateStoredConfig(candidate, defaultConfig).ok, false);
  }
});
