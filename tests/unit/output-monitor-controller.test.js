'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const defaultConfig = require('../../config.json');
const {
  OutputMonitorController,
} = require('../../main/output-monitor-controller');

const TARGET = Object.freeze({
  id: 2,
  bounds: Object.freeze({ x: 1280, y: 0, width: 1280, height: 720 }),
});

function createSettingsManager(display = {}) {
  let snapshot = {
    config: {
      ...structuredClone(defaultConfig),
      display: { ...defaultConfig.display, ...display },
    },
    revision: 0,
  };
  const listeners = new Set();
  return {
    listeners,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(nextDisplay) {
      snapshot = {
        config: {
          ...snapshot.config,
          display: { ...snapshot.config.display, ...nextDisplay },
        },
        revision: snapshot.revision + 1,
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createTopologyService(target = TARGET) {
  let current = target;
  const listeners = new Set();
  return {
    listeners,
    getTargetDisplay: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(nextTarget = current) {
      current = nextTarget;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/**
 * 模擬一台螢幕：Apply 依支援模式與 DDC/CI 能力實際改變狀態，讓控制器
 * 重新查詢時看到結果。
 */
function createMonitorControl({
  supported = true,
  current = { width: 1920, height: 1080 },
  modes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ],
  brightness = { supported: true, percent: 80 },
  contrast = { supported: false, percent: null },
  resolutionOutcome = null,
} = {}) {
  const state = {
    current: { ...current },
    brightness: { ...brightness },
    contrast: { ...contrast },
  };
  const calls = [];
  return {
    calls,
    state,
    isSupported: () => supported,
    async query(origin) {
      calls.push({ type: 'query', origin });
      return {
        found: true,
        current: { ...state.current },
        modes,
        brightness: { ...state.brightness },
        contrast: { ...state.contrast },
      };
    },
    async apply(origin, request) {
      calls.push({ type: 'apply', origin, request });
      let resolution = 'unchanged';
      if (request.resolution) {
        resolution = resolutionOutcome ?? 'applied';
        if (resolution === 'applied') {
          state.current = { ...request.resolution };
        }
      }
      const vcp = (capability, percent) => {
        if (percent === null) {
          return 'unchanged';
        }
        if (!capability.supported) {
          return 'unsupported';
        }
        capability.percent = percent;
        return 'applied';
      };
      return {
        found: true,
        resolution,
        brightness: vcp(state.brightness, request.brightnessPercent),
        contrast: vcp(state.contrast, request.contrastPercent),
      };
    },
  };
}

function createController({
  display,
  monitor = createMonitorControl(),
  topology = createTopologyService(),
} = {}) {
  const settingsManager = createSettingsManager(display);
  const warnings = [];
  const controller = new OutputMonitorController({
    topologyService: topology,
    settingsManager,
    monitorControl: monitor,
    screen: {
      // 模擬 150% 縮放：DIP 原點轉成實體像素。
      dipToScreenRect: (_window, rect) => ({
        ...rect,
        x: rect.x * 1.5,
        y: rect.y * 1.5,
      }),
    },
    logger: { warn: (...args) => warnings.push(args), error() {} },
  });
  return { controller, monitor, settingsManager, topology, warnings };
}

test('自動解析度且未設定亮度對比時只查詢，不變更螢幕', async () => {
  const { controller, monitor } = createController();
  controller.initialize();
  await controller.whenIdle();

  assert.deepEqual(monitor.calls, [
    { type: 'query', origin: { x: 1920, y: 0 } },
  ]);
  assert.deepEqual(
    { ...controller.getStatus(), revision: undefined },
    {
      status: 'ready',
      displayId: 2,
      currentResolution: '1920x1080',
      resolutions: ['1920x1080', '1280x720'],
      resolutionError: null,
      brightnessControl: 'hardware',
      contrastControl: 'software',
      revision: undefined,
    },
  );
  assert.deepEqual(controller.getSoftwareAdjustment(), {
    brightnessPercent: 100,
    contrastPercent: 100,
  });
});

test('設定支援的解析度與亮度時以實體原點套用，並發布切換後狀態', async () => {
  const { controller, monitor } = createController({
    display: { renderResolution: '1280x720', brightnessPercent: 35 },
  });
  const published = [];
  controller.subscribe((status) => published.push(status));
  controller.initialize();
  await controller.whenIdle();

  const applies = monitor.calls.filter(({ type }) => type === 'apply');
  assert.deepEqual(applies, [{
    type: 'apply',
    origin: { x: 1920, y: 0 },
    request: {
      resolution: { width: 1280, height: 720 },
      brightnessPercent: 35,
      contrastPercent: null,
    },
  }]);
  assert.equal(controller.getStatus().currentResolution, '1280x720');
  assert.equal(controller.getStatus().resolutionError, null);
  assert.equal(monitor.state.brightness.percent, 35);
  assert.equal(published.at(-1), controller.getStatus());
});

test('螢幕不支援的解析度不呼叫 Apply，並回報 unsupported', async () => {
  const { controller, monitor } = createController({
    display: { renderResolution: '3840x2160' },
  });
  controller.initialize();
  await controller.whenIdle();

  assert.equal(monitor.calls.some(({ type }) => type === 'apply'), false);
  assert.equal(controller.getStatus().resolutionError, 'unsupported');
  assert.equal(controller.getStatus().currentResolution, '1920x1080');
});

test('解析度切換失敗後同組設定不重試，重新儲存設定才再試', async () => {
  const monitor = createMonitorControl({ resolutionOutcome: 'failed' });
  const { controller, settingsManager, topology, warnings } = createController({
    display: { renderResolution: '1280x720' },
    monitor,
  });
  controller.initialize();
  await controller.whenIdle();

  assert.equal(controller.getStatus().resolutionError, 'failed');
  assert.equal(warnings.length, 1);
  const appliesAfterFailure = () =>
    monitor.calls.filter(({ type }) => type === 'apply').length;
  assert.equal(appliesAfterFailure(), 1);

  // Windows 顯示事件或同一螢幕位置變動不得造成重試迴圈。
  topology.publish({ ...TARGET, bounds: { ...TARGET.bounds, y: 10 } });
  await controller.whenIdle();
  assert.equal(appliesAfterFailure(), 1);
  assert.equal(controller.getStatus().resolutionError, 'failed');

  settingsManager.update({ brightnessPercent: 50 });
  await controller.whenIdle();
  assert.equal(appliesAfterFailure(), 2);
});

test('不支援 DDC/CI 的項目改用軟體調整，不設定時維持 100%', async () => {
  const monitor = createMonitorControl({
    brightness: { supported: false, percent: null },
    contrast: { supported: true, percent: 50 },
  });
  const { controller, settingsManager } = createController({
    display: { brightnessPercent: 40, contrastPercent: 70 },
    monitor,
  });
  controller.initialize();
  await controller.whenIdle();

  assert.equal(controller.getStatus().brightnessControl, 'software');
  assert.equal(controller.getStatus().contrastControl, 'hardware');
  assert.equal(monitor.state.contrast.percent, 70);
  assert.deepEqual(controller.getSoftwareAdjustment(), {
    brightnessPercent: 40,
    contrastPercent: 100,
  });

  settingsManager.update({ brightnessPercent: null });
  await controller.whenIdle();
  assert.deepEqual(controller.getSoftwareAdjustment(), {
    brightnessPercent: 100,
    contrastPercent: 100,
  });
});

test('非 Windows 平台不執行螢幕控制，亮度對比全部以軟體調整', async () => {
  const monitor = createMonitorControl({ supported: false });
  const { controller } = createController({
    display: { renderResolution: '1280x720', brightnessPercent: 60 },
    monitor,
  });
  controller.initialize();
  await controller.whenIdle();

  assert.equal(monitor.calls.length, 0);
  assert.equal(controller.getStatus().status, 'unsupported');
  assert.deepEqual(controller.getStatus().resolutions, []);
  assert.deepEqual(controller.getSoftwareAdjustment(), {
    brightnessPercent: 60,
    contrastPercent: 100,
  });
});

test('沒有訊息螢幕時不查詢；同步依序執行並合併期間的變更', async () => {
  const topology = createTopologyService(null);
  const monitor = createMonitorControl();
  let releaseQuery;
  const originalQuery = monitor.query;
  let concurrent = 0;
  let maximumConcurrent = 0;
  monitor.query = async (origin) => {
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    if (!releaseQuery) {
      await new Promise((resolve) => {
        releaseQuery = resolve;
      });
    }
    concurrent -= 1;
    return originalQuery(origin);
  };
  const { controller, settingsManager } = createController({
    monitor,
    topology,
  });
  controller.initialize();
  await controller.whenIdle();
  assert.equal(controller.getStatus().status, 'no-display');
  assert.equal(monitor.calls.length, 0);

  topology.publish(TARGET);
  settingsManager.update({ brightnessPercent: 20 });
  settingsManager.update({ brightnessPercent: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  releaseQuery();
  await controller.whenIdle();

  assert.equal(maximumConcurrent, 1);
  assert.equal(monitor.state.brightness.percent, 30);
});

test('dispose 後解除訂閱且不再發布', async () => {
  const { controller, settingsManager, topology } = createController();
  const published = [];
  controller.subscribe((status) => published.push(status));
  controller.initialize();
  await controller.whenIdle();
  const count = published.length;

  controller.dispose();
  settingsManager.update({ brightnessPercent: 10 });
  topology.publish({ ...TARGET, id: 9 });
  await controller.whenIdle();

  assert.equal(published.length, count);
  assert.equal(settingsManager.listeners.size, 0);
  assert.equal(topology.listeners.size, 0);
});
