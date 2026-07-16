'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  configureOfflineSession,
  hardenWebContents,
} = require('../../main/security-policy');

test('Session 拒絕權限、下載與所有網路協定', () => {
  const listeners = new Map();
  const fakeSession = {
    webRequest: {
      onBeforeRequest(filter, listener) {
        this.filter = filter;
        this.listener = listener;
      },
    },
    setPermissionCheckHandler(handler) {
      this.permissionCheckHandler = handler;
    },
    setPermissionRequestHandler(handler) {
      this.permissionRequestHandler = handler;
    },
    setDevicePermissionHandler(handler) {
      this.devicePermissionHandler = handler;
    },
    on(eventName, listener) {
      listeners.set(eventName, listener);
    },
  };

  configureOfflineSession(fakeSession);

  assert.equal(fakeSession.permissionCheckHandler(), false);

  let permissionResult = null;
  fakeSession.permissionRequestHandler(null, 'media', (allowed) => {
    permissionResult = allowed;
  });
  assert.equal(permissionResult, false);
  assert.equal(fakeSession.devicePermissionHandler(), false);

  assert.deepEqual(fakeSession.webRequest.filter.urls, [
    'http://*/*',
    'https://*/*',
    'ws://*/*',
    'wss://*/*',
    'ftp://*/*',
  ]);

  let networkDecision = null;
  fakeSession.webRequest.listener({}, (decision) => {
    networkDecision = decision;
  });
  assert.deepEqual(networkDecision, { cancel: true });

  let downloadPrevented = false;
  listeners.get('will-download')({
    preventDefault() {
      downloadPrevented = true;
    },
  });
  assert.equal(downloadPrevented, true);
});

test('WebContents 拒絕導覽、新視窗與 webview', () => {
  const webContents = new EventEmitter();
  webContents.setWindowOpenHandler = (handler) => {
    webContents.windowOpenHandler = handler;
  };

  hardenWebContents(webContents);

  assert.deepEqual(webContents.windowOpenHandler(), { action: 'deny' });

  for (const eventName of [
    'will-navigate',
    'will-frame-navigate',
    'will-redirect',
    'will-attach-webview',
  ]) {
    let prevented = false;
    webContents.emit(eventName, {
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true, `${eventName} 必須被阻擋`);
  }
});
