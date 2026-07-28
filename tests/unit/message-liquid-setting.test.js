'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

async function readProjectFile(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

async function readDefaultConfig() {
  return JSON.parse(await readProjectFile('config.json'));
}

function createDraftInput(config, overrides = {}) {
  return {
    baseline: config,
    logoEnabled: config.logo.enabled,
    logoPath: config.logo.path,
    logoSizePercent: String(config.logo.sizePercent),
    standbyBackgroundMode: config.standby.backgroundMode,
    standbyBackgroundImagePaths: [...config.standby.backgroundImagePaths],
    standbySlideDurationSeconds: String(config.standby.slideDurationSeconds),
    backgroundColor: config.appearance.backgroundColor,
    messageBackgroundPreset: config.appearance.messageBackgroundPreset,
    fontFamily: config.appearance.fontFamily,
    fontColor: config.appearance.fontColor,
    minimumFontSizeRem: String(config.appearance.minimumFontSizeRem),
    fontSizePercent: String(config.appearance.fontSizePercent),
    standbyClockSizePercent: String(
      config.appearance.standbyClockSizePercent,
    ),
    lineSpacingPercent: String(config.appearance.lineSpacingPercent),
    messageLiquidEffectEnabled: false,
    inspectionBackgroundColor: config.emergency.inspectionBackgroundColor,
    releaseBackgroundColor: config.emergency.releaseBackgroundColor,
    dateTimeEnabled: config.dateTime.enabled,
    dateTimeOffsetSeconds: config.dateTime.offsetSeconds,
    marqueeEnabled: config.marquee.enabled,
    pageDurationSeconds: String(config.playback.pageDurationSeconds),
    repeatMode: config.playback.repeatMode,
    roundCount: String(config.playback.roundCount),
    renderResolution: config.display.renderResolution,
    ...overrides,
  };
}

test('canonical v9 設定預設啟用訊息倒酒效果，且只接受 boolean', async () => {
  const { CONFIG_VERSION, validateConfig } = require(
    '../../config/config-schema'
  );
  const config = await readDefaultConfig();

  assert.equal(CONFIG_VERSION, 9);
  assert.equal(config.configVersion, 9);
  assert.equal(config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(validateConfig(config).ok, true);

  for (const messageLiquidEffectEnabled of [true, false]) {
    const result = validateConfig({
      ...config,
      appearance: {
        ...config.appearance,
        messageLiquidEffectEnabled,
      },
    });

    assert.equal(result.ok, true, String(messageLiquidEffectEnabled));
    assert.equal(
      result.value.appearance.messageLiquidEffectEnabled,
      messageLiquidEffectEnabled,
    );
  }

  for (const invalidValue of [null, 0, 1, 'true']) {
    const result = validateConfig({
      ...config,
      appearance: {
        ...config.appearance,
        messageLiquidEffectEnabled: invalidValue,
      },
    });

    assert.equal(result.ok, false, JSON.stringify(invalidValue));
    assert.equal(
      result.error.field,
      'appearance.messageLiquidEffectEnabled',
    );
  }

  const missing = structuredClone(config);
  delete missing.appearance.messageLiquidEffectEnabled;
  assert.equal(validateConfig(missing).ok, false);
});

test('磁碟 canonical v8 嚴格遷移至 v9，保留舊值並預設啟用效果', async () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const defaults = await readDefaultConfig();
  const legacy = structuredClone(defaults);
  legacy.configVersion = 8;
  legacy.appearance.backgroundColor = '#123456';
  legacy.playback.roundCount = 27;
  delete legacy.appearance.messageLiquidEffectEnabled;

  const result = migrateStoredConfig(legacy, defaults);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 9);
  assert.equal(result.value.appearance.backgroundColor, '#123456');
  assert.equal(result.value.appearance.messageLiquidEffectEnabled, true);
  assert.equal(result.value.playback.roundCount, 27);
});

test('Control 設定頁只增加一個清楚的訊息字體效果開關', async () => {
  const html = await readProjectFile('control/index.html');
  const viewSource = await readProjectFile('control/settings-view.mjs');

  assert.equal(
    (html.match(/id="message-liquid-effect-enabled-input"/g) ?? []).length,
    1,
  );
  assert.match(
    html,
    /<label[^>]+for="message-liquid-effect-enabled-input"[\s\S]*?<strong>訊息字體倒酒效果<\/strong>[\s\S]*?<input[^>]+id="message-liquid-effect-enabled-input"[^>]+type="checkbox"/,
  );
  assert.match(html, /待機、營運訊息及 555／888 不受影響/);
  assert.match(
    viewSource,
    /messageLiquidEffectEnabled:\s*document\.getElementById\(\s*'message-liquid-effect-enabled-input',?\s*\)/,
  );
  assert.match(
    viewSource,
    /messageLiquidEffectEnabled:\s*elements\.messageLiquidEffectEnabled\.checked/,
  );
  assert.match(
    viewSource,
    /elements\.messageLiquidEffectEnabled\.checked\s*=\s*config\.appearance\.messageLiquidEffectEnabled/,
  );
});

test('Control 草稿可儲存關閉值，並將開關差異視為未儲存變更', async () => {
  const { buildSettingsDraft, settingsEqual } = await import(
    '../../control/settings-model.mjs'
  );
  const config = await readDefaultConfig();
  const result = buildSettingsDraft(createDraftInput(config));

  assert.equal(result.ok, true);
  assert.equal(result.config.configVersion, 9);
  assert.equal(result.config.appearance.messageLiquidEffectEnabled, false);
  assert.equal(settingsEqual(config, result.config), false);
  assert.equal(
    buildSettingsDraft(createDraftInput(config, {
      messageLiquidEffectEnabled: 'false',
    })).ok,
    false,
  );
});

test('Display projection 明確傳遞效果開關，安全預設則保持靜態白字', async () => {
  const { createDisplaySettingsSnapshot } = require('../../ipc/display-settings');
  const { SAFE_DISPLAY_SETTINGS, acceptDisplaySettingsSnapshot } = await import(
    '../../display/settings-state.mjs'
  );
  const config = await readDefaultConfig();
  config.appearance.messageLiquidEffectEnabled = false;
  const projected = createDisplaySettingsSnapshot({
    config,
    defaults: config,
    notice: null,
    revision: 6,
  });

  assert.equal(projected.appearance.messageLiquidEffectEnabled, false);
  assert.equal(
    acceptDisplaySettingsSnapshot(-1, projected).snapshot.appearance
      .messageLiquidEffectEnabled,
    false,
  );
  assert.equal(
    SAFE_DISPLAY_SETTINGS.appearance.messageLiquidEffectEnabled,
    false,
  );
});

test('Display 關閉效果時不 prepare，播放途中關閉會立即 reset 並退回白字', async () => {
  const source = await readProjectFile('display/app.mjs');

  assert.match(
    source,
    /currentSettings\.appearance\.messageLiquidEffectEnabled[\s\S]*?messageLiquidAnimator\.prepare\(snapshot,\s*elements\.pageLayer\)/,
  );
  assert.match(
    source,
    /messageLiquidEffectEnabled\s*===\s*false[\s\S]*?messageLiquidAnimator\.reset\(\)[\s\S]*?disableMessageLiquidEffect\(\)/,
  );
});
