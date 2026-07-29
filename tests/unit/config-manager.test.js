'use strict';

const assert = require('node:assert/strict');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConfigConflictError,
  ConfigManager,
  ConfigValidationError,
} = require('../../config/config-manager');
const { CONFIG_LIMITS } = require('../../config/config-schema');

const projectRoot = path.resolve(__dirname, '..', '..');
const bundledDefaultPath = path.join(projectRoot, 'config.json');
const DEFAULT_STANDBY = Object.freeze({
  backgroundMode: 'fixed',
  backgroundImagePaths: Object.freeze([]),
  sandEffectEnabled: true,
  slideDurationSeconds: 10,
});

async function readBundledDefault() {
  return JSON.parse(await fileSystem.readFile(bundledDefaultPath, 'utf8'));
}

function expectedSafeDisplay(defaultDisplay, legacyDisplay) {
  return {
    ...defaultDisplay,
    renderResolution:
      legacyDisplay.renderResolution ?? defaultDisplay.renderResolution,
  };
}

async function createHarness(t, overrides = {}) {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-config-'),
  );
  const configPath = path.join(directory, 'config.json');
  const manager = new ConfigManager({
    defaultConfigPath: bundledDefaultPath,
    configPath,
    ...overrides,
  });

  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  return { configPath, directory, manager };
}

test('首次啟動以原廠預設值原子建立 userData/config.json', async (t) => {
  const { configPath, directory, manager } = await createHarness(t);
  const defaults = await readBundledDefault();

  const snapshot = await manager.initialize();
  const persistedText = await fileSystem.readFile(configPath, 'utf8');

  assert.deepEqual(snapshot.config, defaults);
  assert.deepEqual(snapshot.defaults, defaults);
  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.standby.sandEffectEnabled, true);
  assert.deepEqual(snapshot.config.logo, {
    enabled: false,
    path: null,
    sizePercent: 100,
  });
  assert.deepEqual(snapshot.config.standby, DEFAULT_STANDBY);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.notice, null);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.config), true);
  assert.equal(Object.isFrozen(snapshot.config.standby), true);
  assert.equal(
    Object.isFrozen(snapshot.config.standby.backgroundImagePaths),
    true,
  );
  assert.equal(persistedText.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(persistedText), defaults);
  assert.deepEqual(await fileSystem.readdir(directory), ['config.json']);
});

test('有效使用者設定支援 UTF-8 BOM，載入時不擅自重寫檔案', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const custom = await readBundledDefault();
  custom.appearance.backgroundColor = '#123abc';
  const originalText = `\uFEFF${JSON.stringify(custom)}`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.appearance.backgroundColor, '#123ABC');
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
});

test('既有 v1 使用者設定在記憶體升級為 v11 且不擅自覆寫原檔', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = {
    configVersion: 1,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#123abc',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#fedcba',
      minimumFontSizeRem: 3.25,
    },
    dateTime: { enabled: true, locale: 'zh-TW', hour12: true },
    marquee: { enabled: false },
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
    },
  };
  const originalText = JSON.stringify(legacy);
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.deepEqual(snapshot.config.logo, {
    enabled: false,
    path: null,
    sizePercent: 100,
  });
  assert.equal(snapshot.config.appearance.backgroundColor, '#123ABC');
  assert.equal(snapshot.config.appearance.fontColor, '#FEDCBA');
  assert.equal(snapshot.config.appearance.fontSizePercent, 100);
  assert.equal(snapshot.config.appearance.lineSpacingPercent, 100);
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 100);
  assert.deepEqual(snapshot.config.dateTime, {
    enabled: true,
    offsetSeconds: 0,
  });
  assert.deepEqual(snapshot.config.emergency, snapshot.defaults.emergency);
  assert.deepEqual(snapshot.config.playback, snapshot.defaults.playback);
  assert.deepEqual(snapshot.config.standby, DEFAULT_STANDBY);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  assert.equal(
    JSON.parse(await fileSystem.readFile(configPath, 'utf8')).configVersion,
    11,
  );
  assert.equal(
    JSON.parse(await fileSystem.readFile(configPath, 'utf8')).logo.sizePercent,
    100,
  );
  assert.equal(saved.revision, 1);
});

