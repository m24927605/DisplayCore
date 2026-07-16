import { acceptDisplaySettingsSnapshot } from './settings-state.mjs';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Display 的唯讀設定控制器。
 *
 * 設定與 presentation 使用獨立 revision；啟動固定先訂閱再 GET，IPC 失敗
 * 也保留訂閱，後續成功的設定事件可自行恢復。
 */
export function createDisplaySettingsController({ api, view }) {
  let latestRevision = -1;
  let started = false;
  let disposed = false;
  let unsubscribe = null;

  function applySnapshot(candidate) {
    if (disposed) {
      return false;
    }

    const result = acceptDisplaySettingsSnapshot(latestRevision, candidate);

    if (!result.accepted) {
      return false;
    }

    latestRevision = result.snapshot.revision;
    view.applyDisplaySettings(result.snapshot);
    return true;
  }

  function applyResponse(response) {
    if (
      !isPlainObject(response) ||
      response.ok !== true ||
      !Object.hasOwn(response, 'data')
    ) {
      return false;
    }

    const structurallyValid = acceptDisplaySettingsSnapshot(-1, response.data);

    if (!structurallyValid.accepted) {
      return false;
    }

    // 若 event 已先送達，較舊 GET 會被忽略，但啟動資料本身仍視為有效。
    applySnapshot(structurallyValid.snapshot);
    return true;
  }

  return Object.freeze({
    async start() {
      if (started || disposed) {
        return false;
      }

      started = true;

      try {
        unsubscribe = api.onSettingsChanged((snapshot) => {
          applySnapshot(snapshot);
        });

        if (typeof unsubscribe !== 'function') {
          unsubscribe = null;
          return false;
        }

        return applyResponse(await api.getSettings());
      } catch {
        return false;
      }
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

