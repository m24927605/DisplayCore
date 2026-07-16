'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'control', 'control-controller.mjs'),
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

function createBlankSnapshot(revision = 0) {
  return {
    mode: 'blank',
    messages: [],
    layout: 'single-line',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision,
  };
}

function createPageSnapshot(revision, message = '001請至前廳') {
  return {
    mode: 'page',
    messages: [{ message }],
    layout: 'single-line',
    pageDurationSeconds: 3,
    pageNumber: 1,
    pageCount: 1,
    roundNumber: null,
    totalRounds: null,
    revision,
  };
}

function createViewRecorder() {
  const calls = [];

  return {
    calls,
    view: {
      setBusy: (busy) => calls.push(['busy', busy]),
      renderPresentation: (snapshot) => calls.push(['presentation', snapshot]),
      renderStatus: (message) => calls.push(['status', message]),
      renderError: (message) => calls.push(['error', message]),
    },
  };
}

async function loadController() {
  return import(moduleUrl);
}

test('啟動時先訂閱再取 snapshot，較舊 query 不覆蓋較新 event', async () => {
  const { createControlController } = await loadController();
  const initialResponse = createDeferred();
  const callOrder = [];
  let eventListener;
  let unsubscribeCount = 0;
  const { calls, view } = createViewRecorder();
  const api = {
    onPresentationChanged(listener) {
      callOrder.push('subscribe');
      eventListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
    getPresentation() {
      callOrder.push('get');
      return initialResponse.promise;
    },
    startProgram: async () => {
      throw new Error('此測試不應啟動清單');
    },
    showEmergency: async () => {
      throw new Error('此測試不應顯示滿屏');
    },
    clearPresentation: async () => {
      throw new Error('此測試不應清除');
    },
  };
  const controller = createControlController({ api, view });
  const startPromise = controller.start();

  assert.deepEqual(callOrder, ['subscribe', 'get']);

  eventListener(createPageSnapshot(2, '新事件'));
  initialResponse.resolve({
    ok: true,
    data: createPageSnapshot(1, '舊 snapshot'),
  });
  await startPromise;

  assert.deepEqual(
    calls.filter(([type]) => type === 'presentation'),
    [['presentation', createPageSnapshot(2, '新事件')]],
  );

  controller.dispose();
  controller.dispose();
  assert.equal(unsubscribeCount, 1);
});

test('啟動播放只傳完整 program，並同步阻擋重複提交', async () => {
  const { createControlController } = await loadController();
  const response = createDeferred();
  const apiCalls = [];
  const { calls, view } = createViewRecorder();
  const api = {
    onPresentationChanged: () => () => {},
    getPresentation: async () => ({ ok: true, data: createBlankSnapshot() }),
    startProgram(program) {
      apiCalls.push(program);
      return response.promise;
    },
    showEmergency: async () => ({ ok: false }),
    clearPresentation: async () => ({ ok: false }),
  };
  const controller = createControlController({ api, view });
  await controller.start();
  const program = {
    messages: [{ message: '001請至前廳' }],
    pageDurationSeconds: 3,
    repeat: { mode: 'continuous' },
  };

  const firstOperation = controller.startProgram(program, '清單已顯示。');
  const duplicateOperation = await controller.startProgram(
    { ...program, messages: [{ message: '重複' }] },
    '不應顯示。',
  );

  assert.equal(duplicateOperation, false);
  assert.deepEqual(apiCalls, [program]);

  response.resolve({ ok: true, data: createPageSnapshot(1) });
  assert.equal(await firstOperation, true);
  assert.deepEqual(
    calls.filter(([type]) => type === 'busy').slice(-2),
    [
      ['busy', true],
      ['busy', false],
    ],
  );
  assert.deepEqual(calls.at(-2), ['status', '清單已顯示。']);
});

test('緊急代碼與清除使用各自專用 API；錯誤 envelope 不改變目前畫面', async () => {
  const { createControlController } = await loadController();
  const apiCalls = [];
  const { calls, view } = createViewRecorder();
  const api = {
    onPresentationChanged: () => () => {},
    getPresentation: async () => ({
      ok: true,
      data: createPageSnapshot(4, '既有內容'),
    }),
    startProgram: async () => {
      throw new Error('此測試不可啟動清單');
    },
    showEmergency: async (code) => {
      apiCalls.push(['emergency', code]);
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '操作失敗，請稍後再試。',
        },
      };
    },
    clearPresentation: async () => {
      apiCalls.push(['clear']);
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: '操作失敗，請稍後再試。',
        },
      };
    },
  };
  const controller = createControlController({ api, view });
  await controller.start();
  const presentationCount = calls.filter(
    ([type]) => type === 'presentation',
  ).length;

  assert.equal(await controller.showEmergency('555'), false);
  assert.equal(await controller.clearPresentation(), false);
  assert.deepEqual(apiCalls, [['emergency', '555'], ['clear']]);
  assert.equal(
    calls.filter(([type]) => type === 'presentation').length,
    presentationCount,
  );
  assert.deepEqual(calls.at(-2), ['error', '操作失敗，請稍後再試。']);
});

test('invoke rejection 與畸形 response 只顯示固定本機錯誤', async () => {
  const { createControlController } = await loadController();
  const { calls, view } = createViewRecorder();
  const api = {
    onPresentationChanged: () => () => {},
    getPresentation: async () => {
      throw new Error('/private/config.json: stack trace');
    },
    startProgram: async () => ({ unexpected: true }),
    showEmergency: async () => ({ unexpected: true }),
    clearPresentation: async () => ({ unexpected: true }),
  };
  const controller = createControlController({ api, view });

  assert.equal(await controller.start(), false);
  assert.deepEqual(calls.at(-1), [
    'error',
    '無法連接主程序，請重新啟動 DisplayCore。',
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /private|stack trace/);

  assert.equal(
    await controller.startProgram(
      {
        messages: [{ message: '公告' }],
        pageDurationSeconds: 3,
        repeat: { mode: 'continuous' },
      },
      '不應成功',
    ),
    false,
  );
  assert.deepEqual(calls.at(-2), [
    'error',
    '主程序回傳無效資料，請重新啟動 DisplayCore。',
  ]);
});
