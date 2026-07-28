function validateGeometry({ width, height }) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError('GPU 風吹砂時間軸的畫面寬高必須是正數。');
  }
}

function validateStart({ width, height, durationMs, onComplete, onError }) {
  validateGeometry({ width, height });
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('GPU 風吹砂時間軸的時間必須是正數。');
  }
  if (onComplete !== undefined && typeof onComplete !== 'function') {
    throw new TypeError('GPU 風吹砂時間軸的完成回呼必須是函式。');
  }
  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('GPU 風吹砂時間軸的失敗回呼必須是函式。');
  }
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * 只負責 GPU 轉場的播放生命週期與單調進度。
 *
 * WebGL 會在顯示卡上直接處理每個圖片像素，因此這個時間軸不得再建立 CPU
 * erosion mask 或數萬個 JS 粒子；Renderer 每幀只收到尺寸與 0～1 進度。
 */
export function createSandTimeline({
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  onFrame,
} = {}) {
  if (
    typeof requestFrame !== 'function' ||
    typeof cancelFrame !== 'function' ||
    typeof onFrame !== 'function'
  ) {
    throw new TypeError('GPU 風吹砂時間軸缺少必要相依函式。');
  }

  let disposed = false;
  let running = false;
  let generation = 0;
  let frameHandle = null;
  let startTimestamp = null;
  let transition = null;
  let preparedGeometry = null;

  function cancelScheduledFrame() {
    if (frameHandle === null) {
      return;
    }
    cancelFrame(frameHandle);
    frameHandle = null;
  }

  function scheduleFrame(expectedGeneration) {
    let scheduledHandle = null;
    scheduledHandle = requestFrame((timestamp) => {
      if (
        disposed ||
        !running ||
        generation !== expectedGeneration ||
        frameHandle !== scheduledHandle
      ) {
        return;
      }
      frameHandle = null;
      if (startTimestamp === null) {
        startTimestamp = timestamp;
      }

      const progress = clamp01(
        Math.max(0, timestamp - startTimestamp) / transition.durationMs,
      );
      try {
        onFrame({
          width: transition.width,
          height: transition.height,
          progress,
        });
      } catch {
        const fail = transition.onError;
        running = false;
        startTimestamp = null;
        transition = null;
        try {
          fail?.();
        } catch {
          // 清理失敗不可再中斷 Renderer 事件迴圈。
        }
        return;
      }

      if (disposed || !running || generation !== expectedGeneration) {
        return;
      }
      if (progress >= 1) {
        const complete = transition.onComplete;
        running = false;
        startTimestamp = null;
        transition = null;
        complete?.();
        return;
      }
      scheduleFrame(expectedGeneration);
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
    prepare(options) {
      if (disposed || running) {
        return false;
      }
      validateGeometry(options);
      preparedGeometry = { width: options.width, height: options.height };
      return true;
    },

    discardPrepared() {
      const hadPreparedGeometry = preparedGeometry !== null;
      preparedGeometry = null;
      return hadPreparedGeometry;
    },

    start(options) {
      if (disposed) {
        return false;
      }
      validateStart(options);
      cancel();
      generation += 1;
      running = true;
      startTimestamp = null;
      preparedGeometry = null;
      transition = { ...options };
      scheduleFrame(generation);
      return true;
    },

    cancel,

    isRunning() {
      return running;
    },

    dispose() {
      if (disposed) {
        return;
      }
      cancel();
      preparedGeometry = null;
      disposed = true;
    },
  });
}
