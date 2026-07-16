'use strict';

const { PRESENTATION_LAYOUTS } = require('./channels');

// 防止一次 IPC 傳入極端大量文字耗盡 Main／Renderer 記憶體。
const MAX_MESSAGE_CODE_POINTS = 10_000;
const ALLOWED_LAYOUTS = new Set(Object.values(PRESENTATION_LAYOUTS));
const SHOW_MESSAGE_KEYS = Object.freeze(['layout', 'message']);

/**
 * @param {string} message
 * @returns {boolean}
 */
function isWithinMessageLimit(message) {
  let codePoints = 0;

  for (const _character of message) {
    codePoints += 1;

    if (codePoints > MAX_MESSAGE_CODE_POINTS) {
      return false;
    }
  }

  return true;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 建立可安全回傳 Renderer 的驗證錯誤，不含 payload 或內部例外資訊。
 *
 * @param {string} message
 * @param {string} [field]
 */
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

/**
 * 驗證 Control 顯示請求。
 *
 * message 不 trim、不正規化、不判斷編號、花名或 555／888，只做型別與
 * 純資源上限檢查。拒絕未知欄位，確保內容永遠不會被拆成 title 等欄位。
 *
 * @param {unknown} payload
 */
function validateShowMessagePayload(payload) {
  if (!isPlainObject(payload)) {
    return validationFailure('顯示資料必須是物件。');
  }

  const keys = Object.keys(payload).sort();

  if (
    keys.length !== SHOW_MESSAGE_KEYS.length ||
    keys.some((key, index) => key !== SHOW_MESSAGE_KEYS[index])
  ) {
    return validationFailure('顯示資料包含缺少或不允許的欄位。');
  }

  if (typeof payload.message !== 'string') {
    return validationFailure('message 必須是文字。', 'message');
  }

  if (!isWithinMessageLimit(payload.message)) {
    return validationFailure(
      `message 不得超過 ${MAX_MESSAGE_CODE_POINTS} 個字元。`,
      'message',
    );
  }

  if (!ALLOWED_LAYOUTS.has(payload.layout)) {
    return validationFailure('layout 不在允許清單中。', 'layout');
  }

  return {
    ok: true,
    value: {
      message: payload.message,
      layout: payload.layout,
    },
  };
}

module.exports = {
  MAX_MESSAGE_CODE_POINTS,
  validateShowMessagePayload,
};
