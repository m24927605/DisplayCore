const SNAPSHOT_KEYS = Object.freeze([
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
const MAX_PAGE_MESSAGES = 3;
const MAX_PAGE_COUNT = 167;
const MAX_CYCLE_COUNT = 999;
const MAX_TOTAL_CODE_POINTS = 10_000;

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
  if (!Array.isArray(messages) || messages.length > MAX_PAGE_MESSAGES) {
    return false;
  }

  let totalCodePoints = 0;

  for (const item of messages) {
    if (
      !hasExactKeys(item, MESSAGE_KEYS) ||
      typeof item.message !== 'string' ||
      item.message.length === 0
    ) {
      return false;
    }

    for (const _character of item.message) {
      totalCodePoints += 1;

      if (totalCodePoints > MAX_TOTAL_CODE_POINTS) {
        return false;
      }
    }
  }

  return true;
}

function hasNullMetadata(snapshot) {
  return (
    snapshot.pageDurationSeconds === null &&
    snapshot.pageNumber === null &&
    snapshot.pageCount === null &&
    snapshot.roundNumber === null &&
    snapshot.totalRounds === null
  );
}

function isValidPage(snapshot) {
  const continuous =
    snapshot.roundNumber === null && snapshot.totalRounds === null;
  const finite =
    Number.isSafeInteger(snapshot.roundNumber) &&
    Number.isSafeInteger(snapshot.totalRounds) &&
    snapshot.roundNumber >= 1 &&
    snapshot.totalRounds >= snapshot.roundNumber &&
    snapshot.totalRounds <= MAX_CYCLE_COUNT;

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
    snapshot.pageNumber >= 1 &&
    snapshot.pageNumber <= snapshot.pageCount &&
    (continuous || finite)
  );
}

function isValidSnapshot(snapshot) {
  if (
    !hasExactKeys(snapshot, SNAPSHOT_KEYS) ||
    !isValidMessages(snapshot.messages) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0
  ) {
    return false;
  }

  if (snapshot.mode === 'blank') {
    return (
      snapshot.layout === 'single-line' &&
      snapshot.messages.length === 0 &&
      hasNullMetadata(snapshot)
    );
  }

  if (snapshot.mode === 'emergency') {
    return (
      snapshot.layout === 'fill-screen' &&
      snapshot.messages.length === 1 &&
      hasNullMetadata(snapshot)
    );
  }

  return snapshot.mode === 'page' && isValidPage(snapshot);
}

/** 驗證並深層複製 Main 發給 Display 的唯讀頁面。 */
export function acceptDisplaySnapshot(currentRevision, candidate) {
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
    },
  };
}
