/** 單次轉場允許的粒子硬上限，避免 4K 畫面產生與像素數等比例的工作量。 */
const HARD_MAXIMUM_PARTICLE_COUNT = 2_400;
const DEFAULT_PARTICLE_COUNT = 1_600;
const EROSION_GROWTH_PROGRESS = 0.1;
const WIND_START_PROGRESS = 0.025;
const WIND_VERTICAL_TRAVEL_PROGRESS = 0.75;
const DUST_CORE_HORIZONTAL_POSITION = 0.66;
const DUST_CORE_HORIZONTAL_SPREAD = 0.11;
const PARTICLE_FINAL_FADE_START_PROGRESS = 0.88;
const TAU = Math.PI * 2;

export const SAND_TRANSITION_LIMITS = Object.freeze({
  maximumParticleCount: HARD_MAXIMUM_PARTICLE_COUNT,
  defaultParticleCount: DEFAULT_PARTICLE_COUNT,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validateStartOptions({ width, height, durationMs, onComplete }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('風吹沙轉場的畫面寬高必須是正數。');
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('風吹沙轉場的時間必須是正數。');
  }

  if (onComplete !== undefined && typeof onComplete !== 'function') {
    throw new TypeError('風吹沙轉場的完成回呼必須是函式。');
  }
}

/**
 * 以固定數量的完整網格建立舊圖片碎片與侵蝕孔資料。
 *
 * 每個取樣點只保存來源座標、連續侵蝕面的啟動時間及運動參數，不讀取圖片像素，
 * 因此解析度提高到 4K 時，此引擎的取樣計算與粒子資料量仍固定且有界。
 * 呼叫端可用 sourceX、sourceY 從舊圖片裁出粒粒分明的方形沙粒。
 */
function createSamples({ width, height, sampleCount, random }) {
  const aspectRatio = width / height;
  const columns = Math.max(
    1,
    Math.min(sampleCount, Math.floor(Math.sqrt(sampleCount * aspectRatio))),
  );
  const rows = Math.max(1, Math.floor(sampleCount / columns));
  const actualSampleCount = columns * rows;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const shortestSide = Math.min(width, height);
  const samples = new Array(actualSampleCount);

  for (let index = 0; index < actualSampleCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const horizontalJitter = clamp(random(), 0, 1);
    const verticalJitter = clamp(random(), 0, 1);
    const sizeRandom = clamp(random(), 0, 1);
    const driftRandom = clamp(random(), 0, 1);
    const liftRandom = clamp(random(), 0, 1);
    const sourceX = Math.min(width, (
      column + 0.38 + horizontalJitter * 0.24
    ) * cellWidth);
    const sourceY = Math.min(height, (
      row + 0.38 + verticalJitter * 0.24
    ) * cellHeight);
    const normalizedX = sourceX / width;
    const distanceFromBottom = (height - sourceY) / height;
    const phase = (
      index * 2.399963 + sourceX * 0.013 + sourceY * 0.009
    ) % TAU;
    const plumeStrength = Math.exp(
      -0.5 * (
        (normalizedX - DUST_CORE_HORIZONTAL_POSITION) /
        DUST_CORE_HORIZONTAL_SPREAD
      ) ** 2,
    );
    // 兩個不同頻率的緩慢起伏形成沙丘表面；不使用 floor 或分帶索引，
    // 因此侵蝕面只會連續向上，不會在每一列重新做左到右掃描。
    const surfaceRoughness =
      Math.sin(TAU * (normalizedX * 1.15 + distanceFromBottom * 0.12) + 0.4) *
        0.012 +
      Math.sin(TAU * (normalizedX * 3.7 + distanceFromBottom * 0.35)) * 0.007 +
      (liftRandom - 0.5) * 0.012;
    const activation = clamp(
      WIND_START_PROGRESS +
        distanceFromBottom * WIND_VERTICAL_TRAVEL_PROGRESS +
        normalizedX * 0.006 +
        surfaceRoughness -
        plumeStrength * 0.012,
      0.005,
      0.82,
    );
    const sourceSize = Math.max(
      2,
      shortestSide * (0.0015 + sizeRandom * 0.003),
    );

    samples[index] = {
      sourceX,
      sourceY,
      sourceSize,
      erosionRadius: Math.hypot(cellWidth, cellHeight) *
        (0.58 + sizeRandom * 0.12),
      driftDistance: width * (
        0.025 + driftRandom * 0.05 + plumeStrength * 0.02
      ),
      liftDistance: height * (
        0.025 + liftRandom * 0.035 + plumeStrength * 0.085
      ),
      turbulenceDistance: width * (0.004 + sizeRandom * 0.008),
      suspensionStrength: clamp(
        (1 - sizeRandom) * 0.32 + plumeStrength * 0.68,
        0,
        1,
      ),
      phase,
      activation,
      lifeProgress: 0.23 + sizeRandom * 0.04 + plumeStrength * 0.09,
      opacityScale: 0.14 + plumeStrength * 0.86,
    };
  }

  return samples;
}

/** 侵蝕孔隨單一沙丘表面連續上移，圓孔大小漸增以保留粒狀邊緣。 */
function createErosionFrame(samples, progress) {
  if (progress <= 0) {
    return [];
  }

  const patches = [];

  for (const sample of samples) {
    const growth = clamp(
      (progress - sample.activation) / EROSION_GROWTH_PROGRESS,
      0,
      1,
    );

    if (growth <= 0) {
      continue;
    }

    const easedGrowth = 1 - (1 - growth) ** 3;
    patches.push({
      x: sample.sourceX,
      y: sample.sourceY,
      radius: sample.erosionRadius * easedGrowth,
    });
  }

  return patches;
}

function createParticleFrame(samples, progress) {
  if (progress <= 0 || progress >= 1) {
    return [];
  }

  const particles = [];
  const finalFade = progress <= PARTICLE_FINAL_FADE_START_PROGRESS
    ? 1
    : (1 - progress) / (1 - PARTICLE_FINAL_FADE_START_PROGRESS);

  for (const sample of samples) {
    const age = (progress - sample.activation) / sample.lifeProgress;

    if (age < 0 || age >= 1) {
      continue;
    }

    const travelProgress = age + age ** 2 * 0.35;
    // 較大的砂粒貼近表面跳動，細砂則懸浮上升，兩者共同形成翻滾沙塵。
    const saltationArc = Math.sin(Math.PI * age) ** 0.82;
    const suspensionRise = 1 - (1 - age) ** 1.4;
    const liftProgress =
      saltationArc * (1 - sample.suspensionStrength) * 0.65 +
      suspensionRise * sample.suspensionStrength;
    const turbulenceEnvelope = Math.sin(Math.PI * age);
    const horizontalTurbulence = Math.sin(
      sample.phase + age * 9,
    ) * sample.turbulenceDistance * turbulenceEnvelope;
    const verticalTurbulence = Math.cos(
      sample.phase * 1.7 + age * 11,
    ) * sample.liftDistance * 0.12 * turbulenceEnvelope;
    const horizontalTravel = Math.max(
      0,
      sample.driftDistance * travelProgress + horizontalTurbulence,
    );
    const upwardTravel = Math.max(
      0,
      sample.liftDistance * liftProgress + verticalTurbulence,
    );
    // 沙粒從表面鬆動後快速成形，避免每一批新粒子在同一幀突然閃現。
    const entranceFade = clamp(age / 0.14, 0, 1);
    particles.push({
      sourceX: sample.sourceX,
      sourceY: sample.sourceY,
      sourceSize: sample.sourceSize,
      x: sample.sourceX + horizontalTravel,
      y: sample.sourceY - upwardTravel,
      size: Math.max(2, sample.sourceSize * (1 - age * 0.38)),
      opacity: sample.opacityScale * entranceFade * (1 - age) ** 1.18 * finalFade,
    });
  }

  return particles;
}

/**
 * 建立與 DOM、Canvas 解耦的風吹沙時間軸。
 *
 * 引擎只回傳每幀的侵蝕孔與粒子座標；圖片裁切及繪製方式由呼叫端決定。
 * 建立後不會自行播放，只有呼叫 start 才會向注入的 requestFrame 排程。
 */
export function createSandTransition({
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  onFrame,
  random = Math.random,
  maxParticleCount = DEFAULT_PARTICLE_COUNT,
} = {}) {
  if (
    typeof requestFrame !== 'function' ||
    typeof cancelFrame !== 'function' ||
    typeof onFrame !== 'function' ||
    typeof random !== 'function'
  ) {
    throw new TypeError('風吹沙轉場缺少必要相依函式。');
  }

  if (!Number.isInteger(maxParticleCount) || maxParticleCount <= 0) {
    throw new RangeError('風吹沙轉場的粒子上限必須是正整數。');
  }

  const sampleCount = Math.min(maxParticleCount, HARD_MAXIMUM_PARTICLE_COUNT);
  let disposed = false;
  let running = false;
  let generation = 0;
  let frameHandle = null;
  let startTimestamp = null;
  let transition = null;

  function cancelScheduledFrame() {
    if (frameHandle === null) {
      return;
    }

    cancelFrame(frameHandle);
    frameHandle = null;
  }

  function scheduleFrame(scheduledGeneration) {
    let scheduledHandle = null;
    scheduledHandle = requestFrame((timestamp) => {
      if (
        disposed ||
        !running ||
        scheduledGeneration !== generation ||
        frameHandle !== scheduledHandle
      ) {
        return;
      }

      frameHandle = null;

      if (startTimestamp === null) {
        startTimestamp = timestamp;
      }

      const elapsed = Math.max(0, timestamp - startTimestamp);
      const progress = clamp(elapsed / transition.durationMs, 0, 1);
      const frame = {
        width: transition.width,
        height: transition.height,
        progress,
        sampleCount: transition.samples.length,
        erosionPatches: createErosionFrame(transition.samples, progress),
        particles: createParticleFrame(transition.samples, progress),
      };

      onFrame(frame);

      // onFrame 可能同步要求取消或開始下一次轉場，舊幀不得再排程或完成。
      if (disposed || !running || scheduledGeneration !== generation) {
        return;
      }

      if (progress >= 1) {
        const complete = transition.onComplete;
        running = false;
        transition = null;
        complete?.();
        return;
      }

      scheduleFrame(scheduledGeneration);
    });
    frameHandle = scheduledHandle;
  }

  function cancel() {
    if (!running) {
      return false;
    }

    generation += 1;
    running = false;
    startTimestamp = null;
    transition = null;
    cancelScheduledFrame();
    return true;
  }

  return Object.freeze({
    /** 開始一輪新轉場；若上一輪仍執行中，會先使其所有回呼失效。 */
    start(options) {
      if (disposed) {
        return false;
      }

      validateStartOptions(options);
      cancel();
      generation += 1;
      running = true;
      startTimestamp = null;
      transition = {
        width: options.width,
        height: options.height,
        durationMs: options.durationMs,
        onComplete: options.onComplete,
        samples: createSamples({
          width: options.width,
          height: options.height,
          sampleCount,
          random,
        }),
      };
      scheduleFrame(generation);
      return true;
    },

    cancel,

    isRunning() {
      return running;
    },

    /** 永久停止引擎；dispose 後的 start 與 stale callback 都不再生效。 */
    dispose() {
      if (disposed) {
        return;
      }

      cancel();
      disposed = true;
      generation += 1;
    },
  });
}
