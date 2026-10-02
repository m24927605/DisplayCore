'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');
const DEFAULT_STANDBY = Object.freeze({
  backgroundMode: 'fixed',
  backgroundImagePaths: Object.freeze([]),
  slideDurationSeconds: 10,
  sandEffectEnabled: true,
});
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

function createV6Config() {
  const legacy = createV5Config();

  return {
    ...legacy,
    configVersion: 6,
    logo: {
      ...legacy.logo,
      sizePercent: 175,
    },
  };
}

function createV7Config() {
  return {
    configVersion: 7,
    logo: {
      enabled: false,
      path: null,
      sizePercent: 275,
    },
    standby: {
      backgroundMode: 'slideshow',
      backgroundImagePaths: [
        'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
      ],
      slideDurationSeconds: 12,
    },
    appearance: {
      backgroundColor: '#102030',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#f0e0d0',
      minimumFontSizeRem: 4.25,
      fontSizePercent: 175,
      lineSpacingPercent: 125,
    },
    dateTime: { enabled: true, offsetSeconds: 123 },
    emergency: {
      inspectionBackgroundColor: '#520000',
      releaseBackgroundColor: '#004220',
    },
    marquee: { enabled: false },
    playback: {
      pageDurationSeconds: 8,
      repeatMode: 'finite',
      roundCount: 4,
    },
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
      renderResolution: '1920x1080',
    },
  };
}

/** v8 已具備材質背景與待機時間大小，但還沒有訊息字體倒酒開關。 */
function createV8Config() {
  const legacy = structuredClone(defaultConfig);
  legacy.configVersion = 8;
  legacy.appearance.backgroundColor = '#203040';
  legacy.appearance.fontColor = '#E0D0C0';
  legacy.appearance.messageBackgroundPreset = 'walnut';
  legacy.appearance.standbyClockSizePercent = 185;
  legacy.playback.pageDurationSeconds = 11;
  delete legacy.appearance.messageLiquidEffectEnabled;
  delete legacy.standby.sandEffectEnabled;
  delete legacy.display.controlDisplayId;
  return legacy;
}

/** v9 已具備倒酒開關，但仍只有單一訊息輸出螢幕欄位。 */
function createV9Config() {
  const legacy = structuredClone(defaultConfig);
  legacy.configVersion = 9;
  delete legacy.standby.sandEffectEnabled;
  legacy.display = {
    selectionMode: 'manual',
    defaultDisplayId: 84,
    fullscreen: false,
    renderResolution: '1600x900',
  };
  return legacy;
}

/** v10 已具備雙螢幕與倒酒開關，但還沒有待機風吹沙開關。 */
function createV10Config() {
  const legacy = structuredClone(defaultConfig);
  legacy.configVersion = 10;
  delete legacy.standby.sandEffectEnabled;
  return legacy;
}

test('canonical v8 嚴格遷移為 v11，補特效開關並安全改用自動螢幕分工', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV8Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(defaultConfig.configVersion, 11);
  assert.equal(defaultConfig.appearance.messageLiquidEffectEnabled, true);
  assert.equal(defaultConfig.standby.sandEffectEnabled, true);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 11,
    standby: {
      ...legacy.standby,
      sandEffectEnabled: true,
    },
    appearance: {
      ...legacy.appearance,
      messageLiquidEffectEnabled: true,
    },
    display: {
      ...defaultConfig.display,
      renderResolution: legacy.display.renderResolution,
    },
  });
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.appearance), true);
});

test('canonical v7 外觀嚴格遷移為 v11 並維持原有純色視覺比例', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV7Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 11);
  assert.deepEqual(result.value.standby, {
    ...legacy.standby,
    sandEffectEnabled: true,
  });
  assert.deepEqual(result.value.appearance, {
    ...legacy.appearance,
    backgroundColor: '#102030',
    fontColor: '#F0E0D0',
    messageBackgroundPreset: 'solid',
    messageLiquidEffectEnabled: true,
    standbyClockSizePercent: legacy.appearance.fontSizePercent,
  });
  assert.equal(Object.isFrozen(result.value.appearance), true);
});

