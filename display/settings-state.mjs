const SNAPSHOT_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'emergency',
  'logo',
  'marquee',
  'revision',
  'standby',
]);
const APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'fontSizePercent',
  'lineSpacingPercent',
  'messageBackgroundPreset',
  'messageLiquidEffectEnabled',
  'minimumFontSizeRem',
  'standbyClockSizePercent',
]);
const DATE_TIME_KEYS = Object.freeze(['enabled', 'offsetSeconds']);
const EMERGENCY_KEYS = Object.freeze([
  'inspectionBackgroundColor',
  'releaseBackgroundColor',
]);
const LOGO_KEYS = Object.freeze(['enabled', 'sizePercent', 'url']);
const STANDBY_KEYS = Object.freeze([
  'backgroundImageUrls',
  'backgroundMode',
  'sandEffectEnabled',
  'slideDurationSeconds',
]);
const MARQUEE_KEYS = Object.freeze(['enabled']);
const DISPLAY_KEYS = Object.freeze(['renderResolution']);
const RENDER_RESOLUTIONS = Object.freeze([
  'auto',
  '1366x768',
  '1600x900',
  '1920x1080',
  '2560x1440',
  '3840x2160',
]);
const DISPLAY_LOGO_URL =
  /^displaycore:\/\/app\/managed\/logo\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const DISPLAY_STANDBY_BACKGROUND_URL =
  /^displaycore:\/\/app\/managed\/standby-background\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const OPAQUE_HEX_COLOR = /^#[0-9A-F]{6}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MINIMUM_FONT_SIZE_REM = 1;
