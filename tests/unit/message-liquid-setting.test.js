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
    standbySandEffectEnabled: config.standby.sandEffectEnabled,
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
    messageLiquidEffectEnabled:
      config.appearance.messageLiquidEffectEnabled,
    inspectionBackgroundColor: config.emergency.inspectionBackgroundColor,
    releaseBackgroundColor: config.emergency.releaseBackgroundColor,
    dateTimeEnabled: config.dateTime.enabled,
    dateTimeOffsetSeconds: config.dateTime.offsetSeconds,
    marqueeEnabled: config.marquee.enabled,
    pageDurationSeconds: String(config.playback.pageDurationSeconds),
    repeatMode: config.playback.repeatMode,
    roundCount: String(config.playback.roundCount),
    controlDisplayId:
      config.display.controlDisplayId === null
        ? 'auto'
        : String(config.display.controlDisplayId),
    defaultDisplayId:
      config.display.defaultDisplayId === null
        ? 'auto'
        : String(config.display.defaultDisplayId),
    renderResolution: config.display.renderResolution,
    brightnessEnabled: config.display.brightnessPercent !== null,
    brightnessPercent: String(config.display.brightnessPercent ?? 100),
    contrastEnabled: config.display.contrastPercent !== null,
    contrastPercent: String(config.display.contrastPercent ?? 100),
    ...overrides,
  };
}

