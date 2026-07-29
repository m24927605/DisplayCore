'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const bundledConfig = require('../../config.json');
const {
  CONFIG_VERSION,
  DISPLAY_SELECTION_MODES,
  validateConfig,
} = require('../../config/config-schema');
const { migrateStoredConfig } = require('../../config/config-migrations');

function createV11Defaults() {
  return structuredClone({
    ...bundledConfig,
    configVersion: 11,
    display: {
      selectionMode: DISPLAY_SELECTION_MODES.AUTO,
      controlDisplayId: null,
      defaultDisplayId: null,
      fullscreen: true,
      renderResolution: 'auto',
    },
  });
}

test('設定可分別保存控制台與訊息螢幕，且兩個明確指派不得相同', () => {
  const defaults = createV11Defaults();
  const manual = structuredClone({
    ...defaults,
    display: {
      ...defaults.display,
      selectionMode: DISPLAY_SELECTION_MODES.MANUAL,
      controlDisplayId: 1,
      defaultDisplayId: 2,
    },
  });

  const accepted = validateConfig(manual);

  assert.equal(CONFIG_VERSION, 11);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.value.display, {
    selectionMode: 'manual',
    controlDisplayId: 1,
    defaultDisplayId: 2,
    fullscreen: true,
    renderResolution: 'auto',
  });

  const duplicate = validateConfig({
    ...manual,
    display: {
      ...manual.display,
      defaultDisplayId: 1,
    },
  });

  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.field, 'display.controlDisplayId');
});

test('自動分工不保存硬體 ID，手動分工必須同時提供兩個 ID', () => {
  const defaults = createV11Defaults();

  assert.equal(validateConfig(defaults).ok, true);

  for (const display of [
    { ...defaults.display, controlDisplayId: 1 },
    {
      ...defaults.display,
      selectionMode: 'manual',
      controlDisplayId: 1,
      defaultDisplayId: null,
    },
    {
      ...defaults.display,
      selectionMode: 'manual',
      controlDisplayId: null,
      defaultDisplayId: 2,
    },
  ]) {
    assert.equal(
      validateConfig({ ...defaults, display }).ok,
      false,
      JSON.stringify(display),
    );
  }
});

test('既有 canonical v9 設定遷移到 v11 時保留外觀、解析度並補上風吹沙開關', () => {
  const defaults = createV11Defaults();
  const legacyV9 = structuredClone({
    ...bundledConfig,
    configVersion: 9,
    appearance: {
      ...bundledConfig.appearance,
      fontSizePercent: 135,
    },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: true,
      renderResolution: '2560x1440',
    },
  });
  delete legacyV9.standby.sandEffectEnabled;

  const migrated = migrateStoredConfig(legacyV9, defaults);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.value.configVersion, 11);
  assert.equal(migrated.value.appearance.fontSizePercent, 135);
  assert.equal(migrated.value.standby.sandEffectEnabled, true);
  assert.deepEqual(migrated.value.display, {
    selectionMode: 'auto',
    controlDisplayId: null,
    defaultDisplayId: null,
    fullscreen: true,
    renderResolution: '2560x1440',
  });
});