test('既有 v2 使用者設定在記憶體升級為 v11 且不擅自覆寫原檔', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = {
    configVersion: 2,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#234bcd',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#edcb98',
      minimumFontSizeRem: 3.5,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
    },
    dateTime: { enabled: false },
    emergency: {
      inspectionBackgroundColor: '#7f1d1d',
      releaseBackgroundColor: '#14532d',
    },
    marquee: { enabled: true },
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
    },
  };
  const originalText = `\uFEFF${JSON.stringify(legacy)}`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.deepEqual(snapshot.config.logo, {
    enabled: false,
    path: null,
    sizePercent: 100,
  });
  assert.equal(snapshot.config.appearance.backgroundColor, '#234BCD');
  assert.equal(snapshot.config.appearance.fontColor, '#EDCB98');
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 125);
  assert.deepEqual(snapshot.config.dateTime, {
    enabled: false,
    offsetSeconds: 0,
  });
  assert.deepEqual(snapshot.config.playback, snapshot.defaults.playback);
  assert.deepEqual(snapshot.config.standby, DEFAULT_STANDBY);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  assert.equal(
    JSON.parse(await fileSystem.readFile(configPath, 'utf8')).configVersion,
    11,
  );
  assert.equal(
    JSON.parse(await fileSystem.readFile(configPath, 'utf8')).logo.sizePercent,
    100,
  );
  assert.equal(saved.revision, 1);
});

test('既有 v3 使用者設定在記憶體升級為 v11 且安全改用自動螢幕分工', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = {
    configVersion: 3,
    logo: { enabled: false, path: null },
    appearance: {
      backgroundColor: '#345cde',
      fontFamily: 'Noto Sans TC, sans-serif',
      fontColor: '#dcba87',
      minimumFontSizeRem: 3.75,
      fontSizePercent: 130,
      lineSpacingPercent: 155,
    },
    dateTime: { enabled: true, offsetSeconds: 3_661 },
    emergency: {
      inspectionBackgroundColor: '#6f1c1c',
      releaseBackgroundColor: '#13522c',
    },
    marquee: { enabled: false },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
      renderResolution: '2560x1440',
    },
  };
  const originalText = `\uFEFF${JSON.stringify(legacy)}`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.deepEqual(snapshot.config.logo, {
    enabled: false,
    path: null,
    sizePercent: 100,
  });
  assert.equal(snapshot.config.appearance.backgroundColor, '#345CDE');
  assert.equal(snapshot.config.appearance.fontColor, '#DCBA87');
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 130);
  assert.deepEqual(snapshot.config.playback, snapshot.defaults.playback);
  assert.deepEqual(snapshot.config.standby, DEFAULT_STANDBY);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  const persisted = JSON.parse(await fileSystem.readFile(configPath, 'utf8'));
  assert.equal(persisted.configVersion, 11);
  assert.equal(persisted.logo.sizePercent, 100);
  assert.deepEqual(persisted.playback, snapshot.defaults.playback);
  assert.deepEqual(persisted.standby, DEFAULT_STANDBY);
  assert.equal(saved.revision, 1);
});

