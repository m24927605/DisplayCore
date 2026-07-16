'use strict';

const CONFIG_VERSION = 1;

const DISPLAY_SELECTION_MODES = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

const CONFIG_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 65_536,
  MAX_LOGO_PATH_LENGTH: 128,
  MAX_FONT_FAMILY_LENGTH: 200,
  MINIMUM_FONT_SIZE_REM: 1,
  MAXIMUM_FONT_SIZE_REM: 12,
  FONT_SIZE_STEP_REM: 0.25,
});

const CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'logo',
  'marquee',
]);
const LOGO_KEYS = Object.freeze(['enabled', 'path']);
const APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'minimumFontSizeRem',
]);
const DATE_TIME_KEYS = Object.freeze(['enabled', 'hour12', 'locale']);
const MARQUEE_KEYS = Object.freeze(['enabled']);
const DISPLAY_KEYS = Object.freeze([
  'defaultDisplayId',
  'fullscreen',
  'selectionMode',
]);
const OPAQUE_HEX_COLOR = /^#[0-9a-f]{6}$/i;
// LogoImporter 只會產生 SHA-256 前 24 位的小寫識別；設定不得自行命名檔案。
const MANAGED_LOGO_PATH = /^logos\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

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

  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function validationFailure(message, field) {
  return {
    ok: false,
    error: {
      code: 'VALIDATION_FAILED',
      message,
      ...(field ? { field } : {}),
    },
  };
}

function validateLogo(logo) {
  if (!hasExactKeys(logo, LOGO_KEYS) || typeof logo.enabled !== 'boolean') {
    return validationFailure('Logo 設定格式不正確。', 'logo');
  }

  if (logo.path === null) {
    return logo.enabled
      ? validationFailure('啟用 Logo 前必須設定圖片路徑。', 'logo.path')
      : { ok: true, value: { enabled: false, path: null } };
  }

  if (
    typeof logo.path !== 'string' ||
    logo.path.length === 0 ||
    logo.path.length > CONFIG_LIMITS.MAX_LOGO_PATH_LENGTH ||
    CONTROL_CHARACTERS.test(logo.path) ||
    !MANAGED_LOGO_PATH.test(logo.path)
  ) {
    return validationFailure(
      'Logo 必須是已匯入 DisplayCore 的 PNG、JPEG 或 WebP 圖片。',
      'logo.path',
    );
  }

  return { ok: true, value: { enabled: logo.enabled, path: logo.path } };
}

function validateAppearance(appearance) {
  if (!hasExactKeys(appearance, APPEARANCE_KEYS)) {
    return validationFailure('外觀設定格式不正確。', 'appearance');
  }

  for (const field of ['backgroundColor', 'fontColor']) {
    if (
      typeof appearance[field] !== 'string' ||
      !OPAQUE_HEX_COLOR.test(appearance[field])
    ) {
      return validationFailure(
        '顏色必須使用六位十六進位格式，例如 #FFFFFF。',
        `appearance.${field}`,
      );
    }
  }

  if (
    typeof appearance.fontFamily !== 'string' ||
    appearance.fontFamily.trim().length === 0 ||
    appearance.fontFamily.length > CONFIG_LIMITS.MAX_FONT_FAMILY_LENGTH ||
    CONTROL_CHARACTERS.test(appearance.fontFamily)
  ) {
    return validationFailure(
      `字型名稱必須是 1 至 ${CONFIG_LIMITS.MAX_FONT_FAMILY_LENGTH} 個字元。`,
      'appearance.fontFamily',
    );
  }

  const minimumFontSizeRem = appearance.minimumFontSizeRem;
  const stepRatio = minimumFontSizeRem / CONFIG_LIMITS.FONT_SIZE_STEP_REM;

  if (
    !Number.isFinite(minimumFontSizeRem) ||
    minimumFontSizeRem < CONFIG_LIMITS.MINIMUM_FONT_SIZE_REM ||
    minimumFontSizeRem > CONFIG_LIMITS.MAXIMUM_FONT_SIZE_REM ||
    Math.abs(stepRatio - Math.round(stepRatio)) > Number.EPSILON * 16
  ) {
    return validationFailure(
      `最小字級必須是 ${CONFIG_LIMITS.MINIMUM_FONT_SIZE_REM} 至 ${CONFIG_LIMITS.MAXIMUM_FONT_SIZE_REM} rem，並以 ${CONFIG_LIMITS.FONT_SIZE_STEP_REM} rem 遞增。`,
      'appearance.minimumFontSizeRem',
    );
  }

  return {
    ok: true,
    value: {
      backgroundColor: appearance.backgroundColor.toUpperCase(),
      fontFamily: appearance.fontFamily,
      fontColor: appearance.fontColor.toUpperCase(),
      minimumFontSizeRem,
    },
  };
}

