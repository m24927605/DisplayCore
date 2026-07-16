import {
  acceptOutputSnapshot,
  validateOutputSnapshot,
} from './output-state.mjs';

const CONNECTION_ERROR =
  '無法取得輸出狀態，將保留最近一次有效資料。';
const INVALID_OUTPUT_ERROR =
  '主程序回傳無效的輸出狀態，將保留最近一次有效資料。';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readSuccessEnvelope(response) {
  try {
    if (!isPlainObject(response)) {
      return null;
    }

    const keys = Object.keys(response).sort();

    if (
      keys.length !== 2 ||
      keys[0] !== 'data' ||
      keys[1] !== 'ok' ||
      response.ok !== true
    ) {
      return null;
    }

    return response.data;
  } catch {
    return null;
  }
}

function hasRequiredDependencies(api, view) {
  return (
    api !== null &&
    typeof api === 'object' &&
    typeof api.getOutputStatus === 'function' &&
    typeof api.onOutputStatusChanged === 'function' &&
    view !== null &&
    typeof view === 'object' &&
    typeof view.renderOutputStatus === 'function' &&
    typeof view.renderOutputError === 'function'
  );
}

/**
 * 建立 Control Renderer 的輸出狀態控制器。
 *
 * bridge 只提供 getOutputStatus／onOutputStatusChanged；controller 不接觸
 * ipcRenderer。任何錯誤都只附加本機提示，不會清除最後有效狀態。
 */
export function createOutputController({ api, view } = {}) {
  if (!hasRequiredDependencies(api, view)) {
    throw new TypeError('輸出狀態控制器缺少必要相依。');
  }

  let currentSnapshot = null;
  let started = false;
  let disposed = false;
  let unsubscribe = null;

  function renderError(message) {
    if (!disposed) {
      view.renderOutputError(message);
    }
  }

  function applyValidatedSnapshot(validation) {
    const result = acceptOutputSnapshot(
      currentSnapshot,
      validation.snapshot,
    );

    if (!result.accepted) {
      return false;
    }

    currentSnapshot = result.snapshot;
    view.renderOutputStatus(result.snapshot, result.ux);
    return true;
  }

  function handleEvent(candidate) {
    if (disposed) {
      return;
    }

    const validation = validateOutputSnapshot(candidate);

    if (!validation.ok) {
      renderError(INVALID_OUTPUT_ERROR);
      return;
    }

    // 合法但較舊或重複的事件只需忽略；這是正常的非同步競態。
    applyValidatedSnapshot(validation);
  }

  return Object.freeze({
    /** 先訂閱再 GET，初始化期間的事件才不會落在競態縫隙中。 */
    async start() {
      if (started || disposed) {
        return false;
      }

      started = true;

      try {
        unsubscribe = api.onOutputStatusChanged(handleEvent);

        if (typeof unsubscribe !== 'function') {
          unsubscribe = null;
          throw new TypeError('輸出狀態訂閱未回傳解除函式。');
        }
      } catch {
        renderError(CONNECTION_ERROR);
        return false;
      }

      let response;

      try {
        response = await api.getOutputStatus();
      } catch {
        renderError(CONNECTION_ERROR);
        return false;
      }

      if (disposed) {
        return false;
      }

      const candidate = readSuccessEnvelope(response);
      const validation = validateOutputSnapshot(candidate);

      if (!validation.ok) {
        renderError(INVALID_OUTPUT_ERROR);
        return false;
      }

      // GET 可能比初始化期間收到的 event 舊；格式有效即代表讀取成功。
      applyValidatedSnapshot(validation);
      return true;
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