test('既有 v4 使用者設定在記憶體升級為 v11，不覆寫原檔且安全自動分工', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = {
    configVersion: 4,
    logo: {
      enabled: true,
      path: 'logos/0123456789abcdef01234567.png',
    },
    appearance: {
      backgroundColor: '#456def',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#cba987',
      minimumFontSizeRem: 4,
      fontSizePercent: 135,
      lineSpacingPercent: 160,
    },
    dateTime: { enabled: false, offsetSeconds: -3_661 },
    emergency: {
      inspectionBackgroundColor: '#5f1b1b',
      releaseBackgroundColor: '#12512b',
    },
    marquee: { enabled: true },
    playback: {
      pageDurationSeconds: 9,
      repeatMode: 'continuous',
      roundCount: 23,
    },
    display: {
      selectionMode: 'manual',
      defaultDisplayId: 84,
      fullscreen: false,
      renderResolution: '3840x2160',
    },
  };
  const originalText = `\uFEFF${JSON.stringify(legacy)}`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 135);
  assert.deepEqual(snapshot.config.standby, DEFAULT_STANDBY);
  assert.deepEqual(snapshot.config.playback, legacy.playback);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.config.logo.path, legacy.logo.path);
  assert.equal(snapshot.config.logo.sizePercent, 100);
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const next = structuredClone(snapshot.config);
  next.standby.backgroundImagePaths = [
    'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
  ];
  const saved = await manager.saveConfig(next, snapshot.revision);
  const persisted = JSON.parse(await fileSystem.readFile(configPath, 'utf8'));

  assert.equal(saved.revision, 1);
  assert.equal(persisted.configVersion, 11);
  assert.equal(persisted.logo.sizePercent, 100);
  assert.deepEqual(persisted.playback, legacy.playback);
  assert.deepEqual(
    persisted.standby.backgroundImagePaths,
    ['standby-backgrounds/abcdefabcdefabcdefabcdef.webp'],
  );
});

test('既有 v5 使用者設定在記憶體升級為 v11，保留背景並安全自動分工', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = {
    configVersion: 5,
    logo: {
      enabled: true,
      path: 'logos/0123456789abcdef01234567.png',
    },
    standby: {
      backgroundImagePath:
        'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
    },
    appearance: {
      backgroundColor: '#456def',
      fontFamily: 'Arial, sans-serif',
      fontColor: '#cba987',
      minimumFontSizeRem: 4,
      fontSizePercent: 135,
      lineSpacingPercent: 160,
    },
    dateTime: { enabled: false, offsetSeconds: -3_661 },
    emergency: {
      inspectionBackgroundColor: '#5f1b1b',
      releaseBackgroundColor: '#12512b',
    },
    marquee: { enabled: true },
    playback: {
      pageDurationSeconds: 9,
      repeatMode: 'continuous',
      roundCount: 23,
    },
    display: {
      selectionMode: 'auto',
      defaultDisplayId: null,
      fullscreen: true,
      renderResolution: '1920x1080',
    },
  };
  const originalText = `\uFEFF${JSON.stringify(legacy)}`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 135);
  assert.deepEqual(snapshot.config.logo, {
    ...legacy.logo,
    sizePercent: 100,
  });
  assert.deepEqual(snapshot.config.standby, {
    backgroundMode: 'fixed',
    backgroundImagePaths: [legacy.standby.backgroundImagePath],
    sandEffectEnabled: true,
    slideDurationSeconds: 10,
  });
  assert.deepEqual(snapshot.config.playback, legacy.playback);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  const persisted = JSON.parse(await fileSystem.readFile(configPath, 'utf8'));

  assert.equal(saved.revision, 1);
  assert.equal(persisted.configVersion, 11);
  assert.deepEqual(persisted.logo, {
    ...legacy.logo,
    sizePercent: 100,
  });
});

test('既有 v6 使用者設定嚴格升級為 v11 且儲存前不覆寫原檔', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = await readBundledDefault();
  legacy.configVersion = 6;
  delete legacy.appearance.messageBackgroundPreset;
  delete legacy.appearance.messageLiquidEffectEnabled;
  delete legacy.appearance.standbyClockSizePercent;
  delete legacy.display.controlDisplayId;
  legacy.logo.sizePercent = 375;
  legacy.standby = {
    backgroundImagePath:
      'standby-backgrounds/0123456789abcdef01234567.png',
  };
  const originalText = JSON.stringify(legacy);
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.logo.sizePercent, 375);
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 100);
  assert.deepEqual(snapshot.config.standby, {
    backgroundMode: 'fixed',
    backgroundImagePaths: [legacy.standby.backgroundImagePath],
    sandEffectEnabled: true,
    slideDurationSeconds: 10,
  });
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
});

