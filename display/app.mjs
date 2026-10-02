import { createDisplayClock } from './date-time.mjs';
import { createDisplayController } from './display-controller.mjs';
import { createPageProgressReporter } from './page-progress.mjs';
import {
  classifyLogoAlpha,
  LOGO_TREATMENTS,
} from './logo-appearance.mjs';
import { calculateLogoLayoutScales } from './logo-size.mjs';
import {
  createMessageBackgroundLoader,
} from './message-background-loader.mjs';
import {
  createMessageLiquidAnimator,
} from './message-liquid-progress.mjs';
import {
  renderMessageLiquidFrame,
  resetMessageLiquidSvgs,
  syncMessageLiquidSvgs,
  warmMessageLiquidPipeline,
} from './message-liquid-svg.mjs';
import { createMessageTypographyPlan } from './message-typography.mjs';
import { createDisplaySettingsController } from './settings-controller.mjs';
import { SAFE_DISPLAY_SETTINGS } from './settings-state.mjs';
import {
  createStandbyBackgroundPlayer,
} from './standby-background-player.mjs';
import { createSandTransition } from './sand-transition.mjs';
import { createSandTimeline } from './sand-timeline.mjs';
import { createSandWebglRenderer } from './sand-webgl-renderer.mjs';
import {
  calculateResponsiveFontBounds,
  findLargestFittingFontSize,
} from './text-fit.mjs';

const EMERGENCY_GRID_CELL_COUNT = 9;
const EMERGENCY_GLYPHS = Object.freeze({
  inspection: '5',
  release: '8',
});
const FIT_PRECISION_PX = 0.25;
const MESSAGE_LINE_HEIGHT = 1.08;
const LOGO_ALPHA_SAMPLE_EDGE = 64;
const SAND_TRANSITION_DURATION_MS = 2_800;
const LAYOUT_GENERATION_STORAGE_KEY = 'displaycore-layout-generation';
const SUPPORTS_IDLE_CALLBACK =
  typeof globalThis.requestIdleCallback === 'function' &&
  typeof globalThis.cancelIdleCallback === 'function';
const requestSandPreparationIdle = SUPPORTS_IDLE_CALLBACK
  ? (callback) => globalThis.requestIdleCallback(callback, { timeout: 1_000 })
  : (callback) => globalThis.setTimeout(callback, 0);
const cancelSandPreparationIdle = SUPPORTS_IDLE_CALLBACK
  ? (handle) => globalThis.cancelIdleCallback(handle)
  : (handle) => globalThis.clearTimeout(handle);
const messageLiquidMotionPreference =
  typeof globalThis.matchMedia === 'function'
    ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

const elements = Object.freeze({
  renderSurface: document.getElementById('display-render-surface'),
  stage: document.getElementById('display-stage'),
  announcement: document.getElementById('display-announcement'),
  normalLayer: document.getElementById('normal-layer'),
  standbyBackgroundLayer: document.getElementById('standby-background-layer'),
  standbyBackgroundImages: Object.freeze([
    document.getElementById('standby-background-image'),
    document.getElementById('standby-background-image-buffer'),
  ]),
  sandCanvas: document.getElementById('standby-sand-transition'),
  sandParticleCanvas: document.getElementById('standby-sand-particles'),
  chrome: document.getElementById('display-chrome'),
  logoFrame: document.getElementById('logo-frame'),
  logo: document.getElementById('display-logo'),
  clock: document.getElementById('display-clock'),
  pageLayer: document.getElementById('page-layer'),
  fillLayer: document.getElementById('fill-layer'),
});

let presentationController = null;
let settingsController = null;
let pageProgressReporter = null;
let unsubscribeRefitRequested = null;
let unsubscribeOutputAdjustment = null;
let currentPresentation = null;
let currentSettings = SAFE_DISPLAY_SETTINGS;
let currentDisplayEpoch = 0;
let renderGeneration = 0;
let fitFrame = null;
let expectedLogoUrl = null;
let logoReady = false;
let expectedStandbyBackgroundUrl = null;
let activeStandbyBackgroundImage = null;
let pendingStandbyBackgroundImage = null;
let standbyBackgroundReady = false;
let sandOutgoingImage = null;
let sandCoverCrop = null;
let sandMaskImageData = null;
let sandParticleImageData = null;
let sandParticleSourcePixels = null;
let sandPreparationHandle = null;
let sandDustColumnStrengths = null;
let sandDustColumnStrengthsWidth = 0;
let sandPreparedViewportWidth = 0;
let sandPreparedViewportHeight = 0;
let sandPreparedScrimSignature = null;
let clockHasValue = false;
let clockSignature = null;
let messageBackgroundGeneration = 0;
let messageBackgroundReadyPromise = Promise.resolve(true);
let liquidMotionFallbackScope = null;

function readStoredLayoutGeneration() {
  try {
    const value = Number.parseInt(
      sessionStorage.getItem(LAYOUT_GENERATION_STORAGE_KEY) || '0',
      10,
    );
    return Number.isSafeInteger(value) &&
      value >= 0 &&
      value < Number.MAX_SAFE_INTEGER
      ? value
      : 0;
  } catch {
    return 0;
  }
}

function storeLayoutGeneration(value) {
  try {
    sessionStorage.setItem(LAYOUT_GENERATION_STORAGE_KEY, String(value));
  } catch {
    // 同一 Renderer 仍保留記憶體內單調值；儲存失敗只影響手動 reload。
  }
}

/** 只接受 Main 在 Display 真正可見後核發的單欄位 refit 世代。 */
function handleRefitRequested(payload) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, 'displayEpoch') ||
    !Number.isSafeInteger(payload.displayEpoch) ||
    payload.displayEpoch < 1 ||
    payload.displayEpoch < currentDisplayEpoch
  ) {
    return;
  }

  currentDisplayEpoch = payload.displayEpoch;
  scheduleFit();
}

const clock = createDisplayClock({
  render(value) {
    const previousClockHasValue = clockHasValue;

    if (value === null) {
      elements.clock.textContent = '';
      elements.clock.removeAttribute('datetime');
      elements.clock.hidden = true;
      clockHasValue = false;
    } else {
      elements.clock.textContent = value.text;
      elements.clock.dateTime = value.dateTime;
      elements.clock.hidden = false;
      clockHasValue = true;
    }

    updateChromeVisibility();
    // 每分鐘只更新文字；若可見性不變，不重建正在播放的跑馬燈。
    if (clockHasValue !== previousClockHasValue) {
      scheduleFit();
    }
  },
});
const standbyBackgroundPlayer = createStandbyBackgroundPlayer({
  onSourceChange: applyStandbyBackgroundSource,
});
const messageBackgroundLoader = createMessageBackgroundLoader();
const messageLiquidAnimator = createMessageLiquidAnimator({
  onComplete({ revision, layoutGeneration }) {
    pageProgressReporter?.liquidComplete(revision, layoutGeneration);
  },
  onFailure() {
    const layoutGeneration = Number(elements.stage.dataset.layoutGeneration);
    disableMessageLiquidEffect();
    if (Number.isSafeInteger(layoutGeneration)) {
      pageProgressReporter?.liquidComplete(
        currentPresentation?.revision,
        layoutGeneration,
      );
    }
  },
  renderFrame(frame) {
    const expectedCount = elements.pageLayer.querySelectorAll(
      '.message-row[data-liquid-effect="active"] .message-vessel',
    ).length;
    const renderedCount = renderMessageLiquidFrame(elements.pageLayer, frame);

    if (expectedCount > 0 && renderedCount !== expectedCount) {
      throw new Error('訊息酒液 SVG 未能繪製全部字形。');
    }
  },
  shouldReduceMotion() {
    return messageLiquidMotionPreference?.matches === true;
  },
});
const sandContext = elements.sandCanvas.getContext('2d', { alpha: true });
const sandWebglRenderer = createSandWebglRenderer({
  canvas: elements.sandParticleCanvas,
});
const sandParticleContext = sandWebglRenderer === null
  ? elements.sandParticleCanvas.getContext('2d', { alpha: true })
  : null;
const sandMaskCanvas = document.createElement('canvas');
const sandMaskContext = sandMaskCanvas.getContext('2d', { alpha: true });
const sandParticleSourceCanvas = document.createElement('canvas');
const sandParticleSourceContext = sandParticleSourceCanvas.getContext('2d', {
  alpha: true,
  willReadFrequently: true,
});
const sandTransition = sandWebglRenderer === null
  ? createSandTransition({ onFrame: drawStandbySandFrame })
  : createSandTimeline({ onFrame: drawStandbySandFrame });
elements.standbyBackgroundLayer.dataset.sandRenderer =
  sandWebglRenderer === null ? 'canvas-2d' : 'webgl';

function cancelPendingFit() {
  renderGeneration += 1;
  pageProgressReporter?.cancel();

  if (fitFrame !== null) {
    cancelAnimationFrame(fitFrame);
    fitFrame = null;
  }
}

function clearVisualLayers() {
  cancelPendingFit();
  liquidMotionFallbackScope = null;
  messageLiquidAnimator.reset();
  resetMessageLiquidSvgs(elements.pageLayer);
  const leavingStandby = currentPresentation?.mode !== 'blank';
  if (leavingStandby) {
    cancelScheduledSandPreparation();
  }
  cancelStandbySandTransition({ releaseBuffers: leavingStandby });
  elements.pageLayer.textContent = '';
  elements.fillLayer.textContent = '';
  elements.standbyBackgroundLayer.hidden = true;
  for (const image of elements.standbyBackgroundImages) {
    image.hidden = true;
  }
  elements.pageLayer.removeAttribute('style');
  elements.stage.dataset.fittedRevision = '';
  elements.stage.dataset.fittedSettingsRevision = '';
  elements.stage.dataset.layoutGeneration = '';
  elements.stage.dataset.marqueeCount = '0';
  elements.stage.dataset.minimumFontClamped = 'false';
}

function updateAnnouncement(message, priority) {
  // 先切換播報優先級再更新內容，確保本次變更使用正確的 live-region 模式。
  elements.announcement.setAttribute('aria-live', priority);
  elements.announcement.textContent = message;
}

