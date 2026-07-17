'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createControlWindowOptions,
  createDisplayWindowOptions,
} = require('../../main/window-options');

const projectRoot = path.resolve(__dirname, '..', '..');
const controlPreloadPath = path.join(projectRoot, 'preload.js');
const displayPreloadPath = path.join(projectRoot, 'preload', 'display-preload.js');
const appSession = { partition: 'displaycore' };

function assertSecureWebPreferences(webPreferences, preloadPath) {
  assert.equal(webPreferences.preload, preloadPath);
  assert.equal(webPreferences.session, appSession);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.nodeIntegrationInWorker, false);
  assert.equal(webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.webSecurity, true);
  assert.equal(webPreferences.allowRunningInsecureContent, false);
  assert.equal(webPreferences.webviewTag, false);
  assert.equal(webPreferences.experimentalFeatures, false);
  assert.equal(webPreferences.navigateOnDragDrop, false);
  assert.equal(webPreferences.spellcheck, false);
}

test('Control Window 使用安全且可操作的視窗設定', () => {
  const options = createControlWindowOptions({
    preloadPath: controlPreloadPath,
    session: appSession,
    devTools: true,
  });

  assert.equal(options.show, false);
  assert.equal(options.frame, true);
  assert.equal(options.focusable, true);
  assert.equal(options.autoHideMenuBar, true);
  assert.equal(options.title, 'DisplayCore 控制台');
  assertSecureWebPreferences(options.webPreferences, controlPreloadPath);
  assert.equal(options.webPreferences.devTools, true);
});

test('Display Window 預設為全螢幕、無框、置頂且不可操作', () => {
  const options = createDisplayWindowOptions({
    preloadPath: displayPreloadPath,
    session: appSession,
    windowed: false,
  });

  assert.equal(options.fullscreen, true);
  assert.equal(options.fullscreenable, true);
  assert.equal(options.frame, false);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.focusable, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.resizable, false);
  assert.equal(options.movable, false);
  assert.equal(options.minimizable, false);
  assert.equal(options.maximizable, false);
  assert.equal(options.closable, false);
  assertSecureWebPreferences(options.webPreferences, displayPreloadPath);
  assert.equal(options.webPreferences.devTools, false);
  assert.equal(options.webPreferences.backgroundThrottling, false);
});

test('第 9 步託管輸出先建立隱藏的非全螢幕視窗，等待定位後再切換', () => {
  const options = createDisplayWindowOptions({
    preloadPath: displayPreloadPath,
    session: appSession,
    managedOutput: true,
  });

  assert.equal(options.show, false);
  assert.equal(options.fullscreen, false);
  assert.equal(options.fullscreenable, true);
  assert.equal(options.frame, false);
  assert.equal(options.focusable, false);
});

test('視窗煙霧測試模式將 Display 限制為 16:9 視窗', () => {
  const options = createDisplayWindowOptions({
    preloadPath: displayPreloadPath,
    session: appSession,
    windowed: true,
  });

  assert.equal(options.fullscreen, false);
  assert.equal(options.fullscreenable, false);
  assert.equal(options.width, 960);
  assert.equal(options.height, 540);
});
