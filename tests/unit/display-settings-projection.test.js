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

function createV10Config() {
  return {
    ...structuredClone(defaultConfig),
    configVersion: 10,
    logo: { enabled: false, path: null, sizePercent: 100 },
    standby: {
      backgroundMode: 'fixed',
      backgroundImagePaths: [],
      slideDurationSeconds: 10,
    },
    dateTime: { enabled: false, offsetSeconds: 0 },
    display: {
      ...defaultConfig.display,
      renderResolution: 'auto',
    },
  };
}

test('Display 設定只投影唯讀顯示欄位，不包含管理資訊與實體 Logo 路徑', () => {
  const config = createV10Config();
  config.logo = {
    enabled: true,
    path: 'logos/0123456789abcdef01234567.png',
    sizePercent: 150,
  };
  config.standby = {
    backgroundMode: 'slideshow',
    backgroundImagePaths: [
      'standby-backgrounds/fedcba987654321001234567.webp',
      'standby-backgrounds/0123456789abcdef01234567.png',
    ],
    slideDurationSeconds: 15,
  };
  config.appearance = {
    backgroundColor: '#102030',
    fontFamily: 'Noto Sans TC, sans-serif',
    fontColor: '#F4F5F6',
    messageBackgroundPreset: 'walnut',
    minimumFontSizeRem: 3.25,
    fontSizePercent: 125,
    lineSpacingPercent: 150,
    messageLiquidEffectEnabled: false,
    standbyClockSizePercent: 175,
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
    controlDisplayId: 7,
    defaultDisplayId: 42,
    fullscreen: false,
    renderResolution: '2560x1440',
  };

  const projected = createDisplaySettingsSnapshot(
    createManagerSnapshot(config, 7),
  );

  assert.deepEqual(projected, {
    configVersion: 10,
    logo: {
      enabled: true,
      url: 'displaycore://app/managed/logo/0123456789abcdef01234567.png',
      sizePercent: 150,
    },
    standby: {
      backgroundMode: 'slideshow',
      backgroundImageUrls: [
        'displaycore://app/managed/standby-background/fedcba987654321001234567.webp',
        'displaycore://app/managed/standby-background/0123456789abcdef01234567.png',
      ],
      slideDurationSeconds: 15,
    },
    appearance: {
      backgroundColor: '#102030',
      fontFamily: 'Noto Sans TC, sans-serif',
      fontColor: '#F4F5F6',
      messageBackgroundPreset: 'walnut',
      minimumFontSizeRem: 3.25,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
      messageLiquidEffectEnabled: false,
      standbyClockSizePercent: 175,
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
  assert.equal(
    Object.isFrozen(projected.standby.backgroundImageUrls),
    true,
  );
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
  assert.equal(Object.hasOwn(projected.display, 'controlDisplayId'), false);
  assert.equal(Object.hasOwn(projected.display, 'defaultDisplayId'), false);
  assert.equal(Object.hasOwn(projected.display, 'fullscreen'), false);
  assert.equal(Object.hasOwn(projected.logo, 'path'), false);
  assert.equal(Object.hasOwn(projected.standby, 'backgroundImagePaths'), false);
  assert.equal(JSON.stringify(projected).includes(config.logo.path), false);
  for (const backgroundImagePath of config.standby.backgroundImagePaths) {
    assert.equal(JSON.stringify(projected).includes(backgroundImagePath), false);
  }
});

test('停用 Logo 與未選待機背景時只發布空 URL 陣列', () => {
  const config = createV10Config();
  config.logo.path = 'logos/abcdefabcdefabcdefabcdef.webp';

  const projected = createDisplaySettingsSnapshot(
    createManagerSnapshot(config, 3),
  );

  assert.deepEqual(projected.logo, {
    enabled: false,
    url: null,
    sizePercent: 100,
  });
  assert.deepEqual(projected.standby, {
    backgroundMode: 'fixed',
    backgroundImageUrls: [],
    slideDurationSeconds: 10,
  });
  assert.equal(projected.appearance.messageLiquidEffectEnabled, true);
});

test('Display 投影完整保留管理員啟用或停用訊息倒酒效果的布林值', () => {
  for (const enabled of [true, false]) {
    const config = createV10Config();
    config.appearance.messageLiquidEffectEnabled = enabled;

    const projected = createDisplaySettingsSnapshot(
      createManagerSnapshot(config, enabled ? 4 : 5),
    );

    assert.equal(
      projected.appearance.messageLiquidEffectEnabled,
      enabled,
    );
  }
});

test('Display 投影拒絕缺少或非布林的訊息倒酒效果設定', () => {
  const missing = createV10Config();
  delete missing.appearance.messageLiquidEffectEnabled;

  for (const candidate of [missing, ...['true', 1, null].map((value) => {
    const config = createV10Config();
    config.appearance.messageLiquidEffectEnabled = value;
    return config;
  })]) {
    assert.throws(
      () => createDisplaySettingsSnapshot(createManagerSnapshot(candidate)),
      { name: 'TypeError', message: 'Display 設定 snapshot 格式不正確。' },
    );
  }
});

test('投影拒絕不合法 revision、設定內容與非受管理圖片識別', () => {
  for (const snapshot of [
    createManagerSnapshot(createV10Config(), -1),
    createManagerSnapshot(createV10Config(), Number.MAX_SAFE_INTEGER + 1),
    createManagerSnapshot({ ...createV10Config(), unknown: true }, 0),
    createManagerSnapshot(
      {
        ...createV10Config(),
        logo: {
          enabled: true,
          path: 'logos/operator-logo.png',
          sizePercent: 100,
        },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV10Config(),
        standby: {
          ...createV10Config().standby,
          backgroundImagePaths: ['C:\\private\\background.png'],
        },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV10Config(),
        standby: {
          ...createV10Config().standby,
          backgroundImagePaths: [
            'standby-backgrounds/operator-background.png',
          ],
        },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV10Config(),
        display: {
          ...createV10Config().display,
          renderResolution: '1280x720',
        },
      },
      0,
    ),
    createManagerSnapshot(
      {
        ...createV10Config(),
        playback: {
          ...createV10Config().playback,
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

test('投影拒絕超界、非 5% 步進與非整數 Logo 大小', () => {
  for (const sizePercent of [49, 1_001, 101, 100.5, '100']) {
    const config = createV10Config();
    config.logo.sizePercent = sizePercent;

    assert.throws(
      () => createDisplaySettingsSnapshot(createManagerSnapshot(config)),
      { name: 'TypeError', message: 'Display 設定 snapshot 格式不正確。' },
      String(sizePercent),
    );
  }
});

test('投影拒絕未知訊息背景與無效待機時間大小', () => {
  for (const appearancePatch of [
    { messageBackgroundPreset: 'gold' },
    { standbyClockSizePercent: 45 },
    { standbyClockSizePercent: 305 },
    { standbyClockSizePercent: 101 },
    { standbyClockSizePercent: '100' },
  ]) {
    const config = createV10Config();
    config.appearance = { ...config.appearance, ...appearancePatch };

    assert.throws(
      () => createDisplaySettingsSnapshot(createManagerSnapshot(config)),
      { name: 'TypeError', message: 'Display 設定 snapshot 格式不正確。' },
      JSON.stringify(appearancePatch),
    );
  }
});