/** 安全建立混合字型內容；不使用 innerHTML，也不改寫原始訊息。 */
function appendMessageTypography(target, runs) {
  for (const run of runs) {
    if (run.kind === 'number') {
      const number = document.createElement('span');
      number.className = 'message-number';
      number.textContent = run.text;
      target.append(number);
      continue;
    }

    target.append(document.createTextNode(run.text));
  }
}

/**
 * 建立唯一排版來源與固定純白外框。SVG 酒液會在最終排版完成後才建立，
 * 並複製 sizing 內容成 alpha mask，避免中文、英文與 Didot 數字錯位。
 */
function createMessageVessel(message, className) {
  const typography = createMessageTypographyPlan(message);
  const vessel = document.createElement('span');
  vessel.className = `${className} message-vessel`;
  vessel.setAttribute('aria-hidden', 'true');
  vessel.dataset.liquidCompatible = String(typography.liquidCompatible);

  const sizing = document.createElement('span');
  sizing.className = 'message-glyph-layer message-glyph-sizing';
  appendMessageTypography(sizing, typography.runs);

  const shell = document.createElement('span');
  shell.className = 'message-glyph-layer message-glyph-shell';
  appendMessageTypography(shell, typography.runs);
  vessel.append(sizing, shell);

  return vessel;
}

function createStaticMessage(row, message) {
  row.textContent = '';
  row.classList.remove('is-marquee', 'is-compressed');
  row.style.removeProperty('--compression-ratio');
  row.setAttribute('aria-label', message);

  const text = createMessageVessel(message, 'message-text');
  row.append(text);
  return text;
}

function getRows() {
  return [...elements.pageLayer.querySelectorAll('.message-row')];
}

function pageFitsAt(fontSize, rows) {
  elements.pageLayer.style.fontSize = `${fontSize}px`;

  return rows.every((row) => {
    const message = row.querySelector('.message-text');

    if (!message) {
      return false;
    }

    const textBox = message.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    return (
      textBox.width <= rowBox.width + 0.5 &&
      textBox.height <= rowBox.height + 0.5
    );
  });
}

function activateMarquee(row, message) {
  row.textContent = '';
  row.classList.add('is-marquee');
  row.setAttribute('aria-label', message);

  const track = document.createElement('span');
  track.className = 'marquee-track';
  track.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < 2; index += 1) {
    const copy = document.createElement('span');
    copy.className = 'marquee-copy';
    copy.append(createMessageVessel(message, 'marquee-message'));
    track.append(copy);
  }

  row.append(track);

  const firstCopy = track.querySelector('.marquee-copy');
  const distance = firstCopy?.getBoundingClientRect().width ||
    row.getBoundingClientRect().width;
  const speed = Math.max(
    48,
    elements.stage.getBoundingClientRect().width * 0.045,
  );
  const durationSeconds = Math.max(8, distance / speed);
  track.style.setProperty('--marquee-duration', `${durationSeconds}s`);
}

function compressOverflowingRows(rows) {
  for (const row of rows) {
    const message = row.querySelector('.message-text');
    const textWidth = message?.getBoundingClientRect().width || 0;
    const rowWidth = row.getBoundingClientRect().width;

    if (message && textWidth > rowWidth && textWidth > 0) {
      row.classList.add('is-compressed');
      row.style.setProperty(
        '--compression-ratio',
        String(rowWidth / textWidth),
      );
    }
  }
}

/** 一般訊息固定字級後，僅針對真正水平溢位的列套用完整文字保護。 */
function protectOverflowingRows(rows) {
  const overflowingRows = rows.filter((row) => {
    const message = row.querySelector('.message-text');
    return message &&
      message.getBoundingClientRect().width >
        row.getBoundingClientRect().width + 0.5;
  });

  if (currentSettings.marquee.enabled) {
    for (const row of overflowingRows) {
      activateMarquee(row, row.dataset.message || '');
    }
    return;
  }

  // 操作者停用跑馬燈時只水平壓縮，不改變該列的固定字級。
  compressOverflowingRows(overflowingRows);
}

/** 動效無法與 Main 的頁面生命週期同步時，安全退回可讀的白色實心字。 */
function disableMessageLiquidEffect() {
  resetMessageLiquidSvgs(elements.pageLayer, { fallback: true });
  for (const row of getRows()) {
    if (row.dataset.liquidEffect === 'active') {
      row.dataset.liquidEffect = 'static';
    }
  }
}

/**
 * 系統在訊息播放途中切換降低動態時，只停止 Renderer 的裝飾時鐘並退回白字。
 * 切回一般動態不處理，確保同一頁不會從中途重新倒酒；下一頁會重新 prepare。
 */
function handleMessageLiquidMotionPreferenceChange() {
  if (messageLiquidMotionPreference?.matches !== true) {
    return;
  }

  liquidMotionFallbackScope = Object.freeze({
    presentationRevision: currentPresentation?.revision ?? null,
    settingsRevision: currentSettings.revision,
  });
  const layoutGeneration = Number(elements.stage.dataset.layoutGeneration);
  if (Number.isSafeInteger(layoutGeneration)) {
    pageProgressReporter?.liquidComplete(
      currentPresentation?.revision,
      layoutGeneration,
    );
  }
  messageLiquidAnimator.reset();
  disableMessageLiquidEffect();
}

/** 以最長跑馬燈 traversal 與設定最短秒數的較大值作為實際顯示時間。 */
function calculateEffectivePageDurationMilliseconds(tracks) {
  const configuredDuration = Number.isSafeInteger(
    currentPresentation?.pageDurationSeconds,
  )
    ? currentPresentation.pageDurationSeconds * 1_000
    : 0;
  let effectiveDuration = configuredDuration;

  for (const track of tracks) {
    const durationSeconds = Number.parseFloat(
      track.style.getPropertyValue('--marquee-duration'),
    );
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      effectiveDuration = Math.max(
        effectiveDuration,
        durationSeconds * 1_000,
      );
    }
  }

  return effectiveDuration;
}

function startMessageLiquidEffect(revision, layoutGeneration) {
  const started = messageLiquidAnimator.start(revision, layoutGeneration);
  if (!started) {
    disableMessageLiquidEffect();
  }
  return started;
}

/** 新 layout 進入 pending 時暫停跑馬燈；同頁酒液維持單一連續時鐘。 */
function holdPageEffectsForLayout(revision) {
  for (const track of elements.pageLayer.querySelectorAll('.marquee-track')) {
    track.style.animationPlayState = 'paused';
  }
  messageLiquidAnimator.holdAtStart(revision);
}

/** Main 接受目前版面後，同步放行跑馬燈與酒液的播放時軸。 */
function startAcceptedPageEffects({ revision, layoutGeneration }) {
  if (
    currentPresentation?.mode !== 'page' ||
    currentPresentation.revision !== revision ||
    Number(elements.stage.dataset.layoutGeneration) !== layoutGeneration
  ) {
    return false;
  }

  const hasActiveLiquid = elements.pageLayer.querySelector(
    '.message-row[data-liquid-effect="active"]',
  ) !== null;
  if (hasActiveLiquid) {
    // 酒液只是裝飾：建立失敗已由 helper 退回白字，不得卡住 finite 播放。
    if (!startMessageLiquidEffect(revision, layoutGeneration)) {
      pageProgressReporter?.liquidComplete(revision, layoutGeneration);
    }
  }

  /*
   * CSS 動畫預設 paused；此處與 WAAPI 的酒液 start 同步執行，瀏覽器會在
   * 下一個 compositor frame 一起開始，避免 IPC 延遲期間跑馬燈先行。
   */
  for (const track of elements.pageLayer.querySelectorAll('.marquee-track')) {
    track.style.animationPlayState = 'running';
  }
  return true;
}

async function reportPageReady(
  presentationRevision,
  settingsRevision,
  layoutToken,
) {
  const readyGeneration = renderGeneration;
  const tracks = [
    ...elements.pageLayer.querySelectorAll('.marquee-track'),
  ];
  const activeLiquidRows = elements.pageLayer.querySelectorAll(
    '.message-row[data-liquid-effect="active"]',
  );
  const activeLiquidVessels = elements.pageLayer.querySelectorAll(
    '.message-row[data-liquid-effect="active"] .message-vessel',
  );
  const effectiveDurationMilliseconds =
    calculateEffectivePageDurationMilliseconds(tracks);
  let liquidLayoutReady = true;

  if (activeLiquidVessels.length > 0) {
    const renderers = syncMessageLiquidSvgs(elements.pageLayer, {
      seed: presentationRevision,
    });
    liquidLayoutReady = renderers.length === activeLiquidVessels.length;
    if (!liquidLayoutReady) {
      disableMessageLiquidEffect();
    }
  }

  if (
    liquidLayoutReady &&
    activeLiquidRows.length > 0 &&
    !messageLiquidAnimator.retime(
      presentationRevision,
      effectiveDurationMilliseconds,
    )
  ) {
    disableMessageLiquidEffect();
    liquidLayoutReady = false;
  }

  if (liquidLayoutReady && activeLiquidRows.length > 0) {
    const warmed = await warmMessageLiquidPipeline(elements.pageLayer, {
      durationMilliseconds: effectiveDurationMilliseconds,
    });
    if (!warmed) {
      disableMessageLiquidEffect();
    }
  }

  if (
    readyGeneration !== renderGeneration ||
    currentPresentation?.mode !== 'page' ||
    currentPresentation.revision !== presentationRevision ||
    currentPresentation.pageNumber !== layoutToken.pageNumber ||
    currentSettings.revision !== settingsRevision ||
    currentDisplayEpoch !== layoutToken.displayEpoch
  ) {
    return false;
  }

  elements.stage.dataset.marqueeCount = String(
    elements.pageLayer.querySelectorAll('.is-marquee').length,
  );
  elements.stage.dataset.fittedRevision = String(presentationRevision);
  elements.stage.dataset.fittedSettingsRevision = String(settingsRevision);
  elements.stage.dataset.layoutGeneration = String(
    layoutToken.layoutGeneration,
  );
  pageProgressReporter.ready(
    layoutToken,
    tracks,
    {
      liquidCompletionRequired: elements.pageLayer.querySelector(
        '.message-row[data-liquid-effect="active"]',
      ) !== null,
    },
  );
  return true;
}

