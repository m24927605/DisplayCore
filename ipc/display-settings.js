'use strict';

const { validateConfig } = require('../config/config-schema');

const MANAGED_LOGO_PATH = /^logos\/([a-f0-9]{24}\.(?:jpg|png|webp))$/;
const DISPLAY_LOGO_URL_PREFIX = 'displaycore://app/managed/logo/';

function invalidSnapshot() {
  throw new TypeError('Display 設定 snapshot 格式不正確。');
}

function freezeDisplaySettings(settings) {
  Object.freeze(settings.logo);
  Object.freeze(settings.appearance);
  Object.freeze(settings.dateTime);
  Object.freeze(settings.marquee);
  return Object.freeze(settings);
}

/**
 * 將 ConfigManager snapshot 投影為 Display 唯讀且最小權限的設定。
 *
 * 不發布 defaults、notice、螢幕選擇或受管理檔案路徑；Logo 只以同源、
 * 不含作業系統資訊的 URL 提供給 Renderer。
 */
function createDisplaySettingsSnapshot(managerSnapshot) {
  if (
    managerSnapshot === null ||
    typeof managerSnapshot !== 'object' ||
    Array.isArray(managerSnapshot) ||
    !Number.isSafeInteger(managerSnapshot.revision) ||
    managerSnapshot.revision < 0
  ) {
    return invalidSnapshot();
  }

  const validation = validateConfig(managerSnapshot.config);

  if (!validation.ok) {
    return invalidSnapshot();
  }

  const config = validation.value;
  let logoUrl = null;

  if (config.logo.enabled) {
    const match = MANAGED_LOGO_PATH.exec(config.logo.path || '');

    if (!match) {
      return invalidSnapshot();
    }

    logoUrl = `${DISPLAY_LOGO_URL_PREFIX}${match[1]}`;
  }

  return freezeDisplaySettings({
    configVersion: config.configVersion,
    logo: {
      enabled: config.logo.enabled,
      url: logoUrl,
    },
    appearance: {
      backgroundColor: config.appearance.backgroundColor,
      fontFamily: config.appearance.fontFamily,
      fontColor: config.appearance.fontColor,
      minimumFontSizeRem: config.appearance.minimumFontSizeRem,
    },
    dateTime: {
      enabled: config.dateTime.enabled,
      locale: config.dateTime.locale,
      hour12: config.dateTime.hour12,
    },
    marquee: { enabled: config.marquee.enabled },
    revision: managerSnapshot.revision,
  });
}

module.exports = {
  DISPLAY_LOGO_URL_PREFIX,
  MANAGED_LOGO_PATH,
  createDisplaySettingsSnapshot,
};

