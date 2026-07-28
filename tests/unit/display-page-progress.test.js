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

test('pending 與 started 都必須由 Main 接受後才推進本機版面生命週期', async () => {
  const lifecycle = [];
  const harness = createHarness();
  const reporter = createPageProgressReporterForLifecycleTest();

  function createPageProgressReporterForLifecycleTest() {
    return loadModule().then(({ createPageProgressReporter }) =>
      createPageProgressReporter({
        report: harness.report,
        onPendingAccepted: (token) => {
          lifecycle.push(`pending:${token.layoutGeneration}`);
        },
        onStartedAccepted: (token) => {
          lifecycle.push(`started:${token.layoutGeneration}`);
        },
      }));
  }

  const instance = await reporter;
  const token = instance.begin({
    revision: 2,
    pageNumber: 1,
    settingsRevision: 3,
    displayEpoch: 1,
  });
  await flushPromises();
  assert.deepEqual(lifecycle, ['pending:1']);

  instance.ready(token, []);
  await flushPromises();
  await flushPromises();

  assert.deepEqual(lifecycle, ['pending:1', 'started:1']);
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started', 'complete'],
    '沒有跑馬燈與酒液時也要明確 complete，Main 才能在期限後換頁',
  );
  instance.dispose();
});

test('有酒液的頁面必須等 100% 終幀通知後才回報 complete', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness();
  const reporter = createPageProgressReporter({
    report: harness.report,
  });
  const token = reporter.begin({
    revision: 4,
    pageNumber: 1,
    settingsRevision: 3,
    displayEpoch: 1,
  });
  await flushPromises();

  reporter.ready(token, [], { liquidCompletionRequired: true });
  await flushPromises();
  await flushPromises();
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started'],
  );

  assert.equal(reporter.liquidComplete(token), true);
  await flushPromises();
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started', 'complete'],
  );
  assert.equal(reporter.liquidComplete(token), true, '終幀通知必須冪等');
  reporter.dispose();
});

test('跑馬燈先跑完也不得讓酒液在顯示期限前提早 complete', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness();
  const reporter = createPageProgressReporter({ report: harness.report });
  const track = new EventTarget();
  const token = reporter.begin({
    revision: 5,
    pageNumber: 1,
    settingsRevision: 3,
    displayEpoch: 1,
  });

  reporter.ready(token, [track], { liquidCompletionRequired: true });
  await flushPromises();
  track.dispatchEvent(new Event('animationiteration'));
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started'],
    '跑馬燈完成只滿足 traversal，不得旁路酒液期限',
  );

  reporter.liquidComplete(token);
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started', 'complete'],
  );
  reporter.dispose();
});

test('靜態 layout 在 started 被接受後啟動效果並明確回報 complete', async () => {
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
  await flushPromises();
  assert.deepEqual(harness.reports, [
    ['pending', 3, 1, 4, 2, 1, undefined],
    ['ready', 3, 1, 4, 2, 1, 0],
    ['started', 3, 1, 4, 2, 1, undefined],
    ['complete', 3, 1, 4, 2, 1, undefined],
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
    ['started', 8, 2, 5, 3, 1, undefined],
  ]);

  secondTrack.dispatchEvent(new Event('animationiteration'));
  secondTrack.dispatchEvent(new Event('animationiteration'));
  assert.deepEqual(harness.reports, [
    ['pending', 8, 2, 5, 3, 1, undefined],
    ['ready', 8, 2, 5, 3, 1, 2],
    ['started', 8, 2, 5, 3, 1, undefined],
    ['complete', 8, 2, 5, 3, 1, undefined],
  ]);
});

test('頁面效果全部完成時只回報一次 complete', async () => {
  const { createPageProgressReporter } = await loadModule();
  const events = [];
  const reporter = createPageProgressReporter({
    report: (phase) => {
      events.push(`report:${phase}`);
      return Promise.resolve(ACCEPTED);
    },
    onTraversalComplete: (token) => {
      events.push(`finish:${token.layoutGeneration}`);
    },
  });
  const track = new EventTarget();
  const token = reporter.begin({
    revision: 18,
    pageNumber: 1,
    settingsRevision: 7,
    displayEpoch: 5,
  });

  reporter.ready(token, [track]);
  await flushPromises();
  track.dispatchEvent(new Event('animationiteration'));

  assert.deepEqual(events, [
    'report:pending',
    'report:ready',
    'report:started',
    'finish:1',
    'report:complete',
  ]);
  track.dispatchEvent(new Event('animationiteration'));
  assert.equal(
    events.filter((event) => event.startsWith('finish:')).length,
    1,
    'duplicate iteration 不得重跑終幀 callback',
  );
  reporter.dispose();
});

test('終幀 callback 故障不得讓可讀 fallback 永久卡在目前頁', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness();
  const reporter = createPageProgressReporter({
    report: harness.report,
    onTraversalComplete: () => {
      throw new Error('synthetic final-frame failure');
    },
  });
  const track = new EventTarget();
  const token = reporter.begin({
    revision: 19,
    pageNumber: 1,
    settingsRevision: 7,
    displayEpoch: 5,
  });

  reporter.ready(token, [track]);
  await flushPromises();
  track.dispatchEvent(new Event('animationiteration'));
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started', 'complete'],
  );
  reporter.dispose();
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
    ['pending', 'ready', 'started', 'complete'],
  );
});

