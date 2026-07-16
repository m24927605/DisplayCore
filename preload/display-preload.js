'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Display bridge 永遠唯讀；翻頁、清除與 emergency 全由 Main Process 決定。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v2:display:presentation:get',
  GET_SETTINGS: 'dc:v2:display:settings:get',
  PRESENTATION_CHANGED: 'dc:v2:display:presentation:changed',
  SETTINGS_CHANGED: 'dc:v2:display:settings:changed',
});

function subscribe(channel, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('listener 必須是函式。');
  }

  const wrappedListener = (_event, snapshot) => {
    listener(snapshot);
  };

  ipcRenderer.on(channel, wrappedListener);

  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

function onPresentationChanged(listener) {
  return subscribe(CHANNELS.PRESENTATION_CHANGED, listener);
}

function onSettingsChanged(listener) {
  return subscribe(CHANNELS.SETTINGS_CHANGED, listener);
}

contextBridge.exposeInMainWorld(
  'displayCoreDisplay',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    getSettings: () => ipcRenderer.invoke(CHANNELS.GET_SETTINGS),
    onPresentationChanged,
    onSettingsChanged,
  }),
);
