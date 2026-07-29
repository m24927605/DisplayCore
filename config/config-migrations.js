'use strict';

const { validateConfig } = require('./config-schema');

const LEGACY_V1_CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'logo',
  'marquee',
]);
const LEGACY_V2_CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'emergency',
  'logo',
  'marquee',
]);
const LEGACY_V3_CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'emergency',
  'logo',
  'marquee',
]);
const LEGACY_V4_CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'emergency',
  'logo',
  'marquee',
  'playback',
]);
const LEGACY_V5_CONFIG_KEYS = Object.freeze([
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
const LEGACY_V6_CONFIG_KEYS = LEGACY_V5_CONFIG_KEYS;
const LEGACY_V7_CONFIG_KEYS = LEGACY_V5_CONFIG_KEYS;
const LEGACY_V8_CONFIG_KEYS = LEGACY_V5_CONFIG_KEYS;
const LEGACY_V9_CONFIG_KEYS = LEGACY_V5_CONFIG_KEYS;
const LEGACY_APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'minimumFontSizeRem',
]);
const LEGACY_V2_TO_V7_APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'fontSizePercent',
  'lineSpacingPercent',
  'minimumFontSizeRem',
]);
const LEGACY_V8_APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'fontSizePercent',
  'lineSpacingPercent',
  'messageBackgroundPreset',
  'minimumFontSizeRem',
  'standbyClockSizePercent',
]);
const LEGACY_V9_APPEARANCE_KEYS = Object.freeze([
  ...LEGACY_V8_APPEARANCE_KEYS,
  'messageLiquidEffectEnabled',
].sort());

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
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

function failure(message = '舊版設定檔格式不正確。') {
  return {
    ok: false,
    error: { code: 'VALIDATION_FAILED', message },
  };
}

function isValidLegacyDateTime(dateTime) {
  if (
    !hasExactKeys(dateTime, ['enabled', 'hour12', 'locale']) ||
    typeof dateTime.enabled !== 'boolean' ||
    typeof dateTime.hour12 !== 'boolean' ||
    typeof dateTime.locale !== 'string'
  ) {
    return false;
  }

  try {
    return Intl.getCanonicalLocales(dateTime.locale).length === 1;
  } catch {
    return false;
  }
}

function hasCommonLegacySections(candidate) {
  return (
    hasExactKeys(candidate.logo, ['enabled', 'path']) &&
    hasExactKeys(candidate.marquee, ['enabled']) &&
    hasExactKeys(candidate.display, [
      'defaultDisplayId',
      'fullscreen',
      'selectionMode',
    ])
  );
}

function isCanonicalV2Shape(candidate) {
  return (
    hasExactKeys(candidate, LEGACY_V2_CONFIG_KEYS) &&
    candidate.configVersion === 2 &&
    hasCommonLegacySections(candidate) &&
    hasExactKeys(candidate.appearance, LEGACY_V2_TO_V7_APPEARANCE_KEYS) &&
    hasExactKeys(candidate.dateTime, ['enabled']) &&
    typeof candidate.dateTime.enabled === 'boolean' &&
    hasExactKeys(candidate.emergency, [
      'inspectionBackgroundColor',
      'releaseBackgroundColor',
    ])
  );
}

/**
 * v7 以前沒有訊息材質與獨立待機時間比例；遷移時保留原本純色外觀，
 * 並讓待機時間沿用舊字體比例，避免升級後畫面突然改變。
 */
function migrateLegacyAppearance(legacyAppearance, defaultAppearance) {
  const appearance = {
    ...defaultAppearance,
    ...legacyAppearance,
  };

  return {
    ...appearance,
    messageBackgroundPreset: 'solid',
    standbyClockSizePercent: appearance.fontSizePercent,
  };
}

/**
 * 將 v5／v6 的單張待機背景轉成目前版本的有序清單。
 * null 代表沒有背景，因此轉成空陣列；既有圖片則固定放在第一張。
 */
function migrateSingleStandbyBackground(legacyStandby, defaultStandby) {
  return {
    backgroundMode: 'fixed',
    backgroundImagePaths:
      legacyStandby.backgroundImagePath === null
        ? []
        : [legacyStandby.backgroundImagePath],
    slideDurationSeconds: defaultStandby.slideDurationSeconds,
  };
}

