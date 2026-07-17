import { createDisplayClock } from './date-time.mjs';
import { createDisplayController } from './display-controller.mjs';
import { createPageProgressReporter } from './page-progress.mjs';
import {
  classifyLogoAlpha,
  LOGO_TREATMENTS,
} from './logo-appearance.mjs';
import { calculateLogoLayoutScales } from './logo-size.mjs';
import { createDisplaySettingsController } from './settings-controller.mjs';
import { SAFE_DISPLAY_SETTINGS } from './settings-state.mjs';
import {
  createStandbyBackgroundPlayer,
} from './standby-background-player.mjs';
import { resolveRenderResolution } from './render-resolution.mjs';
import {
  calculateResponsiveFontBounds,
  findLargestFittingFontSize,
} from './text-fit.mjs';

const FILL_CELL_COUNT = 24;
const FIT_PRECISION_PX = 0.25;
const MESSAGE_LINE_HEIGHT = 1.08;
const LOGO_ALPHA_SAMPLE_EDGE = 64;
const LAYOUT_GENERATION_STORAGE_KEY = 'displaycore-layout-generation';

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
  chrome: document.getElementById('display-chrome'),
  logoFrame: document.getElementById('logo-frame'),
  logo: document.getElementById('display-logo'),
  clock: document.getElementById('display-clock'),
  pageLayer: document.getElementById('page-layer'),
  standbyLayer: document.getElementById('standby-layer'),
  fillLayer: document.getElementById('fill-layer'),
});

let presentationController = null;
let settingsController = null;
let pageProgressReporter = null;
let unsubscribeRefitRequested = null;
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
let clockHasValue = false;
let clockSignature = null;

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
    // 每秒只更新文字；若可見性不變，不重建正在播放的跑馬燈。
    if (clockHasValue !== previousClockHasValue) {
      scheduleFit();
    }
  },
});
const standbyBackgroundPlayer = createStandbyBackgroundPlayer({
  onSourceChange: applyStandbyBackgroundSource,
});

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
  elements.pageLayer.textContent = '';
  elements.fillLayer.textContent = '';
  elements.standbyLayer.hidden = true;
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

function createStaticMessage(row, message) {
  row.textContent = '';
  row.classList.remove('is-marquee', 'is-compressed');
  row.style.removeProperty('--compression-ratio');

  const text = document.createElement('span');
  text.className = 'message-text';
  text.textContent = message;
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

  const track = document.createElement('span');
  track.className = 'marquee-track';
  track.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < 2; index += 1) {
    const copy = document.createElement('span');
    copy.className = 'marquee-copy';
    copy.textContent = message;
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
    if (currentSettings.marquee.enabled) {
      for (const row of rows) {
        const message = row.querySelector('.message-text');
        const overflowsHorizontally =
          message &&
          message.getBoundingClientRect().width >
            row.getBoundingClientRect().width + 0.5;

        if (overflowsHorizontally) {
          activateMarquee(row, row.dataset.message || '');
        }
      }
    } else {
      // 操作者停用跑馬燈時守住最小字級，並水平縮放以保留完整文字。
      compressOverflowingRows(rows);
    }
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
    [...elements.pageLayer.querySelectorAll('.marquee-track')],
  );
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
  elements.clock.hidden = !showClock;
  elements.normalLayer.classList.toggle('has-logo', showLogo);
  elements.normalLayer.classList.toggle('has-clock', showClock);
  elements.chrome.hidden = !showLogo;
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

