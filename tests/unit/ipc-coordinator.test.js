'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IPC_CHANNELS, IPC_ROLES } = require('../../ipc/channels');
const { IpcCoordinator } = require('../../ipc/ipc-coordinator');
const { PresentationService } = require('../../ipc/presentation-service');
const { PresentationStore } = require('../../ipc/presentation-store');

const defaultConfig = require('../../config.json');

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

function createSettingsManager() {
  let snapshot = Object.freeze({
    config: defaultConfig,
    defaults: defaultConfig,
    revision: 0,
    notice: null,
  });

  const listeners = new Set();

  return {
    saved: [],
    listeners,
    getSnapshot() {
      return snapshot;
    },
    async saveConfig(config, expectedRevision) {
      this.saved.push({ config, expectedRevision });
      snapshot = Object.freeze({
        config,
        defaults: defaultConfig,
        revision: expectedRevision + 1,
        notice: null,
      });
      this.publish(snapshot);
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(nextSnapshot = snapshot) {
      for (const listener of listeners) {
        listener(nextSnapshot);
      }
    },
  };
}

function createTopologySnapshot(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    topologyStatus: 'ready',
    hdmiConnectionStatus: 'detecting',
    displays: Object.freeze([Object.freeze({
      id: 1,
      label: '主螢幕',
      width: 1920,
      height: 1080,
      scaleFactor: 1,
      isPrimary: true,
      isInternal: true,
    })]),
    effectiveDisplayId: 1,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    secondDisplayConnected: false,
    configRevision: 0,
    revision: 0,
    ...overrides,
  });
}

function createPlacementSnapshot(overrides = {}) {
  return Object.freeze({
    status: 'applied',
    displayId: 1,
    fullscreen: true,
    revision: 0,
    ...overrides,
  });
}

