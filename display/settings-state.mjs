const SNAPSHOT_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'logo',
  'marquee',
  'revision',
]);
const APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'minimumFontSizeRem',
]);
const DATE_TIME_KEYS = Object.freeze(['enabled', 'hour12', 'locale']);
const LOGO_KEYS = Object.freeze(['enabled', 'url']);
const MARQUEE_KEYS = Object.freeze(['enabled']);
const DISPLAY_LOGO_URL =
  /^displaycore:\/\/app\/managed\/logo\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const OPAQUE_HEX_COLOR = /^#[0-9A-F]{6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MINIMUM_FONT_SIZE_REM = 1;
const MAXIMUM_FONT_SIZE_REM = 12;
const FONT_SIZE_STEP_REM = 0.25;
const MAXIMUM_FONT_FAMILY_LENGTH = 200;

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

function isValidLogo(logo) {
  if (
    !hasExactKeys(logo, LOGO_KEYS) ||
    typeof logo.enabled !== 'boolean'
  ) {
    return false;
  }

  if (!logo.enabled) {
    return logo.url === null;
  }

  return typeof logo.url === 'string' && DISPLAY_LOGO_URL.test(logo.url);
}

function isValidAppearance(appearance) {
  if (!hasExactKeys(appearance, APPEARANCE_KEYS)) {
    return false;
  }

  if (
    !OPAQUE_HEX_COLOR.test(appearance.backgroundColor) ||
    !OPAQUE_HEX_COLOR.test(appearance.fontColor) ||
    typeof appearance.fontFamily !== 'string' ||
    appearance.fontFamily.trim().length === 0 ||
    appearance.fontFamily.length > MAXIMUM_FONT_FAMILY_LENGTH ||
    CONTROL_CHARACTERS.test(appearance.fontFamily)
  ) {
    return false;
  }

  const fontSize = appearance.minimumFontSizeRem;
  const stepRatio = fontSize / FONT_SIZE_STEP_REM;

  return (
    Number.isFinite(fontSize) &&
    fontSize >= MINIMUM_FONT_SIZE_REM &&
    fontSize <= MAXIMUM_FONT_SIZE_REM &&
    Math.abs(stepRatio - Math.round(stepRatio)) <= Number.EPSILON * 16
  );
}

function isValidDateTime(dateTime) {
  if (
    !hasExactKeys(dateTime, DATE_TIME_KEYS) ||
    typeof dateTime.enabled !== 'boolean' ||
    typeof dateTime.hour12 !== 'boolean' ||
    typeof dateTime.locale !== 'string' ||
    dateTime.locale.length === 0 ||
    dateTime.locale.length > 35 ||
    CONTROL_CHARACTERS.test(dateTime.locale)
  ) {
    return false;
  }

  try {
    const locales = Intl.getCanonicalLocales(dateTime.locale);
    return locales.length === 1 && locales[0] === dateTime.locale;
  } catch {
    return false;
  }
}

function isValidSnapshot(candidate) {
  return (
    hasExactKeys(candidate, SNAPSHOT_KEYS) &&
    candidate.configVersion === 1 &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    isValidLogo(candidate.logo) &&
    isValidAppearance(candidate.appearance) &&
    isValidDateTime(candidate.dateTime) &&
    hasExactKeys(candidate.marquee, MARQUEE_KEYS) &&
    typeof candidate.marquee.enabled === 'boolean'
  );
}

function freezeSettings(settings) {
  Object.freeze(settings.logo);
  Object.freeze(settings.appearance);
  Object.freeze(settings.dateTime);
  Object.freeze(settings.marquee);
  return Object.freeze(settings);
}

function cloneSettings(candidate) {
  return freezeSettings({
    configVersion: candidate.configVersion,
    logo: { enabled: candidate.logo.enabled, url: candidate.logo.url },
    appearance: {
      backgroundColor: candidate.appearance.backgroundColor,
      fontFamily: candidate.appearance.fontFamily,
      fontColor: candidate.appearance.fontColor,
      minimumFontSizeRem: candidate.appearance.minimumFontSizeRem,
    },
    dateTime: {
      enabled: candidate.dateTime.enabled,
      locale: candidate.dateTime.locale,
      hour12: candidate.dateTime.hour12,
    },
    marquee: { enabled: candidate.marquee.enabled },
    revision: candidate.revision,
  });
}

/** IPC 無法取得設定時仍可安全顯示訊息，不在電視呈現錯誤文字。 */
export const SAFE_DISPLAY_SETTINGS = freezeSettings({
  configVersion: 1,
  logo: { enabled: false, url: null },
  appearance: {
    backgroundColor: '#000000',
    fontFamily: 'Microsoft JhengHei UI, Microsoft JhengHei, sans-serif',
    fontColor: '#FFFFFF',
    minimumFontSizeRem: 2.5,
  },
  dateTime: { enabled: false, locale: 'zh-TW', hour12: false },
  marquee: { enabled: true },
  revision: -1,
});

/** 驗證 Main 投影並拒絕相同或較舊的設定 revision。 */
export function acceptDisplaySettingsSnapshot(currentRevision, candidate) {
  if (
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < -1 ||
    !isValidSnapshot(candidate) ||
    candidate.revision <= currentRevision
  ) {
    return { accepted: false };
  }

  return { accepted: true, snapshot: cloneSettings(candidate) };
}

