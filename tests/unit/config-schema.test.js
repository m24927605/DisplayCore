'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  CONFIG_LIMITS,
  CONFIG_VERSION,
  DISPLAY_SELECTION_MODES,
  PLAYBACK_MODES,
  validateConfig,
} = require('../../config/config-schema');

const projectRoot = path.resolve(__dirname, '..', '..');
const VALID_RENDER_RESOLUTIONS = Object.freeze([
  'auto',
  '1366x768',
  '1600x900',
  '1920x1080',
  '2560x1440',
  '3840x2160',
]);

async function readDefaultConfig() {
  return JSON.parse(
    await readFile(path.join(projectRoot, 'config.json'), 'utf8'),
  );
}

test('根目錄 config.json 通過 v6 schema，回傳深層凍結副本', async () => {
  const source = await readDefaultConfig();
  const result = validateConfig(source);

  assert.equal(CONFIG_VERSION, 6);
  assert.equal(result.ok, true);
  assert.equal(result.value.configVersion, CONFIG_VERSION);
  assert.notEqual(result.value, source);
  assert.notEqual(result.value.appearance, source.appearance);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.logo), true);
  assert.equal(Object.isFrozen(result.value.standby), true);
  assert.equal(Object.isFrozen(result.value.appearance), true);
  assert.equal(Object.isFrozen(result.value.emergency), true);
  assert.equal(Object.isFrozen(result.value.dateTime), true);
  assert.equal(Object.isFrozen(result.value.marquee), true);
  assert.equal(Object.isFrozen(result.value.playback), true);
  assert.equal(Object.isFrozen(result.value.display), true);
});

test('顏色正規化，但受管理圖片路徑與字型名稱不改寫', async () => {
  const source = await readDefaultConfig();
  source.logo = {
    enabled: true,
    path: 'logos/0123456789abcdef01234567.png',
    sizePercent: 125,
  };
  source.standby = {
    backgroundImagePath:
      'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
  };
  source.appearance.backgroundColor = '#a1b2c3';
  source.appearance.fontColor = '#d4e5f6';
  source.appearance.fontFamily = 'Microsoft JhengHei UI, sans-serif';

  const result = validateConfig(source);

  assert.equal(result.ok, true);
  assert.equal(result.value.logo.path, source.logo.path);
  assert.equal(
    result.value.standby.backgroundImagePath,
    source.standby.backgroundImagePath,
  );
  assert.equal(result.value.appearance.fontFamily, source.appearance.fontFamily);
  assert.equal(result.value.appearance.backgroundColor, '#A1B2C3');
  assert.equal(result.value.appearance.fontColor, '#D4E5F6');
});

