'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const {
  CONFIG_LIMITS,
  CONFIG_VERSION,
  DISPLAY_SELECTION_MODES,
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

test('根目錄 config.json 通過 v3 schema，回傳深層凍結副本', async () => {
  const source = await readDefaultConfig();
  const result = validateConfig(source);

  assert.equal(CONFIG_VERSION, 3);
  assert.equal(result.ok, true);
  assert.equal(result.value.configVersion, CONFIG_VERSION);
  assert.notEqual(result.value, source);
  assert.notEqual(result.value.appearance, source.appearance);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.logo), true);
  assert.equal(Object.isFrozen(result.value.appearance), true);
  assert.equal(Object.isFrozen(result.value.emergency), true);
  assert.equal(Object.isFrozen(result.value.dateTime), true);
  assert.equal(Object.isFrozen(result.value.marquee), true);
  assert.equal(Object.isFrozen(result.value.display), true);
});

test('顏色正規化，但 Logo 路徑與字型名稱不改寫', async () => {
  const source = await readDefaultConfig();
  source.logo = {
    enabled: true,
    path: 'logos/0123456789abcdef01234567.png',
  };
  source.appearance.backgroundColor = '#a1b2c3';
  source.appearance.fontColor = '#d4e5f6';
  source.appearance.fontFamily = 'Microsoft JhengHei UI, sans-serif';

  const result = validateConfig(source);

  assert.equal(result.ok, true);
  assert.equal(result.value.logo.path, source.logo.path);
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
    { ...source, configVersion: 4 },
    { ...source, logo: { ...source.logo, unexpected: true } },
  ]) {
    const result = validateConfig(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_FAILED');
  }
});

test('Logo 僅接受受管理的相對點陣圖識別，啟用時不得缺少路徑', async () => {
  const source = await readDefaultConfig();
  const candidates = [
    { enabled: true, path: null },
    { enabled: false, path: '' },
    { enabled: true, path: '/tmp/logo.png' },
    { enabled: true, path: 'C:\\DisplayCore\\logo.png' },
    { enabled: true, path: '\\\\server\\share\\logo.png' },
    { enabled: true, path: 'https://example.invalid/logo.png' },
    { enabled: true, path: 'logos/../logo.png' },
    { enabled: true, path: 'logos/nested/logo.png' },
    { enabled: true, path: 'logos/logo.svg' },
    { enabled: true, path: 'logos/operator-logo.png' },
    { enabled: true, path: 'logos/0123456789abcdef01234567.PNG' },
    { enabled: true, path: 'C:\\logo.exe' },
    { enabled: true, path: 'logos/logo\n.png' },
    {
      enabled: true,
      path: `logos/${'a'.repeat(CONFIG_LIMITS.MAX_LOGO_PATH_LENGTH)}.png`,
    },
  ];

  for (const logo of candidates) {
    const result = validateConfig({ ...source, logo });
    assert.equal(result.ok, false, JSON.stringify(logo));
    assert.equal(result.error.field, 'logo.path');
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
