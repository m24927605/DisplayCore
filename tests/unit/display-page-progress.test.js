'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.resolve(
  __dirname,
  '..',
  '..',
  'display',
  'page-progress.mjs',
)).href;

async function loadModule() {
  return import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);
}

const ACCEPTED = Object.freeze({ ok: true, data: { accepted: true } });

function createHarness(reportImpl = () => Promise.resolve(ACCEPTED)) {
  const reports = [];
  const report = (...args) => {
    reports.push(args);
    return reportImpl(...args);
  };

  return { report, reports };
}

function createFakeTimers() {
  const handles = [];

  return {
    handles,
    setTimer(callback, delay) {
      const handle = { callback, delay, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    active() {
      return handles.filter(({ cleared }) => !cleared);
    },
    fireNext() {
      const handle = this.active()[0];
      assert.ok(handle);
      handle.cleared = true;
      handle.callback();
    },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('靜態 layout 回報 pending 與 ready，不等待不存在的動畫', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness();
  const reporter = createPageProgressReporter({ report: harness.report });
  const token = reporter.begin({
    revision: 3,
    pageNumber: 1,
    settingsRevision: 4,
    displayEpoch: 2,
  });

  assert.deepEqual(token, {
    revision: 3,
    pageNumber: 1,
    settingsRevision: 4,
    displayEpoch: 2,
    layoutGeneration: 1,
  });
  assert.equal(reporter.ready(token, []), true);
  assert.deepEqual(harness.reports, [
    ['pending', 3, 1, 4, 2, 1, undefined],
    ['ready', 3, 1, 4, 2, 1, 0],
  ]);
});

test('所有跑馬燈各完成第一次 animationiteration 才回報 complete', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness();
  const reporter = createPageProgressReporter({ report: harness.report });
  const firstTrack = new EventTarget();
  const secondTrack = new EventTarget();
  const token = reporter.begin({
    revision: 8,
    pageNumber: 2,
    settingsRevision: 5,
    displayEpoch: 3,
  });

  assert.equal(reporter.ready(token, [firstTrack, secondTrack]), true);
  await flushPromises();
  firstTrack.dispatchEvent(new Event('animationiteration'));
  firstTrack.dispatchEvent(new Event('animationiteration'));
  assert.deepEqual(harness.reports, [
    ['pending', 8, 2, 5, 3, 1, undefined],
    ['ready', 8, 2, 5, 3, 1, 2],
  ]);

  secondTrack.dispatchEvent(new Event('animationiteration'));
  secondTrack.dispatchEvent(new Event('animationiteration'));
  assert.deepEqual(harness.reports, [
    ['pending', 8, 2, 5, 3, 1, undefined],
    ['ready', 8, 2, 5, 3, 1, 2],
    ['complete', 8, 2, 5, 3, 1, undefined],
  ]);
});

test('ready 尚未被 Main 接受時先完成動畫，會延後 complete 而不造成永久拒絕', async () => {
  const { createPageProgressReporter } = await loadModule();
  let acceptReady;
  const harness = createHarness((phase) => {
    if (phase === 'ready') {
      return new Promise((resolve) => {
        acceptReady = resolve;
      });
    }

    return Promise.resolve(ACCEPTED);
  });
  const reporter = createPageProgressReporter({ report: harness.report });
  const track = new EventTarget();
  const token = reporter.begin({
    revision: 11,
    pageNumber: 1,
    settingsRevision: 6,
    displayEpoch: 4,
  });

  reporter.ready(token, [track]);
  track.dispatchEvent(new Event('animationiteration'));
  await flushPromises();
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready'],
  );

  acceptReady(ACCEPTED);
  await flushPromises();
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'complete'],
  );
});

test('refit 使舊 token 與舊 DOM 事件失效，dispose 後不再回報', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness((phase) => {
    if (phase === 'pending') {
      throw new Error('模擬 IPC 拒絕也不得中斷 Display');
    }

    return Promise.resolve(ACCEPTED);
  });
  const reporter = createPageProgressReporter({ report: harness.report });
  const oldTrack = new EventTarget();
  const oldToken = reporter.begin({
    revision: 1,
    pageNumber: 1,
    settingsRevision: 0,
    displayEpoch: 5,
  });
  reporter.ready(oldToken, [oldTrack]);

  const currentTrack = new EventTarget();
  const currentToken = reporter.begin({
    revision: 1,
    pageNumber: 1,
    settingsRevision: 0,
    displayEpoch: 5,
  });
  assert.equal(currentToken.layoutGeneration, 2);
  assert.equal(reporter.ready(oldToken, [oldTrack]), false);
  assert.equal(reporter.ready(currentToken, [currentTrack]), true);
  await flushPromises();
  oldTrack.dispatchEvent(new Event('animationiteration'));
  assert.equal(
    harness.reports.filter(([phase]) => phase === 'complete').length,
    0,
  );

  currentTrack.dispatchEvent(new Event('animationiteration'));
  assert.equal(
    harness.reports.filter(([phase]) => phase === 'complete').length,
    1,
  );
  reporter.dispose();
  assert.equal(reporter.begin({
    revision: 2,
    pageNumber: 1,
    settingsRevision: 0,
    displayEpoch: 5,
  }), null);
});

test('暫時 IPC 失敗會以可取消退避重試，Main 明確拒絕則停止', async () => {
  const { createPageProgressReporter } = await loadModule();
  const timers = createFakeTimers();
  const responses = [
    () => Promise.reject(new Error('暫時失敗')),
    () => Promise.resolve({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '暫時失敗' },
    }),
    () => Promise.resolve(ACCEPTED),
  ];
  const harness = createHarness(() => responses.shift()());
  const reporter = createPageProgressReporter({
    report: harness.report,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  reporter.begin({
    revision: 9,
    pageNumber: 1,
    settingsRevision: 2,
    displayEpoch: 6,
  });
  await flushPromises();
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 100);

  timers.fireNext();
  await flushPromises();
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 200);

  timers.fireNext();
  await flushPromises();
  assert.equal(timers.active().length, 0);
  assert.equal(harness.reports.length, 3);

  const rejectedTimers = createFakeTimers();
  const rejected = createPageProgressReporter({
    report: () => Promise.resolve({
      ok: true,
      data: { accepted: false },
    }),
    setTimer: rejectedTimers.setTimer,
    clearTimer: rejectedTimers.clearTimer,
  });
  rejected.begin({
    revision: 10,
    pageNumber: 1,
    settingsRevision: 2,
    displayEpoch: 6,
  });
  await flushPromises();
  assert.equal(rejectedTimers.active().length, 0);

  reporter.dispose();
  rejected.dispose();
});

test('同一 WebContents reload 可延續 layoutGeneration 單調值', async () => {
  const { createPageProgressReporter } = await loadModule();
  const savedGenerations = [];
  const reporter = createPageProgressReporter({
    report: () => Promise.resolve(ACCEPTED),
    initialLayoutGeneration: 40,
    onLayoutGeneration: (value) => savedGenerations.push(value),
  });

  const token = reporter.begin({
    revision: 2,
    pageNumber: 1,
    settingsRevision: 3,
    displayEpoch: 7,
  });
  assert.equal(token.layoutGeneration, 41);
  assert.deepEqual(savedGenerations, [41]);
  reporter.dispose();
});
