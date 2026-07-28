import { createLiquidSurfaceFrame } from './liquid-surface-model.mjs';
import {
  resolveMessageLiquidCanvasStyle,
  resolveMessageLiquidRefractionBands,
} from './message-liquid-canvas-style.mjs';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ACTIVE_VESSEL_SELECTOR =
  '.message-row[data-liquid-effect="active"] .message-vessel';
const MINIMUM_RENDER_SIZE = 0.5;
const MINIMUM_MESSAGE_OUTLINE_STROKE_WIDTH = 1;
const MESSAGE_OUTLINE_STROKE_FONT_RATIO = 0.022;
const MESSAGE_OUTLINE_STROKE_HEIGHT_FALLBACK_RATIO = 0.019;
const TEXT_NODE_TYPE = 3;
const MAXIMUM_CANVAS_DEVICE_PIXEL_RATIO = 3;
const MARQUEE_CANVAS_CHUNK_SCREEN_PIXELS = 512;
const MARQUEE_CANVAS_BUFFER_SCREEN_PIXELS = 384;
const VIEWPORT_INTERSECTION_EPSILON = 0.5;

let nextMaskIdentifier = 0;
const rendererByVessel = new WeakMap();
let liquidPipelineWarmed = false;
let liquidPipelineWarmPromise = null;

function createSvgElement(document, name) {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function setAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function setOpacity(element, value) {
  const opacity = String(value);
  element.setAttribute('opacity', opacity);
  // Inline style 必須高於靜態 CSS 外觀預設，0% 與 fallback 才能真正隱藏。
  element.style.setProperty('opacity', opacity);
}

function createGradientStop(document, offset, color, opacity = 1) {
  return setAttributes(createSvgElement(document, 'stop'), {
    offset,
    'stop-color': color,
    'stop-opacity': opacity,
  });
}

/**
 * 取得與訊息相同的排版來源。尺寸層保留完整中文與 Didot 數字 span，
 * 因此 mask 不需要重新猜測字距、字型 fallback 或混合字型的 advance。
 */
function getTypographySource(vessel) {
  return vessel.querySelector('.message-glyph-sizing');
}

function getOwningRow(vessel) {
  return vessel.closest('.message-row');
}

function restoreStaticFallback(vessel) {
  const row = getOwningRow(vessel);
  if (row) {
    row.dataset.liquidEffect = 'static';
  }
  delete vessel.dataset.liquidSvg;
}

function prefersReducedMotion() {
  return typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hashText(text, salt) {
  let hash = (0x811c9dc5 ^ salt) >>> 0;

  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash;
}

function normalizeSeed(seed, text, index) {
  if (Number.isSafeInteger(seed)) {
    return hashText(text, (seed + index) >>> 0);
  }
  return hashText(text, Math.imul(index + 1, 0x9e3779b1) >>> 0);
}

/** 與純模型相同的 deterministic hash，用來取得尚未 snap 的注入位置。 */
function hashUnit(seed, index) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

/** alpha mask 只允許字形本體，禁止繼承列層陰影或其他 paint effect。 */
function suppressInheritedPaintEffects(element) {
  element.style.setProperty('text-shadow', 'none');
  element.style.setProperty('filter', 'none');
  element.style.setProperty('opacity', '1');
}

function copyTypographyStyles(source, target) {
  const view = source.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') {
    return;
  }

  const computed = view.getComputedStyle(source);
  const copiedProperties = [
    'font-family',
    'font-size',
    'font-stretch',
    'font-style',
    'font-variant',
    'font-weight',
    'font-feature-settings',
    'font-kerning',
    'font-synthesis',
    'font-variation-settings',
    'font-variant-caps',
    'font-variant-east-asian',
    'font-variant-ligatures',
    'font-variant-numeric',
    'letter-spacing',
    'text-rendering',
    'word-spacing',
  ];

  for (const property of copiedProperties) {
    target.style.setProperty(property, computed.getPropertyValue(property));
  }
  suppressInheritedPaintEffects(target);
}

/**
 * 量出文字節點的實際單行位置。數字段落可直接量 span，其餘文字節點則
 * 必須使用 Range；這些數值已包含字距、kerning 與瀏覽器 fallback 字型。
 */
function measureTypographyNode(node) {
  if (node.nodeType !== TEXT_NODE_TYPE) {
    return node.getBoundingClientRect();
  }

  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect;
}

/**
 * 以零尺寸 inline-block 取得 CSS inline formatting context 的真實 baseline。
 * active SVG 與 HTML fallback 因此維持相同垂直基準，不需猜測各字型 ascent。
 */
function measureTypographyBaseline(source) {
  const probe = source.ownerDocument.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.setProperty('display', 'inline-block');
  probe.style.setProperty('inline-size', '0');
  probe.style.setProperty('block-size', '0');
  probe.style.setProperty('margin', '0');
  probe.style.setProperty('padding', '0');
  probe.style.setProperty('border', '0');
  probe.style.setProperty('font-size', '0');
  probe.style.setProperty('line-height', '0');
  probe.style.setProperty('vertical-align', 'baseline');

  source.append(probe);
  try {
    return probe.getBoundingClientRect().top;
  } finally {
    probe.remove();
  }
}

function createInkMeasurementContext(document) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context || typeof context.measureText !== 'function') {
    throw new Error('瀏覽器不支援訊息字形墨跡量測。');
  }
  context.textBaseline = 'alphabetic';
  return context;
}

/**
 * Canvas TextMetrics 的 actualBoundingBox* 是 Chromium 可取得的實際字形
 * 墨跡高度。SVG text.getBBox() 對部分 CJK／Didot 字型會回傳整個字型盒，
 * 甚至超出可見 viewBox，因此不能用來決定何時真正滿杯。
 */
function applyInkMeasurementTypography(context, styleSource) {
  const view = styleSource.ownerDocument.defaultView;
  const computed = view?.getComputedStyle(styleSource);
  if (!computed) {
    throw new Error('無法取得訊息字形量測樣式。');
  }

  /*
   * Canvas font parser 在目前 Electron 對 font-stretch: 100% shorthand 仍會
   * 整串拒絕並悄悄保留 10px sans-serif。stretch／caps 改由獨立屬性設定，
   * shorthand 只放所有 Chromium 版本都能可靠解析的四個核心欄位。
   */
  const font = [
    computed.fontStyle,
    computed.fontWeight,
    computed.fontSize,
    computed.fontFamily,
  ].join(' ');
  context.font = font;
  if (!context.font.includes(computed.fontSize)) {
    throw new Error('Canvas 未接受訊息實際字型與字級。');
  }

  for (const [property, value] of [
    ['direction', computed.direction],
    ['fontKerning', computed.fontKerning],
    ['fontStretch', computed.fontStretch],
    ['fontVariantCaps', computed.fontVariantCaps],
    ['letterSpacing', computed.letterSpacing],
    ['textRendering', computed.textRendering],
    ['wordSpacing', computed.wordSpacing],
  ]) {
    if (property in context && value) {
      context[property] = value;
    }
  }
}

/**
 * 由正式 DOM 排版建立唯一 canonical SVG glyph。每個 HTML run 都成為獨立
 * SVG <text>，並用實測 x／寬度保留中文、英文與 Didot 數字的混合排版。
 */
