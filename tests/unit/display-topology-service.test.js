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

function createService({
  displays,
  primaryDisplayId,
  powerMonitor,
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
    hdmiDetector,
    powerMonitor,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  return { hdmiCalls, screen, service, warnings };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createFakeTimers() {
  const timers = new Map();
  let nextId = 1;

  return {
    clearTimer(id) {
      timers.delete(id);
    },
    pendingCount() {
      return timers.size;
    },
    runAll() {
      const callbacks = [...timers.values()];
      timers.clear();

      for (const callback of callbacks) {
        callback();
      }
    },
    setTimer(callback) {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      return id;
    },
  };
}

test('初始化不等待 HDMI 探測，先提供可定位的拓樸再背景更新狀態', async () => {
  const primary = createDisplay(1, { internal: true });
  let resolveHdmi;
  const hdmiResult = new Promise((resolve) => {
    resolveHdmi = resolve;
  });
  const screen = new FakeScreen([primary], 1);
  const service = new DisplayTopologyService({
    screen,
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

test('休眠恢復與解鎖後重新查詢拓樸，dispose 精確移除 powerMonitor 監聽', async () => {
  const powerMonitor = new EventEmitter();
  const primary = createDisplay(1, { internal: true });
  const external = createDisplay(2);
  const { screen, service } = createService({
    displays: [primary],
    primaryDisplayId: 1,
    powerMonitor,
  });

  await service.initialize();
  await flushAsyncWork();
  const queryCountBefore = screen.queryCount;
  screen.displays = [primary, external];

  powerMonitor.emit('resume');
  powerMonitor.emit('unlock-screen');
  await flushAsyncWork();

  assert.equal(screen.queryCount, queryCountBefore + 1);
  assert.equal(service.getSnapshot().effectiveDisplayId, 2);
  assert.equal(powerMonitor.listenerCount('resume'), 1);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), 1);

  service.dispose();
  assert.equal(powerMonitor.listenerCount('resume'), 0);
  assert.equal(powerMonitor.listenerCount('unlock-screen'), 0);
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

test('外接螢幕拔除時回到主螢幕，重新連接後自動返回外接螢幕', async () => {
  const primary = createDisplay(1, { internal: true });
  const selected = createDisplay(42, { label: '外接電視' });
  const { screen, service } = createService({
    displays: [primary, selected],
    primaryDisplayId: 1,
  });

  await service.initialize();
  assert.equal(service.getSnapshot().effectiveDisplayId, 42);
  assert.equal(service.getSnapshot().configuredDisplayId, null);
  assert.equal(service.getSnapshot().usingFallback, false);
  assert.equal(service.getSnapshot().fullscreen, true);

  screen.displays = [primary];
  screen.emit('display-removed', {}, selected);
  await flushAsyncWork();

  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
  assert.equal(service.getSnapshot().configuredDisplayId, null);
  assert.equal(service.getSnapshot().usingFallback, false);
  assert.equal(service.getSnapshot().fullscreen, true);

  screen.displays = [primary, selected];
  screen.emit('display-added', {}, selected);
  await flushAsyncWork();

  assert.equal(service.getSnapshot().effectiveDisplayId, 42);
  assert.equal(service.getSnapshot().configuredDisplayId, null);
  assert.equal(service.getSnapshot().usingFallback, false);
  assert.deepEqual(service.getTargetDisplay().bounds, selected.bounds);
});

test('沒有外接螢幕時只使用主螢幕，不會誤選內建副螢幕', async () => {
  const primary = createDisplay(1, { internal: true });
  const internalSecondary = createDisplay(2, { internal: true });
  const { service } = createService({
    displays: [primary, internalSecondary],
    primaryDisplayId: 1,
  });

  await service.initialize();

  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
  assert.equal(service.getTargetDisplay().id, 1);
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

test('display 事件立即合併拓樸，HDMI 探測則 debounce 避免事件風暴', async () => {
  const primary = createDisplay(1, { internal: true });
  const external = createDisplay(2);
  const hdmiResults = [
    { status: 'not-connected', activeConnectionCount: 1, hdmiConnectionCount: 0 },
    { status: 'connected', activeConnectionCount: 2, hdmiConnectionCount: 1 },
  ];
  const { screen } = createService({
    displays: [primary],
    primaryDisplayId: 1,
  });
  const timers = createFakeTimers();
  let hdmiIndex = 0;
  const service = new DisplayTopologyService({
    screen,
    hdmiDetector: {
      async detect() {
        return hdmiResults[Math.min(hdmiIndex++, hdmiResults.length - 1)];
      },
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await service.initialize();
  await flushAsyncWork();
  const queryCountBefore = screen.queryCount;
  screen.displays = [primary, external];
  screen.emit('display-added', {}, external);
  screen.emit('display-metrics-changed', {}, external, ['bounds']);
  screen.emit('display-metrics-changed', {}, external, ['scaleFactor']);
  await flushAsyncWork();

  assert.equal(screen.queryCount, queryCountBefore + 1);
  assert.equal(service.getSnapshot().effectiveDisplayId, 2);
  assert.equal(service.getSnapshot().hdmiConnectionStatus, 'not-connected');
  assert.equal(timers.pendingCount(), 1);
  assert.equal(hdmiIndex, 1);

  timers.runAll();
  await flushAsyncWork();

  assert.equal(service.getSnapshot().hdmiConnectionStatus, 'connected');
  assert.equal(hdmiIndex, 2);
});

test('HDMI 探測 single-flight：前次未完成時只排定一次後續查詢', async () => {
  const timers = createFakeTimers();
  const primary = createDisplay(1, { internal: true });
  const external = createDisplay(2);
  const screen = new FakeScreen([primary], 1);
  const resolvers = [];
  let callCount = 0;
  const service = new DisplayTopologyService({
    screen,
    hdmiDetector: {
      detect() {
        callCount += 1;
        return new Promise((resolve) => resolvers.push(resolve));
      },
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  await service.initialize();
  assert.equal(callCount, 1);

  screen.displays = [primary, external];
  screen.emit('display-added', {}, external);
  screen.emit('display-metrics-changed', {}, external, ['bounds']);
  await flushAsyncWork();
  timers.runAll();
  await flushAsyncWork();

  assert.equal(callCount, 1);

  resolvers.shift()({ status: 'not-connected' });
  await flushAsyncWork();
  assert.equal(callCount, 2);

  resolvers.shift()({ status: 'connected' });
  await flushAsyncWork();
  assert.equal(service.getSnapshot().hdmiConnectionStatus, 'connected');
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

test('初次拓樸查詢失敗時保留固定自動全螢幕狀態', async () => {
  const screen = new FakeScreen([createDisplay(1, { internal: true })], 1);
  screen.error = new Error('startup topology unavailable');
  const service = new DisplayTopologyService({
    screen,
    hdmiDetector: {
      async detect() {
        return { status: 'unknown' };
      },
    },
    logger: { warn() {} },
  });

  await service.initialize();

  assert.equal(service.getSnapshot().topologyStatus, 'unknown');
  assert.equal(service.getSnapshot().selectionMode, 'auto');
  assert.equal(service.getSnapshot().configuredDisplayId, null);
  assert.equal(service.getSnapshot().effectiveDisplayId, null);
  assert.equal(service.getSnapshot().usingFallback, false);
  assert.equal(service.getSnapshot().fullscreen, true);
});

test('dispose 精確移除 screen 訂閱，後續事件不再變更狀態', async () => {
  const { screen, service } = createService();
  await service.initialize();
  const snapshotBefore = service.getSnapshot();

  assert.equal(screen.listenerCount('display-added'), 1);
  assert.equal(screen.listenerCount('display-removed'), 1);
  assert.equal(screen.listenerCount('display-metrics-changed'), 1);

  service.dispose();
  screen.displays = [createDisplay(1), createDisplay(2)];
  screen.emit('display-added', {}, createDisplay(2));
  await flushAsyncWork();

  assert.equal(screen.listenerCount('display-added'), 0);
  assert.equal(screen.listenerCount('display-removed'), 0);
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
  assert.equal(service.getSnapshot(), snapshotBefore);
});
