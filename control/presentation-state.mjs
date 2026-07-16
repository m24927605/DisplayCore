const ALLOWED_LAYOUTS = new Set(['single-line', 'fill-screen']);
const ALLOWED_MODES = new Set(['blank', 'page', 'emergency']);
const SNAPSHOT_KEYS = Object.freeze([
  'contentRevision',
  'layout',
  'messages',
  'mode',
  'pageCount',
  'pageDurationSeconds',
  'pageNumber',
  'revision',
  'roundNumber',
  'totalRounds',
]);
const MESSAGE_KEYS = Object.freeze(['message']);
const MESSAGES_PER_PAGE = 3;
const MAX_ACTIVE_MESSAGES = 500;
const MAX_PAGE_COUNT = Math.ceil(MAX_ACTIVE_MESSAGES / MESSAGES_PER_PAGE);
const MAX_TOTAL_CODE_POINTS = 10_000;
const MAX_ROUNDS = 999;

/** 僅接受 structured-clone 後的普通資料物件，拒絕陣列與自定 prototype。 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function isValidMessages(messages) {
  if (!Array.isArray(messages) || messages.length > MAX_ACTIVE_MESSAGES) {
    return false;
  }

  let codePoints = 0;

  for (const item of messages) {
    if (
      !hasExactKeys(item, MESSAGE_KEYS) ||
      typeof item.message !== 'string' ||
      item.message.length === 0
    ) {
      return false;
    }

    for (const _character of item.message) {
      codePoints += 1;

      if (codePoints > MAX_TOTAL_CODE_POINTS) {
        return false;
      }
    }
  }

  return true;
}

function hasNullPlaybackMetadata(snapshot) {
  return (
    snapshot.pageDurationSeconds === null &&
    snapshot.pageNumber === null &&
    snapshot.pageCount === null &&
    snapshot.roundNumber === null &&
    snapshot.totalRounds === null
  );
}

function isValidPageMetadata(snapshot) {
  const hasContinuousRepeat =
    snapshot.roundNumber === null && snapshot.totalRounds === null;
  const hasFiniteRepeat =
    Number.isSafeInteger(snapshot.roundNumber) &&
    Number.isSafeInteger(snapshot.totalRounds) &&
    snapshot.roundNumber >= 1 &&
    snapshot.totalRounds <= MAX_ROUNDS &&
    snapshot.totalRounds >= snapshot.roundNumber;

  return (
    snapshot.layout === 'single-line' &&
    snapshot.messages.length >= 1 &&
    Number.isSafeInteger(snapshot.pageDurationSeconds) &&
    snapshot.pageDurationSeconds >= 1 &&
    snapshot.pageDurationSeconds <= 3_600 &&
    Number.isSafeInteger(snapshot.pageNumber) &&
    Number.isSafeInteger(snapshot.pageCount) &&
    snapshot.pageCount >= 1 &&
    snapshot.pageCount <= MAX_PAGE_COUNT &&
    snapshot.pageCount === Math.ceil(
      snapshot.messages.length / MESSAGES_PER_PAGE,
    ) &&
    snapshot.pageNumber >= 1 &&
    snapshot.pageNumber <= snapshot.pageCount &&
    (hasContinuousRepeat || hasFiniteRepeat)
  );
}

function isValidSnapshot(snapshot) {
  if (
    !hasExactKeys(snapshot, SNAPSHOT_KEYS) ||
    !ALLOWED_MODES.has(snapshot.mode) ||
    !ALLOWED_LAYOUTS.has(snapshot.layout) ||
    !isValidMessages(snapshot.messages) ||
    !Number.isSafeInteger(snapshot.contentRevision) ||
    snapshot.contentRevision < 0 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0
  ) {
    return false;
  }

  if (snapshot.mode === 'blank') {
    return (
      snapshot.layout === 'single-line' &&
      snapshot.messages.length === 0 &&
      hasNullPlaybackMetadata(snapshot)
    );
  }

  if (snapshot.mode === 'emergency') {
    return (
      snapshot.layout === 'fill-screen' &&
      snapshot.messages.length === 1 &&
      hasNullPlaybackMetadata(snapshot)
    );
  }

  return isValidPageMetadata(snapshot);
}

/**
 * 驗證 Main v2 snapshot，並只接受單調增加的 revision。
 * 回傳 messages 深層副本，避免 Renderer 之外的物件稍後改寫目前狀態。
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
      mode: candidate.mode,
      messages: candidate.messages.map(({ message }) => ({ message })),
      layout: candidate.layout,
      pageDurationSeconds: candidate.pageDurationSeconds,
      pageNumber: candidate.pageNumber,
      pageCount: candidate.pageCount,
      roundNumber: candidate.roundNumber,
      totalRounds: candidate.totalRounds,
      revision: candidate.revision,
      contentRevision: candidate.contentRevision,
    },
  };
}
