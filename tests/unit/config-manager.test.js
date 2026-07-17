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

async function readBundledDefault() {
  return JSON.parse(await fileSystem.readFile(bundledDefaultPath, 'utf8'));
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
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.notice, null);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.config), true);
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

test('既有 v1 使用者設定在記憶體升級為 v2且不擅自覆寫原檔', async (t) => {
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

  assert.equal(snapshot.config.configVersion, 2);
  assert.equal(snapshot.config.appearance.backgroundColor, '#123ABC');
  assert.equal(snapshot.config.appearance.fontColor, '#FEDCBA');
  assert.equal(snapshot.config.appearance.fontSizePercent, 100);
  assert.equal(snapshot.config.appearance.lineSpacingPercent, 100);
  assert.deepEqual(snapshot.config.dateTime, { enabled: true });
  assert.deepEqual(snapshot.config.emergency, snapshot.defaults.emergency);
  assert.equal(snapshot.notice, null);
  assert.equal(await fileSystem.readFile(configPath, 'utf8'), originalText);

  const saved = await manager.saveConfig(
    structuredClone(snapshot.config),
    snapshot.revision,
  );
  assert.equal(
    JSON.parse(await fileSystem.readFile(configPath, 'utf8')).configVersion,
    2,
  );
  assert.equal(saved.revision, 1);
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

test('無效設定與過期 revision 不會改變既有檔案或記憶體', async (t) => {
  const { configPath, manager } = await createHarness(t);
  const initial = await manager.initialize();
  const originalText = await fileSystem.readFile(configPath, 'utf8');
  const invalid = structuredClone(initial.config);
  invalid.appearance.fontColor = 'red';

  await assert.rejects(
    manager.saveConfig(invalid, initial.revision),
    (error) =>
      error instanceof ConfigValidationError &&
      error.validationError.field === 'appearance.fontColor',
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
