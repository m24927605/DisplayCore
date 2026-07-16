import { createDisplayClock } from './date-time.mjs';
import { createDisplayController } from './display-controller.mjs';
import { createDisplaySettingsController } from './settings-controller.mjs';
import { SAFE_DISPLAY_SETTINGS } from './settings-state.mjs';
import {
  calculateResponsiveFontBounds,
  findLargestFittingFontSize,
} from './text-fit.mjs';

const FILL_CELL_COUNT = 24;
const FIT_PRECISION_PX = 0.25;
const MESSAGE_LINE_HEIGHT = 1.08;

const elements = Object.freeze({
  stage: document.getElementById('display-stage'),
  announcement: document.getElementById('display-announcement'),
  normalLayer: document.getElementById('normal-layer'),
  chrome: document.getElementById('display-chrome'),
  logoFrame: document.getElementById('logo-frame'),
  logo: document.getElementById('display-logo'),
  clock: document.getElementById('display-clock'),
  pageLayer: document.getElementById('page-layer'),
  fillLayer: document.getElementById('fill-layer'),
});

let presentationController = null;
let settingsController = null;
let currentPresentation = null;
let currentSettings = SAFE_DISPLAY_SETTINGS;
let renderGeneration = 0;
let fitFrame = null;
let expectedLogoUrl = null;
let logoReady = false;
let clockHasValue = false;
let clockSignature = null;

const clock = createDisplayClock({
  render(value) {
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
    scheduleFit();
  },
});

function cancelPendingFit() {
  renderGeneration += 1;

  if (fitFrame !== null) {
    cancelAnimationFrame(fitFrame);
    fitFrame = null;
  }
}

function clearVisualLayers() {
  cancelPendingFit();
  elements.pageLayer.textContent = '';
  elements.fillLayer.textContent = '';
  elements.pageLayer.removeAttribute('style');
  elements.stage.dataset.fittedRevision = '';
  elements.stage.dataset.fittedSettingsRevision = '';
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
    return (
      textBox.width <= row.clientWidth + 0.5 &&
      textBox.height <= row.clientHeight + 0.5
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
  const distance = firstCopy?.getBoundingClientRect().width || row.clientWidth;
  const speed = Math.max(48, elements.stage.clientWidth * 0.045);
  const durationSeconds = Math.max(8, distance / speed);
  track.style.setProperty('--marquee-duration', `${durationSeconds}s`);
}

function compressOverflowingRows(rows) {
  for (const row of rows) {
    const message = row.querySelector('.message-text');
    const textWidth = message?.getBoundingClientRect().width || 0;

    if (message && textWidth > row.clientWidth && textWidth > 0) {
      row.classList.add('is-compressed');
      row.style.setProperty(
        '--compression-ratio',
        String(row.clientWidth / textWidth),
      );
    }
  }
}

function fitCurrentPage(presentationRevision, settingsRevision, generation) {
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
          message.getBoundingClientRect().width > row.clientWidth + 0.5;

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
}

function scheduleFit() {
  if (currentPresentation?.mode !== 'page') {
    return;
  }

  if (fitFrame !== null) {
    cancelAnimationFrame(fitFrame);
  }

  const generation = renderGeneration;
  const presentationRevision = currentPresentation.revision;
  const settingsRevision = currentSettings.revision;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    fitCurrentPage(presentationRevision, settingsRevision, generation);
  });
}

function updateChromeVisibility() {
  const pageVisible = currentPresentation?.mode === 'page';
  const showLogo =
    pageVisible && currentSettings.logo.enabled && logoReady;
  const showClock =
    pageVisible && currentSettings.dateTime.enabled && clockHasValue;

  elements.logoFrame.hidden = !showLogo;
  elements.logo.hidden = !showLogo;
  elements.clock.hidden = !showClock;
  elements.normalLayer.classList.toggle('has-chrome', showLogo || showClock);
  elements.chrome.hidden = !(showLogo || showClock);
}

function syncClock() {
  const enabled =
    currentPresentation?.mode === 'page' && currentSettings.dateTime.enabled;
  const signature = [
    enabled,
    currentSettings.dateTime.locale,
    currentSettings.dateTime.hour12,
  ].join('|');

  if (signature === clockSignature) {
    updateChromeVisibility();
    return;
  }

  clockSignature = signature;
  clock.update({
    enabled,
    locale: currentSettings.dateTime.locale,
    hour12: currentSettings.dateTime.hour12,
  });
}

function handleLogoLoad() {
  if (
    expectedLogoUrl === null ||
    elements.logo.getAttribute('src') !== expectedLogoUrl
  ) {
    return;
  }

  logoReady = elements.logo.naturalWidth > 0 && elements.logo.naturalHeight > 0;
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
    elements.stage.dataset.logoState = 'ready';
    updateChromeVisibility();
    return;
  }

  logoReady = false;
  elements.stage.dataset.logoState = 'loading';
  elements.logo.src = nextUrl;
  updateChromeVisibility();
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

function applyDisplaySettings(snapshot) {
  cancelPendingFit();
  currentSettings = snapshot;
  const rootStyle = document.documentElement.style;
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
    '--logo-outline',
    calculateLogoOutline(snapshot.appearance.backgroundColor),
  );
  elements.stage.dataset.settingsRevision = String(snapshot.revision);
  applyLogo();
  syncClock();
  updateChromeVisibility();
  scheduleFit();
}

function renderBlank(snapshot) {
  clearVisualLayers();
  updateAnnouncement('', 'polite');
  elements.normalLayer.hidden = true;
  elements.pageLayer.hidden = true;
  elements.fillLayer.hidden = true;
  elements.stage.dataset.mode = 'blank';
  elements.stage.dataset.revision = String(snapshot.revision);
  syncClock();
  updateChromeVisibility();
}

function renderPage(snapshot) {
  clearVisualLayers();
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

  const fragment = document.createDocumentFragment();

  for (const { message } of snapshot.messages) {
    const row = document.createElement('div');
    row.className = 'message-row';
    row.dataset.message = message;
    createStaticMessage(row, message);
    fragment.append(row);
  }

  elements.pageLayer.append(fragment);
  elements.stage.dataset.mode = 'page';
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
  elements.fillLayer.hidden = false;

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
    typeof api?.onSettingsChanged === 'function'
  );
}

elements.logo.addEventListener('load', handleLogoLoad);
elements.logo.addEventListener('error', handleLogoError);
applyDisplaySettings(SAFE_DISPLAY_SETTINGS);

const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});
resizeObserver.observe(elements.stage);
resizeObserver.observe(elements.pageLayer);

async function boot() {
  const bridge = window.displayCoreDisplay;

  if (!hasRequiredBridge(bridge)) {
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
  const settingsStartPromise = settingsController.start();

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
  const settingsStarted = await settingsStartPromise;
  document.documentElement.dataset.displayReady = String(presentationStarted);
  document.documentElement.dataset.settingsReady = String(settingsStarted);
}

window.addEventListener(
  'beforeunload',
  () => {
    presentationController?.dispose();
    settingsController?.dispose();
    clock.dispose();
    resizeObserver.disconnect();
    elements.logo.removeEventListener('load', handleLogoLoad);
    elements.logo.removeEventListener('error', handleLogoError);
    cancelPendingFit();
  },
  { once: true },
);

void boot();
