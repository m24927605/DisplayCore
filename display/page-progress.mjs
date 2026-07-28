const RETRY_BASE_MILLISECONDS = 100;
const RETRY_MAX_MILLISECONDS = 2_000;

function isAccepted(response) {
  return response?.ok === true && response.data?.accepted === true;
}

function isAuthoritativelyRejected(response) {
  return response?.ok === true && response.data?.accepted === false;
}

/**
 * 封裝 Display 對 Main 的最小版面進度回報。
 *
 * 每次 begin 都建立新的 layoutGeneration 並取消舊 DOM listener；只有目前
 * token 能進入 ready。Main 接受 started 後才同步啟動頁面效果；跑馬燈
 * traversal 與酒液 100% 終幀都滿足後，才回報 complete。暫時 IPC 失敗
 * 會以有上限的退避間隔重試，換頁、refit 或 dispose 會取消所有舊重試。
 */
export function createPageProgressReporter({
  report,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
  initialLayoutGeneration = 0,
  onLayoutGeneration = () => {},
  onPendingAccepted = () => {},
  onStartedAccepted = () => {},
  onTraversalComplete = () => {},
}) {
  if (
    typeof report !== 'function' ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function' ||
    typeof onLayoutGeneration !== 'function' ||
    typeof onPendingAccepted !== 'function' ||
    typeof onStartedAccepted !== 'function' ||
    typeof onTraversalComplete !== 'function' ||
    !Number.isSafeInteger(initialLayoutGeneration) ||
    initialLayoutGeneration < 0 ||
    initialLayoutGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('頁面進度回報器參數不正確。');
  }

  let layoutGeneration = initialLayoutGeneration;
  let active = null;
  let disposed = false;

  function finalizeTraversal(token) {
    if (
      disposed ||
      active?.token !== token ||
      active.traversalFinalized
    ) {
      return;
    }

    active.traversalFinalized = true;
    try {
      onTraversalComplete(token);
    } catch {
      // 裝飾性終幀故障不得阻止可讀內容正常換頁。
    }
  }

  /**
   * Renderer 的跑馬燈與酒液終幀都完成後，才回報同一個 complete。
   * Main 仍保有最短停留 timer 的最終決定權，Display 不自行翻頁。
   */
  function requestCompletion(token) {
    if (
      disposed ||
      active?.token !== token ||
      active.completeRequested ||
      !active.effectsStarted ||
      !active.traversalSatisfied ||
      !active.liquidCompletionSatisfied
    ) {
      return false;
    }

    active.completeRequested = true;
    active.controller.abort();
    finalizeTraversal(token);
    sendWithRetry('complete', token, undefined);
    return true;
  }

  function operationIsCurrent(operation) {
    return Boolean(
      !disposed &&
      active?.token === operation.token &&
      active.operations.get(operation.phase) === operation,
    );
  }

  function scheduleRetry(operation) {
    if (!operationIsCurrent(operation) || operation.timer !== null) {
      return;
    }

    const delay = Math.min(
      RETRY_BASE_MILLISECONDS * (2 ** operation.retryCount),
      RETRY_MAX_MILLISECONDS,
    );
    operation.retryCount += 1;
    operation.timer = setTimer(() => {
      operation.timer = null;
      sendAttempt(operation);
    }, delay);
    operation.timer?.unref?.();
  }

  function handleResponse(operation, response) {
    if (!operationIsCurrent(operation)) {
      return;
    }

    if (isAccepted(response)) {
      active.operations.delete(operation.phase);
      if (operation.phase === 'pending') {
        try {
          onPendingAccepted(operation.token);
        } catch {
          // pending 已使 Main 舊 timer 失效；排版故障時保持 fail closed。
        }
        return;
      }

      if (operation.phase === 'ready') {
        sendWithRetry('started', operation.token, undefined);
        return;
      }

      if (operation.phase === 'started') {
        let effectsStarted = false;
        try {
          effectsStarted = onStartedAccepted(operation.token) !== false;
        } catch {
          // 效果未能啟動時不宣告 complete，讓 Main fail closed、不提早翻頁。
        }

        if (!effectsStarted) {
          return;
        }

        active.effectsStarted = true;
        requestCompletion(operation.token);
      }
      return;
    }

    if (isAuthoritativelyRejected(response)) {
      active.operations.delete(operation.phase);
      return;
    }

    scheduleRetry(operation);
  }

  function sendAttempt(operation) {
    if (!operationIsCurrent(operation)) {
      return;
    }

    let result;
    try {
      result = report(
        operation.phase,
        operation.token.revision,
        operation.token.pageNumber,
        operation.token.settingsRevision,
        operation.token.displayEpoch,
        operation.token.layoutGeneration,
        operation.marqueeCount,
      );
    } catch {
      scheduleRetry(operation);
      return;
    }

    Promise.resolve(result).then(
      (response) => handleResponse(operation, response),
      () => scheduleRetry(operation),
    );
  }

  function sendWithRetry(phase, token, marqueeCount) {
    if (disposed || active?.token !== token) {
      return false;
    }

    if (active.operations.has(phase)) {
      return true;
    }

    const operation = {
      phase,
      token,
      marqueeCount,
      retryCount: 0,
      timer: null,
    };
    active.operations.set(phase, operation);
    sendAttempt(operation);
    return true;
  }

  function cancel() {
    if (!active) {
      return;
    }

    active.controller.abort();
    for (const operation of active.operations.values()) {
      if (operation.timer !== null) {
        clearTimer(operation.timer);
        operation.timer = null;
      }
    }
    active.operations.clear();
    active = null;
  }

  return Object.freeze({
    begin({ revision, pageNumber, settingsRevision, displayEpoch }) {
      if (disposed || layoutGeneration >= Number.MAX_SAFE_INTEGER) {
        return null;
      }

      cancel();
      layoutGeneration += 1;
      try {
        onLayoutGeneration(layoutGeneration);
      } catch {
        // sessionStorage 失敗不影響目前 Renderer 的單調記憶體計數。
      }

      const token = {
        revision,
        pageNumber,
        settingsRevision,
        displayEpoch,
        layoutGeneration,
      };
      active = {
        token,
        controller: new AbortController(),
        operations: new Map(),
        ready: false,
        effectsStarted: false,
        completed: false,
        completeRequested: false,
        liquidCompletionSatisfied: true,
        traversalSatisfied: false,
        traversalFinalized: false,
      };
      sendWithRetry('pending', token, undefined);
      return token;
    },

    ready(token, tracks, { liquidCompletionRequired = false } = {}) {
      if (disposed || active?.token !== token) {
        return false;
      }

      if (active.ready) {
        return true;
      }

      const uniqueTracks = [...new Set(tracks)];
      if (uniqueTracks.some(
        (track) => typeof track?.addEventListener !== 'function',
      ) || typeof liquidCompletionRequired !== 'boolean') {
        return false;
      }

      active.ready = true;
      active.traversalSatisfied = uniqueTracks.length === 0;
      active.liquidCompletionSatisfied = !liquidCompletionRequired;
      sendWithRetry('ready', token, uniqueTracks.length);

      if (uniqueTracks.length === 0) {
        return true;
      }

      const completedTracks = new Set();
      for (const track of uniqueTracks) {
        track.addEventListener(
          'animationiteration',
          () => {
            if (
              disposed ||
              active?.token !== token ||
              active.completed
            ) {
              return;
            }

            completedTracks.add(track);
            if (completedTracks.size !== uniqueTracks.length) {
              return;
            }

            active.completed = true;
            active.traversalSatisfied = true;
            requestCompletion(token);
          },
          { signal: active.controller.signal },
        );
      }

      return true;
    },

    /** 酒液 Renderer 已畫出同一 layout 的精確 100% 終幀。 */
    liquidComplete(tokenOrRevision, layoutGeneration = null) {
      const tokenMatches = Boolean(
        active && (
          active.token === tokenOrRevision ||
          (
            Number.isSafeInteger(tokenOrRevision) &&
            active.token.revision === tokenOrRevision &&
            active.token.layoutGeneration === layoutGeneration
          )
        )
      );
      if (disposed || !tokenMatches || !active.ready) {
        return false;
      }

      if (active.liquidCompletionSatisfied) {
        return true;
      }

      active.liquidCompletionSatisfied = true;
      requestCompletion(active.token);
      return true;
    },

    cancel,

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      cancel();
    },
  });
}