function fitCurrentPage(
  presentationRevision,
  settingsRevision,
  generation,
  layoutToken,
) {
  if (
    generation !== renderGeneration ||
    currentPresentation?.mode !== 'page' ||
    currentPresentation.revision !== presentationRevision ||
    currentSettings.revision !== settingsRevision
  ) {
    return;
  }

  const rows = getRows();

  if (rows.length === 0) {
    return;
  }

  for (const row of rows) {
    createStaticMessage(row, row.dataset.message || '');
  }

  /*
   * 一般訊息固定使用 CSS 的響應式字級，與當頁有 1、2 或 3 則、文字長短
   * 完全無關。只有實際列高不足時才做垂直安全下修。
   */
  if (elements.pageLayer.dataset.layout === 'messages') {
    elements.pageLayer.style.removeProperty('font-size');
    const responsiveFontSize = Number.parseFloat(
      getComputedStyle(elements.pageLayer).fontSize,
    );
    const smallestRowHeight = Math.min(
      ...rows.map((row) => row.clientHeight),
    );

    if (
      !Number.isFinite(responsiveFontSize) ||
      responsiveFontSize <= 0 ||
      smallestRowHeight <= 0
    ) {
      return;
    }

    const fixedFontSize = Math.min(
      responsiveFontSize,
      smallestRowHeight / MESSAGE_LINE_HEIGHT,
    );
    elements.pageLayer.style.fontSize = `${fixedFontSize}px`;
    elements.stage.dataset.minimumFontClamped = 'false';
    elements.stage.dataset.fixedFontClamped = String(
      fixedFontSize < responsiveFontSize,
    );
    protectOverflowingRows(rows);
    reportPageReady(
      presentationRevision,
      settingsRevision,
      layoutToken,
    );
    return;
  }

  const rootFontSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  ) || 16;
  const smallestRowHeight = Math.min(
    ...rows.map((row) => row.clientHeight),
  );
  let bounds;

  try {
    bounds = calculateResponsiveFontBounds({
      availableWidth: elements.pageLayer.clientWidth,
      smallestRowHeight,
      rootFontSize,
      minimumFontSizeRem: currentSettings.appearance.minimumFontSizeRem,
      fontSizePercent: currentSettings.appearance.fontSizePercent,
      lineHeight: MESSAGE_LINE_HEIGHT,
    });
  } catch {
    // 尚未完成 layout 時等待下一次 ResizeObserver，不在畫面顯示錯誤。
    return;
  }

  const fit = findLargestFittingFontSize({
    minimumFontSize: bounds.minimumFontSize,
    maximumFontSize: bounds.maximumFontSize,
    precision: FIT_PRECISION_PX,
    fits: (fontSize) => pageFitsAt(fontSize, rows),
  });
  elements.pageLayer.style.fontSize = `${fit.fontSize}px`;
  elements.stage.dataset.minimumFontClamped = String(
    bounds.minimumWasClamped,
  );

  if (!fit.fitsAtMinimum) {
    protectOverflowingRows(rows);
  }

  reportPageReady(
    presentationRevision,
    settingsRevision,
    layoutToken,
  );
}

/** Main 接受 pending 並取消舊 timer 後，才可把同頁酒液歸零並重新排版。 */
function startAcceptedPageLayout(layoutToken) {
  if (
    currentPresentation?.mode !== 'page' ||
    currentPresentation.revision !== layoutToken.revision ||
    currentPresentation.pageNumber !== layoutToken.pageNumber ||
    currentSettings.revision !== layoutToken.settingsRevision ||
    currentDisplayEpoch !== layoutToken.displayEpoch
  ) {
    return false;
  }

  holdPageEffectsForLayout(currentPresentation.revision);
  const generation = renderGeneration;
  const presentationRevision = currentPresentation.revision;
  const settingsRevision = currentSettings.revision;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    fitCurrentPage(
      presentationRevision,
      settingsRevision,
      generation,
      layoutToken,
    );
  });
  return true;
}

function scheduleFit() {
  if (
    currentPresentation?.mode !== 'page' ||
    currentDisplayEpoch < 1
  ) {
    return;
  }

  if (fitFrame !== null) {
    cancelAnimationFrame(fitFrame);
  }

  const layoutToken = pageProgressReporter?.begin({
    revision: currentPresentation.revision,
    pageNumber: currentPresentation.pageNumber,
    settingsRevision: currentSettings.revision,
    displayEpoch: currentDisplayEpoch,
  });
  if (!layoutToken) {
    return;
  }
}

function updateChromeVisibility() {
  const pageVisible = currentPresentation?.mode === 'page';
  const standbyVisible = currentPresentation?.mode === 'blank';
  const showLogo =
    (pageVisible || standbyVisible) &&
    currentSettings.logo.enabled &&
    logoReady;
  const showStandbyBackground =
    standbyVisible && standbyBackgroundReady &&
    activeStandbyBackgroundImage !== null;
  const showClock =
    (standbyVisible || (pageVisible && currentSettings.dateTime.enabled)) &&
    clockHasValue;

  elements.logoFrame.hidden = !showLogo;
  elements.logo.hidden = !showLogo;
  elements.standbyBackgroundLayer.hidden = !showStandbyBackground;
  for (const image of elements.standbyBackgroundImages) {
    image.hidden = !showStandbyBackground ||
      image !== activeStandbyBackgroundImage;
  }
  elements.sandCanvas.hidden = sandWebglRenderer !== null ||
    !showStandbyBackground || !sandTransition.isRunning();
  elements.sandParticleCanvas.hidden = !showStandbyBackground ||
    !sandTransition.isRunning();
  elements.clock.hidden = !showClock;
  elements.normalLayer.classList.toggle('has-logo', showLogo);
  elements.normalLayer.classList.toggle('has-clock', showClock);
  elements.normalLayer.classList.toggle('has-chrome', showLogo || showClock);
  elements.chrome.hidden = !(showLogo || showClock);
}

function syncClock() {
  const enabled = currentPresentation?.mode === 'blank' ||
    (currentPresentation?.mode === 'page' && currentSettings.dateTime.enabled);
  const offsetSeconds = currentSettings.dateTime.offsetSeconds;
  const signature = `${enabled}:${offsetSeconds}`;

  if (signature === clockSignature) {
    updateChromeVisibility();
    return;
  }

  clockSignature = signature;
  clock.update({ enabled, offsetSeconds });
}

/**
 * 螢幕不支援 DDC/CI 時，Main 以百分比要求畫面濾鏡模擬亮度／對比；
 * 100% 代表原始畫面，因此兩者皆為 100 時移除濾鏡以免額外合成成本。
 */
function applyOutputAdjustment(adjustment) {
  const isPercent = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 100;
  if (
    adjustment === null ||
    typeof adjustment !== 'object' ||
    Object.keys(adjustment).length !== 2 ||
    !isPercent(adjustment.brightnessPercent) ||
    !isPercent(adjustment.contrastPercent)
  ) {
    return false;
  }

  const { brightnessPercent, contrastPercent } = adjustment;
  const neutral = brightnessPercent === 100 && contrastPercent === 100;
  elements.renderSurface.style.filter = neutral
    ? ''
    : `brightness(${brightnessPercent / 100}) contrast(${contrastPercent / 100})`;
  elements.stage.dataset.outputAdjustment = neutral ? 'none' : 'software';
  return true;
}

function handleLogoLoad() {
  if (
    expectedLogoUrl === null ||
    elements.logo.getAttribute('src') !== expectedLogoUrl
  ) {
    return;
  }

  logoReady = elements.logo.naturalWidth > 0 && elements.logo.naturalHeight > 0;
  if (logoReady) {
    applyLogoTreatment();
  }
  elements.stage.dataset.logoState = logoReady ? 'ready' : 'error';
  updateChromeVisibility();
  scheduleFit();
}

function handleLogoError() {
  if (
    expectedLogoUrl === null ||
    elements.logo.getAttribute('src') !== expectedLogoUrl
  ) {
    return;
  }

  logoReady = false;
  elements.logoFrame.removeAttribute('data-logo-treatment');
  elements.stage.dataset.logoState = 'error';
  updateChromeVisibility();
  scheduleFit();
}

function applyLogo() {
  const nextUrl = currentSettings.logo.enabled
    ? currentSettings.logo.url
    : null;

  if (nextUrl === null) {
    expectedLogoUrl = null;
    logoReady = false;
    elements.logoFrame.removeAttribute('data-logo-treatment');
    elements.logo.removeAttribute('src');
    elements.stage.dataset.logoState = 'disabled';
    updateChromeVisibility();
    return;
  }

  expectedLogoUrl = nextUrl;

  if (
    elements.logo.getAttribute('src') === nextUrl &&
    elements.logo.complete &&
    elements.logo.naturalWidth > 0
  ) {
    logoReady = true;
    applyLogoTreatment();
    elements.stage.dataset.logoState = 'ready';
    updateChromeVisibility();
    return;
  }

  logoReady = false;
  elements.logoFrame.removeAttribute('data-logo-treatment');
  elements.stage.dataset.logoState = 'loading';
  elements.logo.src = nextUrl;
  updateChromeVisibility();
}

/**
 * 以最多 64×64 的離屏樣本辨識透明背景；失敗時保留原圖並使用亮白底襯。
 * Canvas 不加入 DOM，分析後也不保存任何像素資料。
 */