function createCanonicalGlyph(source, {
  scaleX,
  scaleY,
  vesselRect,
}) {
  const document = source.ownerDocument;
  const canonicalGlyph = createSvgElement(document, 'g');
  canonicalGlyph.classList.add('message-liquid-canonical-glyph');
  canonicalGlyph.setAttribute('fill', '#ffffff');
  canonicalGlyph.setAttribute('stroke', 'none');
  canonicalGlyph.setAttribute('aria-hidden', 'true');
  suppressInheritedPaintEffects(canonicalGlyph);

  const baseline = (
    measureTypographyBaseline(source) - vesselRect.top
  ) / scaleY;
  const measurementContext = createInkMeasurementContext(document);
  let fluidTop = Number.POSITIVE_INFINITY;
  let fluidRight = Number.NEGATIVE_INFINITY;
  let fluidBottom = Number.NEGATIVE_INFINITY;
  let fluidLeft = Number.POSITIVE_INFINITY;
  let runCount = 0;

  for (const node of source.childNodes) {
    const textContent = node.textContent || '';
    if (textContent.length === 0) {
      continue;
    }

    const styleSource = node.nodeType === TEXT_NODE_TYPE
      ? source
      : node;
    const rect = measureTypographyNode(node);
    const x = (rect.left - vesselRect.left) / scaleX;
    const width = rect.width / scaleX;
    if (![x, width, baseline].every(Number.isFinite)) {
      throw new Error('無法量測訊息 SVG 字形位置。');
    }

    applyInkMeasurementTypography(measurementContext, styleSource);
    const ink = measurementContext.measureText(textContent);
    const ascent = ink.actualBoundingBoxAscent;
    const descent = ink.actualBoundingBoxDescent;
    if (
      ![ascent, descent].every(Number.isFinite) ||
      ascent < 0 ||
      descent < 0 ||
      ascent + descent < MINIMUM_RENDER_SIZE
    ) {
      throw new Error('無法量測訊息字形的實際墨跡高度。');
    }
    fluidTop = Math.min(fluidTop, baseline - ascent);
    fluidRight = Math.max(fluidRight, x + width);
    fluidBottom = Math.max(fluidBottom, baseline + descent);
    fluidLeft = Math.min(fluidLeft, x);

    const text = setAttributes(createSvgElement(document, 'text'), {
      class: 'message-liquid-glyph-run',
      x,
      y: baseline,
      'dominant-baseline': 'alphabetic',
      'xml:space': 'preserve',
    });
    if (styleSource.matches?.('.message-number')) {
      text.classList.add('message-liquid-glyph-number');
    }
    if (width > MINIMUM_RENDER_SIZE) {
      text.setAttribute('textLength', String(width));
      text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    }
    copyTypographyStyles(styleSource, text);
    text.textContent = textContent;
    canonicalGlyph.append(text);
    runCount += 1;
  }

  if (runCount === 0) {
    throw new Error('訊息 SVG 字形沒有可繪製的文字 run。');
  }
  const fluidBounds = Object.freeze({
    height: fluidBottom - fluidTop,
    width: fluidRight - fluidLeft,
    x: fluidLeft,
    y: fluidTop,
  });
  if (
    ![
      fluidBounds.x,
      fluidBounds.y,
      fluidBounds.width,
      fluidBounds.height,
    ].every(Number.isFinite) ||
    fluidBounds.width < MINIMUM_RENDER_SIZE ||
    fluidBounds.height < MINIMUM_RENDER_SIZE
  ) {
    throw new Error('訊息字形的實際墨跡邊界無效。');
  }
  canonicalGlyph.dataset.message = source.textContent || '';
  canonicalGlyph.dataset.runCount = String(runCount);
  canonicalGlyph.dataset.fluidX = String(fluidBounds.x);
  canonicalGlyph.dataset.fluidY = String(fluidBounds.y);
  canonicalGlyph.dataset.fluidWidth = String(fluidBounds.width);
  canonicalGlyph.dataset.fluidHeight = String(fluidBounds.height);
  return Object.freeze({
    baseline,
    canonicalGlyph,
    fluidBounds,
  });
}

/** mask 與固定純白框都 clone 同一 canonical glyph，杜絕幾何漂移。 */
function cloneCanonicalGlyphs(canonicalGlyph, outlineStrokeWidth) {
  const maskGlyph = canonicalGlyph.cloneNode(true);
  maskGlyph.classList.remove('message-liquid-canonical-glyph');
  maskGlyph.classList.add('message-liquid-mask-glyph');
  setAttributes(maskGlyph, {
    fill: '#ffffff',
    stroke: 'none',
  });
  suppressInheritedPaintEffects(maskGlyph);

  const canvasMaskGlyph = maskGlyph.cloneNode(true);
  canvasMaskGlyph.classList.remove('message-liquid-mask-glyph');
  canvasMaskGlyph.classList.add('message-liquid-canvas-mask-glyph');

  const outlineGlyph = canonicalGlyph.cloneNode(true);
  outlineGlyph.classList.remove('message-liquid-canonical-glyph');
  outlineGlyph.classList.add('message-liquid-outline-glyph');
  setAttributes(outlineGlyph, {
    fill: 'none',
    stroke: '#ffffff',
    'stroke-width': outlineStrokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'paint-order': 'stroke',
  });
  suppressInheritedPaintEffects(outlineGlyph);
  return Object.freeze({ canvasMaskGlyph, maskGlyph, outlineGlyph });
}

function createWineDefinitions(document, identifiers) {
  const defs = createSvgElement(document, 'defs');

  const mask = setAttributes(createSvgElement(document, 'mask'), {
    id: identifiers.mask,
    'mask-type': 'alpha',
    maskUnits: 'userSpaceOnUse',
    maskContentUnits: 'userSpaceOnUse',
  });
  mask.classList.add('message-liquid-mask');
  mask.style.setProperty('mask-type', 'alpha');

  /*
   * Canvas 最後再通過一份固定 native glyph mask。此 mask 只在 sync/chunk
   * 跨界時 rasterize，動態酒體仍完全由 Canvas 合成。
   */
  const canvasMask = setAttributes(createSvgElement(document, 'mask'), {
    id: identifiers.canvasMask,
    'mask-type': 'alpha',
    maskUnits: 'userSpaceOnUse',
    maskContentUnits: 'userSpaceOnUse',
  });
  canvasMask.classList.add('message-liquid-canvas-mask');
  canvasMask.style.setProperty('mask-type', 'alpha');

  /* 所有內部光學層除字形 mask 外，再以當幀酒體路徑裁切。 */
  const fluidClip = setAttributes(createSvgElement(document, 'clipPath'), {
    id: identifiers.fluidClip,
    clipPathUnits: 'userSpaceOnUse',
  });
  fluidClip.classList.add('message-liquid-fluid-clip');
  const fluidClipPath = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-fluid-clip-path',
  });
  fluidClip.append(fluidClipPath);

  const bodyGradient = setAttributes(
    createSvgElement(document, 'linearGradient'),
    {
      id: identifiers.bodyGradient,
      gradientUnits: 'userSpaceOnUse',
    },
  );
  bodyGradient.append(
    createGradientStop(document, '0%', '#e1a088', 0.84),
    createGradientStop(document, '16%', '#c85e62', 0.9),
    createGradientStop(document, '47%', '#9d2947', 0.88),
    createGradientStop(document, '78%', '#71152f', 0.94),
    createGradientStop(document, '100%', '#4b0a20', 0.87),
  );

  const refractionGradient = setAttributes(
    createSvgElement(document, 'linearGradient'),
    {
      id: identifiers.refractionGradient,
      gradientUnits: 'userSpaceOnUse',
    },
  );
  refractionGradient.append(
    createGradientStop(document, '0%', '#ffffff', 0),
    createGradientStop(document, '19%', '#ffe1b3', 0.06),
    createGradientStop(document, '38%', '#fff7e1', 0.5),
    createGradientStop(document, '51%', '#e7987d', 0.08),
    createGradientStop(document, '71%', '#fffaf0', 0.25),
    createGradientStop(document, '100%', '#ffffff', 0),
  );

  const secondaryRefractionGradient = setAttributes(
    createSvgElement(document, 'linearGradient'),
    {
      id: identifiers.secondaryRefractionGradient,
      gradientUnits: 'userSpaceOnUse',
    },
  );
  secondaryRefractionGradient.append(
    createGradientStop(document, '0%', '#ffd7ad', 0),
    createGradientStop(document, '26%', '#ffd7ad', 0.08),
    createGradientStop(document, '43%', '#fffdf4', 0.34),
    createGradientStop(document, '49%', '#ffffff', 0.08),
    createGradientStop(document, '67%', '#f2a07f', 0.24),
    createGradientStop(document, '100%', '#f2a07f', 0),
  );

  const causticGradient = setAttributes(
    createSvgElement(document, 'radialGradient'),
    {
      id: identifiers.causticGradient,
      gradientUnits: 'userSpaceOnUse',
      cx: '0',
      cy: '0',
      fx: '-0.16',
      fy: '-0.12',
      r: '1',
    },
  );
  causticGradient.append(
    createGradientStop(document, '0%', '#fffdf0', 0.78),
    createGradientStop(document, '18%', '#ffd59e', 0.46),
    createGradientStop(document, '48%', '#d45b62', 0.18),
    createGradientStop(document, '100%', '#7d1735', 0),
  );

  const surfaceFocusGradient = setAttributes(
    createSvgElement(document, 'linearGradient'),
    {
      id: identifiers.surfaceFocusGradient,
      x1: '0%',
      y1: '0%',
      x2: '100%',
      y2: '0%',
    },
  );
  surfaceFocusGradient.append(
    createGradientStop(document, '0%', '#f3b687', 0),
    createGradientStop(document, '28%', '#ffe8bd', 0.35),
    createGradientStop(document, '50%', '#fffdf1', 0.82),
    createGradientStop(document, '72%', '#eaa17c', 0.32),
    createGradientStop(document, '100%', '#b63d54', 0),
  );

  const meniscusGradient = setAttributes(
    createSvgElement(document, 'linearGradient'),
    {
      id: identifiers.meniscusGradient,
      gradientUnits: 'userSpaceOnUse',
    },
  );
  meniscusGradient.append(
    createGradientStop(document, '0%', '#f1c48a', 0.42),
    createGradientStop(document, '18%', '#fff4d7', 0.92),
    createGradientStop(document, '43%', '#d7776d', 0.68),
    createGradientStop(document, '68%', '#fff8e8', 0.96),
    createGradientStop(document, '100%', '#e3a16f', 0.5),
  );

  const meniscusDepthGradient = setAttributes(
    createSvgElement(document, 'linearGradient'),
    {
      id: identifiers.meniscusDepthGradient,
      gradientUnits: 'userSpaceOnUse',
    },
  );
  meniscusDepthGradient.append(
    createGradientStop(document, '0%', '#70142f', 0.12),
    createGradientStop(document, '21%', '#df6e68', 0.42),
    createGradientStop(document, '46%', '#ffe0aa', 0.8),
    createGradientStop(document, '68%', '#bd3d55', 0.48),
    createGradientStop(document, '100%', '#5b0c26', 0.12),
  );

  defs.append(
    mask,
    canvasMask,
    fluidClip,
    bodyGradient,
    refractionGradient,
    secondaryRefractionGradient,
    causticGradient,
    surfaceFocusGradient,
    meniscusDepthGradient,
    meniscusGradient,
  );

  return Object.freeze({
    bodyGradient,
    canvasMask,
    causticGradient,
    defs,
    fluidClipPath,
    mask,
    meniscusDepthGradient,
    meniscusGradient,
    refractionGradient,
    secondaryRefractionGradient,
  });
}

