'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PresentationService } = require('../../ipc/presentation-service');
const { PresentationStore } = require('../../ipc/presentation-store');

function createProgram(messageCount, repeat = { mode: 'finite', rounds: 2 }) {
  return {
    messages: Array.from({ length: messageCount }, (_value, index) => ({
      message: `訊息${index + 1}`,
    })),
    pageDurationSeconds: 3,
    repeat,
  };
}

function createFakeTimers() {
  const scheduled = [];

  return {
    scheduled,
    setTimer(callback, delay) {
      const handle = { callback, delay, cleared: false, unrefCalled: false };
      handle.unref = () => {
        handle.unrefCalled = true;
      };
      scheduled.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    fire(handle) {
      handle.cleared = true;
      handle.callback();
    },
    active() {
      return scheduled.filter((handle) => !handle.cleared);
    },
  };
}

function createProgress(service, phase, overrides = {}) {
  const snapshot = service.getSnapshot();
  const progress = {
    rendererId: 101,
    phase,
    displayEpoch: service.getDisplayEpoch(),
    revision: snapshot.revision,
    pageNumber: snapshot.pageNumber,
    settingsRevision: 0,
    layoutGeneration: 1,
    ...overrides,
  };

  if (phase === 'ready' && !Object.hasOwn(progress, 'marqueeCount')) {
    progress.marqueeCount = 0;
  }

  return progress;
}

test('ready 只授權目前 layout，started 才冪等啟動最短停留 timer', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const snapshots = [];
  service.subscribe((snapshot) => snapshots.push(snapshot));

  service.startProgram(createProgram(6, { mode: 'finite', rounds: 1 }));
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'pending')),
    true,
  );
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready')),
    true,
  );
  assert.equal(timers.active().length, 0, 'ready 回覆遺失不得使頁面提早前進');
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready')),
    true,
  );
  assert.equal(timers.active().length, 0, 'duplicate ready 仍不得計時');
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    true,
  );
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 3_000);
  assert.equal(timers.active()[0].unrefCalled, true);

  const firstTimer = timers.active()[0];
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    true,
  );
  assert.equal(timers.active()[0], firstTimer, 'duplicate started 不得重新計時');

  timers.fire(firstTimer);
  assert.equal(service.getSnapshot().pageNumber, 1);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete')),
    true,
  );
  assert.equal(service.getSnapshot().pageNumber, 2);
  assert.equal(timers.active().length, 0);

  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready', {
      layoutGeneration: 2,
    })),
    true,
  );
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started', {
      layoutGeneration: 2,
    })),
    true,
  );
  assert.equal(timers.active().length, 1);
  timers.fire(timers.active()[0]);
  assert.equal(service.getSnapshot().mode, 'page');
  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete', {
      layoutGeneration: 2,
    })),
    true,
  );
  assert.equal(service.getSnapshot().mode, 'blank');
  assert.equal(timers.active().length, 0);
  assert.deepEqual(
    snapshots.map(({ mode, pageNumber, revision }) => ({
      mode,
      pageNumber,
      revision,
    })),
    [
      { mode: 'page', pageNumber: 1, revision: 1 },
      { mode: 'page', pageNumber: 2, revision: 2 },
      { mode: 'blank', pageNumber: null, revision: 3 },
    ],
  );
});

test('沒有跑馬燈的頁面也必須同時等期限與 Renderer 終幀 complete', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  service.startProgram(createProgram(6, { mode: 'finite', rounds: 1 }));
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready')),
    true,
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    true,
  );
  timers.fire(timers.active()[0]);
  assert.equal(service.getSnapshot().pageNumber, 1);
  assert.equal(service.getSnapshot().revision, 1);

  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete')),
    true,
  );
  assert.equal(service.getSnapshot().pageNumber, 2);
  assert.equal(service.getSnapshot().revision, 2);
});

