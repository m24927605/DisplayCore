'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Display preload 必須維持唯讀；不得加入任何顯示、清除或設定修改 channel。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v1:display:presentation:get',
  PRESENTATION_CHANGED: 'dc:v1:display:presentation:changed',
});

/**
 * 將 Main 推送的完整 snapshot 交給 Display Renderer，不傳遞 Electron event。
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

/** Display Renderer 僅能讀取與訂閱顯示狀態。 */
contextBridge.exposeInMainWorld(
  'displayCoreDisplay',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    onPresentationChanged,
  }),
);
