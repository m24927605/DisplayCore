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

test('連續低頻風團必須平滑有界，且全程不得斷風', async () => {
  const { calculateSandGustStrength } = await loadModule();
  const samples = Array.from(
    { length: 101 },
    (_, index) => calculateSandGustStrength(index / 100, 0.37),
  );
  const neighboringChanges = samples.slice(1).map(
    (value, index) => Math.abs(value - samples[index]),
  );

  assert.ok(Math.min(...samples) >= 0.88, '風團低谷不得掉到斷風');
  assert.ok(Math.max(...samples) <= 1.12, '風團峰值不得突然爆衝');
  assert.ok(
    Math.max(...samples) - Math.min(...samples) >= 0.14,
    '風團必須有肉眼可感的強弱層次',
  );
  assert.ok(
    Math.max(...neighboringChanges) <= 0.04,
    '相鄰 1% 時間步進不可跳動，避免風帶斷斷續續',
  );
});

test('沙粒末段必須錯開消散，但完成幀全部歸零', async () => {
  const { calculateSandParticleFinalFade } = await loadModule();
  const fadeStarts = [0.87, 0.9, 0.93];
  const atNinetyOne = fadeStarts.map(
    (fadeStart) => calculateSandParticleFinalFade(0.91, fadeStart),
  );

  assert.ok(
    new Set(atNinetyOne.map((value) => value.toFixed(4))).size >= 2,
    '同一時刻不同沙粒不可整批使用同一透明度',
  );
  for (const fadeStart of fadeStarts) {
    const values = [0.88, 0.92, 0.96, 0.99, 1].map(
      (progress) => calculateSandParticleFinalFade(progress, fadeStart),
    );
    assert.ok(
      values.slice(1).every((value, index) => value <= values[index]),
      '每顆沙粒進入末段後只能持續淡出',
    );
    assert.equal(values.at(-1), 0, '完成幀不可殘留沙粒');
  }
});

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
  assert.equal(frames[0].erosionMask.erasedPixelCount, 0);
  assert.ok(
    frames[0].erosionMask.pixels.every((value, index) =>
      index % 4 !== 3 || value === 0,
    ),
  );
  assert.deepEqual(frames[0].particles, []);
});

test('停留期間可預先建立下一輪幾何，start 不得再次同步重算', async () => {
  let randomCallCount = 0;
  const { animationFrames, engine } = await createHarness({
    random() {
      randomCallCount += 1;
      return 0.5;
    },
  });

  assert.equal(engine.prepare({ width: 1_920, height: 1_080 }), true);
  const callsAfterPrepare = randomCallCount;
  assert.ok(callsAfterPrepare > 1, 'prepare 必須真正建立種子與沙粒資料');

  assert.equal(
    engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 }),
    true,
  );
  assert.equal(
    randomCallCount,
    callsAfterPrepare,
    '同尺寸 start 必須消耗預先資料，不可在轉場起點重新建立幾何',
  );
  assert.equal(animationFrames.active().length, 1);
});

test('離開待機可丟棄未使用的預備幾何，避免固定畫面長期保留記憶體', async () => {
  let randomCallCount = 0;
  const { engine } = await createHarness({
    random() {
      randomCallCount += 1;
      return 0.5;
    },
  });

  engine.prepare({ width: 1_920, height: 1_080 });
  const callsAfterPrepare = randomCallCount;
  assert.equal(engine.discardPrepared(), true);
  assert.equal(engine.discardPrepared(), false);
  engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 });
  assert.ok(
    randomCallCount > callsAfterPrepare,
    '丟棄後 start 必須建立新幾何，證明舊 typed arrays 已不再被 cache 持有',
  );
});

test('Renderer 單幀繪製失敗時停止該輪並呼叫失敗回呼，不能永久卡住輪播', async () => {
  const failures = [];
  const { animationFrames, engine } = await createHarness({
    onFrame() {
      throw new Error('simulated canvas failure');
    },
  });

  engine.start({
    width: 1_920,
    height: 1_080,
    durationMs: 1_000,
    onError: () => failures.push('failed'),
  });
  animationFrames.fire(animationFrames.active()[0], 1_000);

  assert.equal(engine.isRunning(), false);
  assert.equal(animationFrames.active().length, 0);
  assert.deepEqual(failures, ['failed']);
});

test('單一沙漠陣風的可見沙塵峰值隨高度上移，且維持在畫面中間偏右', async () => {
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: 1_800,
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
      visibleMasses[index] >= neighboringMass * 0.65,
      `進度 ${continuousFrames[index].progress} 的沙塵不可形成週期性低谷：` +
        JSON.stringify({
          visibleMass: visibleMasses[index],
          neighboringMass,
        }),
    );
  }
});