test('設定 schema 拒絕未知欄位、錯誤版本與非純物件', async () => {
  const source = await readDefaultConfig();

  for (const candidate of [
    null,
    [],
    { ...source, unexpected: true },
    { ...source, configVersion: 1 },
    { ...source, configVersion: 2 },
    { ...source, configVersion: 3 },
    { ...source, configVersion: 4 },
    { ...source, configVersion: 5 },
    { ...source, configVersion: 7 },
    { ...source, logo: { ...source.logo, unexpected: true } },
  ]) {
    const result = validateConfig(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_FAILED');
  }
});

test('待機背景接受 null 或受管理的 exact 點陣圖路徑', async () => {
  const source = await readDefaultConfig();

  for (const backgroundImagePath of [
    null,
    'standby-backgrounds/0123456789abcdef01234567.jpg',
    'standby-backgrounds/abcdefabcdefabcdefabcdef.png',
    'standby-backgrounds/ffffffffffffffffffffffff.webp',
  ]) {
    const result = validateConfig({
      ...source,
      standby: { backgroundImagePath },
    });

    assert.equal(result.ok, true, String(backgroundImagePath));
    assert.deepEqual(result.value.standby, { backgroundImagePath });
    assert.equal(Object.isFrozen(result.value.standby), true);
  }
});

test('待機背景拒絕非 exact shape、本機路徑、網路路徑與非受管理圖片', async () => {
  const source = await readDefaultConfig();
  const validPath = 'standby-backgrounds/0123456789abcdef01234567.png';

  for (const standby of [
    {},
    { backgroundImagePath: null, unexpected: true },
  ]) {
    const result = validateConfig({ ...source, standby });
    assert.equal(result.ok, false, JSON.stringify(standby));
    assert.equal(result.error.field, 'standby');
  }

  for (const backgroundImagePath of [
    '',
    123,
    '/tmp/background.png',
    'C:\\DisplayCore\\background.png',
    '\\\\server\\share\\background.png',
    'file:///C:/DisplayCore/background.png',
    'https://example.invalid/background.png',
    'standby-backgrounds/../background.png',
    'standby-backgrounds/nested/0123456789abcdef01234567.png',
    'logos/0123456789abcdef01234567.png',
    'standby-backgrounds/0123456789abcdef0123456.png',
    'standby-backgrounds/0123456789abcdef012345678.png',
    'standby-backgrounds/0123456789abcdef0123456g.png',
    'standby-backgrounds/0123456789ABCDEF01234567.png',
    'standby-backgrounds/0123456789abcdef01234567.PNG',
    'standby-backgrounds/0123456789abcdef01234567.jpeg',
    'standby-backgrounds/0123456789abcdef01234567.svg',
    'standby-backgrounds/0123456789abcdef01234567.png?cache=1',
    'standby-backgrounds/0123456789abcdef01234567.png#fragment',
    'standby-backgrounds/0123456789abcdef01234567\n.png',
    `${validPath}/extra`,
  ]) {
    const result = validateConfig({
      ...source,
      standby: { backgroundImagePath },
    });
    assert.equal(result.ok, false, String(backgroundImagePath));
    assert.equal(result.error.field, 'standby.backgroundImagePath');
  }
});

test('播放設定接受有限／持續模式及邊界值，並保留有限輪播偏好', async () => {
  const source = await readDefaultConfig();

  for (const playback of [
    {
      pageDurationSeconds: CONFIG_LIMITS.MINIMUM_PAGE_DURATION_SECONDS,
      repeatMode: PLAYBACK_MODES.FINITE,
      roundCount: CONFIG_LIMITS.MINIMUM_ROUND_COUNT,
    },
    {
      pageDurationSeconds: CONFIG_LIMITS.MAXIMUM_PAGE_DURATION_SECONDS,
      repeatMode: PLAYBACK_MODES.CONTINUOUS,
      roundCount: CONFIG_LIMITS.MAXIMUM_ROUND_COUNT,
    },
  ]) {
    const result = validateConfig({ ...source, playback });

    assert.equal(result.ok, true, JSON.stringify(playback));
    assert.deepEqual(result.value.playback, playback);
  }
});

test('播放設定拒絕缺少／多餘欄位、錯誤型別與超出資源上限', async () => {
  const source = await readDefaultConfig();
  const valid = source.playback;
  const { pageDurationSeconds: _duration, ...missingDuration } = valid;
  const { repeatMode: _repeatMode, ...missingMode } = valid;
  const { roundCount: _roundCount, ...missingRoundCount } = valid;
  const invalidPlaybackValues = [
    missingDuration,
    missingMode,
    missingRoundCount,
    { ...valid, unexpected: true },
    { ...valid, pageDurationSeconds: 0 },
    { ...valid, pageDurationSeconds: 3_601 },
    { ...valid, pageDurationSeconds: 1.5 },
    { ...valid, pageDurationSeconds: '3' },
    { ...valid, repeatMode: 'unknown' },
    { ...valid, roundCount: 0 },
    { ...valid, roundCount: 1_000 },
    { ...valid, roundCount: 1.5 },
    { ...valid, roundCount: '1' },
  ];

  for (const playback of invalidPlaybackValues) {
    const result = validateConfig({ ...source, playback });

    assert.equal(result.ok, false, JSON.stringify(playback));
    assert.equal(result.error.field, 'playback');
  }
});

test('Logo 僅接受受管理的相對點陣圖識別，啟用時不得缺少路徑', async () => {
  const source = await readDefaultConfig();
  const withDefaultSize = (logo) => ({ ...logo, sizePercent: 100 });
  const candidates = [
    withDefaultSize({ enabled: true, path: null }),
    withDefaultSize({ enabled: false, path: '' }),
    withDefaultSize({ enabled: true, path: '/tmp/logo.png' }),
    withDefaultSize({ enabled: true, path: 'C:\\DisplayCore\\logo.png' }),
    withDefaultSize({ enabled: true, path: '\\\\server\\share\\logo.png' }),
    withDefaultSize({
      enabled: true,
      path: 'https://example.invalid/logo.png',
    }),
    withDefaultSize({ enabled: true, path: 'logos/../logo.png' }),
    withDefaultSize({ enabled: true, path: 'logos/nested/logo.png' }),
    withDefaultSize({ enabled: true, path: 'logos/logo.svg' }),
    withDefaultSize({ enabled: true, path: 'logos/operator-logo.png' }),
    withDefaultSize({
      enabled: true,
      path: 'logos/0123456789abcdef01234567.PNG',
    }),
    withDefaultSize({ enabled: true, path: 'C:\\logo.exe' }),
    withDefaultSize({ enabled: true, path: 'logos/logo\n.png' }),
    withDefaultSize({
      enabled: true,
      path: `logos/${'a'.repeat(CONFIG_LIMITS.MAX_LOGO_PATH_LENGTH)}.png`,
    }),
  ];

  for (const logo of candidates) {
    const result = validateConfig({ ...source, logo });
    assert.equal(result.ok, false, JSON.stringify(logo));
    assert.equal(result.error.field, 'logo.path');
  }
});

test('Logo 尺寸接受 50% 至 200% 且只能以 5% 遞增', async () => {
  const source = await readDefaultConfig();

  for (const sizePercent of [50, 100, 200]) {
    const result = validateConfig({
      ...source,
      logo: { ...source.logo, sizePercent },
    });

    assert.equal(result.ok, true, String(sizePercent));
    assert.deepEqual(result.value.logo, { ...source.logo, sizePercent });
  }

  for (const sizePercent of [49, 201, 51, 99, 100.5, '100', null]) {
    const result = validateConfig({
      ...source,
      logo: { ...source.logo, sizePercent },
    });

    assert.equal(result.ok, false, String(sizePercent));
    assert.equal(result.error.field, 'logo.sizePercent');
  }
});

test('Logo 必須具備 enabled、path、sizePercent 三個精確欄位', async () => {
  const source = await readDefaultConfig();
  const { sizePercent: _sizePercent, ...missingSize } = source.logo;

  for (const logo of [
    missingSize,
    { ...source.logo, unexpected: true },
  ]) {
    const result = validateConfig({ ...source, logo });

    assert.equal(result.ok, false, JSON.stringify(logo));
    assert.equal(result.error.field, 'logo');
  }
});

test('外觀設定限制色碼、字型、最小字級、字體比例與行距比例', async () => {
  const source = await readDefaultConfig();
  const invalidAppearanceValues = [
    { backgroundColor: '#FFF' },
    { backgroundColor: '#FFFFFF80' },
    { fontColor: 'white' },
    { fontFamily: '   ' },
    { fontFamily: `A${'b'.repeat(CONFIG_LIMITS.MAX_FONT_FAMILY_LENGTH)}` },
    { minimumFontSizeRem: CONFIG_LIMITS.MINIMUM_FONT_SIZE_REM - 0.25 },
    { minimumFontSizeRem: CONFIG_LIMITS.MAXIMUM_FONT_SIZE_REM + 0.25 },
    { minimumFontSizeRem: 2.6 },
    { fontSizePercent: CONFIG_LIMITS.MINIMUM_FONT_SIZE_PERCENT - 5 },
    { fontSizePercent: CONFIG_LIMITS.MAXIMUM_FONT_SIZE_PERCENT + 5 },
    { fontSizePercent: 101 },
    { lineSpacingPercent: CONFIG_LIMITS.MINIMUM_LINE_SPACING_PERCENT - 5 },
    { lineSpacingPercent: CONFIG_LIMITS.MAXIMUM_LINE_SPACING_PERCENT + 5 },
    { lineSpacingPercent: 101 },
  ];

  for (const partial of invalidAppearanceValues) {
    const result = validateConfig({
      ...source,
      appearance: { ...source.appearance, ...partial },
    });
    assert.equal(result.ok, false, JSON.stringify(partial));
    assert.match(result.error.field, /^appearance\./);
  }
});

test('555 與 888 背景顏色使用各自獨立且嚴格的設定', async () => {
  const source = await readDefaultConfig();
  source.emergency.inspectionBackgroundColor = '#a10b0b';
  source.emergency.releaseBackgroundColor = '#0b5a32';

  const result = validateConfig(source);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.emergency, {
    inspectionBackgroundColor: '#A10B0B',
    releaseBackgroundColor: '#0B5A32',
  });

  for (const emergency of [
    { ...source.emergency, inspectionBackgroundColor: 'red' },
    { ...source.emergency, releaseBackgroundColor: '#00000080' },
    { ...source.emergency, unexpected: '#000000' },
  ]) {
    const invalid = validateConfig({ ...source, emergency });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error.field ?? 'emergency', /^emergency/);
  }
});

