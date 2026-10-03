'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'control', 'output-state.mjs'),
).toString();

function createSnapshot(overrides = {}) {
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
      label: '前廳電視',
      width: 3840,
      height: 2160,
      scaleFactor: 1.5,
      isPrimary: false,
      isInternal: false,
    }],
    effectiveControlDisplayId: 1,
    configuredControlDisplayId: null,
    controlUsingFallback: false,
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
    monitor: {
      status: 'ready',
      displayId: 2,
      currentResolution: '3840x2160',
      resolutions: ['3840x2160', '1920x1080'],
      resolutionError: null,
      brightnessControl: 'hardware',
      contrastControl: 'software',
      brightnessPercent: 65,
      contrastPercent: null,
      revision: 2,
    },
    ...overrides,
  };
}

function withPlacement(snapshot, overrides) {
  return {
    ...snapshot,
    placement: { ...snapshot.placement, ...overrides },
  };
}

async function loadState() {
  return import(moduleUrl);
}

test('驗證成功時建立不受來源後續修改影響的深層唯讀快照與 UX', async () => {
  const { validateOutputSnapshot } = await loadState();
  const candidate = createSnapshot();
  const result = validateOutputSnapshot(candidate);

  assert.equal(result.ok, true);
  assert.notEqual(result.snapshot, candidate);
  assert.notEqual(result.snapshot.displays, candidate.displays);
  assert.notEqual(result.snapshot.displays[0], candidate.displays[0]);
  assert.notEqual(result.snapshot.placement, candidate.placement);
  assert.deepEqual(result.snapshot, candidate);
  assert.deepEqual(result.ux, {
    hdmi: {
      status: 'connected',
      message: '已偵測到 HDMI 連接。',
    },
    routing: {
      status: 'applied',
      message: '畫面已輸出至前廳電視。',
    },
  });

  for (const value of [
    result,
    result.snapshot,
    result.snapshot.displays,
    result.snapshot.displays[0],
    result.snapshot.placement,
    result.snapshot.monitor,
    result.snapshot.monitor.resolutions,
    result.ux,
    result.ux.hdmi,
    result.ux.routing,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }

  candidate.displays[1].label = '已被竄改';
  candidate.displays.push({ ...candidate.displays[0], id: 99 });
  candidate.placement.status = 'error';

  assert.equal(result.snapshot.displays.length, 2);
  assert.equal(result.snapshot.displays[1].label, '前廳電視');
  assert.equal(result.snapshot.placement.status, 'applied');
});

test('exact schema、資源上限與欄位關聯任一不符時安全拒絕', async () => {
  const { validateOutputSnapshot } = await loadState();
  const base = createSnapshot();
  const displaysWithSymbol = [...base.displays];
  displaysWithSymbol[Symbol('private')] = true;
  const invalidCandidates = [
    null,
    { ...base, extra: true },
    (() => {
      const { monitor: _removed, ...missing } = base;
      return missing;
    })(),
    { ...base, monitor: { ...base.monitor, deviceName: '\\\\.\\DISPLAY2' } },
    { ...base, monitor: { ...base.monitor, status: 'busy' } },
    { ...base, monitor: { ...base.monitor, currentResolution: '3840×2160' } },
    { ...base, monitor: { ...base.monitor, resolutions: ['1920x1080', 720] } },
    { ...base, monitor: { ...base.monitor, brightnessControl: 'ddc' } },
    { ...base, monitor: { ...base.monitor, resolutionError: 'timeout' } },
    (() => {
      const { fullscreen: _removed, ...missing } = base;
      return missing;
    })(),
    {
      ...base,
      displays: [{ ...base.displays[0], privateDevicePath: '\\\\?\\DISPLAY' }],
      effectiveDisplayId: 1,
    },
    {
      ...base,
      displays: [{ ...base.displays[0], label: '螢'.repeat(81) }],
      effectiveDisplayId: 1,
    },
    {
      ...base,
      displays: Array.from({ length: 33 }, (_value, id) => ({
        ...base.displays[0],
        id,
        isPrimary: id === 0,
      })),
      effectiveDisplayId: 0,
    },
    { ...base, displays: displaysWithSymbol },
    { ...base, displays: [base.displays[0], { ...base.displays[0] }], effectiveDisplayId: 1 },
    { ...base, effectiveDisplayId: 99 },
    { ...base, effectiveControlDisplayId: 99 },
    { ...base, configuredDisplayId: 2 },
    { ...base, selectionMode: 'manual', configuredDisplayId: null },
    { ...base, selectionMode: 'manual', configuredDisplayId: 99, usingFallback: false },
    { ...base, topologyRevision: -1 },
    { ...base, hdmiConnectionStatus: 'yes' },
    { ...base, displays: [{ ...base.displays[0], width: 65536 }], effectiveDisplayId: 1 },
    { ...base, displays: [{ ...base.displays[0], scaleFactor: Infinity }], effectiveDisplayId: 1 },
    withPlacement(base, { extra: true }),
    withPlacement(base, { revision: 1.5 }),
  ];

  for (const candidate of invalidCandidates) {
    assert.deepEqual(validateOutputSnapshot(candidate), { ok: false });
  }
});

test('惡意 Proxy 或 accessor 不會讓驗證例外及原始內容逸出', async () => {
  const { validateOutputSnapshot } = await loadState();
  const throwingProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error('/private/secret-device-path');
    },
  });
  const accessorCandidate = createSnapshot();
  Object.defineProperty(accessorCandidate, 'topologyStatus', {
    enumerable: true,
    get() {
      throw new Error('不應執行 getter');
    },
  });

  assert.doesNotThrow(() => validateOutputSnapshot(throwingProxy));
  assert.deepEqual(validateOutputSnapshot(throwingProxy), { ok: false });
  assert.deepEqual(validateOutputSnapshot(accessorCandidate), { ok: false });
});

