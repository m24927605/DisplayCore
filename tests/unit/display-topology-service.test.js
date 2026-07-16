'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  DISPLAY_TOPOLOGY_STATUSES,
  DisplayTopologyService,
} = require('../../main/display-topology-service');

function createDisplay(id, overrides = {}) {
  return {
    id,
    label: `Display ${id}`,
    detected: true,
    internal: false,
    bounds: { x: id * 100, y: 0, width: 1920, height: 1080 },
    workArea: { x: id * 100, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    rotation: 0,
    ...overrides,
  };
}

function createConfigSnapshot({
  revision = 0,
  selectionMode = 'auto',
  defaultDisplayId = null,
  fullscreen = true,
} = {}) {
  return {
    config: {
      display: { selectionMode, defaultDisplayId, fullscreen },
    },
    revision,
  };
}

class FakeScreen extends EventEmitter {
  constructor(displays, primaryDisplayId) {
    super();
    this.displays = displays;
    this.primaryDisplayId = primaryDisplayId;
    this.error = null;
    this.queryCount = 0;
  }

  getAllDisplays() {
    this.queryCount += 1;

    if (this.error) {
      throw this.error;
    }

    return this.displays;
  }

  getPrimaryDisplay() {
    if (this.error) {
      throw this.error;
    }

    return this.displays.find(({ id }) => id === this.primaryDisplayId);
  }
}

class FakeSettingsManager {
  constructor(snapshot = createConfigSnapshot()) {
    this.snapshot = snapshot;
    this.listeners = new Set();
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(snapshot) {
    this.snapshot = snapshot;

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function createService({
  displays,
  primaryDisplayId,
  settingsSnapshot,
  hdmiResult = {
    status: 'not-connected',
    activeConnectionCount: 1,
    hdmiConnectionCount: 0,
  },
} = {}) {
  const screen = new FakeScreen(
    displays || [createDisplay(1, { internal: true })],
    primaryDisplayId ?? 1,
  );
  const settingsManager = new FakeSettingsManager(settingsSnapshot);
  const hdmiCalls = [];
  const hdmiDetector = {
    async detect() {
      hdmiCalls.push(true);
      return hdmiResult;
    },
  };
  const warnings = [];
  const service = new DisplayTopologyService({
    screen,
    settingsManager,
    hdmiDetector,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  return { hdmiCalls, screen, service, settingsManager, warnings };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('初始化不等待 HDMI 探測，先提供可定位的拓樸再背景更新狀態', async () => {
  const primary = createDisplay(1, { internal: true });
  let resolveHdmi;
  const hdmiResult = new Promise((resolve) => {
    resolveHdmi = resolve;
  });
  const screen = new FakeScreen([primary], 1);
  const settingsManager = new FakeSettingsManager();
  const service = new DisplayTopologyService({
    screen,
    settingsManager,
    hdmiDetector: {
      detect() {
        return hdmiResult;
      },
    },
  });

  const raceResult = await Promise.race([
    service.initialize().then(() => 'initialized'),
    new Promise((resolve) => setImmediate(() => resolve('blocked'))),
  ]);

  assert.equal(raceResult, 'initialized');
  assert.equal(service.getSnapshot().topologyStatus, 'ready');
  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
  assert.equal(service.getSnapshot().hdmiConnectionStatus, 'detecting');

  resolveHdmi({
    status: 'connected',
    activeConnectionCount: 1,
    hdmiConnectionCount: 1,
  });
  await flushAsyncWork();

  assert.equal(service.getSnapshot().hdmiConnectionStatus, 'connected');
});

test('只有主螢幕時 auto 使用主螢幕並發布最小唯讀快照', async () => {
  const primary = createDisplay(1, {
    label: '  內建\u0000螢幕  ',
    internal: true,
    bounds: { x: 0, y: 0, width: 1536, height: 864 },
    workArea: { x: 0, y: 0, width: 1536, height: 824 },
    scaleFactor: 1.25,
  });
  const { service } = createService({
    displays: [primary],
    primaryDisplayId: 1,
    settingsSnapshot: createConfigSnapshot({ revision: 4 }),
    hdmiResult: {
      status: 'connected',
      activeConnectionCount: 1,
      hdmiConnectionCount: 1,
    },
  });

  await service.initialize();
  await flushAsyncWork();
  const snapshot = service.getSnapshot();

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    topologyStatus: DISPLAY_TOPOLOGY_STATUSES.READY,
    hdmiConnectionStatus: 'connected',
    displays: [{
      id: 1,
      label: '內建螢幕',
      width: 1920,
      height: 1080,
      scaleFactor: 1.25,
      isPrimary: true,
      isInternal: true,
    }],
    effectiveDisplayId: 1,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    secondDisplayConnected: false,
    configRevision: 4,
    revision: 1,
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.displays), true);
  assert.equal(Object.isFrozen(snapshot.displays[0]), true);
  assert.deepEqual(service.getTargetDisplay().bounds, primary.bounds);
});

test('auto 優先非主螢幕，清單順序或新增其他螢幕不使現有目標跳動', async () => {
  const primary = createDisplay(10, { internal: true });
  const firstExternal = createDisplay(20, { label: 'TV' });
  const secondExternal = createDisplay(30, { label: 'Projector' });
  const { screen, service } = createService({
    displays: [secondExternal, primary, firstExternal],
    primaryDisplayId: 10,
  });
  const snapshots = [];
  service.subscribe((snapshot) => snapshots.push(snapshot));

  await service.initialize();
  await flushAsyncWork();
  snapshots.length = 0;
  assert.equal(service.getSnapshot().effectiveDisplayId, 20);
  assert.deepEqual(
    service.getSnapshot().displays.map(({ id }) => id),
    [10, 20, 30],
  );

  screen.displays = [createDisplay(15), secondExternal, firstExternal, primary];
  screen.emit('display-added', {}, createDisplay(15));
  await flushAsyncWork();

  assert.equal(service.getSnapshot().effectiveDisplayId, 20);
  assert.equal(service.getSnapshot().secondDisplayConnected, true);
  assert.equal(snapshots.length, 1);
});

test('auto 在外接電視是主螢幕時仍優先外接，不誤選內建副螢幕', async () => {
  const externalPrimary = createDisplay(10, {
    label: 'HDMI TV',
    internal: false,
  });
  const internalSecondary = createDisplay(20, {
    label: '內建面板',
    internal: true,
  });
  const { service } = createService({
    displays: [internalSecondary, externalPrimary],
    primaryDisplayId: 10,
  });

  await service.initialize();

  assert.equal(service.getSnapshot().effectiveDisplayId, 10);
  assert.equal(service.getTargetDisplay().label, 'HDMI TV');
});

test('auto 從單一外接主螢幕升級到新接入的外接副螢幕', async () => {
  const desktopPrimary = createDisplay(10, {
    label: '桌機主螢幕',
    internal: false,
  });
  const television = createDisplay(20, {
    label: '新接入電視',
    internal: false,
  });
  const { screen, service } = createService({
    displays: [desktopPrimary],
    primaryDisplayId: 10,
  });

  await service.initialize();
  assert.equal(service.getSnapshot().effectiveDisplayId, 10);

  screen.displays = [desktopPrimary, television];
  screen.emit('display-added', {}, television);
  await flushAsyncWork();

  assert.equal(service.getSnapshot().effectiveDisplayId, 20);
});

test('manual 螢幕離線時暫用主螢幕，重新連接後自動回到原設定', async () => {
  const primary = createDisplay(1, { internal: true });
  const selected = createDisplay(42, { label: '指定電視' });
  const { screen, service } = createService({
    displays: [primary],
    primaryDisplayId: 1,
    settingsSnapshot: createConfigSnapshot({
      selectionMode: 'manual',
      defaultDisplayId: 42,
      fullscreen: false,
    }),
  });

  await service.initialize();
  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
  assert.equal(service.getSnapshot().configuredDisplayId, 42);
  assert.equal(service.getSnapshot().usingFallback, true);
  assert.equal(service.getSnapshot().fullscreen, false);

  screen.displays = [primary, selected];
  screen.emit('display-added', {}, selected);
  await flushAsyncWork();

  assert.equal(service.getSnapshot().effectiveDisplayId, 42);
  assert.equal(service.getSnapshot().configuredDisplayId, 42);
  assert.equal(service.getSnapshot().usingFallback, false);
  assert.deepEqual(service.getTargetDisplay().bounds, selected.bounds);
});

test('忽略無效、未偵測與重複 id，保留有效螢幕的負座標與 DIP bounds', async () => {
  const primary = createDisplay(1, { internal: true });
  const left = createDisplay(2, {
    label: '',
    bounds: { x: -2560, y: -360, width: 1707, height: 960 },
    workArea: { x: -2560, y: -360, width: 1707, height: 920 },
    scaleFactor: 1.5,
  });
  const { service } = createService({
    displays: [
      createDisplay(-1),
      createDisplay(-10),
      createDisplay(Number.MAX_SAFE_INTEGER + 1),
      createDisplay(3, { detected: false }),
      primary,
      left,
      createDisplay(2, { label: 'duplicate' }),
    ],
    primaryDisplayId: 1,
  });

  await service.initialize();

  assert.deepEqual(service.getSnapshot().displays, [
    {
      id: 1,
      label: 'Display 1',
      width: 1920,
      height: 1080,
      scaleFactor: 1,
      isPrimary: true,
      isInternal: true,
    },
    {
      id: 2,
      label: '螢幕 2',
      width: 2561,
      height: 1440,
      scaleFactor: 1.5,
      isPrimary: false,
      isInternal: false,
    },
  ]);
  assert.deepEqual(service.getTargetDisplay().bounds, left.bounds);
});

test('display 事件以 microtask 合併並依最新 API 狀態更新 HDMI', async () => {
  const primary = createDisplay(1, { internal: true });
  const external = createDisplay(2);
  const hdmiResults = [
    { status: 'not-connected', activeConnectionCount: 1, hdmiConnectionCount: 0 },
    { status: 'connected', activeConnectionCount: 2, hdmiConnectionCount: 1 },
  ];
  const { screen, settingsManager } = createService({
    displays: [primary],
    primaryDisplayId: 1,
  });
  let hdmiIndex = 0;
  const service = new DisplayTopologyService({
    screen,
    settingsManager,
    hdmiDetector: {
      async detect() {
        return hdmiResults[Math.min(hdmiIndex++, hdmiResults.length - 1)];
      },
    },
  });

  await service.initialize();
  const queryCountBefore = screen.queryCount;
  screen.displays = [primary, external];
  screen.emit('display-added', {}, external);
  screen.emit('display-metrics-changed', {}, external, ['bounds']);
  screen.emit('display-metrics-changed', {}, external, ['scaleFactor']);
  await flushAsyncWork();

  assert.equal(screen.queryCount, queryCountBefore + 1);
  assert.equal(service.getSnapshot().effectiveDisplayId, 2);
  assert.equal(service.getSnapshot().hdmiConnectionStatus, 'connected');
});

test('設定發布即時更新偏好，且不需要重新查詢 HDMI', async () => {
  const primary = createDisplay(1, { internal: true });
  const external = createDisplay(2);
  const { hdmiCalls, service, settingsManager } = createService({
    displays: [primary, external],
    primaryDisplayId: 1,
  });

  await service.initialize();
  settingsManager.publish(createConfigSnapshot({
    revision: 8,
    selectionMode: 'manual',
    defaultDisplayId: 1,
    fullscreen: false,
  }));

  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
  assert.equal(service.getSnapshot().configuredDisplayId, 1);
  assert.equal(service.getSnapshot().fullscreen, false);
  assert.equal(service.getSnapshot().configRevision, 8);
  assert.equal(hdmiCalls.length, 1);
});

test('screen API 暫時失敗時保留原目標並標示 unknown，恢復後重新發布', async () => {
  const primary = createDisplay(1, { internal: true });
  const external = createDisplay(2);
  const { screen, service, warnings } = createService({
    displays: [primary, external],
    primaryDisplayId: 1,
  });

  await service.initialize();
  const targetBefore = service.getTargetDisplay();
  screen.error = new Error('/private/display/path');
  screen.emit('display-removed', {}, external);
  await flushAsyncWork();

  assert.equal(
    service.getSnapshot().topologyStatus,
    DISPLAY_TOPOLOGY_STATUSES.UNKNOWN,
  );
  assert.deepEqual(service.getTargetDisplay(), targetBefore);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private\/display/);

  screen.error = null;
  screen.displays = [primary];
  screen.emit('display-removed', {}, external);
  await flushAsyncWork();

  assert.equal(
    service.getSnapshot().topologyStatus,
    DISPLAY_TOPOLOGY_STATUSES.READY,
  );
  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
});

test('dispose 精確移除 screen 與設定訂閱，後續事件不再變更狀態', async () => {
  const { screen, service, settingsManager } = createService();
  await service.initialize();
  const snapshotBefore = service.getSnapshot();

  assert.equal(screen.listenerCount('display-added'), 1);
  assert.equal(screen.listenerCount('display-removed'), 1);
  assert.equal(screen.listenerCount('display-metrics-changed'), 1);
  assert.equal(settingsManager.listeners.size, 1);

  service.dispose();
  screen.displays = [createDisplay(1), createDisplay(2)];
  screen.emit('display-added', {}, createDisplay(2));
  settingsManager.publish(createConfigSnapshot({ revision: 9 }));
  await flushAsyncWork();

  assert.equal(screen.listenerCount('display-added'), 0);
  assert.equal(screen.listenerCount('display-removed'), 0);
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
  assert.equal(settingsManager.listeners.size, 0);
  assert.equal(service.getSnapshot(), snapshotBefore);
});
