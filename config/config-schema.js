'use strict';

const CONFIG_VERSION = 5;

const PLAYBACK_MODES = Object.freeze({
  FINITE: 'finite',
  CONTINUOUS: 'continuous',
});

const DISPLAY_SELECTION_MODES = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

const CONFIG_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 65_536,
  MAX_LOGO_PATH_LENGTH: 128,
  MAX_STANDBY_BACKGROUND_PATH_LENGTH: 128,
  MAX_FONT_FAMILY_LENGTH: 200,
  MINIMUM_FONT_SIZE_REM: 1,
  MAXIMUM_FONT_SIZE_REM: 12,
  FONT_SIZE_STEP_REM: 0.25,
  MINIMUM_FONT_SIZE_PERCENT: 50,
  MAXIMUM_FONT_SIZE_PERCENT: 200,
  MINIMUM_LINE_SPACING_PERCENT: 0,
  MAXIMUM_LINE_SPACING_PERCENT: 300,
  PERCENTAGE_STEP: 5,
  MINIMUM_CLOCK_OFFSET_SECONDS: -43_199,
  MAXIMUM_CLOCK_OFFSET_SECONDS: 43_200,
  MINIMUM_PAGE_DURATION_SECONDS: 1,
  MAXIMUM_PAGE_DURATION_SECONDS: 3_600,
  MINIMUM_ROUND_COUNT: 1,
  MAXIMUM_ROUND_COUNT: 999,
});

const RENDER_RESOLUTIONS = Object.freeze([
  'auto',
  '1366x768',
  '1600x900',
  '1920x1080',
  '2560x1440',
  '3840x2160',
]);

const CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'emergency',
  'logo',
  'marquee',
  'playback',
  'standby',
]);
const LOGO_KEYS = Object.freeze(['enabled', 'path']);
const STANDBY_KEYS = Object.freeze(['backgroundImagePath']);
const APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'fontSizePercent',
  'lineSpacingPercent',
  'minimumFontSizeRem',
]);
const DATE_TIME_KEYS = Object.freeze(['enabled', 'offsetSeconds']);
const EMERGENCY_KEYS = Object.freeze([
  'inspectionBackgroundColor',
  'releaseBackgroundColor',
]);
const MARQUEE_KEYS = Object.freeze(['enabled']);
const PLAYBACK_KEYS = Object.freeze([
  'pageDurationSeconds',
  'repeatMode',
  'roundCount',
]);
const DISPLAY_KEYS = Object.freeze([
  'defaultDisplayId',
  'fullscreen',
  'renderResolution',
  'selectionMode',
]);
const OPAQUE_HEX_COLOR = /^#[0-9a-f]{6}$/i;
// LogoImporter 只會產生 SHA-256 前 24 位的小寫識別；設定不得自行命名檔案。
const MANAGED_LOGO_PATH = /^logos\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const MANAGED_STANDBY_BACKGROUND_PATH =
  /^standby-backgrounds\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
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

function validateStandby(standby) {
  if (!hasExactKeys(standby, STANDBY_KEYS)) {
    return validationFailure('待機背景設定格式不正確。', 'standby');
  }

  if (standby.backgroundImagePath === null) {
    return { ok: true, value: { backgroundImagePath: null } };
  }

  if (
    typeof standby.backgroundImagePath !== 'string' ||
    standby.backgroundImagePath.length === 0 ||
    standby.backgroundImagePath.length >
      CONFIG_LIMITS.MAX_STANDBY_BACKGROUND_PATH_LENGTH ||
    CONTROL_CHARACTERS.test(standby.backgroundImagePath) ||
    !MANAGED_STANDBY_BACKGROUND_PATH.test(standby.backgroundImagePath)
  ) {
    return validationFailure(
      '待機背景必須是已匯入 DisplayCore 的 PNG、JPEG 或 WebP 圖片。',
      'standby.backgroundImagePath',
    );
  }

  return {
    ok: true,
    value: { backgroundImagePath: standby.backgroundImagePath },
  };
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

  for (const [field, minimum, maximum] of [
    [
      'fontSizePercent',
      CONFIG_LIMITS.MINIMUM_FONT_SIZE_PERCENT,
      CONFIG_LIMITS.MAXIMUM_FONT_SIZE_PERCENT,
    ],
    [
      'lineSpacingPercent',
      CONFIG_LIMITS.MINIMUM_LINE_SPACING_PERCENT,
      CONFIG_LIMITS.MAXIMUM_LINE_SPACING_PERCENT,
    ],
  ]) {
    const value = appearance[field];

    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum ||
      value % CONFIG_LIMITS.PERCENTAGE_STEP !== 0
    ) {
      return validationFailure(
        `${field === 'fontSizePercent' ? '字體大小' : '行距'}必須是 ${minimum}% 至 ${maximum}% 的整數，並以 ${CONFIG_LIMITS.PERCENTAGE_STEP}% 遞增。`,
        `appearance.${field}`,
      );
    }
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
      fontSizePercent: appearance.fontSizePercent,
      lineSpacingPercent: appearance.lineSpacingPercent,
      minimumFontSizeRem,
    },
  };
}