test('canonical v12 預設啟用兩項顯示特效，且都只接受 boolean', async () => {
  const { CONFIG_VERSION, validateConfig } = require(
    '../../config/config-schema'
  );
  const config = await readDefaultConfig();

  assert.equal(CONFIG_VERSION, 12);
  assert.equal(config.configVersion, 12);
  assert.equal(config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(config.standby.sandEffectEnabled, true);
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

  for (const sandEffectEnabled of [true, false]) {
    const result = validateConfig({
      ...config,
      standby: {
        ...config.standby,
        sandEffectEnabled,
      },
    });

    assert.equal(result.ok, true, String(sandEffectEnabled));
    assert.equal(result.value.standby.sandEffectEnabled, sandEffectEnabled);
  }

  for (const invalidValue of [null, 0, 1, 'true']) {
    const result = validateConfig({
      ...config,
      standby: {
        ...config.standby,
        sandEffectEnabled: invalidValue,
      },
    });

    assert.equal(result.ok, false, JSON.stringify(invalidValue));
    assert.equal(result.error.field, 'standby.sandEffectEnabled');
  }

  const missingSandEffect = structuredClone(config);
  delete missingSandEffect.standby.sandEffectEnabled;
  assert.equal(validateConfig(missingSandEffect).ok, false);
});

test('磁碟 canonical v8 嚴格遷移至 v12，保留舊值並預設啟用兩項效果', async () => {
  const { migrateStoredConfig } = require('../../config/config-migrations');
  const defaults = await readDefaultConfig();
  const legacy = structuredClone(defaults);
  legacy.configVersion = 8;
  legacy.appearance.backgroundColor = '#123456';
  legacy.playback.roundCount = 27;
  delete legacy.appearance.messageLiquidEffectEnabled;
  delete legacy.standby.sandEffectEnabled;
  delete legacy.display.controlDisplayId;
  delete legacy.display.brightnessPercent;
  delete legacy.display.contrastPercent;

  const result = migrateStoredConfig(legacy, defaults);

  assert.equal(result.ok, true);
  assert.equal(result.migrated, true);
  assert.equal(result.value.configVersion, 12);
  assert.equal(result.value.appearance.backgroundColor, '#123456');
  assert.equal(result.value.appearance.messageLiquidEffectEnabled, true);
  assert.equal(result.value.standby.sandEffectEnabled, true);
  assert.equal(result.value.playback.roundCount, 27);
});

test('Control 設定頁只有兩個獨立且清楚的顯示特效開關', async () => {
  const html = await readProjectFile('control/index.html');
  const viewSource = await readProjectFile('control/settings-view.mjs');

  const expectedEffectInputIds = [
    'message-liquid-effect-enabled-input',
    'standby-sand-effect-enabled-input',
  ];

  for (const inputId of expectedEffectInputIds) {
    assert.equal(
      (html.match(new RegExp(`id="${inputId}"`, 'g')) ?? []).length,
      1,
      `${inputId} 必須且只能出現一次`,
    );
  }
  assert.equal(
    (
      html.match(
        /id="(?:message-liquid-effect-enabled-input|standby-sand-effect-enabled-input)"/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    html,
    /<label[^>]+for="message-liquid-effect-enabled-input"[\s\S]*?<strong>訊息特效<\/strong>[\s\S]*?<input[^>]+id="message-liquid-effect-enabled-input"[^>]+type="checkbox"/,
  );
  assert.match(
    html,
    /<label[^>]+for="standby-sand-effect-enabled-input"[\s\S]*?<strong>待機頁面特效（風吹沙）<\/strong>[\s\S]*?<input[^>]+id="standby-sand-effect-enabled-input"[^>]+type="checkbox"/,
  );
  assert.match(html, /關閉後顯示固定白字/);
  assert.match(html, /關閉後直接切換圖片/);
  assert.doesNotMatch(html, /<strong>訊息字體倒酒效果<\/strong>/);
  assert.match(
    viewSource,
    /messageLiquidEffectEnabled:\s*document\.getElementById\(\s*'message-liquid-effect-enabled-input',?\s*\)/,
  );
  assert.match(
    viewSource,
    /standbySandEffectEnabled:\s*document\.getElementById\(\s*'standby-sand-effect-enabled-input',?\s*\)/,
  );
  assert.match(
    viewSource,
    /messageLiquidEffectEnabled:\s*elements\.messageLiquidEffectEnabled\.checked/,
  );
  assert.match(
    viewSource,
    /standbySandEffectEnabled:\s*elements\.standbySandEffectEnabled\.checked/,
  );
  assert.match(
    viewSource,
    /elements\.messageLiquidEffectEnabled\.checked\s*=\s*config\.appearance\.messageLiquidEffectEnabled/,
  );
  assert.match(
    viewSource,
    /elements\.standbySandEffectEnabled\.checked\s*=\s*config\.standby\.sandEffectEnabled/,
  );

  const effectInputListenerLoop = viewSource.match(
    /for \(const control of \[[\s\S]*?elements\.messageLiquidEffectEnabled[\s\S]*?\]\) \{[\s\S]*?control\.addEventListener\('input',\s*handleDraftInput/,
  )?.[0] ?? '';
  assert.match(
    effectInputListenerLoop,
    /elements\.standbySandEffectEnabled/,
    '兩項特效開關都必須觸發草稿變更偵測',
  );
});

test('Control 草稿可獨立儲存兩項開關，且各自影響 settingsEqual', async () => {
  const { buildSettingsDraft, settingsEqual } = await import(
    '../../control/settings-model.mjs'
  );
  const config = await readDefaultConfig();
  const messageEffectOff = buildSettingsDraft(createDraftInput(config, {
    messageLiquidEffectEnabled: false,
    standbySandEffectEnabled: true,
  }));
  const standbyEffectOff = buildSettingsDraft(createDraftInput(config, {
    messageLiquidEffectEnabled: true,
    standbySandEffectEnabled: false,
  }));
  const unchanged = buildSettingsDraft(createDraftInput(config, {
    messageLiquidEffectEnabled: true,
    standbySandEffectEnabled: true,
  }));

  assert.equal(messageEffectOff.ok, true);
  assert.equal(messageEffectOff.config.configVersion, 12);
  assert.equal(
    messageEffectOff.config.appearance.messageLiquidEffectEnabled,
    false,
  );
  assert.equal(messageEffectOff.config.standby.sandEffectEnabled, true);
  assert.equal(settingsEqual(config, messageEffectOff.config), false);

  assert.equal(standbyEffectOff.ok, true);
  assert.equal(
    standbyEffectOff.config.appearance.messageLiquidEffectEnabled,
    true,
  );
  assert.equal(standbyEffectOff.config.standby.sandEffectEnabled, false);
  assert.equal(settingsEqual(config, standbyEffectOff.config), false);

  assert.equal(unchanged.ok, true);
  assert.equal(settingsEqual(config, unchanged.config), true);
  assert.equal(
    buildSettingsDraft(createDraftInput(config, {
      messageLiquidEffectEnabled: 'false',
    })).ok,
    false,
  );
  assert.equal(
    buildSettingsDraft(createDraftInput(config, {
      standbySandEffectEnabled: 'false',
    })).ok,
    false,
  );
});

test('Display projection 明確傳遞兩項效果開關，安全預設停用兩者', async () => {
  const { createDisplaySettingsSnapshot } = require('../../ipc/display-settings');
  const { SAFE_DISPLAY_SETTINGS, acceptDisplaySettingsSnapshot } = await import(
    '../../display/settings-state.mjs'
  );
  const config = await readDefaultConfig();
  config.appearance.messageLiquidEffectEnabled = false;
  config.standby.sandEffectEnabled = false;
  const projected = createDisplaySettingsSnapshot({
    config,
    defaults: config,
    notice: null,
    revision: 6,
  });

  assert.equal(projected.appearance.messageLiquidEffectEnabled, false);
  assert.equal(projected.standby.sandEffectEnabled, false);
  assert.equal(
    acceptDisplaySettingsSnapshot(-1, projected).snapshot.appearance
      .messageLiquidEffectEnabled,
    false,
  );
  assert.equal(
    SAFE_DISPLAY_SETTINGS.appearance.messageLiquidEffectEnabled,
    false,
  );
  assert.equal(SAFE_DISPLAY_SETTINGS.standby.sandEffectEnabled, false);
});

test('Display 兩項效果各自門控 prepare，播放途中關閉會立即清理', async () => {
  const source = await readProjectFile('display/app.mjs');

  assert.match(
    source,
    /currentSettings\.appearance\.messageLiquidEffectEnabled[\s\S]*?messageLiquidAnimator\.prepare\(snapshot,\s*elements\.pageLayer\)/,
  );
  assert.match(
    source,
    /messageLiquidEffectEnabled\s*===\s*false[\s\S]*?messageLiquidAnimator\.reset\(\)[\s\S]*?disableMessageLiquidEffect\(\)/,
  );
  assert.match(
    source,
    /function scheduleStandbySandPreparation\(\)[\s\S]*?currentSettings\.standby\.sandEffectEnabled\s*!==\s*true[\s\S]*?sandTransition\.discardPrepared\(\)[\s\S]*?clearStandbySandCanvas\(\{\s*releaseBuffers:\s*true\s*\}\)/,
  );
  assert.match(
    source,
    /function startStandbySandTransition\(image,\s*url\)\s*\{[\s\S]*?currentSettings\.standby\.sandEffectEnabled\s*!==\s*true[\s\S]*?return false;/,
  );
  assert.match(
    source,
    /function applyDisplaySettings\(snapshot\)\s*\{[\s\S]*?currentSettings\s*=\s*snapshot;[\s\S]*?snapshot\.standby\.sandEffectEnabled\s*===\s*false[\s\S]*?cancelScheduledSandPreparation\(\);[\s\S]*?cancelStandbySandTransition\(\{\s*releaseBuffers:\s*true\s*\}\)/,
  );
});
