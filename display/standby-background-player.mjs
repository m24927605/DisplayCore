/**
 * 管理待機背景來源與輪播節奏。
 *
 * 本模組不碰 DOM；圖片是否真正解碼成功由呼叫端透過 handleLoad／
 * handleError 回報。如此停留秒數只會從可見圖片完成載入後開始計算。
 */
export function createStandbyBackgroundPlayer({
  onSourceChange,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  if (
    typeof onSourceChange !== 'function' ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function'
  ) {
    throw new TypeError('待機背景播放器缺少必要相依函式。');
  }

  let active = false;
  let backgroundMode = 'fixed';
  let backgroundImageUrls = [];
  let slideDurationSeconds = 10;
  let currentIndex = -1;
  let currentUrl = null;
  let timer = null;
  let generation = 0;
  let disposed = false;
  let failedUrls = new Set();

  function cancelTimer() {
    if (timer === null) {
      return;
    }

    clearTimer(timer);
    timer = null;
  }

  function publishSource(url, index) {
    cancelTimer();
    currentUrl = url;
    currentIndex = index;
    onSourceChange(url);
  }

  function findNextHealthyIndex() {
    for (let offset = 1; offset < backgroundImageUrls.length; offset += 1) {
      const index = (currentIndex + offset) % backgroundImageUrls.length;

      if (!failedUrls.has(backgroundImageUrls[index])) {
        return index;
      }
    }

    return -1;
  }

  function advance() {
    if (!active || disposed || currentUrl === null) {
      return false;
    }

    const nextIndex = findNextHealthyIndex();

    if (nextIndex < 0) {
      return false;
    }

    publishSource(backgroundImageUrls[nextIndex], nextIndex);
    return true;
  }

  function scheduleAdvance() {
    cancelTimer();

    if (
      !active ||
      disposed ||
      backgroundMode !== 'slideshow' ||
      currentUrl === null ||
      backgroundImageUrls.filter((url) => !failedUrls.has(url)).length < 2
    ) {
      return;
    }

    const scheduledGeneration = generation;
    const scheduledUrl = currentUrl;
    const handle = setTimer(() => {
      clearTimer(handle);

      if (timer === handle) {
        timer = null;
      }

      if (
        disposed ||
        !active ||
        scheduledGeneration !== generation ||
        scheduledUrl !== currentUrl
      ) {
        return;
      }

      advance();
    }, slideDurationSeconds * 1_000);
    timer = handle;
  }

  return Object.freeze({
    /** 套用最新設定或顯示模式；每次進入待機都從第一張開始。 */
    update(settings) {
      if (disposed) {
        return false;
      }

      generation += 1;
      cancelTimer();
      active = settings.active === true;
      backgroundMode = settings.backgroundMode;
      backgroundImageUrls = [...settings.backgroundImageUrls];
      slideDurationSeconds = settings.slideDurationSeconds;
      failedUrls = new Set();
      currentIndex = -1;
      currentUrl = null;

      if (!active) {
        return true;
      }

      if (backgroundImageUrls.length === 0) {
        publishSource(null, -1);
        return true;
      }

      publishSource(backgroundImageUrls[0], 0);
      return true;
    },

    /** 圖片成功解碼後才開始計算該張的停留時間。 */
    handleLoad(url) {
      if (disposed || !active || url !== currentUrl) {
        return false;
      }

      scheduleAdvance();
      return true;
    },

    /** 跳過壞圖；每張每輪最多嘗試一次，全部失敗即停止。 */
    handleError(url) {
      if (disposed || !active || url !== currentUrl) {
        return false;
      }

      failedUrls.add(url);
      cancelTimer();
      const nextIndex = findNextHealthyIndex();

      if (nextIndex < 0) {
        publishSource(null, -1);
        return true;
      }

      publishSource(backgroundImageUrls[nextIndex], nextIndex);
      return true;
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      active = false;
      generation += 1;
      cancelTimer();
      currentUrl = null;
      currentIndex = -1;
      onSourceChange(null);
    },
  });
}