/** 建立可手動控制發布順序的唯讀狀態服務。 */
function createOutputStateService(initialSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set();

  return {
    listeners,
    getSnapshot() {
      return snapshot;
    },
    getStatus() {
      return snapshot;
    },
    setSnapshot(nextSnapshot) {
      snapshot = nextSnapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(nextSnapshot = snapshot) {
      snapshot = nextSnapshot;

      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createHarness({
  presentationService = null,
  settingsManager = null,
  logoImporter = null,
  displayTopologyService = null,
  displayPlacementController = null,
} = {}) {
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
  const resolvedSettingsManager = settingsManager || createSettingsManager();
  const resolvedLogoImporter = logoImporter || {
    calls: 0,
    async chooseAndImport() {
      this.calls += 1;
      return { canceled: false, assetPath: 'logos/abc123.png' };
    },
  };
  const resolvedTopologyService = displayTopologyService ||
    createOutputStateService(createTopologySnapshot());
  const resolvedPlacementController = displayPlacementController ||
    createOutputStateService(createPlacementSnapshot());
  const coordinator = new IpcCoordinator({
    ipcMain,
    presentationService: service,
    settingsManager: resolvedSettingsManager,
    logoImporter: resolvedLogoImporter,
    displayTopologyService: resolvedTopologyService,
    displayPlacementController: resolvedPlacementController,
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
    logoImporter: resolvedLogoImporter,
    displayPlacementController: resolvedPlacementController,
    displayTopologyService: resolvedTopologyService,
    presentationService: service,
    settingsManager: resolvedSettingsManager,
    timers,
    warnings,
    windows,
  };
}

test('Control 可取得拓樸與定位的最小輸出快照，Display 角色不可存取', async () => {
  const { ipcMain, windows } = createHarness();

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
    createEvent(windows.control),
  );

  assert.deepEqual(result, {
    ok: true,
    data: {
      schemaVersion: 1,
      topologyStatus: 'ready',
      hdmiConnectionStatus: 'detecting',
      displays: [{
        id: 1,
        label: '主螢幕',
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        isPrimary: true,
        isInternal: true,
      }],
      effectiveDisplayId: 1,
      configuredDisplayId: null,
      selectionMode: 'auto',
      fullscreen: true,
      usingFallback: false,
      configRevision: 0,
      topologyRevision: 0,
      placement: {
        status: 'applied',
        displayId: 1,
        fullscreen: true,
        revision: 0,
      },
    },
  });

  const forbiddenResult = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
    createEvent(windows.display),
  );
  assert.equal(forbiddenResult.ok, false);
  assert.equal(forbiddenResult.error.code, 'FORBIDDEN');
});

test('輸出來源連續發布相同組合時只向 Control 廣播一次', () => {
  const {
    displayPlacementController,
    displayTopologyService,
    windows,
  } = createHarness();
  const nextTopology = createTopologySnapshot({
    hdmiConnectionStatus: 'connected',
    revision: 1,
  });
  const nextPlacement = createPlacementSnapshot({ revision: 1 });

  // 模擬真實 listener 順序：Topology 已提交新狀態，Placement 先發布套用結果，
  // 隨後 Topology 才通知 IPC；兩次讀到的組合完全相同，只能送出一個事件。
  displayTopologyService.setSnapshot(nextTopology);
  displayPlacementController.publish(nextPlacement);
  displayTopologyService.publish(nextTopology);
  displayPlacementController.publish(nextPlacement);

  assert.equal(windows.control.webContents.sent.length, 1);
  assert.equal(windows.display.webContents.sent.length, 0);
  assert.equal(
    windows.control.webContents.sent[0].channel,
    IPC_CHANNELS.CONTROL_OUTPUT_STATUS_CHANGED,
  );
  assert.equal(
    windows.control.webContents.sent[0].payload.topologyRevision,
    1,
  );
  assert.equal(
    windows.control.webContents.sent[0].payload.placement.revision,
    1,
  );

  displayTopologyService.publish(createTopologySnapshot({
    hdmiConnectionStatus: 'not-connected',
    revision: 2,
  }));
  assert.equal(windows.control.webContents.sent.length, 2);
});

test('Control 可讀寫設定與匯入 Logo，Display 無法呼叫特權操作', async () => {
  const { ipcMain, logoImporter, settingsManager, windows } = createHarness();
  const controlEvent = createEvent(windows.control);
  const displayEvent = createEvent(windows.display);
  const config = structuredClone(defaultConfig);
  config.appearance.backgroundColor = '#102030';

  const loaded = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_GET_SETTINGS,
    controlEvent,
  );
  const saved = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    controlEvent,
    { config, expectedRevision: 0 },
  );
  const logo = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
    controlEvent,
  );

  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.revision, 0);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.config.appearance.backgroundColor, '#102030');
  assert.equal(settingsManager.saved.length, 1);
  assert.deepEqual(logo, {
    ok: true,
    data: { canceled: false, assetPath: 'logos/abc123.png' },
  });
  assert.equal(logoImporter.calls, 1);

  for (const channel of [
    IPC_CHANNELS.CONTROL_GET_SETTINGS,
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
  ]) {
    const result = await ipcMain.invoke(
      channel,
      displayEvent,
      { config, expectedRevision: 1 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'FORBIDDEN');
  }
});

test('Display 只能讀取最小設定投影，Control 不能冒充 Display', async () => {
  const { ipcMain, windows } = createHarness();

  const result = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_GET_SETTINGS,
    createEvent(windows.display),
  );

  assert.deepEqual(result, {
    ok: true,
    data: {
      configVersion: 1,
      logo: { enabled: false, url: null },
      appearance: defaultConfig.appearance,
      dateTime: defaultConfig.dateTime,
      marquee: defaultConfig.marquee,
      revision: 0,
    },
  });
  assert.equal(Object.hasOwn(result.data, 'defaults'), false);
  assert.equal(Object.hasOwn(result.data, 'notice'), false);
  assert.equal(Object.hasOwn(result.data, 'display'), false);

  const forbiddenResult = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_GET_SETTINGS,
    createEvent(windows.control),
  );
  assert.equal(forbiddenResult.ok, false);
  assert.equal(forbiddenResult.error.code, 'FORBIDDEN');
});

test('設定原子儲存成功後只向 Display 發布最小設定事件', async () => {
  const { ipcMain, windows } = createHarness();
  const config = structuredClone(defaultConfig);
  config.appearance.backgroundColor = '#123456';
  config.dateTime.enabled = true;

  const saved = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    createEvent(windows.control),
    { config, expectedRevision: 0 },
  );

  assert.equal(saved.ok, true);
  assert.equal(windows.control.webContents.sent.length, 0);
  assert.equal(windows.display.webContents.sent.length, 1);
  assert.equal(
    windows.display.webContents.sent[0].channel,
    IPC_CHANNELS.DISPLAY_SETTINGS_CHANGED,
  );
  assert.deepEqual(windows.display.webContents.sent[0].payload, {
    configVersion: 1,
    logo: { enabled: false, url: null },
    appearance: config.appearance,
    dateTime: config.dateTime,
    marquee: config.marquee,
    revision: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(windows.display.webContents.sent[0].payload),
    /defaults|notice|defaultDisplayId|selectionMode|fullscreen|userData/i,
  );
});