function applyLogoTreatment() {
  let treatment = LOGO_TREATMENTS.LIGHT_PLATE;

  try {
    const scale = Math.min(
      1,
      LOGO_ALPHA_SAMPLE_EDGE / elements.logo.naturalWidth,
      LOGO_ALPHA_SAMPLE_EDGE / elements.logo.naturalHeight,
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(elements.logo.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(elements.logo.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (context) {
      context.drawImage(elements.logo, 0, 0, canvas.width, canvas.height);
      treatment = classifyLogoAlpha(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
      );
    }
  } catch {
    // 解碼器或 Canvas 拒絕讀取時採保守底襯，不讓 Logo 消失。
  }

  elements.logoFrame.dataset.logoTreatment = treatment;
}

/** 計算與 object-fit: cover 相同的置中裁切，供 Canvas 精準複製舊背景。 */
function calculateCoverCrop(image, width, height) {
  const scale = Math.max(
    width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;

  return Object.freeze({
    scale,
    sourceX: (image.naturalWidth - sourceWidth) / 2,
    sourceY: (image.naturalHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
  });
}

function setCanvasSize(canvas, width, height) {
  if (canvas.width === width && canvas.height === height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;
  return true;
}

/**
 * 隱藏並清空本輪內容；輪播期間預設保留 backing store，避免下一輪重新配置。
 * 離開待機或卸載時才縮回 1×1 並釋放大型像素陣列。
 */
function clearStandbySandCanvas({ releaseBuffers = false } = {}) {
  sandOutgoingImage = null;
  sandCoverCrop = null;
  sandPreparedScrimSignature = null;
  elements.sandCanvas.hidden = true;
  elements.sandParticleCanvas.hidden = true;

  sandContext?.clearRect(
    0,
    0,
    elements.sandCanvas.width,
    elements.sandCanvas.height,
  );
  sandParticleContext?.clearRect(
    0,
    0,
    elements.sandParticleCanvas.width,
    elements.sandParticleCanvas.height,
  );
  if (releaseBuffers) {
    sandWebglRenderer?.releaseSourceTexture();
  } else {
    sandWebglRenderer?.clear();
  }
  sandMaskContext?.clearRect(0, 0, sandMaskCanvas.width, sandMaskCanvas.height);
  sandParticleSourceContext?.clearRect(
    0,
    0,
    sandParticleSourceCanvas.width,
    sandParticleSourceCanvas.height,
  );
  sandMaskImageData?.data.fill(0);
  sandParticleImageData?.data.fill(0);

  if (!releaseBuffers) {
    return;
  }

  sandMaskImageData = null;
  sandParticleImageData = null;
  sandParticleSourcePixels = null;
  sandPreparedViewportWidth = 0;
  sandPreparedViewportHeight = 0;
  setCanvasSize(sandMaskCanvas, 1, 1);
  setCanvasSize(sandParticleSourceCanvas, 1, 1);
  setCanvasSize(elements.sandCanvas, 1, 1);
  setCanvasSize(elements.sandParticleCanvas, 1, 1);
}

function cancelStandbySandTransition(options) {
  sandTransition.cancel();
  if (options?.releaseBuffers === true) {
    sandTransition.discardPrepared();
  }
  clearStandbySandCanvas(options);
  delete elements.stage.dataset.standbyTransition;
  delete elements.stage.dataset.sandProgress;
}

function cancelScheduledSandPreparation({ preserveReady = false } = {}) {
  if (sandPreparationHandle !== null) {
    cancelSandPreparationIdle(sandPreparationHandle);
    sandPreparationHandle = null;
  }

  if (
    !preserveReady ||
    elements.stage.dataset.sandPreparation !== 'ready'
  ) {
    delete elements.stage.dataset.sandPreparation;
  }
}

/** 在背景靜止停留期間先建立下一輪遮罩與粒子幾何，轉場起點只做繪圖準備。 */
function scheduleStandbySandPreparation() {
  cancelScheduledSandPreparation({ preserveReady: true });

  if (sandTransition.isRunning()) {
    return false;
  }

  if (
    currentSettings.standby.sandEffectEnabled !== true ||
    currentPresentation?.mode !== 'blank' ||
    !activeStandbyBackgroundImage ||
    currentSettings.standby.backgroundMode !== 'slideshow' ||
    currentSettings.standby.backgroundImageUrls.length < 2
  ) {
    sandTransition.discardPrepared();
    clearStandbySandCanvas({ releaseBuffers: true });
    delete elements.stage.dataset.sandPreparation;
    return false;
  }

  const width = elements.standbyBackgroundLayer.clientWidth;
  const height = elements.standbyBackgroundLayer.clientHeight;
  const expectedImage = activeStandbyBackgroundImage;
  const expectedScrimSignature = createStandbyScrimSignature(
    currentSettings.appearance.fontColor,
  );
  if (width <= 0 || height <= 0) {
    return false;
  }

  if (
    elements.stage.dataset.sandPreparation === 'ready' &&
    sandOutgoingImage === expectedImage &&
    sandPreparedViewportWidth === width &&
    sandPreparedViewportHeight === height &&
    sandPreparedScrimSignature === expectedScrimSignature
  ) {
    return true;
  }

  elements.stage.dataset.sandPreparation = 'scheduled';
  const handle = requestSandPreparationIdle(() => {
    if (sandPreparationHandle !== handle) {
      return;
    }

    sandPreparationHandle = null;
    if (
      currentSettings.standby.sandEffectEnabled !== true ||
      currentPresentation?.mode !== 'blank' ||
      activeStandbyBackgroundImage !== expectedImage ||
      createStandbyScrimSignature(currentSettings.appearance.fontColor) !==
        expectedScrimSignature ||
      sandTransition.isRunning()
    ) {
      delete elements.stage.dataset.sandPreparation;
      return;
    }

    const geometryPrepared = sandTransition.prepare({ width, height });
    const buffersPrepared = geometryPrepared && prepareStandbySandBuffers(
      expectedImage,
      width,
      height,
    );
    elements.stage.dataset.sandPreparation = buffersPrepared
      ? 'ready'
      : 'skipped';
  });
  sandPreparationHandle = handle;
  return true;
}

function drawCoverImage(context, image, crop, width, height) {
  context.drawImage(
    image,
    crop.sourceX,
    crop.sourceY,
    crop.sourceWidth,
    crop.sourceHeight,
    0,
    0,
    width,
    height,
  );
}

/**
 * 在靜止停留期間先配置 Canvas、複製舊圖並讀取來源像素。
 * 轉場真正開始時若圖片與尺寸相同，就不再觸發首輪 backing store 配置卡頓。
 */
function prepareStandbySandBuffers(image, width, height) {
  if (
    (sandWebglRenderer === null && (
      !sandContext ||
      !sandParticleContext ||
      !sandParticleSourceContext
    )) ||
    !image ||
    width <= 0 ||
    height <= 0 ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0
  ) {
    return false;
  }

  sandOutgoingImage = image;
  sandCoverCrop = calculateCoverCrop(image, width, height);
  sandPreparedViewportWidth = width;
  sandPreparedViewportHeight = height;
  const scrimProfile = calculateStandbyScrimProfile(
    currentSettings.appearance.fontColor,
  );
  const scrimSignature = createStandbyScrimSignature(
    currentSettings.appearance.fontColor,
  );

  if (sandWebglRenderer !== null) {
    const prepared = sandWebglRenderer.prepare({
      image,
      crop: sandCoverCrop,
      width,
      height,
      scrim: scrimProfile,
    });
    if (!prepared) {
      clearStandbySandCanvas({ releaseBuffers: true });
    } else {
      sandPreparedScrimSignature = scrimSignature;
    }
    return prepared;
  }

  setCanvasSize(elements.sandCanvas, width, height);
  // 以總像素上限控制成本；1920 畫面維持接近原生解析度，4K 仍約 1600×900。
  const particleScale = Math.min(
    1,
    Math.sqrt(1_500_000 / (width * height)),
  );
  const particleWidth = Math.max(1, Math.round(width * particleScale));
  const particleHeight = Math.max(1, Math.round(height * particleScale));
  setCanvasSize(elements.sandParticleCanvas, particleWidth, particleHeight);
  setCanvasSize(sandParticleSourceCanvas, particleWidth, particleHeight);
  sandContext.clearRect(0, 0, width, height);
  sandContext.imageSmoothingEnabled = true;
  drawCoverImage(sandContext, image, sandCoverCrop, width, height);
  sandParticleSourceContext.clearRect(0, 0, particleWidth, particleHeight);
  sandParticleSourceContext.imageSmoothingEnabled = true;
  drawCoverImage(
    sandParticleSourceContext,
    image,
    sandCoverCrop,
    particleWidth,
    particleHeight,
  );

  try {
    sandParticleSourcePixels = sandParticleSourceContext.getImageData(
      0,
      0,
      particleWidth,
      particleHeight,
    ).data;
    if (
      !sandParticleImageData ||
      sandParticleImageData.width !== particleWidth ||
      sandParticleImageData.height !== particleHeight
    ) {
      sandParticleImageData = sandParticleContext.createImageData(
        particleWidth,
        particleHeight,
      );
    }
  } catch {
    clearStandbySandCanvas();
    return false;
  }

  sandPreparedScrimSignature = scrimSignature;
  return true;
}

/** 將引擎的細顆粒資料同步到可重用離屏 Canvas，只更新這一幀的髒矩形。 */
function updateSandMaskCanvas(erosionMask) {
  if (!sandMaskContext) {
    return false;
  }

  if (
    sandMaskImageData === null ||
    sandMaskCanvas.width !== erosionMask.width ||
    sandMaskCanvas.height !== erosionMask.height
  ) {
    sandMaskCanvas.width = erosionMask.width;
    sandMaskCanvas.height = erosionMask.height;
    sandMaskImageData = sandMaskContext.createImageData(
      erosionMask.width,
      erosionMask.height,
    );
  }

  const dirty = erosionMask.dirtyBounds;
  if (dirty === null) {
    return true;
  }

  const source = erosionMask.deltaPixels;
  const destination = sandMaskImageData.data;
  for (let y = dirty.y; y < dirty.y + dirty.height; y += 1) {
    const start = (y * erosionMask.width + dirty.x) * 4;
    const end = start + dirty.width * 4;
    destination.set(source.subarray(start, end), start);
  }
  sandMaskContext.putImageData(
    sandMaskImageData,
    0,
    0,
    dirty.x,
    dirty.y,
    dirty.width,
    dirty.height,
  );
  return true;
}

/** 將來源圖片像素以 source-over 混入顆粒 ImageData，重疊處仍保留正確色彩。 */
function blendSandPixel(destination, destinationIndex, sourceIndex, opacity) {
  if (!sandParticleSourcePixels || opacity <= 0) {
    return;
  }

  const sourceAlpha = sandParticleSourcePixels[sourceIndex + 3] / 255 * opacity;
  const destinationAlpha = destination[destinationIndex + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) {
    return;
  }

  const destinationWeight = destinationAlpha * (1 - sourceAlpha);
  for (let channel = 0; channel < 3; channel += 1) {
    destination[destinationIndex + channel] = Math.round((
      sandParticleSourcePixels[sourceIndex + channel] * sourceAlpha +
      destination[destinationIndex + channel] * destinationWeight
    ) / outputAlpha);
  }
  destination[destinationIndex + 3] = Math.round(outputAlpha * 255);
}

/**
 * 將舊圖來源像素畫成一段 1～3px 的水平細砂。
 *
 * 風砂不能使用實心圓，否則亮色來源會變成雪點或泡泡；短水平粒同時保留來源
 * 色彩與左至右風向。顆粒固定在有界 ImageData 上，4K 仍只需一次 putImageData。
 */
function rasterizeSandGrain(
  destination,
  sourceIndex,
  particleWidth,
  particleHeight,
  x,
  y,
  width,
  height,
  opacity,
  scaleX,
  scaleY,
) {
  if (opacity <= 0 || width <= 0 || height <= 0) {
    return;
  }

  const centerX = x * scaleX;
  const centerY = y * scaleY;
  const halfWidth = Math.max(0.5, width * scaleX / 2);
  const halfHeight = Math.max(0.42, height * scaleY / 2);
  const left = Math.max(0, Math.floor(centerX - halfWidth));
  const right = Math.min(particleWidth - 1, Math.ceil(centerX + halfWidth));
  const top = Math.max(0, Math.floor(centerY - halfHeight));
  const bottom = Math.min(particleHeight - 1, Math.ceil(centerY + halfHeight));
  let painted = false;

  for (let pixelY = top; pixelY <= bottom; pixelY += 1) {
    for (let pixelX = left; pixelX <= right; pixelX += 1) {
      const normalizedX = Math.abs(pixelX + 0.5 - centerX) / halfWidth;
      const normalizedY = Math.abs(pixelY + 0.5 - centerY) / halfHeight;
      if (normalizedX > 1 || normalizedY > 1) {
        continue;
      }
      // 砂粒中央清楚、四周快速變薄，避免整齊矩形看起來像電視雜訊。
      const horizontalProfile = 1 - normalizedX ** 2;
      const verticalProfile = 1 - normalizedY ** 2;
      const edgeFade = Math.max(
        0.16,
        horizontalProfile * verticalProfile,
      );
      blendSandPixel(
        destination,
        (pixelY * particleWidth + pixelX) * 4,
        sourceIndex,
        opacity * edgeFade,
      );
      painted = true;
    }
  }

  if (!painted) {
    const pixelX = Math.max(0, Math.min(
      particleWidth - 1,
      Math.floor(centerX),
    ));
    const pixelY = Math.max(0, Math.min(
      particleHeight - 1,
      Math.floor(centerY),
    ));
    blendSandPixel(
      destination,
      (pixelY * particleWidth + pixelX) * 4,
      sourceIndex,
      opacity,
    );
  }
}

function smoothstep01(value) {
  const progress = Math.min(1, Math.max(0, value));
  return progress * progress * (3 - 2 * progress);
}

/**
 * 預先計算每個遮罩欄位的沙塵供料量。
 *
 * 左側是低矮進風，約 66% 畫寬形成主揚砂核心，核心右側拉成較長尾流；最後
 * 14% 畫寬逐步歸零，避免沙粒撞上螢幕右邊後被硬切斷。
 */
function getSandDustColumnStrengths(maskWidth) {
  if (
    sandDustColumnStrengths !== null &&
    sandDustColumnStrengthsWidth === maskWidth
  ) {
    return sandDustColumnStrengths;
  }

  const strengths = new Float32Array(maskWidth);
  for (let x = 0; x < maskWidth; x += 1) {
    const normalizedX = (x + 0.5) / maskWidth;
    const intake = smoothstep01(normalizedX / 0.66);
    const coreSpread = normalizedX < 0.66 ? 0.095 : 0.19;
    const core = Math.exp(
      -0.5 * ((normalizedX - 0.66) / coreSpread) ** 2,
    );
    const edgeFade = smoothstep01((0.985 - normalizedX) / 0.145);
    strengths[x] = (
      0.015 + intake * 0.055 + core * 0.93
    ) * edgeFade;
  }

  sandDustColumnStrengths = strengths;
  sandDustColumnStrengthsWidth = maskWidth;
  return strengths;
}

function calculateParticleRightEdgeFade(x, width) {
  return smoothstep01((0.985 - x / width) / 0.145);
}

/**
 * 將這一輪剛離開舊圖的遮罩像素直接搬成向右飛行的密集細砂。
 *
 * 稀疏主粒負責較遠的揚砂與尾流；這個貼面粒場負責補回被遮罩移除的圖片質量，
 * 避免畫面先出現 wipe 接縫，之後才在別處看到零散粒子。每一粒的 RGB 都直接
 * 取自舊背景相同位置，不建立假色煙霧，也不產生每幀物件配置。
 */
function rasterizeErosionDustField(
  frame,
  destination,
  particleWidth,
  particleHeight,
  scaleX,
  scaleY,
) {
  const { activations, width: maskWidth, height: maskHeight } =
    frame.erosionMask;
  if (!activations || frame.progress <= 0 || frame.progress >= 1) {
    return;
  }

  const sourceCellEdge = Math.max(
    frame.width / maskWidth,
    frame.height / maskHeight,
  );
  const columnStrengths = getSandDustColumnStrengths(maskWidth);
  const finalFade = frame.progress <= 0.94
    ? 1
    : (1 - frame.progress) / 0.06;

  for (let maskY = 0; maskY < maskHeight; maskY += 1) {
    const sourceY = (maskY + 0.5) / maskHeight * frame.height;
    // 棋盤式取樣保留每列連續風紋，同時把 4K 每幀像素工作量減半。
    for (let maskX = maskY % 2; maskX < maskWidth; maskX += 2) {
      const maskIndex = maskY * maskWidth + maskX;
      const normalizedX = (maskX + 0.5) / maskWidth;
      const plumeStrength = columnStrengths[maskX];
      const activation = activations[maskIndex] / 255;
      const lifeProgress = 0.09 + plumeStrength * 0.14;
      const age = (frame.progress - activation) / lifeProgress;
      if (age < 0 || age >= 1) {
        continue;
      }

      let hash = Math.imul(maskIndex ^ 0x51ed270b, 1_597_334_677);
      hash = Math.imul(hash ^ (hash >>> 15), 2_246_822_519);
      const gateRandom = ((hash ^ (hash >>> 13)) >>> 0) / 4_294_967_295;
      if (gateRandom > 0.012 + plumeStrength * 0.68) {
        continue;
      }
      hash = Math.imul(hash ^ 0x68bc21eb, 3_266_489_917);
      const motionRandom = ((hash ^ (hash >>> 16)) >>> 0) / 4_294_967_295;

      const sourceX = (maskX + 0.5) / maskWidth * frame.width;
      const travelProgress = age * (2 - age);
      const horizontalTravel = frame.width * (
        0.022 + plumeStrength * 0.17 + motionRandom * 0.026
      ) * travelProgress;
      const upwardTravel = frame.height * (
        0.003 + plumeStrength * 0.034 + motionRandom * 0.006
      ) * (1 - (1 - age) ** 1.35);
      const streamJitter = Math.sin(
        maskY * 0.73 + maskX * 0.11 + motionRandom * Math.PI * 2,
      ) * sourceCellEdge * (0.4 + age * 1.2);
      const destinationX = sourceX + horizontalTravel;
      const rightEdgeFade = calculateParticleRightEdgeFade(
        destinationX,
        frame.width,
      );
      const opacity = Math.min(
        0.5,
        (0.012 + plumeStrength * 0.47) *
          (1 - age) ** 0.68 *
          finalFade *
          (0.68 + motionRandom * 0.32) *
          rightEdgeFade,
      );
      const sourcePixelX = Math.max(0, Math.min(
        particleWidth - 1,
        Math.floor(sourceX * scaleX),
      ));
      const sourcePixelY = Math.max(0, Math.min(
        particleHeight - 1,
        Math.floor(sourceY * scaleY),
      ));
      const sourceIndex = (
        sourcePixelY * particleWidth + sourcePixelX
      ) * 4;
      const grainHeight = sourceCellEdge * (0.42 + motionRandom * 0.28);
      const grainWidth = grainHeight * (
        2.4 + plumeStrength * 2.1 + age * 1.4
      );

      rasterizeSandGrain(
        destination,
        sourceIndex,
        particleWidth,
        particleHeight,
        destinationX,
        sourceY - upwardTravel + streamJitter,
        grainWidth,
        grainHeight,
        opacity,
        scaleX,
        scaleY,
      );
    }
  }
}

/**
 * 只對舊圖 Canvas 新增的侵蝕區做 destination-out；飛散圖粒畫在獨立的
 * 半解析度 Canvas，讓 4K 畫面不必在每一幀清除及重畫整張舊圖片。
 */
function drawStandbySandFrame(frame) {
  elements.stage.dataset.sandProgress = frame.progress.toFixed(3);

  if (sandWebglRenderer !== null) {
    if (!sandWebglRenderer.draw(frame.progress)) {
      throw new Error('GPU 風吹砂單幀繪製失敗。');
    }
    return;
  }

  if (
    !sandContext ||
    !sandParticleContext ||
    !sandOutgoingImage ||
    !sandCoverCrop
  ) {
    return;
  }

  if (updateSandMaskCanvas(frame.erosionMask)) {
    const dirty = frame.erosionMask.dirtyBounds;
    if (dirty !== null) {
      const sourceX = Math.max(0, dirty.x - 1);
      const sourceY = Math.max(0, dirty.y - 1);
      const sourceRight = Math.min(
        frame.erosionMask.width,
        dirty.x + dirty.width + 1,
      );
      const sourceBottom = Math.min(
        frame.erosionMask.height,
        dirty.y + dirty.height + 1,
      );
      const sourceWidth = sourceRight - sourceX;
      const sourceHeight = sourceBottom - sourceY;
      const destinationX = sourceX / frame.erosionMask.width * frame.width;
      const destinationY = sourceY / frame.erosionMask.height * frame.height;
      const destinationWidth = sourceWidth /
        frame.erosionMask.width * frame.width;
      const destinationHeight = sourceHeight /
        frame.erosionMask.height * frame.height;

      sandContext.save();
      sandContext.globalCompositeOperation = 'destination-out';
      sandContext.imageSmoothingEnabled = false;
      sandContext.drawImage(
        sandMaskCanvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        destinationX,
        destinationY,
        destinationWidth,
        destinationHeight,
      );
      sandContext.restore();
    }
  }

  const particleWidth = elements.sandParticleCanvas.width;
  const particleHeight = elements.sandParticleCanvas.height;
  const scaleX = particleWidth / frame.width;
  const scaleY = particleHeight / frame.height;
  if (
    !sandParticleImageData ||
    !sandParticleSourcePixels ||
    sandParticleImageData.width !== particleWidth ||
    sandParticleImageData.height !== particleHeight
  ) {
    return;
  }

  const destination = sandParticleImageData.data;
  destination.fill(0);
  rasterizeErosionDustField(
    frame,
    destination,
    particleWidth,
    particleHeight,
    scaleX,
    scaleY,
  );
  for (const particle of frame.particles) {
    const particleEdgeFade = calculateParticleRightEdgeFade(
      particle.x,
      frame.width,
    );
    const particleOpacity = particle.opacity * particleEdgeFade;
    if (particleOpacity < 0.004) {
      continue;
    }
    const sourceX = Math.max(0, Math.min(
      particleWidth - 1,
      Math.floor(particle.sourceX * scaleX),
    ));
    const sourceY = Math.max(0, Math.min(
      particleHeight - 1,
      Math.floor(particle.sourceY * scaleY),
    ));
    const sourceIndex = (sourceY * particleWidth + sourceX) * 4;

    const activeFragmentGrainCount = Math.ceil(
      particle.fragmentGrainCount * particle.fragmentStrength,
    );
    for (
      let fragmentGrainIndex = 0;
      fragmentGrainIndex < activeFragmentGrainCount;
      fragmentGrainIndex += 1
    ) {
      const fragmentPhase = particle.wakePhase * 1.73 +
        fragmentGrainIndex * 2.399963;
      const fragmentJitter = (Math.sin(fragmentPhase * 6.17) + 1) / 2;
      const fragmentDistance = particle.fragmentSpread * Math.sqrt(
        (fragmentGrainIndex + 0.25 + fragmentJitter * 0.5) /
          (particle.fragmentGrainCount + 0.5),
      ) * 2.2;
      const fragmentSourceX = Math.max(0, Math.min(
        particleWidth - 1,
        sourceX - Math.round(fragmentDistance * scaleX),
      ));
      const fragmentSourceY = Math.max(0, Math.min(
        particleHeight - 1,
        sourceY + Math.round(
          Math.sin(fragmentPhase) * particle.fragmentSpread * 0.35 * scaleY,
        ),
      ));
      const fragmentSourceIndex = (
        fragmentSourceY * particleWidth + fragmentSourceX
      ) * 4;
      const fragmentSizeScale = 0.24 + fragmentJitter * 0.18;

      rasterizeSandGrain(
        destination,
        fragmentSourceIndex,
        particleWidth,
        particleHeight,
        particle.x - fragmentDistance,
        particle.y + Math.sin(fragmentPhase) * particle.fragmentSpread * 0.35,
        particle.width * fragmentSizeScale,
        particle.height * fragmentSizeScale,
        particleOpacity * (0.36 + particle.fragmentStrength * 0.3),
        scaleX,
        scaleY,
      );
    }

    for (
      let wakeIndex = particle.wakeGrainCount;
      wakeIndex >= 1;
      wakeIndex -= 1
    ) {
      const wakeJitter = (
        Math.sin(particle.wakePhase * 13.7 + wakeIndex * 78.233) + 1
      ) / 2;
      const wakeProgress = Math.pow(
        Math.max(0.04, Math.min(
          0.98,
          (wakeIndex - 0.32 + wakeJitter * 0.64) /
            (particle.wakeGrainCount + 0.36),
        )),
        1.28,
      );
      const wakeScale = 1 - wakeProgress * 0.55;
      const wakeOpacity = particleOpacity * particle.wakeOpacityScale *
        (1 - wakeProgress * 0.7);
      const sourceSpread = Math.max(
        1,
        Math.round(particle.sourceSize * Math.max(scaleX, scaleY) * 1.4),
      );
      const wakeSourceX = Math.max(0, Math.min(
        particleWidth - 1,
        sourceX + Math.round(
          Math.sin(particle.wakePhase + wakeIndex * 2.17) * sourceSpread,
        ),
      ));
      const wakeSourceY = Math.max(0, Math.min(
        particleHeight - 1,
        sourceY + Math.round(
          Math.cos(particle.wakePhase * 1.31 + wakeIndex * 1.73) *
            sourceSpread,
        ),
      ));
      const wakeSourceIndex = (
        wakeSourceY * particleWidth + wakeSourceX
      ) * 4;

      if (wakeOpacity < 0.012) {
        continue;
      }

      rasterizeSandGrain(
        destination,
        wakeSourceIndex,
        particleWidth,
        particleHeight,
        particle.x - particle.wakeLength * wakeProgress,
        particle.y + Math.sin(
          particle.wakePhase + wakeProgress * Math.PI * 2.7,
        ) * particle.wakeCurl * (0.45 + wakeProgress * 0.55),
        particle.width * wakeScale,
        particle.height * wakeScale,
        wakeOpacity,
        scaleX,
        scaleY,
      );
    }
    rasterizeSandGrain(
      destination,
      sourceIndex,
      particleWidth,
      particleHeight,
      particle.x,
      particle.y,
      particle.width,
      particle.height,
      particleOpacity,
      scaleX,
      scaleY,
    );
  }
  sandParticleContext.putImageData(sandParticleImageData, 0, 0);
}

/**
 * 將新圖固定在 Canvas 下層，再以單一、不規則的沙丘侵蝕面連續向上風蝕舊圖；
 * 舊圖粒在中間偏右形成濃密揚沙核心，並隨左至右的風向翻滾飄散。
 * 第一張圖片不播放轉場。
 * 若 Canvas 無法使用則立即切換，絕不讓待機輪播停住。
 */
function startStandbySandTransition(image, url) {
  if (currentSettings.standby.sandEffectEnabled !== true) {
    return false;
  }

  const outgoingImage = activeStandbyBackgroundImage;
  const width = elements.standbyBackgroundLayer.clientWidth;
  const height = elements.standbyBackgroundLayer.clientHeight;

  if (
    (sandWebglRenderer === null && (
      !sandContext ||
      !sandParticleContext ||
      !sandParticleSourceContext ||
      !sandMaskContext
    )) ||
    !outgoingImage ||
    width <= 0 ||
    height <= 0 ||
    outgoingImage.naturalWidth <= 0 ||
    outgoingImage.naturalHeight <= 0
  ) {
    return false;
  }

  const buffersArePrepared =
    !sandTransition.isRunning() &&
    sandOutgoingImage === outgoingImage &&
    sandCoverCrop !== null &&
    sandPreparedViewportWidth === width &&
    sandPreparedViewportHeight === height &&
    sandPreparedScrimSignature === createStandbyScrimSignature(
      currentSettings.appearance.fontColor,
    ) &&
    (sandWebglRenderer !== null || (
      sandParticleSourcePixels !== null &&
      sandParticleImageData !== null
    ));
  cancelScheduledSandPreparation();
  sandTransition.cancel();
  delete elements.stage.dataset.standbyTransition;
  delete elements.stage.dataset.sandProgress;

  if (!buffersArePrepared) {
    clearStandbySandCanvas();
    if (!prepareStandbySandBuffers(outgoingImage, width, height)) {
      return false;
    }
  }

  activeStandbyBackgroundImage = image;
  pendingStandbyBackgroundImage = null;
  expectedStandbyBackgroundUrl = null;
  standbyBackgroundReady = true;
  elements.stage.dataset.standbyBackgroundState = 'ready';
  elements.stage.dataset.standbyTransition = 'sand';
  elements.stage.dataset.sandPreparation = 'consumed';

  const finishTransition = () => {
    clearStandbySandCanvas();
    delete elements.stage.dataset.standbyTransition;
    delete elements.stage.dataset.sandProgress;
    updateChromeVisibility();
    scheduleStandbySandPreparation();
    standbyBackgroundPlayer.handleLoad(url);
  };

  const started = sandTransition.start({
    width,
    height,
    durationMs: SAND_TRANSITION_DURATION_MS,
    onComplete: finishTransition,
    onError: finishTransition,
  });

  if (!started) {
    clearStandbySandCanvas();
    delete elements.stage.dataset.standbyTransition;
    return false;
  }

  updateChromeVisibility();
  return true;
}

function isExpectedStandbyBackground(image) {
  return image === pendingStandbyBackgroundImage &&
    expectedStandbyBackgroundUrl !== null &&
    image.getAttribute('src') === expectedStandbyBackgroundUrl;
}

/** 第一張立即顯示；後續健康圖片以連續上移的沙漠風蝕轉場原子替換。 */
function commitStandbyBackgroundImage(image, url) {
  if (!isExpectedStandbyBackground(image) || url !== expectedStandbyBackgroundUrl) {
    return false;
  }

  if (
    activeStandbyBackgroundImage !== null &&
    startStandbySandTransition(image, url)
  ) {
    return true;
  }

  activeStandbyBackgroundImage = image;
  pendingStandbyBackgroundImage = null;
  expectedStandbyBackgroundUrl = null;
  standbyBackgroundReady = true;
  elements.stage.dataset.standbyBackgroundState = 'ready';
  updateChromeVisibility();
  scheduleStandbySandPreparation();
  standbyBackgroundPlayer.handleLoad(url);
  return true;
}

/** 壞圖只清除 pending 槽；目前健康背景持續可見並由播放器有界跳過。 */
function rejectStandbyBackgroundImage(image, url) {
  if (!isExpectedStandbyBackground(image) || url !== expectedStandbyBackgroundUrl) {
    return false;
  }

  image.hidden = true;
  image.removeAttribute('src');
  pendingStandbyBackgroundImage = null;
  expectedStandbyBackgroundUrl = null;
  standbyBackgroundReady = activeStandbyBackgroundImage !== null;
  elements.stage.dataset.standbyBackgroundState = standbyBackgroundReady
    ? 'ready'
    : 'error';
  updateChromeVisibility();
  standbyBackgroundPlayer.handleError(url);
  return true;
}

function handleStandbyBackgroundLoad(event) {
  const image = event.currentTarget;
  if (!isExpectedStandbyBackground(image)) {
    return;
  }

  const url = expectedStandbyBackgroundUrl;
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    commitStandbyBackgroundImage(image, url);
  } else {
    rejectStandbyBackgroundImage(image, url);
  }
}

function handleStandbyBackgroundError(event) {
  const image = event.currentTarget;
  if (!isExpectedStandbyBackground(image)) {
    return;
  }

  rejectStandbyBackgroundImage(image, expectedStandbyBackgroundUrl);
}

function clearStandbyBackgroundImages() {
  cancelScheduledSandPreparation();
  cancelStandbySandTransition({ releaseBuffers: true });
  expectedStandbyBackgroundUrl = null;
  activeStandbyBackgroundImage = null;
  pendingStandbyBackgroundImage = null;
  standbyBackgroundReady = false;

  for (const image of elements.standbyBackgroundImages) {
    image.hidden = true;
    image.removeAttribute('src');
  }
}

/**
 * 將下一張載入隱藏的緩衝槽；解碼完成前保留目前健康背景，不做過場動畫。
 */
function applyStandbyBackgroundSource(nextUrl) {
  // 設定更新可能在轉場中途重設來源；舊世代動畫必須立即失效。
  // 靜止停留時則保留剛在 idle 期間準備完成的 Canvas，供下一張直接使用。
  if (sandTransition.isRunning()) {
    cancelStandbySandTransition();
  }

  if (nextUrl === null) {
    clearStandbyBackgroundImages();
    elements.stage.dataset.standbyBackgroundState = 'disabled';
    updateChromeVisibility();
    return;
  }

  if (
    activeStandbyBackgroundImage?.getAttribute('src') === nextUrl &&
    activeStandbyBackgroundImage.complete &&
    activeStandbyBackgroundImage.naturalWidth > 0 &&
    activeStandbyBackgroundImage.naturalHeight > 0
  ) {
    if (pendingStandbyBackgroundImage) {
      pendingStandbyBackgroundImage.hidden = true;
      pendingStandbyBackgroundImage.removeAttribute('src');
      pendingStandbyBackgroundImage = null;
      expectedStandbyBackgroundUrl = null;
    }
    standbyBackgroundReady = true;
    elements.stage.dataset.standbyBackgroundState = 'ready';
    updateChromeVisibility();
    scheduleStandbySandPreparation();
    standbyBackgroundPlayer.handleLoad(nextUrl);
    return;
  }

  const targetImage = elements.standbyBackgroundImages.find(
    (image) => image !== activeStandbyBackgroundImage,
  );
  if (!targetImage) {
    standbyBackgroundPlayer.handleError(nextUrl);
    return;
  }

  if (
    pendingStandbyBackgroundImage &&
    pendingStandbyBackgroundImage !== targetImage
  ) {
    pendingStandbyBackgroundImage.hidden = true;
    pendingStandbyBackgroundImage.removeAttribute('src');
  }

  pendingStandbyBackgroundImage = targetImage;
  expectedStandbyBackgroundUrl = nextUrl;
  targetImage.hidden = true;
  elements.stage.dataset.standbyBackgroundState = 'loading';

  if (
    targetImage.getAttribute('src') === nextUrl &&
    targetImage.complete &&
    targetImage.naturalWidth > 0 &&
    targetImage.naturalHeight > 0
  ) {
    commitStandbyBackgroundImage(targetImage, nextUrl);
    return;
  }

  if (
    targetImage.getAttribute('src') === nextUrl &&
    targetImage.complete
  ) {
    // 已失敗的同 URL 在新一輪可重試一次；移除後重設以確保事件重新送達。
    targetImage.removeAttribute('src');
  }

  targetImage.src = nextUrl;
  updateChromeVisibility();
}

/** 設定更新或顯示模式切換皆建立新世代；回待機固定從第一張開始。 */
function syncStandbyBackgroundPlayer() {
  standbyBackgroundPlayer.update({
    active: currentPresentation?.mode === 'blank',
    backgroundMode: currentSettings.standby.backgroundMode,
    backgroundImageUrls: currentSettings.standby.backgroundImageUrls,
    slideDurationSeconds: currentSettings.standby.slideDurationSeconds,
  });
}

function calculateLogoOutline(backgroundColor) {
  const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
  const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
  const relativeBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return relativeBrightness >= 150
    ? 'rgb(0 0 0 / 10%)'
    : 'rgb(255 255 255 / 10%)';
}

/** 依文字明暗回傳相反色遮罩；CSS 與 GPU 舊圖共用同一份色彩資料。 */
function calculateStandbyScrimProfile(fontColor) {
  const red = Number.parseInt(fontColor.slice(1, 3), 16);
  const green = Number.parseInt(fontColor.slice(3, 5), 16);
  const blue = Number.parseInt(fontColor.slice(5, 7), 16);
  const relativeBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return relativeBrightness >= 150
    ? Object.freeze({ red: 0, green: 0, blue: 0, alpha: 0.48 })
    : Object.freeze({ red: 1, green: 1, blue: 1, alpha: 0.52 });
}

function createStandbyScrimSignature(fontColor) {
  const { red, green, blue, alpha } = calculateStandbyScrimProfile(fontColor);
  return `${red}:${green}:${blue}:${alpha}`;
}

function calculateStandbyScrim(fontColor) {
  const { red, green, blue, alpha } = calculateStandbyScrimProfile(fontColor);
  return `rgb(${red * 255} ${green * 255} ${blue * 255} / ${alpha * 100}%)`;
}

function applyEmergencyBackground(tone) {
  if (tone === 'inspection') {
    document.documentElement.style.setProperty(
      '--emergency-background',
      currentSettings.emergency.inspectionBackgroundColor,
    );
  } else if (tone === 'release') {
    document.documentElement.style.setProperty(
      '--emergency-background',
      currentSettings.emergency.releaseBackgroundColor,
    );
  }
}

/**
 * 先完成目前材質的單張 4K 解碼，再原子切換 CSS selector。
 * 快速連續改設定時，以世代號拒絕較舊 decode，避免舊材質反蓋新設定。
 */
function prepareMessageBackground(preset) {
  const generation = ++messageBackgroundGeneration;

  if (preset === 'solid') {
    messageBackgroundLoader.prepare('solid');
    elements.stage.dataset.messageBackground = 'solid';
    elements.stage.dataset.messageBackgroundState = 'ready';
    messageBackgroundReadyPromise = Promise.resolve(true);
    return;
  }

  elements.stage.dataset.messageBackgroundState = 'loading';
  messageBackgroundReadyPromise = messageBackgroundLoader
    .prepare(preset)
    .then((ready) => {
      if (generation !== messageBackgroundGeneration) {
        return false;
      }

      elements.stage.dataset.messageBackground = ready ? preset : 'solid';
      elements.stage.dataset.messageBackgroundState = ready ? 'ready' : 'error';
      applyEmergencyBackground(currentPresentation?.emergencyTone);
      return ready;
    });
}

/** 啟動 Display 前等待最新一輪，而不是等待可能已過期的前一張圖片。 */
async function waitForCurrentMessageBackground() {
  while (true) {
    const pending = messageBackgroundReadyPromise;
    await pending;
    if (pending === messageBackgroundReadyPromise) {
      return;
    }
  }
}

function applyDisplaySettings(snapshot) {
  cancelPendingFit();
  currentSettings = snapshot;
  if (snapshot.standby.sandEffectEnabled === false) {
    // 關閉後立刻停止當前轉場與預建，輪播本身仍由背景播放器繼續。
    cancelScheduledSandPreparation();
    cancelStandbySandTransition({ releaseBuffers: true });
  }
  if (snapshot.appearance.messageLiquidEffectEnabled === false) {
    // 管理員關閉後立即停止裝飾時鐘並移除 SVG，保留固定純白字。
    messageLiquidAnimator.reset();
    disableMessageLiquidEffect();
  }
  const rootStyle = document.documentElement.style;
  const logoScales = calculateLogoLayoutScales(snapshot.logo.sizePercent);
  rootStyle.setProperty(
    '--display-background',
    snapshot.appearance.backgroundColor,
  );
  rootStyle.setProperty('--display-ink', snapshot.appearance.fontColor);
  rootStyle.setProperty(
    '--display-font-family',
    snapshot.appearance.fontFamily,
  );
  rootStyle.setProperty(
    '--logo-size-scale',
    String(logoScales.configuredScale),
  );
  rootStyle.setProperty(
    '--logo-page-size-scale',
    String(logoScales.pageScale),
  );
  rootStyle.setProperty(
    '--logo-standby-size-scale',
    String(logoScales.standbyScale),
  );
  rootStyle.setProperty(
    '--message-font-scale',
    String(snapshot.appearance.fontSizePercent / 100),
  );
  rootStyle.setProperty(
    '--standby-clock-size-scale',
    String(snapshot.appearance.standbyClockSizePercent / 100),
  );
  rootStyle.setProperty(
    '--message-line-spacing-scale',
    String(snapshot.appearance.lineSpacingPercent / 100),
  );
  rootStyle.setProperty(
    '--logo-outline',
    calculateLogoOutline(snapshot.appearance.backgroundColor),
  );
  rootStyle.setProperty(
    '--standby-scrim',
    calculateStandbyScrim(snapshot.appearance.fontColor),
  );
  prepareMessageBackground(snapshot.appearance.messageBackgroundPreset);
  elements.stage.dataset.settingsRevision = String(snapshot.revision);
  applyEmergencyBackground(currentPresentation?.emergencyTone);
  applyLogo();
  syncStandbyBackgroundPlayer();
  syncClock();
  updateChromeVisibility();
  scheduleFit();
}

function renderBlank(snapshot) {
  clearVisualLayers();
  // 每次重新進入待機都從乾淨的第一張開始，且第一張不播放轉場。
  clearStandbyBackgroundImages();
  applyEmergencyBackground(null);
  updateAnnouncement('', 'off');
  elements.normalLayer.hidden = false;
  elements.pageLayer.hidden = true;
  elements.fillLayer.hidden = true;
  elements.stage.dataset.mode = 'blank';
  delete elements.stage.dataset.emergencyTone;
  elements.stage.dataset.revision = String(snapshot.revision);
  syncClock();
  updateChromeVisibility();
}

function renderPage(snapshot) {
  clearVisualLayers();
  applyEmergencyBackground(null);
  updateAnnouncement(
    snapshot.messages.map(({ message }) => message).join('\n'),
    'polite',
  );
  elements.fillLayer.hidden = true;
  elements.normalLayer.hidden = false;
  elements.pageLayer.hidden = false;
  elements.pageLayer.style.setProperty(
    '--row-count',
    String(snapshot.messages.length),
  );
  elements.pageLayer.dataset.layout = snapshot.messages.every(
    ({ alignment }) => alignment === 'center',
  )
    ? 'operation'
    : 'messages';

  const hasLiquidEligibleMessage = snapshot.messages.some(
    ({ alignment }) => alignment === 'left',
  );
  const liquidPrepared =
    currentSettings.appearance.messageLiquidEffectEnabled &&
    hasLiquidEligibleMessage &&
    messageLiquidAnimator.prepare(snapshot, elements.pageLayer);

  const fragment = document.createDocumentFragment();
  let activeLiquidRowCount = 0;

  for (const { message, alignment } of snapshot.messages) {
    const row = document.createElement('div');
    row.className = 'message-row';
    row.dataset.message = message;
    row.dataset.alignment = alignment;
    const vessel = createStaticMessage(row, message);
    row.dataset.liquidEffect =
      liquidPrepared &&
      alignment === 'left' &&
      vessel.dataset.liquidCompatible === 'true'
        ? 'active'
        : 'static';
    if (row.dataset.liquidEffect === 'active') {
      activeLiquidRowCount += 1;
    }
    fragment.append(row);
  }

  if (liquidPrepared && activeLiquidRowCount === 0) {
    // 極端輸入採白字安全路徑，不保留永遠不會啟動的裝飾時鐘。
    messageLiquidAnimator.reset();
  }

  elements.pageLayer.append(fragment);
  elements.stage.dataset.mode = 'page';
  delete elements.stage.dataset.emergencyTone;
  elements.stage.dataset.revision = String(snapshot.revision);
  syncClock();
  updateChromeVisibility();
  scheduleFit();
}

function renderEmergency(snapshot) {
  clearVisualLayers();
  const message = snapshot.messages[0].message;
  const glyph = EMERGENCY_GLYPHS[snapshot.emergencyTone] ?? '';
  updateAnnouncement(message, 'assertive');
  elements.normalLayer.hidden = true;
  elements.pageLayer.hidden = true;
  elements.fillLayer.hidden = false;
  applyEmergencyBackground(snapshot.emergencyTone);
  elements.stage.dataset.emergencyTone = snapshot.emergencyTone;

  const fragment = document.createDocumentFragment();

  for (let index = 0; index < EMERGENCY_GRID_CELL_COUNT; index += 1) {
    const cell = document.createElement('span');
    cell.className = 'fill-cell';
    cell.textContent = glyph;
    fragment.append(cell);
  }

  elements.fillLayer.append(fragment);
  elements.stage.dataset.mode = 'emergency';
  elements.stage.dataset.revision = String(snapshot.revision);
  elements.stage.dataset.fittedRevision = String(snapshot.revision);
  syncClock();
  updateChromeVisibility();
}

function renderPresentation(snapshot) {
  currentPresentation = snapshot;

  if (snapshot.mode === 'blank') {
    renderBlank(snapshot);
    // renderBlank 完成清理後才啟動播放器，避免取消第一張的停留計時。
    syncStandbyBackgroundPlayer();
    return;
  }

  syncStandbyBackgroundPlayer();

  if (snapshot.mode === 'emergency') {
    renderEmergency(snapshot);
    return;
  }

  renderPage(snapshot);
}

function hasRequiredBridge(api) {
  return (
    typeof api?.getPresentation === 'function' &&
    typeof api?.onPresentationChanged === 'function' &&
    typeof api?.getSettings === 'function' &&
    typeof api?.onSettingsChanged === 'function' &&
    typeof api?.onRefitRequested === 'function' &&
    typeof api?.reportPageProgress === 'function' &&
    typeof api?.getOutputAdjustment === 'function' &&
    typeof api?.onOutputAdjustmentChanged === 'function'
  );
}

function handleFontsLoadingDone() {
  const sameMotionFallbackScope = Boolean(
    liquidMotionFallbackScope !== null &&
    liquidMotionFallbackScope.presentationRevision ===
      currentPresentation?.revision &&
    liquidMotionFallbackScope.settingsRevision === currentSettings.revision
  );
  if (
    sameMotionFallbackScope ||
    (
      messageLiquidMotionPreference?.matches === true &&
      elements.pageLayer.querySelector(
        '.message-row[data-liquid-effect="active"]',
      ) !== null
    )
  ) {
    return;
  }

  // 動態切換內嵌字型後，必須用真正字型重新判斷縮字、壓縮與跑馬燈。
  scheduleFit();
}

elements.logo.addEventListener('load', handleLogoLoad);
elements.logo.addEventListener('error', handleLogoError);
document.fonts.addEventListener('loadingdone', handleFontsLoadingDone);
messageLiquidMotionPreference?.addEventListener?.(
  'change',
  handleMessageLiquidMotionPreferenceChange,
);
for (const image of elements.standbyBackgroundImages) {
  image.addEventListener('load', handleStandbyBackgroundLoad);
  image.addEventListener('error', handleStandbyBackgroundError);
}
applyDisplaySettings(SAFE_DISPLAY_SETTINGS);

const resizeObserver = new ResizeObserver(() => {
  scheduleStandbySandPreparation();
  scheduleFit();
});
resizeObserver.observe(elements.stage);
resizeObserver.observe(elements.pageLayer);
resizeObserver.observe(document.documentElement);

async function boot() {
  const bridge = window.displayCoreDisplay;

  if (!hasRequiredBridge(bridge)) {
    document.documentElement.dataset.displayReady = 'false';
    document.documentElement.dataset.settingsReady = 'false';
    return;
  }

  pageProgressReporter = createPageProgressReporter({
    report: (...args) => bridge.reportPageProgress(...args),
    initialLayoutGeneration: readStoredLayoutGeneration(),
    onLayoutGeneration: storeLayoutGeneration,
    onPendingAccepted: startAcceptedPageLayout,
    onStartedAccepted: startAcceptedPageEffects,
  });
  unsubscribeRefitRequested = bridge.onRefitRequested(handleRefitRequested);
  if (typeof unsubscribeRefitRequested !== 'function') {
    unsubscribeRefitRequested = null;
    document.documentElement.dataset.displayReady = 'false';
    document.documentElement.dataset.settingsReady = 'false';
    return;
  }

  unsubscribeOutputAdjustment = bridge.onOutputAdjustmentChanged(
    applyOutputAdjustment,
  );
  try {
    const adjustment = await bridge.getOutputAdjustment();
    if (adjustment?.ok === true) {
      applyOutputAdjustment(adjustment.data);
    }
  } catch {
    // 取不到時維持原始畫面；Main 狀態改變時仍會推送最新調整。
  }

  const settingsApi = Object.freeze({
    getSettings: () => bridge.getSettings(),
    onSettingsChanged: (listener) => bridge.onSettingsChanged(listener),
  });
  settingsController = createDisplaySettingsController({
    api: settingsApi,
    view: Object.freeze({ applyDisplaySettings }),
  });
  const settingsStarted = await settingsController.start();
  await waitForCurrentMessageBackground();

  try {
    await document.fonts.ready;
  } catch {
    // 系統字型仍可使用；後續 ResizeObserver 會再次量測。
  }

  const presentationApi = Object.freeze({
    getPresentation: () => bridge.getPresentation(),
    onPresentationChanged: (listener) =>
      bridge.onPresentationChanged(listener),
  });
  presentationController = createDisplayController({
    api: presentationApi,
    view: Object.freeze({ renderPresentation }),
  });
  const presentationStarted = await presentationController.start();
  document.documentElement.dataset.displayReady = String(presentationStarted);
  document.documentElement.dataset.settingsReady = String(settingsStarted);
}

window.addEventListener(
  'beforeunload',
  () => {
    presentationController?.dispose();
    settingsController?.dispose();
    pageProgressReporter?.dispose();
    unsubscribeRefitRequested?.();
    unsubscribeRefitRequested = null;
    unsubscribeOutputAdjustment?.();
    unsubscribeOutputAdjustment = null;
    clock.dispose();
    standbyBackgroundPlayer.dispose();
    messageBackgroundGeneration += 1;
    messageBackgroundLoader.dispose();
    messageLiquidAnimator.dispose();
    cancelScheduledSandPreparation();
    sandTransition.dispose();
    clearStandbySandCanvas({ releaseBuffers: true });
    sandWebglRenderer?.dispose();
    resizeObserver.disconnect();
    document.fonts.removeEventListener('loadingdone', handleFontsLoadingDone);
    messageLiquidMotionPreference?.removeEventListener?.(
      'change',
      handleMessageLiquidMotionPreferenceChange,
    );
    elements.logo.removeEventListener('load', handleLogoLoad);
    elements.logo.removeEventListener('error', handleLogoError);
    for (const image of elements.standbyBackgroundImages) {
      image.removeEventListener('load', handleStandbyBackgroundLoad);
      image.removeEventListener('error', handleStandbyBackgroundError);
    }
    cancelPendingFit();
  },
  { once: true },
);

void boot();
