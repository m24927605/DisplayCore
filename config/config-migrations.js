'use strict';

const { validateConfig } = require('./config-schema');

const LEGACY_CONFIG_KEYS = Object.freeze([
  'appearance',
  'configVersion',
  'dateTime',
  'display',
  'logo',
  'marquee',
]);
const LEGACY_APPEARANCE_KEYS = Object.freeze([
  'backgroundColor',
  'fontColor',
  'fontFamily',
  'minimumFontSizeRem',
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

/**
 * 將磁碟上的合法 v1 設定轉成 canonical v2。
 *
 * 只有這個磁碟邊界接受 v1；IPC、Control 與 Display 一律只使用 v2。
 * 新欄位取自封裝預設值，既有使用者欄位則完整保留並再次交由 v2 schema
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
    !hasExactKeys(candidate, LEGACY_CONFIG_KEYS) ||
    candidate.configVersion !== 1 ||
    !hasExactKeys(candidate.logo, ['enabled', 'path']) ||
    !hasExactKeys(candidate.appearance, LEGACY_APPEARANCE_KEYS) ||
    !isValidLegacyDateTime(candidate.dateTime) ||
    !hasExactKeys(candidate.marquee, ['enabled']) ||
    !hasExactKeys(candidate.display, [
      'defaultDisplayId',
      'fullscreen',
      'selectionMode',
    ])
  ) {
    return failure();
  }

  const migrated = validateConfig({
    configVersion: defaults.value.configVersion,
    logo: { ...candidate.logo },
    appearance: {
      ...defaults.value.appearance,
      ...candidate.appearance,
    },
    dateTime: { enabled: candidate.dateTime.enabled },
    emergency: { ...defaults.value.emergency },
    marquee: { ...candidate.marquee },
    display: { ...candidate.display },
  });

  return migrated.ok
    ? { ok: true, value: migrated.value, migrated: true }
    : migrated;
}

module.exports = { migrateStoredConfig };
