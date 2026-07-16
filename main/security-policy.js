'use strict';

const BLOCKED_NETWORK_URLS = Object.freeze([
  'http://*/*',
  'https://*/*',
  'ws://*/*',
  'wss://*/*',
  'ftp://*/*',
]);

/**
 * 將 DisplayCore 專用 Session 限制為完全離線。
 *
 * 系統不需要網路、下載、相機、麥克風、通知或其他裝置權限，因此採取
 * 預設全部拒絕的策略。自訂 displaycore: 協定不在阻擋清單內，可繼續載入
 * 應用程式封裝內的靜態資源。
 *
 * @param {Electron.Session} appSession
 */
function configureOfflineSession(appSession) {
  if (!appSession) {
    throw new TypeError('設定安全政策時必須提供 Session。');
  }

  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  appSession.setDevicePermissionHandler(() => false);

  appSession.webRequest.onBeforeRequest(
    { urls: [...BLOCKED_NETWORK_URLS] },
    (_details, callback) => {
      callback({ cancel: true });
    },
  );

  appSession.on('will-download', (event) => {
    event.preventDefault();
  });
}

/**
 * 限制單一 Renderer 不得自行導覽、開新視窗或附加 WebView。
 *
 * 主程序仍可透過 BrowserWindow.loadURL 載入白名單中的初始頁面；Renderer
 * 自己發起的後續導覽則一律拒絕。
 *
 * @param {Electron.WebContents} webContents
 */
function hardenWebContents(webContents) {
  if (!webContents) {
    throw new TypeError('套用安全政策時必須提供 WebContents。');
  }

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  for (const eventName of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview',
  ]) {
    webContents.on(eventName, (event) => {
      event.preventDefault();
    });
  }
}

module.exports = {
  BLOCKED_NETWORK_URLS,
  configureOfflineSession,
  hardenWebContents,
};
