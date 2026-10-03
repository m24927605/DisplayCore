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
let nextWebContentsId = 1;

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
    id: nextWebContentsId++,
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

function createProgram(
  messageCount = 1,
  repeat = { mode: 'continuous' },
  expectedContentRevision = 0,
) {
  return {
    messages: Array.from({ length: messageCount }, (_value, index) => ({
      message: `訊息${index + 1}`,
      alignment: 'left',
    })),
    pageDurationSeconds: 3,
    repeat,
    expectedContentRevision,
  };
}

function createPageProgress(snapshot, phase, overrides = {}) {
  const payload = {
    phase,
    displayEpoch: 1,
    revision: snapshot.revision,
    pageNumber: snapshot.pageNumber,
    settingsRevision: 0,
    layoutGeneration: 1,
    ...overrides,
  };

  if (phase === 'ready' && !Object.hasOwn(payload, 'marqueeCount')) {
    payload.marqueeCount = 0;
  }

  return payload;
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
    effectiveControlDisplayId: 1,
    configuredControlDisplayId: null,
    controlUsingFallback: false,
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

function createMonitorStatus(overrides = {}) {
  return Object.freeze({
    status: 'ready',
    displayId: 1,
    currentResolution: '1920x1080',
    resolutions: Object.freeze(['1920x1080', '1280x720']),
    resolutionError: null,
    brightnessControl: 'hardware',
    contrastControl: 'software',
    brightnessPercent: 65,
    contrastPercent: null,
    revision: 0,
    ...overrides,
  });
}

/** 輸出螢幕控制替身：狀態與軟體調整皆可由測試手動發布。 */
function createOutputMonitorService() {
  const service = createOutputStateService(createMonitorStatus());
  service.adjustment = Object.freeze({
    brightnessPercent: 100,
    contrastPercent: 100,
  });
  service.getSoftwareAdjustment = () => service.adjustment;
  return service;
}

function createHarness({
  presentationService = null,
  settingsManager = null,
  logoImporter = null,
  standbyBackgroundImporter = null,
  displayTopologyService = null,
  displayPlacementController = null,
  outputMonitorController = null,
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
  const resolvedStandbyBackgroundImporter = standbyBackgroundImporter || {
    calls: 0,
    options: [],
    async chooseAndImport(options) {
      this.calls += 1;
      this.options.push(options);
      return {
        canceled: false,
        assetPaths: [
          'standby-backgrounds/0123456789abcdef01234567.png',
          'standby-backgrounds/abcdef0123456789abcdef01.webp',
        ],
      };
    },
  };
  const resolvedTopologyService = displayTopologyService ||
    createOutputStateService(createTopologySnapshot());
  const resolvedPlacementController = displayPlacementController ||
    createOutputStateService(createPlacementSnapshot());
  const resolvedOutputMonitorController = outputMonitorController ||
    createOutputMonitorService();
  const coordinator = new IpcCoordinator({
    ipcMain,
    presentationService: service,
    settingsManager: resolvedSettingsManager,
    logoImporter: resolvedLogoImporter,
    standbyBackgroundImporter: resolvedStandbyBackgroundImporter,
    displayTopologyService: resolvedTopologyService,
    displayPlacementController: resolvedPlacementController,
    outputMonitorController: resolvedOutputMonitorController,
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
    standbyBackgroundImporter: resolvedStandbyBackgroundImporter,
    displayPlacementController: resolvedPlacementController,
    displayTopologyService: resolvedTopologyService,
    outputMonitorController: resolvedOutputMonitorController,
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
      effectiveControlDisplayId: 1,
      configuredControlDisplayId: null,
      controlUsingFallback: false,
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
      monitor: {
        status: 'ready',
        displayId: 1,
        currentResolution: '1920x1080',
        resolutions: ['1920x1080', '1280x720'],
        resolutionError: null,
        brightnessControl: 'hardware',
        contrastControl: 'software',
        brightnessPercent: 65,
        contrastPercent: null,
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

test('Control 可讀寫設定與匯入 Logo／待機背景，Display 無法呼叫特權操作', async () => {
  const {
    ipcMain,
    logoImporter,
    settingsManager,
    standbyBackgroundImporter,
    windows,
  } = createHarness();
  const controlEvent = createEvent(windows.control);
  const displayEvent = createEvent(windows.display);
  const config = structuredClone(defaultConfig);
  config.appearance.backgroundColor = '#102030';
  config.playback.pageDurationSeconds = 8;
  config.playback.repeatMode = 'continuous';
  config.playback.roundCount = 7;

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
  const standbyBackground = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
    controlEvent,
    { backgroundMode: 'slideshow' },
  );

  assert.equal(loaded.ok, true);
  assert.equal(loaded.data.revision, 0);
  assert.equal(loaded.data.config.configVersion, 12);
  assert.equal(loaded.data.config.display.controlDisplayId, null);
  assert.deepEqual(loaded.data.config.playback, defaultConfig.playback);
  assert.equal(saved.ok, true);
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.config.appearance.backgroundColor, '#102030');
  assert.deepEqual(saved.data.config.playback, config.playback);
  assert.equal(settingsManager.saved.length, 1);
  assert.deepEqual(settingsManager.saved[0].config.display, config.display);
  assert.deepEqual(settingsManager.saved[0].config.playback, config.playback);
  assert.deepEqual(logo, {
    ok: true,
    data: { canceled: false, assetPath: 'logos/abc123.png' },
  });
  assert.equal(logoImporter.calls, 1);
  assert.deepEqual(standbyBackground, {
    ok: true,
    data: {
      canceled: false,
      assetPaths: [
        'standby-backgrounds/0123456789abcdef01234567.png',
        'standby-backgrounds/abcdef0123456789abcdef01.webp',
      ],
    },
  });
  assert.deepEqual(Object.keys(standbyBackground).sort(), ['data', 'ok']);
  assert.deepEqual(Object.keys(standbyBackground.data).sort(), [
    'assetPaths',
    'canceled',
  ]);
  assert.equal(standbyBackgroundImporter.calls, 1);
  assert.deepEqual(standbyBackgroundImporter.options, [{ multiple: true }]);

  for (const channel of [
    IPC_CHANNELS.CONTROL_GET_SETTINGS,
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
    IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
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

test('待機背景模式由 Main 驗證，固定單選且無效 payload 不開啟選檔', async () => {
  const { ipcMain, standbyBackgroundImporter, windows } = createHarness();
  const controlEvent = createEvent(windows.control);

  const fixed = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
    controlEvent,
    { backgroundMode: 'fixed' },
  );
  assert.equal(fixed.ok, true);
  assert.deepEqual(standbyBackgroundImporter.options, [{ multiple: false }]);

  for (const payload of [
    undefined,
    {},
    { backgroundMode: 'carousel' },
    { backgroundMode: 'slideshow', extra: true },
  ]) {
    const result = await ipcMain.invoke(
      IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
      controlEvent,
      payload,
    );
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.error.code, 'VALIDATION_FAILED');
  }

  assert.equal(standbyBackgroundImporter.calls, 1);
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
      configVersion: 12,
      logo: {
        enabled: true,
        sizePercent: 100,
        url: 'displaycore://app/managed/logo/6a1befac78d5883759cd1112.png',
      },
      standby: {
        backgroundMode: 'fixed',
        backgroundImageUrls: [],
        sandEffectEnabled: true,
        slideDurationSeconds: 10,
      },
      appearance: defaultConfig.appearance,
      dateTime: defaultConfig.dateTime,
      emergency: defaultConfig.emergency,
      marquee: defaultConfig.marquee,
      revision: 0,
    },
  });
  assert.equal(Object.hasOwn(result.data, 'defaults'), false);
  assert.equal(Object.hasOwn(result.data, 'notice'), false);
  assert.equal(Object.hasOwn(result.data, 'playback'), false);
  assert.equal(
    result.data.appearance.messageLiquidEffectEnabled,
    true,
  );
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
  config.appearance.messageLiquidEffectEnabled = false;
  config.dateTime.enabled = true;
  config.dateTime.offsetSeconds = 3_661;
  config.playback.pageDurationSeconds = 8;
  config.playback.repeatMode = 'continuous';
  config.playback.roundCount = 7;
  config.display.renderResolution = '2560x1440';
  config.logo.sizePercent = 150;

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
    configVersion: 12,
    logo: {
      enabled: true,
      sizePercent: 150,
      url: 'displaycore://app/managed/logo/6a1befac78d5883759cd1112.png',
    },
    standby: {
      backgroundMode: 'fixed',
      backgroundImageUrls: [],
      sandEffectEnabled: true,
      slideDurationSeconds: 10,
    },
    appearance: config.appearance,
    dateTime: config.dateTime,
    emergency: config.emergency,
    marquee: config.marquee,
    revision: 1,
  });
  assert.equal(
    windows.display.webContents.sent[0].payload.appearance
      .messageLiquidEffectEnabled,
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(windows.display.webContents.sent[0].payload),
    /defaults|notice|playback|controlDisplayId|defaultDisplayId|selectionMode|fullscreen|renderResolution|brightness|contrast|userData/i,
  );
});

test('Display 只能讀取軟體亮度／對比調整，狀態改變時只推送一次', async () => {
  const { ipcMain, outputMonitorController, windows } = createHarness();

  const initial = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_GET_OUTPUT_ADJUSTMENT,
    createEvent(windows.display),
  );
  assert.deepEqual(initial, {
    ok: true,
    data: { brightnessPercent: 100, contrastPercent: 100 },
  });

  const forbidden = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_GET_OUTPUT_ADJUSTMENT,
    createEvent(windows.control),
  );
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.error.code, 'FORBIDDEN');

  // 調整值未改變時，狀態更新只送 Control 輸出狀態，不重送 Display 調整。
  outputMonitorController.publish(createMonitorStatus({ revision: 1 }));
  assert.equal(windows.display.webContents.sent.length, 0);

  outputMonitorController.adjustment = Object.freeze({
    brightnessPercent: 40,
    contrastPercent: 100,
  });
  outputMonitorController.publish(createMonitorStatus({
    brightnessControl: 'software',
    revision: 2,
  }));
  outputMonitorController.publish(createMonitorStatus({
    brightnessControl: 'software',
    revision: 2,
  }));

  assert.deepEqual(
    windows.display.webContents.sent.map(({ channel, payload }) => ({
      channel,
      payload,
    })),
    [{
      channel: IPC_CHANNELS.DISPLAY_OUTPUT_ADJUSTMENT_CHANGED,
      payload: { brightnessPercent: 40, contrastPercent: 100 },
    }],
  );
  assert.equal(
    windows.control.webContents.sent.at(-1).payload.monitor.brightnessControl,
    'software',
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

test('待機背景格式錯誤回傳固定可操作訊息，不洩漏原始例外', async () => {
  const standbyBackgroundImporter = {
    async chooseAndImport() {
      const error = new Error('C:\\秘密\\bad-background.svg');
      error.code = 'STANDBY_BACKGROUND_IMPORT_FAILED';
      throw error;
    },
  };
  const { errors, ipcMain, windows } = createHarness({
    standbyBackgroundImporter,
  });

  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
    createEvent(windows.control),
    { backgroundMode: 'slideshow' },
  );

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'STANDBY_BACKGROUND_IMPORT_FAILED',
      message: '無法匯入待機背景圖片，請確認圖片格式與檔案大小。',
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /秘密|bad-background|svg/i);
  assert.equal(errors.length, 0);
});

