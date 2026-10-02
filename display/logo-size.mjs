const MINIMUM_LOGO_SIZE_PERCENT = 50;
const LINEAR_LOGO_SIZE_PERCENT = 200;
const MAXIMUM_LOGO_SIZE_PERCENT = 1_000;
const LOGO_SIZE_PERCENT_STEP = 5;
const PAGE_MAXIMUM_LAYOUT_SCALE = 3.2;

function isValidSizePercent(value) {
  return Number.isSafeInteger(value) &&
    value >= MINIMUM_LOGO_SIZE_PERCENT &&
    value <= MAXIMUM_LOGO_SIZE_PERCENT &&
    value % LOGO_SIZE_PERCENT_STEP === 0;
}

function interpolateCompressedScale(sizePercent) {
  const progress =
    (sizePercent - LINEAR_LOGO_SIZE_PERCENT) /
    (MAXIMUM_LOGO_SIZE_PERCENT - LINEAR_LOGO_SIZE_PERCENT);
  return (LINEAR_LOGO_SIZE_PERCENT / 100) +
    (progress * (PAGE_MAXIMUM_LAYOUT_SCALE - (LINEAR_LOGO_SIZE_PERCENT / 100)));
}

/**
 * 將管理員設定的百分比轉成安全排版尺度。
 *
 * Logo 只顯示於訊息畫面。50–200% 維持直覺的一比一比例；更大的設定仍逐級
 * 成長，但壓縮至訊息三列都能保留的上限。configuredScale 保留原始設定語意
 * 供狀態檢查。
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
    });
  }

  return Object.freeze({
    configuredScale,
    pageScale: interpolateCompressedScale(sizePercent),
  });
}