test('Main 原子拒絕畸形設定 payload，不呼叫設定管理器', async () => {
  const { ipcMain, settingsManager, windows } = createHarness();

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    createEvent(windows.control),
    {
      config: { ...defaultConfig, unknown: true },
      expectedRevision: 0,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_FAILED');
  assert.equal(settingsManager.saved.length, 0);
});

test('非同步設定與 Logo 錯誤使用固定 envelope，不洩漏路徑', async () => {
  const settingsManager = createSettingsManager();
  settingsManager.saveConfig = async () => {
    throw new Error('/private/userData/config.json: stack');
  };
  const logoImporter = {
    async chooseAndImport() {
      throw new Error('C:\\Users\\Operator\\秘密Logo.png');
    },
  };
  const { errors, ipcMain, windows } = createHarness({
    settingsManager,
    logoImporter,
  });
  const event = createEvent(windows.control);

  const saveResult = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    event,
    { config: defaultConfig, expectedRevision: 0 },
  );
  const logoResult = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
    event,
  );

  for (const result of [saveResult, logoResult]) {
    assert.deepEqual(result, {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '操作失敗，請稍後再試。',
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /private|Users|Logo\.png|stack/i);
  }
  assert.equal(errors.length, 2);
});

test('設定衝突與 Logo 格式錯誤回傳固定可操作訊息', async () => {
  const settingsManager = createSettingsManager();
  settingsManager.saveConfig = async () => {
    const error = new Error('/private/newer-config.json');
    error.code = 'CONFIG_CONFLICT';
    throw error;
  };
  const logoImporter = {
    async chooseAndImport() {
      const error = new Error('C:\\秘密\\bad.svg');
      error.code = 'LOGO_IMPORT_FAILED';
      throw error;
    },
  };
  const { errors, ipcMain, windows } = createHarness({
    settingsManager,
    logoImporter,
  });
  const event = createEvent(windows.control);

  assert.deepEqual(
    await ipcMain.invoke(
      IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
      event,
      { config: defaultConfig, expectedRevision: 0 },
    ),
    {
      ok: false,
      error: {
        code: 'CONFIG_CONFLICT',
        message: '設定已由另一個操作更新，請重新載入後再儲存。',
      },
    },
  );
  assert.deepEqual(
    await ipcMain.invoke(IPC_CHANNELS.CONTROL_CHOOSE_LOGO, event),
    {
      ok: false,
      error: {
        code: 'LOGO_IMPORT_FAILED',
        message: '無法匯入 Logo，請確認圖片格式與檔案大小。',
      },
    },
  );
  assert.equal(errors.length, 0);
});

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
  const {
    coordinator,
    displayPlacementController,
    displayTopologyService,
    ipcMain,
    presentationService,
    settingsManager,
    windows,
  } = createHarness();
  const requestChannels = [
    IPC_CHANNELS.CONTROL_GET_PRESENTATION,
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
    IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
    IPC_CHANNELS.CONTROL_GET_SETTINGS,
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
    IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
    IPC_CHANNELS.DISPLAY_GET_SETTINGS,
  ];

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), requestChannels.sort());

  coordinator.register();
  assert.equal(ipcMain.handlers.size, requestChannels.length);

  coordinator.dispose();
  presentationService.showEmergency('555');
  settingsManager.publish();
  displayTopologyService.publish(createTopologySnapshot({ revision: 1 }));
  displayPlacementController.publish(createPlacementSnapshot({ revision: 1 }));
  assert.equal(ipcMain.handlers.size, 0);
  assert.deepEqual(ipcMain.removedChannels.sort(), requestChannels.sort());
  assert.equal(windows.control.webContents.sent.length, 0);
  assert.equal(windows.display.webContents.sent.length, 0);
  assert.equal(settingsManager.listeners.size, 0);
  assert.equal(displayTopologyService.listeners.size, 0);
  assert.equal(displayPlacementController.listeners.size, 0);
});
