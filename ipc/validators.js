'use strict';

const {
  MESSAGE_ALIGNMENTS,
  PAGE_PROGRESS_PHASES,
  PLAYBACK_MODES,
} = require('./channels');
const { validateConfig } = require('../config/config-schema');

// 所有限制都由 Main 再驗證，Renderer 的欄位狀態不能視為安全邊界。
const MESSAGES_PER_PAGE = 3;
const MAX_MESSAGE_COUNT = 500;
const MAX_MESSAGE_CODE_POINTS = 10_000;
const MIN_PAGE_DURATION_SECONDS = 1;
const MAX_PAGE_DURATION_SECONDS = 3_600;
const MAX_CYCLE_COUNT = 999;

const PROGRAM_KEYS = Object.freeze([
  'expectedContentRevision',
  'messages',
  'pageDurationSeconds',
  'repeat',
]);
const CLEAR_PRESENTATION_KEYS = Object.freeze(['expectedContentRevision']);
const MESSAGE_KEYS = Object.freeze(['alignment', 'message']);
const EMERGENCY_KEYS = Object.freeze(['code']);
const SAVE_SETTINGS_KEYS = Object.freeze(['config', 'expectedRevision']);
const PAGE_PROGRESS_KEYS = Object.freeze([
  'displayEpoch',
  'layoutGeneration',
  'pageNumber',
  'phase',
  'revision',
  'settingsRevision',
]);
const READY_PAGE_PROGRESS_KEYS = Object.freeze([
  'displayEpoch',
  'layoutGeneration',
  'marqueeCount',
  'pageNumber',
  'phase',
  'revision',
  'settingsRevision',
]);
const EMERGENCY_CODES = new Set(['555', '888']);

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

function validationFailure(message, field) {
  const error = {
    code: 'VALIDATION_FAILED',
    message,
  };

  if (field) {
    error.field = field;
  }

  return { ok: false, error };
}

function validateMessages(messages) {
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > MAX_MESSAGE_COUNT
  ) {
    return validationFailure(
      `messages 必須包含 1 至 ${MAX_MESSAGE_COUNT} 則訊息。`,
      'messages',
    );
  }

  let totalCodePoints = 0;
  const copiedMessages = [];

  for (const item of messages) {
    if (
      !hasExactKeys(item, MESSAGE_KEYS) ||
      typeof item.message !== 'string' ||
      !Object.values(MESSAGE_ALIGNMENTS).includes(item.alignment)
    ) {
      return validationFailure(
        '每則訊息必須包含完整 message 與允許的 alignment。',
        'messages',
      );
    }

    if (item.message.length === 0) {
      return validationFailure('message 不得為空字串。', 'messages');
    }

    for (const _character of item.message) {
      totalCodePoints += 1;

      if (totalCodePoints > MAX_MESSAGE_CODE_POINTS) {
        return validationFailure(
          `所有 message 合計不得超過 ${MAX_MESSAGE_CODE_POINTS} 個字元。`,
          'messages',
        );
      }
    }

    copiedMessages.push({
      message: item.message,
      alignment: item.alignment,
    });
  }

  return { ok: true, value: copiedMessages };
}

function validateRepeat(repeat) {
  if (!isPlainObject(repeat) || typeof repeat.mode !== 'string') {
    return validationFailure('repeat 格式不正確。', 'repeat');
  }

  if (repeat.mode === PLAYBACK_MODES.CONTINUOUS) {
    if (!hasExactKeys(repeat, ['mode'])) {
      return validationFailure(
        '持續模式不可包含整輪次數。',
        'repeat',
      );
    }

    return { ok: true, value: { mode: PLAYBACK_MODES.CONTINUOUS } };
  }

  if (repeat.mode === PLAYBACK_MODES.FINITE) {
    if (
      !hasExactKeys(repeat, ['mode', 'rounds']) ||
      !Number.isSafeInteger(repeat.rounds) ||
      repeat.rounds < 1 ||
      repeat.rounds > MAX_CYCLE_COUNT
    ) {
      return validationFailure(
        `整輪顯示次數必須是 1 至 ${MAX_CYCLE_COUNT} 的整數。`,
        'repeat',
      );
    }

    return {
      ok: true,
      value: { mode: PLAYBACK_MODES.FINITE, rounds: repeat.rounds },
    };
  }

  return validationFailure('repeat mode 不在允許清單中。', 'repeat');
}

function validateExpectedContentRevision(expectedContentRevision) {
  if (
    !Number.isSafeInteger(expectedContentRevision) ||
    expectedContentRevision < 0
  ) {
    return validationFailure(
      '螢幕內容版本必須是非負整數。',
      'expectedContentRevision',
    );
  }

  return { ok: true, value: expectedContentRevision };
}

/** 驗證並深層複製一般訊息播放清單。 */
function validateStartProgramPayload(payload) {
  if (!hasExactKeys(payload, PROGRAM_KEYS)) {
    return validationFailure('一般顯示資料包含缺少或不允許的欄位。');
  }

  const messages = validateMessages(payload.messages);

  if (!messages.ok) {
    return messages;
  }

  const expectedContentRevision = validateExpectedContentRevision(
    payload.expectedContentRevision,
  );

  if (!expectedContentRevision.ok) {
    return expectedContentRevision;
  }

  if (
    !Number.isSafeInteger(payload.pageDurationSeconds) ||
    payload.pageDurationSeconds < MIN_PAGE_DURATION_SECONDS ||
    payload.pageDurationSeconds > MAX_PAGE_DURATION_SECONDS
  ) {
    return validationFailure(
      `每頁秒數必須是 ${MIN_PAGE_DURATION_SECONDS} 至 ${MAX_PAGE_DURATION_SECONDS} 的整數。`,
      'pageDurationSeconds',
    );
  }

  const repeat = validateRepeat(payload.repeat);

  if (!repeat.ok) {
    return repeat;
  }

  return {
    ok: true,
    value: {
      messages: messages.value,
      pageDurationSeconds: payload.pageDurationSeconds,
      repeat: repeat.value,
      expectedContentRevision: expectedContentRevision.value,
    },
  };
}

