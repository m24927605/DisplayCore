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
const SNAPSHOT_KEYS = Object.freeze([
  'config',
  'defaults',
  'notice',
  'revision',
]);
const NOTICE_KEYS = Object.freeze(['code', 'message']);
const MANAGED_LOGO_PATH = /^logos\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const MANAGED_STANDBY_BACKGROUND_PATH =
  /^standby-backgrounds\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const OPAQUE_HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DECIMAL_NUMBER = /^\d+(?:\.\d{1,2})?$/;
const INTEGER_NUMBER = /^\d+$/;
const INVALID_USER_CONFIG_NOTICE = Object.freeze({
  code: 'INVALID_USER_CONFIG',
  message: '使用者設定檔無法讀取，目前使用安全預設值；儲存後可修復。',
});

export const SETTINGS_LIMITS = Object.freeze({
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

const PLAYBACK_MODES = Object.freeze(['finite', 'continuous']);

const RENDER_RESOLUTIONS = Object.freeze([
  'auto',
  '1366x768',
  '1600x900',
  '1920x1080',
  '2560x1440',
  '3840x2160',
]);

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

function failure(field, message) {
  return { ok: false, error: { field, message } };
}

function freezeConfig(config) {
  for (const section of [
    'logo',
    'appearance',
    'dateTime',
    'emergency',
    'marquee',
    'playback',
    'display',
    'standby',
  ]) {
    Object.freeze(config[section]);
  }

  return Object.freeze(config);
}

/** Renderer 鏡像驗證只改善 UX；Main 仍是唯一安全邊界。 */
function normalizeConfig(candidate) {
  if (!hasExactKeys(candidate, CONFIG_KEYS) || candidate.configVersion !== 5) {
    return failure('settings', '設定資料格式不正確。');
  }

  if (
    !hasExactKeys(candidate.logo, ['enabled', 'path']) ||
    typeof candidate.logo.enabled !== 'boolean'
  ) {
    return failure('logo', 'Logo 設定格式不正確。');
  }

  if (
    candidate.logo.path !== null &&
    (
      typeof candidate.logo.path !== 'string' ||
      candidate.logo.path.length === 0 ||
      candidate.logo.path.length > SETTINGS_LIMITS.MAX_LOGO_PATH_LENGTH ||
      CONTROL_CHARACTERS.test(candidate.logo.path) ||
      !MANAGED_LOGO_PATH.test(candidate.logo.path)
    )
  ) {
    return failure('logo.path', '請重新選擇有效的 Logo 圖片。');
  }

  if (candidate.logo.enabled && candidate.logo.path === null) {
    return failure('logo.path', '啟用 Logo 前請先選擇圖片。');
  }

  const standby = candidate.standby;
  if (!hasExactKeys(standby, ['backgroundImagePath'])) {
    return failure('standby', '待機畫面設定格式不正確。');
  }

  if (
    standby.backgroundImagePath !== null &&
    (
      typeof standby.backgroundImagePath !== 'string' ||
      standby.backgroundImagePath.length === 0 ||
      standby.backgroundImagePath.length >
        SETTINGS_LIMITS.MAX_STANDBY_BACKGROUND_PATH_LENGTH ||
      CONTROL_CHARACTERS.test(standby.backgroundImagePath) ||
      !MANAGED_STANDBY_BACKGROUND_PATH.test(standby.backgroundImagePath)
    )
  ) {
    return failure(
      'standby.backgroundImagePath',
      '請重新選擇有效的待機背景圖片。',
    );
  }

  const appearance = candidate.appearance;

  if (
    !hasExactKeys(appearance, [
      'backgroundColor',
      'fontColor',
      'fontFamily',
      'fontSizePercent',
      'lineSpacingPercent',
      'minimumFontSizeRem',
    ])
  ) {
    return failure('appearance', '外觀設定格式不正確。');
  }

  for (const field of ['backgroundColor', 'fontColor']) {
    if (
      typeof appearance[field] !== 'string' ||
      !OPAQUE_HEX_COLOR.test(appearance[field])
    ) {
      return failure(
        `appearance.${field}`,
        '請輸入六位十六進位色碼，例如 #FFFFFF。',
      );
    }
  }

  if (
    typeof appearance.fontFamily !== 'string' ||
    appearance.fontFamily.trim().length === 0 ||
    appearance.fontFamily.length > SETTINGS_LIMITS.MAX_FONT_FAMILY_LENGTH ||
    CONTROL_CHARACTERS.test(appearance.fontFamily)
  ) {
    return failure('appearance.fontFamily', '請選擇有效字型。');
  }

  for (const [field, minimum, maximum] of [
    [
      'fontSizePercent',
      SETTINGS_LIMITS.MINIMUM_FONT_SIZE_PERCENT,
      SETTINGS_LIMITS.MAXIMUM_FONT_SIZE_PERCENT,
    ],
    [
      'lineSpacingPercent',
      SETTINGS_LIMITS.MINIMUM_LINE_SPACING_PERCENT,
      SETTINGS_LIMITS.MAXIMUM_LINE_SPACING_PERCENT,
    ],
  ]) {
    const value = appearance[field];
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum ||
      value % SETTINGS_LIMITS.PERCENTAGE_STEP !== 0
    ) {
      return failure(
        `appearance.${field}`,
        `${field === 'fontSizePercent' ? '字體大小' : '行距'}必須介於 ${minimum}% 至 ${maximum}%，並以 5% 遞增。`,
      );
    }
  }

  const emergency = candidate.emergency;
  if (
    !hasExactKeys(emergency, [
      'inspectionBackgroundColor',
      'releaseBackgroundColor',
    ])
  ) {
    return failure('emergency', '滿屏代碼設定格式不正確。');
  }

  for (const field of [
    'inspectionBackgroundColor',
    'releaseBackgroundColor',
  ]) {
    if (
      typeof emergency[field] !== 'string' ||
      !OPAQUE_HEX_COLOR.test(emergency[field])
    ) {
      return failure(
        `emergency.${field}`,
        '請輸入六位十六進位色碼，例如 #000000。',
      );
    }
  }

  const minimumFontSizeRem = appearance.minimumFontSizeRem;
  const stepRatio = minimumFontSizeRem / SETTINGS_LIMITS.FONT_SIZE_STEP_REM;

  if (
    !Number.isFinite(minimumFontSizeRem) ||
    minimumFontSizeRem < SETTINGS_LIMITS.MINIMUM_FONT_SIZE_REM ||
    minimumFontSizeRem > SETTINGS_LIMITS.MAXIMUM_FONT_SIZE_REM ||
    Math.abs(stepRatio - Math.round(stepRatio)) > Number.EPSILON * 16
  ) {
    return failure(
      'appearance.minimumFontSizeRem',
      '最小字級必須介於 1 至 12 rem，並以 0.25 rem 遞增。',
    );
  }

  const dateTime = candidate.dateTime;

  if (
    !hasExactKeys(dateTime, ['enabled', 'offsetSeconds']) ||
    typeof dateTime.enabled !== 'boolean' ||
    !Number.isSafeInteger(dateTime.offsetSeconds) ||
    dateTime.offsetSeconds < SETTINGS_LIMITS.MINIMUM_CLOCK_OFFSET_SECONDS ||
    dateTime.offsetSeconds > SETTINGS_LIMITS.MAXIMUM_CLOCK_OFFSET_SECONDS
  ) {
    return failure('dateTime', '日期時間設定格式不正確。');
  }

  if (
    !hasExactKeys(candidate.marquee, ['enabled']) ||
    typeof candidate.marquee.enabled !== 'boolean'
  ) {
    return failure('marquee.enabled', '跑馬燈設定格式不正確。');
  }

  const playback = candidate.playback;

  if (
    !hasExactKeys(playback, [
      'pageDurationSeconds',
      'repeatMode',
      'roundCount',
    ])
  ) {
    return failure('playback', '訊息播放設定格式不正確。');
  }

  if (
    !Number.isSafeInteger(playback.pageDurationSeconds) ||
    playback.pageDurationSeconds < SETTINGS_LIMITS.MINIMUM_PAGE_DURATION_SECONDS ||
    playback.pageDurationSeconds > SETTINGS_LIMITS.MAXIMUM_PAGE_DURATION_SECONDS
  ) {
    return failure(
      'playback.pageDurationSeconds',
      '每頁顯示秒數必須是 1 至 3600 的整數。',
    );
  }

  if (!PLAYBACK_MODES.includes(playback.repeatMode)) {
    return failure('playback.repeatMode', '請選擇有效的播放方式。');
  }

  if (
    !Number.isSafeInteger(playback.roundCount) ||
    playback.roundCount < SETTINGS_LIMITS.MINIMUM_ROUND_COUNT ||
    playback.roundCount > SETTINGS_LIMITS.MAXIMUM_ROUND_COUNT
  ) {
    return failure(
      'playback.roundCount',
      '整輪顯示次數必須是 1 至 999 的整數。',
    );
  }

  const display = candidate.display;
  const isAuto = display?.selectionMode === 'auto';
  const isManual = display?.selectionMode === 'manual';

  if (
    !hasExactKeys(display, [
      'defaultDisplayId',
      'fullscreen',
      'renderResolution',
      'selectionMode',
    ]) ||
    typeof display.fullscreen !== 'boolean' ||
    !RENDER_RESOLUTIONS.includes(display.renderResolution) ||
    (!isAuto && !isManual) ||
    (isAuto && display.defaultDisplayId !== null) ||
    (isManual &&
      (!Number.isSafeInteger(display.defaultDisplayId) ||
        display.defaultDisplayId < 0))
  ) {
    return failure('display', '輸出螢幕設定格式不正確。');
  }

  return {
    ok: true,
    value: freezeConfig({
      configVersion: 5,
      logo: {
        enabled: candidate.logo.enabled,
        path: candidate.logo.path,
      },
      standby: {
        backgroundImagePath: standby.backgroundImagePath,
      },
      appearance: {
        backgroundColor: appearance.backgroundColor.toUpperCase(),
        fontFamily: appearance.fontFamily,
        fontColor: appearance.fontColor.toUpperCase(),
        fontSizePercent: appearance.fontSizePercent,
        lineSpacingPercent: appearance.lineSpacingPercent,
        minimumFontSizeRem,
      },
      dateTime: {
        enabled: dateTime.enabled,
        offsetSeconds: dateTime.offsetSeconds,
      },
      emergency: {
        inspectionBackgroundColor:
          emergency.inspectionBackgroundColor.toUpperCase(),
        releaseBackgroundColor:
          emergency.releaseBackgroundColor.toUpperCase(),
      },
      marquee: { enabled: candidate.marquee.enabled },
      playback: {
        pageDurationSeconds: playback.pageDurationSeconds,
        repeatMode: playback.repeatMode,
        roundCount: playback.roundCount,
      },
      display: {
        selectionMode: display.selectionMode,
        defaultDisplayId: display.defaultDisplayId,
        fullscreen: display.fullscreen,
        renderResolution: display.renderResolution,
      },
    }),
  };
}

export function acceptSettingsSnapshot(candidate) {
  if (
    !hasExactKeys(candidate, SNAPSHOT_KEYS) ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0
  ) {
    return { ok: false };
  }

  const config = normalizeConfig(candidate.config);
  const defaults = normalizeConfig(candidate.defaults);

  if (!config.ok || !defaults.ok) {
    return { ok: false };
  }

  let notice = null;

  if (candidate.notice !== null) {
    if (
      !hasExactKeys(candidate.notice, NOTICE_KEYS) ||
      candidate.notice.code !== INVALID_USER_CONFIG_NOTICE.code ||
      candidate.notice.message !== INVALID_USER_CONFIG_NOTICE.message
    ) {
      return { ok: false };
    }

    notice = Object.freeze({ ...candidate.notice });
  }

  return {
    ok: true,
    snapshot: Object.freeze({
      config: config.value,
      defaults: defaults.value,
      revision: candidate.revision,
      notice,
    }),
  };
}

export function buildSettingsDraft({
  baseline,
  logoEnabled,
  logoPath,
  standbyBackgroundImagePath,
  backgroundColor,
  fontFamily,
  fontColor,
  minimumFontSizeRem,
  fontSizePercent,
  lineSpacingPercent,
  inspectionBackgroundColor,
  releaseBackgroundColor,
  dateTimeEnabled,
  dateTimeOffsetSeconds,
  marqueeEnabled,
  pageDurationSeconds,
  repeatMode,
  roundCount,
  renderResolution,
}) {
  const baselineResult = normalizeConfig(baseline);

  if (!baselineResult.ok) {
    return failure('settings', '設定基準資料無效，請重新開啟設定。');
  }

  if (
    typeof minimumFontSizeRem !== 'string' ||
    !DECIMAL_NUMBER.test(minimumFontSizeRem)
  ) {
    return failure(
      'appearance.minimumFontSizeRem',
      '最小字級必須是一般十進位數字。',
    );
  }

  for (const [value, field, label] of [
    [fontSizePercent, 'appearance.fontSizePercent', '字體大小'],
    [lineSpacingPercent, 'appearance.lineSpacingPercent', '行距'],
    [pageDurationSeconds, 'playback.pageDurationSeconds', '每頁顯示秒數'],
    [roundCount, 'playback.roundCount', '整輪顯示次數'],
  ]) {
    if (typeof value !== 'string' || !INTEGER_NUMBER.test(value)) {
      return failure(field, `${label}必須是一般十進位整數。`);
    }
  }

  const result = normalizeConfig({
    configVersion: 5,
    logo: { enabled: logoEnabled, path: logoPath },
    standby: { backgroundImagePath: standbyBackgroundImagePath },
    appearance: {
      backgroundColor,
      fontFamily,
      fontColor,
      minimumFontSizeRem: Number(minimumFontSizeRem),
      fontSizePercent: Number(fontSizePercent),
      lineSpacingPercent: Number(lineSpacingPercent),
    },
    dateTime: {
      enabled: dateTimeEnabled,
      offsetSeconds: dateTimeOffsetSeconds,
    },
    emergency: {
      inspectionBackgroundColor,
      releaseBackgroundColor,
    },
    marquee: { enabled: marqueeEnabled },
    playback: {
      pageDurationSeconds: Number(pageDurationSeconds),
      repeatMode,
      roundCount: Number(roundCount),
    },
    // 輸出螢幕仍自動管理；Control 只可修改邏輯排版解析度。
    display: {
      ...baselineResult.value.display,
      renderResolution,
    },
  });

  return result.ok ? { ok: true, config: result.value } : result;
}

export function settingsEqual(first, second) {
  const firstResult = normalizeConfig(first);
  const secondResult = normalizeConfig(second);

  return (
    firstResult.ok &&
    secondResult.ok &&
    JSON.stringify(firstResult.value) === JSON.stringify(secondResult.value)
  );
}