test('合法 v1 設定保留舊值並由 v11 預設補上新欄位', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(createV1Config(), defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 11);
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
      messageBackgroundPreset: 'solid',
      standbyClockSizePercent: 100,
    },
    dateTime: { enabled: true, offsetSeconds: 0 },
    marquee: { enabled: false },
    standby: DEFAULT_STANDBY,
    display: defaultConfig.display,
  });
});

test('合法 v2 設定嚴格遷移為 v11，保留舊值並只補上新欄位', () => {
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
      messageBackgroundPreset: 'solid',
      messageLiquidEffectEnabled: true,
      standbyClockSizePercent: 125,
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
      controlDisplayId: null,
      defaultDisplayId: null,
      fullscreen: true,
      renderResolution: 'auto',
    },
  });
});

test('合法 v3 設定嚴格遷移為 v11，只補預設欄位並安全改用自動螢幕分工', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV3Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 11,
    logo: {
      ...legacy.logo,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
    appearance: {
      ...legacy.appearance,
      backgroundColor: '#345CDE',
      fontColor: '#DCBA87',
      messageBackgroundPreset: 'solid',
      messageLiquidEffectEnabled: true,
      standbyClockSizePercent: legacy.appearance.fontSizePercent,
    },
    emergency: {
      inspectionBackgroundColor: '#6F1C1C',
      releaseBackgroundColor: '#13522C',
    },
    playback: defaultConfig.playback,
    standby: DEFAULT_STANDBY,
    display: {
      ...defaultConfig.display,
      renderResolution: legacy.display.renderResolution,
    },
  });
});

test('合法 v4 設定嚴格遷移為 v11，保留舊值並安全改用自動螢幕分工', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV4Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 11,
    logo: {
      ...legacy.logo,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
    appearance: {
      ...legacy.appearance,
      backgroundColor: '#456DEF',
      fontColor: '#CBA987',
      messageBackgroundPreset: 'solid',
      messageLiquidEffectEnabled: true,
      standbyClockSizePercent: legacy.appearance.fontSizePercent,
    },
    emergency: {
      inspectionBackgroundColor: '#5F1B1B',
      releaseBackgroundColor: '#12512B',
    },
    standby: DEFAULT_STANDBY,
    display: {
      ...defaultConfig.display,
      renderResolution: legacy.display.renderResolution,
    },
  });
  assert.deepEqual(result.value.playback, legacy.playback);
  assert.equal(Object.isFrozen(result.value.standby), true);
});

test('合法 v5 設定嚴格遷移為 v11，保留背景並安全改用自動螢幕分工', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV5Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 11,
    logo: {
      ...legacy.logo,
      sizePercent: DEFAULT_LOGO_SIZE_PERCENT,
    },
    appearance: {
      ...legacy.appearance,
      backgroundColor: '#456DEF',
      fontColor: '#CBA987',
      messageBackgroundPreset: 'solid',
      messageLiquidEffectEnabled: true,
      standbyClockSizePercent: legacy.appearance.fontSizePercent,
    },
    emergency: {
      inspectionBackgroundColor: '#5F1B1B',
      releaseBackgroundColor: '#12512B',
    },
    standby: {
      backgroundMode: 'fixed',
      backgroundImagePaths: [legacy.standby.backgroundImagePath],
      slideDurationSeconds: 10,
      sandEffectEnabled: true,
    },
    display: {
      ...defaultConfig.display,
      renderResolution: legacy.display.renderResolution,
    },
  });
  assert.equal(Object.isFrozen(result.value.logo), true);
  assert.equal(
    Object.isFrozen(result.value.standby.backgroundImagePaths),
    true,
  );
});

