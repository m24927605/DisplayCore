'use strict';

const { PLAYBACK_MODES } = require('./channels');
const { validateConfig } = require('../config/config-schema');

// 所有限制都由 Main 再驗證，Renderer 的欄位狀態不能視為安全邊界。
const MESSAGES_PER_PAGE = 5;
const MAX_MESSAGE_COUNT = 500;
const MAX_MESSAGE_CODE_POINTS = 10_000;
const MIN_PAGE_DURATION_SECONDS = 1;
const MAX_PAGE_DURATION_SECONDS = 3_600;
const MAX_CYCLE_COUNT = 999;

const PROGRAM_KEYS = Object.freeze([
  'messages',
  'pageDurationSeconds',
  'repeat',
]);
const MESSAGE_KEYS = Object.freeze(['message']);
const EMERGENCY_KEYS = Object.freeze(['code']);
const SAVE_SETTINGS_KEYS = Object.freeze(['config', 'expectedRevision']);
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
    if (!hasExactKeys(item, MESSAGE_KEYS) || typeof item.message !== 'string') {
      return validationFailure(
        '每則訊息只能包含一個文字 message 欄位。',
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

    copiedMessages.push({ message: item.message });
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

/** 驗證並深層複製一般訊息播放清單。 */
function validateStartProgramPayload(payload) {
  if (!hasExactKeys(payload, PROGRAM_KEYS)) {
    return validationFailure('一般顯示資料包含缺少或不允許的欄位。');
  }

  const messages = validateMessages(payload.messages);

  if (!messages.ok) {
    return messages;
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
    },
  };
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

module.exports = {
  MAX_CYCLE_COUNT,
  MAX_MESSAGE_CODE_POINTS,
  MAX_MESSAGE_COUNT,
  MAX_PAGE_DURATION_SECONDS,
  MESSAGES_PER_PAGE,
  MIN_PAGE_DURATION_SECONDS,
  validateEmergencyPayload,
  validateSaveSettingsPayload,
  validateStartProgramPayload,
};
