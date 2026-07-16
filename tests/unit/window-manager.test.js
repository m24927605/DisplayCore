'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');

const { WindowManager } = require('../../main/window-manager');

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];

  static loadFailureUrl = null;

  static loadGate = null;

  static deferClosedEvent = false;

  static pendingClosedWindows = [];

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.minimized = false;
    this.destroyedPromise = new Promise((resolve, reject) => {
      this.rejectDestroyedLoad = reject;
    });
    FakeBrowserWindow.instances.push(this);
  }

  async loadURL(url) {
    this.loadedUrl = url;
    const loadWork = (async () => {
      if (FakeBrowserWindow.loadGate) {
        await FakeBrowserWindow.loadGate;
      }

      if (FakeBrowserWindow.loadFailureUrl === url) {
        throw new Error('測試用載入失敗');
      }
    })();

    await Promise.race([loadWork, this.destroyedPromise]);
  }

  show() {
    this.shown = true;
  }

  showInactive() {
    this.shownInactive = true;
  }

  focus() {
    this.focused = true;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.restored = true;
    this.minimized = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.rejectDestroyedLoad(new Error('測試用視窗已銷毀'));

      if (FakeBrowserWindow.deferClosedEvent) {
        FakeBrowserWindow.pendingClosedWindows.push(this);
      } else {
        this.emit('closed');
      }
    }
  }

  static flushClosedEvents() {
    for (const browserWindow of FakeBrowserWindow.pendingClosedWindows.splice(0)) {
      browserWindow.emit('closed');
    }
  }

  setAlwaysOnTop(enabled, level) {
    this.alwaysOnTopCall = { enabled, level };
  }

  setIgnoreMouseEvents(enabled) {
    this.ignoreMouseEvents = enabled;
  }

  setClosable(enabled) {
    this.closable = enabled;
  }
}

