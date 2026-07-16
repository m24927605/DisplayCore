const ALLOWED_LAYOUTS = new Set(['single-line', 'fill-screen']);
const SNAPSHOT_KEYS = Object.freeze(['layout', 'message', 'revision']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    return false;
  }

  const keys = Object.keys(snapshot).sort();

  return (
    keys.length === SNAPSHOT_KEYS.length &&
    keys.every((key, index) => key === SNAPSHOT_KEYS[index]) &&
    typeof snapshot.message === 'string' &&
    ALLOWED_LAYOUTS.has(snapshot.layout) &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision >= 0
  );
}

/**
 * 驗證 Main 傳入的 presentation，並拒絕比目前 revision 更舊的狀態。
 *
 * event 與啟動 snapshot 可能交錯到達；相同 revision 已代表同一狀態處理
 * 完成，因此不再重畫，也避免衝突內容冒用既有 revision。回傳獨立副本，
 * 避免外部物件之後被修改。
 *
 * @param {number} currentRevision
 * @param {unknown} candidate
 */
export function acceptPresentationSnapshot(currentRevision, candidate) {
  if (
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < -1 ||
    !isValidSnapshot(candidate) ||
    candidate.revision <= currentRevision
  ) {
    return { accepted: false };
  }

  return {
    accepted: true,
    snapshot: {
      message: candidate.message,
      layout: candidate.layout,
      revision: candidate.revision,
    },
  };
}
