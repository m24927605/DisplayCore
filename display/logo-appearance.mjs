const TRANSPARENT_ALPHA_MAXIMUM = 249;
const MINIMUM_TRANSPARENT_PIXEL_RATIO = 0.1;

export const LOGO_TREATMENTS = Object.freeze({
  BRIGHT_WHITE: 'bright-white',
  LIGHT_PLATE: 'light-plate',
});

/**
 * 只分析縮小後的 RGBA alpha 樣本，不保留圖片內容。
 *
 * 透明背景足夠明確時可安全把圖形轉為亮白輪廓；JPG、完全不透明圖片，
 * 或任何無法辨識的資料都使用亮白底襯，避免整張圖片被濾成白色方塊。
 */
export function classifyLogoAlpha(pixels) {
  if (
    !(pixels instanceof Uint8ClampedArray) ||
    pixels.length === 0 ||
    pixels.length % 4 !== 0
  ) {
    return LOGO_TREATMENTS.LIGHT_PLATE;
  }

  const pixelCount = pixels.length / 4;
  let transparentPixelCount = 0;

  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset] <= TRANSPARENT_ALPHA_MAXIMUM) {
      transparentPixelCount += 1;
    }
  }

  return transparentPixelCount / pixelCount >=
    MINIMUM_TRANSPARENT_PIXEL_RATIO
    ? LOGO_TREATMENTS.BRIGHT_WHITE
    : LOGO_TREATMENTS.LIGHT_PLATE;
}
