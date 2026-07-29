'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'control', 'output-controller.mjs'),
).toString();

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createSnapshot(topologyRevision, placementRevision, overrides = {}) {
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
    topologyRevision,
    placement: {
      status: 'applied',
      displayId: 2,
      fullscreen: true,
      revision: placementRevision,
    },
    ...overrides,
  };
}

function createViewRecorder() {
  const calls = [];

  return {
    calls,
    view: {
      renderOutputStatus: (snapshot, ux) => calls.push(['status', snapshot, ux]),
      renderOutputError: (message) => calls.push(['error', message]),
    },
  };
}

async function loadController() {
  return import(moduleUrl);
}

test('啟動先訂閱再 GET，較舊 query 不覆蓋初始化期間的新事件', async () => {
  const { createOutputController } = await loadController();
  const deferred = createDeferred();
  const callOrder = [];
  let listener;
  const { calls, view } = createViewRecorder();
  const api = {
    onOutputStatusChanged(nextListener) {
      callOrder.push('subscribe');
      listener = nextListener;
      return () => {};
    },
    getOutputStatus() {
      callOrder.push('get');
      return deferred.promise;
    },
  };
  const controller = createOutputController({ api, view });
  const startPromise = controller.start();

  assert.deepEqual(callOrder, ['subscribe', 'get']);

  listener(createSnapshot(3, 5));
  deferred.resolve({ ok: true, data: createSnapshot(2, 5) });

  assert.equal(await startPromise, true);
  assert.deepEqual(
    calls.filter(([type]) => type === 'status').map(([, snapshot]) => [
      snapshot.topologyRevision,
      snapshot.placement.revision,
    ]),
    [[3, 5]],
  );
});

test('任一 component revision 回滾的事件會忽略且不誤報格式錯誤', async () => {
  const { createOutputController } = await loadController();
  let listener;
  const { calls, view } = createViewRecorder();
  const api = {
    onOutputStatusChanged(nextListener) {
      listener = nextListener;
      return () => {};
    },
    getOutputStatus: async () => ({ ok: true, data: createSnapshot(4, 7) }),
  };
  const controller = createOutputController({ api, view });

  assert.equal(await controller.start(), true);
  listener(createSnapshot(5, 6));
  listener(createSnapshot(3, 8));
  listener(createSnapshot(4, 7));

  assert.equal(calls.filter(([type]) => type === 'status').length, 1);
  assert.equal(calls.filter(([type]) => type === 'error').length, 0);
});

test('畸形事件只顯示固定本機錯誤並保留最後有效輸出狀態', async () => {
  const { createOutputController } = await loadController();
  let listener;
  const { calls, view } = createViewRecorder();
  const api = {
    onOutputStatusChanged(nextListener) {
      listener = nextListener;
      return () => {};
    },
    getOutputStatus: async () => ({ ok: true, data: createSnapshot(1, 1) }),
  };
  const controller = createOutputController({ api, view });

  await controller.start();
  const renderedSnapshot = calls.find(([type]) => type === 'status')[1];
  listener({ ...createSnapshot(2, 2), leakedPath: '/private/config.json' });

  assert.equal(calls.filter(([type]) => type === 'status').length, 1);
  assert.equal(calls.find(([type]) => type === 'status')[1], renderedSnapshot);
  assert.deepEqual(calls.at(-1), [
    'error',
    '主程序回傳無效的輸出狀態，將保留最近一次有效資料。',
  ]);
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /private|config\.json/);
});

test('GET rejection 不清除初始化期間已收到的有效事件', async () => {
  const { createOutputController } = await loadController();
  const deferred = createDeferred();
  let listener;
  const { calls, view } = createViewRecorder();
  const api = {
    onOutputStatusChanged(nextListener) {
      listener = nextListener;
      return () => {};
    },
    getOutputStatus: () => deferred.promise,
  };
  const controller = createOutputController({ api, view });
  const startPromise = controller.start();

  listener(createSnapshot(8, 5));
  deferred.reject(new Error('/Users/name/secret.txt'));

  assert.equal(await startPromise, false);
  assert.equal(calls.filter(([type]) => type === 'status').length, 1);
  assert.deepEqual(calls.at(-1), [
    'error',
    '無法取得輸出狀態，將保留最近一次有效資料。',
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /Users|secret/);
});

test('畸形 response Proxy 只回報固定錯誤，不讓 getter 例外拒絕 start', async () => {
  const { createOutputController } = await loadController();
  const { calls, view } = createViewRecorder();
  const response = new Proxy({}, {
    ownKeys() {
      throw new Error('/private/raw-output.json');
    },
  });
  const api = {
    onOutputStatusChanged: () => () => {},
    getOutputStatus: async () => response,
  };
  const controller = createOutputController({ api, view });

  assert.equal(await controller.start(), false);
  assert.deepEqual(calls, [[
    'error',
    '主程序回傳無效的輸出狀態，將保留最近一次有效資料。',
  ]]);
  assert.doesNotMatch(JSON.stringify(calls), /private|raw-output/);
});

test('dispose 精確解除一次訂閱，並忽略尚未完成的 GET 與後續事件', async () => {
  const { createOutputController } = await loadController();
  const deferred = createDeferred();
  let listener;
  let unsubscribeCount = 0;
  const { calls, view } = createViewRecorder();
  const api = {
    onOutputStatusChanged(nextListener) {
      listener = nextListener;
      return () => {
        unsubscribeCount += 1;
      };
    },
    getOutputStatus: () => deferred.promise,
  };
  const controller = createOutputController({ api, view });
  const startPromise = controller.start();

  controller.dispose();
  controller.dispose();
  listener(createSnapshot(2, 2));
  deferred.resolve({ ok: true, data: createSnapshot(1, 1) });

  assert.equal(await startPromise, false);
  assert.equal(unsubscribeCount, 1);
  assert.deepEqual(calls, []);
  assert.equal(await controller.start(), false);
});

test('不完整 bridge 或 view 會在建立時以固定 TypeError 拒絕', async () => {
  const { createOutputController } = await loadController();

  assert.throws(
    () => createOutputController({ api: {}, view: {} }),
    {
      name: 'TypeError',
      message: '輸出狀態控制器缺少必要相依。',
    },
  );
});