test('Control 取得完整內容版本，Display 只取得目前頁面 snapshot', async () => {
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
    { expectedContentRevision: 2 },
  );

  assert.equal(initial.ok, true);
  assert.equal(initial.data.mode, 'blank');
  assert.equal(initial.data.emergencyTone, null);
  assert.equal(initial.data.contentRevision, 0);
  assert.deepEqual(shown, {
    ok: true,
    data: {
      mode: 'page',
      messages: [{ message: '訊息1', alignment: 'left' }],
      layout: 'single-line',
      pageDurationSeconds: 3,
      pageNumber: 1,
      pageCount: 1,
      roundNumber: null,
      totalRounds: null,
      emergencyTone: null,
      revision: 1,
      contentRevision: 1,
    },
  });
  assert.equal(displaySnapshot.ok, true);
  assert.equal(displaySnapshot.data.mode, 'page');
  assert.equal(displaySnapshot.data.emergencyTone, null);
  assert.equal(Object.hasOwn(displaySnapshot.data, 'contentRevision'), false);
  assert.equal(emergency.data.mode, 'emergency');
  assert.deepEqual(emergency.data.messages[0], {
    message: '888',
    alignment: 'center',
  });
  assert.equal(emergency.data.emergencyTone, 'release');
  assert.equal(emergency.data.contentRevision, 2);
  assert.equal(cleared.data.mode, 'blank');
  assert.equal(cleared.data.emergencyTone, null);
  assert.equal(cleared.data.revision, 3);
  assert.equal(cleared.data.contentRevision, 3);

  assert.deepEqual(
    windows.control.webContents.sent.map(({ payload }) =>
      [payload.revision, payload.contentRevision]),
    [[1, 1], [2, 2], [3, 3]],
  );
  assert.deepEqual(
    windows.display.webContents.sent.map(({ payload }) =>
      [payload.revision, Object.hasOwn(payload, 'contentRevision')]),
    [[1, false], [2, false], [3, false]],
  );
});