test('跑馬燈頁只有最短時間與所有 traversal 都完成後才前進', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  service.startProgram(createProgram(6, { mode: 'finite', rounds: 1 }));
  const firstLayout = createProgress(service, 'ready', { marqueeCount: 2 });
  assert.equal(service.reportPageProgress(firstLayout), true);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    true,
  );
  timers.fire(timers.active()[0]);
  assert.equal(service.getSnapshot().revision, 1);
  assert.equal(service.getSnapshot().pageNumber, 1);

  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete')),
    true,
  );
  assert.equal(service.getSnapshot().revision, 2);
  assert.equal(service.getSnapshot().pageNumber, 2);

  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready', {
      layoutGeneration: 2,
      marqueeCount: 1,
    })),
    true,
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete', {
      layoutGeneration: 2,
    })),
    true,
  );
  assert.equal(service.getSnapshot().mode, 'page');
  assert.equal(service.getSnapshot().revision, 2);
  assert.equal(timers.active().length, 0, 'complete 先到仍須等待 started');
  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete', {
      layoutGeneration: 2,
    })),
    true,
    'duplicate complete 必須冪等',
  );

  assert.equal(
    service.reportPageProgress(createProgress(service, 'started', {
      layoutGeneration: 2,
    })),
    true,
  );
  timers.fire(timers.active()[0]);
  assert.equal(service.getSnapshot().mode, 'blank');
  assert.equal(service.getSnapshot().revision, 3);
});

test('新 layout、手動失效與狀態替換使舊 timer 及舊事件失效', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  service.startProgram(createProgram(6));
  service.reportPageProgress(createProgress(service, 'ready'));
  service.reportPageProgress(createProgress(service, 'started'));
  const staleAfterRefit = timers.active()[0];
  assert.equal(
    service.reportPageProgress(createProgress(service, 'pending', {
      layoutGeneration: 2,
    })),
    true,
  );
  assert.equal(staleAfterRefit.cleared, true);
  assert.equal(timers.active().length, 0);
  timers.fire(staleAfterRefit);
  assert.equal(service.getSnapshot().revision, 1);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete')),
    false,
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'pending', {
      layoutGeneration: 2,
    })),
    true,
    'duplicate pending 必須冪等',
  );

  service.reportPageProgress(createProgress(service, 'ready', {
    layoutGeneration: 2,
    marqueeCount: 1,
  }));
  service.reportPageProgress(createProgress(service, 'started', {
    layoutGeneration: 2,
  }));
  const staleAfterInvalidation = timers.active()[0];
  const delayedReady = createProgress(service, 'ready', {
    layoutGeneration: 2,
    marqueeCount: 1,
  });
  assert.equal(service.invalidateCurrentPageLayout(), true);
  assert.equal(staleAfterInvalidation.cleared, true);
  assert.equal(
    service.reportPageProgress(delayedReady),
    false,
    '已失效 layout 的在途 ready 不得重新建立 timer',
  );
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'complete', {
      layoutGeneration: 2,
    })),
    false,
  );

  service.reportPageProgress(createProgress(service, 'ready', {
    rendererId: 202,
    layoutGeneration: 1,
  }));
  service.reportPageProgress(createProgress(service, 'started', {
    rendererId: 202,
    layoutGeneration: 1,
  }));
  const staleAfterEmergency = timers.active()[0];
  service.showEmergency('555');
  timers.fire(staleAfterEmergency);
  assert.equal(service.getSnapshot().mode, 'emergency');

  service.startProgram(createProgram(6));
  service.reportPageProgress(createProgress(service, 'ready'));
  service.reportPageProgress(createProgress(service, 'started'));
  const staleAfterClear = timers.active()[0];
  service.clearPresentation();
  timers.fire(staleAfterClear);
  assert.equal(service.getSnapshot().mode, 'blank');

  service.startProgram(createProgram(6));
  service.reportPageProgress(createProgress(service, 'ready'));
  service.reportPageProgress(createProgress(service, 'started'));
  const staleAfterReplacement = timers.active()[0];
  service.startProgram(createProgram(1, { mode: 'continuous' }));
  timers.fire(staleAfterReplacement);
  assert.equal(service.getSnapshot().messages[0].message, '訊息1');
});