function createPaintGroup(document, identifiers) {
  const paint = createSvgElement(document, 'g');
  paint.classList.add('message-liquid-paint');
  paint.setAttribute('mask', `url(#${identifiers.mask})`);

  /*
   * mask 與 paint 固定共用 SVG 根座標；只有內層幾何做文字偏移。若把
   * transform 直接放在 masked group，userSpaceOnUse mask 可能再套一次
   * 位移，造成酒液與字形在部分 Chromium compositor 上錯位。
   */
  const geometry = createSvgElement(document, 'g');
  geometry.classList.add('message-liquid-geometry');

  const body = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-body',
    fill: `url(#${identifiers.bodyGradient})`,
    opacity: '0',
  });

  const optics = setAttributes(createSvgElement(document, 'g'), {
    class: 'message-liquid-optics',
  });
  optics.setAttribute('clip-path', `url(#${identifiers.fluidClip})`);
  const primaryRefraction = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-refraction message-liquid-refraction-primary',
    fill: `url(#${identifiers.refractionGradient})`,
    opacity: '0',
  });
  const secondaryRefraction = setAttributes(
    createSvgElement(document, 'rect'),
    {
      class: 'message-liquid-refraction-secondary',
      fill: `url(#${identifiers.secondaryRefractionGradient})`,
      opacity: '0',
    },
  );
  const caustic = setAttributes(createSvgElement(document, 'rect'), {
    class: 'message-liquid-caustic',
    fill: `url(#${identifiers.causticGradient})`,
    opacity: '0',
  });
  const surfaceFocus = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-surface-focus',
    fill: `url(#${identifiers.surfaceFocusGradient})`,
    opacity: '0',
  });
  const bubbleBodies = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-bubble-bodies',
    fill: 'rgb(45 5 22 / 0.18)',
    stroke: 'rgb(255 221 174 / 0.52)',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    opacity: '0',
  });
  const bubbleHighlights = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-bubble-highlights',
    fill: 'none',
    stroke: 'rgb(255 250 231 / 0.82)',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    opacity: '0',
  });
  const meniscusDepth = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-meniscus-depth',
    fill: 'none',
    stroke: `url(#${identifiers.meniscusDepthGradient})`,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    opacity: '0',
  });
  const meniscus = setAttributes(createSvgElement(document, 'path'), {
    class: 'message-liquid-meniscus',
    fill: 'none',
    stroke: `url(#${identifiers.meniscusGradient})`,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    opacity: '0',
  });
  setOpacity(body, 0);
  setOpacity(primaryRefraction, 0);
  setOpacity(secondaryRefraction, 0);
  setOpacity(caustic, 0);
  setOpacity(surfaceFocus, 0);
  setOpacity(bubbleBodies, 0);
  setOpacity(bubbleHighlights, 0);
  setOpacity(meniscusDepth, 0);
  setOpacity(meniscus, 0);
  optics.append(
    primaryRefraction,
    secondaryRefraction,
    caustic,
    surfaceFocus,
    bubbleBodies,
    bubbleHighlights,
    meniscusDepth,
  );
  geometry.append(body, optics, meniscus);
  paint.append(geometry);

  return Object.freeze({
    body,
    bubbleBodies,
    bubbleHighlights,
    caustic,
    geometry,
    meniscus,
    meniscusDepth,
    optics,
    paint,
    primaryRefraction,
    secondaryRefraction,
    surfaceFocus,
  });
}

/**
 * Canvas 只負責會逐幀改變的酒液；canonical SVG 仍是唯一固定白框來源。
 * desynchronized 讓 Chromium 不必為每個 4K 畫格等待 CPU／compositor 往返，
 * alpha 則是後續 destination-in 字形裁切不可缺少的條件。
 */
function createLiquidCanvas(document) {
  const canvas = document.createElement('canvas');
  canvas.classList.add('message-liquid-canvas');
  canvas.setAttribute('aria-hidden', 'true');
  const context = canvas.getContext('2d', {
    alpha: true,
    desynchronized: true,
  });
  if (!context) {
    throw new Error('瀏覽器無法建立訊息酒液 Canvas 2D context。');
  }
  return Object.freeze({ canvas, context });
}

function createDetachedMaskCanvas(document) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) {
    throw new Error('瀏覽器無法建立訊息字形 alpha mask。');
  }
  return Object.freeze({ canvas, context });
}

function resolveCanvasPixelRatio(view) {
  const ratio = Number(view?.devicePixelRatio) || 1;
  return Math.min(MAXIMUM_CANVAS_DEVICE_PIXEL_RATIO, Math.max(1, ratio));
}

/** 實際 backing store 允許向上取整；回傳精確比例避免最右側少一列像素。 */
function sizeCanvas(canvas, logicalWidth, logicalHeight, pixelRatio) {
  const width = Math.max(1, Math.ceil(logicalWidth * pixelRatio));
  const height = Math.max(1, Math.ceil(logicalHeight * pixelRatio));
  canvas.width = width;
  canvas.height = height;
  return Object.freeze({
    scaleX: width / logicalWidth,
    scaleY: height / logicalHeight,
  });
}

function getRectRight(rect) {
  return Number.isFinite(rect?.right)
    ? rect.right
    : rect.left + rect.width;
}

function roundCanvasCoordinate(value) {
  return Number(value.toFixed(4));
}

/**
 * 靜態短訊息使用完整 canvas；跑馬燈則只保留 row 附近的局部視窗。
 * windowStart 以 vessel 的未 transform 邏輯座標表示，並每 512 個螢幕像素
 * 才跳至下一 chunk，避免每個動畫影格都重建文字 alpha mask。
 */
function createCanvasWindowPlan(vessel, metrics, viewport = null) {
  if (!metrics.isMarquee) {
    return Object.freeze({
      canvasWidth: metrics.layoutWidth,
      isVisible: true,
      key: `static:${metrics.layoutWidth}`,
      shouldPrepare: true,
      windowStart: 0,
    });
  }

  const row = getOwningRow(vessel);
  const rowRect = viewport?.rowRect ?? row?.getBoundingClientRect();
  const vesselRect = viewport?.vesselRect ?? vessel.getBoundingClientRect();
  const vesselScaleX = vesselRect?.width / metrics.layoutWidth;
  if (
    !rowRect ||
    !vesselRect ||
    !Number.isFinite(vesselScaleX) ||
    vesselScaleX <= 0
  ) {
    return Object.freeze({
      canvasWidth: metrics.layoutWidth,
      isVisible: true,
      key: `fallback:${metrics.layoutWidth}`,
      shouldPrepare: true,
      vesselRect,
      windowStart: 0,
    });
  }

  const rowLeft = rowRect.left;
  const rowRight = getRectRight(rowRect);
  const vesselLeft = vesselRect.left;
  const vesselRight = getRectRight(vesselRect);
  const visibleWidth = Math.min(rowRight, vesselRight) -
    Math.max(rowLeft, vesselLeft);
  const isVisible = visibleWidth > VIEWPORT_INTERSECTION_EPSILON;
  const bufferedLeft = rowLeft - MARQUEE_CANVAS_BUFFER_SCREEN_PIXELS;
  const bufferedRight = rowRight + MARQUEE_CANVAS_BUFFER_SCREEN_PIXELS;
  const preparedLeft = Math.max(bufferedLeft, vesselLeft);
  const preparedRight = Math.min(bufferedRight, vesselRight);

  if (preparedRight - preparedLeft <= VIEWPORT_INTERSECTION_EPSILON) {
    return Object.freeze({
      canvasWidth: metrics.canvasWidth,
      isVisible: false,
      key: metrics.windowKey,
      shouldPrepare: false,
      vesselRect,
      windowStart: metrics.windowStart,
    });
  }

  const chunkWidth = MARQUEE_CANVAS_CHUNK_SCREEN_PIXELS / vesselScaleX;
  const rawStart = Math.max(
    0,
    (preparedLeft - vesselLeft) / vesselScaleX,
  );
  const rawEnd = Math.min(
    metrics.layoutWidth,
    (preparedRight - vesselLeft) / vesselScaleX,
  );
  const windowStart = Math.max(
    0,
    Math.floor(rawStart / chunkWidth) * chunkWidth,
  );
  const windowEnd = Math.min(
    metrics.layoutWidth,
    Math.max(
      windowStart + chunkWidth,
      Math.ceil(rawEnd / chunkWidth) * chunkWidth,
    ),
  );
  const canvasWidth = Math.max(
    MINIMUM_RENDER_SIZE,
    windowEnd - windowStart,
  );
  const roundedStart = roundCanvasCoordinate(windowStart);
  const roundedWidth = roundCanvasCoordinate(canvasWidth);

  return Object.freeze({
    canvasWidth: roundedWidth,
    isVisible,
    key: `marquee:${roundedStart}:${roundedWidth}`,
    shouldPrepare: true,
    vesselRect,
    windowStart: roundedStart,
  });
}