test('內容 CAS 不受翻頁 revision 影響，過期修改會原子拒絕', async () => {
  const { ipcMain, presentationService, timers, windows } = createHarness();
  const controlEvent = createEvent(windows.control);
  const displayEvent = createEvent(windows.display);

  const started = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    controlEvent,
    createProgram(4, { mode: 'finite', rounds: 1 }, 0),
  );
  assert.equal(started.data.contentRevision, 1);

  await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    displayEvent,
    createPageProgress(presentationService.getSnapshot(), 'ready'),
  );
  await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    displayEvent,
    createPageProgress(presentationService.getSnapshot(), 'started'),
  );
  timers[0].callback();
  assert.equal(
    presentationService.getSnapshot().pageNumber,
    1,
    'Main timer 到期仍須等待 Renderer 的 100% 終幀 complete',
  );
  await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    displayEvent,
    createPageProgress(presentationService.getSnapshot(), 'complete'),
  );
  assert.equal(presentationService.getSnapshot().pageNumber, 2);
  assert.equal(presentationService.getControlSnapshot().contentRevision, 1);

  const replaced = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    controlEvent,
    createProgram(1, { mode: 'continuous' }, 1),
  );
  assert.equal(replaced.ok, true);
  assert.equal(replaced.data.contentRevision, 2);
  const broadcastCount = windows.control.webContents.sent.length;

  for (const [channel, payload] of [
    [IPC_CHANNELS.CONTROL_START_PROGRAM, createProgram(1, { mode: 'continuous' }, 1)],
    [IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION, { expectedContentRevision: 1 }],
  ]) {
    const conflict = await ipcMain.invoke(channel, controlEvent, payload);
    assert.deepEqual(conflict, {
      ok: false,
      error: {
        code: 'PRESENTATION_CONFLICT',
        message: '螢幕內容已更新，請重新操作。',
      },
    });
  }

  assert.equal(presentationService.getControlSnapshot().contentRevision, 2);
  assert.equal(windows.control.webContents.sent.length, broadcastCount);
  assert.equal(
    (await ipcMain.invoke(
      IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
      controlEvent,
      { expectedContentRevision: 2 },
    )).ok,
    true,
  );
});

