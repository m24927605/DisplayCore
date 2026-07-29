'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const currentDefaultConfig = require('../../config.json');
const { validateConfig } = require('../../config/config-schema');

// Control Renderer 測試固定宣告完整 v10 契約，不依賴遷移測試的 fixture。
const defaultConfig = structuredClone({
  ...currentDefaultConfig,
  configVersion: 10,
  logo: {
    ...currentDefaultConfig.logo,
    sizePercent: 100,
  },
  appearance: {
    ...currentDefaultConfig.appearance,
    messageBackgroundPreset: 'obsidian',
    messageLiquidEffectEnabled: true,
    standbyClockSizePercent: 100,
  },
});

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

function createValidDraftInput(overrides = {}) {
  return {
    baseline: defaultConfig,
    logoEnabled: false,
    logoPath: null,
    logoSizePercent: '100',
    standbyBackgroundMode: 'fixed',
    standbyBackgroundImagePaths: [],
    standbySlideDurationSeconds: '10',
    backgroundColor: '#000000',
    messageBackgroundPreset: 'obsidian',
    fontFamily: defaultConfig.appearance.fontFamily,
    fontColor: '#FFFFFF',
    minimumFontSizeRem: '2.5',
    fontSizePercent: '100',
    standbyClockSizePercent: '100',
    lineSpacingPercent: '100',
    messageLiquidEffectEnabled: true,
    inspectionBackgroundColor: '#000000',
    releaseBackgroundColor: '#000000',
    dateTimeEnabled: true,
    dateTimeOffsetSeconds: 0,
    marqueeEnabled: true,
    pageDurationSeconds: '3',
    repeatMode: 'finite',
    roundCount: '1',
    controlDisplayId: 'auto',
    defaultDisplayId: 'auto',
    renderResolution: 'auto',
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
  assert.notEqual(result.snapshot.config.playback, source.config.playback);
  assert.notEqual(result.snapshot.config.standby, source.config.standby);
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.config), true);
  assert.equal(Object.isFrozen(result.snapshot.config.logo), true);
  assert.equal(Object.isFrozen(result.snapshot.config.appearance), true);
  assert.equal(Object.isFrozen(result.snapshot.config.playback), true);
  assert.equal(Object.isFrozen(result.snapshot.config.standby), true);
  assert.equal(
    Object.isFrozen(result.snapshot.config.standby.backgroundImagePaths),
    true,
  );
  assert.equal(Object.isFrozen(result.snapshot.defaults.standby), true);
  assert.equal(Object.isFrozen(result.snapshot.defaults.playback), true);
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
      config: { ...defaultConfig, configVersion: 8 },
    }),
    createSnapshot({
      config: {
        ...defaultConfig,
        playback: { ...defaultConfig.playback, unknown: true },
      },
    }),
    createSnapshot({
      config: {
        ...defaultConfig,
        playback: { ...defaultConfig.playback, pageDurationSeconds: 0 },
      },
    }),
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

