'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/sand-transition.mjs');
}

function createFakeAnimationFrames() {
  const handles = [];

  return {
    handles,
    requestFrame(callback) {
      const handle = { callback, canceled: false, fired: false };
      handles.push(handle);
      return handle;
    },
    cancelFrame(handle) {
      handle.canceled = true;
    },
    fire(handle, timestamp) {
      handle.fired = true;
      handle.callback(timestamp);
    },
    active() {
      return handles.filter(({ canceled, fired }) => !canceled && !fired);
    },
  };
}

async function createHarness(options = {}) {
  const { createSandTransition } = await loadModule();
  const animationFrames = createFakeAnimationFrames();
  const frames = [];
  const engine = createSandTransition({
    requestFrame: animationFrames.requestFrame,
    cancelFrame: animationFrames.cancelFrame,
    onFrame: (frame) => frames.push(frame),
    random: () => 0.5,
    maxParticleCount: 120,
    ...options,
  });

  return { animationFrames, engine, frames };
}

test('建立引擎不會自行播放，start 後第一幀仍為未溶解狀態', async () => {
  const { animationFrames, engine, frames } = await createHarness();

  assert.equal(engine.isRunning(), false);
  assert.equal(animationFrames.active().length, 0);
  assert.equal(frames.length, 0);

  assert.equal(engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 }), true);
  assert.equal(engine.isRunning(), true);
  assert.equal(frames.length, 0);
  assert.equal(animationFrames.active().length, 1);

  animationFrames.fire(animationFrames.active()[0], 2_000);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].progress, 0);
  assert.equal(frames[0].dissolveFrontX, 0);
  assert.deepEqual(frames[0].particles, []);
});

test('溶解邊界由左向右前進，舊圖片顆粒只向右漂移且保持清楚尺寸', async () => {
  const { animationFrames, engine, frames } = await createHarness();

  engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);
  animationFrames.fire(animationFrames.active()[0], 1_500);

  const middleFrame = frames.at(-1);
  assert.equal(middleFrame.progress, 0.5);
  assert.equal(middleFrame.dissolveFrontX, 960);
  assert.equal(middleFrame.sampleCount, 120);
  assert.ok(middleFrame.particles.length > 0);
  assert.ok(middleFrame.particles.length <= middleFrame.sampleCount);
  assert.ok(middleFrame.particles.some(({ x, sourceX }) => x > sourceX));

  for (const particle of middleFrame.particles) {
    assert.ok(particle.x >= particle.sourceX, '沙粒不可逆風向左飄移');
    assert.ok(particle.sourceX >= 0 && particle.sourceX <= middleFrame.width);
    assert.ok(particle.sourceY >= 0 && particle.sourceY <= middleFrame.height);
    assert.ok(particle.size >= 2, '沙粒必須維持可辨識尺寸');
    assert.ok(particle.opacity > 0 && particle.opacity <= 1);
  }

  animationFrames.fire(animationFrames.active()[0], 1_750);
  assert.ok(frames.at(-1).dissolveFrontX > middleFrame.dissolveFrontX);
});

test('4K 畫面採固定且有界的取樣數，不依總像素逐點處理', async () => {
  let randomCallCount = 0;
  const maximum = 777;
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: maximum,
    random() {
      randomCallCount += 1;
      return 0.5;
    },
  });

  engine.start({ width: 3_840, height: 2_160, durationMs: 1_200 });
  animationFrames.fire(animationFrames.active()[0], 0);
  animationFrames.fire(animationFrames.active()[0], 600);

  assert.equal(frames[0].sampleCount, maximum);
  assert.equal(frames[1].sampleCount, maximum);
  assert.ok(frames[1].particles.length <= maximum);
  assert.ok(randomCallCount <= maximum * 5);
});

test('完成回呼只執行一次，完成後不再排程畫面', async () => {
  const completions = [];
  const { animationFrames, engine, frames } = await createHarness();

  engine.start({
    width: 1_600,
    height: 900,
    durationMs: 500,
    onComplete: () => completions.push('done'),
  });
  animationFrames.fire(animationFrames.active()[0], 100);
  const finalHandle = animationFrames.active()[0];
  animationFrames.fire(finalHandle, 600);

  assert.equal(frames.at(-1).progress, 1);
  assert.deepEqual(completions, ['done']);
  assert.equal(engine.isRunning(), false);
  assert.equal(animationFrames.active().length, 0);

  animationFrames.fire(finalHandle, 900);
  assert.deepEqual(completions, ['done']);
});

test('cancel、重新 start 與 dispose 會讓已排程的 stale callback 失效', async () => {
  const completions = [];
  const { animationFrames, engine, frames } = await createHarness();

  engine.start({
    width: 1_366,
    height: 768,
    durationMs: 1_000,
    onComplete: () => completions.push('first'),
  });
  const canceledHandle = animationFrames.active()[0];
  assert.equal(engine.cancel(), true);
  assert.equal(canceledHandle.canceled, true);
  assert.equal(engine.cancel(), false);
  animationFrames.fire(canceledHandle, 10_000);
  assert.equal(frames.length, 0);
  assert.deepEqual(completions, []);

  engine.start({
    width: 2_560,
    height: 1_440,
    durationMs: 1_000,
    onComplete: () => completions.push('second'),
  });
  const staleRestartHandle = animationFrames.active()[0];
  engine.start({
    width: 3_840,
    height: 2_160,
    durationMs: 1_000,
    onComplete: () => completions.push('third'),
  });
  animationFrames.fire(staleRestartHandle, 1_000);
  assert.equal(frames.length, 0);

  const disposedHandle = animationFrames.active()[0];
  engine.dispose();
  assert.equal(disposedHandle.canceled, true);
  assert.equal(engine.isRunning(), false);
  animationFrames.fire(disposedHandle, 2_000);
  assert.equal(frames.length, 0);
  assert.deepEqual(completions, []);
  assert.equal(
    engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 }),
    false,
  );
});

test('拒絕無效尺寸、時間與相依函式', async () => {
  const { createSandTransition } = await loadModule();
  const animationFrames = createFakeAnimationFrames();

  assert.throws(
    () => createSandTransition({
      requestFrame: animationFrames.requestFrame,
      cancelFrame: animationFrames.cancelFrame,
      onFrame: null,
    }),
    /缺少必要相依函式/,
  );

  const { engine } = await createHarness();
  assert.throws(
    () => engine.start({ width: 0, height: 1_080, durationMs: 1_000 }),
    /寬高必須是正數/,
  );
  assert.throws(
    () => engine.start({ width: 1_920, height: 1_080, durationMs: 0 }),
    /時間必須是正數/,
  );
  assert.throws(
    () => engine.start({
      width: 1_920,
      height: 1_080,
      durationMs: 1_000,
      onComplete: 'done',
    }),
    /完成回呼必須是函式/,
  );
});