test('合法 v6 設定嚴格遷移為 v11，保留 Logo 尺寸與單張背景', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV6Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 11);
  assert.equal(result.value.logo.sizePercent, 175);
  assert.equal(result.value.appearance.messageBackgroundPreset, 'solid');
  assert.equal(result.value.appearance.messageLiquidEffectEnabled, true);
  assert.equal(
    result.value.appearance.standbyClockSizePercent,
    legacy.appearance.fontSizePercent,
  );
  assert.deepEqual(result.value.standby, {
    backgroundMode: 'fixed',
    backgroundImagePaths: [legacy.standby.backgroundImagePath],
    slideDurationSeconds: 10,
    sandEffectEnabled: true,
  });
  assert.deepEqual(result.value.display, {
    ...defaultConfig.display,
    renderResolution: legacy.display.renderResolution,
  });
});

test('canonical v9 嚴格遷移為 v11，保留解析度並安全改用自動螢幕分工', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV9Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 11);
  assert.deepEqual(result.value.standby, {
    ...legacy.standby,
    sandEffectEnabled: true,
  });
  assert.deepEqual(result.value.display, {
    ...defaultConfig.display,
    renderResolution: legacy.display.renderResolution,
  });
  assert.equal(Object.isFrozen(result.value.display), true);
});

test('canonical v10 缺少風吹沙開關時嚴格遷移為 v11 並補 true', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createV10Config();
  const result = migrateStoredConfig(legacy, defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.deepEqual(result.value, {
    ...legacy,
    configVersion: 11,
    standby: {
      ...legacy.standby,
      sandEffectEnabled: true,
    },
  });
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.standby), true);
});

test('canonical v11 設定不會被誤判為遷移資料', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(defaultConfig, defaultConfig);

  assert.equal(defaultConfig.configVersion, 11);
  assert.equal(result.ok, true);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.value, defaultConfig);
});

test('遷移拒絕畸形 v1 至 v10、未知欄位與未知版本', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const v1 = createV1Config();
  const v2 = createV2Config();
  const v3 = createV3Config();
  const v4 = createV4Config();
  const v5 = createV5Config();
  const v6 = createV6Config();
  const v7 = createV7Config();
  const v8 = createV8Config();
  const v9 = createV9Config();
  const v10 = createV10Config();

  const invalidCandidates = [
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
    {
      ...v3,
      display: { ...v3.display, renderResolution: '1024x768' },
    },
    { ...v4, unexpected: true },
    { ...v4, standby: { backgroundImagePath: null } },
    { ...v4, logo: { ...v4.logo, sizePercent: 100 } },
    { ...v4, playback: { ...v4.playback, unexpected: true } },
    { ...v4, configVersion: 5 },
    { ...v5, logo: { ...v5.logo, sizePercent: 100 } },
    { ...v5, standby: { ...v5.standby, unexpected: true } },
    { ...v5, configVersion: 6 },
    { ...v6, unexpected: true },
    { ...v6, logo: { ...v6.logo, unexpected: true } },
    {
      ...v6,
      appearance: { ...v6.appearance, messageBackgroundPreset: 'solid' },
    },
    { ...v6, standby: { ...v6.standby, unexpected: true } },
    { ...v6, standby: { backgroundImagePath: '/tmp/background.png' } },
    { ...v6, configVersion: 7 },
    { ...v7, unexpected: true },
    { ...v7, appearance: { ...v7.appearance, unexpected: true } },
    { ...v7, appearance: { ...v7.appearance, fontSizePercent: 101 } },
    { ...v7, configVersion: 8 },
    { ...v8, unexpected: true },
    { ...v8, appearance: { ...v8.appearance, unexpected: true } },
    {
      ...v8,
      appearance: { ...v8.appearance, messageLiquidEffectEnabled: true },
    },
    { ...v8, configVersion: 9 },
    { ...v9, unexpected: true },
    {
      ...v9,
      display: { ...v9.display, renderResolution: '1024x768' },
    },
    { ...v9, configVersion: 10 },
    { ...v10, unexpected: true },
    {
      ...v10,
      standby: { ...v10.standby, sandEffectEnabled: true },
    },
    { ...v10, configVersion: 11 },
    { ...defaultConfig, configVersion: 99 },
  ];

  for (const [index, candidate] of invalidCandidates.entries()) {
    assert.equal(
      migrateStoredConfig(candidate, defaultConfig).ok,
      false,
      `invalidCandidates[${index}] 不應通過遷移`,
    );
  }
});