test('Main scheduler 同時等待最短時間與 Display 終幀 complete 才翻頁', async () => {
  const { ipcMain, presentationService, timers, windows } = createHarness();
  const result = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    createEvent(windows.control),
    createProgram(6, { mode: 'finite', rounds: 1 }),
  );

  assert.equal(result.ok, true);
  assert.equal(timers.length, 0);
  const firstReady = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'ready'),
  );
  assert.deepEqual(firstReady, { ok: true, data: { accepted: true } });
  assert.equal(timers.length, 0);
  const firstStarted = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'started'),
  );
  assert.deepEqual(firstStarted, { ok: true, data: { accepted: true } });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 3_000);

  timers[0].cleared = true;
  timers[0].callback();
  assert.equal(presentationService.getSnapshot().pageNumber, 1);
  const firstComplete = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'complete'),
  );
  assert.deepEqual(firstComplete, { ok: true, data: { accepted: true } });
  assert.equal(presentationService.getSnapshot().pageNumber, 2);
  assert.equal(timers.length, 1);

  const secondReady = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'ready', {
      layoutGeneration: 2,
    }),
  );
  assert.deepEqual(secondReady, { ok: true, data: { accepted: true } });
  assert.equal(timers.length, 1);
  const secondStarted = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'started', {
      layoutGeneration: 2,
    }),
  );
  assert.deepEqual(secondStarted, { ok: true, data: { accepted: true } });
  assert.equal(timers.length, 2);

  timers[1].cleared = true;
  timers[1].callback();
  assert.equal(presentationService.getSnapshot().mode, 'page');
  const secondComplete = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'complete', {
      layoutGeneration: 2,
    }),
  );
  assert.deepEqual(secondComplete, { ok: true, data: { accepted: true } });
  assert.equal(presentationService.getSnapshot().mode, 'blank');
  assert.deepEqual(
    windows.display.webContents.sent.map(({ payload }) => payload.revision),
    [1, 2, 3],
  );
});

