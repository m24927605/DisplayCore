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
  assert.deepEqual(frames[0].erosionOrigin, { x: 0, y: 1_080 });
  assert.deepEqual(frames[0].erosionPatches, []);
  assert.deepEqual(frames[0].particles, []);
});

test('侵蝕從左下角向右上擴散，不能退化成垂直直線 wipe', async () => {
  const { animationFrames, engine, frames } = await createHarness();

  engine.start({ width: 1_000, height: 500, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);
  animationFrames.fire(animationFrames.active()[0], 1_200);

  const earlyFrame = frames.at(-1);
  assert.equal(earlyFrame.progress, 0.2);
  assert.deepEqual(earlyFrame.erosionOrigin, { x: 0, y: 500 });
  assert.equal(Object.hasOwn(earlyFrame, 'dissolveFrontX'), false);
  assert.ok(earlyFrame.erosionPatches.length > 0);

  const meanX = earlyFrame.erosionPatches.reduce(
    (total, patch) => total + patch.x,
    0,
  ) / earlyFrame.erosionPatches.length;
  const meanY = earlyFrame.erosionPatches.reduce(
    (total, patch) => total + patch.y,
    0,
  ) / earlyFrame.erosionPatches.length;
  const lowerLeftCount = earlyFrame.erosionPatches.filter(
    ({ x, y }) => x < earlyFrame.width * 0.35 && y > earlyFrame.height * 0.65,
  ).length;
  const upperLeftCount = earlyFrame.erosionPatches.filter(
    ({ x, y }) => x < earlyFrame.width * 0.35 && y < earlyFrame.height * 0.35,
  ).length;

  assert.ok(meanX < earlyFrame.width * 0.35, '初期侵蝕必須集中在左側');
  assert.ok(meanY > earlyFrame.height * 0.65, '初期侵蝕必須集中在下方');
  assert.ok(lowerLeftCount > upperLeftCount * 3, '左下角必須明顯早於左上角');
});

test('舊圖片顆粒由來源位置向右上揚起並逐漸縮小', async () => {
  const { animationFrames, engine, frames } = await createHarness();

  engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);
  animationFrames.fire(animationFrames.active()[0], 1_500);

  const middleFrame = frames.at(-1);
  assert.equal(middleFrame.progress, 0.5);
  assert.ok(middleFrame.particles.length > 0);
  assert.ok(middleFrame.particles.length <= middleFrame.sampleCount);
  assert.ok(middleFrame.particles.some(({ x, sourceX }) => x > sourceX));
  assert.ok(middleFrame.particles.some(({ y, sourceY }) => y < sourceY));

  for (const particle of middleFrame.particles) {
    assert.ok(particle.x >= particle.sourceX, '沙粒不可逆風向左飄移');
    assert.ok(particle.y <= particle.sourceY, '沙粒必須被風向上揚起');
    assert.ok(particle.sourceX >= 0 && particle.sourceX <= middleFrame.width);
    assert.ok(particle.sourceY >= 0 && particle.sourceY <= middleFrame.height);
    assert.ok(particle.sourceSize >= 2, '沙粒必須裁自舊圖片的來源區塊');
    assert.ok(particle.size >= 2, '沙粒必須維持可辨識尺寸');
    assert.ok(particle.size <= particle.sourceSize, '沙粒飄散時只能縮小');
    assert.ok(particle.opacity > 0 && particle.opacity <= 1);
  }

  animationFrames.fire(animationFrames.active()[0], 1_750);
  assert.ok(
    frames.at(-1).erosionPatches.length > middleFrame.erosionPatches.length,
    '侵蝕區必須隨時間向外擴散',
  );
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

  assert.ok(frames[0].sampleCount <= maximum);
  assert.ok(frames[0].sampleCount >= maximum * 0.85);
  assert.equal(frames[1].sampleCount, frames[0].sampleCount);
  assert.ok(frames[1].particles.length <= maximum);
  assert.ok(randomCallCount <= maximum * 5);
});

test('極端寬高比仍不得突破呼叫端指定的粒子上限', async () => {
  let randomCallCount = 0;
  const maximum = 7;
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: maximum,
    random() {
      randomCallCount += 1;
      return 0.5;
    },
  });

  engine.start({ width: 100_000, height: 100, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 0);

  assert.ok(frames[0].sampleCount <= maximum);
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
