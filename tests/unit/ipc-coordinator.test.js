'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IPC_CHANNELS, IPC_ROLES } = require('../../ipc/channels');
const { IpcCoordinator } = require('../../ipc/ipc-coordinator');
const { PresentationStore } = require('../../ipc/presentation-store');

const CONTROL_URL = 'displaycore://app/control/index.html';
const DISPLAY_URL = 'displaycore://app/display/index.html';
let nextFrameTreeNodeId = 1;

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.removedChannels = [];
  }

  handle(channel, handler) {
    if (this.handlers.has(channel)) {
      throw new Error(`重複註冊 ${channel}`);
    }

    this.handlers.set(channel, handler);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
    this.removedChannels.push(channel);
  }

  async invoke(channel, event, ...args) {
    const handler = this.handlers.get(channel);
    assert.ok(handler, `找不到 handler：${channel}`);
    return handler(event, ...args);
  }
}

function createFrame(url, frameTreeNodeId = nextFrameTreeNodeId++) {
  return {
    detached: false,
    destroyed: false,
    frameTreeNodeId,
    url,
    isDestroyed() {
      return this.destroyed;
    },
  };
}

function createWindow(url) {
  const mainFrame = createFrame(url);
  const webContents = {
    destroyed: false,
    mainFrame,
    sent: [],
    isDestroyed() {
      return this.destroyed;
    },
    send(channel, payload) {
      if (this.destroyed) {
        throw new Error('WebContents 已銷毀');
      }

      this.sent.push({ channel, payload });
    },
  };

  return {
    destroyed: false,
    webContents,
    isDestroyed() {
      return this.destroyed;
    },
  };
}

function createEvent(browserWindow, senderFrame = browserWindow.webContents.mainFrame) {
  return {
    sender: browserWindow.webContents,
    senderFrame,
  };
}

function createHarness({ presentationStore = new PresentationStore() } = {}) {
  const ipcMain = new FakeIpcMain();
  const windows = {
    [IPC_ROLES.CONTROL]: createWindow(CONTROL_URL),
    [IPC_ROLES.DISPLAY]: createWindow(DISPLAY_URL),
  };
  const warnings = [];
  const errors = [];
  const coordinator = new IpcCoordinator({
    ipcMain,
    presentationStore,
    getWindow: (role) => windows[role] || null,
    allowedUrls: {
      [IPC_ROLES.CONTROL]: CONTROL_URL,
      [IPC_ROLES.DISPLAY]: DISPLAY_URL,
    },
    logger: {
      warn(...args) {
        warnings.push(args);
      },
      error(...args) {
        errors.push(args);
      },
    },
  });
  coordinator.register();

  return {
    coordinator,
    errors,
    ipcMain,
    presentationStore,
    warnings,
    windows,
  };
}

test('Control 可顯示與清除，Main 將同一 snapshot 發送至兩個角色', async () => {
  const { ipcMain, windows } = createHarness();
  const controlEvent = createEvent(windows.control);
  const displayEvent = createEvent(windows.display);

  const initial = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_GET_PRESENTATION,
    controlEvent,
  );
  const shown = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
    controlEvent,
    { message: '001請至前廳', layout: 'single-line' },
  );
  const displaySnapshot = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
    displayEvent,
  );
  const cleared = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CLEAR_MESSAGE,
    controlEvent,
  );

  assert.deepEqual(initial, {
    ok: true,
    data: { message: '', layout: 'single-line', revision: 0 },
  });
  assert.deepEqual(shown, {
    ok: true,
    data: { message: '001請至前廳', layout: 'single-line', revision: 1 },
  });
  assert.deepEqual(displaySnapshot, shown);
  assert.deepEqual(cleared, {
    ok: true,
    data: { message: '', layout: 'single-line', revision: 2 },
  });

  assert.deepEqual(
    windows.control.webContents.sent.map(({ channel }) => channel),
    [
      IPC_CHANNELS.CONTROL_PRESENTATION_CHANGED,
      IPC_CHANNELS.CONTROL_PRESENTATION_CHANGED,
    ],
  );
  assert.deepEqual(
    windows.display.webContents.sent.map(({ channel }) => channel),
    [
      IPC_CHANNELS.DISPLAY_PRESENTATION_CHANGED,
      IPC_CHANNELS.DISPLAY_PRESENTATION_CHANGED,
    ],
  );
  assert.deepEqual(
    windows.display.webContents.sent[0].payload,
    shown.data,
  );
});

