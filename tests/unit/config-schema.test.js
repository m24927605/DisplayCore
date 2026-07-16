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

async function readDefaultConfig() {
  return JSON.parse(
    await readFile(path.join(projectRoot, 'config.json'), 'utf8'),
  );
}

test('根目錄 config.json 通過 v1 schema，回傳深層凍結副本', async () => {
  const source = await readDefaultConfig();
  const result = validateConfig(source);

  assert.equal(result.ok, true);
  assert.equal(result.value.configVersion, CONFIG_VERSION);
  assert.notEqual(result.value, source);
  assert.notEqual(result.value.appearance, source.appearance);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.logo), true);
  assert.equal(Object.isFrozen(result.value.appearance), true);
  assert.equal(Object.isFrozen(result.value.dateTime), true);
  assert.equal(Object.isFrozen(result.value.marquee), true);
  assert.equal(Object.isFrozen(result.value.display), true);
});

test('顏色與 locale 正規化，但 Logo 路徑與字型名稱不改寫', async () => {
  const source = await readDefaultConfig();
  source.logo = {
    enabled: true,
    path: 'logos/brand-2026.PNG',
  };
  source.appearance.backgroundColor = '#a1b2c3';
  source.appearance.fontColor = '#d4e5f6';
  source.appearance.fontFamily = 'Microsoft JhengHei UI, sans-serif';
  source.dateTime.locale = 'zh-tw';

  const result = validateConfig(source);

  assert.equal(result.ok, true);
  assert.equal(result.value.logo.path, source.logo.path);
  assert.equal(result.value.appearance.fontFamily, source.appearance.fontFamily);
  assert.equal(result.value.appearance.backgroundColor, '#A1B2C3');
  assert.equal(result.value.appearance.fontColor, '#D4E5F6');
  assert.equal(result.value.dateTime.locale, 'zh-TW');
});

test('設定 schema 拒絕未知欄位、錯誤版本與非純物件', async () => {
  const source = await readDefaultConfig();

  for (const candidate of [
    null,
    [],
    { ...source, unexpected: true },
    { ...source, configVersion: 2 },
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

test('外觀設定限制不透明色碼、字型長度及 0.25rem 字級級距', async () => {
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

test('日期、跑馬燈與顯示設定使用明確型別及交叉欄位規則', async () => {
  const source = await readDefaultConfig();
  const invalidPartials = [
    { dateTime: { ...source.dateTime, enabled: 'true' } },
    { dateTime: { ...source.dateTime, locale: '不是 locale' } },
    { dateTime: { ...source.dateTime, hour12: 0 } },
    { marquee: { enabled: 1 } },
    {
      display: {
        selectionMode: DISPLAY_SELECTION_MODES.AUTO,
        defaultDisplayId: 7,
        fullscreen: true,
      },
    },
    {
      display: {
        selectionMode: DISPLAY_SELECTION_MODES.MANUAL,
        defaultDisplayId: null,
        fullscreen: true,
      },
    },
    {
      display: {
        selectionMode: DISPLAY_SELECTION_MODES.MANUAL,
        defaultDisplayId: -1,
        fullscreen: true,
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
    },
  });
  assert.equal(manual.ok, true);
  assert.deepEqual(manual.value.display, {
    selectionMode: 'manual',
    defaultDisplayId: 42,
    fullscreen: false,
  });
});