function clearCanvas(context, canvas) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'copy';
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

/**
 * 每次 sync 僅在這裡 rasterize 一次文字 alpha。每幀只重用完成的 bitmap，
 * 不再要求 Chromium 對動態 SVG mask 重新做 4K glyph raster。
 */
function rasterizeGlyphMask({
  baseline,
  canvasHeight,
  canvasWidth,
  document,
  overlayTop,
  pixelRatio,
  scaleX,
  source,
  vesselRect,
  windowStart,
}) {
  const surface = createDetachedMaskCanvas(document);
  const backingScale = sizeCanvas(
    surface.canvas,
    canvasWidth,
    canvasHeight,
    pixelRatio,
  );
  const context = surface.context;
  context.setTransform(backingScale.scaleX, 0, 0, backingScale.scaleY, 0, 0);
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = '#ffffff';
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.textAlign = 'start';
  context.textBaseline = 'alphabetic';

  for (const node of source.childNodes) {
    const textContent = node.textContent || '';
    if (textContent.length === 0) {
      continue;
    }
    const styleSource = node.nodeType === TEXT_NODE_TYPE ? source : node;
    const rect = measureTypographyNode(node);
    const x = (rect.left - vesselRect.left) / scaleX;

    context.save();
    applyInkMeasurementTypography(context, styleSource);
    context.fillStyle = '#ffffff';
    context.textAlign = 'start';
    context.textBaseline = 'alphabetic';
    const measuredWidth = context.measureText(textContent).width;
    if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) {
      context.restore();
      throw new Error('無法 rasterize 訊息字形 alpha mask。');
    }
    context.translate(x - windowStart, baseline - overlayTop);
    /*
     * Canvas 已套用與 HTML 完全相同的 letterSpacing／kerning。不可再以整個
     * run 的 Range 寬度 scale glyph；那會把 Didot 0 的右弧撐出白框 10px。
     */
    context.fillText(textContent, 0, 0);
    context.restore();
  }

  return Object.freeze({
    ...surface,
    backingScale,
  });
}

/**
 * 在 cached alpha 中選擇靠近 seed、又確實有筆畫承接撞擊的固定欄位。
 * 只在 sync 做一次 readback；每幀沿用同一 ratio，液面焦點不會跳字。
 */
function findStableSourceXRatio({
  fluidBounds,
  glyphMask,
  probeStart,
  seed,
}) {
  const defaultRatio = 0.28 + hashUnit(seed, 313) * 0.44;
  const context = glyphMask.context;
  const { width, height } = glyphMask.canvas;
  if (width < 1 || height < 1) {
    return defaultRatio;
  }

  const pixels = context.getImageData(0, 0, width, height).data;
  const densities = new Float64Array(width);
  let maximumDensity = 0;
  for (let x = 0; x < width; x += 1) {
    let density = 0;
    for (let y = 0; y < height; y += 1) {
      density += pixels[(y * width + x) * 4 + 3] / 255;
    }
    densities[x] = density;
    maximumDensity = Math.max(maximumDensity, density);
  }
  if (maximumDensity <= 0) {
    return defaultRatio;
  }

  const desiredVesselX = fluidBounds.x + fluidBounds.width * defaultRatio;
  const desiredPixelX = (
    desiredVesselX - probeStart
  ) * glyphMask.backingScale.scaleX;
  const smoothingRadius = Math.max(
    1,
    Math.round(height * 0.012),
  );
  let bestPixelX = desiredPixelX;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let x = 0; x < width; x += 1) {
    let smoothedDensity = 0;
    const first = Math.max(0, x - smoothingRadius);
    const last = Math.min(width - 1, x + smoothingRadius);
    for (let sample = first; sample <= last; sample += 1) {
      smoothedDensity += densities[sample];
    }
    smoothedDensity /= last - first + 1;
    const densityScore = smoothedDensity / maximumDensity;
    const distancePenalty = Math.abs(x - desiredPixelX) / width * 0.38;
    const score = densityScore - distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      bestPixelX = x;
    }
  }

  const vesselX = probeStart +
    bestPixelX / glyphMask.backingScale.scaleX;
  return Math.min(0.86, Math.max(
    0.14,
    (vesselX - fluidBounds.x) / fluidBounds.width,
  ));
}

/**
 * 跑馬燈可能寬達數萬像素，不能為了找注入點建立整列 readback。這個 probe
 * 只包住 seed 預設位置附近數個字寬，建立後立即釋放；正式逐幀仍只使用
 * 當前可見 chunk 的 cached alpha mask。
 */
function resolveStableSourceXRatio({
  baseline,
  document,
  fluidBounds,
  layoutWidth,
  overlayHeight,
  overlayTop,
  pixelRatio,
  scaleX,
  seed,
  source,
  vesselRect,
}) {
  const defaultRatio = 0.28 + hashUnit(seed, 313) * 0.44;
  const desiredX = fluidBounds.x + fluidBounds.width * defaultRatio;
  const probeWidth = Math.min(
    layoutWidth,
    Math.max(192, fluidBounds.height * 4),
  );
  const probeStart = Math.max(
    0,
    Math.min(layoutWidth - probeWidth, desiredX - probeWidth / 2),
  );
  const probe = rasterizeGlyphMask({
    baseline,
    canvasHeight: overlayHeight,
    canvasWidth: probeWidth,
    document,
    overlayTop,
    pixelRatio,
    scaleX,
    source,
    vesselRect,
    windowStart: probeStart,
  });

  try {
    return findStableSourceXRatio({
      fluidBounds,
      glyphMask: probe,
      probeStart,
      seed,
    });
  } finally {
    probe.canvas.width = 0;
    probe.canvas.height = 0;
  }
}

function createCanvasGradient(context, coordinates, stops) {
  const gradient = context.createLinearGradient(...coordinates);
  for (const [offset, color] of stops) {
    gradient.addColorStop(offset, color);
  }
  return gradient;
}

function createBodyGradient(context, surfaceY, height) {
  const liquidDepth = Math.max(1, height - surfaceY);
  return createCanvasGradient(
    context,
    [0, surfaceY, 0, surfaceY + liquidDepth],
    [
      // 液面附近只有一層薄暖紅透光，往下才累積成 ruby 與 burgundy。
      [0, 'rgb(239 146 130 / 86%)'],
      [0.055, 'rgb(207 75 91 / 91%)'],
      [0.24, 'rgb(164 35 70 / 92%)'],
      [0.58, 'rgb(111 17 47 / 95%)'],
      [1, 'rgb(55 5 25 / 97%)'],
    ],
  );
}

function fillRefractionLayer(context, {
  alpha,
  bodyPath,
  coordinates,
  height,
  offsetX,
  offsetY,
  rotation,
  stops,
  width,
}) {
  if (alpha <= 0) {
    return;
  }
  context.save();
  context.clip(bodyPath);
  context.globalCompositeOperation = 'screen';
  context.globalAlpha = alpha;
  context.translate(width / 2 + offsetX, height / 2 + offsetY);
  context.rotate(rotation * Math.PI / 180);
  context.translate(-width / 2, -height / 2);
  context.fillStyle = createCanvasGradient(context, coordinates, stops);
  context.fillRect(-width * 0.25, -height * 0.2, width * 1.5, height * 1.4);
  context.restore();
}