test('只有 Main 接受目前 started 後才啟動效果，且每個 token 只通知一次', async () => {
  const { createPageProgressReporter } = await loadModule();
  let acceptReady;
  const acceptedTokens = [];
  let phasesSeenWhileStartingEffects = null;
  const harness = createHarness((phase) => {
    if (phase === 'ready') {
      return new Promise((resolve) => {
        acceptReady = resolve;
      });
    }
    return Promise.resolve(ACCEPTED);
  });
  const reporter = createPageProgressReporter({
    report: harness.report,
    onStartedAccepted: (token) => {
      acceptedTokens.push(token);
      phasesSeenWhileStartingEffects = harness.reports.map(([phase]) => phase);
    },
  });
  const token = reporter.begin({
    revision: 12,
    pageNumber: 2,
    settingsRevision: 6,
    displayEpoch: 4,
  });

  reporter.ready(token, []);
  await flushPromises();
  assert.deepEqual(acceptedTokens, [], 'IPC 尚未接受時不得偷跑顏色倒數');

  acceptReady(ACCEPTED);
  await flushPromises();
  assert.deepEqual(acceptedTokens, [token]);
  assert.deepEqual(
    phasesSeenWhileStartingEffects,
    ['pending', 'ready', 'started'],
    'Main 建立最短停留 timer 後，Renderer 才可同步啟動效果',
  );
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started', 'complete'],
  );
  reporter.ready(token, []);
  await flushPromises();
  assert.deepEqual(acceptedTokens, [token], '重送 ready 不得重啟倒數');
  assert.equal(
    harness.reports.filter(([phase]) => phase === 'started').length,
    1,
    '重送 ready 不得重送 started',
  );

  reporter.dispose();
});

test('ready 回覆遺失時不得先啟動效果或回報 started', async () => {
  const { createPageProgressReporter } = await loadModule();
  const timers = createFakeTimers();
  let readyAttempts = 0;
  const acceptedTokens = [];
  const harness = createHarness((phase) => {
    if (phase === 'ready' && readyAttempts++ === 0) {
      return Promise.reject(new Error('Main 已收或未收皆不可推測'));
    }
    return Promise.resolve(ACCEPTED);
  });
  const reporter = createPageProgressReporter({
    report: harness.report,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onStartedAccepted: (token) => acceptedTokens.push(token),
  });
  const token = reporter.begin({
    revision: 15,
    pageNumber: 1,
    settingsRevision: 6,
    displayEpoch: 4,
  });

  reporter.ready(token, []);
  await flushPromises();
  assert.deepEqual(acceptedTokens, []);
  assert.equal(
    harness.reports.some(([phase]) => phase === 'started'),
    false,
  );
  assert.equal(timers.active().length, 1);

  timers.fireNext();
  await flushPromises();
  assert.deepEqual(acceptedTokens, [token]);
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'ready', 'started', 'complete'],
  );
  reporter.dispose();
});

test('started 回覆遺失只重送 started，接受前不得偷跑效果', async () => {
  const { createPageProgressReporter } = await loadModule();
  const timers = createFakeTimers();
  let startedAttempts = 0;
  const acceptedTokens = [];
  const harness = createHarness((phase) => {
    if (phase === 'started' && startedAttempts++ === 0) {
      return Promise.reject(new Error('started 回覆遺失'));
    }
    return Promise.resolve(ACCEPTED);
  });
  const reporter = createPageProgressReporter({
    report: harness.report,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onStartedAccepted: (token) => acceptedTokens.push(token),
  });
  const token = reporter.begin({
    revision: 16,
    pageNumber: 1,
    settingsRevision: 6,
    displayEpoch: 4,
  });

  reporter.ready(token, []);
  await flushPromises();
  assert.deepEqual(acceptedTokens, []);
  assert.equal(timers.active().length, 1);

  timers.fireNext();
  await flushPromises();
  assert.deepEqual(acceptedTokens, [token], 'started retry 不得重播效果');
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started', 'started', 'complete'],
  );
  reporter.dispose();
});

test('started callback 判定 token stale 時 fail closed，不得回報 complete', async () => {
  const { createPageProgressReporter } = await loadModule();
  const harness = createHarness();
  const reporter = createPageProgressReporter({
    report: harness.report,
    onStartedAccepted: () => false,
  });
  const track = new EventTarget();
  const token = reporter.begin({
    revision: 17,
    pageNumber: 1,
    settingsRevision: 6,
    displayEpoch: 4,
  });

  reporter.ready(token, [track]);
  track.dispatchEvent(new Event('animationiteration'));
  await flushPromises();
  assert.deepEqual(
    harness.reports.map(([phase]) => phase),
    ['pending', 'ready', 'started'],
  );
  reporter.dispose();
});

test('被拒絕、已取消或已 dispose 的 ready 不得啟動頁面效果', async () => {
  const { createPageProgressReporter } = await loadModule();
  const acceptedTokens = [];
  const rejected = createPageProgressReporter({
    report: () => Promise.resolve({ ok: true, data: { accepted: false } }),
    onStartedAccepted: (token) => acceptedTokens.push(token),
  });
  const rejectedToken = rejected.begin({
    revision: 13,
    pageNumber: 1,
    settingsRevision: 6,
    displayEpoch: 4,
  });
  rejected.ready(rejectedToken, []);
  await flushPromises();
  assert.deepEqual(acceptedTokens, []);
  rejected.dispose();

  let resolveReady;
  const cancelled = createPageProgressReporter({
    report: (phase) => phase === 'ready'
      ? new Promise((resolve) => {
        resolveReady = resolve;
      })
      : Promise.resolve(ACCEPTED),
    onStartedAccepted: (token) => acceptedTokens.push(token),
  });
  const cancelledToken = cancelled.begin({
    revision: 14,
    pageNumber: 1,
    settingsRevision: 6,
    displayEpoch: 4,
  });
  cancelled.ready(cancelledToken, []);
  cancelled.cancel();
  resolveReady(ACCEPTED);
  await flushPromises();
  assert.deepEqual(acceptedTokens, []);
  cancelled.dispose();
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