/**
 * v9 及以前雖保留單一輸出螢幕欄位，實際執行版本仍固定自動路由。
 * 升級為雙螢幕分工時採安全自動配置，避免無法推斷 Control 螢幕卻誤放視窗；
 * 排版解析度仍完整保留。
 */
function migrateLegacyDisplay(legacyDisplay, defaultDisplay) {
  return {
    ...defaultDisplay,
    renderResolution:
      typeof legacyDisplay?.renderResolution === 'string'
        ? legacyDisplay.renderResolution
        : defaultDisplay.renderResolution,
  };
}

/**
 * 將磁碟上的合法 v1 至 v9 設定轉成 canonical v10。
 *
 * 只有這個磁碟邊界接受舊版本；IPC、Control 與 Display 一律只使用 v10。
 * 新欄位取自封裝預設值，既有使用者欄位則完整保留並再次交由 v10 schema
 * 驗證，避免寬鬆合併掩蓋損壞或未知資料。
 */
function migrateStoredConfig(candidate, currentDefaults) {
  const defaults = validateConfig(currentDefaults);

  if (!defaults.ok) {
    return failure('原廠預設設定無效。');
  }

  const current = validateConfig(candidate);
  if (current.ok) {
    return { ok: true, value: current.value, migrated: false };
  }

  if (
    hasExactKeys(candidate, LEGACY_V9_CONFIG_KEYS) &&
    candidate.configVersion === 9 &&
    hasExactKeys(candidate.appearance, LEGACY_V9_APPEARANCE_KEYS)
  ) {
    const migratedV9 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV9.ok
      ? { ok: true, value: migratedV9.value, migrated: true }
      : migratedV9;
  }

  if (
    hasExactKeys(candidate, LEGACY_V8_CONFIG_KEYS) &&
    candidate.configVersion === 8 &&
    hasExactKeys(candidate.appearance, LEGACY_V8_APPEARANCE_KEYS)
  ) {
    const migratedV8 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      appearance: {
        ...candidate.appearance,
        messageLiquidEffectEnabled:
          defaults.value.appearance.messageLiquidEffectEnabled,
      },
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV8.ok
      ? { ok: true, value: migratedV8.value, migrated: true }
      : migratedV8;
  }

  if (
    hasExactKeys(candidate, LEGACY_V7_CONFIG_KEYS) &&
    candidate.configVersion === 7 &&
    hasExactKeys(candidate.appearance, LEGACY_V2_TO_V7_APPEARANCE_KEYS)
  ) {
    const migratedV7 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      appearance: migrateLegacyAppearance(
        candidate.appearance,
        defaults.value.appearance,
      ),
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV7.ok
      ? { ok: true, value: migratedV7.value, migrated: true }
      : migratedV7;
  }

  if (
    hasExactKeys(candidate, LEGACY_V6_CONFIG_KEYS) &&
    candidate.configVersion === 6 &&
    hasExactKeys(candidate.logo, ['enabled', 'path', 'sizePercent']) &&
    hasExactKeys(candidate.appearance, LEGACY_V2_TO_V7_APPEARANCE_KEYS) &&
    hasExactKeys(candidate.standby, ['backgroundImagePath'])
  ) {
    const migratedV6 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      appearance: migrateLegacyAppearance(
        candidate.appearance,
        defaults.value.appearance,
      ),
      standby: migrateSingleStandbyBackground(
        candidate.standby,
        defaults.value.standby,
      ),
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV6.ok
      ? { ok: true, value: migratedV6.value, migrated: true }
      : migratedV6;
  }

  if (
    hasExactKeys(candidate, LEGACY_V5_CONFIG_KEYS) &&
    candidate.configVersion === 5 &&
    hasExactKeys(candidate.logo, ['enabled', 'path']) &&
    hasExactKeys(candidate.appearance, LEGACY_V2_TO_V7_APPEARANCE_KEYS) &&
    hasExactKeys(candidate.standby, ['backgroundImagePath'])
  ) {
    const migratedV5 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      logo: {
        ...candidate.logo,
        sizePercent: defaults.value.logo.sizePercent,
      },
      appearance: migrateLegacyAppearance(
        candidate.appearance,
        defaults.value.appearance,
      ),
      standby: migrateSingleStandbyBackground(
        candidate.standby,
        defaults.value.standby,
      ),
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV5.ok
      ? { ok: true, value: migratedV5.value, migrated: true }
      : migratedV5;
  }

  if (
    hasExactKeys(candidate, LEGACY_V4_CONFIG_KEYS) &&
    candidate.configVersion === 4 &&
    hasExactKeys(candidate.logo, ['enabled', 'path']) &&
    hasExactKeys(candidate.appearance, LEGACY_V2_TO_V7_APPEARANCE_KEYS)
  ) {
    const migratedV4 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      logo: {
        ...candidate.logo,
        sizePercent: defaults.value.logo.sizePercent,
      },
      appearance: migrateLegacyAppearance(
        candidate.appearance,
        defaults.value.appearance,
      ),
      standby: { ...defaults.value.standby },
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV4.ok
      ? { ok: true, value: migratedV4.value, migrated: true }
      : migratedV4;
  }

  if (
    hasExactKeys(candidate, LEGACY_V3_CONFIG_KEYS) &&
    candidate.configVersion === 3 &&
    hasExactKeys(candidate.logo, ['enabled', 'path']) &&
    hasExactKeys(candidate.appearance, LEGACY_V2_TO_V7_APPEARANCE_KEYS)
  ) {
    const migratedV3 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      logo: {
        ...candidate.logo,
        sizePercent: defaults.value.logo.sizePercent,
      },
      appearance: migrateLegacyAppearance(
        candidate.appearance,
        defaults.value.appearance,
      ),
      playback: { ...defaults.value.playback },
      standby: { ...defaults.value.standby },
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
    });

    return migratedV3.ok
      ? { ok: true, value: migratedV3.value, migrated: true }
      : migratedV3;
  }

  if (isCanonicalV2Shape(candidate)) {
    const migratedV2 = validateConfig({
      ...candidate,
      configVersion: defaults.value.configVersion,
      logo: {
        ...candidate.logo,
        sizePercent: defaults.value.logo.sizePercent,
      },
      appearance: migrateLegacyAppearance(
        candidate.appearance,
        defaults.value.appearance,
      ),
      dateTime: {
        enabled: candidate.dateTime.enabled,
        offsetSeconds: defaults.value.dateTime.offsetSeconds,
      },
      display: migrateLegacyDisplay(
        candidate.display,
        defaults.value.display,
      ),
      playback: { ...defaults.value.playback },
      standby: { ...defaults.value.standby },
    });

    return migratedV2.ok
      ? { ok: true, value: migratedV2.value, migrated: true }
      : migratedV2;
  }

  if (
    !hasExactKeys(candidate, LEGACY_V1_CONFIG_KEYS) ||
    candidate.configVersion !== 1 ||
    !hasCommonLegacySections(candidate) ||
    !hasExactKeys(candidate.appearance, LEGACY_APPEARANCE_KEYS) ||
    !isValidLegacyDateTime(candidate.dateTime)
  ) {
    return failure();
  }

  const migrated = validateConfig({
    configVersion: defaults.value.configVersion,
    logo: {
      ...candidate.logo,
      sizePercent: defaults.value.logo.sizePercent,
    },
    appearance: migrateLegacyAppearance(
      candidate.appearance,
      defaults.value.appearance,
    ),
    dateTime: {
      enabled: candidate.dateTime.enabled,
      offsetSeconds: defaults.value.dateTime.offsetSeconds,
    },
    emergency: { ...defaults.value.emergency },
    marquee: { ...candidate.marquee },
    playback: { ...defaults.value.playback },
    standby: { ...defaults.value.standby },
    display: migrateLegacyDisplay(
      candidate.display,
      defaults.value.display,
    ),
  });

  return migrated.ok
    ? { ok: true, value: migrated.value, migrated: true }
    : migrated;
}

module.exports = { migrateStoredConfig };