function fillSurfaceFocus(context, frame, PathConstructor) {
  if (!frame.surfaceFocus.path || frame.surfaceFocus.opacity <= 0) {
    return;
  }
  const radius = Math.max(1, frame.surfaceFocus.propagationRadius);
  const path = new PathConstructor(frame.surfaceFocus.path);
  context.save();
  context.globalCompositeOperation = 'screen';
  context.globalAlpha = frame.surfaceFocus.opacity;
  context.fillStyle = createCanvasGradient(
    context,
    [frame.surfaceFocus.sourceX - radius, 0,
      frame.surfaceFocus.sourceX + radius, 0],
    [
      [0, 'rgb(243 182 135 / 0%)'],
      [0.28, 'rgb(255 232 189 / 35%)'],
      [0.5, 'rgb(255 253 241 / 82%)'],
      [0.72, 'rgb(234 161 124 / 32%)'],
      [1, 'rgb(182 61 84 / 0%)'],
    ],
  );
  context.fill(path);
  context.restore();
}

function fillCaustic(context, frame, bodyPath) {
  if (frame.caustic.opacity <= 0) {
    return;
  }
  context.save();
  context.clip(bodyPath);
  context.globalCompositeOperation = 'screen';
  context.globalAlpha = frame.caustic.opacity;
  context.translate(frame.caustic.centerX, frame.caustic.centerY);
  context.rotate(frame.caustic.rotation * Math.PI / 180);
  context.scale(
    Math.max(1, frame.caustic.radiusX),
    Math.max(1, frame.caustic.radiusY),
  );
  const gradient = context.createRadialGradient(-0.16, -0.12, 0, 0, 0, 1);
  gradient.addColorStop(0, 'rgb(255 253 240 / 78%)');
  gradient.addColorStop(0.18, 'rgb(255 213 158 / 46%)');
  gradient.addColorStop(0.48, 'rgb(212 91 98 / 18%)');
  gradient.addColorStop(1, 'rgb(125 23 53 / 0%)');
  context.fillStyle = gradient;
  context.fillRect(-1, -1, 2, 2);
  context.restore();
}

function strokeBubbles(context, frame, PathConstructor, style) {
  if (!frame.bubbleBodyPath || frame.bubbleOpacity <= 0) {
    return;
  }
  const bodies = new PathConstructor(frame.bubbleBodyPath);
  context.save();
  context.globalAlpha = frame.bubbleOpacity * style.bubbleBodyAlpha;
  context.fillStyle = 'rgb(45 5 22 / 18%)';
  context.strokeStyle = 'rgb(255 221 174 / 52%)';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = style.bubbleBodyWidth;
  context.fill(bodies);
  context.stroke(bodies);
  context.restore();

  if (!frame.bubbleHighlightPath) {
    return;
  }
  context.save();
  context.globalAlpha = frame.bubbleOpacity * style.bubbleHighlightAlpha;
  context.strokeStyle = 'rgb(255 250 231 / 82%)';
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = style.bubbleHighlightWidth;
  context.stroke(new PathConstructor(frame.bubbleHighlightPath));
  context.restore();
}

function strokeMeniscus(
  context,
  frame,
  PathConstructor,
  width,
  height,
  style,
) {
  if (!frame.meniscusPath || frame.meniscusOpacity <= 0) {
    return;
  }
  const path = new PathConstructor(frame.meniscusPath);
  const offset = frame.refractionOffset * width * 0.42;

  context.save();
  context.globalCompositeOperation = 'screen';
  context.globalAlpha =
    frame.meniscusOpacity * style.meniscusDepthAlpha;
  context.strokeStyle = createCanvasGradient(
    context,
    [offset, 0, width + offset, height * 0.08],
    [
      [0, 'rgb(112 20 47 / 12%)'],
      [0.21, 'rgb(223 110 104 / 42%)'],
      [0.46, 'rgb(255 224 170 / 80%)'],
      [0.68, 'rgb(189 61 85 / 48%)'],
      [1, 'rgb(91 12 38 / 12%)'],
    ],
  );
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = style.meniscusDepthWidth;
  context.stroke(path);
  context.restore();

  context.save();
  context.globalCompositeOperation = 'screen';
  context.globalAlpha =
    frame.meniscusOpacity * style.meniscusCoreAlpha;
  context.strokeStyle = createCanvasGradient(
    context,
    [offset * 0.72, 0, width + offset * 0.72, height * 0.08],
    [
      [0, 'rgb(241 196 138 / 42%)'],
      [0.18, 'rgb(255 244 215 / 92%)'],
      [0.43, 'rgb(215 119 109 / 68%)'],
      [0.68, 'rgb(255 248 232 / 96%)'],
      [1, 'rgb(227 161 111 / 50%)'],
    ],
  );
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = style.meniscusCoreWidth;
  context.stroke(path);
  context.restore();
}

/**
 * 在單一 Canvas 畫完一個 vessel 的完整酒體，再以 cached glyph bitmap 做
 * destination-in。這是最後一道硬邊界，任何酒色都不可能離開文字 alpha。
 */
function paintLiquidFrame({
  canvas,
  context,
  frame,
  glyphMask,
  metrics,
  PathConstructor,
}) {
  clearCanvas(context, canvas);
  if (frame.bodyOpacity <= 0) {
    return;
  }

  context.save();
  context.setTransform(
    metrics.canvasScaleX,
    0,
    0,
    metrics.canvasScaleY,
    0,
    0,
  );
  context.translate(
    metrics.offsetX - metrics.windowStart,
    metrics.offsetY - metrics.overlayTop,
  );
  const bodyPath = new PathConstructor(frame.bodyPath);
  context.globalAlpha = frame.bodyOpacity;
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = createBodyGradient(
    context,
    frame.surfaceY,
    metrics.height,
  );
  context.fill(bodyPath);
  const refractionBands = resolveMessageLiquidRefractionBands({
    frame,
    height: metrics.height,
    width: metrics.width,
  });
  for (const band of refractionBands) {
    fillRefractionLayer(context, {
      alpha: band.alpha,
      bodyPath,
      coordinates: band.geometry,
      height: metrics.height,
      offsetX: 0,
      offsetY: 0,
      rotation: band.rotationDegrees,
      stops: band.stops.map(({ color, offset }) => [offset, color]),
      width: metrics.width,
    });
  }
  fillSurfaceFocus(context, frame, PathConstructor);
  fillCaustic(context, frame, bodyPath);

  context.save();
  context.clip(bodyPath);
  strokeBubbles(context, frame, PathConstructor, metrics.canvasStyle);
  strokeMeniscus(
    context,
    frame,
    PathConstructor,
    metrics.width,
    metrics.height,
    metrics.canvasStyle,
  );
  context.restore();
  context.restore();

  // alpha mask 與可見畫布 backing store 尺寸相同，可直接做一次 bitmap 合成。
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(glyphMask.canvas, 0, 0, canvas.width, canvas.height);
  context.restore();
}

function collectActiveVessels(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return [];
  }
  if (root.matches?.('.message-vessel')) {
    return [root];
  }
  return [...root.querySelectorAll(ACTIVE_VESSEL_SELECTOR)];
}

/**
 * 建立單一訊息的 Canvas 酒液與 canonical SVG 白框。保留既有 export 名稱
 * 以維持 app 邊界穩定；Main ready 前不自行啟動任何時間軸。
 */
