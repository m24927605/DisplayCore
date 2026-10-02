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
  Object.freeze(settings.standby.backgroundImageUrls);
  Object.freeze(settings.standby);
  Object.freeze(settings.appearance);
  Object.freeze(settings.dateTime);
  Object.freeze(settings.emergency);
  Object.freeze(settings.marquee);
  return Object.freeze(settings);
}

/**
 * 將 ConfigManager snapshot 投影為 Display 唯讀且最小權限的設定。
 *
 * 不發布 defaults、notice、螢幕選擇、輸出解析度或受管理檔案路徑；Display
 * 一律依實際視窗尺寸排版。Logo 與待機背景只以同源、不含作業系統資訊的
 * URL 提供給 Renderer。
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
  const backgroundImageUrls = [];

  if (config.logo.enabled) {
    const match = MANAGED_LOGO_PATH.exec(config.logo.path || '');

    if (!match) {
      return invalidSnapshot();
    }

    logoUrl = `${DISPLAY_LOGO_URL_PREFIX}${match[1]}`;
  }

  for (const backgroundImagePath of config.standby.backgroundImagePaths) {
    const match = MANAGED_STANDBY_BACKGROUND_PATH.exec(backgroundImagePath);

    if (!match) {
      return invalidSnapshot();
    }

    backgroundImageUrls.push(
      `${DISPLAY_STANDBY_BACKGROUND_URL_PREFIX}${match[1]}`,
    );
  }

  return freezeDisplaySettings({
    configVersion: config.configVersion,
    logo: {
      enabled: config.logo.enabled,
      url: logoUrl,
      sizePercent: config.logo.sizePercent,
    },
    standby: {
      backgroundMode: config.standby.backgroundMode,
      backgroundImageUrls,
      sandEffectEnabled: config.standby.sandEffectEnabled,
      slideDurationSeconds: config.standby.slideDurationSeconds,
    },
    appearance: {
      backgroundColor: config.appearance.backgroundColor,
      fontFamily: config.appearance.fontFamily,
      fontColor: config.appearance.fontColor,
      messageBackgroundPreset: config.appearance.messageBackgroundPreset,
      minimumFontSizeRem: config.appearance.minimumFontSizeRem,
      fontSizePercent: config.appearance.fontSizePercent,
      lineSpacingPercent: config.appearance.lineSpacingPercent,
      messageLiquidEffectEnabled:
        config.appearance.messageLiquidEffectEnabled,
      standbyClockSizePercent: config.appearance.standbyClockSizePercent,
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
