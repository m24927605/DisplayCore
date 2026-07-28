const DEFAULT_ALPHA_THRESHOLD = 1;
const DEFAULT_RING_SAMPLE_COUNT = 64;
const MINIMUM_RING_COVERAGE = 0.25;
const TARGET_RING_COVERAGE = 0.48;
const TARGET_AGGREGATE_COVERAGE = 0.45;
const DISTANCE_EPSILON = 1e-7;
const ringSamplesByCount = new Map();

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} 必須是正整數。`);
  }
  return value;
}

function requireFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} 必須是有限數值。`);
  }
  return value;
}

function resolveScale(value, fallback, label) {
  const scale = value ?? fallback;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new TypeError(`${label} 必須大於零。`);
  }
  return scale;
}

/**
 * 將字形 alpha 解析成每列的連續區段。這個函式只應在 renderer sync 或
 * 跑馬燈 chunk 切換時呼叫；逐幀 placement 不再掃描原始像素。
 *
 * alpha 可直接傳入 getImageData 的 RGBA Uint8ClampedArray，也可傳入每像素
 * 一個值的 alpha-only 陣列。windowStart/windowTop 是 backing bitmap 左上角
 * 對應的全域邏輯座標；scaleX/scaleY 未指定時沿用 dpr。
 */
export function createGlyphAlphaRowRuns({
  alpha,
  alphaThreshold = DEFAULT_ALPHA_THRESHOLD,
  dpr = 1,
  height,
  scaleX,
  scaleY,
  width,
  windowStart = 0,
  windowTop = 0,
}) {
  const pixelWidth = requirePositiveInteger(width, 'glyph alpha width');
  const pixelHeight = requirePositiveInteger(height, 'glyph alpha height');
  const pixelCount = pixelWidth * pixelHeight;
  if (!(alpha instanceof Uint8ClampedArray)) {
    throw new TypeError('glyph alpha 必須是 Uint8ClampedArray。');
  }

  let stride;
  let channel;
  if (alpha.length === pixelCount) {
    stride = 1;
    channel = 0;
  } else if (alpha.length === pixelCount * 4) {
    stride = 4;
    channel = 3;
  } else {
    throw new RangeError('glyph alpha 長度必須符合 alpha-only 或 RGBA 尺寸。');
  }

  const threshold = requireFiniteNumber(alphaThreshold, 'alphaThreshold');
  if (threshold < 0 || threshold > 255) {
    throw new RangeError('alphaThreshold 必須介於 0 到 255。');
  }
  const fallbackScale = resolveScale(dpr, 1, 'dpr');
  const resolvedScaleX = resolveScale(scaleX, fallbackScale, 'scaleX');
  const resolvedScaleY = resolveScale(scaleY, fallbackScale, 'scaleY');
  const originX = requireFiniteNumber(windowStart, 'windowStart');
  const originY = requireFiniteNumber(windowTop, 'windowTop');
  const rows = new Array(pixelHeight);
  let runCount = 0;

  for (let y = 0; y < pixelHeight; y += 1) {
    const runs = [];
    let runStart = -1;
    const rowOffset = y * pixelWidth;
    for (let x = 0; x < pixelWidth; x += 1) {
      const value = alpha[(rowOffset + x) * stride + channel];
      if (value >= threshold && runStart < 0) {
        runStart = x;
      }
      if (value < threshold && runStart >= 0) {
        runs.push(runStart, x - 1);
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      runs.push(runStart, pixelWidth - 1);
    }
    runCount += runs.length / 2;
    rows[y] = Int32Array.from(runs);
  }

  return Object.freeze({
    height: pixelHeight,
    logicalHeight: pixelHeight / resolvedScaleY,
    logicalWidth: pixelWidth / resolvedScaleX,
    rowRuns: Object.freeze(rows),
    runCount,
    scaleX: resolvedScaleX,
    scaleY: resolvedScaleY,
    width: pixelWidth,
    windowStart: originX,
    windowTop: originY,
  });
}

function assertCompiledMask(mask) {
  if (
    !mask ||
    !Array.isArray(mask.rowRuns) ||
    !Number.isFinite(mask.scaleX) ||
    !Number.isFinite(mask.scaleY) ||
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height)
  ) {
    throw new TypeError('mask 必須由 createGlyphAlphaRowRuns 建立。');
  }
}

