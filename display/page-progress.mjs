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
 * token 能進入 ready。若有多列跑馬燈，必須每一列都收到第一次
 * animationiteration 後才回報 complete。暫時 IPC 失敗會以有上限的退避
 * 間隔重試，換頁、refit 或 dispose 會取消所有舊重試。
 */
export function createPageProgressReporter({
  report,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
  initialLayoutGeneration = 0,
  onLayoutGeneration = () => {},
}) {
  if (
    typeof report !== 'function' ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function' ||
    typeof onLayoutGeneration !== 'function' ||
    !Number.isSafeInteger(initialLayoutGeneration) ||
    initialLayoutGeneration < 0 ||
    initialLayoutGeneration >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('頁面進度回報器參數不正確。');
  }

  let layoutGeneration = initialLayoutGeneration;
  let active = null;
  let disposed = false;

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
      if (operation.phase === 'ready') {
        active.readyAccepted = true;
        if (active.completeRequested) {
          sendWithRetry('complete', operation.token, undefined);
        }
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
        readyAccepted: false,
        completed: false,
        completeRequested: false,
      };
      sendWithRetry('pending', token, undefined);
      return token;
    },

    ready(token, tracks) {
      if (disposed || active?.token !== token) {
        return false;
      }

      if (active.ready) {
        return true;
      }

      const uniqueTracks = [...new Set(tracks)];
      if (uniqueTracks.some(
        (track) => typeof track?.addEventListener !== 'function',
      )) {
        return false;
      }

      active.ready = true;
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
            active.completeRequested = true;
            active.controller.abort();
            if (active.readyAccepted) {
              sendWithRetry('complete', token, undefined);
            }
          },
          { signal: active.controller.signal },
        );
      }

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
