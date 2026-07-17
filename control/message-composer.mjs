/**
 * Control Window 可選擇的標準動作。
 *
 * 這些值只供 Control 組合 message；Main 與 Display 不會解析動作語意。
 */
export const ACTIONS = Object.freeze({
  GO_TO_LOBBY: 'go-to-lobby',
  LOBBY_CODE: 'lobby-code',
  CUSTOM: 'custom',
});

/** Control 明確提供的滿屏代碼。 */
export const EMERGENCY_CODES = Object.freeze({
  INSPECTION: '555',
  CLEAR: '888',
});

/** 可一鍵顯示的固定營運訊息；Main 與 Display 仍只把它們視為一般文字。 */
export const OPERATION_MESSAGES = Object.freeze({
  QUIET: '請輕聲細語',
});

const FIXED_ACTION_TEXT = Object.freeze({
  [ACTIONS.GO_TO_LOBBY]: '請至前廳',
  [ACTIONS.LOBBY_CODE]: '前廳000',
});

function failure(field, message) {
  return {
    ok: false,
    error: { field, message },
  };
}

/**
 * 將 Control 表單資料組合成單一 presentation。
 *
 * 編號／花名及自定義內容皆不 trim、不正規化、不解析 HTML，確保送入
 * IPC 的 message 與管理人員輸入完全一致。
 *
 * @param {object} input
 * @param {unknown} input.recipient 編號或花名
 * @param {unknown} input.action 動作代碼
 * @param {unknown} input.customText 自定義文字
 */
export function composeMessage({ recipient, action, customText }) {
  if (typeof recipient !== 'string') {
    return failure('recipient', '編號或花名必須是文字。');
  }

  if (typeof customText !== 'string') {
    return failure('customText', '自定義內容必須是文字。');
  }

  if (!Object.values(ACTIONS).includes(action)) {
    return failure('action', '請選擇有效的動作指令。');
  }

  let actionText;

  if (action === ACTIONS.CUSTOM) {
    if (customText.length === 0) {
      return failure('customText', '請輸入自定義內容。');
    }

    actionText = customText;
  } else {
    if (recipient.length === 0) {
      return failure('recipient', '請輸入編號或花名。');
    }

    actionText = FIXED_ACTION_TEXT[action];
  }

  return {
    ok: true,
    presentation: {
      message: `${recipient}${actionText}`,
      alignment: 'left',
      layout: 'single-line',
    },
  };
}

/**
 * 將受支援的警示代碼建立為滿屏 presentation。
 *
 * Display 只依 layout 排版，不需要知道 555／888 的業務含義。
 *
 * @param {unknown} emergencyCode
 */
export function createEmergencyPresentation(emergencyCode) {
  if (!Object.values(EMERGENCY_CODES).includes(emergencyCode)) {
    return failure('emergencyCode', '不支援的滿屏代碼。');
  }

  return {
    ok: true,
    presentation: {
      message: emergencyCode,
      alignment: 'center',
      layout: 'fill-screen',
    },
  };
}
