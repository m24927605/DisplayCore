'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');
const {
  createDisplaySettingsSnapshot,
} = require('../../ipc/display-settings');

function createManagerSnapshot(config = structuredClone(defaultConfig), revision = 0) {
  return {
    config,
    defaults: defaultConfig,
    revision,
    notice: { code: 'CONFIG_RECOVERED', message: '不應傳給 Display。' },
  };
}

test('Display 設定只投影唯讀顯示欄位，不包含管理資訊與實體 Logo 路徑', () => {
  const config = structuredClone(defaultConfig);
  config.logo = {
    enabled: true,
    path: 'logos/0123456789abcdef01234567.png',
  };
  config.appearance = {
    backgroundColor: '#102030',
    fontFamily: 'Noto Sans TC, sans-serif',
    fontColor: '#F4F5F6',
    minimumFontSizeRem: 3.25,
  };
  config.dateTime = { enabled: true, locale: 'zh-TW', hour12: true };
  config.marquee = { enabled: false };
  config.display = {
    selectionMode: 'manual',
    defaultDisplayId: 42,
    fullscreen: false,
  };

  const projected = createDisplaySettingsSnapshot(
    createManagerSnapshot(config, 7),
  );

  assert.deepEqual(projected, {
    configVersion: 1,
    logo: {
      enabled: true,
      url: 'displaycore://app/managed/logo/0123456789abcdef01234567.png',
    },
    appearance: {
      backgroundColor: '#102030',
      fontFamily: 'Noto Sans TC, sans-serif',
      fontColor: '#F4F5F6',
      minimumFontSizeRem: 3.25,
    },
    dateTime: { enabled: true, locale: 'zh-TW', hour12: true },
    marquee: { enabled: false },
    revision: 7,
  });
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.logo), true);
  assert.equal(Object.isFrozen(projected.appearance), true);
  assert.equal(Object.isFrozen(projected.dateTime), true);
  assert.equal(Object.isFrozen(projected.marquee), true);
  assert.equal(Object.hasOwn(projected, 'defaults'), false);
  assert.equal(Object.hasOwn(projected, 'notice'), false);
  assert.equal(Object.hasOwn(projected, 'display'), false);
  assert.equal(Object.hasOwn(projected.logo, 'path'), false);
  assert.equal(JSON.stringify(projected).includes(config.logo.path), false);
});

test('停用 Logo 時只發布 null URL，即使設定仍保留受管理識別', () => {
  const config = structuredClone(defaultConfig);
  config.logo.path = 'logos/abcdefabcdefabcdefabcdef.webp';

  const projected = createDisplaySettingsSnapshot(
    createManagerSnapshot(config, 3),
  );

  assert.deepEqual(projected.logo, { enabled: false, url: null });
});

test('投影拒絕不合法 revision、設定內容與非雜湊 Logo 識別', () => {
  for (const snapshot of [
    createManagerSnapshot(defaultConfig, -1),
    createManagerSnapshot(defaultConfig, Number.MAX_SAFE_INTEGER + 1),
    createManagerSnapshot({ ...defaultConfig, unknown: true }, 0),
    createManagerSnapshot(
      {
        ...defaultConfig,
        logo: { enabled: true, path: 'logos/operator-logo.png' },
      },
      0,
    ),
  ]) {
    assert.throws(
      () => createDisplaySettingsSnapshot(snapshot),
      { name: 'TypeError', message: 'Display 設定 snapshot 格式不正確。' },
    );
  }
});
