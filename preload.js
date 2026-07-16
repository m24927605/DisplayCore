'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Sandboxed preload 無法載入本機 CommonJS 模組；固定字串由契約測試與
// ipc/channels.js 對照，避免為共用模組而降低 Renderer sandbox 權限。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v1:control:presentation:get',
  SHOW_MESSAGE: 'dc:v1:control:message:show',
  CLEAR_MESSAGE: 'dc:v1:control:message:clear',
  PRESENTATION_CHANGED: 'dc:v1:control:presentation:changed',
});

/**
 * 訂閱 Main 主動推送的顯示狀態。
 *
 * Electron event 不可傳入 Renderer，否則 callback 可從 event.sender 取得
 * ipcRenderer。回傳的函式只解除本次建立的 listener。
 *
 * @param {(snapshot: object) => void} listener
 */
function onPresentationChanged(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener 必須是函式。');
  }

  const wrappedListener = (_event, snapshot) => {
    listener(snapshot);
  };

  ipcRenderer.on(CHANNELS.PRESENTATION_CHANGED, wrappedListener);

  return () => {
    ipcRenderer.removeListener(CHANNELS.PRESENTATION_CHANGED, wrappedListener);
  };
}

/**
 * Control Renderer 的最小權限 API。
 *
 * 不暴露 ipcRenderer、channel 或通用 invoke；每個方法只能執行一個固定用途。
 */
contextBridge.exposeInMainWorld(
  'displayCoreControl',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    showMessage: (message, layout = 'single-line') =>
      ipcRenderer.invoke(CHANNELS.SHOW_MESSAGE, { message, layout }),
    clearMessage: () => ipcRenderer.invoke(CHANNELS.CLEAR_MESSAGE),
    onPresentationChanged,
  }),
);