test('Display 頁面進度受角色、main frame URL、schema 與目前 revision 限制', async () => {
  const { ipcMain, presentationService, timers, windows } = createHarness();
  await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    createEvent(windows.control),
    createProgram(6, { mode: 'finite', rounds: 1 }),
  );
  const valid = createPageProgress(
    presentationService.getSnapshot(),
    'ready',
    { marqueeCount: 1 },
  );

  const forbiddenControl = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.control),
    valid,
  );
  assert.equal(forbiddenControl.ok, false);
  assert.equal(forbiddenControl.error.code, 'FORBIDDEN');

  const invalidPayload = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    { ...valid, nextPage: true },
  );
  assert.equal(invalidPayload.ok, false);
  assert.equal(invalidPayload.error.code, 'VALIDATION_FAILED');
  assert.equal(timers.length, 0);

  const displayFrame = createFrame(
    DISPLAY_URL,
    windows.display.webContents.mainFrame.frameTreeNodeId,
  );
  windows.display.webContents.mainFrame.url = CONTROL_URL;
  const wrongCurrentUrl = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display, displayFrame),
    valid,
  );
  assert.equal(wrongCurrentUrl.ok, false);
  assert.equal(wrongCurrentUrl.error.code, 'FORBIDDEN');
  windows.display.webContents.mainFrame.url = DISPLAY_URL;

  const stale = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    { ...valid, revision: valid.revision - 1 },
  );
  assert.deepEqual(stale, { ok: true, data: { accepted: false } });

  const accepted = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    valid,
  );
  assert.deepEqual(accepted, { ok: true, data: { accepted: true } });
  assert.equal(timers.length, 0);
  const started = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'started'),
  );
  assert.deepEqual(started, { ok: true, data: { accepted: true } });
  assert.equal(timers.length, 1);

  const oldDisplay = windows.display;
  windows.display = createWindow(DISPLAY_URL);
  const forbiddenOldWindow = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(oldDisplay),
    valid,
  );
  assert.equal(forbiddenOldWindow.ok, false);
  assert.equal(forbiddenOldWindow.error.code, 'FORBIDDEN');
});