const MAXIMUM_FONT_SIZE_REM = 12;
const FONT_SIZE_STEP_REM = 0.25;
const MAXIMUM_FONT_FAMILY_LENGTH = 200;
const MINIMUM_FONT_SIZE_PERCENT = 50;
const MAXIMUM_FONT_SIZE_PERCENT = 200;
const MINIMUM_STANDBY_CLOCK_SIZE_PERCENT = 50;
const MAXIMUM_STANDBY_CLOCK_SIZE_PERCENT = 300;
const MINIMUM_LINE_SPACING_PERCENT = 0;
const MAXIMUM_LINE_SPACING_PERCENT = 300;
const PERCENTAGE_STEP = 5;
const MINIMUM_CLOCK_OFFSET_SECONDS = -43_199;
const MAXIMUM_CLOCK_OFFSET_SECONDS = 43_200;
const MINIMUM_LOGO_SIZE_PERCENT = 50;
const MAXIMUM_LOGO_SIZE_PERCENT = 1_000;
const LOGO_SIZE_PERCENT_STEP = 5;
const MAXIMUM_STANDBY_BACKGROUND_COUNT = 20;
const MINIMUM_STANDBY_SLIDE_DURATION_SECONDS = 1;
const MAXIMUM_STANDBY_SLIDE_DURATION_SECONDS = 3_600;
const MESSAGE_BACKGROUND_PRESETS = Object.freeze([
  'solid',
  'obsidian',
  'dark-marble',
  'walnut',
  'emerald-onyx',
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

function isValidLogo(logo) {
  if (
    !hasExactKeys(logo, LOGO_KEYS) ||
    typeof logo.enabled !== 'boolean' ||
    !Number.isSafeInteger(logo.sizePercent) ||
    logo.sizePercent < MINIMUM_LOGO_SIZE_PERCENT ||
    logo.sizePercent > MAXIMUM_LOGO_SIZE_PERCENT ||
    logo.sizePercent % LOGO_SIZE_PERCENT_STEP !== 0
  ) {
    return false;
  }

  if (!logo.enabled) {
    return logo.url === null;
  }

  return typeof logo.url === 'string' && DISPLAY_LOGO_URL.test(logo.url);
}

function isValidStandby(standby) {
  if (
    !hasExactKeys(standby, STANDBY_KEYS) ||
    !['fixed', 'slideshow'].includes(standby.backgroundMode) ||
    typeof standby.sandEffectEnabled !== 'boolean' ||
    !Array.isArray(standby.backgroundImageUrls) ||
    standby.backgroundImageUrls.length > MAXIMUM_STANDBY_BACKGROUND_COUNT ||
    !Number.isSafeInteger(standby.slideDurationSeconds) ||
    standby.slideDurationSeconds <
      MINIMUM_STANDBY_SLIDE_DURATION_SECONDS ||
    standby.slideDurationSeconds >
      MAXIMUM_STANDBY_SLIDE_DURATION_SECONDS
  ) {
    return false;
  }

  return (
    new Set(standby.backgroundImageUrls).size ===
      standby.backgroundImageUrls.length &&
    standby.backgroundImageUrls.every(
      (url) =>
        typeof url === 'string' && DISPLAY_STANDBY_BACKGROUND_URL.test(url),
    )
  );
}

function isValidAppearance(appearance) {
  if (!hasExactKeys(appearance, APPEARANCE_KEYS)) {
    return false;
  }

  if (
    !OPAQUE_HEX_COLOR.test(appearance.backgroundColor) ||
    !OPAQUE_HEX_COLOR.test(appearance.fontColor) ||
    typeof appearance.messageLiquidEffectEnabled !== 'boolean' ||
    typeof appearance.fontFamily !== 'string' ||
    appearance.fontFamily.trim().length === 0 ||
    appearance.fontFamily.length > MAXIMUM_FONT_FAMILY_LENGTH ||
    CONTROL_CHARACTERS.test(appearance.fontFamily)
  ) {
    return false;
  }

  const minimumFontSize = appearance.minimumFontSizeRem;
  const stepRatio = minimumFontSize / FONT_SIZE_STEP_REM;
  const fontSizePercent = appearance.fontSizePercent;
  const lineSpacingPercent = appearance.lineSpacingPercent;
  const standbyClockSizePercent = appearance.standbyClockSizePercent;

  return (
    Number.isFinite(minimumFontSize) &&
    minimumFontSize >= MINIMUM_FONT_SIZE_REM &&
    minimumFontSize <= MAXIMUM_FONT_SIZE_REM &&
    Math.abs(stepRatio - Math.round(stepRatio)) <= Number.EPSILON * 16 &&
    Number.isSafeInteger(fontSizePercent) &&
    fontSizePercent >= MINIMUM_FONT_SIZE_PERCENT &&
    fontSizePercent <= MAXIMUM_FONT_SIZE_PERCENT &&
    fontSizePercent % PERCENTAGE_STEP === 0 &&
    MESSAGE_BACKGROUND_PRESETS.includes(
      appearance.messageBackgroundPreset,
    ) &&
    Number.isSafeInteger(lineSpacingPercent) &&
    lineSpacingPercent >= MINIMUM_LINE_SPACING_PERCENT &&
    lineSpacingPercent <= MAXIMUM_LINE_SPACING_PERCENT &&
    lineSpacingPercent % PERCENTAGE_STEP === 0 &&
    Number.isSafeInteger(standbyClockSizePercent) &&
    standbyClockSizePercent >= MINIMUM_STANDBY_CLOCK_SIZE_PERCENT &&
    standbyClockSizePercent <= MAXIMUM_STANDBY_CLOCK_SIZE_PERCENT &&
    standbyClockSizePercent % PERCENTAGE_STEP === 0
  );
}

function isValidDateTime(dateTime) {
  if (
    !hasExactKeys(dateTime, DATE_TIME_KEYS) ||
    typeof dateTime.enabled !== 'boolean' ||
    !Number.isSafeInteger(dateTime.offsetSeconds) ||
    dateTime.offsetSeconds < MINIMUM_CLOCK_OFFSET_SECONDS ||
    dateTime.offsetSeconds > MAXIMUM_CLOCK_OFFSET_SECONDS
  ) {
    return false;
  }

  return true;
}

function isValidEmergency(emergency) {
  return (
    hasExactKeys(emergency, EMERGENCY_KEYS) &&
    OPAQUE_HEX_COLOR.test(emergency.inspectionBackgroundColor) &&
    OPAQUE_HEX_COLOR.test(emergency.releaseBackgroundColor)
  );
}

function isValidSnapshot(candidate) {
  return (
    hasExactKeys(candidate, SNAPSHOT_KEYS) &&
    candidate.configVersion === 11 &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0 &&
    isValidLogo(candidate.logo) &&
    isValidStandby(candidate.standby) &&
    isValidAppearance(candidate.appearance) &&
    isValidDateTime(candidate.dateTime) &&
    isValidEmergency(candidate.emergency) &&
    hasExactKeys(candidate.marquee, MARQUEE_KEYS) &&
    typeof candidate.marquee.enabled === 'boolean' &&
    hasExactKeys(candidate.display, DISPLAY_KEYS) &&
    RENDER_RESOLUTIONS.includes(candidate.display.renderResolution)
  );
}

function freezeSettings(settings) {
  Object.freeze(settings.logo);
  Object.freeze(settings.standby.backgroundImageUrls);
  Object.freeze(settings.standby);
  Object.freeze(settings.appearance);
  Object.freeze(settings.dateTime);
  Object.freeze(settings.emergency);
  Object.freeze(settings.marquee);
  Object.freeze(settings.display);
  return Object.freeze(settings);
}

function cloneSettings(candidate) {
  return freezeSettings({
    configVersion: candidate.configVersion,
    logo: {
      enabled: candidate.logo.enabled,
      url: candidate.logo.url,
      sizePercent: candidate.logo.sizePercent,
    },
    standby: {
      backgroundMode: candidate.standby.backgroundMode,
      backgroundImageUrls: [...candidate.standby.backgroundImageUrls],
      sandEffectEnabled: candidate.standby.sandEffectEnabled,
      slideDurationSeconds: candidate.standby.slideDurationSeconds,
    },
    appearance: {
      backgroundColor: candidate.appearance.backgroundColor,
      fontFamily: candidate.appearance.fontFamily,
      fontColor: candidate.appearance.fontColor,
      messageBackgroundPreset:
        candidate.appearance.messageBackgroundPreset,
      messageLiquidEffectEnabled:
        candidate.appearance.messageLiquidEffectEnabled,
      minimumFontSizeRem: candidate.appearance.minimumFontSizeRem,
      fontSizePercent: candidate.appearance.fontSizePercent,
      lineSpacingPercent: candidate.appearance.lineSpacingPercent,
      standbyClockSizePercent:
        candidate.appearance.standbyClockSizePercent,
    },
    dateTime: {
      enabled: candidate.dateTime.enabled,
      offsetSeconds: candidate.dateTime.offsetSeconds,
    },
    emergency: {
      inspectionBackgroundColor:
        candidate.emergency.inspectionBackgroundColor,
      releaseBackgroundColor: candidate.emergency.releaseBackgroundColor,
    },
    marquee: { enabled: candidate.marquee.enabled },
    display: { renderResolution: candidate.display.renderResolution },
    revision: candidate.revision,
  });
}

/** IPC 無法取得設定時仍可安全顯示訊息，不在電視呈現錯誤文字。 */
export const SAFE_DISPLAY_SETTINGS = freezeSettings({
  configVersion: 11,
  logo: { enabled: false, url: null, sizePercent: 100 },
  standby: {
    backgroundMode: 'fixed',
    backgroundImageUrls: [],
    sandEffectEnabled: false,
    slideDurationSeconds: 10,
  },
  appearance: {
    backgroundColor: '#000000',
    fontFamily:
      '"DisplayCore Source Han Serif TC", "Noto Serif TC", serif',
    fontColor: '#F4F0E7',
    messageBackgroundPreset: 'obsidian',
    messageLiquidEffectEnabled: false,
    minimumFontSizeRem: 2.5,
    fontSizePercent: 100,
    lineSpacingPercent: 100,
    standbyClockSizePercent: 100,
  },
  dateTime: { enabled: false, offsetSeconds: 0 },
  emergency: {
    inspectionBackgroundColor: '#000000',
    releaseBackgroundColor: '#000000',
  },
  marquee: { enabled: true },
  display: { renderResolution: 'auto' },
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
