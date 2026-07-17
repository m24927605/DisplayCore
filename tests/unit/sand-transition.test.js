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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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
  assert.deepEqual(frames[0].erosionPatches, []);
  assert.deepEqual(frames[0].particles, []);
});

test('單一沙漠陣風的可見沙塵峰值隨高度上移，且維持在畫面中間偏右', async () => {
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: 900,
  });

  engine.start({ width: 960, height: 540, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);

  for (let step = 1; step < 100; step += 1) {
    animationFrames.fire(animationFrames.active()[0], 1_000 + step * 10);
  }

  const layers = [
    { name: '下層', includes: ({ sourceY }) => sourceY >= 360 },
    {
      name: '中層',
      includes: ({ sourceY }) => sourceY >= 180 && sourceY < 360,
    },
    { name: '上層', includes: ({ sourceY }) => sourceY < 180 },
  ];
  const peakProgresses = [];

  for (const layer of layers) {
    const peak = frames.reduce((strongest, frame) => {
      const particles = frame.particles.filter((particle) =>
        layer.includes(particle) &&
        particle.x >= 0 && particle.x <= frame.width &&
        particle.y >= 0 && particle.y <= frame.height,
      );
      const visibleMass = particles.reduce(
        (total, particle) =>
          total + particle.opacity * particle.size ** 2,
        0,
      );

      return !strongest || visibleMass > strongest.visibleMass
        ? { frame, particles, visibleMass }
        : strongest;
    }, null);

    assert.ok(peak.visibleMass > 0, `${layer.name}必須有舊圖片顆粒形成的可見沙塵`);

    const horizontalMass = new Array(5).fill(0);
    for (const particle of peak.particles) {
      const bucket = Math.min(
        horizontalMass.length - 1,
        Math.floor(particle.x / peak.frame.width * horizontalMass.length),
      );
      horizontalMass[bucket] += particle.opacity * particle.size ** 2;
    }

    const strongestBucket = horizontalMass.indexOf(Math.max(...horizontalMass));
    assert.equal(
      strongestBucket,
      3,
      `${layer.name}沙塵密度峰值必須位於畫面 60%～80% 的中間偏右區域：` +
        JSON.stringify(horizontalMass),
    );
    peakProgresses.push(peak.frame.progress);
  }

  assert.ok(
    peakProgresses[0] < peakProgresses[1] &&
      peakProgresses[1] < peakProgresses[2],
    `沙塵峰值必須由下往上連續移動：${JSON.stringify(peakProgresses)}`,
  );

  const continuousFrames = frames.filter(
    ({ progress }) => progress >= 0.15 && progress <= 0.75,
  );
  const visibleMasses = continuousFrames.map((frame) =>
    frame.particles.reduce(
      (total, particle) => total + particle.opacity * particle.size ** 2,
      0,
    ),
  );

  for (let index = 2; index < visibleMasses.length - 2; index += 1) {
    const neighboringMass = (
      visibleMasses[index - 2] +
      visibleMasses[index - 1] +
      visibleMasses[index + 1] +
      visibleMasses[index + 2]
    ) / 4;
    assert.ok(
      visibleMasses[index] >= neighboringMass * 0.95,
      `進度 ${continuousFrames[index].progress} 的沙塵不可形成週期性低谷：` +
        JSON.stringify({
          visibleMass: visibleMasses[index],
          neighboringMass,
        }),
    );
  }
});

