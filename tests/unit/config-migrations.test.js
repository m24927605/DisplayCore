'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');

function createLegacyConfig() {
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

test('合法 v1 設定保留舊值並由 v2 預設補上新增顯示欄位', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const result = migrateStoredConfig(createLegacyConfig(), defaultConfig);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
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
    dateTime: { enabled: true },
    marquee: { enabled: false },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
    },
  });
});

test('遷移拒絕畸形 v1、未知欄位與不是 canonical v2 的資料', () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const legacy = createLegacyConfig();

  for (const candidate of [
    { ...legacy, unexpected: true },
    { ...legacy, appearance: { ...legacy.appearance, unexpected: true } },
    { ...legacy, dateTime: { enabled: true } },
    { ...defaultConfig, configVersion: 99 },
  ]) {
    assert.equal(migrateStoredConfig(candidate, defaultConfig).ok, false);
  }
});