function validateDateTime(dateTime) {
  if (
    !hasExactKeys(dateTime, DATE_TIME_KEYS) ||
    typeof dateTime.enabled !== 'boolean' ||
    typeof dateTime.hour12 !== 'boolean' ||
    typeof dateTime.locale !== 'string' ||
    dateTime.locale.length === 0 ||
    dateTime.locale.length > 35 ||
    CONTROL_CHARACTERS.test(dateTime.locale)
  ) {
    return validationFailure('日期時間設定格式不正確。', 'dateTime');
  }

  let canonicalLocales;

  try {
    canonicalLocales = Intl.getCanonicalLocales(dateTime.locale);
  } catch {
    return validationFailure('日期時間語系格式不正確。', 'dateTime.locale');
  }

  if (canonicalLocales.length !== 1) {
    return validationFailure('日期時間語系格式不正確。', 'dateTime.locale');
  }

  return {
    ok: true,
    value: {
      enabled: dateTime.enabled,
      locale: canonicalLocales[0],
      hour12: dateTime.hour12,
    },
  };
}

function validateMarquee(marquee) {
  if (!hasExactKeys(marquee, MARQUEE_KEYS) || typeof marquee.enabled !== 'boolean') {
    return validationFailure('跑馬燈設定格式不正確。', 'marquee');
  }

  return { ok: true, value: { enabled: marquee.enabled } };
}

function validateDisplay(display) {
  if (
    !hasExactKeys(display, DISPLAY_KEYS) ||
    typeof display.fullscreen !== 'boolean' ||
    !Object.values(DISPLAY_SELECTION_MODES).includes(display.selectionMode)
  ) {
    return validationFailure('輸出螢幕設定格式不正確。', 'display');
  }

  if (
    display.selectionMode === DISPLAY_SELECTION_MODES.AUTO &&
    display.defaultDisplayId !== null
  ) {
    return validationFailure(
      '自動選擇螢幕時 defaultDisplayId 必須為 null。',
      'display.defaultDisplayId',
    );
  }

  if (
    display.selectionMode === DISPLAY_SELECTION_MODES.MANUAL &&
    (!Number.isSafeInteger(display.defaultDisplayId) ||
      display.defaultDisplayId < 0)
  ) {
    return validationFailure(
      '手動選擇螢幕時必須提供有效的螢幕 ID。',
      'display.defaultDisplayId',
    );
  }

  return {
    ok: true,
    value: {
      selectionMode: display.selectionMode,
      defaultDisplayId: display.defaultDisplayId,
      fullscreen: display.fullscreen,
    },
  };
}

function freezeConfig(config) {
  for (const section of ['logo', 'appearance', 'dateTime', 'marquee', 'display']) {
    Object.freeze(config[section]);
  }

  return Object.freeze(config);
}

/** 驗證、正規化並深層複製完整的 config v1。 */
function validateConfig(candidate) {
  if (!hasExactKeys(candidate, CONFIG_KEYS)) {
    return validationFailure('設定檔包含缺少或不允許的欄位。');
  }

  if (candidate.configVersion !== CONFIG_VERSION) {
    return validationFailure(
      `configVersion 必須是 ${CONFIG_VERSION}。`,
      'configVersion',
    );
  }

  const logo = validateLogo(candidate.logo);
  const appearance = validateAppearance(candidate.appearance);
  const dateTime = validateDateTime(candidate.dateTime);
  const marquee = validateMarquee(candidate.marquee);
  const display = validateDisplay(candidate.display);

  for (const result of [logo, appearance, dateTime, marquee, display]) {
    if (!result.ok) {
      return result;
    }
  }

  return {
    ok: true,
    value: freezeConfig({
      configVersion: CONFIG_VERSION,
      logo: logo.value,
      appearance: appearance.value,
      dateTime: dateTime.value,
      marquee: marquee.value,
      display: display.value,
    }),
  };
}

module.exports = {
  CONFIG_LIMITS,
  CONFIG_VERSION,
  DISPLAY_SELECTION_MODES,
  validateConfig,
};