export function createMessageLiquidSvg(vessel, { seed = 0 } = {}) {
  if (
    !vessel ||
    typeof vessel.querySelector !== 'function' ||
    typeof vessel.append !== 'function'
  ) {
    throw new TypeError('訊息酒液 SVG 需要有效的 message vessel。');
  }

  const existing = rendererByVessel.get(vessel);
  if (existing) {
    return existing;
  }

  const source = getTypographySource(vessel);
  if (!source) {
    throw new TypeError('訊息酒液 SVG 找不到字形尺寸來源。');
  }

  const document = vessel.ownerDocument;
  const identifier = ++nextMaskIdentifier;
  const liquidMaskId = `message-liquid-mask-${identifier}`;
  const normalizedSeed = normalizeSeed(seed, source.textContent || '', 0);
  const identifiers = Object.freeze({
    mask: liquidMaskId,
    canvasMask: `message-liquid-canvas-mask-${identifier}`,
    fluidClip: `message-liquid-fluid-clip-${identifier}`,
    bodyGradient: `message-liquid-body-gradient-${identifier}`,
    refractionGradient: `message-liquid-refraction-gradient-${identifier}`,
    secondaryRefractionGradient:
      `message-liquid-refraction-secondary-gradient-${identifier}`,
    causticGradient: `message-liquid-caustic-gradient-${identifier}`,
    surfaceFocusGradient:
      `message-liquid-surface-focus-gradient-${identifier}`,
    meniscusGradient: `message-liquid-meniscus-gradient-${identifier}`,
    meniscusDepthGradient:
      `message-liquid-meniscus-depth-gradient-${identifier}`,
  });

  const svg = setAttributes(createSvgElement(document, 'svg'), {
    class: 'message-liquid-svg',
    'aria-hidden': 'true',
    focusable: 'false',
    preserveAspectRatio: 'none',
  });
  const definitions = createWineDefinitions(document, identifiers);
  const paths = createPaintGroup(document, identifiers);
  svg.append(definitions.defs, paths.paint);
  const { canvas, context } = createLiquidCanvas(document);
  canvas.style.setProperty('mask', `url(#${identifiers.canvasMask})`);
  canvas.style.setProperty('-webkit-mask', `url(#${identifiers.canvasMask})`);
  const shell = vessel.querySelector('.message-glyph-shell');
  if (!shell) {
    throw new TypeError('訊息酒液找不到固定白框排版來源。');
  }
  /*
   * deadline 使用與獨立 HTML 字形參考相同的 raster path，避免 Canvas 與
   * SVG 抗鋸齒 alpha 疊乘後，在細筆畫邊緣看似尚未裝滿。
   */
  const endpoint = shell.cloneNode(true);
  endpoint.className = 'message-glyph-layer message-liquid-endpoint';
  endpoint.setAttribute('aria-hidden', 'true');
  endpoint.style.setProperty('visibility', 'hidden');
  const PathConstructor = document.defaultView?.Path2D;
  if (typeof PathConstructor !== 'function') {
    throw new Error('瀏覽器不支援訊息酒液 Path2D。');
  }
  // Canvas 位於 SVG 下方；SVG 只保留不可變的 canonical 純白外框。
  vessel.append(canvas, endpoint, svg);

  let metrics = null;
  let glyphGeometry = null;
  let glyphMask = null;
  let disposed = false;
  let endpointVisible = false;

  /** 只在 99%→100% 或 reset 的狀態邊界寫 style，逐幀不得重觸發 text paint。 */
  function setEndpointVisible(visible) {
    if (endpointVisible === visible) {
      return;
    }
    endpointVisible = visible;
    endpoint.style.setProperty('visibility', visible ? 'visible' : 'hidden');
  }

  function releaseGlyphMask() {
    if (!glyphMask) {
      return;
    }
    glyphMask.canvas.width = 0;
    glyphMask.canvas.height = 0;
    glyphMask = null;
  }

  /** chunk 跨界時才建立新 backing 與 mask；同一 chunk 的每幀只重用 bitmap。 */
  function prepareCanvasWindow(plan, vesselRect) {
    if (
      !plan.shouldPrepare ||
      !metrics ||
      (glyphMask && plan.key === metrics.windowKey)
    ) {
      return glyphMask !== null;
    }

    const scaleX = vesselRect.width / metrics.layoutWidth;
    if (!Number.isFinite(scaleX) || scaleX <= 0) {
      return false;
    }
    const nextGlyphMask = rasterizeGlyphMask({
      baseline: metrics.baseline,
      canvasHeight: metrics.overlayHeight,
      canvasWidth: plan.canvasWidth,
      document,
      overlayTop: metrics.overlayTop,
      pixelRatio: metrics.pixelRatio,
      scaleX,
      source,
      vesselRect,
      windowStart: plan.windowStart,
    });
    const canvasScale = sizeCanvas(
      canvas,
      plan.canvasWidth,
      metrics.overlayHeight,
      metrics.pixelRatio,
    );

    releaseGlyphMask();
    glyphMask = nextGlyphMask;
    metrics = Object.freeze({
      ...metrics,
      canvasScaleX: canvasScale.scaleX,
      canvasScaleY: canvasScale.scaleY,
      canvasWidth: plan.canvasWidth,
      windowKey: plan.key,
      windowStart: plan.windowStart,
    });
    canvas.style.setProperty(
      'inset-inline-start',
      `${plan.windowStart}px`,
    );
    canvas.style.setProperty('inset-block-start', `${metrics.overlayTop}px`);
    canvas.style.setProperty('inline-size', `${plan.canvasWidth}px`);
    canvas.style.setProperty('block-size', `${metrics.overlayHeight}px`);
    setAttributes(definitions.canvasMask, {
      x: 0,
      y: 0,
      width: plan.canvasWidth,
      height: metrics.overlayHeight,
    });
    glyphGeometry?.canvasMaskGlyph.setAttribute(
      'transform',
      `translate(${-plan.windowStart} ${-metrics.overlayTop})`,
    );
    canvas.dataset.windowStart = String(plan.windowStart);
    canvas.dataset.windowWidth = String(plan.canvasWidth);
    return true;
  }

  function updateCanvasWindow(viewport = null) {
    const plan = createCanvasWindowPlan(vessel, metrics, viewport);
    const vesselRect = plan.vesselRect ??
      viewport?.vesselRect ??
      vessel.getBoundingClientRect();
    const prepared = !plan.shouldPrepare ||
      prepareCanvasWindow(plan, vesselRect);

    if (plan.isVisible && prepared && glyphMask) {
      canvas.style.removeProperty('visibility');
      return true;
    }
    canvas.style.setProperty('visibility', 'hidden');
    return false;
  }

  function sync() {
    if (disposed || !svg.isConnected) {
      return false;
    }

    const vesselRect = vessel.getBoundingClientRect();
    const sourceRect = source.getBoundingClientRect();
    if (
      vesselRect.width < MINIMUM_RENDER_SIZE ||
      vesselRect.height < MINIMUM_RENDER_SIZE ||
      sourceRect.width < MINIMUM_RENDER_SIZE ||
      sourceRect.height < MINIMUM_RENDER_SIZE
    ) {
      return false;
    }

    /*
     * getBoundingClientRect 已包含 render-resolution 與水平壓縮 transform；
     * SVG viewBox 則必須使用 transform 前的邏輯尺寸，否則會把相同比例套用
     * 兩次。以 offsetWidth 反推出局部比例，同時保留 sub-pixel 量測。
     */
    const vesselLayoutWidth = vessel.offsetWidth || vesselRect.width;
    const vesselLayoutHeight = vessel.offsetHeight || vesselRect.height;
    const scaleX = vesselRect.width / vesselLayoutWidth;
    const scaleY = vesselRect.height / vesselLayoutHeight;
    const sourceHeight = sourceRect.height / scaleY;
    const fontSize = Number.parseFloat(
      document.defaultView?.getComputedStyle(source).fontSize || '',
    );
    const outlineStrokeWidth = Math.max(
      MINIMUM_MESSAGE_OUTLINE_STROKE_WIDTH,
      Number.isFinite(fontSize)
        ? fontSize * MESSAGE_OUTLINE_STROKE_FONT_RATIO
        : sourceHeight * MESSAGE_OUTLINE_STROKE_HEIGHT_FALLBACK_RATIO,
    );
    const {
      baseline,
      canonicalGlyph,
      fluidBounds,
    } = createCanonicalGlyph(source, {
      scaleX,
      scaleY,
      vesselRect,
    });
    const outlinePadding = Math.max(2, outlineStrokeWidth * 1.25);
    const overlayTop = Math.min(0, fluidBounds.y - outlinePadding);
    const overlayBottom = Math.max(
      vesselLayoutHeight,
      fluidBounds.y + fluidBounds.height + outlinePadding,
    );
    const overlayHeight = overlayBottom - overlayTop;
    const sourceXRatio = resolveStableSourceXRatio({
      baseline,
      document,
      fluidBounds,
      layoutWidth: vesselLayoutWidth,
      overlayHeight,
      overlayTop,
      pixelRatio: resolveCanvasPixelRatio(document.defaultView),
      scaleX,
      seed: normalizedSeed,
      source,
      vesselRect,
    });
    // canonical 先接入 defs，mask 與 outline 隨後都 clone 同一份幾何。
    definitions.defs.prepend(canonicalGlyph);

    const pixelRatio = resolveCanvasPixelRatio(document.defaultView);
    const canvasStyle = resolveMessageLiquidCanvasStyle({
      height: fluidBounds.height,
      width: fluidBounds.width,
    });
    const nextMetrics = Object.freeze({
      baseline,
      canvasStyle,
      canvasScaleX: 1,
      canvasScaleY: 1,
      canvasWidth: 0,
      height: fluidBounds.height,
      isMarquee: getOwningRow(vessel)?.classList.contains('is-marquee') === true,
      layoutHeight: vesselLayoutHeight,
      layoutWidth: vesselLayoutWidth,
      offsetX: fluidBounds.x,
      offsetY: fluidBounds.y,
      overlayHeight,
      overlayTop,
      pixelRatio,
      sourceXRatio,
      width: fluidBounds.width,
      windowKey: null,
      windowStart: 0,
    });
    const {
      canvasMaskGlyph,
      maskGlyph,
      outlineGlyph,
    } = cloneCanonicalGlyphs(
      canonicalGlyph,
      outlineStrokeWidth,
    );

    svg.setAttribute(
      'viewBox',
      `0 ${overlayTop} ${vesselLayoutWidth} ${overlayHeight}`,
    );
    svg.style.setProperty('inset-block-start', `${overlayTop}px`);
    svg.style.setProperty('block-size', `${overlayHeight}px`);
    setAttributes(definitions.mask, {
      x: 0,
      y: overlayTop,
      width: vesselLayoutWidth,
      height: overlayHeight,
    });
    paths.geometry.setAttribute(
      'transform',
      `translate(${fluidBounds.x} ${fluidBounds.y})`,
    );
    paths.meniscus.setAttribute(
      'stroke-width',
      String(canvasStyle.meniscusCoreWidth),
    );
    paths.meniscusDepth.setAttribute(
      'stroke-width',
      String(canvasStyle.meniscusDepthWidth),
    );
    paths.bubbleBodies.setAttribute(
      'stroke-width',
      String(canvasStyle.bubbleBodyWidth),
    );
    paths.bubbleHighlights.setAttribute(
      'stroke-width',
      String(canvasStyle.bubbleHighlightWidth),
    );
    for (const paintLayer of [
      paths.secondaryRefraction,
      paths.caustic,
    ]) {
      setAttributes(paintLayer, {
        x: 0,
        y: 0,
        width: fluidBounds.width,
        height: fluidBounds.height,
      });
    }
    setAttributes(definitions.bodyGradient, {
      x1: -fluidBounds.width * 0.08,
      y1: 0,
      x2: fluidBounds.width * 1.08,
      y2: fluidBounds.height,
    });
    setAttributes(definitions.refractionGradient, {
      x1: -fluidBounds.width * 0.18,
      y1: fluidBounds.height * 0.06,
      x2: fluidBounds.width * 1.14,
      y2: fluidBounds.height * 0.91,
    });
    setAttributes(definitions.secondaryRefractionGradient, {
      x1: fluidBounds.width * 0.08,
      y1: fluidBounds.height,
      x2: fluidBounds.width * 0.92,
      y2: 0,
    });
    for (const gradient of [
      definitions.meniscusDepthGradient,
      definitions.meniscusGradient,
    ]) {
      setAttributes(gradient, {
        x1: 0,
        y1: 0,
        x2: fluidBounds.width,
        y2: fluidBounds.height * 0.08,
      });
    }

    // 先裝上完整的新幾何再移除舊節點，refit 過程不會閃出未遮罩酒色。
    definitions.mask.replaceChildren(maskGlyph);
    definitions.canvasMask.replaceChildren(canvasMaskGlyph);
    svg.append(outlineGlyph);
    glyphGeometry?.canonicalGlyph.remove();
    glyphGeometry?.outlineGlyph.remove();
    glyphGeometry = Object.freeze({
      canonicalGlyph,
      canvasMaskGlyph,
      outlineGlyph,
    });
    releaseGlyphMask();
    metrics = nextMetrics;
    const initialWindow = createCanvasWindowPlan(vessel, metrics, {
      rowRect: getOwningRow(vessel)?.getBoundingClientRect(),
      vesselRect,
    });
    if (initialWindow.shouldPrepare) {
      const initialGlyphMask = rasterizeGlyphMask({
        baseline,
        canvasHeight: overlayHeight,
        canvasWidth: initialWindow.canvasWidth,
        document,
        overlayTop,
        pixelRatio,
        scaleX,
        source,
        vesselRect,
        windowStart: initialWindow.windowStart,
      });
      const canvasScale = sizeCanvas(
        canvas,
        initialWindow.canvasWidth,
        overlayHeight,
        pixelRatio,
      );
      glyphMask = initialGlyphMask;
      metrics = Object.freeze({
        ...metrics,
        canvasScaleX: canvasScale.scaleX,
        canvasScaleY: canvasScale.scaleY,
        canvasWidth: initialWindow.canvasWidth,
        windowKey: initialWindow.key,
        windowStart: initialWindow.windowStart,
      });
      canvas.style.setProperty(
        'inset-inline-start',
        `${initialWindow.windowStart}px`,
      );
      canvas.style.setProperty('inset-block-start', `${overlayTop}px`);
      canvas.style.setProperty(
        'inline-size',
        `${initialWindow.canvasWidth}px`,
      );
      canvas.style.setProperty('block-size', `${overlayHeight}px`);
      setAttributes(definitions.canvasMask, {
        x: 0,
        y: 0,
        width: initialWindow.canvasWidth,
        height: overlayHeight,
      });
      canvasMaskGlyph.setAttribute(
        'transform',
        `translate(${-initialWindow.windowStart} ${-overlayTop})`,
      );
      canvas.dataset.windowStart = String(initialWindow.windowStart);
      canvas.dataset.windowWidth = String(initialWindow.canvasWidth);
    }
    if (initialWindow.isVisible && glyphMask) {
      canvas.style.removeProperty('visibility');
    } else {
      canvas.style.setProperty('visibility', 'hidden');
    }
    canvas.dataset.pixelRatio = String(pixelRatio);
    vessel.dataset.liquidSvg = 'ready';
    return true;
  }

  function render(
    { progress, timeMilliseconds, durationMilliseconds },
    viewport = null,
  ) {
    if (disposed || (metrics === null && !sync())) {
      return false;
    }

    const shouldPaintCanvas = updateCanvasWindow(viewport);

    const frame = createLiquidSurfaceFrame({
      progress,
      timeMilliseconds,
      durationMilliseconds,
      width: metrics.width,
      height: metrics.height,
      seed: normalizedSeed,
      sourceXRatio: metrics.sourceXRatio,
    });
    const isEndpoint = frame.fillRatio === 1;
    setEndpointVisible(isEndpoint);
    if (isEndpoint) {
      clearCanvas(context, canvas);
    } else if (shouldPaintCanvas) {
      paintLiquidFrame({
        canvas,
        context,
        frame,
        glyphMask,
        metrics,
        PathConstructor,
      });
    }

    /*
     * 下列 native SVG path 是結構／逐幀 QA 的 canonical signature。其 paint
     * group 由 CSS 強制 display:none，因此更新 attribute 不會觸發 4K raster。
     */
    paths.body.setAttribute('d', frame.bodyPath);
    paths.primaryRefraction.setAttribute('d', frame.bodyPath);
    definitions.fluidClipPath.setAttribute('d', frame.bodyPath);
    paths.surfaceFocus.setAttribute('d', frame.surfaceFocus.path);
    paths.bubbleBodies.setAttribute('d', frame.bubbleBodyPath);
    paths.bubbleHighlights.setAttribute('d', frame.bubbleHighlightPath);
    paths.meniscusDepth.setAttribute('d', frame.meniscusPath);
    paths.meniscus.setAttribute('d', frame.meniscusPath);
    const [primaryLayer, secondaryLayer] = frame.refractionLayers;
    const centerX = metrics.width / 2;
    const centerY = metrics.height / 2;
    definitions.refractionGradient.setAttribute(
      'gradientTransform',
      `translate(${
        primaryLayer.offsetX + frame.refractionOffset * metrics.width
      } ${primaryLayer.offsetY}) ` +
      `rotate(${primaryLayer.rotation} ${centerX} ${centerY})`,
    );
    definitions.secondaryRefractionGradient.setAttribute(
      'gradientTransform',
      `translate(${secondaryLayer.offsetX} ${secondaryLayer.offsetY}) ` +
      `rotate(${secondaryLayer.rotation} ${centerX} ${centerY})`,
    );
    definitions.causticGradient.setAttribute(
      'gradientTransform',
      `translate(${frame.caustic.centerX} ${frame.caustic.centerY}) ` +
      `rotate(${frame.caustic.rotation}) ` +
      `scale(${frame.caustic.radiusX} ${frame.caustic.radiusY})`,
    );
    const surfaceHighlightOffset =
      frame.refractionOffset * metrics.width * 0.42;
    definitions.meniscusDepthGradient.setAttribute(
      'gradientTransform',
      `translate(${surfaceHighlightOffset} 0)`,
    );
    definitions.meniscusGradient.setAttribute(
      'gradientTransform',
      `translate(${surfaceHighlightOffset * 0.72} 0)`,
    );
    setOpacity(paths.body, frame.bodyOpacity);
    setOpacity(
      paths.primaryRefraction,
      frame.bodyOpacity === 0 ? 0 : primaryLayer.opacity,
    );
    setOpacity(
      paths.secondaryRefraction,
      frame.bodyOpacity === 0 ? 0 : secondaryLayer.opacity,
    );
    setOpacity(paths.caustic, frame.caustic.opacity);
    setOpacity(paths.surfaceFocus, frame.surfaceFocus.opacity);
    setOpacity(paths.bubbleBodies, frame.bubbleOpacity * 0.78);
    setOpacity(paths.bubbleHighlights, frame.bubbleOpacity);
    setOpacity(paths.meniscusDepth, frame.meniscusOpacity * 0.68);
    setOpacity(paths.meniscus, frame.meniscusOpacity);
    return frame;
  }

  function reset() {
    if (disposed) {
      return false;
    }
    clearCanvas(context, canvas);
    setEndpointVisible(false);
    paths.body.removeAttribute('d');
    paths.primaryRefraction.removeAttribute('d');
    definitions.fluidClipPath.removeAttribute('d');
    paths.surfaceFocus.removeAttribute('d');
    paths.bubbleBodies.removeAttribute('d');
    paths.bubbleHighlights.removeAttribute('d');
    paths.meniscusDepth.removeAttribute('d');
    paths.meniscus.removeAttribute('d');
    definitions.refractionGradient.setAttribute(
      'gradientTransform',
      'translate(0 0)',
    );
    definitions.secondaryRefractionGradient.setAttribute(
      'gradientTransform',
      'translate(0 0)',
    );
    definitions.causticGradient.setAttribute(
      'gradientTransform',
      'translate(0 0) scale(1 1)',
    );
    definitions.meniscusDepthGradient.setAttribute(
      'gradientTransform',
      'translate(0 0)',
    );
    definitions.meniscusGradient.setAttribute(
      'gradientTransform',
      'translate(0 0)',
    );
    setOpacity(paths.body, 0);
    setOpacity(paths.primaryRefraction, 0);
    setOpacity(paths.secondaryRefraction, 0);
    setOpacity(paths.caustic, 0);
    setOpacity(paths.surfaceFocus, 0);
    setOpacity(paths.bubbleBodies, 0);
    setOpacity(paths.bubbleHighlights, 0);
    setOpacity(paths.meniscusDepth, 0);
    setOpacity(paths.meniscus, 0);
    return true;
  }

  function fallback() {
    if (disposed) {
      return false;
    }
    restoreStaticFallback(vessel);
    reset();
    return true;
  }

  function setWarmupOpacity(value) {
    if (disposed) {
      return false;
    }
    if (value === null) {
      canvas.style.removeProperty('opacity');
      endpoint.style.removeProperty('opacity');
      return true;
    }
    canvas.style.setProperty('opacity', String(value));
    endpoint.style.setProperty('opacity', String(value));
    return true;
  }

  function dispose() {
    if (disposed) {
      return;
    }
    reset();
    disposed = true;
    rendererByVessel.delete(vessel);
    canvas.remove();
    endpoint.remove();
    svg.remove();
    canvas.width = 0;
    canvas.height = 0;
    releaseGlyphMask();
    delete vessel.dataset.liquidSvg;
  }

  const renderer = Object.freeze({
    canvas,
    dispose,
    fallback,
    maskId: liquidMaskId,
    render,
    reset,
    seed: normalizedSeed,
    setWarmupOpacity,
    svg,
    sync,
    vessel,
  });
  rendererByVessel.set(vessel, renderer);
  return renderer;
}