test('既有 canonical v7 使用者設定升級為 v11 並維持純色與待機時間比例', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = await readBundledDefault();
  legacy.configVersion = 7;
  legacy.appearance.backgroundColor = '#123abc';
  legacy.appearance.fontSizePercent = 175;
  delete legacy.appearance.messageBackgroundPreset;
  delete legacy.appearance.messageLiquidEffectEnabled;
  delete legacy.appearance.standbyClockSizePercent;
  delete legacy.standby.sandEffectEnabled;
  delete legacy.display.controlDisplayId;
  const originalText = JSON.stringify(legacy);
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.appearance.backgroundColor, '#123ABC');
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'solid');
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 175);
  assert.equal(snapshot.config.standby.sandEffectEnabled, true);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
});

test('既有 canonical v8 使用者設定升級為 v11，下次儲存才寫回新格式', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = await readBundledDefault();
  legacy.configVersion = 8;
  legacy.appearance.backgroundColor = '#123abc';
  legacy.appearance.messageBackgroundPreset = 'walnut';
  legacy.appearance.standbyClockSizePercent = 185;
  legacy.playback.pageDurationSeconds = 17;
  delete legacy.appearance.messageLiquidEffectEnabled;
  delete legacy.standby.sandEffectEnabled;
  delete legacy.display.controlDisplayId;
  const originalText = `\uFEFF${JSON.stringify(legacy)}`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.appearance.backgroundColor, '#123ABC');
  assert.equal(snapshot.config.appearance.messageBackgroundPreset, 'walnut');
  assert.equal(snapshot.config.appearance.standbyClockSizePercent, 185);
  assert.equal(snapshot.config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(snapshot.config.standby.sandEffectEnabled, true);
  assert.equal(snapshot.config.playback.pageDurationSeconds, 17);
  assert.deepEqual(
    snapshot.config.display,
    expectedSafeDisplay(snapshot.defaults.display, legacy.display),
  );
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  const persisted = JSON.parse(await fileSystem.readFile(configPath, 'utf8'));

  assert.equal(saved.revision, 1);
  assert.equal(persisted.configVersion, 11);
  assert.equal(persisted.appearance.messageLiquidEffectEnabled, true);
  assert.equal(persisted.appearance.messageBackgroundPreset, 'walnut');
  assert.equal(persisted.playback.pageDurationSeconds, 17);
});

test('既有 canonical v9 手動螢幕設定升級為 v11 時採安全自動分工', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = await readBundledDefault();
  legacy.configVersion = 9;
  legacy.display = {
    selectionMode: 'manual',
    defaultDisplayId: 84,
    fullscreen: false,
    renderResolution: '1600x900',
  };
  delete legacy.standby.sandEffectEnabled;
  const originalText = JSON.stringify(legacy);
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.standby.sandEffectEnabled, true);
  assert.deepEqual(snapshot.config.display, {
    selectionMode: 'auto',
    controlDisplayId: null,
    defaultDisplayId: null,
    fullscreen: true,
    renderResolution: '1600x900',
  });
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  const persisted = JSON.parse(await fileSystem.readFile(configPath, 'utf8'));

  assert.equal(saved.revision, 1);
  assert.equal(persisted.configVersion, 11);
  assert.deepEqual(persisted.display, snapshot.config.display);
});

test('既有 canonical v10 設定升級為 v11 時補上待機風吹沙開關', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const legacy = await readBundledDefault();
  legacy.configVersion = 10;
  legacy.standby.backgroundMode = 'slideshow';
  legacy.standby.slideDurationSeconds = 17;
  delete legacy.standby.sandEffectEnabled;
  const originalText = JSON.stringify(legacy);
  await fileSystem.writeFile(configPath, originalText, 'utf8');

  const snapshot = await manager.initialize();

  assert.equal(snapshot.config.configVersion, 11);
  assert.equal(snapshot.config.standby.backgroundMode, 'slideshow');
  assert.equal(snapshot.config.standby.slideDurationSeconds, 17);
  assert.equal(snapshot.config.standby.sandEffectEnabled, true);
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
});

