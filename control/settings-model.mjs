const CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'logo',
  'marquee',
]);
const SNAPSHOT_KEYS = Object.freeze([
  'config',
  'defaults',
  'notice',
  'revision',
]);
const NOTICE_KEYS = Object.freeze(['code', 'message']);
const MANAGED_LOGO_PATH = /^logos\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const OPAQUE_HEX_COLOR = /^#[0-9a-f]{6}$/i;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DECIMAL_NUMBER = /^\d+(?:\.\d{1,2})?$/;
const INVALID_USER_CONFIG_NOTICE = Object.freeze({
  code: 'INVALID_USER_CONFIG',
  message: '使用者設定檔無法讀取，目前使用安全預設值；儲存後可修復。',
});

export const SETTINGS_LIMITS = Object.freeze({
  MAX_LOGO_PATH_LENGTH: 128,
  MAX_FONT_FAMILY_LENGTH: 200,
  MINIMUM_FONT_SIZE_REM: 1,
  MAXIMUM_FONT_SIZE_REM: 12,
  FONT_SIZE_STEP_REM: 0.25,
});

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
  for (const section of ['logo', 'appearance', 'dateTime', 'marquee', 'display']) {
    Object.freeze(config[section]);
  }

  return Object.freeze(config);
}

/** Renderer 鏡像驗證只改善 UX；Main 仍是唯一安全邊界。 */
function normalizeConfig(candidate) {
  if (!hasExactKeys(candidate, CONFIG_KEYS) || candidate.configVersion !== 1) {
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

  const appearance = candidate.appearance;

  if (
    !hasExactKeys(appearance, [
      'backgroundColor',
      'fontColor',
      'fontFamily',
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
    !hasExactKeys(dateTime, ['enabled', 'hour12', 'locale']) ||
    typeof dateTime.enabled !== 'boolean' ||
    typeof dateTime.hour12 !== 'boolean' ||
    typeof dateTime.locale !== 'string'
  ) {
    return failure('dateTime', '日期時間設定格式不正確。');
  }

  let locale;

  try {
    const locales = Intl.getCanonicalLocales(dateTime.locale);

    if (locales.length !== 1) {
      return failure('dateTime.locale', '日期時間語系格式不正確。');
    }

    [locale] = locales;
  } catch {
    return failure('dateTime.locale', '日期時間語系格式不正確。');
  }

  if (
    !hasExactKeys(candidate.marquee, ['enabled']) ||
    typeof candidate.marquee.enabled !== 'boolean'
  ) {
    return failure('marquee.enabled', '跑馬燈設定格式不正確。');
  }

  const display = candidate.display;
  const isAuto = display?.selectionMode === 'auto';
  const isManual = display?.selectionMode === 'manual';

  if (
    !hasExactKeys(display, ['defaultDisplayId', 'fullscreen', 'selectionMode']) ||
    typeof display.fullscreen !== 'boolean' ||
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
      configVersion: 1,
      logo: {
        enabled: candidate.logo.enabled,
        path: candidate.logo.path,
      },
      appearance: {
        backgroundColor: appearance.backgroundColor.toUpperCase(),
        fontFamily: appearance.fontFamily,
        fontColor: appearance.fontColor.toUpperCase(),
        minimumFontSizeRem,
      },
      dateTime: {
        enabled: dateTime.enabled,
        locale,
        hour12: dateTime.hour12,
      },
      marquee: { enabled: candidate.marquee.enabled },
      display: {
        selectionMode: display.selectionMode,
        defaultDisplayId: display.defaultDisplayId,
        fullscreen: display.fullscreen,
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
  backgroundColor,
  fontFamily,
  fontColor,
  minimumFontSizeRem,
  dateTimeEnabled,
  hour12,
  marqueeEnabled,
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

  const result = normalizeConfig({
    configVersion: 1,
    logo: { enabled: logoEnabled, path: logoPath },
    appearance: {
      backgroundColor,
      fontFamily,
      fontColor,
      minimumFontSizeRem: Number(minimumFontSizeRem),
    },
    dateTime: {
      enabled: dateTimeEnabled,
      locale: baselineResult.value.dateTime.locale,
      hour12,
    },
    marquee: { enabled: marqueeEnabled },
    // config v1 仍保留舊欄位供既有檔案相容；Control 不再提供修改入口。
    display: { ...baselineResult.value.display },
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
