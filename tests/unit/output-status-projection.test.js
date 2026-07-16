'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createControlOutputSnapshot,
} = require('../../ipc/output-status');

function createTopology(overrides = {}) {
  return {
    schemaVersion: 1,
    topologyStatus: 'ready',
    hdmiConnectionStatus: 'connected',
    displays: [{
      id: 1,
      label: '內建螢幕',
      width: 1920,
      height: 1080,
      scaleFactor: 1,
      isPrimary: true,
      isInternal: true,
    }, {
      id: 2,
      label: '客廳電視',
      width: 3840,
      height: 2160,
      scaleFactor: 1.5,
      isPrimary: false,
      isInternal: false,
    }],
    effectiveDisplayId: 2,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    secondDisplayConnected: true,
    configRevision: 4,
    revision: 7,
    ...overrides,
  };
}

function createPlacement(overrides = {}) {
  return {
    status: 'applied',
    displayId: 2,
    fullscreen: true,
    revision: 3,
    ...overrides,
  };
}

test('Control 輸出快照只投影安全顯示欄位與實際 placement 狀態', () => {
  const topology = createTopology();
  topology.displays[1].bounds = { x: 1920, y: 0, width: 2560, height: 1440 };
  topology.displays[1].workArea = { x: 1920, y: 0, width: 2560, height: 1400 };
  topology.activeConnectionCount = 2;
  const snapshot = createControlOutputSnapshot(
    // 模擬服務內部未來增加欄位時，projector 仍不得自動洩漏。
    { ...topology, internalDevicePath: '\\\\?\\DISPLAY#PRIVATE' },
    createPlacement(),
  );

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    topologyStatus: 'ready',
    hdmiConnectionStatus: 'connected',
    displays: [{
      id: 1,
      label: '內建螢幕',
      width: 1920,
      height: 1080,
      scaleFactor: 1,
      isPrimary: true,
      isInternal: true,
    }, {
      id: 2,
      label: '客廳電視',
      width: 3840,
      height: 2160,
      scaleFactor: 1.5,
      isPrimary: false,
      isInternal: false,
    }],
    effectiveDisplayId: 2,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    configRevision: 4,
    topologyRevision: 7,
    placement: {
      status: 'applied',
      displayId: 2,
      fullscreen: true,
      revision: 3,
    },
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.displays), true);
  assert.equal(Object.isFrozen(snapshot.displays[0]), true);
  assert.equal(Object.isFrozen(snapshot.placement), true);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
  assert.equal(Object.hasOwn(snapshot.displays[1], 'bounds'), false);
});

test('輸出投影接受 detecting／unknown 與尚無有效目標的 pending 狀態', () => {
  const snapshot = createControlOutputSnapshot(
    createTopology({
      topologyStatus: 'unknown',
      hdmiConnectionStatus: 'detecting',
      displays: [],
      effectiveDisplayId: null,
      secondDisplayConnected: false,
    }),
    createPlacement({
      status: 'pending',
      displayId: null,
      revision: 0,
    }),
  );

  assert.equal(snapshot.topologyStatus, 'unknown');
  assert.equal(snapshot.hdmiConnectionStatus, 'detecting');
  assert.equal(snapshot.effectiveDisplayId, null);
  assert.equal(snapshot.placement.status, 'pending');
});

test('輸出投影拒絕畸形 enum、重複螢幕、過量欄位與不安全數值', () => {
  const invalidPairs = [
    [null, createPlacement()],
    [createTopology({ topologyStatus: 'loading' }), createPlacement()],
    [createTopology({ hdmiConnectionStatus: 'yes' }), createPlacement()],
    [createTopology({ displays: Array(33).fill(createTopology().displays[0]) }), createPlacement()],
    [createTopology({ displays: [createTopology().displays[0], createTopology().displays[0]] }), createPlacement()],
    [createTopology({ effectiveDisplayId: 99 }), createPlacement()],
    [createTopology({ selectionMode: 'manual', configuredDisplayId: null }), createPlacement()],
    [createTopology({ revision: -1 }), createPlacement()],
    [createTopology(), createPlacement({ status: 'done' })],
    [createTopology(), createPlacement({ displayId: -1 })],
    [createTopology(), createPlacement({ fullscreen: 'true' })],
    [createTopology(), createPlacement({ revision: 1.5 })],
  ];

  for (const [topology, placement] of invalidPairs) {
    assert.throws(
      () => createControlOutputSnapshot(topology, placement),
      /輸出狀態/,
    );
  }
});
