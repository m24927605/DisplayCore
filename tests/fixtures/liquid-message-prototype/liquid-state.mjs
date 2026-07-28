const RIM_COLOR = '#FFFFFF';
const LIQUID_COLOR = '#B65B43';
const LIQUID_DEEP_COLOR = '#5A0D25';
const SURFACE_COLOR = '#E0B06A';
const WAVE_POINT_COUNT = 24;
const SURFACE_BAND_THICKNESS_PERCENT = 0.9;

export const LIQUID_PROTOTYPE_PROGRESS_STEPS = Object.freeze([
  0,
  0.25,
  0.5,
  0.75,
  1,
]);

function round(value, digits = 4) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function createSurfacePoints(progress, surfacePercent) {
  const waveAmplitude = 1.55 * Math.sin(Math.PI * progress);
  const points = [];

  for (let index = 0; index <= WAVE_POINT_COUNT; index += 1) {
    const normalizedX = index / WAVE_POINT_COUNT;
    const primaryWave = Math.sin(normalizedX * Math.PI * 8);
    const secondaryWave = Math.sin(normalizedX * Math.PI * 14) * 0.18;
    points.push(Object.freeze({
      x: round(normalizedX * 100),
      y: round(clampPercent(
        surfacePercent + (waveAmplitude * (primaryWave + secondaryWave)),
      )),
    }));
  }

  return Object.freeze(points);
}

function toPointList(points) {
  return points.map(({ x, y }) => `${x}% ${y}%`).join(', ');
}

function createFillClipPath(surfacePoints) {
  return `polygon(${toPointList(surfacePoints)}, 100% 100%, 0% 100%)`;
}

function createSurfaceClipPath(surfacePoints) {
  const halfThickness = SURFACE_BAND_THICKNESS_PERCENT / 2;
  const topPoints = surfacePoints.map(({ x, y }) => ({
    x,
    y: round(clampPercent(y - halfThickness)),
  }));
  const bottomPoints = [...surfacePoints].reverse().map(({ x, y }) => ({
    x,
    y: round(clampPercent(y + halfThickness)),
  }));
  return `polygon(${toPointList([...topPoints, ...bottomPoints])})`;
}

/**
 * 建立單一評審進度的酒液視覺狀態。
 *
 * 原型使用同一組百分比幾何套用到每一列，讓任意中文、花名與 Didot 數字
 * 都共享一致液面，不依文字長度或解析度改變填充比例。
 */
export function createLiquidVisualState(progress) {
  if (
    typeof progress !== 'number' ||
    !Number.isFinite(progress) ||
    progress < 0 ||
    progress > 1
  ) {
    throw new TypeError('進度必須是 0 至 1 之間的有限數字。');
  }

  const fillPercent = round(progress * 100);
  const surfacePercent = round(100 - fillPercent);
  const surfacePoints = createSurfacePoints(progress, surfacePercent);

  return Object.freeze({
    deepColor: LIQUID_DEEP_COLOR,
    fillClipPath: createFillClipPath(surfacePoints),
    fillPercent,
    liquidColor: LIQUID_COLOR,
    progress,
    rimColor: RIM_COLOR,
    surfaceClipPath: createSurfaceClipPath(surfacePoints),
    surfaceColor: SURFACE_COLOR,
    surfaceOpacity: progress > 0 && progress < 1 ? 0.4 : 0,
    surfacePercent,
    surfacePoints,
  });
}
