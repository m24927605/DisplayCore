'use strict';

const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

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
    // 只排除開發產物，避免誤傷 node_modules 內同名目錄或正式 Renderer 資源。
    ignore: [
      /^\/tests(?:\/|$)/,
      /^\/coverage(?:\/|$)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'displaycore',
        setupExe: 'DisplayCoreSetup.exe',
      },
    },
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};
