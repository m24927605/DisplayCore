'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function createHarness() {
  const { createSandTimeline } = await import('../../display/sand-timeline.mjs');
  const frames = [];
  const pending = [];
  let completed = 0;
  let failed = 0;
  const timeline = createSandTimeline({
    requestFrame(callback) {
      const handle = { callback, canceled: false };
      pending.push(handle);
      return handle;
    },
    cancelFrame(handle) {
      handle.canceled = true;
    },
    onFrame(frame) {
      frames.push(frame);
    },
  });

  return {
    timeline,
    frames,
    pending,
    callbacks: {
      onComplete() {
        completed += 1;
      },
      onError() {
        failed += 1;
      },
    },
    counts() {
      return { completed, failed };
    },
  };
}

test('GPU 風吹砂時間軸只回傳尺寸與單調進度，不建立 CPU 遮罩', async () => {
  const harness = await createHarness();
  assert.equal(harness.timeline.prepare({ width: 1_920, height: 1_080 }), true);
  assert.equal(harness.timeline.start({
    width: 1_920,
    height: 1_080,
    durationMs: 2_000,
    ...harness.callbacks,
  }), true);

  harness.pending.shift().callback(1_000);
  harness.pending.shift().callback(2_000);
  harness.pending.shift().callback(3_000);

  assert.deepEqual(
    harness.frames.map(({ width, height, progress, ...extra }) => ({
      width,
      height,
      progress,
      extra,
    })),
    [
      { width: 1_920, height: 1_080, progress: 0, extra: {} },
      { width: 1_920, height: 1_080, progress: 0.5, extra: {} },
      { width: 1_920, height: 1_080, progress: 1, extra: {} },
    ],
  );
  assert.deepEqual(harness.counts(), { completed: 1, failed: 0 });
  assert.equal(harness.timeline.isRunning(), false);
});

test('取消 GPU 時間軸後，既有 callback 不得再繪製或完成', async () => {
  const harness = await createHarness();
  harness.timeline.start({
    width: 800,
    height: 600,
    durationMs: 1_000,
    ...harness.callbacks,
  });
  const stale = harness.pending.shift();
  assert.equal(harness.timeline.cancel(), true);
  stale.callback(500);

  assert.equal(stale.canceled, true);
  assert.deepEqual(harness.frames, []);
  assert.deepEqual(harness.counts(), { completed: 0, failed: 0 });
});

test('GPU 時間軸拒絕無效幾何與時間', async () => {
  const harness = await createHarness();
  assert.throws(
    () => harness.timeline.prepare({ width: 0, height: 600 }),
    RangeError,
  );
  assert.throws(
    () => harness.timeline.start({
      width: 800,
      height: 600,
      durationMs: 0,
    }),
    RangeError,
  );
});