/**
 * 在字型、固定字級、壓縮與跑馬燈全部完成後同步每一個 active vessel。
 * 任一副本建立失敗只讓該列退回白色實心字，不會破壞其他訊息。
 */
export function syncMessageLiquidSvgs(root, { seed = 0 } = {}) {
  const vessels = collectActiveVessels(root);
  const renderers = [];
  const seedByRow = new Map();

  if (prefersReducedMotion()) {
    for (const vessel of vessels) {
      restoreStaticFallback(vessel);
    }
    return Object.freeze(renderers);
  }

  for (let index = 0; index < vessels.length; index += 1) {
    const vessel = vessels[index];
    const row = getOwningRow(vessel);
    if (row?.dataset.liquidEffect !== 'active') {
      continue;
    }

    try {
      if (!seedByRow.has(row)) {
        seedByRow.set(row, normalizeSeed(
          seed,
          getTypographySource(vessel)?.textContent || '',
          seedByRow.size,
        ));
      }
      const renderer = createMessageLiquidSvg(vessel, {
        // 同一列的兩份跑馬燈共用 seed，移動接縫不會突然換一片液面。
        seed: seedByRow.get(row),
      });
      if (!renderer.sync()) {
        throw new Error('訊息字形尚未取得可繪製尺寸。');
      }
      renderers.push(renderer);
    } catch (error) {
      rendererByVessel.get(vessel)?.dispose();
      if (row) {
        row.dataset.liquidEffect = 'static';
      }
      restoreStaticFallback(vessel);
    }
  }

  return Object.freeze(renderers);
}

