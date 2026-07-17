const MAX_BINARY_SEARCH_ITERATIONS = 24;

/**
 * 依可用列高計算有效最小字級，避免三行加 Logo／日期時發生垂直裁切。
 *
 * 使用者設定仍是水平縮放與跑馬燈的目標下限；只有物理列高不足時才會下修，
 * 並回傳 minimumWasClamped 供畫面診斷與測試。
 */
export function calculateResponsiveFontBounds({
  availableWidth,
  smallestRowHeight,
  rootFontSize,
  minimumFontSizeRem,
  fontSizePercent,
  lineHeight,
}) {
  if (
    !Number.isFinite(availableWidth) ||
    availableWidth <= 0 ||
    !Number.isFinite(smallestRowHeight) ||
    smallestRowHeight <= 0 ||
    !Number.isFinite(rootFontSize) ||
    rootFontSize <= 0 ||
    !Number.isFinite(minimumFontSizeRem) ||
    minimumFontSizeRem <= 0 ||
    !Number.isFinite(fontSizePercent) ||
    fontSizePercent <= 0 ||
    !Number.isFinite(lineHeight) ||
    lineHeight <= 0
  ) {
    throw new TypeError('響應式字級邊界參數不正確。');
  }

  const configuredMinimumFontSize = minimumFontSizeRem * rootFontSize;
  const verticalFontSizeLimit = smallestRowHeight / lineHeight;
  const configuredResponsiveMaximum =
    availableWidth * 0.24 * (fontSizePercent / 100);
  const minimumFontSize = Math.min(
    configuredMinimumFontSize,
    verticalFontSizeLimit,
  );
  const maximumFontSize = Math.max(
    minimumFontSize,
    Math.min(configuredResponsiveMaximum, verticalFontSizeLimit),
  );

  return {
    configuredMinimumFontSize,
    minimumFontSize,
    maximumFontSize,
    minimumWasClamped: minimumFontSize < configuredMinimumFontSize,
  };
}

/**
 * 以有界二分搜尋找出不溢出的最大字級。
 *
 * fits 由 DOM adapter 使用同一正式字型與容器量測；本模組不接觸 DOM，讓
 * 演算法可獨立驗證。若設定的 minimum 仍放不下，交由呼叫端切換跑馬燈。
 */
export function findLargestFittingFontSize({
  minimumFontSize,
  maximumFontSize,
  precision = 0.25,
  fits,
}) {
  if (
    !Number.isFinite(minimumFontSize) ||
    minimumFontSize <= 0 ||
    !Number.isFinite(maximumFontSize) ||
    maximumFontSize < minimumFontSize ||
    !Number.isFinite(precision) ||
    precision <= 0 ||
    typeof fits !== 'function'
  ) {
    throw new TypeError('字體縮放參數不正確。');
  }

  if (!fits(minimumFontSize)) {
    return {
      fontSize: minimumFontSize,
      fitsAtMinimum: false,
      iterations: 0,
    };
  }

  if (fits(maximumFontSize)) {
    return {
      fontSize: maximumFontSize,
      fitsAtMinimum: true,
      iterations: 0,
    };
  }

  let lowerBound = minimumFontSize;
  let upperBound = maximumFontSize;
  let iterations = 0;

  while (
    upperBound - lowerBound > precision &&
    iterations < MAX_BINARY_SEARCH_ITERATIONS
  ) {
    const candidate = (lowerBound + upperBound) / 2;

    if (fits(candidate)) {
      lowerBound = candidate;
    } else {
      upperBound = candidate;
    }

    iterations += 1;
  }

  return {
    fontSize: lowerBound,
    fitsAtMinimum: true,
    iterations,
  };
}
