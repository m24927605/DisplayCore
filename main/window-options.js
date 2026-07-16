'use strict';

const path = require('node:path');

/**
 * 建立 Renderer 共用的安全偏好設定。
 *
 * 即使 Electron 已有部分安全預設值，仍在此明確宣告，避免日後升級或維護時
 * 無意間開啟 Node.js、WebView 或其他不需要的能力。
 *
 * @param {object} options
 * @param {string} options.preloadPath preload 的絕對路徑
 * @param {Electron.Session} options.session DisplayCore 專用 Session
 * @param {boolean} options.devTools 是否允許開啟開發者工具
 * @returns {Electron.WebPreferences}
 */
function createSecureWebPreferences({ preloadPath, session, devTools }) {
  if (!path.isAbsolute(preloadPath)) {
    throw new TypeError('preloadPath 必須是絕對路徑。');
  }

  if (!session) {
    throw new TypeError('建立視窗時必須提供 DisplayCore 專用 Session。');
  }

  return {
    preload: preloadPath,
    session,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: Boolean(devTools),
  };
}

/**
 * 建立 Control Window 的視窗選項。
 *
 * 視窗只提供安全外殼；第 5 步 Control Renderer 透過 preload bridge 使用
 * 固定用途 IPC，仍不能直接接觸 Node.js 或 Electron API。
 *
 * @param {object} options
 * @param {string} options.preloadPath
 * @param {Electron.Session} options.session
 * @param {boolean} options.devTools
 * @returns {Electron.BrowserWindowConstructorOptions}
 */
function createControlWindowOptions({ preloadPath, session, devTools = false }) {
  return {
    show: false,
    frame: true,
    focusable: true,
    autoHideMenuBar: true,
    title: 'DisplayCore 控制台',
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#f3f5f7',
    webPreferences: createSecureWebPreferences({
      preloadPath,
      session,
      devTools,
    }),
  };
}

/**
 * 建立 Display Window 的視窗選項。
 *
 * 正常模式為無框全螢幕；自動測試可使用 16:9 視窗模式，避免測試程序占滿螢幕。
 * 輸出螢幕選擇屬於第 9 步，因此此處交由作業系統先放在預設螢幕。
 *
 * @param {object} options
 * @param {string} options.preloadPath
 * @param {Electron.Session} options.session
 * @param {boolean} options.windowed
 * @returns {Electron.BrowserWindowConstructorOptions}
 */
function createDisplayWindowOptions({ preloadPath, session, windowed = false }) {
  const options = {
    show: false,
    frame: false,
    fullscreen: !windowed,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    backgroundColor: '#000000',
    webPreferences: {
      ...createSecureWebPreferences({
        preloadPath,
        session,
        devTools: false,
      }),
      backgroundThrottling: false,
      disableDialogs: true,
      focusOnNavigation: false,
    },
  };

  if (windowed) {
    options.width = 960;
    options.height = 540;
  }

  return options;
}

module.exports = {
  createControlWindowOptions,
  createDisplayWindowOptions,
};
