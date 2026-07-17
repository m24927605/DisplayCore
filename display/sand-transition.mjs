/** 單次轉場允許的粒子硬上限，避免 4K 畫面產生與像素數等比例的工作量。 */
const HARD_MAXIMUM_PARTICLE_COUNT = 2_400;
const DEFAULT_PARTICLE_COUNT = 1_600;

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
 * 以固定數量的分層取樣點建立舊圖片碎片資料。
 *
 * 每個取樣點只保存來源座標與運動參數，不讀取圖片像素，因此解析度提高到
 * 4K 時仍維持固定且有界的 CPU／記憶體成本。呼叫端可用 sourceX、sourceY
 * 從舊圖片裁出粒粒分明的方形沙粒。
 */
function createSamples({ width, height, sampleCount, random }) {
  const aspectRatio = width / height;
  const columns = Math.max(1, Math.ceil(Math.sqrt(sampleCount * aspectRatio)));
  const rows = Math.ceil(sampleCount / columns);
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const shortestSide = Math.min(width, height);
  const samples = new Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const horizontalJitter = clamp(random(), 0, 1);
    const verticalJitter = clamp(random(), 0, 1);
    const sizeRandom = clamp(random(), 0, 1);
    const driftRandom = clamp(random(), 0, 1);
    const liftRandom = clamp(random(), 0, 1);
    const sourceX = Math.min(
      width,
      (column + 0.15 + horizontalJitter * 0.7) * cellWidth,
    );
    const sourceY = Math.min(
      height,
      (row + 0.15 + verticalJitter * 0.7) * cellHeight,
    );

    samples[index] = {
      sourceX,
      sourceY,
      size: Math.max(2, shortestSide * (0.0015 + sizeRandom * 0.003)),
      driftDistance: width * (0.06 + driftRandom * 0.14),
      verticalDistance: height * ((liftRandom - 0.5) * 0.04),
      activation: clamp(
        sourceX / width + (liftRandom - 0.5) * 0.045,
        0,
        0.985,
      ),
      lifeProgress: 0.2 + sizeRandom * 0.12,
    };
  }

  return samples;
}

function createParticleFrame(samples, progress) {
  if (progress <= 0) {
    return [];
  }

  const particles = [];

  for (const sample of samples) {
    const age = (progress - sample.activation) / sample.lifeProgress;

    if (age < 0 || age >= 1) {
      continue;
    }

    const easedAge = 1 - (1 - age) ** 2;
    particles.push({
      sourceX: sample.sourceX,
      sourceY: sample.sourceY,
      x: sample.sourceX + sample.driftDistance * easedAge,
      y: sample.sourceY + sample.verticalDistance * easedAge,
      size: sample.size,
      opacity: 1 - age ** 1.25,
    });
  }

  return particles;
}

/**
 * 建立與 DOM、Canvas 解耦的風吹沙時間軸。
 *
 * 引擎只回傳每幀的溶解邊界與粒子座標；圖片裁切及繪製方式由呼叫端決定。
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
        dissolveFrontX: transition.width * progress,
        sampleCount: transition.samples.length,
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