test('時間偏移只接受 -43199 至 43200 秒的完整數與精確欄位', async () => {
  const source = await readDefaultConfig();

  for (const offsetSeconds of [-43_199, 0, 43_200]) {
    const result = validateConfig({
      ...source,
      dateTime: { enabled: true, offsetSeconds },
    });

    assert.equal(result.ok, true, String(offsetSeconds));
    assert.deepEqual(result.value.dateTime, { enabled: true, offsetSeconds });
  }

  for (const dateTime of [
    { enabled: true },
    { enabled: true, offsetSeconds: -43_200 },
    { enabled: true, offsetSeconds: 43_201 },
    { enabled: true, offsetSeconds: 0.5 },
    { enabled: true, offsetSeconds: '0' },
    { enabled: true, offsetSeconds: 0, unexpected: true },
  ]) {
    const result = validateConfig({ ...source, dateTime });
    assert.equal(result.ok, false, JSON.stringify(dateTime));
    assert.match(result.error.field ?? 'dateTime', /^dateTime/);
  }
});

test('顯示解析度只接受 auto 與五種固定預設，display 不接受缺少或多餘欄位', async () => {
  const source = await readDefaultConfig();

  for (const renderResolution of VALID_RENDER_RESOLUTIONS) {
    const result = validateConfig({
      ...source,
      display: { ...source.display, renderResolution },
    });

    assert.equal(result.ok, true, renderResolution);
    assert.equal(result.value.display.renderResolution, renderResolution);
  }

  const { renderResolution: _renderResolution, ...missingResolution } =
    source.display;
  for (const display of [
    missingResolution,
    { ...source.display, renderResolution: '1280x720' },
    { ...source.display, renderResolution: '1920×1080' },
    { ...source.display, renderResolution: 1920 },
    { ...source.display, unexpected: true },
  ]) {
    const result = validateConfig({ ...source, display });
    assert.equal(result.ok, false, JSON.stringify(display));
    assert.match(result.error.field ?? 'display', /^display/);
  }
});

