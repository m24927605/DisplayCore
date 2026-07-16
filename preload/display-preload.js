'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Display bridge 永遠唯讀；翻頁、清除與 emergency 全由 Main Process 決定。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v2:display:presentation:get',
  PRESENTATION_CHANGED: 'dc:v2:display:presentation:changed',
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

contextBridge.exposeInMainWorld(
  'displayCoreDisplay',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    onPresentationChanged,
  }),
);
