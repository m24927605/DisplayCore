'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { ApplicationController } = require('../../main/application-controller');

class FakeApp extends EventEmitter {
  constructor({ hasLock = true } = {}) {
    super();
    this.hasLock = hasLock;
    this.quitCalls = 0;
    this.readyCalls = 0;
    this.readyPromise = Promise.resolve();
  }

  requestSingleInstanceLock() {
    return this.hasLock;
  }

  async whenReady() {
    this.readyCalls += 1;
    await this.readyPromise;
  }

  quit() {
    this.quitCalls += 1;
  }
}

function createWindowManager() {
  return {
    createCalls: 0,
    focusCalls: 0,
    prepareCalls: 0,
    windowsExist: false,
    recovering: false,
    createError: null,
    async createWindows() {
      this.createCalls += 1;

      if (this.createError) {
        throw this.createError;
      }

      this.windowsExist = true;
    },
    focusControlWindow() {
      this.focusCalls += 1;
    },
    hasWindows() {
      return this.windowsExist;
    },
    isRecovering() {
      return this.recovering;
    },
    prepareForQuit() {
      this.prepareCalls += 1;
    },
  };
}

test('ApplicationController 依序完成單例、ready、runtime 與視窗建立', async () => {
  const app = new FakeApp();
  const windowManager = createWindowManager();
  let runtimeCalls = 0;
  const controller = new ApplicationController({
    app,
    windowManager,
    initializeRuntime: async () => {
      runtimeCalls += 1;
    },
    platform: 'win32',
    logger: { error() {} },
  });

  assert.equal(await controller.start(), true);
  assert.equal(app.readyCalls, 1);
  assert.equal(runtimeCalls, 1);
  assert.equal(windowManager.createCalls, 1);

  app.emit('second-instance');
  assert.equal(windowManager.focusCalls, 1);

  app.emit('before-quit');
  assert.equal(windowManager.prepareCalls, 1);

  windowManager.windowsExist = false;
  app.emit('window-all-closed');
  assert.equal(app.quitCalls, 1);
});

test('Windows 自動復原期間忽略暫時性的 window-all-closed', async () => {
  const app = new FakeApp();
  const windowManager = createWindowManager();
  const controller = new ApplicationController({
    app,
    windowManager,
    initializeRuntime: async () => {},
    platform: 'win32',
    logger: { error() {} },
  });
  await controller.start();

  windowManager.windowsExist = false;
  windowManager.recovering = true;
  app.emit('window-all-closed');
  assert.equal(app.quitCalls, 0);

  windowManager.recovering = false;
  windowManager.windowsExist = true;
  app.emit('window-all-closed');
  assert.equal(app.quitCalls, 0);
});

test('沒有單例鎖時立即退出且不初始化 runtime', async () => {
  const app = new FakeApp({ hasLock: false });
  const windowManager = createWindowManager();
  let runtimeCalls = 0;
  const controller = new ApplicationController({
    app,
    windowManager,
    initializeRuntime: async () => {
      runtimeCalls += 1;
    },
    platform: 'win32',
    logger: { error() {} },
  });

  assert.equal(await controller.start(), false);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.readyCalls, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(windowManager.createCalls, 0);
});

test('activate 時若視窗已不存在則重新建立', async () => {
  const app = new FakeApp();
  const windowManager = createWindowManager();
  const controller = new ApplicationController({
    app,
    windowManager,
    initializeRuntime: async () => {},
    platform: 'darwin',
    logger: { error() {} },
  });
  await controller.start();
  windowManager.windowsExist = false;

  app.emit('activate');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(windowManager.createCalls, 2);
  app.emit('window-all-closed');
  assert.equal(app.quitCalls, 0);
});

test('activate 時保留既有視窗，非同步建立錯誤交由 logger 記錄', async () => {
  const app = new FakeApp();
  const windowManager = createWindowManager();
  const errors = [];
  const controller = new ApplicationController({
    app,
    windowManager,
    initializeRuntime: async () => {},
    platform: 'win32',
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
  });
  await controller.start();

  app.emit('activate');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windowManager.createCalls, 1);

  windowManager.windowsExist = false;
  windowManager.createError = new Error('測試用重建失敗');
  app.emit('activate');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(windowManager.createCalls, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /重新建立視窗失敗/);
  assert.equal(errors[0][1], windowManager.createError);
});

test('ready 與 runtime 完成前的 activate 不會提前建立視窗', async () => {
  const app = new FakeApp();
  let releaseReady;
  app.readyPromise = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const windowManager = createWindowManager();
  const controller = new ApplicationController({
    app,
    windowManager,
    initializeRuntime: async () => {},
    platform: 'darwin',
    logger: { error() {} },
  });

  const startPromise = controller.start();
  app.emit('activate');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windowManager.createCalls, 0);

  releaseReady();
  await startPromise;
  assert.equal(windowManager.createCalls, 1);
});