test('單一侵蝕面連續上移，同一高度不得重新執行左到右掃描', async () => {
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: 900,
  });

  engine.start({ width: 1_000, height: 600, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);

  const firstErosionBySample = new Map();

  for (let step = 1; step <= 850; step += 1) {
    animationFrames.fire(animationFrames.active()[0], 1_000 + step);
    const frame = frames.at(-1);
    for (const patch of frame.erosionPatches) {
      const key = `${patch.x}:${patch.y}`;
      if (!firstErosionBySample.has(key)) {
        firstErosionBySample.set(key, {
          x: patch.x,
          y: patch.y,
          progress: frame.progress,
        });
      }
    }
  }

  const samples = [...firstErosionBySample.values()];
  assert.ok(samples.length >= 800, '必須取得足夠樣本判斷連續侵蝕面');

  const verticalLayers = [
    { name: '下層', includes: ({ y }) => y >= 400 },
    { name: '中層', includes: ({ y }) => y >= 200 && y < 400 },
    { name: '上層', includes: ({ y }) => y < 200 },
  ];
  const horizontalRegions = [
    { name: '左側', includes: ({ x }) => x < 300 },
    { name: '中央', includes: ({ x }) => x >= 350 && x < 650 },
    { name: '右側', includes: ({ x }) => x >= 700 },
  ];
  const layerMedians = [];

  for (const layer of verticalLayers) {
    const medians = horizontalRegions.map((region) => {
      const progressValues = samples
        .filter((sample) => layer.includes(sample) && region.includes(sample))
        .map(({ progress }) => progress);
      assert.ok(progressValues.length >= 50, `${layer.name}${region.name}樣本不足`);
      return median(progressValues);
    });

    assert.ok(
      Math.max(...medians) - Math.min(...medians) <= 0.055,
      `${layer.name}同一高度必須近乎同時受風，不能再次由左掃到右：` +
        JSON.stringify(medians),
    );
    layerMedians.push(median(medians));
  }

  assert.ok(
    layerMedians[0] < layerMedians[1] &&
      layerMedians[1] < layerMedians[2],
    `侵蝕面必須從下方連續上移：${JSON.stringify(layerMedians)}`,
  );

  const samplesByRow = new Map();
  for (const sample of samples) {
    const rowSamples = samplesByRow.get(sample.y) ?? [];
    rowSamples.push(sample);
    samplesByRow.set(sample.y, rowSamples);
  }

  const rowsFromBottom = [...samplesByRow.values()]
    .sort((left, right) => right[0].y - left[0].y);
  assert.ok(rowsFromBottom.length >= 20, '必須有足夠高度取樣檢查連續性');

  for (const [index, row] of rowsFromBottom.entries()) {
    const rowProgresses = row.map(({ progress }) => progress);
    assert.ok(
      Math.max(...rowProgresses) - Math.min(...rowProgresses) <= 0.06,
      `第 ${index + 1} 個高度不可形成水平掃描線：` +
        JSON.stringify({
          earliest: Math.min(...rowProgresses),
          latest: Math.max(...rowProgresses),
        }),
    );
  }

  const coreColumnActivations = rowsFromBottom.map((row) => {
    const coreSample = row.reduce((closest, sample) =>
      Math.abs(sample.x - 680) < Math.abs(closest.x - 680)
        ? sample
        : closest,
    );
    return coreSample.progress;
  });
  const verticalGaps = coreColumnActivations
    .slice(1)
    .map((progress, index) => progress - coreColumnActivations[index]);
  assert.ok(
    verticalGaps.every((gap) => gap > 0),
    `侵蝕核心必須持續向上，不能向下重設：${JSON.stringify(verticalGaps)}`,
  );
  const averageGap = verticalGaps.reduce((total, gap) => total + gap, 0) /
    verticalGaps.length;
  const standardDeviation = Math.sqrt(
    verticalGaps.reduce(
      (total, gap) => total + (gap - averageGap) ** 2,
      0,
    ) / verticalGaps.length,
  );
  assert.ok(
    standardDeviation / averageGap < 0.4,
    `侵蝕面向上移動不可出現固定週期的條帶重啟：${JSON.stringify({
      averageGap,
      coefficientOfVariation: standardDeviation / averageGap,
      verticalGaps,
    })}`,
  );

  const representativeRows = [0.25, 0.5, 0.75].map((position) =>
    rowsFromBottom[Math.floor((rowsFromBottom.length - 1) * position)]
      .sort((left, right) => left.x - right.x),
  );
  for (const [index, row] of representativeRows.entries()) {
    const directions = row.slice(1)
      .map((sample, sampleIndex) =>
        Math.sign(sample.progress - row[sampleIndex].progress),
      )
      .filter((direction) => direction !== 0);
    const directionChanges = directions.slice(1).filter(
      (direction, directionIndex) => direction !== directions[directionIndex],
    ).length;
    assert.ok(
      directionChanges >= 4,
      `第 ${index + 1} 個代表高度的沙丘邊緣必須自然起伏，` +
        `不能是單調直線或階梯：${JSON.stringify({
          directions,
          directionChanges,
        })}`,
    );
  }
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

test('尾端沙粒會逐段漸隱為零，不會只在完成瞬間被清除', async () => {
  const { animationFrames, engine, frames } = await createHarness();

  engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);

  for (const progress of [0.88, 0.94, 0.99, 1]) {
    animationFrames.fire(
      animationFrames.active()[0],
      1_000 + progress * 1_000,
    );
  }

  const visibleMasses = frames.slice(-4).map((frame) =>
    frame.particles.reduce(
      (total, particle) => total + particle.opacity * particle.size ** 2,
      0,
    ),
  );

  assert.ok(visibleMasses[0] > 0, '88% 時必須仍有尾端沙粒');
  assert.ok(
    visibleMasses[1] > 0 && visibleMasses[1] < visibleMasses[0] * 0.5,
    `94% 時沙粒必須明顯淡出：${JSON.stringify(visibleMasses)}`,
  );
  assert.ok(
    visibleMasses[2] > 0 && visibleMasses[2] < visibleMasses[1] * 0.15,
    `99% 時只可留下極淡尾跡：${JSON.stringify(visibleMasses)}`,
  );
  assert.equal(visibleMasses[3], 0, '完成幀必須平順收斂為零');
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
  assert.equal(
    frames.at(-1).erosionPatches.length,
    frames.at(-1).sampleCount,
    '完成時舊圖片的所有取樣區域都必須被吹走',
  );
  assert.deepEqual(
    frames.at(-1).particles,
    [],
    '完成幀的沙粒必須已漸隱，避免 Canvas 清除時突然消失',
  );
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
