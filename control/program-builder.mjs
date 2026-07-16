/**
 * Control 端一般訊息清單與播放計畫建構器。
 *
 * 此模組只處理不可變資料與純計算，不接觸 DOM 或 IPC。Main Process
 * 仍會再次驗證同一組上限；這裡的驗證是為了讓使用者在送出前得到
 * 精確回饋，不是安全邊界。
 */

export const PLAYBACK_MODES = Object.freeze({
  FINITE: 'finite',
  CONTINUOUS: 'continuous',
});

export const PROGRAM_LIMITS = Object.freeze({
  MESSAGES_PER_PAGE: 3,
  MAX_MESSAGE_COUNT: 500,
  MAX_MESSAGE_CODE_POINTS: 10_000,
  MIN_PAGE_DURATION_SECONDS: 1,
  MAX_PAGE_DURATION_SECONDS: 3_600,
  MIN_ROUNDS: 1,
  MAX_ROUNDS: 999,
});

const MESSAGE_KEYS = Object.freeze(['message']);

function failure(field, message) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ field, message }),
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactMessageShape(item) {
  if (!isPlainObject(item)) {
    return false;
  }

  const keys = Object.keys(item);
  return (
    keys.length === MESSAGE_KEYS.length &&
    keys.every((key, index) => key === MESSAGE_KEYS[index]) &&
    typeof item.message === 'string'
  );
}

function countCodePoints(value) {
  let count = 0;

  for (const _character of value) {
    count += 1;
  }

  return count;
}

function validateAndCopyMessages(messages, { allowEmpty }) {
  if (!Array.isArray(messages)) {
    return failure('messages', '訊息清單格式不正確。');
  }

  if (!allowEmpty && messages.length === 0) {
    return failure('messages', '請至少加入一則訊息。');
  }

  if (messages.length > PROGRAM_LIMITS.MAX_MESSAGE_COUNT) {
    return failure(
      'messages',
      `訊息清單最多 ${PROGRAM_LIMITS.MAX_MESSAGE_COUNT} 則。`,
    );
  }

  let totalCodePoints = 0;
  const copiedMessages = [];

  for (const item of messages) {
    if (!hasExactMessageShape(item)) {
      return failure('messages', '每則訊息只能包含一個文字 message 欄位。');
    }

    if (item.message.length === 0) {
      return failure('messages', '訊息不得為空字串。');
    }

    totalCodePoints += countCodePoints(item.message);

    if (totalCodePoints > PROGRAM_LIMITS.MAX_MESSAGE_CODE_POINTS) {
      return failure(
        'messages',
        `所有訊息合計不得超過 ${PROGRAM_LIMITS.MAX_MESSAGE_CODE_POINTS} 個字元。`,
      );
    }

    copiedMessages.push(Object.freeze({ message: item.message }));
  }

  return Object.freeze({
    ok: true,
    messages: Object.freeze(copiedMessages),
  });
}

function parseBoundedInteger(value, minimum, maximum) {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;

  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

/** 以唯一的每頁上限計算頁數，避免 DOM adapter 複製分頁規則。 */
export function countPages(messageCount) {
  if (
    !Number.isSafeInteger(messageCount) ||
    messageCount < 0 ||
    messageCount > PROGRAM_LIMITS.MAX_MESSAGE_COUNT
  ) {
    throw new TypeError('messageCount 必須是允許範圍內的非負整數。');
  }

  return Math.ceil(messageCount / PROGRAM_LIMITS.MESSAGES_PER_PAGE);
}

/**
 * 把一則完整 message 追加到清單。文字不 trim、不正規化也不解析。
 */
export function appendMessage(messages, message) {
  if (typeof message !== 'string' || message.length === 0) {
    return failure('message', '請加入有內容的訊息。');
  }

  const current = validateAndCopyMessages(messages, { allowEmpty: true });

  if (!current.ok) {
    return current;
  }

  return validateAndCopyMessages(
    [...current.messages, { message }],
    { allowEmpty: true },
  );
}

/** 以不可變方式刪除清單中的指定訊息。 */
export function removeMessage(messages, index) {
  const current = validateAndCopyMessages(messages, { allowEmpty: true });

  if (
    !current.ok ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= current.messages.length
  ) {
    return failure('messages', '無法刪除指定的訊息。');
  }

  return validateAndCopyMessages(
    current.messages.filter((_item, itemIndex) => itemIndex !== index),
    { allowEmpty: true },
  );
}

/**
 * 建立 Main Process 可驗證的完整 program，並推算頁數與播放時間。
 *
 * 有限模式的最短總秒數＝頁數 × 每頁最短秒數 × 整輪次數。跑馬燈可能
 * 自動延長單頁，因此這只是下限試算，不會成為中途截斷 page 的 timer。
 */
export function buildProgram({
  messages,
  pageDurationSeconds,
  repeatMode,
  rounds,
}) {
  const copied = validateAndCopyMessages(messages, { allowEmpty: false });

  if (!copied.ok) {
    return copied;
  }

  const duration = parseBoundedInteger(
    pageDurationSeconds,
    PROGRAM_LIMITS.MIN_PAGE_DURATION_SECONDS,
    PROGRAM_LIMITS.MAX_PAGE_DURATION_SECONDS,
  );

  if (duration === null) {
    return failure(
      'pageDurationSeconds',
      `每頁秒數必須是 ${PROGRAM_LIMITS.MIN_PAGE_DURATION_SECONDS} 至 ${PROGRAM_LIMITS.MAX_PAGE_DURATION_SECONDS} 的整數。`,
    );
  }

  if (!Object.values(PLAYBACK_MODES).includes(repeatMode)) {
    return failure('repeat', '請選擇有效的播放模式。');
  }

  let repeat;

  if (repeatMode === PLAYBACK_MODES.FINITE) {
    const parsedRounds = parseBoundedInteger(
      rounds,
      PROGRAM_LIMITS.MIN_ROUNDS,
      PROGRAM_LIMITS.MAX_ROUNDS,
    );

    if (parsedRounds === null) {
      return failure(
        'rounds',
        `整輪顯示次數必須是 ${PROGRAM_LIMITS.MIN_ROUNDS} 至 ${PROGRAM_LIMITS.MAX_ROUNDS} 的整數。`,
      );
    }

    repeat = Object.freeze({
      mode: PLAYBACK_MODES.FINITE,
      rounds: parsedRounds,
    });
  } else {
    repeat = Object.freeze({ mode: PLAYBACK_MODES.CONTINUOUS });
  }

  const pageCount = countPages(copied.messages.length);
  const secondsPerRound = pageCount * duration;
  const totalSeconds = repeat.mode === PLAYBACK_MODES.FINITE
    ? secondsPerRound * repeat.rounds
    : null;
  const summary = Object.freeze({
    messageCount: copied.messages.length,
    pageCount,
    secondsPerRound,
    totalSeconds,
  });
  const program = Object.freeze({
    messages: copied.messages,
    pageDurationSeconds: duration,
    repeat,
  });

  return Object.freeze({ ok: true, program, summary });
}

/** 將有限秒數轉成簡潔中文；null 代表持續顯示。 */
export function formatDuration(durationSeconds) {
  if (durationSeconds === null) {
    return '持續顯示';
  }

  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new TypeError('durationSeconds 必須是非負整數或 null。');
  }

  const hours = Math.floor(durationSeconds / 3_600);
  const minutes = Math.floor((durationSeconds % 3_600) / 60);
  const seconds = durationSeconds % 60;
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours} 小時`);
  }

  if (minutes > 0) {
    parts.push(`${minutes} 分`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds} 秒`);
  }

  return parts.join(' ');
}