test('Display、subframe、錯誤 URL、null frame 與舊視窗都不能冒充 Control', async () => {
  const { ipcMain, presentationStore, windows } = createHarness();
  const oldControlWindow = windows.control;
  const assertForbidden = async (event) => {
    const result = await ipcMain.invoke(
      IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
      event,
      { message: '禁止顯示', layout: 'single-line' },
    );

    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: '此視窗沒有執行該操作的權限。',
      },
    });
  };

  await assertForbidden(createEvent(windows.display));
  await assertForbidden(createEvent(oldControlWindow, createFrame(CONTROL_URL)));
  await assertForbidden(createEvent(oldControlWindow, null));

  oldControlWindow.webContents.mainFrame.url =
    'displaycore://app/display/index.html';
  await assertForbidden(createEvent(oldControlWindow));
  oldControlWindow.webContents.mainFrame.url = CONTROL_URL;

  const destroyedFrame = createFrame(
    CONTROL_URL,
    oldControlWindow.webContents.mainFrame.frameTreeNodeId,
  );
  destroyedFrame.destroyed = true;
  await assertForbidden(createEvent(oldControlWindow, destroyedFrame));

  const detachedFrame = createFrame(
    CONTROL_URL,
    oldControlWindow.webContents.mainFrame.frameTreeNodeId,
  );
  detachedFrame.detached = true;
  await assertForbidden(createEvent(oldControlWindow, detachedFrame));

  const unstableFrame = {
    frameTreeNodeId: oldControlWindow.webContents.mainFrame.frameTreeNodeId,
    isDestroyed() {
      return false;
    },
    get detached() {
      throw new Error('/private/native-frame-error');
    },
    url: CONTROL_URL,
  };
  await assertForbidden(createEvent(oldControlWindow, unstableFrame));

  windows.control = createWindow(CONTROL_URL);
  await assertForbidden(createEvent(oldControlWindow));

  assert.equal(presentationStore.getSnapshot().revision, 0);
  assert.equal(windows.display.webContents.sent.length, 0);
});

test('相同 underlying main frame 的不同 WebFrameMain wrapper 可以通過驗證', async () => {
  const { ipcMain, windows } = createHarness();
  const controlFrame = windows.control.webContents.mainFrame;
  const equivalentFrame = createFrame(
    CONTROL_URL,
    controlFrame.frameTreeNodeId,
  );

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_GET_PRESENTATION,
    createEvent(windows.control, equivalentFrame),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.revision, 0);
});

test('Main 端拒絕不合法 payload，且不改變狀態或廣播', async () => {
  const { ipcMain, presentationStore, windows } = createHarness();
  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
    createEvent(windows.control),
    {
      message: '001請至前廳',
      layout: 'single-line',
      title: '不允許拆欄位',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_FAILED');
  assert.equal(presentationStore.getSnapshot().revision, 0);
  assert.equal(windows.control.webContents.sent.length, 0);
  assert.equal(windows.display.webContents.sent.length, 0);
});

test('目標視窗已銷毀時保留 Main 狀態並等待新 Renderer 取得 snapshot', async () => {
  const { ipcMain, presentationStore, warnings, windows } = createHarness();
  windows.display.webContents.destroyed = true;

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
    createEvent(windows.control),
    { message: '公告今日停止服務', layout: 'single-line' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(presentationStore.getSnapshot(), result.data);
  assert.equal(windows.control.webContents.sent.length, 1);
  assert.equal(windows.display.webContents.sent.length, 0);
  assert.equal(warnings.length, 0);
});

test('內部錯誤以固定 envelope 回覆，不向 Renderer 洩漏路徑或 stack', async () => {
  const presentationStore = new PresentationStore();
  presentationStore.showMessage = () => {
    throw new Error('/Users/operator/private/config.json');
  };
  const { errors, ipcMain, windows } = createHarness({ presentationStore });

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
    createEvent(windows.control),
    { message: '001前廳000', layout: 'single-line' },
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: '操作失敗，請稍後再試。',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /Users|config\.json|stack/i);
  assert.equal(errors.length, 1);
});

test('IPC handlers 只註冊一次並可在程式退出時完整移除', () => {
  const { coordinator, ipcMain } = createHarness();
  const requestChannels = [
    IPC_CHANNELS.CONTROL_GET_PRESENTATION,
    IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
    IPC_CHANNELS.CONTROL_CLEAR_MESSAGE,
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
  ];

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), requestChannels.sort());

  coordinator.register();
  assert.equal(ipcMain.handlers.size, requestChannels.length);

  coordinator.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  assert.deepEqual(ipcMain.removedChannels.sort(), requestChannels.sort());
});
