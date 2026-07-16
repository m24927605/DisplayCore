'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  FuseV1Options,
  FuseVersion,
} = require('@electron/fuses');
const {
  createFuseConfig,
  finalizeDarwinSignature,
  flipPackageFuses,
  resolveElectronExecutable,
  signAdHocAppBundle,
} = require('../../config/forge-fuses');

test('封裝明確設定 Electron 43 的全部九個 fuse 並啟用嚴格模式', () => {
  const config = createFuseConfig({
    platform: 'win32',
    arch: 'x64',
    hasOsxSign: false,
  });

  assert.equal(config.version, FuseVersion.V1);
  assert.equal(config.strictlyRequireAllFuses, true);
  assert.equal(config.resetAdHocDarwinSignature, false);
  assert.equal(config[FuseV1Options.RunAsNode], false);
  assert.equal(config[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(
    config[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
    false,
  );
  assert.equal(config[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(
    config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    true,
  );
  assert.equal(config[FuseV1Options.OnlyLoadAppFromAsar], true);
  assert.equal(
    config[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot],
    false,
  );
  assert.equal(
    config[FuseV1Options.GrantFileProtocolExtraPrivileges],
    false,
  );
  assert.equal(config[FuseV1Options.WasmTrapHandlers], false);

  const configuredIndexes = Object.keys(config)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((first, second) => first - second);
  assert.deepEqual(configuredIndexes, Array.from({ length: 9 }, (_, index) => index));
});

test('packageAfterCopy 不提早重建 ad-hoc signature，避免後續 Info.plist 變更使其失效', () => {
  assert.equal(
    createFuseConfig({
      platform: 'darwin',
      arch: 'arm64',
      hasOsxSign: false,
    }).resetAdHocDarwinSignature,
    false,
  );
  assert.equal(
    createFuseConfig({
      platform: 'darwin',
      arch: 'arm64',
      hasOsxSign: true,
    }).resetAdHocDarwinSignature,
    false,
  );
});

test('postPackage 對未正式簽章的 Apple Silicon 最終 app bundle 重建 ad-hoc signature', async () => {
  const signedBundles = [];
  const outputPath = path.join('/tmp', 'DisplayCore-darwin-arm64');

  const bundlePaths = await finalizeDarwinSignature({
    forgeConfig: { packagerConfig: {} },
    packageResult: {
      platform: 'darwin',
      arch: 'arm64',
      outputPaths: [outputPath],
    },
    listDirectory: async () => [
      { name: 'DisplayCore.app', isDirectory: () => true },
      { name: 'LICENSE', isDirectory: () => false },
    ],
    signAppBundle: async (bundlePath) => signedBundles.push(bundlePath),
  });

  const expectedBundle = path.join(outputPath, 'DisplayCore.app');
  assert.deepEqual(bundlePaths, [expectedBundle]);
  assert.deepEqual(signedBundles, [expectedBundle]);
});

test('postPackage 不覆蓋正式 macOS 簽章，也不處理 Windows 封裝', async () => {
  let calls = 0;
  const dependencies = {
    listDirectory: async () => {
      calls += 1;
      return [];
    },
    signAppBundle: async () => {
      calls += 1;
    },
  };

  assert.deepEqual(
    await finalizeDarwinSignature({
      forgeConfig: { packagerConfig: { osxSign: { identity: 'Developer ID' } } },
      packageResult: {
        platform: 'darwin',
        arch: 'arm64',
        outputPaths: ['/tmp/signed'],
      },
      ...dependencies,
    }),
    [],
  );
  assert.deepEqual(
    await finalizeDarwinSignature({
      // Electron Packager 將 truthy 的空物件也視為啟用正式簽章。
      forgeConfig: { packagerConfig: { osxSign: {} } },
      packageResult: {
        platform: 'darwin',
        arch: 'arm64',
        outputPaths: ['/tmp/signed-with-defaults'],
      },
      ...dependencies,
    }),
    [],
  );
  assert.deepEqual(
    await finalizeDarwinSignature({
      forgeConfig: { packagerConfig: {} },
      packageResult: {
        platform: 'win32',
        arch: 'x64',
        outputPaths: ['/tmp/windows'],
      },
      ...dependencies,
    }),
    [],
  );
  assert.equal(calls, 0);
});

test('ad-hoc 簽章使用固定 codesign 參數且保留既有安全 metadata', async () => {
  const calls = [];

  await signAdHocAppBundle('/tmp/DisplayCore.app', async (...args) => {
    calls.push(args);
  });

  assert.deepEqual(calls, [
    [
      'codesign',
      [
        '--sign',
        '-',
        '--force',
        '--preserve-metadata=entitlements,requirements,flags,runtime',
        '--deep',
        '/tmp/DisplayCore.app',
      ],
    ],
  ]);
});

test('依 packageAfterCopy 平台解析尚未改名的 Electron 執行檔', () => {
  const buildPath = path.join('/tmp', 'DisplayCore', 'resources', 'app');

  assert.equal(
    resolveElectronExecutable(buildPath, 'win32'),
    path.join('/tmp', 'DisplayCore', 'electron.exe'),
  );
  assert.equal(
    resolveElectronExecutable(buildPath, 'linux'),
    path.join('/tmp', 'DisplayCore', 'electron'),
  );
  assert.equal(
    resolveElectronExecutable(
      path.join('/tmp', 'Electron.app', 'Contents', 'Resources', 'app'),
      'darwin',
    ),
    path.join('/tmp', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  );
});

test('Forge hook 只把解析後執行檔與完整設定交給 flipFuses', async () => {
  const calls = [];
  const buildPath = path.join('/tmp', 'DisplayCore', 'resources', 'app');
  const forgeConfig = { packagerConfig: {} };

  await flipPackageFuses({
    forgeConfig,
    buildPath,
    platform: 'win32',
    arch: 'x64',
    flipFuses: async (...args) => calls.push(args),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], path.join('/tmp', 'DisplayCore', 'electron.exe'));
  assert.equal(calls[0][1].strictlyRequireAllFuses, true);
  assert.equal(calls[0][1][FuseV1Options.WasmTrapHandlers], false);
});
