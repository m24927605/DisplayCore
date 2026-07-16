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
    showMessage: async () => {
      throw new Error('此測試不應顯示訊息');
    },
    clearMessage: async () => {
      throw new Error('此測試不應清除訊息');
    },
  };
  const controller = createControlController({ api, view });
  const startPromise = controller.start();

  assert.deepEqual(callOrder, ['subscribe', 'get']);

  eventListener({ message: '新事件', layout: 'single-line', revision: 2 });
  initialResponse.resolve({
    ok: true,
    data: { message: '舊 snapshot', layout: 'single-line', revision: 1 },
  });
  await startPromise;

  assert.deepEqual(
    calls.filter(([type]) => type === 'presentation'),
    [
      [
        'presentation',
        { message: '新事件', layout: 'single-line', revision: 2 },
      ],
    ],
  );

  controller.dispose();
  controller.dispose();
  assert.equal(unsubscribeCount, 1);
});

test('顯示操作只送出單一 message/layout，並同步阻擋重複提交', async () => {
  const { createControlController } = await loadController();
  const response = createDeferred();
  const apiCalls = [];
  const { calls, view } = createViewRecorder();
  const api = {
    onPresentationChanged: () => () => {},
    getPresentation: async () => ({
      ok: true,
      data: { message: '', layout: 'single-line', revision: 0 },
    }),
    showMessage(message, layout) {
      apiCalls.push([message, layout]);
      return response.promise;
    },
    clearMessage: async () => ({ ok: false }),
  };
  const controller = createControlController({ api, view });
  await controller.start();

  const firstOperation = controller.showPresentation(
    { message: '001請至前廳', layout: 'single-line' },
    '訊息已顯示。',
  );
  const duplicateOperation = await controller.showPresentation(
    { message: '重複', layout: 'single-line' },
    '不應顯示。',
  );

  assert.equal(duplicateOperation, false);
  assert.deepEqual(apiCalls, [['001請至前廳', 'single-line']]);

  response.resolve({
    ok: true,
    data: {
      message: '001請至前廳',
      layout: 'single-line',
      revision: 1,
    },
  });
  assert.equal(await firstOperation, true);
  assert.deepEqual(
    calls.filter(([type]) => type === 'busy').slice(-2),
    [
      ['busy', true],
      ['busy', false],
    ],
  );
  assert.deepEqual(calls.at(-2), ['status', '訊息已顯示。']);
});

test('清除使用專用 API；錯誤 envelope 不改變目前畫面', async () => {
  const { createControlController } = await loadController();
  let clearCount = 0;
  const { calls, view } = createViewRecorder();
  const api = {
    onPresentationChanged: () => () => {},
    getPresentation: async () => ({
      ok: true,
      data: { message: '既有內容', layout: 'single-line', revision: 4 },
    }),
    showMessage: async () => {
      throw new Error('清除不可呼叫 showMessage');
    },
    clearMessage: async () => {
      clearCount += 1;
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
  const presentationCountBeforeClear = calls.filter(
    ([type]) => type === 'presentation',
  ).length;

  assert.equal(await controller.clearPresentation(), false);
  assert.equal(clearCount, 1);
  assert.equal(
    calls.filter(([type]) => type === 'presentation').length,
    presentationCountBeforeClear,
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
    showMessage: async () => ({ unexpected: true }),
    clearMessage: async () => ({ unexpected: true }),
  };
  const controller = createControlController({ api, view });

  assert.equal(await controller.start(), false);
  assert.deepEqual(calls.at(-1), ['error', '無法連接主程序，請重新啟動 DisplayCore。']);
  assert.doesNotMatch(JSON.stringify(calls), /private|stack trace/);

  assert.equal(
    await controller.showPresentation(
      { message: '公告', layout: 'single-line' },
      '不應成功',
    ),
    false,
  );
  assert.deepEqual(calls.at(-2), ['error', '主程序回傳無效資料，請重新啟動 DisplayCore。']);
});
