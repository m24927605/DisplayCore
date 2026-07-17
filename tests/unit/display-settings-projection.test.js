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

function createV5Config() {
  return {
    ...structuredClone(defaultConfig),
    configVersion: 5,
    standby: { backgroundImagePath: null },
    dateTime: { enabled: false, offsetSeconds: 0 },
    display: {
      ...defaultConfig.display,
      renderResolution: 'auto',
    },
  };
}

test('Display 設定只投影唯讀顯示欄位，不包含管理資訊與實體 Logo 路徑', () => {
  const config = createV5Config();
  config.logo = {
    enabled: true,
    path: 'logos/0123456789abcdef01234567.png',
  };
  config.standby = {
    backgroundImagePath:
      'standby-backgrounds/fedcba987654321001234567.webp',
  };
  config.appearance = {
    backgroundColor: '#102030',
    fontFamily: 'Noto Sans TC, sans-serif',
    fontColor: '#F4F5F6',
    minimumFontSizeRem: 3.25,
    fontSizePercent: 125,
    lineSpacingPercent: 150,
  };
  config.dateTime = { enabled: true, offsetSeconds: -3661 };
  config.emergency = {
    inspectionBackgroundColor: '#7F1D1D',
    releaseBackgroundColor: '#14532D',
  };
  config.marquee = { enabled: false };
  config.playback = {
    pageDurationSeconds: 8,
    repeatMode: 'continuous',
    roundCount: 7,
  };
  config.display = {
    selectionMode: 'manual',
    defaultDisplayId: 42,
    fullscreen: false,
    renderResolution: '2560x1440',
  };

  const projected = createDisplaySettingsSnapshot(
    createManagerSnapshot(config, 7),
  );

  assert.deepEqual(projected, {
    configVersion: 5,
    logo: {
      enabled: true,
      url: 'displaycore://app/managed/logo/0123456789abcdef01234567.png',
    },
    standby: {
      backgroundImageUrl:
        'displaycore://app/managed/standby-background/fedcba987654321001234567.webp',
    },
    appearance: {
      backgroundColor: '#102030',
      fontFamily: 'Noto Sans TC, sans-serif',
      fontColor: '#F4F5F6',
      minimumFontSizeRem: 3.25,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
    },
    dateTime: { enabled: true, offsetSeconds: -3661 },
    emergency: {
      inspectionBackgroundColor: '#7F1D1D',
      releaseBackgroundColor: '#14532D',
    },
    marquee: { enabled: false },
    display: { renderResolution: '2560x1440' },
    revision: 7,
  });
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.logo), true);
  assert.equal(Object.isFrozen(projected.standby), true);
  assert.equal(Object.isFrozen(projected.appearance), true);
  assert.equal(Object.isFrozen(projected.dateTime), true);
  assert.equal(Object.isFrozen(projected.emergency), true);
  assert.equal(Object.isFrozen(projected.marquee), true);
  assert.equal(Object.isFrozen(projected.display), true);
  assert.equal(Object.hasOwn(projected, 'defaults'), false);
  assert.equal(Object.hasOwn(projected, 'notice'), false);
  assert.equal(Object.hasOwn(projected, 'playback'), false);
  assert.deepEqual(Object.keys(projected.display), ['renderResolution']);
  assert.equal(Object.hasOwn(projected.display, 'selectionMode'), false);
  assert.equal(Object.hasOwn(projected.display, 'defaultDisplayId'), false);
  assert.equal(Object.hasOwn(projected.display, 'fullscreen'), false);
  assert.equal(Object.hasOwn(projected.logo, 'path'), false);
  assert.equal(Object.hasOwn(projected.standby, 'backgroundImagePath'), false);
  assert.equal(JSON.stringify(projected).includes(config.logo.path), false);
  assert.equal(
    JSON.stringify(projected).includes(config.standby.backgroundImagePath),
    false,
  );
});

test('停用 Logo 與未選待機背景時只發布 null URL', () => {
  const config = createV5Config();
  config.logo.path = 'logos/abcdefabcdefabcdefabcdef.webp';

  const projected = createDisplaySettingsSnapshot(
    createManagerSnapshot(config, 3),
  );

  assert.deepEqual(projected.logo, { enabled: false, url: null });
  assert.deepEqual(projected.standby, { backgroundImageUrl: null });
});

test('投影拒絕不合法 revision、設定內容與非受管理圖片識別', () => {
  for (const snapshot of [
    createManagerSnapshot(createV5Config(), -1),
    createManagerSnapshot(createV5Config(), Number.MAX_SAFE_INTEGER + 1),
    createManagerSnapshot({ ...createV5Config(), unknown: true }, 0),
    createManagerSnapshot(
      {
        ...createV5Config(),
        logo: { enabled: true, path: 'logos/operator-logo.png' },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV5Config(),
        standby: { backgroundImagePath: 'C:\\private\\background.png' },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV5Config(),
        standby: {
          backgroundImagePath:
            'standby-backgrounds/operator-background.png',
        },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV5Config(),
        display: {
          ...createV5Config().display,
          renderResolution: '1280x720',
        },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV5Config(),
        playback: {
          ...createV5Config().playback,
          pageDurationSeconds: 0,
        },
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