test('顆粒侵蝕面連續上移，且中段維持不規則的近二值前緣', async () => {
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: 900,
  });

  engine.start({ width: 1_000, height: 600, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);
  const checkpoints = [];
  for (const progress of [0.2, 0.4, 0.6, 0.8]) {
    animationFrames.fire(
      animationFrames.active()[0],
      1_000 + progress * 1_000,
    );
    const frame = frames.at(-1);
    checkpoints.push({
      progress,
      erasedPixelCount: frame.erosionMask.erasedPixelCount,
      width: frame.erosionMask.width,
      height: frame.erosionMask.height,
      pixels: progress === 0.4 ? frame.erosionMask.pixels.slice() : null,
    });
  }

  assert.ok(
    checkpoints.slice(1).every((checkpoint, index) =>
      checkpoint.erasedPixelCount > checkpoints[index].erasedPixelCount,
    ),
    `侵蝕面必須持續擴大：${JSON.stringify(checkpoints)}`,
  );

  const middleCheckpoint = checkpoints.find(({ progress }) => progress === 0.4);
  const { width, height, pixels } = middleCheckpoint;
  const rowRatios = [];
  for (let y = 0; y < height; y += 1) {
    let erasedMass = 0;
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      erasedMass += alpha / 255;
    }
    rowRatios.push(erasedMass / width);
  }

  const mixedRows = rowRatios.filter((ratio) => ratio >= 0.1 && ratio <= 0.9);
  assert.ok(
    mixedRows.length / height >= 0.22,
    '中段至少畫面高度 22% 必須呈現左清右留，不能形成全寬水平硬邊',
  );
  const lowerThird = rowRatios.slice(Math.floor(height * 2 / 3));
  const upperThird = rowRatios.slice(0, Math.floor(height / 3));
  assert.ok(
    median(lowerThird) > median(upperThird),
    '下方必須比上方更早被風吹走，維持風勢逐漸上移',
  );
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
    assert.ok(particle.sourceSize >= 1.5, '沙粒必須裁自舊圖片的來源區塊');
    assert.ok(particle.size >= 1.25, '沙粒必須維持可辨識尺寸');
    assert.ok(
      particle.fragmentStrength > 0 || particle.size <= particle.sourceSize,
      '離開表面的細砂只能縮小；只有剛剝落的原圖碎片可短暫放大',
    );
    assert.ok(particle.opacity > 0 && particle.opacity <= 1);
  }

  animationFrames.fire(animationFrames.active()[0], 1_750);
  assert.ok(
    frames.at(-1).erosionMask.erasedPixelCount >
      middleFrame.erosionMask.erasedPixelCount,
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
    visibleMasses[2] < visibleMasses[1] * 0.15,
    `99% 時必須只剩極淡尾跡或已完全消散：${JSON.stringify(visibleMasses)}`,
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
  assert.ok(frames[1].erosionMask.width <= 960);
  assert.ok(frames[1].erosionMask.height <= 540);
  assert.ok(randomCallCount <= maximum * 5 + 1);
});

test('增量遮罩可在持久 Canvas 上累積成相同侵蝕量，且髒矩形涵蓋全部變更', async () => {
  const { animationFrames, engine, frames } = await createHarness({
    maxParticleCount: 200,
  });

  engine.start({ width: 320, height: 180, durationMs: 1_000 });
  animationFrames.fire(animationFrames.active()[0], 1_000);
  const initial = frames.at(-1).erosionMask;
  const remainingAlpha = new Float64Array(initial.totalPixelCount).fill(255);

  for (const progress of [0.2, 0.35, 0.5, 0.8, 1]) {
    animationFrames.fire(
      animationFrames.active()[0],
      1_000 + progress * 1_000,
    );
    const mask = frames.at(-1).erosionMask;
    let changedPixelCount = 0;

    for (let index = 0; index < mask.totalPixelCount; index += 1) {
      const deltaAlpha = mask.deltaPixels[index * 4 + 3];
      if (deltaAlpha <= 0) {
        continue;
      }
      changedPixelCount += 1;
      const x = index % mask.width;
      const y = Math.floor(index / mask.width);
      assert.ok(mask.dirtyBounds !== null);
      assert.ok(
        x >= mask.dirtyBounds.x &&
        x < mask.dirtyBounds.x + mask.dirtyBounds.width &&
        y >= mask.dirtyBounds.y &&
        y < mask.dirtyBounds.y + mask.dirtyBounds.height,
        '每個增量 alpha 像素都必須落在回報的髒矩形內',
      );
      remainingAlpha[index] *= 1 - deltaAlpha / 255;
    }

    assert.ok(changedPixelCount > 0 || progress === 1);
    for (let index = 0; index < mask.totalPixelCount; index += 1) {
      const expectedRemaining = 255 - mask.pixels[index * 4 + 3];
      assert.ok(
        Math.abs(remainingAlpha[index] - expectedRemaining) <= 2.1,
        `增量合成必須等同累積遮罩：${JSON.stringify({
          progress,
          index,
          actual: remainingAlpha[index],
          expected: expectedRemaining,
        })}`,
      );
    }
  }

  assert.ok(remainingAlpha.every((alpha) => alpha <= 2.1));
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
  assert.ok(randomCallCount <= maximum * 5 + 1);
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
    frames.at(-1).erosionMask.erasedPixelCount,
    frames.at(-1).erosionMask.totalPixelCount,
    '完成時舊圖片的所有遮罩像素都必須被吹走',
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
    () => engine.prepare({ width: 0, height: 1_080 }),
    /寬高必須是正數/,
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
  assert.throws(
    () => engine.start({
      width: 1_920,
      height: 1_080,
      durationMs: 1_000,
      onError: 'failed',
    }),
    /失敗回呼必須是函式/,
  );
});
