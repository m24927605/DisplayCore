'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  DisplayTopologyService,
} = require('../../main/display-topology-service');

function createDisplay(id, overrides = {}) {
  return {
    id,
    label: `螢幕 ${id}`,
    detected: true,
    internal: false,
    bounds: { x: (id - 1) * 1920, y: 0, width: 1920, height: 1080 },
    workArea: {
      x: (id - 1) * 1920,
      y: 0,
      width: 1920,
      height: 1040,
    },
    scaleFactor: 1,
    ...overrides,
  };
}

class FakeScreen extends EventEmitter {
  constructor(displays, primaryDisplayId) {
    super();
    this.displays = displays;
    this.primaryDisplayId = primaryDisplayId;
    this.cursorDisplayId = primaryDisplayId;
  }

  getCursorScreenPoint() {
    return { x: 0, y: 0 };
  }

  getDisplayNearestPoint() {
    return this.displays.find(({ id }) => id === this.cursorDisplayId) ??
      this.displays.find(({ id }) => id === this.primaryDisplayId);
  }

  getAllDisplays() {
    return this.displays;
  }

  getPrimaryDisplay() {
    return this.displays.find(({ id }) => id === this.primaryDisplayId);
  }
}

class FakeSettingsManager {
  constructor(display, revision = 0) {
    this.snapshot = {
      revision,
      config: { display },
    };
    this.listeners = new Set();
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(display) {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      config: { display },
    };

    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

function manualAssignment(controlDisplayId, defaultDisplayId) {
  return {
    selectionMode: 'manual',
    controlDisplayId,
    defaultDisplayId,
    fullscreen: true,
    renderResolution: 'auto',
  };
}

function createHarness() {
  const primary = createDisplay(1, {
    label: '管理螢幕',
    internal: true,
  });
  const television = createDisplay(2, { label: '訊息電視' });
  const screen = new FakeScreen([primary, television], 1);
  const settingsManager = new FakeSettingsManager(manualAssignment(1, 2));
  const service = new DisplayTopologyService({
    screen,
    settingsManager,
    hdmiDetector: {
      async detect() {
        return { status: 'connected' };
      },
    },
  });

  return { primary, screen, service, settingsManager, television };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('設定儲存後立即交換 Control 與 Display 的有效螢幕', async () => {
  const { service, settingsManager } = createHarness();
  const published = [];
  service.subscribe((snapshot) => published.push(snapshot));

  await service.initialize();
  await flushAsyncWork();
  published.length = 0;

  assert.equal(service.getControlTargetDisplay().id, 1);
  assert.equal(service.getTargetDisplay().id, 2);

  settingsManager.publish(manualAssignment(2, 1));

  assert.equal(service.getControlTargetDisplay().id, 2);
  assert.equal(service.getTargetDisplay().id, 1);
  assert.equal(published.length, 1);
  assert.deepEqual(
    {
      configuredControlDisplayId:
        service.getSnapshot().configuredControlDisplayId,
      effectiveControlDisplayId:
        service.getSnapshot().effectiveControlDisplayId,
      configuredDisplayId: service.getSnapshot().configuredDisplayId,
      effectiveDisplayId: service.getSnapshot().effectiveDisplayId,
      configRevision: service.getSnapshot().configRevision,
    },
    {
      configuredControlDisplayId: 2,
      effectiveControlDisplayId: 2,
      configuredDisplayId: 1,
      effectiveDisplayId: 1,
      configRevision: 1,
    },
  );
});

test('指定螢幕拔除時保留設定並回退，重新接上後自動返回', async () => {
  const { primary, screen, service, settingsManager, television } =
    createHarness();

  await service.initialize();

  screen.displays = [primary];
  screen.emit('display-removed', {}, television);
  await flushAsyncWork();

  assert.equal(service.getSnapshot().configuredControlDisplayId, 1);
  assert.equal(service.getSnapshot().configuredDisplayId, 2);
  assert.equal(service.getSnapshot().effectiveControlDisplayId, 1);
  assert.equal(service.getSnapshot().effectiveDisplayId, 1);
  assert.equal(service.getSnapshot().controlUsingFallback, false);
  assert.equal(service.getSnapshot().usingFallback, true);

  screen.displays = [primary, television];
  screen.emit('display-added', {}, television);
  await flushAsyncWork();

  assert.equal(service.getControlTargetDisplay().id, 1);
  assert.equal(service.getTargetDisplay().id, 2);
  assert.equal(service.getSnapshot().usingFallback, false);

  service.dispose();
  assert.equal(settingsManager.listeners.size, 0);
});

test('控制台與訊息可指定同一螢幕，且不視為回退', async () => {
  const { service, settingsManager } = createHarness();

  await service.initialize();
  settingsManager.publish(manualAssignment(2, 2));

  assert.equal(service.getControlTargetDisplay().id, 2);
  assert.equal(service.getTargetDisplay().id, 2);
  assert.equal(service.getSnapshot().controlUsingFallback, false);
  assert.equal(service.getSnapshot().usingFallback, false);

  service.dispose();
});

test('只指定訊息螢幕時，控制台維持自動且不視為回退', async () => {
  const { service, settingsManager } = createHarness();

  await service.initialize();
  settingsManager.publish(manualAssignment(null, 1));

  assert.equal(service.getTargetDisplay().id, 1);
  assert.equal(service.getControlTargetDisplay().id, 2);
  assert.equal(service.getSnapshot().configuredControlDisplayId, null);
  assert.equal(service.getSnapshot().controlUsingFallback, false);
  assert.equal(service.getSnapshot().usingFallback, false);

  service.dispose();
});

test('自動分工固定由主螢幕顯示 Control，副螢幕顯示訊息', async () => {
  const { service, settingsManager } = createHarness();

  settingsManager.snapshot = {
    revision: 0,
    config: {
      display: {
        selectionMode: 'auto',
        controlDisplayId: null,
        defaultDisplayId: null,
        fullscreen: true,
        renderResolution: 'auto',
      },
    },
  };

  await service.initialize();

  assert.equal(service.getControlTargetDisplay().id, 1);
  assert.equal(service.getTargetDisplay().id, 2);
  assert.equal(service.getSnapshot().controlUsingFallback, false);
  assert.equal(service.getSnapshot().usingFallback, false);
});

test('外接電視是 Windows 主螢幕時，Control 啟動在滑鼠所在的管理螢幕', async () => {
  const television = createDisplay(1, {
    label: '主螢幕電視',
    internal: false,
  });
  const operatorDisplay = createDisplay(2, {
    label: '管理螢幕',
    internal: true,
  });
  const screen = new FakeScreen([television, operatorDisplay], 1);
  screen.cursorDisplayId = 2;
  const settingsManager = new FakeSettingsManager({
    selectionMode: 'auto',
    controlDisplayId: null,
    defaultDisplayId: null,
    fullscreen: true,
    renderResolution: 'auto',
  });
  const service = new DisplayTopologyService({
    screen,
    settingsManager,
    hdmiDetector: {
      async detect() {
        return { status: 'connected' };
      },
    },
  });

  await service.initialize();

  assert.equal(service.getTargetDisplay().id, 1);
  assert.equal(service.getControlTargetDisplay().id, 2);
  assert.equal(service.getSnapshot().effectiveControlDisplayId, 2);
});

test('Control 啟動在滑鼠所在螢幕，不沿用可能已變動的已存螢幕 ID', async () => {
  const { screen, service } = createHarness();
  screen.cursorDisplayId = 2;
  // Saved settings say control=1, message=2, but the cursor is on display 2.

  await service.initialize();

  assert.equal(service.getControlTargetDisplay().id, 2);
  assert.equal(service.getTargetDisplay().id, 2);

  service.dispose();
});

test('救援快捷鍵把 Control 移到滑鼠所在螢幕，自動訊息螢幕會避開它', async () => {
  const television = createDisplay(1, { label: '電視' });
  const operatorDisplay = createDisplay(2, { label: '管理螢幕' });
  const screen = new FakeScreen([television, operatorDisplay], 1);
  const settingsManager = new FakeSettingsManager({
    selectionMode: 'auto',
    controlDisplayId: null,
    defaultDisplayId: null,
    fullscreen: true,
    renderResolution: 'auto',
  });
  const service = new DisplayTopologyService({
    screen,
    settingsManager,
    hdmiDetector: {
      async detect() {
        return { status: 'connected' };
      },
    },
  });

  await service.initialize();
  assert.equal(service.getControlTargetDisplay().id, 1);
  assert.equal(service.getTargetDisplay().id, 2);

  screen.cursorDisplayId = 2;
  assert.equal(service.moveControlToCursorDisplay(), true);

  assert.equal(service.getControlTargetDisplay().id, 2);
  assert.equal(service.getTargetDisplay().id, 1);

  service.dispose();
});

test('設定改選其他控制台螢幕時解除滑鼠固定，改依設定擺放', async () => {
  const { screen, service, settingsManager } = createHarness();
  screen.cursorDisplayId = 2;

  await service.initialize();
  assert.equal(service.getControlTargetDisplay().id, 2);

  settingsManager.publish(manualAssignment(1, 2));
  assert.equal(service.getControlTargetDisplay().id, 2);

  settingsManager.publish(manualAssignment(2, 1));
  settingsManager.publish(manualAssignment(1, 2));
  assert.equal(service.getControlTargetDisplay().id, 1);

  service.dispose();
});