test('topology 與 placement revision 採 component-wise 偏序避免局部回滾', async () => {
  const { acceptOutputSnapshot, validateOutputSnapshot } = await loadState();
  const initial = acceptOutputSnapshot(null, createSnapshot({
    topologyRevision: 5,
    placement: {
      status: 'applied',
      displayId: 2,
      fullscreen: true,
      revision: 8,
    },
  }));

  assert.equal(initial.accepted, true);

  const topologyAdvanced = acceptOutputSnapshot(
    initial.snapshot,
    createSnapshot({
      topologyRevision: 6,
      placement: { ...initial.snapshot.placement },
    }),
  );
  assert.equal(topologyAdvanced.accepted, true);

  const placementAdvanced = acceptOutputSnapshot(
    initial.snapshot,
    createSnapshot({
      topologyRevision: 5,
      placement: { ...initial.snapshot.placement, revision: 9 },
    }),
  );
  assert.equal(placementAdvanced.accepted, true);

  // 只有輸出螢幕控制狀態更新（例如解析度切換完成）也必須被接受。
  const monitorAdvanced = acceptOutputSnapshot(
    initial.snapshot,
    createSnapshot({
      topologyRevision: 5,
      placement: { ...initial.snapshot.placement },
      monitor: { ...initial.snapshot.monitor, revision: 3 },
    }),
  );
  assert.equal(monitorAdvanced.accepted, true);
  assert.deepEqual(
    acceptOutputSnapshot(
      initial.snapshot,
      createSnapshot({
        topologyRevision: 6,
        placement: { ...initial.snapshot.placement },
        monitor: { ...initial.snapshot.monitor, revision: 1 },
      }),
    ),
    { accepted: false },
  );

  for (const candidate of [
    createSnapshot({
      topologyRevision: 6,
      placement: { ...initial.snapshot.placement, revision: 7 },
    }),
    createSnapshot({
      topologyRevision: 4,
      placement: { ...initial.snapshot.placement, revision: 9 },
    }),
    createSnapshot({
      topologyRevision: 5,
      placement: { ...initial.snapshot.placement },
    }),
  ]) {
    assert.deepEqual(
      acceptOutputSnapshot(initial.snapshot, candidate),
      { accepted: false },
    );
  }

  assert.deepEqual(
    acceptOutputSnapshot({ topologyRevision: 5 }, createSnapshot()),
    { accepted: false },
  );
  assert.equal(validateOutputSnapshot(initial.snapshot).ok, true);
});

test('routing UX 依錯誤、無目標、手動 fallback、未知、等待與已套用判定', async () => {
  const { validateOutputSnapshot } = await loadState();
  const scenarios = [
    [
      withPlacement(createSnapshot(), { status: 'error' }),
      'error',
    ],
    [
      createSnapshot({
        displays: [],
        effectiveControlDisplayId: null,
        effectiveDisplayId: null,
        placement: {
          status: 'pending',
          displayId: null,
          fullscreen: true,
          revision: 4,
        },
      }),
      'no-target',
    ],
    [
      createSnapshot({
        selectionMode: 'manual',
        configuredControlDisplayId: 1,
        configuredDisplayId: 99,
        usingFallback: true,
      }),
      'manual-fallback',
    ],
    [createSnapshot({ topologyStatus: 'unknown' }), 'unknown'],
    [withPlacement(createSnapshot(), { status: 'pending' }), 'pending'],
    [withPlacement(createSnapshot(), { displayId: 1 }), 'pending'],
    [createSnapshot(), 'applied'],
  ];

  for (const [candidate, expectedStatus] of scenarios) {
    const result = validateOutputSnapshot(candidate);
    assert.equal(result.ok, true);
    assert.equal(result.ux.routing.status, expectedStatus);
  }
});

test('HDMI UX 保留四態語意且不把 unknown 說成未連接', async () => {
  const { validateOutputSnapshot } = await loadState();
  const expectedMessages = {
    detecting: '正在偵測 HDMI 連接狀態。',
    connected: '已偵測到 HDMI 連接。',
    'not-connected': '未偵測到作用中的 HDMI 連接。',
    unknown: '無法判定 HDMI 連接狀態。',
  };

  for (const [status, message] of Object.entries(expectedMessages)) {
    const result = validateOutputSnapshot(createSnapshot({
      hdmiConnectionStatus: status,
    }));

    assert.equal(result.ok, true);
    assert.deepEqual(result.ux.hdmi, { status, message });
  }
});
