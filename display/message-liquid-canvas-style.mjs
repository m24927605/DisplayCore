/**
 * 訊息字體酒液 Canvas 的純視覺參數。
 *
 * 本模組不接觸 DOM 或 Canvas context，讓線寬、透明度與折射幾何可以在
 * Node 測試中直接驗證，也避免 4K renderer 在每一幀重新組裝常數物件。
 */

const MENISCUS_DEPTH_WIDTH_RATIO = 0.0105;
const MENISCUS_CORE_WIDTH_RATIO = 0.006;
const BUBBLE_BODY_WIDTH_RATIO = 0.0042;
const BUBBLE_HIGHLIGHT_WIDTH_RATIO = 0.003;

const PRIMARY_REFRACTION_SUPPORT_RATIO = 0.12;
const SECONDARY_REFRACTION_SUPPORT_RATIO = 0.09;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Number(value.toFixed(6));
}

function validateDimensions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('width 與 height 必須是大於零的有限數值');
  }

  const { width, height } = options;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError('width 與 height 必須是大於零的有限數值');
  }

  return Object.freeze({ width, height });
}

function validateRefractionFrame(frame) {
  if (
    !frame ||
    typeof frame !== 'object' ||
    !Array.isArray(frame.refractionLayers) ||
    frame.refractionLayers.length !== 2 ||
    typeof frame.refractionOffset !== 'number' ||
    !Number.isFinite(frame.refractionOffset)
  ) {
    throw new TypeError('frame 必須包含兩層有效折射資料與 refractionOffset');
  }

  for (const layer of frame.refractionLayers) {
    if (!layer || typeof layer !== 'object') {
      throw new TypeError('每一層折射資料都必須是物件');
    }

    for (const property of ['offsetX', 'offsetY', 'opacity', 'rotation']) {
      if (
        typeof layer[property] !== 'number' ||
        !Number.isFinite(layer[property])
      ) {
        throw new TypeError(`折射層的 ${property} 必須是有限數值`);
      }
    }

    if (layer.opacity < 0 || layer.opacity > 1) {
      throw new TypeError('折射層 opacity 必須介於 0 與 1');
    }
  }
}

function createStop(offset, red, green, blue, alpha) {
  const normalizedAlpha = clamp(alpha, 0, 1);
  return Object.freeze({
    alpha: normalizedAlpha,
    color: `rgb(${red} ${green} ${blue} / ${round(normalizedAlpha)})`,
    offset: round(offset),
  });
}

function createRefractionBand({
  alpha,
  baseGeometry,
  color,
  layer,
  refractionOffset,
  refractionOffsetScale,
  rotationScale,
  supportRatio,
  width,
  height,
}) {
  const offsetX = layer.offsetX +
    refractionOffset * width * refractionOffsetScale;
  const offsetY = layer.offsetY +
    refractionOffset * height * refractionOffsetScale * 0.18;
  const [startXRatio, startYRatio, endXRatio, endYRatio] = baseGeometry;
  const halfSupport = supportRatio / 2;
  const center = 0.5;
  const edge = halfSupport * 0.96;
  const inner = halfSupport * 0.34;

  return Object.freeze({
    alpha: round(clamp(layer.opacity * alpha, 0, 1)),
    geometry: Object.freeze([
      round(width * startXRatio + offsetX),
      round(height * startYRatio + offsetY),
      round(width * endXRatio + offsetX),
      round(height * endYRatio + offsetY),
    ]),
    offsetX: round(offsetX),
    offsetY: round(offsetY),
    rotationDegrees: round(
      layer.rotation + refractionOffset * rotationScale,
    ),
    stops: Object.freeze([
      createStop(0, ...color.shadow, 0),
      createStop(center - edge, ...color.shadow, 0.01),
      createStop(center - inner, ...color.warm, 0.32),
      createStop(center, ...color.highlight, 0.88),
      createStop(center + inner, ...color.warm, 0.28),
      createStop(center + edge, ...color.shadow, 0.01),
      createStop(1, ...color.shadow, 0),
    ]),
    supportRatio,
  });
}

/**
 * 解析以字腔高度為基準的細線樣式。
 *
 * 線寬不設固定像素下限，確保任何解析度都不會因 minimum width 反而超過
 * 液面厚度上限；Canvas renderer 可再乘上自己的 device scale。
 */
export function resolveMessageLiquidCanvasStyle(options) {
  const { height } = validateDimensions(options);

  return Object.freeze({
    bubbleBodyAlpha: 0.78,
    bubbleBodyWidth: round(height * BUBBLE_BODY_WIDTH_RATIO),
    bubbleHighlightAlpha: 0.92,
    bubbleHighlightWidth: round(height * BUBBLE_HIGHLIGHT_WIDTH_RATIO),
    meniscusCoreAlpha: 0.94,
    meniscusCoreWidth: round(height * MENISCUS_CORE_WIDTH_RATIO),
    meniscusDepthAlpha: 0.58,
    meniscusDepthWidth: round(height * MENISCUS_DEPTH_WIDTH_RATIO),
  });
}

/**
 * 把模型輸出的兩層流場轉為 Canvas 可直接建立 linear gradient 的窄折射帶。
 *
 * geometry 是 [x0, y0, x1, y1]；rotationDegrees、offsetX/Y 皆由當幀的
 * refractionLayers 與 refractionOffset 推導。兩層的可見 support 總和固定
 * 小於 22%，避免寬幅粉紅高光覆蓋整個酒體。
 */
export function resolveMessageLiquidRefractionBands(options) {
  const { width, height } = validateDimensions(options);
  const { frame } = options;
  validateRefractionFrame(frame);

  const [primaryLayer, secondaryLayer] = frame.refractionLayers;
  return Object.freeze([
    createRefractionBand({
      alpha: 0.9,
      baseGeometry: [0.24, 0.02, 0.76, 0.98],
      color: {
        highlight: [255, 252, 234],
        shadow: [119, 28, 53],
        warm: [245, 191, 147],
      },
      height,
      layer: primaryLayer,
      refractionOffset: frame.refractionOffset,
      refractionOffsetScale: 1,
      rotationScale: 24,
      supportRatio: PRIMARY_REFRACTION_SUPPORT_RATIO,
      width,
    }),
    createRefractionBand({
      alpha: 0.82,
      baseGeometry: [0.7, 0, 0.3, 1],
      color: {
        highlight: [255, 248, 225],
        shadow: [96, 17, 43],
        warm: [224, 132, 118],
      },
      height,
      layer: secondaryLayer,
      refractionOffset: frame.refractionOffset,
      refractionOffsetScale: -0.62,
      rotationScale: -19,
      supportRatio: SECONDARY_REFRACTION_SUPPORT_RATIO,
      width,
    }),
  ]);
}