function validateDateTime(dateTime) {
  if (
    !hasExactKeys(dateTime, DATE_TIME_KEYS) ||
    typeof dateTime.enabled !== 'boolean' ||
    !Number.isSafeInteger(dateTime.offsetSeconds) ||
    dateTime.offsetSeconds < CONFIG_LIMITS.MINIMUM_CLOCK_OFFSET_SECONDS ||
    dateTime.offsetSeconds > CONFIG_LIMITS.MAXIMUM_CLOCK_OFFSET_SECONDS
  ) {
    return validationFailure('日期時間設定格式不正確。', 'dateTime');
  }

  return {
    ok: true,
    value: {
      enabled: dateTime.enabled,
      offsetSeconds: dateTime.offsetSeconds,
    },
  };
}

function validateEmergency(emergency) {
  if (!hasExactKeys(emergency, EMERGENCY_KEYS)) {
    return validationFailure('滿屏代碼設定格式不正確。', 'emergency');
  }

  for (const field of EMERGENCY_KEYS) {
    if (
      typeof emergency[field] !== 'string' ||
      !OPAQUE_HEX_COLOR.test(emergency[field])
    ) {
      return validationFailure(
        '滿屏背景顏色必須使用六位十六進位格式，例如 #000000。',
        `emergency.${field}`,
      );
    }
  }

  return {
    ok: true,
    value: {
      inspectionBackgroundColor:
        emergency.inspectionBackgroundColor.toUpperCase(),
      releaseBackgroundColor: emergency.releaseBackgroundColor.toUpperCase(),
    },
  };
}

function validateMarquee(marquee) {
  if (!hasExactKeys(marquee, MARQUEE_KEYS) || typeof marquee.enabled !== 'boolean') {
    return validationFailure('跑馬燈設定格式不正確。', 'marquee');
  }

  return { ok: true, value: { enabled: marquee.enabled } };
}

function validatePlayback(playback) {
  if (
    !hasExactKeys(playback, PLAYBACK_KEYS) ||
    !Number.isSafeInteger(playback.pageDurationSeconds) ||
    playback.pageDurationSeconds < CONFIG_LIMITS.MINIMUM_PAGE_DURATION_SECONDS ||
    playback.pageDurationSeconds > CONFIG_LIMITS.MAXIMUM_PAGE_DURATION_SECONDS ||
    !Object.values(PLAYBACK_MODES).includes(playback.repeatMode) ||
    !Number.isSafeInteger(playback.roundCount) ||
    playback.roundCount < CONFIG_LIMITS.MINIMUM_ROUND_COUNT ||
    playback.roundCount > CONFIG_LIMITS.MAXIMUM_ROUND_COUNT
  ) {
    return validationFailure('訊息播放設定格式不正確。', 'playback');
  }

  return {
    ok: true,
    value: {
      pageDurationSeconds: playback.pageDurationSeconds,
      repeatMode: playback.repeatMode,
      roundCount: playback.roundCount,
    },
  };
}

function validateDisplay(display) {
  if (
    !hasExactKeys(display, DISPLAY_KEYS) ||
    typeof display.fullscreen !== 'boolean' ||
    !Object.values(DISPLAY_SELECTION_MODES).includes(display.selectionMode) ||
    !RENDER_RESOLUTIONS.includes(display.renderResolution)
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
      renderResolution: display.renderResolution,
    },
  };
}

function freezeConfig(config) {
  for (const section of [
    'logo',
    'appearance',
    'dateTime',
    'emergency',
    'marquee',
    'playback',
    'standby',
    'display',
  ]) {
    Object.freeze(config[section]);
  }

  return Object.freeze(config);
}

/** 驗證、正規化並深層複製完整的 canonical config v5。 */
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
  const standby = validateStandby(candidate.standby);
  const appearance = validateAppearance(candidate.appearance);
  const dateTime = validateDateTime(candidate.dateTime);
  const emergency = validateEmergency(candidate.emergency);
  const marquee = validateMarquee(candidate.marquee);
  const playback = validatePlayback(candidate.playback);
  const display = validateDisplay(candidate.display);

  for (const result of [
    logo,
    standby,
    appearance,
    dateTime,
    emergency,
    marquee,
    playback,
    display,
  ]) {
    if (!result.ok) {
      return result;
    }
  }

  return {
    ok: true,
    value: freezeConfig({
      configVersion: CONFIG_VERSION,
      logo: logo.value,
      standby: standby.value,
      appearance: appearance.value,
      dateTime: dateTime.value,
      emergency: emergency.value,
      marquee: marquee.value,
      playback: playback.value,
      display: display.value,
    }),
  };
}

module.exports = {
  CONFIG_LIMITS,
  CONFIG_VERSION,
  DISPLAY_SELECTION_MODES,
  PLAYBACK_MODES,
  RENDER_RESOLUTIONS,
  validateConfig,
};