test('損壞或過大的使用者設定保留原檔，記憶體安全降級為預設值', async (t) => {
  const scenarios = [
    '{ invalid json',
    'x'.repeat(CONFIG_LIMITS.MAX_FILE_BYTES + 1),
  ];

  for (const [index, originalText] of scenarios.entries()) {
    const directory = await fileSystem.mkdtemp(
      path.join(os.tmpdir(), `displaycore-invalid-${index}-`),
    );
    const configPath = path.join(directory, 'config.json');
    await fileSystem.writeFile(configPath, originalText, 'utf8');
    t.after(async () => {
      await fileSystem.rm(directory, { recursive: true, force: true });
    });

    const manager = new ConfigManager({
      defaultConfigPath: bundledDefaultPath,
      configPath,
    });
    const snapshot = await manager.initialize();

    assert.deepEqual(snapshot.config, snapshot.defaults);
    assert.deepEqual(snapshot.notice, {
      code: 'INVALID_USER_CONFIG',
      message: '使用者設定檔無法讀取，目前使用安全預設值；儲存後可修復。',
    });
    assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
  }
});

test('原廠預設設定無效時視為封裝錯誤並中止初始化', async (t) => {
  const { configPath, directory } = await createHarness(t);
  const invalidDefaultPath = path.join(directory, 'invalid-default.json');
  await fileSystem.writeFile(invalidDefaultPath, '{}', 'utf8');
  const manager = new ConfigManager({
    defaultConfigPath: invalidDefaultPath,
    configPath,
  });

  await assert.rejects(
    manager.initialize(),
    /原廠預設設定無效/,
  );
  await assert.rejects(fileSystem.access(configPath));
});

test('儲存成功後才更新 revision、記憶體、磁碟與訂閱者', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const initial = await manager.initialize();
  const nextConfig = structuredClone(initial.config);
  nextConfig.appearance.backgroundColor = '#102030';
  nextConfig.dateTime.enabled = true;
  const received = [];
  const unsubscribe = manager.subscribe((snapshot) => received.push(snapshot));

  const saved = await manager.saveConfig(nextConfig, initial.revision);

  assert.equal(saved.revision, 1);
  assert.equal(saved.config.appearance.backgroundColor, '#102030');
  assert.equal(saved.config.dateTime.enabled, true);
  assert.equal(saved.notice, null);
  assert.deepEqual(manager.getSnapshot(), saved);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], saved);
  assert.deepEqual(
    JSON.parse(await fileSystem.readFile(configPath, 'utf8')),
    saved.config,
  );

  nextConfig.appearance.backgroundColor = '#FFFFFF';
  assert.equal(manager.getSnapshot().config.appearance.backgroundColor, '#102030');

  unsubscribe();
  await manager.saveConfig(structuredClone(initial.config), saved.revision);
  assert.equal(received.length, 1);
});

test('手動雙螢幕分工儲存後可由新的 ConfigManager 重新載入', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const initial = await manager.initialize();
  const nextConfig = structuredClone(initial.config);
  nextConfig.display = {
    selectionMode: 'manual',
    controlDisplayId: 1,
    defaultDisplayId: 2,
    fullscreen: true,
    renderResolution: 'auto',
  };

  await manager.saveConfig(nextConfig, initial.revision);

  const restartedManager = new ConfigManager({
    defaultConfigPath: bundledDefaultPath,
    configPath,
  });
  const restarted = await restartedManager.initialize();

  assert.equal(restarted.revision, 0);
  assert.deepEqual(restarted.config.display, nextConfig.display);
});