function rowContainsPixel(row, pixelX) {
  let low = 0;
  let high = row.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = row[middle * 2];
    const end = row[middle * 2 + 1];
    if (pixelX < start) {
      high = middle - 1;
    } else if (pixelX > end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function findFirstRunEndingAtOrAfter(row, pixelX) {
  let low = 0;
  let high = row.length / 2;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (row[middle * 2 + 1] < pixelX) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low * 2;
}

function hasAlphaAt(mask, logicalX, logicalY) {
  const pixelX = Math.floor(
    (logicalX - mask.windowStart) * mask.scaleX,
  );
  const pixelY = Math.floor(
    (logicalY - mask.windowTop) * mask.scaleY,
  );
  if (
    pixelX < 0 || pixelX >= mask.width ||
    pixelY < 0 || pixelY >= mask.height
  ) {
    return false;
  }
  return rowContainsPixel(mask.rowRuns[pixelY], pixelX);
}

function getRingSamples(sampleCount) {
  const cached = ringSamplesByCount.get(sampleCount);
  if (cached) {
    return cached;
  }
  const samples = new Float64Array(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = index / sampleCount * Math.PI * 2;
    samples[index * 2] = Math.cos(angle);
    samples[index * 2 + 1] = Math.sin(angle);
  }
  ringSamplesByCount.set(sampleCount, samples);
  return samples;
}

function measureRingCoverage(mask, x, y, radius, samples) {
  let covered = 0;
  for (let index = 0; index < samples.length; index += 2) {
    if (hasAlphaAt(
      mask,
      x + samples[index] * radius,
      y + samples[index + 1] * radius,
    )) {
      covered += 1;
    }
  }
  return covered / (samples.length / 2);
}

function toLogicalX(mask, pixelX) {
  return mask.windowStart + (pixelX + 0.5) / mask.scaleX;
}

function toLogicalY(mask, pixelY) {
  return mask.windowTop + (pixelY + 0.5) / mask.scaleY;
}

function compareTargetCandidates(left, right) {
  if (!right) {
    return -1;
  }
  const distanceDifference = left.distance - right.distance;
  if (Math.abs(distanceDifference) > DISTANCE_EPSILON) {
    return distanceDifference;
  }
  const coverageDifference = right.coverage - left.coverage;
  if (Math.abs(coverageDifference) > DISTANCE_EPSILON) {
    return coverageDifference;
  }
  return left.y - right.y || left.x - right.x;
}

function compareFallbackCandidates(left, right) {
  if (!right) {
    return -1;
  }
  const coverageDifference = right.coverage - left.coverage;
  if (Math.abs(coverageDifference) > DISTANCE_EPSILON) {
    return coverageDifference;
  }
  return compareTargetCandidates(left, right);
}

function placeOneBubble({
  bubble,
  mask,
  maximumDisplacement,
  minimumCoverage,
  ringSamples,
  targetCoverage,
}) {
  const { radius, x, y } = bubble;
  if (
    !Number.isFinite(radius) || radius <= 0 ||
    !Number.isFinite(x) || !Number.isFinite(y)
  ) {
    return null;
  }

  const originalCoverage = hasAlphaAt(mask, x, y)
    ? measureRingCoverage(mask, x, y, radius, ringSamples)
    : 0;
  if (originalCoverage >= targetCoverage) {
    return Object.freeze({
      bubble,
      coverage: originalCoverage,
      distance: 0,
      x,
      y,
    });
  }

  const originalPixelX = (x - mask.windowStart) * mask.scaleX - 0.5;
  const originalPixelY = (y - mask.windowTop) * mask.scaleY - 0.5;
  const pixelRadiusX = radius * mask.scaleX;
  const minimumPixelX = Math.floor(
    (x - maximumDisplacement - mask.windowStart) * mask.scaleX,
  );
  const maximumPixelX = Math.ceil(
    (x + maximumDisplacement - mask.windowStart) * mask.scaleX,
  );
  const firstRow = Math.max(
    0,
    Math.floor((y - maximumDisplacement - mask.windowTop) * mask.scaleY),
  );
  const lastRow = Math.min(
    mask.height - 1,
    Math.ceil((y + maximumDisplacement - mask.windowTop) * mask.scaleY),
  );
  const rowOrder = [];
  for (let pixelY = firstRow; pixelY <= lastRow; pixelY += 1) {
    rowOrder.push(pixelY);
  }
  rowOrder.sort((left, right) =>
    Math.abs(left - originalPixelY) - Math.abs(right - originalPixelY) ||
    left - right);

  let bestTarget = null;
  let bestFallback = originalCoverage >= minimumCoverage
    ? {
      coverage: originalCoverage,
      distance: 0,
      x,
      y,
    }
    : null;

  for (const pixelY of rowOrder) {
    const candidateY = toLogicalY(mask, pixelY);
    const verticalDistance = Math.abs(candidateY - y);
    if (
      bestTarget &&
      verticalDistance > bestTarget.distance + DISTANCE_EPSILON
    ) {
      break;
    }
    const row = mask.rowRuns[pixelY];
    const firstRunIndex = findFirstRunEndingAtOrAfter(row, minimumPixelX);
    for (
      let runIndex = firstRunIndex;
      runIndex < row.length;
      runIndex += 2
    ) {
      const runStart = row[runIndex];
      const runEnd = row[runIndex + 1];
      if (runStart > maximumPixelX) {
        break;
      }
      const nearestPixelX = Math.max(
        runStart,
        Math.min(runEnd, Math.round(originalPixelX)),
      );
      const inset = Math.min(
        Math.max(0, pixelRadiusX),
        (runEnd - runStart) / 2,
      );
      const candidatePixels = [
        nearestPixelX,
        Math.round((runStart + runEnd) / 2),
        Math.round(runStart + inset),
        Math.round(runEnd - inset),
      ];
      let previousPixelX = Number.NaN;
      candidatePixels.sort((left, right) =>
        Math.abs(left - originalPixelX) - Math.abs(right - originalPixelX) ||
        left - right);

      for (const pixelX of candidatePixels) {
        if (pixelX === previousPixelX) {
          continue;
        }
        previousPixelX = pixelX;
        const candidateX = toLogicalX(mask, pixelX);
        const distance = Math.hypot(candidateX - x, candidateY - y);
        if (distance > maximumDisplacement + DISTANCE_EPSILON) {
          continue;
        }
        const coverage = measureRingCoverage(
          mask,
          candidateX,
          candidateY,
          radius,
          ringSamples,
        );
        const candidate = {
          coverage,
          distance,
          x: candidateX,
          y: candidateY,
        };
        if (
          coverage >= targetCoverage &&
          compareTargetCandidates(candidate, bestTarget) < 0
        ) {
          bestTarget = candidate;
        }
        if (
          coverage >= minimumCoverage &&
          compareFallbackCandidates(candidate, bestFallback) < 0
        ) {
          bestFallback = candidate;
        }
      }
    }
  }

  const selected = bestTarget ?? bestFallback;
  return selected
    ? Object.freeze({ ...selected, bubble })
    : null;
}

function preserveBubbleWithPosition(placement) {
  return Object.freeze({
    ...placement.bubble,
    x: placement.x,
    y: placement.y,
  });
}

/**
 * 將模型產生的有限生命週期氣泡 snap 到 cached glyph 筆畫。
 *
 * 函式只調整 x/y；id、出生時間、生命週期、半徑與 opacity 原樣保留。
 * 若找不到至少 25% 圓環覆蓋的附近筆畫便捨棄，不會補生新氣泡。為避免
 * 少數低覆蓋氣泡拉低整體可信度，最終集合另保證平均覆蓋率至少 45%。
 */
export function placeBubblesInGlyphMask({
  aggregateRingCoverage = TARGET_AGGREGATE_COVERAGE,
  bubbles,
  mask,
  maximumDisplacement,
  minimumRingCoverage = MINIMUM_RING_COVERAGE,
  ringSampleCount = DEFAULT_RING_SAMPLE_COUNT,
  targetRingCoverage = TARGET_RING_COVERAGE,
}) {
  if (!Array.isArray(bubbles)) {
    throw new TypeError('bubbles 必須是陣列。');
  }
  assertCompiledMask(mask);
  if (!Number.isInteger(ringSampleCount) || ringSampleCount < 16) {
    throw new RangeError('ringSampleCount 必須是至少 16 的整數。');
  }
  for (const [value, label] of [
    [minimumRingCoverage, 'minimumRingCoverage'],
    [targetRingCoverage, 'targetRingCoverage'],
    [aggregateRingCoverage, 'aggregateRingCoverage'],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${label} 必須介於 0 到 1。`);
    }
  }
  if (targetRingCoverage < minimumRingCoverage) {
    throw new RangeError('targetRingCoverage 不得低於 minimumRingCoverage。');
  }
  if (bubbles.length === 0 || mask.runCount === 0) {
    return Object.freeze([]);
  }

  const placements = [];
  const ringSamples = getRingSamples(ringSampleCount);
  for (const bubble of bubbles) {
    const radius = Number(bubble?.radius);
    const resolvedMaximum = maximumDisplacement ?? Math.max(
      Number.isFinite(radius) ? radius * 4 : 0,
      mask.logicalHeight * 0.18,
    );
    if (!Number.isFinite(resolvedMaximum) || resolvedMaximum < 0) {
      throw new RangeError('maximumDisplacement 必須是非負有限數值。');
    }
    const placement = placeOneBubble({
      bubble,
      mask,
      maximumDisplacement: resolvedMaximum,
      minimumCoverage: minimumRingCoverage,
      ringSamples,
      targetCoverage: targetRingCoverage,
    });
    if (placement) {
      placements.push(placement);
    }
  }

  let coverageSum = placements.reduce(
    (sum, placement) => sum + placement.coverage,
    0,
  );
  while (
    placements.length > 0 &&
    coverageSum / placements.length < aggregateRingCoverage
  ) {
    let weakestIndex = 0;
    for (let index = 1; index < placements.length; index += 1) {
      const current = placements[index];
      const weakest = placements[weakestIndex];
      if (
        current.coverage < weakest.coverage - DISTANCE_EPSILON ||
        (
          Math.abs(current.coverage - weakest.coverage) <= DISTANCE_EPSILON &&
          current.distance > weakest.distance + DISTANCE_EPSILON
        )
      ) {
        weakestIndex = index;
      }
    }
    coverageSum -= placements[weakestIndex].coverage;
    placements.splice(weakestIndex, 1);
  }

  return Object.freeze(placements.map(preserveBubbleWithPosition));
}
