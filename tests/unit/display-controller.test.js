'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'display', 'display-controller.mjs'),
).toString();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createPage(revision, message) {
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

async function loadController() {
  return import(moduleUrl);
}

test('Display 先訂閱再 GET；新 event 不會被較舊的啟動回應覆蓋', async () => {
  const { createDisplayController } = await loadController();
  const initial = deferred();
  const order = [];
  const rendered = [];
  let listener;
  let unsubscribeCount = 0;
  const api = {
    onPresentationChanged(next) {
      order.push('subscribe');
      listener = next;
      return () => {
        unsubscribeCount += 1;
      };
    },
    getPresentation() {
      order.push('get');
      return initial.promise;
    },
  };
  const controller = createDisplayController({
    api,
    view: { renderPresentation: (snapshot) => rendered.push(snapshot) },
  });
  const startPromise = controller.start();

  assert.deepEqual(order, ['subscribe', 'get']);
  listener(createPage(2, '最新頁'));
  initial.resolve({ ok: true, data: createPage(1, '過期頁') });

  assert.equal(await startPromise, true);
  assert.deepEqual(rendered, [createPage(2, '最新頁')]);

  controller.dispose();
  controller.dispose();
  assert.equal(unsubscribeCount, 1);
});

test('Display 忽略相同、較舊與畸形事件，快速更新後只保留最高 revision', async () => {
  const { createDisplayController } = await loadController();
  const rendered = [];
  let listener;
  const controller = createDisplayController({
    api: {
      onPresentationChanged(next) {
        listener = next;
        return () => {};
      },
      getPresentation: async () => ({
        ok: true,
        data: createPage(0, '初始'),
      }),
    },
    view: { renderPresentation: (snapshot) => rendered.push(snapshot) },
  });
  await controller.start();

  for (let revision = 1; revision <= 100; revision += 1) {
    listener(createPage(revision, `訊息${revision}`));
  }
  listener(createPage(99, '過期'));
  listener({ unexpected: true, revision: 101 });

  assert.equal(rendered.at(-1).revision, 100);
  assert.equal(rendered.at(-1).messages[0].message, '訊息100');
  assert.equal(rendered.length, 101);
});

test('GET rejection／錯誤 envelope 不在電視顯示錯誤文字，也不清除最後畫面', async () => {
  const { createDisplayController } = await loadController();
  const rendered = [];
  let listener;
  const api = {
    onPresentationChanged(next) {
      listener = next;
      return () => {};
    },
    getPresentation: async () => {
      throw new Error('/private/config.json');
    },
  };
  const controller = createDisplayController({
    api,
    view: { renderPresentation: (snapshot) => rendered.push(snapshot) },
  });

  listener = null;
  assert.equal(await controller.start(), false);
  assert.deepEqual(rendered, []);

  listener(createPage(4, '保留內容'));
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].messages[0].message, '保留內容');
});

test('缺少解除訂閱函式或錯誤 success envelope 時安全失敗', async () => {
  const { createDisplayController } = await loadController();
  const rendered = [];
  const invalidSubscription = createDisplayController({
    api: {
      onPresentationChanged: () => null,
      getPresentation: async () => ({ ok: true, data: createPage(0, '資料') }),
    },
    view: { renderPresentation: (snapshot) => rendered.push(snapshot) },
  });
  const invalidEnvelope = createDisplayController({
    api: {
      onPresentationChanged: () => () => {},
      getPresentation: async () => ({ ok: true, unexpected: true }),
    },
    view: { renderPresentation: (snapshot) => rendered.push(snapshot) },
  });

  assert.equal(await invalidSubscription.start(), false);
  assert.equal(await invalidEnvelope.start(), false);
  assert.deepEqual(rendered, []);
});