test('設定草稿包含 Logo、外觀、播放與雙螢幕分工的完整 v10 設定', async () => {
  const { buildSettingsDraft } = await loadModule();
  const baseline = structuredClone(defaultConfig);
  baseline.display = {
    selectionMode: 'manual',
    controlDisplayId: 1,
    defaultDisplayId: 42,
    fullscreen: false,
    renderResolution: '1600x900',
  };

  const result = buildSettingsDraft({
    baseline,
    logoEnabled: true,
    logoPath: 'logos/0123456789abcdef01234567.png',
    logoSizePercent: '135',
    standbyBackgroundMode: 'slideshow',
    standbyBackgroundImagePaths: [
      'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
      'standby-backgrounds/0123456789abcdef01234567.png',
    ],
    standbySlideDurationSeconds: '8',
    backgroundColor: '#102a3c',
    messageBackgroundPreset: 'dark-marble',
    fontFamily: 'Arial, sans-serif',
    fontColor: '#f0e0d0',
    minimumFontSizeRem: '3.25',
    fontSizePercent: '125',
    standbyClockSizePercent: '185',
    lineSpacingPercent: '150',
    messageLiquidEffectEnabled: false,
    inspectionBackgroundColor: '#7f1d1d',
    releaseBackgroundColor: '#14532d',
    dateTimeEnabled: true,
    dateTimeOffsetSeconds: 3_661,
    marqueeEnabled: false,
    pageDurationSeconds: '7',
    repeatMode: 'continuous',
    roundCount: '23',
    controlDisplayId: '2',
    defaultDisplayId: '84',
    renderResolution: '3840x2160',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config, {
    configVersion: 10,
    logo: {
      enabled: true,
      path: 'logos/0123456789abcdef01234567.png',
      sizePercent: 135,
    },
    standby: {
      backgroundMode: 'slideshow',
      backgroundImagePaths: [
        'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
        'standby-backgrounds/0123456789abcdef01234567.png',
      ],
      slideDurationSeconds: 8,
    },
    appearance: {
      backgroundColor: '#102A3C',
      messageBackgroundPreset: 'dark-marble',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#F0E0D0',
      minimumFontSizeRem: 3.25,
      fontSizePercent: 125,
      standbyClockSizePercent: 185,
      lineSpacingPercent: 150,
      messageLiquidEffectEnabled: false,
    },
    dateTime: { enabled: true, offsetSeconds: 3_661 },
    emergency: {
      inspectionBackgroundColor: '#7F1D1D',
      releaseBackgroundColor: '#14532D',
    },
    marquee: { enabled: false },
    playback: {
      pageDurationSeconds: 7,
      repeatMode: 'continuous',
      roundCount: 23,
    },
    display: {
      selectionMode: 'manual',
      controlDisplayId: 2,
      defaultDisplayId: 84,
      fullscreen: false,
      renderResolution: '3840x2160',
    },
  });
  assert.equal(validateConfig(result.config).ok, true);
});

test('Renderer 草稿驗證與 Main schema 的主要邊界一致', async () => {
  const { buildSettingsDraft } = await loadModule();
  const validRaw = createValidDraftInput();
  const invalidPartials = [
    { logoEnabled: true, logoPath: null },
    { logoPath: 'C:\\logo.png' },
    { logoPath: 'logos/operator-logo.png' },
    { logoSizePercent: 100 },
    { logoSizePercent: '49' },
    { logoSizePercent: '1005' },
    { logoSizePercent: '101' },
    { logoSizePercent: '-50' },
    { logoSizePercent: '1e2' },
    { standbyBackgroundMode: 'carousel' },
    { standbyBackgroundImagePaths: null },
    { standbyBackgroundImagePaths: ['C:\\background.png'] },
    { standbyBackgroundImagePaths: ['logos/0123456789abcdef01234567.png'] },
    { standbyBackgroundImagePaths: ['standby-backgrounds/operator.png'] },
    { standbyBackgroundImagePaths: ['standby-backgrounds/../private.png'] },
    {
      standbyBackgroundImagePaths: Array.from(
        { length: 21 },
        (_, index) =>
          `standby-backgrounds/${index.toString(16).padStart(24, '0')}.png`,
      ),
    },
    { standbySlideDurationSeconds: '0' },
    { standbySlideDurationSeconds: '3601' },
    { standbySlideDurationSeconds: 10 },
    { backgroundColor: '#000' },
    { messageBackgroundPreset: 'blue-gradient' },
    { fontColor: 'white' },
    { fontFamily: '   ' },
    { minimumFontSizeRem: '2.6' },
    { minimumFontSizeRem: '1e2' },
    { minimumFontSizeRem: '0.75' },
    { minimumFontSizeRem: '12.25' },
    { fontSizePercent: '45' },
    { fontSizePercent: '101' },
    { standbyClockSizePercent: '45' },
    { standbyClockSizePercent: '305' },
    { standbyClockSizePercent: '101' },
    { standbyClockSizePercent: 100 },
    { messageLiquidEffectEnabled: 'true' },
    { messageLiquidEffectEnabled: 1 },
    { messageLiquidEffectEnabled: null },
    { lineSpacingPercent: '-5' },
    { lineSpacingPercent: '305' },
    { inspectionBackgroundColor: 'red' },
    { releaseBackgroundColor: '#00000080' },
    { dateTimeEnabled: 'true' },
    { dateTimeOffsetSeconds: -43_200 },
    { dateTimeOffsetSeconds: 43_201 },
    { dateTimeOffsetSeconds: 0.5 },
    { dateTimeOffsetSeconds: '0' },
    { marqueeEnabled: 1 },
    { pageDurationSeconds: 3 },
    { repeatMode: null },
    { roundCount: 1 },
    { controlDisplayId: 'display-1' },
    { defaultDisplayId: '-1' },
    { controlDisplayId: '1', defaultDisplayId: '1' },
    { renderResolution: '1024x768' },
    { renderResolution: null },
  ];

  for (const partial of invalidPartials) {
    const result = buildSettingsDraft({ ...validRaw, ...partial });
    assert.equal(result.ok, false, JSON.stringify(partial));
    assert.equal(typeof result.error.field, 'string');
  }
});

test('Logo 大小只接受 50% 至 1000% 且以 5% 遞增的十進位整數', async () => {
  const { buildSettingsDraft } = await loadModule();

  for (const logoSizePercent of ['50', '100', '200', '1000']) {
    const result = buildSettingsDraft(createValidDraftInput({
      logoSizePercent,
    }));

    assert.equal(result.ok, true, logoSizePercent);
    assert.equal(result.config.logo.sizePercent, Number(logoSizePercent));
  }

  for (const logoSizePercent of [
    '',
    '49',
    '1005',
    '101',
    '-50',
    '100.0',
    '1e2',
  ]) {
    const result = buildSettingsDraft(createValidDraftInput({
      logoSizePercent,
    }));

    assert.equal(result.ok, false, logoSizePercent);
    assert.equal(result.error.field, 'logo.sizePercent', logoSizePercent);
  }
});

test('訊息背景只接受五種固定預設，待機時間大小接受 50% 至 300%', async () => {
  const { buildSettingsDraft } = await loadModule();

  for (const messageBackgroundPreset of [
    'solid',
    'obsidian',
    'dark-marble',
    'walnut',
    'emerald-onyx',
  ]) {
    const result = buildSettingsDraft(createValidDraftInput({
      messageBackgroundPreset,
      standbyClockSizePercent: '300',
    }));

    assert.equal(result.ok, true, messageBackgroundPreset);
    assert.equal(
      result.config.appearance.messageBackgroundPreset,
      messageBackgroundPreset,
    );
    assert.equal(result.config.appearance.standbyClockSizePercent, 300);
  }

  for (const standbyClockSizePercent of ['49', '101', '305', '1e2']) {
    const result = buildSettingsDraft(createValidDraftInput({
      standbyClockSizePercent,
    }));
    assert.equal(result.ok, false, standbyClockSizePercent);
    assert.equal(
      result.error.field,
      'appearance.standbyClockSizePercent',
      standbyClockSizePercent,
    );
  }
});

test('訊息字體倒酒效果草稿預設開啟，且只接受明確 boolean 開關', async () => {
  const { buildSettingsDraft } = await loadModule();

  for (const messageLiquidEffectEnabled of [true, false]) {
    const result = buildSettingsDraft(createValidDraftInput({
      messageLiquidEffectEnabled,
    }));

    assert.equal(result.ok, true, String(messageLiquidEffectEnabled));
    assert.equal(
      result.config.appearance.messageLiquidEffectEnabled,
      messageLiquidEffectEnabled,
    );
  }

  assert.equal(
    createValidDraftInput().messageLiquidEffectEnabled,
    true,
    'Control 新草稿預設必須沿用 config.json 的啟用狀態',
  );

  for (const messageLiquidEffectEnabled of [undefined, null, 0, 1, 'true']) {
    const result = buildSettingsDraft(createValidDraftInput({
      messageLiquidEffectEnabled,
    }));

    assert.equal(result.ok, false, String(messageLiquidEffectEnabled));
    assert.equal(
      result.error.field,
      'appearance.messageLiquidEffectEnabled',
      String(messageLiquidEffectEnabled),
    );
  }
});

test('播放設定接受完整上下界，並以精確欄位拒絕超界與非十進位整數', async () => {
  const { buildSettingsDraft } = await loadModule();

  for (const [pageDurationSeconds, roundCount] of [
    ['1', '1'],
    ['3600', '999'],
  ]) {
    const result = buildSettingsDraft(createValidDraftInput({
      pageDurationSeconds,
      roundCount,
    }));

    assert.equal(result.ok, true);
    assert.equal(
      result.config.playback.pageDurationSeconds,
      Number(pageDurationSeconds),
    );
    assert.equal(result.config.playback.roundCount, Number(roundCount));
  }

  const invalidCases = [
    [{ pageDurationSeconds: '0' }, 'playback.pageDurationSeconds'],
    [{ pageDurationSeconds: '3601' }, 'playback.pageDurationSeconds'],
    [{ pageDurationSeconds: '-1' }, 'playback.pageDurationSeconds'],
    [{ pageDurationSeconds: '1.5' }, 'playback.pageDurationSeconds'],
    [{ pageDurationSeconds: '1e2' }, 'playback.pageDurationSeconds'],
    [{ repeatMode: 'loop' }, 'playback.repeatMode'],
    [{ roundCount: '0' }, 'playback.roundCount'],
    [{ roundCount: '1000' }, 'playback.roundCount'],
    [{ roundCount: '-1' }, 'playback.roundCount'],
    [{ roundCount: '1.5' }, 'playback.roundCount'],
    [{ roundCount: '1e2' }, 'playback.roundCount'],
  ];

  for (const [partial, expectedField] of invalidCases) {
    const result = buildSettingsDraft(createValidDraftInput(partial));
    assert.equal(result.ok, false, JSON.stringify(partial));
    assert.equal(result.error.field, expectedField, JSON.stringify(partial));
  }
});

test('管理員可明確交換控制台與訊息螢幕，或恢復自動分工', async () => {
  const { buildSettingsDraft } = await loadModule();
  const manual = buildSettingsDraft(createValidDraftInput({
    renderResolution: '2560x1440',
    controlDisplayId: '2',
    defaultDisplayId: '1',
  }));

  assert.equal(manual.ok, true);
  assert.deepEqual(manual.config.display, {
    selectionMode: 'manual',
    controlDisplayId: 2,
    defaultDisplayId: 1,
    fullscreen: true,
    renderResolution: '2560x1440',
  });

  const automatic = buildSettingsDraft(createValidDraftInput());
  assert.equal(automatic.ok, true);
  assert.deepEqual(automatic.config.display, {
    selectionMode: 'auto',
    controlDisplayId: null,
    defaultDisplayId: null,
    fullscreen: true,
    renderResolution: 'auto',
  });
});

test('dirty 比較涵蓋所有固定欄位，不受物件參照與 key 順序影響', async () => {
  const { settingsEqual } = await loadModule();
  const same = structuredClone(defaultConfig);
  const changed = structuredClone(defaultConfig);
  const changedTime = structuredClone(defaultConfig);
  const changedResolution = structuredClone(defaultConfig);
  const changedPageDuration = structuredClone(defaultConfig);
  const changedRepeatMode = structuredClone(defaultConfig);
  const changedRoundCount = structuredClone(defaultConfig);
  const changedStandbyBackground = structuredClone(defaultConfig);
  const changedLogoSize = structuredClone(defaultConfig);
  const changedMessageBackground = structuredClone(defaultConfig);
  const changedStandbyClockSize = structuredClone(defaultConfig);
  const changedMessageLiquidEffect = structuredClone(defaultConfig);
  changed.marquee.enabled = false;
  changedTime.dateTime.offsetSeconds = 1;
  changedResolution.display.renderResolution = '1920x1080';
  changedPageDuration.playback.pageDurationSeconds += 1;
  changedRepeatMode.playback.repeatMode = 'continuous';
  changedRoundCount.playback.roundCount += 1;
  changedStandbyBackground.standby.backgroundMode = 'slideshow';
  changedStandbyBackground.standby.backgroundImagePaths = [
    'standby-backgrounds/0123456789abcdef01234567.png',
  ];
  changedLogoSize.logo.sizePercent = 125;
  changedMessageBackground.appearance.messageBackgroundPreset = 'walnut';
  changedStandbyClockSize.appearance.standbyClockSizePercent = 150;
  changedMessageLiquidEffect.appearance.messageLiquidEffectEnabled = false;

  assert.equal(settingsEqual(defaultConfig, same), true);
  assert.equal(settingsEqual(defaultConfig, changed), false);
  assert.equal(settingsEqual(defaultConfig, changedTime), false);
  assert.equal(settingsEqual(defaultConfig, changedResolution), false);
  assert.equal(settingsEqual(defaultConfig, changedPageDuration), false);
  assert.equal(settingsEqual(defaultConfig, changedRepeatMode), false);
  assert.equal(settingsEqual(defaultConfig, changedRoundCount), false);
  assert.equal(settingsEqual(defaultConfig, changedStandbyBackground), false);
  assert.equal(settingsEqual(defaultConfig, changedLogoSize), false);
  assert.equal(settingsEqual(defaultConfig, changedMessageBackground), false);
  assert.equal(settingsEqual(defaultConfig, changedStandbyClockSize), false);
  assert.equal(settingsEqual(defaultConfig, changedMessageLiquidEffect), false);
  assert.equal(settingsEqual(defaultConfig, null), false);
});
