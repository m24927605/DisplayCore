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
  MINIMUM_LOGO_SIZE_PERCENT: 50,
  MAXIMUM_LOGO_SIZE_PERCENT: 1_000,
  MAX_STANDBY_BACKGROUND_PATH_LENGTH: 128,
  MAX_STANDBY_BACKGROUND_IMAGES: 20,
  MINIMUM_STANDBY_SLIDE_DURATION_SECONDS: 1,
  MAXIMUM_STANDBY_SLIDE_DURATION_SECONDS: 3_600,
  MAX_FONT_FAMILY_LENGTH: 200,
  MINIMUM_FONT_SIZE_REM: 1,
  MAXIMUM_FONT_SIZE_REM: 12,
  FONT_SIZE_STEP_REM: 0.25,
  MINIMUM_FONT_SIZE_PERCENT: 50,
  MAXIMUM_FONT_SIZE_PERCENT: 200,
  MINIMUM_STANDBY_CLOCK_SIZE_PERCENT: 50,
  MAXIMUM_STANDBY_CLOCK_SIZE_PERCENT: 300,
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
const STANDBY_BACKGROUND_MODES = Object.freeze(['fixed', 'slideshow']);
const MESSAGE_BACKGROUND_PRESETS = Object.freeze([
  'solid',
  'obsidian',
  'dark-marble',
  'walnut',
  'emerald-onyx',
]);
const PERCENTAGE_FIELD_LABELS = Object.freeze({
  fontSizePercent: '字體大小',
  lineSpacingPercent: '行距',
  standbyClockSizePercent: '待機時間大小',
});

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
  Object.freeze(config.standby.backgroundImagePaths);

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
  if (!hasExactKeys(candidate, CONFIG_KEYS) || candidate.configVersion !== 10) {
    return failure('settings', '設定資料格式不正確。');
  }

  if (
    !hasExactKeys(candidate.logo, ['enabled', 'path', 'sizePercent']) ||
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

  if (
    !Number.isSafeInteger(candidate.logo.sizePercent) ||
    candidate.logo.sizePercent < SETTINGS_LIMITS.MINIMUM_LOGO_SIZE_PERCENT ||
    candidate.logo.sizePercent > SETTINGS_LIMITS.MAXIMUM_LOGO_SIZE_PERCENT ||
    candidate.logo.sizePercent % SETTINGS_LIMITS.PERCENTAGE_STEP !== 0
  ) {
    return failure(
      'logo.sizePercent',
      'Logo 大小必須介於 50% 至 1000%，並以 5% 遞增。',
    );
  }

  const standby = candidate.standby;
  if (
    !hasExactKeys(standby, [
      'backgroundImagePaths',
      'backgroundMode',
      'slideDurationSeconds',
    ])
  ) {
    return failure('standby', '待機畫面設定格式不正確。');
  }

  if (
    !STANDBY_BACKGROUND_MODES.includes(standby.backgroundMode)
  ) {
    return failure('standby.backgroundMode', '請選擇有效的待機背景顯示方式。');
  }

  if (
    !Array.isArray(standby.backgroundImagePaths) ||
    standby.backgroundImagePaths.length >
      SETTINGS_LIMITS.MAX_STANDBY_BACKGROUND_IMAGES ||
    new Set(standby.backgroundImagePaths).size !==
      standby.backgroundImagePaths.length ||
    standby.backgroundImagePaths.some(
      (assetPath) =>
        typeof assetPath !== 'string' ||
        assetPath.length === 0 ||
        assetPath.length >
          SETTINGS_LIMITS.MAX_STANDBY_BACKGROUND_PATH_LENGTH ||
        CONTROL_CHARACTERS.test(assetPath) ||
        !MANAGED_STANDBY_BACKGROUND_PATH.test(assetPath),
    )
  ) {
    return failure(
      'standby.backgroundImagePaths',
      '請重新選擇有效且不重複的待機背景圖片（最多 20 張）。',
    );
  }

  if (
    !Number.isSafeInteger(standby.slideDurationSeconds) ||
    standby.slideDurationSeconds <
      SETTINGS_LIMITS.MINIMUM_STANDBY_SLIDE_DURATION_SECONDS ||
    standby.slideDurationSeconds >
      SETTINGS_LIMITS.MAXIMUM_STANDBY_SLIDE_DURATION_SECONDS
  ) {
    return failure(
      'standby.slideDurationSeconds',
      '每張背景顯示秒數必須是 1 至 3600 的整數。',
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
      'messageBackgroundPreset',
      'messageLiquidEffectEnabled',
      'minimumFontSizeRem',
      'standbyClockSizePercent',
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

  if (!MESSAGE_BACKGROUND_PRESETS.includes(
    appearance.messageBackgroundPreset,
  )) {
    return failure(
      'appearance.messageBackgroundPreset',
      '請選擇有效的訊息背景樣式。',
    );
  }

  if (typeof appearance.messageLiquidEffectEnabled !== 'boolean') {
    return failure(
      'appearance.messageLiquidEffectEnabled',
      '訊息字體倒酒效果開關格式不正確。',
    );
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
    [
      'standbyClockSizePercent',
      SETTINGS_LIMITS.MINIMUM_STANDBY_CLOCK_SIZE_PERCENT,
      SETTINGS_LIMITS.MAXIMUM_STANDBY_CLOCK_SIZE_PERCENT,
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
        `${PERCENTAGE_FIELD_LABELS[field]}必須介於 ${minimum}% 至 ${maximum}%，並以 5% 遞增。`,
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
      'controlDisplayId',
      'defaultDisplayId',
      'fullscreen',
      'renderResolution',
      'selectionMode',
    ]) ||
    typeof display.fullscreen !== 'boolean' ||
    !RENDER_RESOLUTIONS.includes(display.renderResolution) ||
    (!isAuto && !isManual) ||
    (isAuto &&
      (display.controlDisplayId !== null ||
        display.defaultDisplayId !== null)) ||
    (isManual &&
      (
        !Number.isSafeInteger(display.controlDisplayId) ||
        display.controlDisplayId < 0 ||
        !Number.isSafeInteger(display.defaultDisplayId) ||
        display.defaultDisplayId < 0 ||
        display.controlDisplayId === display.defaultDisplayId
      ))
  ) {
    return failure('display', '輸出螢幕設定格式不正確。');
  }

  return {
    ok: true,
    value: freezeConfig({
      configVersion: 10,
      logo: {
        enabled: candidate.logo.enabled,
        path: candidate.logo.path,
        sizePercent: candidate.logo.sizePercent,
      },
      standby: {
        backgroundMode: standby.backgroundMode,
        backgroundImagePaths: [...standby.backgroundImagePaths],
        slideDurationSeconds: standby.slideDurationSeconds,
      },
      appearance: {
        backgroundColor: appearance.backgroundColor.toUpperCase(),
        messageBackgroundPreset: appearance.messageBackgroundPreset,
        fontFamily: appearance.fontFamily,
        fontColor: appearance.fontColor.toUpperCase(),
        fontSizePercent: appearance.fontSizePercent,
        lineSpacingPercent: appearance.lineSpacingPercent,
        messageLiquidEffectEnabled: appearance.messageLiquidEffectEnabled,
        minimumFontSizeRem,
        standbyClockSizePercent: appearance.standbyClockSizePercent,
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
        controlDisplayId: display.controlDisplayId,
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
  logoSizePercent,
  standbyBackgroundMode,
  standbyBackgroundImagePaths,
  standbySlideDurationSeconds,
  backgroundColor,
  messageBackgroundPreset,
  fontFamily,
  fontColor,
  minimumFontSizeRem,
  fontSizePercent,
  standbyClockSizePercent,
  lineSpacingPercent,
  messageLiquidEffectEnabled,
  inspectionBackgroundColor,
  releaseBackgroundColor,
  dateTimeEnabled,
  dateTimeOffsetSeconds,
  marqueeEnabled,
  pageDurationSeconds,
  repeatMode,
  roundCount,
  controlDisplayId,
  defaultDisplayId,
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
    [logoSizePercent, 'logo.sizePercent', 'Logo 大小'],
    [
      standbySlideDurationSeconds,
      'standby.slideDurationSeconds',
      '每張背景顯示秒數',
    ],
    [fontSizePercent, 'appearance.fontSizePercent', '字體大小'],
    [
      standbyClockSizePercent,
      'appearance.standbyClockSizePercent',
      '待機時間大小',
    ],
    [lineSpacingPercent, 'appearance.lineSpacingPercent', '行距'],
    [pageDurationSeconds, 'playback.pageDurationSeconds', '每頁顯示秒數'],
    [roundCount, 'playback.roundCount', '整輪顯示次數'],
  ]) {
    if (typeof value !== 'string' || !INTEGER_NUMBER.test(value)) {
      return failure(field, `${label}必須是一般十進位整數。`);
    }
  }

  const controlUsesAuto = controlDisplayId === 'auto';
  const displayUsesAuto = defaultDisplayId === 'auto';
  let displayAssignment;

  if (controlUsesAuto && displayUsesAuto) {
    displayAssignment = {
      selectionMode: 'auto',
      controlDisplayId: null,
      defaultDisplayId: null,
    };
  } else if (controlUsesAuto !== displayUsesAuto) {
    return failure(
      'display.controlDisplayId',
      '請同時指定控制台與訊息螢幕，或同時使用自動分工。',
    );
  } else {
    if (
      typeof controlDisplayId !== 'string' ||
      !INTEGER_NUMBER.test(controlDisplayId) ||
      !Number.isSafeInteger(Number(controlDisplayId))
    ) {
      return failure(
        'display.controlDisplayId',
        '請選擇有效的控制台螢幕。',
      );
    }

    if (
      typeof defaultDisplayId !== 'string' ||
      !INTEGER_NUMBER.test(defaultDisplayId) ||
      !Number.isSafeInteger(Number(defaultDisplayId))
    ) {
      return failure(
        'display.defaultDisplayId',
        '請選擇有效的訊息螢幕。',
      );
    }

    if (Number(controlDisplayId) === Number(defaultDisplayId)) {
      return failure(
        'display.defaultDisplayId',
        '控制台與訊息畫面必須使用不同螢幕。',
      );
    }

    displayAssignment = {
      selectionMode: 'manual',
      controlDisplayId: Number(controlDisplayId),
      defaultDisplayId: Number(defaultDisplayId),
    };
  }

  const result = normalizeConfig({
    configVersion: 10,
    logo: {
      enabled: logoEnabled,
      path: logoPath,
      sizePercent: Number(logoSizePercent),
    },
    standby: {
      backgroundMode: standbyBackgroundMode,
      backgroundImagePaths: standbyBackgroundImagePaths,
      slideDurationSeconds: Number(standbySlideDurationSeconds),
    },
    appearance: {
      backgroundColor,
      messageBackgroundPreset,
      fontFamily,
      fontColor,
      minimumFontSizeRem: Number(minimumFontSizeRem),
      fontSizePercent: Number(fontSizePercent),
      standbyClockSizePercent: Number(standbyClockSizePercent),
      lineSpacingPercent: Number(lineSpacingPercent),
      messageLiquidEffectEnabled,
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
    display: {
      ...displayAssignment,
      fullscreen: baselineResult.value.display.fullscreen,
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
