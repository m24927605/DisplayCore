import { acceptDisplaySnapshot } from './presentation-state.mjs';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 建立不接觸 DOM 的 Display 唯讀控制器。
 *
 * 啟動順序固定為先訂閱再 GET；所有錯誤都保留最後有效畫面，不把本機錯誤
 * 文字送上電視。Display 不持有 page timer，也沒有任何 mutation API。
 */
export function createDisplayController({ api, view }) {
  let latestRevision = -1;
  let started = false;
  let disposed = false;
  let unsubscribe = null;

  function applySnapshot(candidate) {
    if (disposed) {
      return false;
    }

    const result = acceptDisplaySnapshot(latestRevision, candidate);

    if (!result.accepted) {
      return false;
    }

    latestRevision = result.snapshot.revision;
    view.renderPresentation(result.snapshot);
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

    // 較新 event 已套用時，舊 GET snapshot 被忽略但啟動仍可視為成功。
    const structurallyValid = acceptDisplaySnapshot(-1, response.data);

    if (!structurallyValid.accepted) {
      return false;
    }

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
        unsubscribe = api.onPresentationChanged((snapshot) => {
          applySnapshot(snapshot);
        });

        if (typeof unsubscribe !== 'function') {
          unsubscribe = null;
          return false;
        }

        const response = await api.getPresentation();
        return applyResponse(response);
      } catch {
        // 訂閱若已建立便繼續保留；後續 event 仍可恢復畫面。
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
