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

test('PresentationService 每次只串接一個 page timer 並發布完整狀態序列', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const snapshots = [];
  service.subscribe((snapshot) => snapshots.push(snapshot));

  service.startProgram(createProgram(6, { mode: 'finite', rounds: 1 }));
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delay, 3_000);
  assert.equal(timers.active()[0].unrefCalled, true);

  timers.fire(timers.active()[0]);
  assert.equal(service.getSnapshot().pageNumber, 2);
  assert.equal(timers.active().length, 1);

  timers.fire(timers.active()[0]);
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

test('舊 timer 即使已進入 callback queue，也不能覆蓋 emergency、clear 或新 program', () => {
  const timers = createFakeTimers();
  const service = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  service.startProgram(createProgram(6));
  const staleAfterEmergency = timers.active()[0];
  service.showEmergency('555');
  const emergencyRevision = service.getSnapshot().revision;
  timers.fire(staleAfterEmergency);
  assert.equal(service.getSnapshot().mode, 'emergency');
  assert.equal(service.getSnapshot().revision, emergencyRevision);

  service.startProgram(createProgram(6));
  const staleAfterClear = timers.active()[0];
  service.clearPresentation();
  const clearRevision = service.getSnapshot().revision;
  timers.fire(staleAfterClear);
  assert.equal(service.getSnapshot().mode, 'blank');
  assert.equal(service.getSnapshot().revision, clearRevision);

  service.startProgram(createProgram(6));
  const staleAfterReplacement = timers.active()[0];
  service.startProgram(createProgram(1, { mode: 'continuous' }));
  const replacementRevision = service.getSnapshot().revision;
  timers.fire(staleAfterReplacement);
  assert.equal(service.getSnapshot().messages[0].message, '訊息1');
  assert.equal(service.getSnapshot().revision, replacementRevision);
});

test('單頁持續模式不排 timer；dispose 取消 timer、listener 與後續操作', () => {
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
  assert.equal(timers.active().length, 0);
  assert.equal(published, 1);

  service.startProgram(createProgram(6));
  const activeTimer = timers.active()[0];
  service.dispose();
  assert.equal(activeTimer.cleared, true);
  assert.equal(service.startProgram(createProgram(1)), false);
  assert.equal(published, 2);
});
