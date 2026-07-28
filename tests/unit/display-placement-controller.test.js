'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISPLAY_PLACEMENT_STATUSES,
  DisplayPlacementController,
} = require('../../main/display-placement-controller');

function createTargetDisplay(overrides = {}) {
  return Object.freeze({
    id: 20,
    label: '外接電視',
    bounds: Object.freeze({ x: -2560, y: -360, width: 2560, height: 1440 }),
    workArea: Object.freeze({ x: -2560, y: -360, width: 2560, height: 1400 }),
    scaleFactor: 1.5,
    isPrimary: false,
    isInternal: false,
    ...overrides,
  });
}

function createTopologySnapshot(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    topologyStatus: 'ready',
    hdmiConnectionStatus: 'connected',
    displays: Object.freeze([]),
    effectiveDisplayId: 20,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    secondDisplayConnected: true,
    configRevision: 0,
    revision: 0,
    ...overrides,
  });
}

class FakeTopologyService {
  constructor({
    snapshot = createTopologySnapshot(),
    target = createTargetDisplay(),
  } = {}) {
    this.snapshot = snapshot;
    this.target = target;
    this.listeners = new Set();
  }

  getSnapshot() {
    return this.snapshot;
  }

  getTargetDisplay() {
    return this.target;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(snapshot, target = this.target) {
    this.snapshot = snapshot;
    this.target = target;

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

class FakeWindow {
  constructor() {
    this.destroyed = false;
    this.calls = [];
    this.throwOnBounds = false;
    this.simpleFullscreen = true;
  }

  isDestroyed() {
    return this.destroyed;
  }

  setFullScreen(enabled) {
    this.calls.push({ method: 'setFullScreen', enabled });
  }

  setSimpleFullScreen(enabled) {
    this.calls.push({ method: 'setSimpleFullScreen', enabled });
    this.simpleFullscreen = enabled;
  }

  isSimpleFullScreen() {
    this.calls.push({ method: 'isSimpleFullScreen' });
    return this.simpleFullscreen;
  }

  setBounds(bounds, animate) {
    this.calls.push({ method: 'setBounds', bounds, animate });

    if (this.throwOnBounds) {
      throw new Error('/private/window/path');
    }
  }
}

function createController({
  topologyService,
  getDisplayWindow,
  logger,
  platform = 'win32',
  placementRetryAttempts,
  placementRetryDelayMilliseconds,
  waitForRetry,
} = {}) {
  const topology = topologyService || new FakeTopologyService();
  const controller = new DisplayPlacementController({
    topologyService: topology,
    getDisplayWindow: getDisplayWindow || (() => null),
    logger,
    platform,
    placementRetryAttempts,
    placementRetryDelayMilliseconds,
    waitForRetry,
  });

  return { controller, topology };
}

test('macOS Display 定位使用 simple fullscreen 並確認已成功進入', () => {
  const window = new FakeWindow();
  const topology = new FakeTopologyService();
  const { controller } = createController({
    topologyService: topology,
    platform: 'darwin',
  });
  controller.initialize();

  assert.equal(controller.applyToWindow(window), true);
  assert.deepEqual(window.calls, [
    { method: 'setSimpleFullScreen', enabled: false },
    {
      method: 'setBounds',
      bounds: topology.target.bounds,
      animate: false,
    },
    { method: 'setSimpleFullScreen', enabled: true },
    { method: 'isSimpleFullScreen' },
  ]);
  assert.equal(controller.getStatus().status, DISPLAY_PLACEMENT_STATUSES.APPLIED);
});

test('全螢幕跨螢幕依序退出、套用原始 DIP bounds、再進入全螢幕', () => {
  const window = new FakeWindow();
  const topology = new FakeTopologyService();
  const { controller } = createController({ topologyService: topology });
  controller.initialize();

  assert.equal(controller.applyToWindow(window), true);
  assert.deepEqual(window.calls, [
    { method: 'setFullScreen', enabled: false },
    {
      method: 'setBounds',
      bounds: topology.target.bounds,
      animate: false,
    },
    { method: 'setFullScreen', enabled: true },
  ]);
  assert.deepEqual(controller.getStatus(), {
    status: DISPLAY_PLACEMENT_STATUSES.APPLIED,
    displayId: 20,
    fullscreen: true,
    revision: 1,
  });
});

test('舊拓樸即使帶有視窗偏好，Display 仍固定套用全螢幕', () => {
  const window = new FakeWindow();
  const topology = new FakeTopologyService({
    snapshot: createTopologySnapshot({ fullscreen: false }),
  });
  const { controller } = createController({ topologyService: topology });
  controller.initialize();

  controller.applyToWindow(window);

  assert.deepEqual(window.calls, [
    { method: 'setFullScreen', enabled: false },
    {
      method: 'setBounds',
      bounds: topology.target.bounds,
      animate: false,
    },
    { method: 'setFullScreen', enabled: true },
  ]);
  assert.equal(controller.getStatus().fullscreen, true);
});

test('相同視窗與 placement 不重複呼叫原生 API，目標變更才重套用', () => {
  const window = new FakeWindow();
  const topology = new FakeTopologyService();
  const { controller } = createController({
    topologyService: topology,
    getDisplayWindow: () => window,
  });
  controller.initialize();
  assert.equal(window.calls.length, 3);

  topology.publish(createTopologySnapshot({
    hdmiConnectionStatus: 'not-connected',
    revision: 1,
  }));
  assert.equal(window.calls.length, 3);

  const nextTarget = createTargetDisplay({
    id: 30,
    bounds: Object.freeze({ x: 1920, y: 0, width: 1920, height: 1080 }),
    workArea: Object.freeze({ x: 1920, y: 0, width: 1920, height: 1040 }),
  });
  topology.publish(
    createTopologySnapshot({ effectiveDisplayId: 30, revision: 2 }),
    nextTarget,
  );

  assert.equal(window.calls.length, 6);
  assert.deepEqual(window.calls[4].bounds, nextTarget.bounds);
  assert.equal(controller.getStatus().displayId, 30);
});

test('尚無 Display Window 時保持 pending，新視窗建立或重建後套用最新位置', () => {
  let currentWindow = null;
  const topology = new FakeTopologyService();
  const { controller } = createController({
    topologyService: topology,
    getDisplayWindow: () => currentWindow,
  });

  controller.initialize();
  assert.deepEqual(controller.getStatus(), {
    status: DISPLAY_PLACEMENT_STATUSES.PENDING,
    displayId: 20,
    fullscreen: true,
    revision: 0,
  });

  const firstWindow = new FakeWindow();
  currentWindow = firstWindow;
  assert.equal(controller.applyToWindow(firstWindow), true);
  assert.equal(firstWindow.calls.length, 3);

  const replacementWindow = new FakeWindow();
  currentWindow = replacementWindow;
  assert.equal(controller.applyToWindow(replacementWindow), true);
  assert.equal(replacementWindow.calls.length, 3);
  assert.equal(controller.getStatus().revision, 2);
});

test('已銷毀視窗不呼叫 API，套用錯誤發布固定失敗狀態且不洩漏路徑', () => {
  const warnings = [];
  const topology = new FakeTopologyService();
  const { controller } = createController({
    topologyService: topology,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });
  controller.initialize();

  const destroyedWindow = new FakeWindow();
  destroyedWindow.destroyed = true;
  assert.equal(controller.applyToWindow(destroyedWindow), false);
  assert.equal(destroyedWindow.calls.length, 0);

  const failingWindow = new FakeWindow();
  failingWindow.throwOnBounds = true;
  assert.equal(controller.applyToWindow(failingWindow), false);
  assert.deepEqual(controller.getStatus(), {
    status: DISPLAY_PLACEMENT_STATUSES.ERROR,
    displayId: 20,
    fullscreen: true,
    revision: 1,
  });
  assert.deepEqual(warnings, ['[DisplayCore] Display Window 輸出位置套用失敗。']);
});

test('初始化定位遇到暫時性原生錯誤時有限重試，成功後回到 applied', async () => {
  const window = new FakeWindow();
  let remainingFailures = 2;
  const originalSetBounds = window.setBounds.bind(window);
  window.setBounds = (bounds, animate) => {
    window.throwOnBounds = remainingFailures > 0;
    remainingFailures -= 1;
    originalSetBounds(bounds, animate);
  };
  const waits = [];
  const { controller } = createController({
    logger: { warn() {} },
    placementRetryAttempts: 3,
    placementRetryDelayMilliseconds: 125,
    waitForRetry: async (milliseconds) => waits.push(milliseconds),
  });
  controller.initialize();

  assert.equal(await controller.applyToWindowWithRetry(window), true);
  assert.equal(
    window.calls.filter(({ method }) => method === 'setBounds').length,
    3,
  );
  assert.deepEqual(waits, [125, 125]);
  assert.equal(controller.getStatus().status, DISPLAY_PLACEMENT_STATUSES.APPLIED);
});

test('定位重試達上限後保留 error，不會無限循環', async () => {
  const window = new FakeWindow();
  window.throwOnBounds = true;
  const waits = [];
  const { controller } = createController({
    logger: { warn() {} },
    placementRetryAttempts: 2,
    waitForRetry: async (milliseconds) => waits.push(milliseconds),
  });
  controller.initialize();

  assert.equal(await controller.applyToWindowWithRetry(window), false);
  assert.equal(
    window.calls.filter(({ method }) => method === 'setBounds').length,
    2,
  );
  assert.equal(waits.length, 1);
  assert.equal(controller.getStatus().status, DISPLAY_PLACEMENT_STATUSES.ERROR);
});

test('沒有有效目標時保持 pending，dispose 後不再回應拓樸事件', () => {
  const window = new FakeWindow();
  const topology = new FakeTopologyService({
    snapshot: createTopologySnapshot({
      topologyStatus: 'unknown',
      effectiveDisplayId: null,
    }),
    target: null,
  });
  const { controller } = createController({
    topologyService: topology,
    getDisplayWindow: () => window,
  });

  controller.initialize();
  assert.equal(controller.getStatus().status, DISPLAY_PLACEMENT_STATUSES.PENDING);
  assert.equal(window.calls.length, 0);
  assert.equal(topology.listeners.size, 1);

  controller.dispose();
  topology.publish(createTopologySnapshot(), createTargetDisplay());

  assert.equal(topology.listeners.size, 0);
  assert.equal(window.calls.length, 0);
});