function createManager({
  onControlClosed = () => {},
  onRecoveryFailed = () => {},
} = {}) {
  const hardenedWebContents = [];
  const projectRoot = path.resolve(__dirname, '..', '..');
  const appSession = { partition: 'displaycore' };
  const manager = new WindowManager({
    BrowserWindow: FakeBrowserWindow,
    session: appSession,
    controlPreloadPath: path.join(projectRoot, 'preload.js'),
    displayPreloadPath: path.join(projectRoot, 'preload', 'display-preload.js'),
    controlUrl: 'displaycore://app/control/index.html',
    displayUrl: 'displaycore://app/display/index.html',
    hardenWebContents: (webContents) => hardenedWebContents.push(webContents),
    onControlClosed,
    onRecoveryFailed,
    windowedDisplay: false,
  });

  return { hardenedWebContents, manager };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test.beforeEach(() => {
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.loadFailureUrl = null;
  FakeBrowserWindow.loadGate = null;
  FakeBrowserWindow.deferClosedEvent = false;
  FakeBrowserWindow.pendingClosedWindows = [];
});

test('WindowManager 建立並載入安全的 Control 與 Display Window', async () => {
  const { hardenedWebContents, manager } = createManager();

  await manager.createWindows();
  const [controlWindow, displayWindow] = FakeBrowserWindow.instances;

  assert.equal(FakeBrowserWindow.instances.length, 2);
  assert.equal(controlWindow.loadedUrl, 'displaycore://app/control/index.html');
  assert.equal(displayWindow.loadedUrl, 'displaycore://app/display/index.html');
  assert.equal(displayWindow.options.fullscreen, true);
  assert.equal(displayWindow.ignoreMouseEvents, true);
  assert.deepEqual(displayWindow.alwaysOnTopCall, {
    enabled: true,
    level: 'floating',
  });
  assert.equal(displayWindow.shownInactive, true);
  assert.equal(controlWindow.shown, true);
  assert.equal(controlWindow.focused, true);
  assert.deepEqual(controlWindow.alwaysOnTopCall, {
    enabled: true,
    level: 'pop-up-menu',
  });
  assert.deepEqual(hardenedWebContents, [
    controlWindow.webContents,
    displayWindow.webContents,
  ]);
  assert.equal(manager.hasWindows(), true);
});

test('併發建立請求共用同一組視窗', async () => {
  let releaseLoad;
  FakeBrowserWindow.loadGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const { manager } = createManager();

  const firstCreation = manager.createWindows();
  const secondCreation = manager.createWindows();

  assert.equal(FakeBrowserWindow.instances.length, 2);
  releaseLoad();
  await Promise.all([firstCreation, secondCreation]);
  assert.equal(FakeBrowserWindow.instances.length, 2);
});

test('任一視窗載入失敗時清除整組視窗且可重新建立', async () => {
  let closeNotifications = 0;
  FakeBrowserWindow.loadFailureUrl = 'displaycore://app/display/index.html';
  const { manager } = createManager({
    onControlClosed: () => {
      closeNotifications += 1;
    },
  });

  await assert.rejects(() => manager.createWindows(), /測試用載入失敗/);
  assert.equal(FakeBrowserWindow.instances[0].destroyed, true);
  assert.equal(FakeBrowserWindow.instances[1].destroyed, true);
  assert.equal(manager.hasWindows(), false);
  assert.equal(closeNotifications, 0);

  FakeBrowserWindow.loadFailureUrl = null;
  await manager.createWindows();
  assert.equal(FakeBrowserWindow.instances.length, 4);
  assert.equal(manager.hasWindows(), true);
});

test('載入失敗後延遲送達的 closed 事件不會誤觸程式退出', async () => {
  let closeNotifications = 0;
  FakeBrowserWindow.loadFailureUrl = 'displaycore://app/display/index.html';
  FakeBrowserWindow.deferClosedEvent = true;
  const { manager } = createManager({
    onControlClosed: () => {
      closeNotifications += 1;
    },
  });

  await assert.rejects(() => manager.createWindows(), /測試用載入失敗/);
  assert.equal(closeNotifications, 0);

  FakeBrowserWindow.flushClosedEvents();
  assert.equal(closeNotifications, 0);
});

test('Display Renderer 崩潰時會原子重建整組視窗', async () => {
  let closeNotifications = 0;
  const { manager } = createManager({
    onControlClosed: () => {
      closeNotifications += 1;
    },
  });
  await manager.createWindows();
  const [oldControlWindow, oldDisplayWindow] = FakeBrowserWindow.instances;

  oldDisplayWindow.webContents.emit(
    'render-process-gone',
    {},
    { reason: 'crashed' },
  );
  await flushAsyncWork();

  assert.equal(oldControlWindow.destroyed, true);
  assert.equal(oldDisplayWindow.destroyed, true);
  assert.equal(FakeBrowserWindow.instances.length, 4);
  assert.equal(manager.hasWindows(), true);
  assert.equal(closeNotifications, 0);
});

test('Display Window 意外關閉時不會留下孤立的 Control Window', async () => {
  let closeNotifications = 0;
  const { manager } = createManager({
    onControlClosed: () => {
      closeNotifications += 1;
    },
  });
  await manager.createWindows();
  const [oldControlWindow, oldDisplayWindow] = FakeBrowserWindow.instances;

  oldDisplayWindow.destroy();
  await flushAsyncWork();

  assert.equal(oldControlWindow.destroyed, true);
  assert.equal(FakeBrowserWindow.instances.length, 4);
  assert.equal(manager.hasWindows(), true);
  assert.equal(closeNotifications, 0);
});

test('初次載入期間 Renderer 崩潰仍會建立一組全新視窗', async () => {
  let releaseInitialLoad;
  FakeBrowserWindow.loadGate = new Promise((resolve) => {
    releaseInitialLoad = resolve;
  });
  const { manager } = createManager();
  const initialCreation = manager.createWindows();
  const [oldControlWindow, oldDisplayWindow] = FakeBrowserWindow.instances;

  oldDisplayWindow.webContents.emit(
    'render-process-gone',
    {},
    { reason: 'crashed' },
  );
  releaseInitialLoad();

  await initialCreation;
  assert.equal(oldControlWindow.destroyed, true);
  assert.equal(oldDisplayWindow.destroyed, true);
  assert.equal(FakeBrowserWindow.instances.length, 4);
  assert.equal(manager.hasWindows(), true);
});

test('初次載入期間 Display 關閉仍會建立一組全新視窗', async () => {
  let releaseInitialLoad;
  FakeBrowserWindow.loadGate = new Promise((resolve) => {
    releaseInitialLoad = resolve;
  });
  const { manager } = createManager();
  const initialCreation = manager.createWindows();
  const [oldControlWindow, oldDisplayWindow] = FakeBrowserWindow.instances;

  oldDisplayWindow.destroy();
  releaseInitialLoad();

  await initialCreation;
  assert.equal(oldControlWindow.destroyed, true);
  assert.equal(FakeBrowserWindow.instances.length, 4);
  assert.equal(manager.hasWindows(), true);
});

test('自動復原失敗時交由主程序執行致命錯誤策略', async () => {
  const recoveryErrors = [];
  const { manager } = createManager({
    onRecoveryFailed: (error) => {
      recoveryErrors.push(error);
    },
  });
  await manager.createWindows();
  const [, oldDisplayWindow] = FakeBrowserWindow.instances;
  FakeBrowserWindow.loadFailureUrl = 'displaycore://app/display/index.html';

  oldDisplayWindow.webContents.emit(
    'render-process-gone',
    {},
    { reason: 'crashed' },
  );
  await flushAsyncWork();

  assert.equal(recoveryErrors.length, 1);
  assert.match(recoveryErrors[0].message, /測試用載入失敗/);
  assert.equal(manager.hasWindows(), false);
});

test('復原排程後若程式開始退出就不再重建視窗', async () => {
  const { manager } = createManager();
  await manager.createWindows();
  const [oldControlWindow, oldDisplayWindow] = FakeBrowserWindow.instances;

  oldDisplayWindow.webContents.emit(
    'render-process-gone',
    {},
    { reason: 'crashed' },
  );
  manager.prepareForQuit();
  await flushAsyncWork();

  assert.equal(FakeBrowserWindow.instances.length, 2);
  assert.equal(oldControlWindow.destroyed, false);
  assert.equal(oldDisplayWindow.destroyed, false);
});

test('視窗重建載入途中開始退出時會清除新視窗', async () => {
  const { manager } = createManager();
  await manager.createWindows();
  const [, oldDisplayWindow] = FakeBrowserWindow.instances;
  let releaseLoad;
  FakeBrowserWindow.loadGate = new Promise((resolve) => {
    releaseLoad = resolve;
  });

  oldDisplayWindow.webContents.emit(
    'render-process-gone',
    {},
    { reason: 'crashed' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const [, , newControlWindow, newDisplayWindow] = FakeBrowserWindow.instances;

  manager.prepareForQuit();
  releaseLoad();
  await flushAsyncWork();

  assert.equal(FakeBrowserWindow.instances.length, 4);
  assert.equal(newControlWindow.destroyed, true);
  assert.equal(newDisplayWindow.destroyed, true);
  assert.equal(manager.hasWindows(), false);
});

test('第二次啟動會還原並聚焦既有 Control Window', async () => {
  const { manager } = createManager();
  await manager.createWindows();
  const [controlWindow] = FakeBrowserWindow.instances;
  controlWindow.minimized = true;

  manager.focusControlWindow();

  assert.equal(controlWindow.restored, true);
  assert.equal(controlWindow.shown, true);
  assert.equal(controlWindow.focused, true);
});

test('正常關閉 Control 會通知主程序，程式退出前允許 Display 關閉', async () => {
  let closeNotifications = 0;
  const { manager } = createManager({
    onControlClosed: () => {
      closeNotifications += 1;
    },
  });
  await manager.createWindows();
  const [controlWindow, displayWindow] = FakeBrowserWindow.instances;

  controlWindow.emit('closed');
  assert.equal(closeNotifications, 1);

  manager.prepareForQuit();
  assert.equal(displayWindow.closable, true);
});

test('退出準備完成後關閉 Control 不再重複通知退出', async () => {
  let closeNotifications = 0;
  const { manager } = createManager({
    onControlClosed: () => {
      closeNotifications += 1;
    },
  });
  await manager.createWindows();
  const [controlWindow, displayWindow] = FakeBrowserWindow.instances;

  manager.prepareForQuit();
  controlWindow.emit('closed');

  assert.equal(displayWindow.closable, true);
  assert.equal(closeNotifications, 0);
});