/** 解析邏輯畫布並置中縮放；不變更 Windows 或 HDMI 的實體顯示模式。 */
function applyRenderResolution() {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  let resolved;

  try {
    resolved = resolveRenderResolution({
      profile: currentSettings.display.renderResolution,
      viewportWidth,
      viewportHeight,
    });
  } catch {
    return false;
  }

  elements.renderSurface.style.inlineSize = `${resolved.logicalWidth}px`;
  elements.renderSurface.style.blockSize = `${resolved.logicalHeight}px`;
  elements.renderSurface.style.insetInlineStart = `${resolved.offsetX}px`;
  elements.renderSurface.style.insetBlockStart = `${resolved.offsetY}px`;
  elements.renderSurface.style.setProperty('--render-scale', String(resolved.scale));
  elements.stage.dataset.renderResolution = resolved.profile;
  elements.stage.dataset.logicalWidth = String(resolved.logicalWidth);
  elements.stage.dataset.logicalHeight = String(resolved.logicalHeight);
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

function isExpectedStandbyBackground(image) {
  return image === pendingStandbyBackgroundImage &&
    expectedStandbyBackgroundUrl !== null &&
    image.getAttribute('src') === expectedStandbyBackgroundUrl;
}

/** 只有 pending 圖成功解碼後才原子替換目前健康背景。 */
function commitStandbyBackgroundImage(image, url) {
  if (!isExpectedStandbyBackground(image) || url !== expectedStandbyBackgroundUrl) {
    return false;
  }

  activeStandbyBackgroundImage = image;
  pendingStandbyBackgroundImage = null;
  expectedStandbyBackgroundUrl = null;
  standbyBackgroundReady = true;
  elements.stage.dataset.standbyBackgroundState = 'ready';
  updateChromeVisibility();
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

/** 依文字明暗自動提供相反色遮罩，不增加管理員設定負擔。 */
function calculateStandbyScrim(fontColor) {
  const red = Number.parseInt(fontColor.slice(1, 3), 16);
  const green = Number.parseInt(fontColor.slice(3, 5), 16);
  const blue = Number.parseInt(fontColor.slice(5, 7), 16);
  const relativeBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  return relativeBrightness >= 150
    ? 'rgb(0 0 0 / 48%)'
    : 'rgb(255 255 255 / 52%)';
}

function applyEmergencyBackground(tone) {
  const isEmergency = tone === 'inspection' || tone === 'release';
  let background = currentSettings.appearance.backgroundColor;

  if (tone === 'inspection') {
    background = currentSettings.emergency.inspectionBackgroundColor;
  } else if (tone === 'release') {
    background = currentSettings.emergency.releaseBackgroundColor;
  }

  const rootStyle = document.documentElement.style;

  if (isEmergency) {
    rootStyle.setProperty('--emergency-background', background);
  }
  // contain 排版可能留下邊帶；viewport 必須與緊急畫布同色才是真正滿屏。
  rootStyle.setProperty('--viewport-background', background);
}

function applyDisplaySettings(snapshot) {
  cancelPendingFit();
  currentSettings = snapshot;
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
  elements.stage.dataset.settingsRevision = String(snapshot.revision);
  applyRenderResolution();
  applyEmergencyBackground(currentPresentation?.emergencyTone);
  applyLogo();
  syncStandbyBackgroundPlayer();
  syncClock();
  updateChromeVisibility();
  scheduleFit();
}

function renderBlank(snapshot) {
  clearVisualLayers();
  applyEmergencyBackground(null);
  updateAnnouncement('歡迎光臨', 'polite');
  elements.normalLayer.hidden = false;
  elements.pageLayer.hidden = true;
  elements.standbyLayer.hidden = false;
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
  elements.standbyLayer.hidden = true;
  elements.pageLayer.hidden = false;
  elements.pageLayer.style.setProperty(
    '--row-count',
    String(snapshot.messages.length),
  );

  const fragment = document.createDocumentFragment();

  for (const { message, alignment } of snapshot.messages) {
    const row = document.createElement('div');
    row.className = 'message-row';
    row.dataset.message = message;
    row.dataset.alignment = alignment;
    createStaticMessage(row, message);
    fragment.append(row);
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
  updateAnnouncement(message, 'assertive');
  elements.normalLayer.hidden = true;
  elements.pageLayer.hidden = true;
  elements.standbyLayer.hidden = true;
  elements.fillLayer.hidden = false;
  applyEmergencyBackground(snapshot.emergencyTone);
  elements.stage.dataset.emergencyTone = snapshot.emergencyTone;

  const fragment = document.createDocumentFragment();

  for (let index = 0; index < FILL_CELL_COUNT; index += 1) {
    const cell = document.createElement('span');
    cell.className = 'fill-cell';
    cell.textContent = message;
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
  syncStandbyBackgroundPlayer();

  if (snapshot.mode === 'blank') {
    renderBlank(snapshot);
    return;
  }

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
    typeof api?.reportPageProgress === 'function'
  );
}

elements.logo.addEventListener('load', handleLogoLoad);
elements.logo.addEventListener('error', handleLogoError);
for (const image of elements.standbyBackgroundImages) {
  image.addEventListener('load', handleStandbyBackgroundLoad);
  image.addEventListener('error', handleStandbyBackgroundError);
}
applyDisplaySettings(SAFE_DISPLAY_SETTINGS);

const resizeObserver = new ResizeObserver(() => {
  applyRenderResolution();
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
  });
  unsubscribeRefitRequested = bridge.onRefitRequested(handleRefitRequested);
  if (typeof unsubscribeRefitRequested !== 'function') {
    unsubscribeRefitRequested = null;
    document.documentElement.dataset.displayReady = 'false';
    document.documentElement.dataset.settingsReady = 'false';
    return;
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
    clock.dispose();
    standbyBackgroundPlayer.dispose();
    resizeObserver.disconnect();
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
