'use strict';

const assert = require('node:assert/strict');
const { access, readFile } = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

const requiredDirectories = [
  'assets',
  'config',
  'control',
  'display',
  'ipc',
  'main',
  'preload',
  'tests',
];

const requiredFiles = [
  '.gitignore',
  '.nvmrc',
  'README.md',
  'config.json',
  'forge.config.js',
  'main.js',
  'package.json',
  'preload.js',
];

test('專案包含規劃中的模組化目錄與根目錄檔案', async () => {
  await Promise.all(
    [...requiredDirectories, ...requiredFiles].map((relativePath) =>
      access(path.join(projectRoot, relativePath)),
    ),
  );
});

test('package.json 定義 DisplayCore 與 Electron Forge 指令', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.name, 'displaycore');
  assert.equal(packageJson.productName, 'DisplayCore');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.main, 'main.js');
  assert.equal(packageJson.scripts.start, 'electron-forge start');
  assert.equal(
    packageJson.scripts['start:smoke'],
    'electron-forge start -- --displaycore-smoke-test',
  );
  assert.equal(
    packageJson.scripts['start:main-smoke'],
    'electron-forge start -- --displaycore-main-smoke-test',
  );
  assert.equal(packageJson.scripts.package, 'electron-forge package');
  assert.equal(packageJson.scripts.make, 'electron-forge make');
  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(packageJson.engines.node, '>=24.18.0 <25');
  assert.match(packageJson.devDependencies.electron, /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.devDependencies['@electron-forge/cli'], /^\d+\.\d+\.\d+$/);
});

test('專案未加入網路伺服器、Socket 或資料庫套件', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const installedPackages = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  const forbiddenPackages = [
    'axios',
    'better-sqlite3',
    'express',
    'mongodb',
    'mongoose',
    'mysql',
    'mysql2',
    'node-fetch',
    'socket.io',
    'sqlite3',
    'ws',
  ];

  for (const packageName of forbiddenPackages) {
    assert.equal(installedPackages[packageName], undefined, `${packageName} 不應存在`);
  }
});

test('Electron Fuses 套件支援 WasmTrapHandlers 且不留舊 Forge plugin peer 衝突', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.devDependencies['@electron/fuses'], '2.1.3');
  assert.equal(
    packageJson.devDependencies['@electron-forge/plugin-fuses'],
    undefined,
  );
});

test('Forge 開發工具鏈覆寫為已修補的封裝與暫存套件', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.overrides.tar, '7.5.20');
  assert.equal(packageJson.overrides.tmp, '0.2.7');
});

test('Electron 封裝排除測試、覆蓋率、QA 報告與 AIT 資料', () => {
  const forgeConfig = require('../../forge.config');
  const ignoredPaths = forgeConfig.packagerConfig.ignore;
  const isIgnored = (relativePath) =>
    ignoredPaths.some((pattern) => pattern.test(relativePath));

  assert.ok(Array.isArray(ignoredPaths));
  assert.equal(isIgnored('/tests/unit/window-manager.test.js'), true);
  assert.equal(isIgnored('/coverage/lcov.info'), true);
  assert.equal(isIgnored('/control/index.html'), false);
  assert.equal(isIgnored('/display/index.html'), false);
  assert.equal(isIgnored('/node_modules/example/test/index.test.js'), true);
  assert.equal(isIgnored('/node_modules/example/tests/index.test.js'), true);
  assert.equal(
    isIgnored('/node_modules/@scope/example/coverage/lcov.info'),
    true,
  );
  assert.equal(isIgnored('/.ait/settings.json'), true);
  assert.equal(isIgnored('/ait/settings.json'), true);
  assert.equal(isIgnored('/assets/ait/config.json'), true);
  assert.equal(isIgnored('/assets/wait/config.json'), false);
  assert.equal(isIgnored('/assets/legacy-logo.ait'), true);
  assert.equal(isIgnored('/.gstack/qa-reports/baseline.json'), true);
  assert.equal(isIgnored('/node_modules/example/index.js'), false);
  assert.equal(typeof forgeConfig.hooks.packageAfterCopy, 'function');
  assert.equal(typeof forgeConfig.hooks.postPackage, 'function');
});

test('.gitignore 排除建置產物、相依套件、測試覆蓋率與日誌', async () => {
  const gitignore = await readFile(path.join(projectRoot, '.gitignore'), 'utf8');

  for (const ignoredPath of ['node_modules/', 'out/', 'dist/', 'coverage/', '*.log']) {
    assert.match(gitignore, new RegExp(`^${ignoredPath.replace('*', '\\*')}$`, 'm'));
  }
});

test('config.json 是具版本資訊的有效離線預設設定', async () => {
  const config = JSON.parse(
    await readFile(path.join(projectRoot, 'config.json'), 'utf8'),
  );

  assert.equal(config.configVersion, 4);
  assert.equal(typeof config.appearance.backgroundColor, 'string');
  assert.equal(typeof config.appearance.fontFamily, 'string');
  assert.equal(typeof config.appearance.fontColor, 'string');
  assert.deepEqual(Object.keys(config.dateTime).sort(), [
    'enabled',
    'offsetSeconds',
  ]);
  assert.equal(typeof config.dateTime.enabled, 'boolean');
  assert.equal(Number.isSafeInteger(config.dateTime.offsetSeconds), true);
  assert.ok(config.dateTime.offsetSeconds >= -43_199);
  assert.ok(config.dateTime.offsetSeconds <= 43_200);
  assert.equal(typeof config.marquee.enabled, 'boolean');
  assert.deepEqual(Object.keys(config.playback).sort(), [
    'pageDurationSeconds',
    'repeatMode',
    'roundCount',
  ]);
  assert.equal(Number.isSafeInteger(config.playback.pageDurationSeconds), true);
  assert.ok(config.playback.pageDurationSeconds >= 1);
  assert.ok(config.playback.pageDurationSeconds <= 3_600);
  assert.ok(['finite', 'continuous'].includes(config.playback.repeatMode));
  assert.equal(Number.isSafeInteger(config.playback.roundCount), true);
  assert.ok(config.playback.roundCount >= 1);
  assert.ok(config.playback.roundCount <= 999);
  assert.deepEqual(Object.keys(config.display).sort(), [
    'defaultDisplayId',
    'fullscreen',
    'renderResolution',
    'selectionMode',
  ]);
  assert.equal(typeof config.display.fullscreen, 'boolean');
  assert.ok([
    'auto',
    '1366x768',
    '1600x900',
    '1920x1080',
    '2560x1440',
    '3840x2160',
  ].includes(config.display.renderResolution));
});

test('專案 JavaScript 入口檔通過 Node.js 語法檢查', () => {
  for (const relativePath of ['main.js', 'preload.js', 'forge.config.js']) {
    const result = spawnSync(
      process.execPath,
      ['--check', path.join(projectRoot, relativePath)],
      { encoding: 'utf8' },
    );

    assert.equal(
      result.status,
      0,
      `${relativePath} 語法錯誤：${result.stderr || result.stdout}`,
    );
  }
});

test('Electron 專案骨架可以啟動並正常結束', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['start:smoke'],
    'electron-forge start -- --displaycore-smoke-test',
  );

  const electronBinary = require('electron');
  const result = spawnSync(
    electronBinary,
    [projectRoot, '--displaycore-smoke-test'],
    {
      encoding: 'utf8',
      timeout: 15_000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Electron 專案骨架啟動成功/,
  );
});
