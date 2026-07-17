'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Sandboxed preload 不載入本機模組；固定字串由契約測試與 channels.js 對照。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v2:control:presentation:get',
  START_PROGRAM: 'dc:v2:control:program:start',
  SHOW_EMERGENCY: 'dc:v2:control:emergency:show',
  CLEAR_PRESENTATION: 'dc:v2:control:presentation:clear',
  GET_SETTINGS: 'dc:v2:control:settings:get',
  SAVE_SETTINGS: 'dc:v2:control:settings:save',
  CHOOSE_LOGO: 'dc:v2:control:settings:logo:choose',
  CHOOSE_STANDBY_BACKGROUND:
    'dc:v2:control:settings:standby-background:choose',
  GET_OUTPUT_STATUS: 'dc:v2:control:output-status:get',
  PRESENTATION_CHANGED: 'dc:v2:control:presentation:changed',
  OUTPUT_STATUS_CHANGED: 'dc:v2:control:output-status:changed',
});

/** 封裝固定 channel 的安全事件訂閱，不把 Electron event 傳入 Renderer。 */
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

function onOutputStatusChanged(listener) {
  return subscribe(CHANNELS.OUTPUT_STATUS_CHANGED, listener);
}

/** Control Renderer 只能呼叫固定用途的 v2 API，不能取得 raw ipcRenderer。 */
contextBridge.exposeInMainWorld(
  'displayCoreControl',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    startProgram: (
      messages,
      pageDurationSeconds,
      repeat,
      expectedContentRevision,
    ) =>
      ipcRenderer.invoke(CHANNELS.START_PROGRAM, {
        messages,
        pageDurationSeconds,
        repeat,
        expectedContentRevision,
      }),
    showEmergency: (code) =>
      ipcRenderer.invoke(CHANNELS.SHOW_EMERGENCY, { code }),
    clearPresentation: (expectedContentRevision) =>
      ipcRenderer.invoke(CHANNELS.CLEAR_PRESENTATION, {
        expectedContentRevision,
      }),
    getSettings: () => ipcRenderer.invoke(CHANNELS.GET_SETTINGS),
    saveSettings: (config, expectedRevision) =>
      ipcRenderer.invoke(CHANNELS.SAVE_SETTINGS, {
        config,
        expectedRevision,
      }),
    chooseLogo: () => ipcRenderer.invoke(CHANNELS.CHOOSE_LOGO),
    chooseStandbyBackground: (backgroundMode) =>
      ipcRenderer.invoke(CHANNELS.CHOOSE_STANDBY_BACKGROUND, {
        backgroundMode,
      }),
    getOutputStatus: () => ipcRenderer.invoke(CHANNELS.GET_OUTPUT_STATUS),
    onPresentationChanged,
    onOutputStatusChanged,
  }),
);
