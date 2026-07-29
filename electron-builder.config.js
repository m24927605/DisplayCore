'use strict';

/**
 * Windows NSIS 安裝精靈設定。
 *
 * Electron Forge 先完成 ASAR、安全排除與 Fuses，再由 electron-builder
 * 讀取 prepackaged 目錄建立安裝檔，避免兩套封裝工具產生不同的應用內容。
 */
module.exports = {
  appId: 'com.displaycore.desktop',
  productName: 'DisplayCore',
  directories: {
    output: 'out/make/nsis/x64',
  },
  win: {
    executableName: 'DisplayCore',
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  nsis: {
    artifactName: 'DisplayCoreSetup.${ext}',
    // assisted installer 才會顯示安裝目錄頁面。
    oneClick: false,
    // 專用顯示主機採整台電腦安裝，避免不同 Windows 帳號各裝一份。
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    // 安裝完成後由操作員啟動；CI 也能明確驗證真正的啟動結果。
    runAfterFinish: false,
    shortcutName: 'DisplayCore',
  },
};
