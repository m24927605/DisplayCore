'use strict';

const { validateConfig } = require('../config/config-schema');

const MANAGED_LOGO_PATH = /^logos\/([a-f0-9]{24}\.(?:jpg|png|webp))$/;
const DISPLAY_LOGO_URL_PREFIX = 'displaycore://app/managed/logo/';
const MANAGED_STANDBY_BACKGROUND_PATH =
  /^standby-backgrounds\/([a-f0-9]{24}\.(?:jpg|png|webp))$/;
const DISPLAY_STANDBY_BACKGROUND_URL_PREFIX =
  'displaycore://app/managed/standby-background/';

function invalidSnapshot() {
  throw new TypeError('Display 設定 snapshot 格式不正確。');
}

function freezeDisplaySettings(settings) {
  Object.freeze(settings.logo);
  Object.freeze(settings.standby);
  Object.freeze(settings.appearance);
  Object.freeze(settings.dateTime);
  Object.freeze(settings.emergency);
  Object.freeze(settings.marquee);
  Object.freeze(settings.display);
  return Object.freeze(settings);
}

/**
 * 將 ConfigManager snapshot 投影為 Display 唯讀且最小權限的設定。
 *
 * 不發布 defaults、notice、螢幕選擇或受管理檔案路徑；只投影邏輯排版
 * 解析度。Logo 與待機背景只以同源、不含作業系統資訊的 URL 提供給
 * Renderer。
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
  let backgroundImageUrl = null;

  if (config.logo.enabled) {
    const match = MANAGED_LOGO_PATH.exec(config.logo.path || '');

    if (!match) {
      return invalidSnapshot();
    }

    logoUrl = `${DISPLAY_LOGO_URL_PREFIX}${match[1]}`;
  }

  if (config.standby.backgroundImagePath !== null) {
    const match = MANAGED_STANDBY_BACKGROUND_PATH.exec(
      config.standby.backgroundImagePath,
    );

    if (!match) {
      return invalidSnapshot();
    }

    backgroundImageUrl =
      `${DISPLAY_STANDBY_BACKGROUND_URL_PREFIX}${match[1]}`;
  }

  return freezeDisplaySettings({
    configVersion: config.configVersion,
    logo: {
      enabled: config.logo.enabled,
      url: logoUrl,
    },
    standby: { backgroundImageUrl },
    appearance: {
      backgroundColor: config.appearance.backgroundColor,
      fontFamily: config.appearance.fontFamily,
      fontColor: config.appearance.fontColor,
      minimumFontSizeRem: config.appearance.minimumFontSizeRem,
      fontSizePercent: config.appearance.fontSizePercent,
      lineSpacingPercent: config.appearance.lineSpacingPercent,
    },
    dateTime: {
      enabled: config.dateTime.enabled,
      offsetSeconds: config.dateTime.offsetSeconds,
    },
    emergency: {
      inspectionBackgroundColor:
        config.emergency.inspectionBackgroundColor,
      releaseBackgroundColor: config.emergency.releaseBackgroundColor,
    },
    marquee: { enabled: config.marquee.enabled },
    display: { renderResolution: config.display.renderResolution },
    revision: managerSnapshot.revision,
  });
}

module.exports = {
  DISPLAY_LOGO_URL_PREFIX,
  DISPLAY_STANDBY_BACKGROUND_URL_PREFIX,
  MANAGED_LOGO_PATH,
  MANAGED_STANDBY_BACKGROUND_PATH,
  createDisplaySettingsSnapshot,
};
