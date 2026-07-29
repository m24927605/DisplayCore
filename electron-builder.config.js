'use strict';

/**
 * Windows NSIS 與原生 MSI 安裝精靈設定。
 *
 * Electron Forge 先完成 ASAR、安全排除與 Fuses，再由 electron-builder
 * 讀取同一份 prepackaged 目錄建立兩種安裝檔，避免不同安裝器包含不同內容。
 */
module.exports = {
  appId: 'com.displaycore.desktop',
  productName: 'DisplayCore',
  directories: {
    output: 'out/make/installers/x64',
  },
  win: {
    executableName: 'DisplayCore',
    // MSI 捷徑必須有實體圖示，否則 WiX 會產生找不到 Icon 的連結錯誤。
    icon: 'assets/app-icon.png',
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
      {
        target: 'msi',
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
  msi: {
    artifactName: 'DisplayCoreSetup.${ext}',
    // 關閉 one-click 才會顯示包含安裝目錄選擇的標準 WiX 精靈。
    oneClick: false,
    perMachine: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: false,
    shortcutName: 'DisplayCore',
    // 此 GUID 是 DisplayCore MSI 的永久升級識別，不可在後續版本變更。
    upgradeCode: '{58070DFC-451A-49BD-878E-B877E9644506}',
    warningsAsErrors: true,
  },
};
