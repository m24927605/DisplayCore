'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const currentDefaultConfig = require('../../config.json');
const { validateConfig } = require('../../config/config-schema');

const defaultConfig = structuredClone(currentDefaultConfig);

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
    backgroundColor: '#000000',
    fontFamily: defaultConfig.appearance.fontFamily,
    fontColor: '#FFFFFF',
    minimumFontSizeRem: '2.5',
    fontSizePercent: '100',
    lineSpacingPercent: '100',
    inspectionBackgroundColor: '#000000',
    releaseBackgroundColor: '#000000',
    dateTimeEnabled: true,
    dateTimeOffsetSeconds: 0,
    marqueeEnabled: true,
    pageDurationSeconds: '3',
    repeatMode: 'finite',
    roundCount: '1',
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
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.config), true);
  assert.equal(Object.isFrozen(result.snapshot.config.appearance), true);
  assert.equal(Object.isFrozen(result.snapshot.config.playback), true);
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
      config: { ...defaultConfig, configVersion: 3 },
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

test('設定草稿包含 playback v4、顯示外觀、校時及解析度，並保留相容輸出欄位', async () => {
  const { buildSettingsDraft } = await loadModule();
  const baseline = structuredClone(defaultConfig);
  baseline.display = {
    selectionMode: 'manual',
    defaultDisplayId: 42,
    fullscreen: false,
    renderResolution: '1600x900',
  };

  const result = buildSettingsDraft({
    baseline,
    logoEnabled: true,
    logoPath: 'logos/0123456789abcdef01234567.png',
    backgroundColor: '#102a3c',
    fontFamily: 'Arial, sans-serif',
    fontColor: '#f0e0d0',
    minimumFontSizeRem: '3.25',
    fontSizePercent: '125',
    lineSpacingPercent: '150',
    inspectionBackgroundColor: '#7f1d1d',
    releaseBackgroundColor: '#14532d',
    dateTimeEnabled: true,
    dateTimeOffsetSeconds: 3_661,
    marqueeEnabled: false,
    pageDurationSeconds: '7',
    repeatMode: 'continuous',
    roundCount: '23',
    renderResolution: '3840x2160',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config, {
    configVersion: 4,
    logo: {
      enabled: true,
      path: 'logos/0123456789abcdef01234567.png',
    },
    appearance: {
      backgroundColor: '#102A3C',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#F0E0D0',
      minimumFontSizeRem: 3.25,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
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
      defaultDisplayId: 42,
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
    { backgroundColor: '#000' },
    { fontColor: 'white' },
    { fontFamily: '   ' },
    { minimumFontSizeRem: '2.6' },
    { minimumFontSizeRem: '1e2' },
    { minimumFontSizeRem: '0.75' },
    { minimumFontSizeRem: '12.25' },
    { fontSizePercent: '45' },
    { fontSizePercent: '101' },
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
    { renderResolution: '1024x768' },
    { renderResolution: null },
  ];

  for (const partial of invalidPartials) {
    const result = buildSettingsDraft({ ...validRaw, ...partial });
    assert.equal(result.ok, false, JSON.stringify(partial));
    assert.equal(typeof result.error.field, 'string');
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

test('解析度可編輯，但已移除的螢幕選擇參數無法改變相容欄位', async () => {
  const { buildSettingsDraft } = await loadModule();
  const result = buildSettingsDraft(createValidDraftInput({
    renderResolution: '2560x1440',
    displaySelectionMode: 'manual',
    defaultDisplayId: '42',
    displayFullscreen: false,
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.config.display, {
    selectionMode: 'auto',
    defaultDisplayId: null,
    fullscreen: true,
    renderResolution: '2560x1440',
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
  changed.marquee.enabled = false;
  changedTime.dateTime.offsetSeconds = 1;
  changedResolution.display.renderResolution = '1920x1080';
  changedPageDuration.playback.pageDurationSeconds += 1;
  changedRepeatMode.playback.repeatMode = 'continuous';
  changedRoundCount.playback.roundCount += 1;

  assert.equal(settingsEqual(defaultConfig, same), true);
  assert.equal(settingsEqual(defaultConfig, changed), false);
  assert.equal(settingsEqual(defaultConfig, changedTime), false);
  assert.equal(settingsEqual(defaultConfig, changedResolution), false);
  assert.equal(settingsEqual(defaultConfig, changedPageDuration), false);
  assert.equal(settingsEqual(defaultConfig, changedRepeatMode), false);
  assert.equal(settingsEqual(defaultConfig, changedRoundCount), false);
  assert.equal(settingsEqual(defaultConfig, null), false);
});