/** 清除也必須攜帶操作者目前看到的內容版本，避免 stale click。 */
function validateClearPresentationPayload(payload) {
  if (!hasExactKeys(payload, CLEAR_PRESENTATION_KEYS)) {
    return validationFailure('清除畫面資料包含缺少或不允許的欄位。');
  }

  const expectedContentRevision = validateExpectedContentRevision(
    payload.expectedContentRevision,
  );

  return expectedContentRevision.ok
    ? {
      ok: true,
      value: { expectedContentRevision: expectedContentRevision.value },
    }
    : expectedContentRevision;
}

/** 555／888 使用獨立指令，不允許一般 message 假冒緊急操作。 */
function validateEmergencyPayload(payload) {
  if (
    !hasExactKeys(payload, EMERGENCY_KEYS) ||
    typeof payload.code !== 'string' ||
    !EMERGENCY_CODES.has(payload.code)
  ) {
    return validationFailure('不支援的滿屏代碼。', 'code');
  }

  return { ok: true, value: { code: payload.code } };
}

/** 設定儲存必須攜帶完整 config 與操作者所見的 revision。 */
function validateSaveSettingsPayload(payload) {
  if (!hasExactKeys(payload, SAVE_SETTINGS_KEYS)) {
    return validationFailure('設定儲存資料包含缺少或不允許的欄位。');
  }

  if (
    !Number.isSafeInteger(payload.expectedRevision) ||
    payload.expectedRevision < 0
  ) {
    return validationFailure(
      '設定狀態版本必須是非負整數。',
      'expectedRevision',
    );
  }

  const config = validateConfig(payload.config);

  if (!config.ok) {
    return config;
  }

  return {
    ok: true,
    value: {
      config: config.value,
      expectedRevision: payload.expectedRevision,
    },
  };
}

/**
 * 驗證 Display 對目前版面的受限回報。
 *
 * Renderer 不得攜帶 next page、時間或 message；Main 只接受足以判斷目前
 * layout 是否 ready，以及所有跑馬燈是否已各完成一輪的最小欄位。
 */
function validatePageProgressPayload(payload) {
  const ready = payload?.phase === PAGE_PROGRESS_PHASES.READY;
  const expectedKeys = ready
    ? READY_PAGE_PROGRESS_KEYS
    : PAGE_PROGRESS_KEYS;

  if (!hasExactKeys(payload, expectedKeys)) {
    return validationFailure('頁面進度資料包含缺少或不允許的欄位。');
  }

  if (!Object.values(PAGE_PROGRESS_PHASES).includes(payload.phase)) {
    return validationFailure('頁面進度階段不在允許清單中。', 'phase');
  }

  if (!Number.isSafeInteger(payload.displayEpoch) || payload.displayEpoch < 1) {
    return validationFailure(
      'Display 可見世代必須是正整數。',
      'displayEpoch',
    );
  }

  if (!Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    return validationFailure('頁面狀態版本必須是非負整數。', 'revision');
  }

  if (
    !Number.isSafeInteger(payload.settingsRevision) ||
    payload.settingsRevision < 0
  ) {
    return validationFailure(
      '顯示設定版本必須是非負整數。',
      'settingsRevision',
    );
  }

  const maximumPageNumber = Math.ceil(
    MAX_MESSAGE_COUNT / MESSAGES_PER_PAGE,
  );
  if (
    !Number.isSafeInteger(payload.pageNumber) ||
    payload.pageNumber < 1 ||
    payload.pageNumber > maximumPageNumber
  ) {
    return validationFailure(
      `頁碼必須是 1 至 ${maximumPageNumber} 的整數。`,
      'pageNumber',
    );
  }

  if (
    !Number.isSafeInteger(payload.layoutGeneration) ||
    payload.layoutGeneration < 1
  ) {
    return validationFailure(
      '版面版本必須是正整數。',
      'layoutGeneration',
    );
  }

  if (
    ready &&
    (!Number.isSafeInteger(payload.marqueeCount) ||
      payload.marqueeCount < 0 ||
      payload.marqueeCount > MESSAGES_PER_PAGE)
  ) {
    return validationFailure(
      `跑馬燈列數必須是 0 至 ${MESSAGES_PER_PAGE} 的整數。`,
      'marqueeCount',
    );
  }

  return { ok: true, value: { ...payload } };
}

module.exports = {
  MAX_CYCLE_COUNT,
  MAX_MESSAGE_CODE_POINTS,
  MAX_MESSAGE_COUNT,
  MAX_PAGE_DURATION_SECONDS,
  MESSAGES_PER_PAGE,
  MIN_PAGE_DURATION_SECONDS,
  validateClearPresentationPayload,
  validateEmergencyPayload,
  validatePageProgressPayload,
  validateSaveSettingsPayload,
  validateStartProgramPayload,
};
