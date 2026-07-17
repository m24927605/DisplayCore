'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const { IPC_ROLES } = require(path.join(projectRoot, 'ipc', 'channels'));
const { IpcCoordinator } = require(
  path.join(projectRoot, 'ipc', 'ipc-coordinator'),
);
const { PresentationService } = require(
  path.join(projectRoot, 'ipc', 'presentation-service'),
);
const { PresentationStore } = require(
  path.join(projectRoot, 'ipc', 'presentation-store'),
);
const defaultConfig = require(path.join(projectRoot, 'config.json'));

const CONTROL_URL = pathToFileURL(path.join(__dirname, 'control.html')).toString();
const DISPLAY_URL = pathToFileURL(path.join(__dirname, 'display.html')).toString();
const TIMEOUT_MS = 10_000;

let controlWindow = null;
let displayWindow = null;
let coordinator = null;
let presentationService = null;
let settingsManager = null;
let completed = false;
let timeout = null;
let controlVerified = false;
let displayVerified = false;

function finish(exitCode, message, error) {
  if (completed) {
    return;
  }

  completed = true;

  if (timeout) {
    clearTimeout(timeout);
  }

  coordinator?.dispose();
  presentationService?.dispose();

  if (error) {
    console.error(message, error);
  } else {
    console.info(message);
  }

  for (const browserWindow of [controlWindow, displayWindow]) {
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  }

  app.exit(exitCode);
}

function createWindow(preload) {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    },
  });
}

/** 建立真實 IPC round-trip 使用的記憶體設定管理器。 */
function createSettingsManager() {
  let snapshot = Object.freeze({
    config: structuredClone(defaultConfig),
    defaults: structuredClone(defaultConfig),
    revision: 0,
    notice: null,
  });
  const listeners = new Set();

  return {
    getSnapshot() {
      return snapshot;
    },
    async saveConfig(config, expectedRevision) {
      if (expectedRevision !== snapshot.revision) {
        const error = new Error('測試設定版本衝突。');
        error.code = 'CONFIG_CONFLICT';
        throw error;
      }

      snapshot = Object.freeze({
        config: structuredClone(config),
        defaults: structuredClone(defaultConfig),
        revision: snapshot.revision + 1,
        notice: null,
      });

      for (const listener of listeners) {
        listener(snapshot);
      }

      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function finishWhenBothRenderersAreVerified() {
  if (controlVerified && displayVerified) {
    finish(0, '[DisplayCore] IPC bridge round-trip succeeded.');
  }
}

async function run() {
  await app.whenReady();

  displayWindow = createWindow(
    path.join(projectRoot, 'preload', 'display-preload.js'),
  );
  controlWindow = createWindow(path.join(projectRoot, 'preload.js'));

  presentationService = new PresentationService({
    store: new PresentationStore(),
  });
  settingsManager = createSettingsManager();
  coordinator = new IpcCoordinator({
    ipcMain,
    presentationService,
    settingsManager,
    getWindow: (role) => {
      if (role === IPC_ROLES.CONTROL) {
        return controlWindow;
      }
      if (role === IPC_ROLES.DISPLAY) {
        return displayWindow;
      }

      return null;
    },
    allowedUrls: {
      [IPC_ROLES.CONTROL]: CONTROL_URL,
      [IPC_ROLES.DISPLAY]: DISPLAY_URL,
    },
    logger: console,
  });
  coordinator.register();

  timeout = setTimeout(() => {
    finish(1, '[DisplayCore] IPC bridge smoke test timed out.');
  }, TIMEOUT_MS);

  for (const browserWindow of [controlWindow, displayWindow]) {
    browserWindow.webContents.on('render-process-gone', (_event, details) => {
      finish(
        1,
        '[DisplayCore] IPC bridge smoke Renderer exited.',
        new Error(details.reason),
      );
    });
  }

  displayWindow.on('page-title-updated', (event, title) => {
    event.preventDefault();

    if (title === 'DISPLAYCORE_DISPLAY_IPC_OK') {
      displayVerified = true;
      finishWhenBothRenderersAreVerified();
    }
  });

  controlWindow.on('page-title-updated', (event, title) => {
    event.preventDefault();

    if (title === 'DISPLAYCORE_CONTROL_IPC_FAILED') {
      finish(1, '[DisplayCore] Control bridge returned an error.');
      return;
    }

    if (title === 'DISPLAYCORE_CONTROL_IPC_OK') {
      controlVerified = true;
      finishWhenBothRenderersAreVerified();
    }
  });

  // Display 必須先完成「訂閱事件，再取得 snapshot」，避免 Control 更新競態。
  await displayWindow.loadURL(DISPLAY_URL);
  await controlWindow.loadURL(CONTROL_URL);
}

run().catch((error) => {
  finish(1, '[DisplayCore] IPC bridge smoke test failed.', error);
});