test('錯誤頁面進度、單頁持續模式與 dispose 一律 fail closed', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  let published = 0;
  service.subscribe(() => {
    published += 1;
  });

  service.startProgram(createProgram(1, { mode: 'continuous' }));
  const current = createProgress(service, 'ready');
  assert.equal(service.reportPageProgress(current), true);
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress({ ...current, revision: current.revision + 1 }),
    false,
  );
  assert.equal(
    service.reportPageProgress({ ...current, pageNumber: 2 }),
    false,
  );
  assert.equal(
    service.reportPageProgress({ ...current, rendererId: -1 }),
    false,
  );
  assert.equal(published, 1, '進度回報不得發布 presentation snapshot');

  service.startProgram(createProgram(6));
  service.reportPageProgress(createProgress(service, 'ready'));
  service.reportPageProgress(createProgress(service, 'started'));
  const activeTimer = timers.active()[0];
  service.dispose();
  assert.equal(activeTimer.cleared, true);
  assert.equal(service.startProgram(createProgram(1)), false);
  assert.equal(service.invalidateCurrentPageLayout(), false);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready')),
    false,
  );
  assert.equal(published, 2);
});

test('設定 revision 與 Display 可見性都必須符合才接受 ready／started', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    displayAvailable: false,
  });

  service.startProgram(createProgram(6));
  const hiddenReady = createProgress(service, 'ready');
  assert.equal(service.reportPageProgress(hiddenReady), false);
  assert.equal(timers.active().length, 0);

  assert.equal(service.setDisplayAvailable(true), true);
  assert.equal(timers.active().length, 0, '顯示後仍須等待全新 refit');
  assert.equal(
    service.reportPageProgress(hiddenReady),
    false,
    '顯示前產生但顯示後才抵達的 ready 不得建立 timer',
  );
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready', {
      layoutGeneration: 2,
    })),
    true,
  );
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started', {
      layoutGeneration: 2,
    })),
    true,
  );
  const visibleTimer = timers.active()[0];
  assert.ok(visibleTimer);

  assert.equal(service.updateSettingsRevision(1), true);
  assert.equal(visibleTimer.cleared, true);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready', {
      layoutGeneration: 2,
    })),
    false,
    '舊設定的在途 ready 不得復活 gate',
  );
  assert.equal(timers.active().length, 0);

  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready', {
      settingsRevision: 1,
      layoutGeneration: 3,
    })),
    true,
  );
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started', {
      settingsRevision: 1,
      layoutGeneration: 3,
    })),
    true,
  );
  assert.equal(timers.active().length, 1);
  assert.equal(service.updateSettingsRevision(0), false);

  const delayedVisibleReady = createProgress(service, 'ready', {
    settingsRevision: 1,
    layoutGeneration: 4,
  });
  assert.equal(service.setDisplayAvailable(false), true);
  assert.equal(timers.active().length, 0);
  assert.equal(
    service.reportPageProgress(delayedVisibleReady),
    false,
  );
  assert.equal(service.setDisplayAvailable(true), true);
  assert.equal(service.getDisplayEpoch(), 2);
  assert.equal(
    service.reportPageProgress(delayedVisibleReady),
    false,
    '上一次可見世代的在途 ready 不得在重新顯示後建立 timer',
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready', {
      settingsRevision: 1,
      layoutGeneration: 5,
    })),
    true,
  );
});

test('stale、refit 與未 ready 的 started 一律 fail closed 且不得取代合法 gate', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  service.startProgram(createProgram(6));
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    false,
    'started 不得自行建立 gate',
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'pending')),
    true,
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    false,
    'pending 後仍必須先 ready',
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'ready')),
    true,
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started', {
      layoutGeneration: 2,
    })),
    false,
    '其他 layout 的 started 不得取代目前合法 gate',
  );
  assert.equal(
    service.reportPageProgress(createProgress(service, 'started')),
    true,
  );
  assert.equal(timers.active().length, 1);

  const staleStarted = createProgress(service, 'started');
  assert.equal(service.invalidateCurrentPageLayout(), true);
  assert.equal(timers.active().length, 0);
  assert.equal(service.reportPageProgress(staleStarted), false);
  assert.equal(
    service.reportPageProgress({ ...staleStarted, unexpected: true }),
    false,
  );
  assert.equal(
    service.reportPageProgress({
      ...staleStarted,
      revision: staleStarted.revision + 1,
    }),
    false,
  );
});