async function waitForWarmupPaint(view) {
  await new Promise((resolve) => {
    view.requestAnimationFrame(() => view.requestAnimationFrame(resolve));
  });
  // 4K Canvas backing store 的首次 GPU upload 仍可能晚於 rAF callback；
  // 預熱需留出 compositor 時間，不能把首次 upload 延後到正式計時。
  await new Promise((resolve) => view.setTimeout(resolve, 120));
}

/**
 * 首次實際顯示前，以同一批 Canvas／cached mask／漸層預熱 Chromium 4K
 * 合成管線。Canvas 僅 0.2% 不透明，白色固定外框仍正常可見；
 * 預熱完成後必須先恢復 0% 空杯，Main 才會開始頁面計時。
 */
export async function warmMessageLiquidPipeline(
  root,
  { durationMilliseconds = 1_000 } = {},
) {
  if (liquidPipelineWarmed) {
    return true;
  }
  if (liquidPipelineWarmPromise !== null) {
    return liquidPipelineWarmPromise;
  }
  const view = root?.ownerDocument?.defaultView;
  const renderers = collectActiveVessels(root)
    .map((vessel) => rendererByVessel.get(vessel))
    .filter(Boolean);
  if (
    renderers.length === 0 ||
    !view ||
    typeof view.requestAnimationFrame !== 'function' ||
    !Number.isFinite(durationMilliseconds) ||
    durationMilliseconds <= 0
  ) {
    return false;
  }

  liquidPipelineWarmPromise = (async () => {
    try {
      for (const renderer of renderers) {
        renderer.setWarmupOpacity(0.002);
      }
      for (const progress of [0.18, 0.45, 0.72, 0.92, 1]) {
        for (const renderer of renderers) {
          if (!renderer.render({
            progress,
            timeMilliseconds: durationMilliseconds * progress,
            durationMilliseconds,
          })) {
            throw new Error('酒液合成管線預熱失敗。');
          }
        }
        await waitForWarmupPaint(view);
      }
      for (const renderer of renderers) {
        renderer.render({
          progress: 0,
          timeMilliseconds: 0,
          durationMilliseconds,
        });
      }
      await waitForWarmupPaint(view);
      liquidPipelineWarmed = true;
      return true;
    } catch {
      for (const renderer of renderers) {
        renderer.reset();
      }
      return false;
    } finally {
      for (const renderer of renderers) {
        renderer.setWarmupOpacity(null);
      }
      liquidPipelineWarmPromise = null;
    }
  })();
  return liquidPipelineWarmPromise;
}

/**
 * 由 app 的單一 requestAnimationFrame 時鐘套用同一個液位進度。每列保留
 * 自己的 seed，因此三列不會像複製貼上；同列跑馬燈副本仍同步上升。
 */
export function renderMessageLiquidFrame(
  root,
  { progress, timeMilliseconds, durationMilliseconds },
) {
  const vessels = collectActiveVessels(root);
  const rowRectByRow = new Map();
  const frameOptions = {
    progress,
    timeMilliseconds,
    durationMilliseconds,
  };
  let renderedCount = 0;

  for (const vessel of vessels) {
    const renderer = rendererByVessel.get(vessel);
    if (!renderer) {
      continue;
    }

    try {
      const row = getOwningRow(vessel);
      let viewport = null;
      if (row?.classList.contains('is-marquee')) {
        if (!rowRectByRow.has(row)) {
          rowRectByRow.set(row, row.getBoundingClientRect());
        }
        viewport = {
          rowRect: rowRectByRow.get(row),
          vesselRect: vessel.getBoundingClientRect(),
        };
      }
      if (renderer.render(frameOptions, viewport)) {
        renderedCount += 1;
      }
    } catch (error) {
      renderer.fallback();
    }
  }

  return renderedCount;
}

/** 移除指定根節點內的 SVG，供換頁、設定更新與 Renderer dispose 使用。 */
export function resetMessageLiquidSvgs(root, { fallback = false } = {}) {
  const vessels = root?.matches?.('.message-vessel')
    ? [root]
    : [...(root?.querySelectorAll?.('.message-vessel') || [])];

  for (const vessel of vessels) {
    const renderer = rendererByVessel.get(vessel);
    if (!renderer) {
      continue;
    }
    if (fallback) {
      renderer.fallback();
    }
    renderer.dispose();
  }
}