test('時間、跑馬燈與顯示設定使用明確型別及交叉欄位規則', async () => {
  const source = await readDefaultConfig();
  const invalidPartials = [
    { dateTime: { ...source.dateTime, enabled: 'true' } },
    { dateTime: { ...source.dateTime, hour12: false } },
    { marquee: { enabled: 1 } },
    {
      display: {
        selectionMode: DISPLAY_SELECTION_MODES.AUTO,
        defaultDisplayId: 7,
        fullscreen: true,
        renderResolution: 'auto',
      },
    },
    {
      display: {
        selectionMode: DISPLAY_SELECTION_MODES.MANUAL,
        defaultDisplayId: null,
        fullscreen: true,
        renderResolution: 'auto',
      },
    },
    {
      display: {
        selectionMode: DISPLAY_SELECTION_MODES.MANUAL,
        defaultDisplayId: -1,
        fullscreen: true,
        renderResolution: 'auto',
      },
    },
  ];

  for (const partial of invalidPartials) {
    const result = validateConfig({ ...source, ...partial });
    assert.equal(result.ok, false, JSON.stringify(partial));
  }

  const manual = validateConfig({
    ...source,
    display: {
      selectionMode: DISPLAY_SELECTION_MODES.MANUAL,
      defaultDisplayId: 42,
      fullscreen: false,
      renderResolution: '1920x1080',
    },
  });
  assert.equal(manual.ok, true);
  assert.deepEqual(manual.value.display, {
    selectionMode: 'manual',
    defaultDisplayId: 42,
    fullscreen: false,
    renderResolution: '1920x1080',
  });
});
