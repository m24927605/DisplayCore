function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// 4K 最多三列時，每幀重建六層 SVG 幾何的成本高於視覺收益。30fps 對
// 招待會所的液體慢動態已足夠連續，WAAPI 仍逐毫秒計時並保證終幀 100%。
const MINIMUM_RENDER_INTERVAL_MILLISECONDS = 1_000 / 30;
// 100% 終幀至少經過一個實際 paint 後再保留 100ms，30fps 錄影與一般
// 電視 compositor 才能穩定捕捉，而不是只存在於尚未呈現的 DOM 狀態。
const MINIMUM_PRESENTED_FULL_FRAME_MILLISECONDS = 100;

function formatPercentage(progress) {
  return `${Number((clamp(progress, 0, 1) * 100).toFixed(6))}%`;
}

function isTimedPageSnapshot(snapshot) {
  const commonPageIsValid = Boolean(
    snapshot?.mode === 'page' &&
    Number.isSafeInteger(snapshot.pageDurationSeconds) &&
    snapshot.pageDurationSeconds >= 1 &&
    Number.isSafeInteger(snapshot.pageNumber) &&
    Number.isSafeInteger(snapshot.pageCount) &&
    snapshot.pageCount >= 1 &&
    snapshot.pageNumber >= 1 &&
    snapshot.pageNumber <= snapshot.pageCount &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision >= 0
  );
  if (!commonPageIsValid) {
    return false;
  }

  const finiteMetadataIsValid =
    Number.isSafeInteger(snapshot.roundNumber) &&
    Number.isSafeInteger(snapshot.totalRounds) &&
    snapshot.totalRounds >= 1 &&
    snapshot.roundNumber >= 1 &&
    snapshot.roundNumber <= snapshot.totalRounds;
  const continuousPageHasAnEnd =
    snapshot.roundNumber === null &&
    snapshot.totalRounds === null &&
    snapshot.pageCount > 1;

  return finiteMetadataIsValid || continuousPageHasAnEnd;
}

/**
 * 每個實際顯示頁都是一個獨立的盛酒週期。
 *
 * 頁碼與輪次只保留給診斷資訊；每次換頁後的新字形均由 0% 開始，並在
 * Main 真正結束該頁時精確到達 100%，不再把整批頁數切成數段進度。
 */
function createMessageLiquidTimelineWithDuration(
  snapshot,
  durationMilliseconds = snapshot?.pageDurationSeconds * 1_000,
) {
  if (
    !isTimedPageSnapshot(snapshot) ||
    !Number.isFinite(durationMilliseconds) ||
    durationMilliseconds < 1
  ) {
    return null;
  }

  const isContinuous = snapshot.roundNumber === null;
  const totalSteps = isContinuous
    ? snapshot.pageCount
    : snapshot.pageCount * snapshot.totalRounds;
  if (!Number.isSafeInteger(totalSteps)) {
    return null;
  }
  const stepIndex = isContinuous
    ? snapshot.pageNumber - 1
    : ((snapshot.roundNumber - 1) * snapshot.pageCount) +
      (snapshot.pageNumber - 1);

  return Object.freeze({
    durationMilliseconds,
    endProgress: 1,
    keyframes: Object.freeze([
      Object.freeze({
        offset: 0,
        '--message-liquid-level': '0%',
      }),
      Object.freeze({
        offset: 1,
        '--message-liquid-level': '100%',
      }),
    ]),
    revision: snapshot.revision,
    startProgress: 0,
    stepNumber: stepIndex + 1,
    totalSteps,
  });
}

export function createMessageLiquidTimeline(snapshot) {
  return createMessageLiquidTimelineWithDuration(snapshot);
}

function resolveDefaultFrameRequester() {
  return typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : null;
}

function resolveDefaultFrameCanceller() {
  return typeof globalThis.cancelAnimationFrame === 'function'
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : null;
}

/**
 * 以 WAAPI 作為 Main 頁面時間的單一時鐘，再由一個 rAF 將目前時間送入
 * SVG 物理 Renderer。WAAPI 不再製造波形，只留下可 seek 的 0～100% 時軸。
 */
