import { splitMessageTypographyRuns } from '/display/message-typography.mjs';
import {
  LIQUID_PROTOTYPE_PROGRESS_STEPS,
  createLiquidVisualState,
} from '/liquid-state.mjs';

const PROTOTYPE_MESSAGES = Object.freeze([
  '001請至前廳',
  'Nancy聯絡櫃台',
  '006請至櫃檯',
]);

const pageLayer = document.getElementById('page-layer');
const stage = document.getElementById('display-stage');
const clock = document.getElementById('display-clock');

window.__liquidPrototype = Object.freeze({ state: 'starting' });

function appendTypography(target, message) {
  for (const run of splitMessageTypographyRuns(message)) {
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

function createLayer(className, message) {
  const layer = document.createElement('span');
  layer.className = `liquid-layer ${className}`;
  layer.setAttribute('aria-hidden', 'true');
  appendTypography(layer, message);
  return layer;
}

function createLiquidMessage(message) {
  const wrapper = document.createElement('span');
  wrapper.className = 'message-text liquid-message';
  wrapper.dataset.message = message;
  wrapper.append(
    createLayer('liquid-base', message),
    createLayer('liquid-fill', message),
    createLayer('liquid-surface', message),
    createLayer('liquid-shell', message),
  );
  return wrapper;
}

function renderMessages() {
  const fragment = document.createDocumentFragment();
  for (const message of PROTOTYPE_MESSAGES) {
    const row = document.createElement('div');
    row.className = 'message-row';
    row.dataset.alignment = 'left';
    row.dataset.message = message;
    row.setAttribute('aria-label', message);
    row.append(createLiquidMessage(message));
    fragment.append(row);
  }
  pageLayer.append(fragment);
}

function toRect(element) {
  const { height, left, top, width } = element.getBoundingClientRect();
  return { height, left, top, width };
}

function inspect(progress, visualState) {
  const rows = [...document.querySelectorAll('.message-row')];
  const wrappers = [...document.querySelectorAll('.liquid-message')];
  const clockStyle = getComputedStyle(clock);
  return Object.freeze({
    clock: {
      animationCount: clock.getAnimations({ subtree: true }).length,
      color: clockStyle.color,
      fillColor: clockStyle.webkitTextFillColor,
      liquidLayerCount: clock.querySelectorAll('.liquid-layer').length,
      rect: toRect(clock),
      strokeWidth: clockStyle.webkitTextStrokeWidth,
    },
    fillPercent: visualState.fillPercent,
    fontFaces: [...document.fonts].map(({ family, status }) => ({ family, status })),
    progress,
    rowCount: rows.length,
    rows: wrappers.map((wrapper) => {
      const base = wrapper.querySelector('.liquid-base');
      const fill = wrapper.querySelector('.liquid-fill');
      const surface = wrapper.querySelector('.liquid-surface');
      const shell = wrapper.querySelector('.liquid-shell');
      const baseStyle = getComputedStyle(base);
      const fillStyle = getComputedStyle(fill);
      const shellStyle = getComputedStyle(shell);
      return {
        baseFillColor: baseStyle.webkitTextFillColor,
        baseRect: toRect(base),
        fillClipPath: fillStyle.clipPath,
        fillRect: toRect(fill),
        fillTextColor: fillStyle.webkitTextFillColor,
        layerCount: wrapper.querySelectorAll('.liquid-layer').length,
        liquidColor: wrapper.style.getPropertyValue('--liquid-color'),
        liquidDeepColor: wrapper.style.getPropertyValue('--liquid-deep-color'),
        message: wrapper.dataset.message,
        shellRect: toRect(shell),
        shellStrokeColor: shellStyle.webkitTextStrokeColor,
        shellStrokeWidth: shellStyle.webkitTextStrokeWidth,
        surfaceOpacity: Number.parseFloat(
          wrapper.style.getPropertyValue('--liquid-surface-opacity'),
        ),
        surfaceRect: toRect(surface),
        wrapperRect: toRect(wrapper),
      };
    }),
    stage: {
      backgroundImage: getComputedStyle(stage).backgroundImage,
      height: stage.clientHeight,
      mode: stage.dataset.mode,
      progress: stage.dataset.liquidProgress,
      width: stage.clientWidth,
    },
    surfacePercent: visualState.surfacePercent,
    surfaceSpread: Math.max(...visualState.surfacePoints.map(({ y }) => y)) -
      Math.min(...visualState.surfacePoints.map(({ y }) => y)),
    viewportHasOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth ||
      document.documentElement.scrollHeight > document.documentElement.clientHeight,
  });
}

async function setProgress(progress) {
  const state = createLiquidVisualState(progress);
  for (const wrapper of document.querySelectorAll('.liquid-message')) {
    wrapper.style.setProperty('--liquid-color', state.liquidColor);
    wrapper.style.setProperty('--liquid-deep-color', state.deepColor);
    wrapper.style.setProperty('--liquid-fill-clip', state.fillClipPath);
    wrapper.style.setProperty('--liquid-rim-color', state.rimColor);
    wrapper.style.setProperty('--liquid-surface-clip', state.surfaceClipPath);
    wrapper.style.setProperty('--liquid-surface-color', state.surfaceColor);
    wrapper.style.setProperty(
      '--liquid-surface-opacity',
      String(state.surfaceOpacity),
    );
  }
  stage.dataset.liquidProgress = String(progress);
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
  const snapshot = inspect(progress, state);
  window.__liquidPrototype = Object.freeze({
    progressSteps: LIQUID_PROTOTYPE_PROGRESS_STEPS,
    snapshot,
    state: 'succeeded',
  });
  return snapshot;
}

async function start() {
  renderMessages();
  const background = new Image();
  background.src = '/assets/message-backgrounds/dark-marble.jpg';
  await Promise.all([document.fonts.ready, background.decode()]);
  window.__setLiquidPrototypeProgress = setProgress;
  await setProgress(0);
}

start().catch((error) => {
  window.__liquidPrototype = Object.freeze({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
    state: 'failed',
  });
});
