'use strict';

const {
  finalizeDarwinSignature,
  flipPackageFuses,
} = require('./config/forge-fuses');

/**
 * Electron Forge 建置設定。
 *
 * DisplayCore 只產生 Windows Squirrel 安裝程式，不設定發布或自動更新服務。
 */
module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'DisplayCore',
    // Electron Packager 以「/」開頭的專案根相對路徑套用 ignore。
    // 排除專案與相依套件的開發產物，正式 Renderer 資源仍完整封裝。
    ignore: [
      /^\/tests(?:\/|$)/,
      /^\/coverage(?:\/|$)/,
      /^\/\.gstack(?:\/|$)/,
      /^\/node_modules\/.*\/(?:test|tests|coverage)(?:\/|$)/,
      /^\/(?:.*\/)?\.?ait(?:\/|$)/i,
      /\.ait$/i,
    ],
  },
  rebuildConfig: {},
  hooks: {
    // 直接使用官方 @electron/fuses API，明確覆蓋 Electron 43 的全部 fuse。
    packageAfterCopy: async (
      forgeConfig,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => flipPackageFuses({ forgeConfig, buildPath, platform, arch }),
    // Apple Silicon 必須等最終 Info.plist 與 bundle 名稱完成後再重建簽章。
    postPackage: async (forgeConfig, packageResult) =>
      finalizeDarwinSignature({ forgeConfig, packageResult }),
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'displaycore',
        setupExe: 'DisplayCoreSetup.exe',
      },
    },
  ],
};
