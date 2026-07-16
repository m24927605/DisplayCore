const MAX_BINARY_SEARCH_ITERATIONS = 24;

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