export function createMessageLiquidAnimator({
  cancelFrame = resolveDefaultFrameCanceller(),
  onComplete = () => {},
  onFailure = () => {},
  renderFrame = null,
  requestFrame = resolveDefaultFrameRequester(),
  shouldReduceMotion = () => false,
} = {}) {
  let current = null;
  let frameHandle = null;

  function stopFrameLoop() {
    if (frameHandle !== null && typeof cancelFrame === 'function') {
      cancelFrame(frameHandle);
    }
    frameHandle = null;
  }

  function applyStartFrame(target) {
    target.style.setProperty('--message-liquid-level', '0%');
  }

  function reset() {
    stopFrameLoop();
    if (current === null) {
      return;
    }

    current.animation?.cancel();
    current.target.style.removeProperty('--message-liquid-level');
    current = null;
  }

  function fail() {
    reset();
    try {
      onFailure();
    } catch {
      // fallback 通知不可反過來破壞 Display renderer。
    }
  }

  function notifyCompletion() {
    if (current === null || current.completionNotified) {
      return;
    }

    current.completionFramePending = false;
    current.completionNotified = true;
    try {
      onComplete(Object.freeze({
        durationMilliseconds: current.timeline.durationMilliseconds,
        layoutGeneration: current.layoutGeneration,
        revision: current.timeline.revision,
      }));
    } catch {
      // 終點回報失敗不得反向破壞已完成的白框與酒液終幀。
    }
  }

  /**
   * 100% 幾何必須先經過至少一個瀏覽器繪製週期，才可通知 Main 換頁。
   * 否則同一個 rAF 內完成 IPC 與 DOM 清除，電視可能從未真正呈現滿杯終幀。
   */
  function notifyCompletionAfterPresentedFrame() {
    if (
      current === null ||
      !current.ended ||
      current.completionNotified ||
      current.completionFramePending
    ) {
      return;
    }

    if (typeof requestFrame !== 'function') {
      notifyCompletion();
      return;
    }

    const expectedCurrent = current;
    current.completionFramePending = true;
    /*
     * animation.finished 可能在 paint 前的 microtask 觸發；第一個 rAF 只用
     * 來建立「下一次 paint 將呈現滿杯」的時間錨點。其後以真實時間差等待，
     * 不用固定 callback 數猜測 60Hz／120Hz 或錄影器的刷新率。
     */
    function waitForPresentedFrame(timestamp) {
      frameHandle = null;
      if (current !== expectedCurrent || !current.ended) {
        return;
      }

      const frameClock = Number(timestamp);
      if (
        current.fullFramePresentedAt === null ||
        !Number.isFinite(current.fullFramePresentedAt) ||
        !Number.isFinite(frameClock) ||
        frameClock < current.fullFramePresentedAt
      ) {
        current.fullFramePresentedAt = Number.isFinite(frameClock)
          ? frameClock
          : 0;
        frameHandle = requestFrame(waitForPresentedFrame);
        return;
      }

      if (
        frameClock - current.fullFramePresentedAt <
          MINIMUM_PRESENTED_FULL_FRAME_MILLISECONDS
      ) {
        frameHandle = requestFrame(waitForPresentedFrame);
        return;
      }

      current.completionFramePending = false;
      notifyCompletion();
    }

    frameHandle = requestFrame(waitForPresentedFrame);
  }

  function scheduleFrame() {
    if (
      current === null ||
      typeof renderFrame !== 'function' ||
      typeof requestFrame !== 'function'
    ) {
      return;
    }

    const expectedAnimation = current.animation;
    frameHandle = requestFrame((timestamp) => {
      frameHandle = null;
      if (
        current === null ||
        current.animation !== expectedAnimation ||
        expectedAnimation === null
      ) {
        return;
      }

      const durationMilliseconds = current.timeline.durationMilliseconds;
      const animationTime = Number(expectedAnimation.currentTime);
      const timeMilliseconds = clamp(
        Number.isFinite(animationTime) ? animationTime : 0,
        0,
        durationMilliseconds,
      );
      const progress = timeMilliseconds / durationMilliseconds;
      const frameClock = Number.isFinite(timestamp)
        ? timestamp
        : timeMilliseconds;
      const shouldRender =
        current.lastRenderedFrameClock === null ||
        frameClock < current.lastRenderedFrameClock ||
        frameClock - current.lastRenderedFrameClock >=
          MINIMUM_RENDER_INTERVAL_MILLISECONDS ||
        progress >= 1;

      if (shouldRender) {
        try {
          renderFrame(Object.freeze({
            durationMilliseconds,
            progress,
            timeMilliseconds,
          }));
          current.lastRenderedFrameClock = frameClock;
        } catch {
          fail();
          return;
        }
      }

      if (progress < 1) {
        scheduleFrame();
      } else {
        current.ended = true;
        current.target.style.setProperty('--message-liquid-level', '100%');
        notifyCompletionAfterPresentedFrame();
      }
    });
  }

  /**
   * WAAPI 的 finished Promise 抵達實際期限後，補繪可能被節流漏掉的 100%
   * 終幀。這個方法只供期限回呼使用，不能暴露給跑馬燈或其他呼叫端，避免
   * 尚未到期就把酒液強制跳滿。
   */
  function renderDeadlineFrame(revision, layoutGeneration = null) {
    if (
      current === null ||
      current.timeline.revision !== revision ||
      !current.started ||
      current.layoutGeneration !== layoutGeneration ||
      current.animation === null
    ) {
      return false;
    }
    if (current.ended) {
      notifyCompletionAfterPresentedFrame();
      return true;
    }

    stopFrameLoop();
    const durationMilliseconds = current.timeline.durationMilliseconds;
    const animationTime = Number(current.animation.currentTime);
    if (
      !Number.isFinite(animationTime) ||
      animationTime < durationMilliseconds
    ) {
      return false;
    }

    try {
      current.target.style.setProperty('--message-liquid-level', '100%');
      if (typeof renderFrame === 'function') {
        renderFrame(Object.freeze({
          durationMilliseconds,
          progress: 1,
          timeMilliseconds: durationMilliseconds,
        }));
      }
      current.ended = true;
      notifyCompletionAfterPresentedFrame();
      return true;
    } catch {
      fail();
      return false;
    }
  }

  return Object.freeze({
    prepare(snapshot, target) {
      const timeline = createMessageLiquidTimeline(snapshot);
      let reducedMotion = true;
      try {
        reducedMotion = Boolean(shouldReduceMotion());
      } catch {
        reducedMotion = true;
      }

      if (
        timeline === null ||
        reducedMotion ||
        typeof target?.animate !== 'function' ||
        typeof target?.style?.setProperty !== 'function' ||
        typeof target.style.removeProperty !== 'function'
      ) {
        reset();
        return false;
      }

      reset();
      applyStartFrame(target);
      current = {
        animation: null,
        completionFramePending: false,
        completionNotified: false,
        ended: false,
        fullFramePresentedAt: null,
        lastRenderedFrameClock: null,
        layoutGeneration: null,
        snapshot,
        started: false,
        target,
        timeline,
      };
      return true;
    },

    /** 排版完成後，以最長跑馬燈 traversal 重建仍未開始的本頁時軸。 */
    retime(revision, durationMilliseconds) {
      if (
        current === null ||
        current.timeline.revision !== revision ||
        !Number.isFinite(durationMilliseconds) ||
        durationMilliseconds < 1
      ) {
        return false;
      }

      // 同一 revision 播放中的 refit 只重新量測版面，不能取消後回到 0%。
      if (current.started) {
        return true;
      }

      const timeline = createMessageLiquidTimelineWithDuration(
        current.snapshot,
        durationMilliseconds,
      );
      if (timeline === null) {
        return false;
      }

      stopFrameLoop();
      current.animation?.cancel();
      current.animation = null;
      current.completionFramePending = false;
      current.completionNotified = false;
      current.ended = false;
      current.fullFramePresentedAt = null;
      current.lastRenderedFrameClock = null;
      current.layoutGeneration = null;
      current.started = false;
      current.timeline = timeline;
      applyStartFrame(current.target);
      return true;
    },

    /** 新 layout pending 時取消舊時鐘，固定回這一頁的空字腔。 */
    holdAtStart(revision) {
      if (current === null || current.timeline.revision !== revision) {
        return false;
      }


      // 初次 ready 前仍固定空杯；播放中的同頁 refit 則保持既有時鐘與液位。
      if (current.started) {
        return true;
      }

      stopFrameLoop();
      current.animation?.cancel();
      current.animation = null;
      current.completionFramePending = false;
      current.completionNotified = false;
      current.ended = false;
      current.fullFramePresentedAt = null;
      current.lastRenderedFrameClock = null;
      current.layoutGeneration = null;
      current.started = false;
      applyStartFrame(current.target);
      return true;
    },

    start(revision, layoutGeneration = null) {
      if (current === null || current.timeline.revision !== revision) {
        return false;
      }
      if (
        current.started &&
        current.layoutGeneration === layoutGeneration
      ) {
        return true;
      }

      if (current.started) {
        // layoutGeneration 只是一張頁面的排版 token，不是新的倒酒週期。
        // 更新 completion 的收件 token，但保留同一 WAAPI、currentTime 與酒量。
        current.layoutGeneration = layoutGeneration;
        if (current.ended && current.completionNotified) {
          current.completionNotified = false;
          current.completionFramePending = false;
          current.fullFramePresentedAt = null;
          notifyCompletionAfterPresentedFrame();
        }
        return true;
      }

      current.started = true;
      current.completionFramePending = false;
      current.completionNotified = false;
      current.ended = false;
      current.fullFramePresentedAt = null;
      current.lastRenderedFrameClock = null;
      current.layoutGeneration = layoutGeneration;

      try {
        current.animation = current.target.animate(
          current.timeline.keyframes,
          {
            duration: current.timeline.durationMilliseconds,
            easing: 'linear',
            fill: 'forwards',
            iterations: 1,
          },
        );
        const expectedAnimation = current.animation;
        const expectedLayoutGeneration = current.layoutGeneration;
        if (expectedAnimation?.finished?.then) {
          Promise.resolve(expectedAnimation.finished).then(
            () => {
              if (current?.animation === expectedAnimation) {
                renderDeadlineFrame(revision, expectedLayoutGeneration);
              }
            },
            () => {
              // hold、refit 或換頁取消 WAAPI 時 finished 會 reject，屬正常流程。
            },
          );
        }
        scheduleFrame();
      } catch {
        fail();
        return false;
      }
      return true;
    },

    reset,
    dispose: reset,
  });
}
