'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IPC_CHANNELS, IPC_ROLES } = require('../../ipc/channels');
const { IpcCoordinator } = require('../../ipc/ipc-coordinator');
const { PresentationService } = require('../../ipc/presentation-service');
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

function createEvent(
  browserWindow,
  senderFrame = browserWindow.webContents.mainFrame,
) {
  return {
    sender: browserWindow.webContents,
    senderFrame,
  };
}

function createProgram(messageCount = 1, repeat = { mode: 'continuous' }) {
  return {
    messages: Array.from({ length: messageCount }, (_value, index) => ({
      message: `訊息${index + 1}`,
    })),
    pageDurationSeconds: 3,
    repeat,
  };
}

function createHarness({ presentationService = null } = {}) {
  const ipcMain = new FakeIpcMain();
  const windows = {
    [IPC_ROLES.CONTROL]: createWindow(CONTROL_URL),
    [IPC_ROLES.DISPLAY]: createWindow(DISPLAY_URL),
  };
  const warnings = [];
  const errors = [];
  const timers = [];
  const service = presentationService || new PresentationService({
    store: new PresentationStore(),
    setTimer(callback, delay) {
      const handle = { callback, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
  });
  const coordinator = new IpcCoordinator({
    ipcMain,
    presentationService: service,
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
    presentationService: service,
    timers,
    warnings,
    windows,
  };
}

test('Control 啟動清單、滿屏與清除時，Main 對兩個角色發布相同 snapshot', async () => {
  const { ipcMain, windows } = createHarness();
  const controlEvent = createEvent(windows.control);
  const displayEvent = createEvent(windows.display);

  const initial = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_GET_PRESENTATION,
    controlEvent,
  );
  const shown = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    controlEvent,
    createProgram(1),
  );
  const displaySnapshot = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
    displayEvent,
  );
  const emergency = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
    controlEvent,
    { code: '888' },
  );
  const cleared = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
    controlEvent,
  );

  assert.equal(initial.ok, true);
  assert.equal(initial.data.mode, 'blank');
  assert.deepEqual(shown, {
    ok: true,
    data: {
      mode: 'page',
      messages: [{ message: '訊息1' }],
      layout: 'single-line',
      pageDurationSeconds: 3,
      pageNumber: 1,
      pageCount: 1,
      roundNumber: null,
      totalRounds: null,
      revision: 1,
    },
  });
  assert.deepEqual(displaySnapshot, shown);
  assert.equal(emergency.data.mode, 'emergency');
  assert.equal(emergency.data.messages[0].message, '888');
  assert.equal(cleared.data.mode, 'blank');
  assert.equal(cleared.data.revision, 3);

  for (const role of [IPC_ROLES.CONTROL, IPC_ROLES.DISPLAY]) {
    assert.deepEqual(
      windows[role].webContents.sent.map(({ payload }) => payload.revision),
      [1, 2, 3],
    );
  }
});

test('Main scheduler 翻頁與完成清空也會發布，不需要 Display 回報 timer', async () => {
  const { ipcMain, presentationService, timers, windows } = createHarness();
  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    createEvent(windows.control),
    createProgram(6, { mode: 'finite', rounds: 1 }),
  );

  assert.equal(result.ok, true);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 3_000);

  timers[0].cleared = true;
  timers[0].callback();
  assert.equal(presentationService.getSnapshot().pageNumber, 2);
  assert.equal(timers.length, 2);

  timers[1].cleared = true;
  timers[1].callback();
  assert.equal(presentationService.getSnapshot().mode, 'blank');
  assert.deepEqual(
    windows.display.webContents.sent.map(({ payload }) => payload.revision),
    [1, 2, 3],
  );
});

test('Display、subframe、錯誤 URL、null frame 與舊視窗都不能冒充 Control', async () => {
  const { ipcMain, presentationService, windows } = createHarness();
  const oldControlWindow = windows.control;
  const assertForbidden = async (event) => {
    const result = await ipcMain.invoke(
      IPC_CHANNELS.CONTROL_START_PROGRAM,
      event,
      createProgram(),
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

  oldControlWindow.webContents.mainFrame.url = DISPLAY_URL;
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

  assert.equal(presentationService.getSnapshot().revision, 0);
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

test('Main 原子拒絕不合法 program 與 emergency，不改變狀態、timer 或廣播', async () => {
  const { ipcMain, presentationService, timers, windows } = createHarness();
  const controlEvent = createEvent(windows.control);
  const invalidProgram = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    controlEvent,
    {
      ...createProgram(),
      title: '禁止欄位',
    },
  );
  const invalidEmergency = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
    controlEvent,
    { code: '999' },
  );

  assert.equal(invalidProgram.ok, false);
  assert.equal(invalidProgram.error.code, 'VALIDATION_FAILED');
  assert.equal(invalidEmergency.ok, false);
  assert.equal(presentationService.getSnapshot().revision, 0);
  assert.equal(timers.length, 0);
  assert.equal(windows.control.webContents.sent.length, 0);
  assert.equal(windows.display.webContents.sent.length, 0);
});

test('Display 已銷毀時 Main 仍保存清單，等待重建 Renderer 取得最新頁', async () => {
  const { ipcMain, presentationService, warnings, windows } = createHarness();
  windows.display.webContents.destroyed = true;

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    createEvent(windows.control),
    createProgram(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(presentationService.getSnapshot(), result.data);
  assert.equal(windows.control.webContents.sent.length, 1);
  assert.equal(windows.display.webContents.sent.length, 0);
  assert.equal(warnings.length, 0);
});

test('內部錯誤使用固定 envelope，不洩漏路徑或 stack', async () => {
  const presentationService = new PresentationService();
  presentationService.startProgram = () => {
    throw new Error('/Users/operator/private/config.json');
  };
  const { errors, ipcMain, windows } = createHarness({ presentationService });

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    createEvent(windows.control),
    createProgram(),
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

test('IPC handlers 與 service subscription 只註冊一次並可完整移除', () => {
  const { coordinator, ipcMain, presentationService, windows } = createHarness();
  const requestChannels = [
    IPC_CHANNELS.CONTROL_GET_PRESENTATION,
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
    IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
  ];

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), requestChannels.sort());

  coordinator.register();
  assert.equal(ipcMain.handlers.size, requestChannels.length);

  coordinator.dispose();
  presentationService.showEmergency('555');
  assert.equal(ipcMain.handlers.size, 0);
  assert.deepEqual(ipcMain.removedChannels.sort(), requestChannels.sort());
  assert.equal(windows.control.webContents.sent.length, 0);
});
