'use strict';

const { execFile } = require('node:child_process');
const { readdir } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const {
  flipFuses: flipElectronFuses,
  FuseV1Options,
  FuseVersion,
} = require('@electron/fuses');

const execFileAsync = promisify(execFile);

function hasOsxSigningConfiguration(forgeConfig) {
  // 與 Electron Packager 的判斷一致：包含空物件在內的 truthy 值皆會簽章。
  return Boolean(forgeConfig?.packagerConfig?.osxSign);
}

/**
 * 建立 Electron 43 完整 fuse 設定。
 *
 * strictlyRequireAllFuses 會在 Electron 未來新增 fuse、但本模組還沒有
 * 明確決定時中斷建置，避免安全選項無聲地繼承新預設值。
 */
function createFuseConfig() {
  return {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    // packageAfterCopy 後 Forge 還會修改 bundle；最終 ad-hoc 簽章交由 postPackage。
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    // DisplayCore 不執行 WebAssembly；關閉 signal-handler 路徑後 V8 改用顯式邊界檢查。
    [FuseV1Options.WasmTrapHandlers]: false,
  };
}

/**
 * 對已完成的 macOS app bundle 建立 ad-hoc 簽章。
 *
 * 參數與 @electron/fuses 內建重簽流程一致，並保留既有的安全 metadata。
 */
async function signAdHocAppBundle(
  appBundlePath,
  runCommand = execFileAsync,
) {
  await runCommand('codesign', [
    '--sign',
    '-',
    '--force',
    '--preserve-metadata=entitlements,requirements,flags,runtime',
    '--deep',
    appBundlePath,
  ]);
}

/** 找出 Electron Packager 每個輸出目錄中唯一的最終 app bundle。 */
async function resolveDarwinAppBundles(outputPaths, listDirectory = readdir) {
  if (!Array.isArray(outputPaths) || outputPaths.length === 0) {
    throw new TypeError('macOS 封裝結果必須包含至少一個輸出路徑。');
  }

  const appBundles = [];

  for (const outputPath of outputPaths) {
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      throw new TypeError('macOS 封裝輸出路徑必須是非空字串。');
    }

    if (outputPath.toLowerCase().endsWith('.app')) {
      appBundles.push(outputPath);
      continue;
    }

    const entries = await listDirectory(outputPath, { withFileTypes: true });
    const matches = entries.filter(
      (entry) =>
        entry.isDirectory() && entry.name.toLowerCase().endsWith('.app'),
    );

    if (matches.length !== 1) {
      throw new Error('每個 macOS 封裝輸出目錄必須恰好包含一個 app bundle。');
    }

    appBundles.push(path.join(outputPath, matches[0].name));
  }

  return appBundles;
}

/**
 * 在 Forge 完成所有 bundle 變更後，重建未正式簽章的 Apple Silicon 簽章。
 * 正式 Developer ID 簽章由 Electron Packager 負責，絕不可在此覆蓋。
 */
async function finalizeDarwinSignature({
  forgeConfig,
  packageResult,
  listDirectory = readdir,
  signAppBundle = signAdHocAppBundle,
}) {
  const platform = packageResult?.platform;
  const arch = packageResult?.arch;
  const requiresAdHocSignature =
    ['darwin', 'mas'].includes(platform) &&
    ['arm64', 'universal'].includes(arch) &&
    !hasOsxSigningConfiguration(forgeConfig);

  if (!requiresAdHocSignature) {
    return [];
  }

  const appBundles = await resolveDarwinAppBundles(
    packageResult.outputPaths,
    listDirectory,
  );

  for (const appBundlePath of appBundles) {
    await signAppBundle(appBundlePath);
  }

  return appBundles;
}

/**
 * 解析 Electron Packager 在 packageAfterCopy 階段尚未改名的執行檔。
 */
function resolveElectronExecutable(buildPath, platform) {
  if (typeof buildPath !== 'string' || buildPath.length === 0) {
    throw new TypeError('buildPath 必須是非空字串。');
  }

  const bundleRoot = path.resolve(buildPath, '..', '..');

  if (['darwin', 'mas'].includes(platform)) {
    return path.join(bundleRoot, 'MacOS', 'Electron');
  }

  return path.join(bundleRoot, platform === 'win32' ? 'electron.exe' : 'electron');
}

/** 在封裝後、簽章前寫入全部 fuse。 */
async function flipPackageFuses({
  forgeConfig,
  buildPath,
  platform,
  arch,
  flipFuses = flipElectronFuses,
}) {
  const executablePath = resolveElectronExecutable(buildPath, platform);
  const fuseConfig = createFuseConfig();

  await flipFuses(executablePath, fuseConfig);
}

module.exports = {
  createFuseConfig,
  finalizeDarwinSignature,
  flipPackageFuses,
  resolveElectronExecutable,
  signAdHocAppBundle,
};
