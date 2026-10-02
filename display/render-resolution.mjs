const RESOLUTION_PROFILES = Object.freeze({
  '1280x720': Object.freeze({ width: 1280, height: 720 }),
  '1366x768': Object.freeze({ width: 1366, height: 768 }),
  '1600x900': Object.freeze({ width: 1600, height: 900 }),
  '1920x1080': Object.freeze({ width: 1920, height: 1080 }),
  '2560x1440': Object.freeze({ width: 2560, height: 1440 }),
  '3840x2160': Object.freeze({ width: 3840, height: 2160 }),
});

function isViewportDimension(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * 將解析度設定解析成置中的邏輯畫布；只計算版面，不修改作業系統顯示模式。
 */
export function resolveRenderResolution(candidate) {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 3 ||
    !Object.hasOwn(candidate, 'profile') ||
    !Object.hasOwn(candidate, 'viewportWidth') ||
    !Object.hasOwn(candidate, 'viewportHeight') ||
    !isViewportDimension(candidate.viewportWidth) ||
    !isViewportDimension(candidate.viewportHeight)
  ) {
    throw new TypeError('顯示解析度參數不正確。');
  }

  const { profile, viewportWidth, viewportHeight } = candidate;
  if (profile === 'auto') {
    return Object.freeze({
      profile,
      logicalWidth: viewportWidth,
      logicalHeight: viewportHeight,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });
  }

  const resolution = RESOLUTION_PROFILES[profile];
  if (!resolution) {
    throw new TypeError('不支援的顯示解析度。');
  }

  const scale = Math.min(
    viewportWidth / resolution.width,
    viewportHeight / resolution.height,
  );
  return Object.freeze({
    profile,
    logicalWidth: resolution.width,
    logicalHeight: resolution.height,
    scale,
    offsetX: (viewportWidth - resolution.width * scale) / 2,
    offsetY: (viewportHeight - resolution.height * scale) / 2,
  });
}
