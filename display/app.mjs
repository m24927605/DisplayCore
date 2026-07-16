import { createDisplayController } from './display-controller.mjs';
import { findLargestFittingFontSize } from './text-fit.mjs';

const DEFAULT_MINIMUM_FONT_REM = 2.5;
const DEFAULT_MARQUEE_ENABLED = true;
const FILL_CELL_COUNT = 24;
const FIT_PRECISION_PX = 0.25;

const elements = Object.freeze({
  stage: document.getElementById('display-stage'),
  announcement: document.getElementById('display-announcement'),
  pageLayer: document.getElementById('page-layer'),
  fillLayer: document.getElementById('fill-layer'),
});

let controller = null;
let currentSnapshot = null;
let renderGeneration = 0;
let fitFrame = null;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
  elements.stage.dataset.marqueeCount = '0';
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
    const text = row.querySelector('.message-text');

    if (!text) {
      return false;
    }

    const textBox = text.getBoundingClientRect();
    return (
      textBox.width <= row.clientWidth + 0.5 &&
      textBox.height <= row.clientHeight + 0.5
    );
  });
}

function calculateMaximumFontSize(rows) {
  const availableWidth = elements.pageLayer.clientWidth;
  const availableHeight = elements.pageLayer.clientHeight;
  const rowCount = Math.max(1, rows.length);

  return Math.max(
    DEFAULT_MINIMUM_FONT_REM * 16,
    Math.min(
      availableWidth * 0.24,
      availableHeight / (rowCount * 1.08),
    ),
  );
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

function fitBelowMinimum(rows, minimumFontSize) {
  const fallback = findLargestFittingFontSize({
    minimumFontSize: 1,
    maximumFontSize: minimumFontSize,
    precision: FIT_PRECISION_PX,
    fits: (fontSize) => pageFitsAt(fontSize, rows),
  });
  elements.pageLayer.style.fontSize = `${fallback.fontSize}px`;

  if (fallback.fitsAtMinimum) {
    return;
  }

  // 極端 10,000 字且停用動態時，以水平壓縮守住「完整、不截斷」優先序。
  for (const row of rows) {
    const text = row.querySelector('.message-text');
    const textWidth = text?.getBoundingClientRect().width || 0;

    if (text && textWidth > row.clientWidth && textWidth > 0) {
      row.classList.add('is-compressed');
      row.style.setProperty(
        '--compression-ratio',
        String(row.clientWidth / textWidth),
      );
    }
  }
}

function fitCurrentPage(revision, generation) {
  if (
    generation !== renderGeneration ||
    currentSnapshot?.mode !== 'page' ||
    currentSnapshot.revision !== revision
  ) {
    return;
  }

  const rows = getRows();

  for (const row of rows) {
    createStaticMessage(row, row.dataset.message || '');
  }

  const rootFontSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  ) || 16;
  const minimumFontSize = DEFAULT_MINIMUM_FONT_REM * rootFontSize;
  const maximumFontSize = calculateMaximumFontSize(rows);
  const fit = findLargestFittingFontSize({
    minimumFontSize,
    maximumFontSize,
    precision: FIT_PRECISION_PX,
    fits: (fontSize) => pageFitsAt(fontSize, rows),
  });
  elements.pageLayer.style.fontSize = `${fit.fontSize}px`;

  if (!fit.fitsAtMinimum) {
    const canAnimate = DEFAULT_MARQUEE_ENABLED && !reducedMotion.matches;

    if (canAnimate) {
      for (const row of rows) {
        const text = row.querySelector('.message-text');
        const overflowsHorizontally =
          text && text.getBoundingClientRect().width > row.clientWidth + 0.5;

        if (overflowsHorizontally) {
          activateMarquee(row, row.dataset.message || '');
        }
      }
    } else {
      fitBelowMinimum(rows, minimumFontSize);
    }
  }

  elements.stage.dataset.marqueeCount = String(
    elements.pageLayer.querySelectorAll('.is-marquee').length,
  );
  elements.stage.dataset.fittedRevision = String(revision);
}

function scheduleFit() {
  if (currentSnapshot?.mode !== 'page') {
    return;
  }

  if (fitFrame !== null) {
    cancelAnimationFrame(fitFrame);
  }

  const generation = renderGeneration;
  const revision = currentSnapshot.revision;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    fitCurrentPage(revision, generation);
  });
}

function renderBlank(snapshot) {
  clearVisualLayers();
  elements.announcement.textContent = '';
  elements.pageLayer.hidden = true;
  elements.fillLayer.hidden = true;
  elements.stage.dataset.mode = 'blank';
  elements.stage.dataset.revision = String(snapshot.revision);
}

function renderPage(snapshot) {
  clearVisualLayers();
  elements.announcement.textContent = snapshot.messages
    .map(({ message }) => message)
    .join('\n');
  elements.fillLayer.hidden = true;
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
  scheduleFit();
}

function renderEmergency(snapshot) {
  clearVisualLayers();
  const message = snapshot.messages[0].message;
  elements.announcement.textContent = message;
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
}

function renderPresentation(snapshot) {
  currentSnapshot = snapshot;

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
    typeof api?.onPresentationChanged === 'function'
  );
}

const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});
resizeObserver.observe(elements.stage);
reducedMotion.addEventListener('change', scheduleFit);

async function boot() {
  const bridge = window.displayCoreDisplay;

  if (!hasRequiredBridge(bridge)) {
    document.documentElement.dataset.displayReady = 'false';
    return;
  }

  try {
    await document.fonts.ready;
  } catch {
    // 系統字型仍可使用；後續 ResizeObserver 會再次量測。
  }

  const api = Object.freeze({
    getPresentation: () => bridge.getPresentation(),
    onPresentationChanged: (listener) =>
      bridge.onPresentationChanged(listener),
  });
  controller = createDisplayController({
    api,
    view: Object.freeze({ renderPresentation }),
  });
  const started = await controller.start();
  document.documentElement.dataset.displayReady = String(started);
}

window.addEventListener(
  'beforeunload',
  () => {
    controller?.dispose();
    resizeObserver.disconnect();
    reducedMotion.removeEventListener('change', scheduleFit);
    cancelPendingFit();
  },
  { once: true },
);

void boot();
