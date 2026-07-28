'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyDisplayFullscreenPlacement,
  getDisplayAlwaysOnTopLevel,
} = require('../../main/display-signage-mode');

class FakeDisplayWindow {
  constructor({ simpleFullscreen = true } = {}) {
    this.calls = [];
    this.simpleFullscreen = simpleFullscreen;
  }

  setFullScreen(enabled) {
    this.calls.push({ method: 'setFullScreen', enabled });
  }

  setSimpleFullScreen(enabled) {
    this.calls.push({ method: 'setSimpleFullScreen', enabled });

    if (enabled) {
      this.simpleFullscreen = true;
    }
  }

  isSimpleFullScreen() {
    this.calls.push({ method: 'isSimpleFullScreen' });
    return this.simpleFullscreen;
  }

  setBounds(bounds, animate) {
    this.calls.push({ method: 'setBounds', bounds, animate });
  }
}

const targetBounds = Object.freeze({
  x: 1440,
  y: 0,
  width: 1920,
  height: 1200,
});

test('macOS signage 依序退出簡易全螢幕、定位、重新進入並驗證結果', () => {
  const displayWindow = new FakeDisplayWindow();

  applyDisplayFullscreenPlacement(displayWindow, targetBounds, {
    platform: 'darwin',
  });

  assert.deepEqual(displayWindow.calls, [
    { method: 'setSimpleFullScreen', enabled: false },
    { method: 'setBounds', bounds: targetBounds, animate: false },
    { method: 'setSimpleFullScreen', enabled: true },
    { method: 'isSimpleFullScreen' },
  ]);
});

test('macOS 無法真正進入簡易全螢幕時必須回報失敗', () => {
  const displayWindow = new FakeDisplayWindow({ simpleFullscreen: false });
  displayWindow.setSimpleFullScreen = function setSimpleFullScreen(enabled) {
    this.calls.push({ method: 'setSimpleFullScreen', enabled });
  };

  assert.throws(
    () => applyDisplayFullscreenPlacement(displayWindow, targetBounds, {
      platform: 'darwin',
    }),
    /macOS Display Window 無法進入簡易全螢幕/,
  );
});

test('Windows 保留原生全螢幕退出、定位、重新進入流程', () => {
  const displayWindow = new FakeDisplayWindow();

  applyDisplayFullscreenPlacement(displayWindow, targetBounds, {
    platform: 'win32',
  });

  assert.deepEqual(displayWindow.calls, [
    { method: 'setFullScreen', enabled: false },
    { method: 'setBounds', bounds: targetBounds, animate: false },
    { method: 'setFullScreen', enabled: true },
  ]);
});

test('Display 置頂層級只在 macOS signage 提升為 pop-up-menu', () => {
  assert.equal(getDisplayAlwaysOnTopLevel('darwin'), 'pop-up-menu');
  assert.equal(getDisplayAlwaysOnTopLevel('win32'), 'floating');
});
