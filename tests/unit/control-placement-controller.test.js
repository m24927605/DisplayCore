'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTROL_PLACEMENT_STATUSES,
  ControlPlacementController,
  calculateControlBounds,
} = require('../../main/control-placement-controller');

function createTargetDisplay(overrides = {}) {
  return {
    id: 2,
    bounds: { x: 1920, y: 0, width: 1280, height: 720 },
    workArea: { x: 1920, y: 40, width: 1280, height: 680 },
    ...overrides,
  };
}

class FakeTopologyService {
  constructor(target = createTargetDisplay()) {
    this.target = target;
    this.listeners = new Set();
  }

  getControlTargetDisplay() {
    return this.target;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(target) {
    this.target = target;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class FakeWindow {
  constructor({ width = 960, height = 720, failures = 0 } = {}) {
    this.bounds = { x: 0, y: 0, width, height };
    this.failures = failures;
    this.calls = [];
    this.destroyed = false;
  }

  isDestroyed() {
    return this.destroyed;
  }

  getBounds() {
    return { ...this.bounds };
  }

  setBounds(bounds, animate) {
    this.calls.push({ bounds: { ...bounds }, animate });
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('temporary native failure');
    }
    this.bounds = { ...bounds };
  }
}

test('Control 使用目標螢幕 workArea 保留一般視窗比例、限制大小並置中', () => {
  assert.deepEqual(
    calculateControlBounds(
      { width: 960, height: 720 },
      createTargetDisplay().workArea,
    ),
    { x: 2080, y: 40, width: 960, height: 680 },
  );

  const topologyService = new FakeTopologyService();
  const window = new FakeWindow();
  const controller = new ControlPlacementController({
    topologyService,
    getControlWindow: () => window,
  });

  controller.initialize();

  assert.deepEqual(window.calls, [{
    bounds: { x: 2080, y: 40, width: 960, height: 680 },
    animate: false,
  }]);
  assert.deepEqual(controller.getStatus(), {
    status: CONTROL_PLACEMENT_STATUSES.APPLIED,
    displayId: 2,
    revision: 1,
  });
});

test('Control 指派改變時立即移動，相同目標不重複呼叫原生 API', () => {
  const topologyService = new FakeTopologyService();
  const window = new FakeWindow({ width: 900, height: 600 });
  const controller = new ControlPlacementController({
    topologyService,
    getControlWindow: () => window,
  });

  controller.initialize();
  topologyService.publish(createTargetDisplay());
  assert.equal(window.calls.length, 1);

  topologyService.publish(createTargetDisplay({
    id: 3,
    workArea: { x: -1600, y: 0, width: 1600, height: 900 },
  }));

  assert.equal(window.calls.length, 2);
  assert.deepEqual(window.calls[1], {
    bounds: { x: -1250, y: 150, width: 900, height: 600 },
    animate: false,
  });
  assert.equal(controller.getStatus().displayId, 3);
});

test('Control 初次跨螢幕定位遇到暫時錯誤時有限重試', async () => {
  const topologyService = new FakeTopologyService();
  const window = new FakeWindow({ failures: 1 });
  const delays = [];
  const controller = new ControlPlacementController({
    topologyService,
    getControlWindow: () => null,
    placementRetryAttempts: 2,
    placementRetryDelayMilliseconds: 125,
    waitForRetry(milliseconds) {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });

  controller.initialize();

  assert.equal(await controller.applyToWindowWithRetry(window), true);
  assert.deepEqual(delays, [125]);
  assert.equal(window.calls.length, 2);
  assert.equal(controller.getStatus().status, CONTROL_PLACEMENT_STATUSES.APPLIED);
});

test('執行中切換 Control 螢幕遇到暫時錯誤時也會有限重試', async () => {
  const topologyService = new FakeTopologyService();
  const window = new FakeWindow({ width: 900, height: 600 });
  const controller = new ControlPlacementController({
    topologyService,
    getControlWindow: () => window,
    logger: { warn() {} },
    placementRetryAttempts: 2,
    waitForRetry: () => Promise.resolve(),
  });
  controller.initialize();
  window.failures = 1;

  topologyService.publish(createTargetDisplay({
    id: 3,
    workArea: { x: -1600, y: 0, width: 1600, height: 900 },
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(window.calls.length, 3);
  assert.equal(controller.getStatus().status, CONTROL_PLACEMENT_STATUSES.APPLIED);
  assert.equal(controller.getStatus().displayId, 3);
});

test('Windows 跨 DPI 第一次 setBounds 落錯螢幕時會再套用一次', () => {
  const topologyService = new FakeTopologyService();
  const window = new FakeWindow();
  const intended = [];
  window.setBounds = function setBounds(bounds) {
    intended.push({ ...bounds });
    // First call lands on the wrong display, as Windows does across scale factors.
    this.bounds = intended.length === 1
      ? { ...bounds, x: 0, y: 0 }
      : { ...bounds };
  };
  const controller = new ControlPlacementController({
    topologyService,
    getControlWindow: () => window,
  });

  controller.initialize();

  assert.equal(intended.length, 2);
  assert.equal(window.bounds.x, 2080);
  assert.equal(controller.getStatus().status, CONTROL_PLACEMENT_STATUSES.APPLIED);
});

test('救援時即使快取認為已定位，仍會強制重新擺放 Control', async () => {
  const topologyService = new FakeTopologyService();
  const window = new FakeWindow();
  const controller = new ControlPlacementController({
    topologyService,
    getControlWindow: () => window,
  });

  controller.initialize();
  assert.equal(window.calls.length, 1);

  // Windows moved the window elsewhere behind the controller's back.
  window.bounds = { ...window.bounds, x: 0, y: 0 };
  topologyService.publish(topologyService.target);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.calls.length, 1);

  assert.equal(await controller.forceReapply(), true);
  assert.equal(window.calls.length, 2);
  assert.equal(window.bounds.x, 2080);
});
