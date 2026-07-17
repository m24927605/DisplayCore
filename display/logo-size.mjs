const MINIMUM_LOGO_SIZE_PERCENT = 50;
const LINEAR_LOGO_SIZE_PERCENT = 200;
const MAXIMUM_LOGO_SIZE_PERCENT = 1_000;
const LOGO_SIZE_PERCENT_STEP = 5;
const PAGE_MAXIMUM_LAYOUT_SCALE = 3.2;
const STANDBY_MAXIMUM_LAYOUT_SCALE = 4.4;

function isValidSizePercent(value) {
  return Number.isSafeInteger(value) &&
    value >= MINIMUM_LOGO_SIZE_PERCENT &&
    value <= MAXIMUM_LOGO_SIZE_PERCENT &&
    value % LOGO_SIZE_PERCENT_STEP === 0;
}

function interpolateCompressedScale(sizePercent, maximumScale) {
  const progress =
    (sizePercent - LINEAR_LOGO_SIZE_PERCENT) /
    (MAXIMUM_LOGO_SIZE_PERCENT - LINEAR_LOGO_SIZE_PERCENT);
  return (LINEAR_LOGO_SIZE_PERCENT / 100) +
    (progress * (maximumScale - (LINEAR_LOGO_SIZE_PERCENT / 100)));
}

/**
 * 將管理員設定的百分比轉成安全排版尺度。
 *
 * 50–200% 維持直覺的一比一比例；更大的設定仍逐級成長，但壓縮至訊息三列
 * 與待機三列都能保留的上限。configuredScale 保留原始設定語意供狀態檢查。
 */
export function calculateLogoLayoutScales(sizePercent) {
  if (!isValidSizePercent(sizePercent)) {
    throw new TypeError('Logo 大小設定不正確。');
  }

  const configuredScale = sizePercent / 100;
  if (sizePercent <= LINEAR_LOGO_SIZE_PERCENT) {
    return Object.freeze({
      configuredScale,
      pageScale: configuredScale,
      standbyScale: configuredScale,
    });
  }

  return Object.freeze({
    configuredScale,
    pageScale: interpolateCompressedScale(
      sizePercent,
      PAGE_MAXIMUM_LAYOUT_SCALE,
    ),
    standbyScale: interpolateCompressedScale(
      sizePercent,
      STANDBY_MAXIMUM_LAYOUT_SCALE,
    ),
  });
}
