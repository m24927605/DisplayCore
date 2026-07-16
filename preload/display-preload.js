'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// Display 只能讀狀態並回報目前 layout；翻頁、清除與 emergency 仍由 Main 決定。
const CHANNELS = Object.freeze({
  GET_PRESENTATION: 'dc:v2:display:presentation:get',
  GET_SETTINGS: 'dc:v2:display:settings:get',
  PRESENTATION_CHANGED: 'dc:v2:display:presentation:changed',
  SETTINGS_CHANGED: 'dc:v2:display:settings:changed',
  REPORT_PAGE_PROGRESS: 'dc:v2:display:page-progress:report',
  REFIT_REQUESTED: 'dc:v2:display:layout:refit-requested',
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

function onRefitRequested(listener) {
  return subscribe(CHANNELS.REFIT_REQUESTED, listener);
}

function reportPageProgress(
  phase,
  revision,
  pageNumber,
  settingsRevision,
  displayEpoch,
  layoutGeneration,
  marqueeCount,
) {
  const payload = {
    phase,
    revision,
    pageNumber,
    settingsRevision,
    displayEpoch,
    layoutGeneration,
  };

  // exact schema 只有 ready 能攜帶跑馬燈列數。
  if (phase === 'ready') {
    payload.marqueeCount = marqueeCount;
  }

  return ipcRenderer.invoke(CHANNELS.REPORT_PAGE_PROGRESS, payload);
}

contextBridge.exposeInMainWorld(
  'displayCoreDisplay',
  Object.freeze({
    getPresentation: () => ipcRenderer.invoke(CHANNELS.GET_PRESENTATION),
    getSettings: () => ipcRenderer.invoke(CHANNELS.GET_SETTINGS),
    onPresentationChanged,
    onRefitRequested,
    onSettingsChanged,
    reportPageProgress,
  }),
);
