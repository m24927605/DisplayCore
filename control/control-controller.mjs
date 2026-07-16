import { acceptPresentationSnapshot } from './presentation-state.mjs';

const CONNECTION_ERROR = '無法連接主程序，請重新啟動 DisplayCore。';
const INVALID_RESPONSE_ERROR = '主程序回傳無效資料，請重新啟動 DisplayCore。';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readResponse(response) {
  if (!isPlainObject(response)) {
    return { kind: 'invalid' };
  }

  if (response.ok === true && Object.hasOwn(response, 'data')) {
    return { kind: 'success', snapshot: response.data };
  }

  if (
    response.ok === false &&
    isPlainObject(response.error) &&
    typeof response.error.message === 'string' &&
    response.error.message.length > 0
  ) {
    return { kind: 'application-error', message: response.error.message };
  }

  return { kind: 'invalid' };
}

/**
 * 建立不接觸 DOM 的 Control 操作控制器。
 *
 * api 是 preload 暴露的最小權限 bridge；view 是 Renderer 的 DOM adapter。
 * 將兩者注入可讓啟動競態、錯誤 envelope 與防重送在 Node 測試中驗證。
 *
 * @param {object} dependencies
 * @param {object} dependencies.api
 * @param {object} dependencies.view
 */
export function createControlController({ api, view }) {
  let latestRevision = -1;
  let busy = false;
  let started = false;
  let disposed = false;
  let unsubscribe = null;

  function applySnapshot(candidate) {
    const result = acceptPresentationSnapshot(latestRevision, candidate);

    if (!result.accepted) {
      return false;
    }

    latestRevision = result.snapshot.revision;
    view.renderPresentation(result.snapshot);
    return true;
  }

  function handleResponse(response) {
    const result = readResponse(response);

    if (result.kind === 'application-error') {
      view.renderError(result.message);
      return false;
    }

    if (result.kind !== 'success') {
      view.renderError(INVALID_RESPONSE_ERROR);
      return false;
    }

    // 先用 -1 驗證結構；若只是比 event 舊，仍代表本次 IPC 已成功。
    const validSnapshot = acceptPresentationSnapshot(-1, result.snapshot);

    if (!validSnapshot.accepted) {
      view.renderError(INVALID_RESPONSE_ERROR);
      return false;
    }

    applySnapshot(validSnapshot.snapshot);
    return true;
  }

  async function runMutation(operation, successMessage) {
    if (busy || disposed) {
      return false;
    }

    // 必須在第一個 await 前設定，雙擊或連續 Enter 才不會送出兩次 IPC。
    busy = true;
    view.setBusy(true);

    try {
      const response = await operation();

      if (!handleResponse(response)) {
        return false;
      }

      view.renderStatus(successMessage);
      return true;
    } catch {
      view.renderError(CONNECTION_ERROR);
      return false;
    } finally {
      busy = false;
      view.setBusy(false);
    }
  }

  return Object.freeze({
    /** 先訂閱 event，再取得啟動 snapshot，防止初始化期間遺失更新。 */
    async start() {
      if (started || disposed) {
        return false;
      }

      started = true;

      try {
        unsubscribe = api.onPresentationChanged((snapshot) => {
          if (!disposed) {
            applySnapshot(snapshot);
          }
        });

        if (typeof unsubscribe !== 'function') {
          unsubscribe = null;
          throw new TypeError('訂閱未回傳解除函式。');
        }

        const response = await api.getPresentation();

        if (!handleResponse(response)) {
          return false;
        }

        view.renderStatus('控制介面已就緒。');
        return true;
      } catch {
        view.renderError(CONNECTION_ERROR);
        return false;
      }
    },

    /** @param {{message: string, layout: string}} presentation */
    showPresentation(presentation, successMessage = '訊息已顯示。') {
      return runMutation(
        () => api.showMessage(presentation.message, presentation.layout),
        successMessage,
      );
    },

    clearPresentation() {
      return runMutation(
        () => api.clearMessage(),
        '顯示畫面已清除。',
      );
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}