test('設定更新先使目前頁面 gate 失效，再通知 Display 重新 fit', async () => {
  const { ipcMain, presentationService, timers, windows } = createHarness();
  await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_START_PROGRAM,
    createEvent(windows.control),
    createProgram(6, { mode: 'finite', rounds: 1 }),
  );
  await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'ready'),
  );
  await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'started'),
  );
  const activeTimer = timers[0];
  const delayedOldReady = createPageProgress(
    presentationService.getSnapshot(),
    'ready',
  );
  const config = structuredClone(defaultConfig);
  config.appearance.backgroundColor = '#123456';

  const saved = await ipcMain.invoke(
    IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
    createEvent(windows.control),
    { config, expectedRevision: 0 },
  );

  assert.equal(saved.ok, true);
  assert.equal(activeTimer.cleared, true);
  activeTimer.callback();
  assert.equal(presentationService.getSnapshot().revision, 1);
  assert.equal(presentationService.getSnapshot().pageNumber, 1);
  const delayed = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    delayedOldReady,
  );
  assert.deepEqual(delayed, { ok: true, data: { accepted: false } });
  assert.equal(timers.filter(({ cleared }) => !cleared).length, 0);

  const refitted = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'ready', {
      settingsRevision: 1,
      layoutGeneration: 2,
    }),
  );
  assert.deepEqual(refitted, { ok: true, data: { accepted: true } });
  assert.equal(timers.filter(({ cleared }) => !cleared).length, 0);
  const refittedStarted = await ipcMain.invoke(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    createEvent(windows.display),
    createPageProgress(presentationService.getSnapshot(), 'started', {
      settingsRevision: 1,
      layoutGeneration: 2,
    }),
  );
  assert.deepEqual(refittedStarted, { ok: true, data: { accepted: true } });
  assert.equal(timers.filter(({ cleared }) => !cleared).length, 1);
  assert.equal(
    windows.display.webContents.sent.at(-1).channel,
    IPC_CHANNELS.DISPLAY_SETTINGS_CHANGED,
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
  assert.deepEqual(presentationService.getControlSnapshot(), result.data);
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
    outputMonitorController,
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
    IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
    IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
    IPC_CHANNELS.DISPLAY_GET_SETTINGS,
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    IPC_CHANNELS.DISPLAY_GET_OUTPUT_ADJUSTMENT,
  ];

  assert.deepEqual([...ipcMain.handlers.keys()].sort(), requestChannels.sort());

  coordinator.register();
  assert.equal(ipcMain.handlers.size, requestChannels.length);

  coordinator.dispose();
  presentationService.showEmergency('555');
  settingsManager.publish();
  displayTopologyService.publish(createTopologySnapshot({ revision: 1 }));
  displayPlacementController.publish(createPlacementSnapshot({ revision: 1 }));
  outputMonitorController.publish(createMonitorStatus({ revision: 1 }));
  assert.equal(ipcMain.handlers.size, 0);
  assert.deepEqual(ipcMain.removedChannels.sort(), requestChannels.sort());
  assert.equal(windows.control.webContents.sent.length, 0);
  assert.equal(windows.display.webContents.sent.length, 0);
  assert.equal(settingsManager.listeners.size, 0);
  assert.equal(displayTopologyService.listeners.size, 0);
  assert.equal(displayPlacementController.listeners.size, 0);
  assert.equal(outputMonitorController.listeners.size, 0);
});
