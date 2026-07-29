'use strict';

const {
  finalizeDarwinSignature,
  flipPackageFuses,
} = require('./config/forge-fuses');

/**
 * Electron Forge 建置設定。
 *
 * Forge 負責安全封裝與 Electron Fuses；Windows 安裝精靈由 NSIS 對封裝結果
 * 建立完全離線的 DisplayCoreSetup.exe。
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
      /^\/\.github(?:\/|$)/,
      /^\/release(?:\/|$)/,
      /^\/electron-builder\.config\.js$/,
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
  makers: [],
};