test('多張待機背景設定只在驗證與原子寫入成功後持久化', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const initial = await manager.initialize();
  const next = structuredClone(initial.config);
  next.standby = {
    backgroundMode: 'slideshow',
    backgroundImagePaths: [
      'standby-backgrounds/0123456789abcdef01234567.png',
      'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
    ],
    sandEffectEnabled: false,
    slideDurationSeconds: 8,
  };

  const saved = await manager.saveConfig(next, initial.revision);
  const persisted = JSON.parse(await fileSystem.readFile(configPath, 'utf8'));

  assert.equal(saved.revision, 1);
  assert.deepEqual(
    saved.config.standby.backgroundImagePaths,
    [
      'standby-backgrounds/0123456789abcdef01234567.png',
      'standby-backgrounds/abcdefabcdefabcdefabcdef.webp',
    ],
  );
  assert.equal(saved.config.standby.sandEffectEnabled, false);
  assert.equal(Object.isFrozen(saved.config.standby), true);
  assert.equal(
    Object.isFrozen(saved.config.standby.backgroundImagePaths),
    true,
  );
  assert.deepEqual(persisted.standby, saved.config.standby);
});

test('無效設定與過期 revision 不會改變既有檔案或記憶體', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const initial = await manager.initialize();
  const originalText = await fileSystem.readFile(configPath, 'utf8');
  const invalid = structuredClone(initial.config);
  const invalidEffect = structuredClone(initial.config);
  const invalidStandbyEffect = structuredClone(initial.config);
  invalid.appearance.fontColor = 'red';
  invalidEffect.appearance.messageLiquidEffectEnabled = 'false';
  invalidStandbyEffect.standby.sandEffectEnabled = 'false';

  await assert.rejects(
    manager.saveConfig(invalid, initial.revision),
    (error) =>
      error instanceof ConfigValidationError &&
      error.validationError.field === 'appearance.fontColor',
  );
  await assert.rejects(
    manager.saveConfig(invalidEffect, initial.revision),
    (error) =>
      error instanceof ConfigValidationError &&
      error.validationError.field ===
        'appearance.messageLiquidEffectEnabled',
  );
  await assert.rejects(
    manager.saveConfig(invalidStandbyEffect, initial.revision),
    (error) =>
      error instanceof ConfigValidationError &&
      error.validationError.field === 'standby.sandEffectEnabled',
  );
  await assert.rejects(
    manager.saveConfig(initial.config, initial.revision + 1),
    ConfigConflictError,
  );

  assert.deepEqual(manager.getSnapshot(), initial);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
});

test('併發儲存依呼叫順序串行化，相同 revision 只有第一筆成功', async (t) => {
  const { manager } = await createHarness(t);
  const initial = await manager.initialize();
  const first = structuredClone(initial.config);
  const second = structuredClone(initial.config);
  first.appearance.backgroundColor = '#111111';
  second.appearance.backgroundColor = '#222222';

  const results = await Promise.allSettled([
    manager.saveConfig(first, 0),
    manager.saveConfig(second, 0),
  ]);

  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason instanceof ConfigConflictError, true);
  assert.equal(manager.getSnapshot().revision, 1);
  assert.equal(manager.getSnapshot().config.appearance.backgroundColor, '#111111');
});

test('原子取代失敗時清理暫存檔，保留舊檔、狀態與 revision', async (t) => {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-write-failure-'),
  );
  const configPath = path.join(directory, 'config.json');
  const defaults = await readBundledDefault();
  const originalText = `${JSON.stringify(defaults, null, 2)}\n`;
  await fileSystem.writeFile(configPath, originalText, 'utf8');
  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  let shouldFailRename = true;
  const manager = new ConfigManager({
    defaultConfigPath: bundledDefaultPath,
    configPath,
    fileSystem: {
      ...fileSystem,
      async rename(sourcePath, destinationPath) {
        if (shouldFailRename) {
          const error = new Error('simulated private temp path');
          error.code = 'EACCES';
          throw error;
        }

        return fileSystem.rename(sourcePath, destinationPath);
      },
    },
  });
  const initial = await manager.initialize();
  const next = structuredClone(initial.config);
  next.marquee.enabled = false;

  await assert.rejects(manager.saveConfig(next, 0));

  assert.deepEqual(manager.getSnapshot(), initial);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);
  assert.deepEqual(await fileSystem.readdir(directory), ['config.json']);

  shouldFailRename = false;
  const retried = await manager.saveConfig(next, 0);
  assert.equal(retried.revision, 1);
  assert.equal(retried.config.marquee.enabled, false);
});
