'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Sandboxed preload 不載入本機模組；固定字串由契約測試與 channels.js 對照。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v2:control:presentation:get',
  START_PROGRAM: 'dc:v2:control:program:start',
  SHOW_EMERGENCY: 'dc:v2:control:emergency:show',
  CLEAR_PRESENTATION: 'dc:v2:control:presentation:clear',
  PRESENTATION_CHANGED: 'dc:v2:control:presentation:changed',
});

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

/** Control Renderer 只能呼叫固定用途的 v2 API，不能取得 raw ipcRenderer。 */
contextBridge.exposeInMainWorld(
  'displayCoreControl',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    startProgram: (messages, pageDurationSeconds, repeat) =>
      ipcRenderer.invoke(CHANNELS.START_PROGRAM, {
        messages,
        pageDurationSeconds,
        repeat,
      }),
    showEmergency: (code) =>
      ipcRenderer.invoke(CHANNELS.SHOW_EMERGENCY, { code }),
    clearPresentation: () =>
      ipcRenderer.invoke(CHANNELS.CLEAR_PRESENTATION),
    onPresentationChanged,
  }),
);
