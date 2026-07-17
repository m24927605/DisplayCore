'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fileSystem = require('node:fs/promises');
const { rmSync } = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  session,
} = require('electron');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const defaultConfig = require(path.join(projectRoot, 'config.json'));
const { validateConfig } = require(
  path.join(projectRoot, 'config', 'config-schema'),
);
const { IPC_CHANNELS, IPC_ROLES } = require(
  path.join(projectRoot, 'ipc', 'channels'),
);
const { IpcCoordinator } = require(
  path.join(projectRoot, 'ipc', 'ipc-coordinator'),
);
const { PresentationService } = require(
  path.join(projectRoot, 'ipc', 'presentation-service'),
);
const { PresentationStore } = require(
  path.join(projectRoot, 'ipc', 'presentation-store'),
);
const {
  installLocalProtocol,
  registerAppScheme,
} = require(path.join(projectRoot, 'main', 'local-protocol'));
const {
  configureOfflineSession,
  hardenWebContents,
} = require(path.join(projectRoot, 'main', 'security-policy'));
const { createDisplayWindowOptions } = require(
  path.join(projectRoot, 'main', 'window-options'),
);

const DISPLAY_URL = 'displaycore://app/display/index.html';
const CONTROL_URL = 'displaycore://app/control/index.html';
const TIMEOUT_MS = 20_000;
const LOGO_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAHCAYAAADEUlfTAAAAGUlEQVR4nGNgQID/SBgDYJX8jwdTIEmegwDYmyDgo5Y0vwAAAABJRU5ErkJggg==',
  'base64',
);
const STANDBY_BACKGROUND_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let displayWindow = null;
let coordinator = null;
let presentationService = null;
let settingsManager = null;
let completed = false;
let timeout = null;
let runtimeDataRoot = null;

registerAppScheme(protocol);

function finish(exitCode, message, error) {
  if (completed) {
    return;
  }

  completed = true;
  clearTimeout(timeout);
  coordinator?.dispose();
  presentationService?.dispose();

  if (displayWindow?.webContents.debugger.isAttached()) {
    displayWindow.webContents.debugger.detach();
  }

  if (error) {
    console.error(message, error);
  } else {
    console.info(message);
  }

  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.destroy();
  }

  if (runtimeDataRoot) {
    try {
      rmSync(runtimeDataRoot, { recursive: true, force: true });
    } catch {
      // 測試程序即將退出；清理失敗不覆蓋原始測試結果。
    }
  }

  app.exit(exitCode);
}

async function waitFor(predicate, description, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const error = new Error(`等待逾時：${description}`);
  error.cause = lastError;
  throw error;
}

function execute(source) {
  return displayWindow.webContents.executeJavaScript(source, true);
}

async function waitForRevision(revision, fitted = true) {
  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      return stage?.dataset.revision === '${revision}' &&
        ${fitted ? `stage.dataset.fittedRevision === '${revision}'` : 'true'};
    })()`),
    `Display revision ${revision}`,
  );
}

function createFakeTimers() {
  const handles = [];

  return {
    handles,
    setTimer(callback, delay) {
      const handle = { callback, delay, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    fire(index) {
      handles[index].cleared = true;
      handles[index].callback();
    },
    fireHandle(handle) {
      handle.cleared = true;
      handle.callback();
    },
    active() {
      return handles.filter((handle) => !handle.cleared);
    },
  };
}

function assertLogoHighlight(filter, context) {
  assert.match(filter, /brightness\(0\)/, `${context} Logo 清除原始暗色`);
  assert.match(filter, /invert\(1\)/, `${context} Logo 轉為亮白`);
  assert.match(
    filter,
    /rgba\(255, 255, 255, 0\.45\)/,
    `${context} Logo 白色光暈`,
  );
  assert.match(
    filter,
    /rgba\(0, 0, 0, 0\.7\)/,
    `${context} Logo 深色邊緣`,
  );
}

/**
 * 測試圖片是透明底純黑 PNG；擷取實際 Electron 畫面中心像素，確認不是
 * 只有外圍光暈，而是 Logo 本體也真正轉為接近白字的亮度。
 */
async function verifyLogoRenderedBrightWhite(context) {
  const center = await execute(`(() => {
    const logo = document.getElementById('display-logo').getBoundingClientRect();
    return {
      x: Math.floor(logo.left + (logo.width / 2)),
      y: Math.floor(logo.top + (logo.height / 2)),
    };
  })()`);
  const image = await displayWindow.webContents.capturePage({
    x: center.x,
    y: center.y,
    width: 1,
    height: 1,
  });
  const bitmap = image.toBitmap();

  assert.ok(bitmap.length >= 4, `${context} Logo 像素可擷取`);
  for (let offset = 0; offset <= bitmap.length - 4; offset += 4) {
    const colorChannels = [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]];
    assert.ok(
      colorChannels.every((channel) => channel >= 240),
      `${context} Logo 本體未達亮白：${colorChannels.join(',')}`,
    );
  }
}

function createSettingsManager(initialConfig) {
  const initialValidation = validateConfig(initialConfig);

  if (!initialValidation.ok) {
    throw new Error('Display smoke 初始設定無效。');
  }

  const listeners = new Set();
  let snapshot = Object.freeze({
    config: initialValidation.value,
    defaults: initialValidation.value,
    revision: 0,
    notice: null,
  });

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(config) {
      const validation = validateConfig(config);

      if (!validation.ok) {
        throw new Error('Display smoke 更新設定無效。');
      }

      snapshot = Object.freeze({
        config: validation.value,
        defaults: snapshot.defaults,
        revision: snapshot.revision + 1,
        notice: null,
      });

      for (const listener of listeners) {
        listener(snapshot);
      }

      return snapshot;
    },
  };
}

async function verifyDisplayedClockOffset(expectedOffsetSeconds, description) {
  const measurement = await waitFor(
    () => execute(`(() => {
      const text = document.getElementById('display-clock').textContent;
      const match = /^(\\d{2}):(\\d{2}):(\\d{2})$/.exec(text);
      if (!match) {
        return false;
      }

      const displayedSeconds =
        Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      const now = new Date();
      const localSeconds =
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const expectedSeconds =
        (localSeconds + ${expectedOffsetSeconds} + 86400) % 86400;
      const absoluteDifference = Math.abs(displayedSeconds - expectedSeconds);
      const circularDifference = Math.min(
        absoluteDifference,
        86400 - absoluteDifference,
      );

      return circularDifference <= 1 ? {
        text,
        dateTime: document.getElementById('display-clock').getAttribute('datetime'),
        circularDifference,
      } : false;
    })()`),
    description,
  );

  assert.match(measurement.text, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(measurement.dateTime, measurement.text);
  assert.ok(measurement.circularDifference <= 1);
}

/** 真實 BrowserWindow 驗證待機背景、Logo、歡迎文字與時間的層級。 */
async function verifyStandbyPresentation(
  expectedLogoUrl,
  expectedStandbyBackgroundUrl,
) {
  await waitFor(
    () => execute(`(() => {
      const background = document.getElementById('standby-background-image');
      const logo = document.getElementById('display-logo');
      return document.getElementById('display-stage').dataset.mode === 'blank' &&
        background && !background.hidden && background.complete &&
        background.naturalWidth > 0 && logo && !logo.hidden &&
        logo.complete && logo.naturalWidth > 0;
    })()`),
    '待機背景與 Logo 載入',
  );

  const inspection = await execute(`(() => {
    const stage = document.getElementById('display-stage').getBoundingClientRect();
    const layerElement = document.getElementById('standby-background-layer');
    const layer = layerElement.getBoundingClientRect();
    const backgroundElement = document.getElementById('standby-background-image');
    const background = backgroundElement.getBoundingClientRect();
    const logoElement = document.getElementById('display-logo');
    const logo = logoElement.getBoundingClientRect();
    const message = document.getElementById('standby-message').getBoundingClientRect();
    const clock = document.getElementById('display-clock').getBoundingClientRect();
    const center = (box) => box.left + (box.width / 2);
    return {
      layerHidden: layerElement.hidden,
      backgroundHidden: backgroundElement.hidden,
      backgroundSource: backgroundElement.getAttribute('src'),
      backgroundObjectFit: getComputedStyle(backgroundElement).objectFit,
      backgroundCoversStage:
        Math.abs(layer.left - stage.left) <= 0.5 &&
        Math.abs(layer.top - stage.top) <= 0.5 &&
        Math.abs(layer.width - stage.width) <= 0.5 &&
        Math.abs(layer.height - stage.height) <= 0.5 &&
        Math.abs(background.width - stage.width) <= 0.5 &&
        Math.abs(background.height - stage.height) <= 0.5,
      chromeHidden: document.getElementById('display-chrome').hidden,
      logoHidden: logoElement.hidden,
      logoSource: logoElement.getAttribute('src'),
      logoSizeScale: getComputedStyle(document.documentElement)
        .getPropertyValue('--logo-size-scale').trim(),
      logoFilter: getComputedStyle(logoElement).filter,
      logoTreatment: document.getElementById('logo-frame').dataset.logoTreatment,
      logoCenterError: Math.abs(center(logo) - center(stage)),
      messageCenterError: Math.abs(center(message) - center(stage)),
      clockCenterError: Math.abs(center(clock) - center(stage)),
      verticalOrder:
        logo.bottom <= message.top + 0.5 && message.bottom <= clock.top + 0.5,
      rootOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth ||
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  })()`);

  assert.equal(inspection.layerHidden, false);
  assert.equal(inspection.backgroundHidden, false);
  assert.equal(inspection.backgroundSource, expectedStandbyBackgroundUrl);
  assert.equal(inspection.backgroundObjectFit, 'cover');
  assert.equal(inspection.backgroundCoversStage, true);
  assert.equal(inspection.chromeHidden, false);
  assert.equal(inspection.logoHidden, false);
  assert.equal(inspection.logoSource, expectedLogoUrl);
  assert.equal(inspection.logoSizeScale, '1');
  assertLogoHighlight(inspection.logoFilter, '待機');
  assert.equal(inspection.logoTreatment, 'bright-white');
  await verifyLogoRenderedBrightWhite('待機');
  assert.ok(inspection.logoCenterError < 1);
  assert.ok(inspection.messageCenterError < 1);
  assert.ok(inspection.clockCenterError < 1);
  assert.equal(inspection.verticalOrder, true);
  assert.equal(inspection.rootOverflow, false);
  assert.doesNotMatch(
    inspection.backgroundSource,
    /file:|Users|userData|standby-backgrounds/i,
  );
}

/** 同一邏輯解析度下，50／100／200% 必須等比例縮放 Logo。 */
async function verifyLogoSizeScaling(mode) {
  const measurements = [];

  for (const sizePercent of [50, 100, 200]) {
    const nextConfig = structuredClone(settingsManager.getSnapshot().config);
    nextConfig.logo.enabled = true;
    nextConfig.logo.sizePercent = sizePercent;
    nextConfig.display.renderResolution = 'auto';
    const settingsRevision = settingsManager.publish(nextConfig).revision;

    await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        const logo = document.getElementById('display-logo');
        return stage.dataset.mode === '${mode}' &&
          stage.dataset.settingsRevision === '${settingsRevision}' &&
          ${mode === 'page'
            ? `stage.dataset.fittedSettingsRevision === '${settingsRevision}' &&`
            : ''}
          logo && !logo.hidden && logo.complete && logo.naturalWidth > 0;
      })()`),
      `${mode} Logo ${sizePercent}% 套用`,
    );

    const measurement = await execute(`(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const frame = document.getElementById('logo-frame');
      const logo = document.getElementById('display-logo');
      return {
        sizePercent: ${sizePercent},
        scale: rootStyle.getPropertyValue('--logo-size-scale').trim(),
        frameHeight: frame.getBoundingClientRect().height,
        imageHeight: logo.getBoundingClientRect().height,
        frameMaxWidth: Number.parseFloat(getComputedStyle(frame).maxInlineSize),
        imageMaxWidth: Number.parseFloat(getComputedStyle(logo).maxInlineSize),
        filter: getComputedStyle(logo).filter,
        treatment: frame.dataset.logoTreatment,
        standbyBackgroundHidden:
          document.getElementById('standby-background-layer').hidden,
      };
    })()`);

    assert.equal(measurement.scale, String(sizePercent / 100));
    assert.ok(measurement.frameHeight > 0);
    assert.ok(Math.abs(measurement.frameHeight - measurement.imageHeight) <= 0.5);
    assert.ok(Number.isFinite(measurement.frameMaxWidth));
    assert.ok(Number.isFinite(measurement.imageMaxWidth));
    assert.equal(measurement.standbyBackgroundHidden, mode === 'page');
    assertLogoHighlight(measurement.filter, `${mode} ${sizePercent}%`);
    assert.equal(measurement.treatment, 'bright-white');
    measurements.push(measurement);
  }

  const [half, normal, double] = measurements;
  for (const [field, label] of [
    ['frameHeight', 'frame 高度'],
    ['imageHeight', 'image 高度'],
    ['frameMaxWidth', 'frame 最大寬度'],
    ['imageMaxWidth', 'image 最大寬度'],
  ]) {
    assert.ok(
      Math.abs((half[field] / normal[field]) - 0.5) <= 0.05,
      `${mode} ${label} 50% 比例`,
    );
    assert.ok(
      Math.abs((double[field] / normal[field]) - 2) <= 0.05,
      `${mode} ${label} 200% 比例`,
    );
  }
}

async function verifyResponsiveResolutions() {
  const resolutions = [
    [1366, 768],
    [1600, 900],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ];
  const measuredFontSizes = [];

  for (const [width, height] of resolutions) {
    await execute(
      `document.getElementById('display-stage').dataset.fittedRevision = 'pending'`,
    );
    displayWindow.setContentSize(width, height, false);
    await waitFor(
      () => execute(
        `window.innerWidth === ${width} && window.innerHeight === ${height}`,
      ),
      `${width}×${height} viewport`,
    );
    await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        return stage.dataset.fittedRevision === '1' &&
          stage.dataset.fittedSettingsRevision === '0';
      })()`),
      `${width}×${height} responsive fit`,
    );

    const inspection = await execute(`(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const stageElement = document.getElementById('display-stage');
      const surface = document.getElementById('display-render-surface')
        .getBoundingClientRect();
      const normal = document.getElementById('normal-layer').getBoundingClientRect();
      const chrome = document.getElementById('display-chrome').getBoundingClientRect();
      const logo = document.getElementById('display-logo').getBoundingClientRect();
      const clock = document.getElementById('display-clock').getBoundingClientRect();
      const page = document.getElementById('page-layer').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.message-row')];
      return {
        viewport,
        renderResolution: stageElement.dataset.renderResolution,
        logicalWidth: Number(stageElement.dataset.logicalWidth),
        logicalHeight: Number(stageElement.dataset.logicalHeight),
        surfaceInside:
          surface.left >= -0.5 && surface.top >= -0.5 &&
          surface.right <= viewport.width + 0.5 &&
          surface.bottom <= viewport.height + 0.5,
        surfaceWidth: surface.width,
        surfaceHeight: surface.height,
        rootOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.documentElement.scrollHeight > document.documentElement.clientHeight,
        normalInside:
          normal.left >= -0.5 && normal.top >= -0.5 &&
          normal.right <= viewport.width + 0.5 &&
          normal.bottom <= viewport.height + 0.5,
        chromeAndPageSeparate: chrome.bottom <= page.top + 0.5,
        logoWidth: logo.width,
        logoHeight: logo.height,
        pageInside:
          page.left >= -0.5 && page.top >= -0.5 &&
          page.right <= viewport.width + 0.5 &&
          page.bottom <= viewport.height + 0.5,
        rowsInside: rows.every((row) => {
          const box = row.getBoundingClientRect();
          const text = row.querySelector('.message-text, .marquee-copy');
          const textBox = text?.getBoundingClientRect();
          return box.left >= page.left - 0.5 && box.right <= page.right + 0.5 &&
            box.top >= page.top - 0.5 && box.bottom <= page.bottom + 0.5 &&
            textBox && textBox.height <= box.height + 0.5 &&
            getComputedStyle(row).whiteSpace === 'nowrap';
        }),
        clockInside:
          clock.left >= -0.5 && clock.top >= -0.5 &&
          clock.right <= viewport.width + 0.5 &&
          clock.bottom <= viewport.height + 0.5,
        clockDoesNotOverlap:
          rows.length === 0 || rows.at(-1).getBoundingClientRect().bottom <= clock.top + 0.5,
        fontSize: Number.parseFloat(getComputedStyle(
          document.getElementById('page-layer')
        ).fontSize),
      };
    })()`);

    assert.deepEqual(inspection.viewport, { width, height });
    assert.equal(inspection.renderResolution, 'auto');
    assert.equal(inspection.logicalWidth, width);
    assert.equal(inspection.logicalHeight, height);
    assert.equal(inspection.surfaceInside, true, `${width}×${height} surface bounds`);
    assert.ok(Math.abs(inspection.surfaceWidth - width) <= 0.5);
    assert.ok(Math.abs(inspection.surfaceHeight - height) <= 0.5);
    assert.equal(inspection.rootOverflow, false, `${width}×${height} overflow`);
    assert.equal(inspection.normalInside, true, `${width}×${height} normal bounds`);
    assert.equal(
      inspection.chromeAndPageSeparate,
      true,
      `${width}×${height} chrome overlap`,
    );
    assert.equal(inspection.pageInside, true, `${width}×${height} page bounds`);
    assert.equal(inspection.rowsInside, true, `${width}×${height} row bounds`);
    assert.equal(inspection.clockInside, true, `${width}×${height} clock bounds`);
    assert.equal(
      inspection.clockDoesNotOverlap,
      true,
      `${width}×${height} clock overlaps message`,
    );
    assert.ok(inspection.logoWidth > 0, `${width}×${height} logo width`);
    assert.ok(
      inspection.logoHeight >= height * 0.04,
      `${width}×${height} logo too small: ${inspection.logoHeight}`,
    );
    assert.ok(
      inspection.logoHeight <= height * 0.12,
      `${width}×${height} logo too tall: ${inspection.logoHeight}`,
    );
    assert.ok(Number.isFinite(inspection.fontSize) && inspection.fontSize > 0);
    measuredFontSizes.push(inspection.fontSize);
  }

  for (let index = 1; index < measuredFontSizes.length; index += 1) {
    assert.ok(
      measuredFontSizes[index] >= measuredFontSizes[index - 1],
      `字級未隨解析度成長：${measuredFontSizes.join(', ')}`,
    );
  }
}

async function verifyConfiguredRenderResolutions() {
  const viewport = { width: 1600, height: 900 };
  const profiles = [
    ['1366x768', 1366, 768],
    ['1600x900', 1600, 900],
    ['1920x1080', 1920, 1080],
    ['2560x1440', 2560, 1440],
    ['3840x2160', 3840, 2160],
  ];

  displayWindow.setContentSize(viewport.width, viewport.height, false);
  await waitFor(
    () => execute(
      `window.innerWidth === ${viewport.width} && window.innerHeight === ${viewport.height}`,
    ),
    '邏輯解析度驗證 viewport',
  );

  for (const [profile, logicalWidth, logicalHeight] of profiles) {
    const nextConfig = structuredClone(settingsManager.getSnapshot().config);
    nextConfig.display.renderResolution = profile;
    const revision = settingsManager.publish(nextConfig).revision;

    await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        return stage.dataset.settingsRevision === '${revision}' &&
          stage.dataset.renderResolution === '${profile}' &&
          stage.dataset.logicalWidth === '${logicalWidth}' &&
          stage.dataset.logicalHeight === '${logicalHeight}';
      })()`),
      `${profile} 邏輯解析度套用`,
    );

    const inspection = await execute(`(() => {
      const surfaceElement = document.getElementById('display-render-surface');
      const surface = surfaceElement.getBoundingClientRect();
      const stage = document.getElementById('display-stage').getBoundingClientRect();
      return {
        inlineSize: surfaceElement.style.inlineSize,
        blockSize: surfaceElement.style.blockSize,
        containerType: getComputedStyle(surfaceElement).containerType,
        surface: {
          left: surface.left,
          top: surface.top,
          right: surface.right,
          bottom: surface.bottom,
          width: surface.width,
          height: surface.height,
        },
        stage: {
          left: stage.left,
          top: stage.top,
          right: stage.right,
          bottom: stage.bottom,
          width: stage.width,
          height: stage.height,
        },
        hasOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth ||
          document.documentElement.scrollHeight > document.documentElement.clientHeight,
      };
    })()`);
    const expectedScale = Math.min(
      viewport.width / logicalWidth,
      viewport.height / logicalHeight,
    );
    const expectedWidth = logicalWidth * expectedScale;
    const expectedHeight = logicalHeight * expectedScale;
    const expectedLeft = (viewport.width - expectedWidth) / 2;
    const expectedTop = (viewport.height - expectedHeight) / 2;

    assert.equal(inspection.inlineSize, `${logicalWidth}px`);
    assert.equal(inspection.blockSize, `${logicalHeight}px`);
    assert.equal(inspection.containerType, 'size');
    assert.equal(inspection.hasOverflow, false, `${profile} viewport overflow`);
    assert.ok(Math.abs(inspection.surface.width - expectedWidth) <= 0.75);
    assert.ok(Math.abs(inspection.surface.height - expectedHeight) <= 0.75);
    assert.ok(Math.abs(inspection.surface.left - expectedLeft) <= 0.75);
    assert.ok(Math.abs(inspection.surface.top - expectedTop) <= 0.75);
    assert.ok(inspection.surface.right <= viewport.width + 0.75);
    assert.ok(inspection.surface.bottom <= viewport.height + 0.75);
    assert.deepEqual(inspection.stage, inspection.surface);
  }
}

async function runWorkflow(
  timers,
  expectedLogoUrl,
  expectedStandbyBackgroundUrl,
) {
  await waitFor(
    () => execute(`(() =>
      document.documentElement.dataset.displayReady === 'true' &&
      document.documentElement.dataset.settingsReady === 'true' &&
      document.getElementById('display-stage').dataset.settingsRevision === '0' &&
      document.getElementById('display-stage').dataset.logoState === 'ready'
    )()`),
    'Display presentation 與 settings bridge 初始化',
  );

  const security = await execute(`(() => ({
    requireType: typeof globalThis.require,
    processType: typeof globalThis.process,
    moduleType: typeof globalThis.module,
    bridgeMethods: Object.keys(window.displayCoreDisplay).sort(),
    interactiveCount: document.querySelectorAll(
      'button,input,select,textarea,a,video,audio,[tabindex],[contenteditable]'
    ).length,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }))()`);
  assert.deepEqual(security, {
    requireType: 'undefined',
    processType: 'undefined',
    moduleType: 'undefined',
    bridgeMethods: [
      'getPresentation',
      'getSettings',
      'onPresentationChanged',
      'onRefitRequested',
      'onSettingsChanged',
      'reportPageProgress',
    ],
    interactiveCount: 0,
    reducedMotion: true,
  });

  await verifyStandbyPresentation(
    expectedLogoUrl,
    expectedStandbyBackgroundUrl,
  );

  const literalHtml = '<img src=x onerror="globalThis.displayPwned=true">\n純文字';
  const messages = [
    { message: '001請至前廳', alignment: 'left' },
    { message: '歡迎光臨', alignment: 'center' },
    { message: literalHtml, alignment: 'left' },
    { message: '004請至櫃檯', alignment: 'left' },
    { message: '請輕聲細語', alignment: 'center' },
    { message: '006請至前廳', alignment: 'left' },
  ];
  presentationService.startProgram({
    messages,
    pageDurationSeconds: 1,
    repeat: { mode: 'finite', rounds: 1 },
  });
  assert.equal(timers.handles.length, 0, 'Display ready 前不得啟動 page timer');
  await waitForRevision(1);
  await waitFor(
    () => Promise.resolve(timers.active().length === 1),
    '第一頁 ready 後啟動最短停留 timer',
  );

  const firstPage = await execute(`(() => {
    const stage = document.getElementById('display-stage');
    const rows = [...document.querySelectorAll('.message-row')];
    return {
      mode: stage.dataset.mode,
      settingsRevision: stage.dataset.settingsRevision,
      messages: rows.map((row) => row.dataset.message),
      alignments: rows.map((row) => row.dataset.alignment),
      justifyContents: rows.map((row) => getComputedStyle(row).justifyContent),
      textAlignments: rows.map((row) => getComputedStyle(row).textAlign),
      rowCount: rows.length,
      pageHidden: document.getElementById('page-layer').hidden,
      fillHidden: document.getElementById('fill-layer').hidden,
      normalHidden: document.getElementById('normal-layer').hidden,
      normalHasLogo: document.getElementById('normal-layer').classList.contains('has-logo'),
      normalHasClock: document.getElementById('normal-layer').classList.contains('has-clock'),
      chromeHidden: document.getElementById('display-chrome').hidden,
      standbyBackgroundHidden:
        document.getElementById('standby-background-layer').hidden,
      standbyBackgroundSource:
        document.getElementById('standby-background-image').getAttribute('src'),
      logoHidden: document.getElementById('display-logo').hidden,
      logoSource: document.getElementById('display-logo').getAttribute('src'),
      clockHidden: document.getElementById('display-clock').hidden,
      clockText: document.getElementById('display-clock').textContent,
      clockDateTime: document.getElementById('display-clock').getAttribute('datetime'),
      backgroundColor: getComputedStyle(stage).backgroundColor,
      fontColor: getComputedStyle(stage).color,
      fontFamily: getComputedStyle(document.body).fontFamily,
      whiteSpaces: rows.map((row) => getComputedStyle(row).whiteSpace),
      hasInjectedImage: Boolean(document.querySelector('.message-row img')),
      pwnedType: typeof globalThis.displayPwned,
      announcement: document.getElementById('display-announcement').textContent,
      fontSize: Number.parseFloat(
        getComputedStyle(document.getElementById('page-layer')).fontSize
      ),
      rowsFitVertically: rows.every((row) => {
        const text = row.querySelector('.message-text, .marquee-copy');
        return text && text.getBoundingClientRect().height <= row.clientHeight + 0.5;
      }),
      rowHeights: rows.map((row) => row.clientHeight),
      textHeights: rows.map((row) =>
        row.querySelector('.message-text, .marquee-copy')
          ?.getBoundingClientRect().height ?? null
      ),
      viewportHasOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth ||
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  })()`);
  assert.deepEqual(firstPage, {
    mode: 'page',
    settingsRevision: '0',
    messages: messages.slice(0, 3).map(({ message }) => message),
    alignments: ['left', 'center', 'left'],
    justifyContents: ['flex-start', 'center', 'flex-start'],
    textAlignments: ['left', 'center', 'left'],
    rowCount: 3,
    pageHidden: false,
    fillHidden: true,
    normalHidden: false,
    normalHasLogo: true,
    normalHasClock: true,
    chromeHidden: false,
    standbyBackgroundHidden: true,
    standbyBackgroundSource: expectedStandbyBackgroundUrl,
    logoHidden: false,
    logoSource: expectedLogoUrl,
    clockHidden: false,
    clockText: firstPage.clockText,
    clockDateTime: firstPage.clockDateTime,
    backgroundColor: 'rgb(16, 32, 48)',
    fontColor: 'rgb(244, 245, 246)',
    fontFamily: firstPage.fontFamily,
    whiteSpaces: Array(3).fill('nowrap'),
    hasInjectedImage: false,
    pwnedType: 'undefined',
    announcement: messages.slice(0, 3).map(({ message }) => message).join('\n'),
    fontSize: firstPage.fontSize,
    rowsFitVertically: firstPage.rowsFitVertically,
    rowHeights: firstPage.rowHeights,
    textHeights: firstPage.textHeights,
    viewportHasOverflow: false,
  });
  assert.ok(firstPage.fontSize > 0);
  assert.match(firstPage.clockText, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(firstPage.clockDateTime, firstPage.clockText);
  await verifyDisplayedClockOffset(3_661, 'Display 套用離線時間偏移');
  assert.match(firstPage.fontFamily, /^Arial/i);
  assert.doesNotMatch(firstPage.logoSource, /file:|Users|userData/i);
  assert.doesNotMatch(
    firstPage.standbyBackgroundSource,
    /file:|Users|userData|standby-backgrounds/i,
  );
  assert.equal(
    firstPage.rowsFitVertically,
    true,
    JSON.stringify({
      fontSize: firstPage.fontSize,
      rowHeights: firstPage.rowHeights,
      textHeights: firstPage.textHeights,
    }),
  );

  await verifyResponsiveResolutions();

  await waitFor(
    () => Promise.resolve(timers.active().length === 1),
    '最後一次 responsive refit ready 後重新啟動 timer',
  );
  assert.equal(timers.active()[0].delay, 1_000);
  timers.fireHandle(timers.active()[0]);
  await waitForRevision(2);
  assert.deepEqual(
    await execute(
      `[...document.querySelectorAll('.message-row')].map((row) => row.dataset.message)`,
    ),
    messages.slice(3, 6).map(({ message }) => message),
  );

  const longMessage = '超長訊息'.repeat(1_000);
  const secondLongMessage = '第二列更長訊息'.repeat(700);
  presentationService.startProgram({
    messages: [
      { message: longMessage, alignment: 'left' },
      { message: secondLongMessage, alignment: 'left' },
    ],
    pageDurationSeconds: 1,
    repeat: { mode: 'finite', rounds: 1 },
  });
  await waitForRevision(3);
  const staticOverflow = await execute(`(() => {
    const rows = [...document.querySelectorAll('.message-row')];
    return {
      marquee: rows.map((row) => row.classList.contains('is-marquee')),
      compressed: rows.map((row) => row.classList.contains('is-compressed')),
      messages: rows.map((row) => row.querySelector('.message-text')?.textContent),
    };
  })()`);
  assert.deepEqual(staticOverflow, {
    marquee: [false, false],
    compressed: [true, true],
    messages: [longMessage, secondLongMessage],
  });

  const nextConfig = structuredClone(settingsManager.getSnapshot().config);
  nextConfig.logo.enabled = false;
  nextConfig.appearance.backgroundColor = '#204060';
  nextConfig.appearance.fontColor = '#ABCDEF';
  nextConfig.appearance.fontSizePercent = 75;
  nextConfig.appearance.lineSpacingPercent = 200;
  nextConfig.dateTime.enabled = false;
  nextConfig.marquee.enabled = true;
  settingsManager.publish(nextConfig);
  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      return stage.dataset.revision === '3' &&
        stage.dataset.settingsRevision === '1' &&
        stage.dataset.fittedSettingsRevision === '1' &&
        stage.dataset.marqueeCount === '2';
    })()`),
    '播放中即時套用設定',
  );

  const marquee = await execute(`(() => {
    const stage = document.getElementById('display-stage');
    const rows = [...document.querySelectorAll('.message-row')];
    const row = rows[0];
    const copies = [...row.querySelectorAll('.marquee-copy')];
    return {
      active: rows.map((item) => item.classList.contains('is-marquee')),
      trackCount: document.querySelectorAll('.marquee-track').length,
      copyCount: copies.length,
      copiesMatch: copies.every((copy) => copy.textContent === ${JSON.stringify(longMessage)}),
      ariaHidden: row.querySelector('.marquee-track')?.getAttribute('aria-hidden'),
      presentationRevision: stage.dataset.revision,
      settingsRevision: stage.dataset.settingsRevision,
      backgroundColor: getComputedStyle(stage).backgroundColor,
      fontColor: getComputedStyle(stage).color,
      chromeHidden: document.getElementById('display-chrome').hidden,
      logoSource: document.getElementById('display-logo').getAttribute('src'),
      clockText: document.getElementById('display-clock').textContent,
      normalHasLogo: document.getElementById('normal-layer').classList.contains('has-logo'),
      normalHasClock: document.getElementById('normal-layer').classList.contains('has-clock'),
      normalGap: getComputedStyle(document.getElementById('normal-layer')).gap,
      animationName: getComputedStyle(row.querySelector('.marquee-track')).animationName,
      animationDuration: Number.parseFloat(
        getComputedStyle(row.querySelector('.marquee-track')).animationDuration
      ),
    };
  })()`);
  assert.deepEqual(marquee, {
    active: [true, true],
    trackCount: 2,
    copyCount: 2,
    copiesMatch: true,
    ariaHidden: 'true',
    presentationRevision: '3',
    settingsRevision: '1',
    backgroundColor: 'rgb(32, 64, 96)',
    fontColor: 'rgb(171, 205, 239)',
    chromeHidden: true,
    logoSource: null,
    clockText: '',
    normalHasLogo: false,
    normalHasClock: false,
    normalGap: '0px',
    animationName: 'display-marquee',
    animationDuration: marquee.animationDuration,
  });
  assert.ok(marquee.animationDuration >= 8);

  await waitFor(
    () => Promise.resolve(timers.active().length === 1),
    '跑馬燈 layout ready 後重新啟動最短停留 timer',
  );
  const marqueeTimer = timers.active()[0];
  assert.equal(marqueeTimer.delay, 1_000);
  timers.fireHandle(marqueeTimer);
  assert.equal(presentationService.getSnapshot().revision, 3);
  assert.equal(presentationService.getSnapshot().mode, 'page');

  await execute(`document.querySelectorAll('.marquee-track')[0]
    .dispatchEvent(new Event('animationiteration'))`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(presentationService.getSnapshot().revision, 3);

  await execute(`document.querySelectorAll('.marquee-track')[1]
    .dispatchEvent(new Event('animationiteration'))`);
  await waitForRevision(4, false);
  assert.equal(presentationService.getSnapshot().mode, 'blank');

  // 非 16:9 viewport 會在 contain 畫布外留下邊帶；緊急背景仍須覆蓋滿屏。
  const letterboxConfig = structuredClone(
    settingsManager.getSnapshot().config,
  );
  letterboxConfig.display.renderResolution = '1920x1080';
  const letterboxSettingsRevision = settingsManager.publish(
    letterboxConfig,
  ).revision;
  displayWindow.setContentSize(1600, 1000, false);
  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const surface = document.getElementById('display-render-surface')
        .getBoundingClientRect();
      return stage.dataset.settingsRevision ===
          '${letterboxSettingsRevision}' &&
        stage.dataset.renderResolution === '1920x1080' &&
        window.innerWidth === 1600 && window.innerHeight === 1000 &&
        surface.top > 1;
    })()`),
    '建立非 16:9 緊急滿屏驗證環境',
  );

  presentationService.showEmergency('555');
  await waitForRevision(5, false);
  const inspection = await execute(`(() => ({
    mode: document.getElementById('display-stage').dataset.mode,
    normalHidden: document.getElementById('normal-layer').hidden,
    chromeHidden: document.getElementById('display-chrome').hidden,
    standbyBackgroundHidden:
      document.getElementById('standby-background-layer').hidden,
    pageHidden: document.getElementById('page-layer').hidden,
    fillHidden: document.getElementById('fill-layer').hidden,
    cells: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => cell.textContent
    ),
    marqueeCount: document.querySelectorAll('.marquee-track').length,
    announcement: document.getElementById('display-announcement').textContent,
    ariaLive: document.getElementById('display-announcement').getAttribute('aria-live'),
    backgroundColor: getComputedStyle(document.getElementById('display-stage')).backgroundColor,
    viewportBackgroundColor: getComputedStyle(document.body).backgroundColor,
    fontColor: getComputedStyle(document.getElementById('display-stage')).color,
  }))()`);
  assert.equal(inspection.mode, 'emergency');
  assert.equal(inspection.normalHidden, true);
  assert.equal(inspection.chromeHidden, true);
  assert.equal(inspection.standbyBackgroundHidden, true);
  assert.equal(inspection.pageHidden, true);
  assert.equal(inspection.fillHidden, false);
  assert.equal(
    await execute(`document.getElementById('standby-layer').hidden`),
    true,
  );
  assert.equal(
    await execute(`document.getElementById('display-clock').hidden`),
    true,
  );
  assert.equal(inspection.cells.length, 24);
  assert.equal(inspection.cells.every((value) => value === '555'), true);
  assert.equal(inspection.marqueeCount, 0);
  assert.equal(inspection.announcement, '555');
  assert.equal(inspection.ariaLive, 'assertive');
  assert.equal(inspection.backgroundColor, 'rgb(127, 29, 29)');
  assert.equal(inspection.viewportBackgroundColor, 'rgb(127, 29, 29)');
  assert.equal(inspection.fontColor, 'rgb(255, 255, 255)');

  presentationService.showEmergency('888');
  await waitForRevision(6, false);
  assert.equal(
    await execute(`document.querySelector('.fill-cell').textContent`),
    '888',
  );
  assert.equal(
    await execute(`getComputedStyle(document.getElementById('display-stage')).backgroundColor`),
    'rgb(20, 83, 45)',
  );
  assert.equal(
    await execute(`getComputedStyle(document.body).backgroundColor`),
    'rgb(20, 83, 45)',
  );

  presentationService.clearPresentation();
  await waitForRevision(7, false);
  const standby = await execute(`(() => {
    const stage = document.getElementById('display-stage').getBoundingClientRect();
    const message = document.getElementById('standby-message').getBoundingClientRect();
    const clock = document.getElementById('display-clock').getBoundingClientRect();
    return {
      mode: document.getElementById('display-stage').dataset.mode,
      announcement: document.getElementById('display-announcement').textContent,
      pageChildren: document.getElementById('page-layer').children.length,
      fillChildren: document.getElementById('fill-layer').children.length,
      normalHidden: document.getElementById('normal-layer').hidden,
      chromeHidden: document.getElementById('display-chrome').hidden,
      standbyBackgroundHidden:
        document.getElementById('standby-background-layer').hidden,
      standbyBackgroundSource:
        document.getElementById('standby-background-image').getAttribute('src'),
      standbyBackgroundObjectFit: getComputedStyle(
        document.getElementById('standby-background-image')
      ).objectFit,
      standbyHidden: document.getElementById('standby-layer').hidden,
      standbyText: document.getElementById('standby-message').textContent,
      clockText: document.getElementById('display-clock').textContent,
      messageCenter: message.left + (message.width / 2),
      clockCenter: clock.left + (clock.width / 2),
      stageCenter: stage.left + (stage.width / 2),
    };
  })()`);
  assert.equal(standby.mode, 'blank');
  assert.equal(standby.announcement, '歡迎光臨');
  assert.equal(standby.pageChildren, 0);
  assert.equal(standby.fillChildren, 0);
  assert.equal(standby.normalHidden, false);
  assert.equal(standby.chromeHidden, true);
  assert.equal(standby.standbyBackgroundHidden, false);
  assert.equal(
    standby.standbyBackgroundSource,
    expectedStandbyBackgroundUrl,
  );
  assert.equal(standby.standbyBackgroundObjectFit, 'cover');
  assert.equal(standby.standbyHidden, false);
  assert.equal(standby.standbyText, '歡迎光臨');
  assert.equal(
    await execute(`getComputedStyle(document.body).backgroundColor`),
    'rgb(32, 64, 96)',
  );
  assert.match(standby.clockText, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(Math.abs(standby.messageCenter - standby.stageCenter) < 1);
  assert.ok(Math.abs(standby.clockCenter - standby.stageCenter) < 1);
  await verifyDisplayedClockOffset(3_661, '待機時保留離線時間偏移');
  await verifyConfiguredRenderResolutions();
  await verifyLogoSizeScaling('blank');

  presentationService.startProgram({
    messages: [{ message: '001聯絡櫃台', alignment: 'left' }],
    pageDurationSeconds: 3_600,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const logoPageRevision = presentationService.getSnapshot().revision;
  await waitForRevision(logoPageRevision);
  await verifyLogoSizeScaling('page');
}

async function run() {
  await app.whenReady();

  runtimeDataRoot = path.join(
    app.getPath('temp'),
    `displaycore-display-smoke-data-${process.pid}`,
  );
  const managedLogoDirectory = path.join(runtimeDataRoot, 'logos');
  const managedStandbyBackgroundDirectory = path.join(
    runtimeDataRoot,
    'standby-backgrounds',
  );
  await fileSystem.rm(runtimeDataRoot, { recursive: true, force: true });
  await fileSystem.mkdir(managedLogoDirectory, { recursive: true });
  await fileSystem.mkdir(managedStandbyBackgroundDirectory, {
    recursive: true,
  });
  const logoDigest = createHash('sha256')
    .update(LOGO_BYTES)
    .digest('hex')
    .slice(0, 24);
  const logoFileName = `${logoDigest}.png`;
  const logoAssetPath = `logos/${logoFileName}`;
  const expectedLogoUrl = `displaycore://app/managed/logo/${logoFileName}`;
  await fileSystem.writeFile(
    path.join(managedLogoDirectory, logoFileName),
    LOGO_BYTES,
  );
  const standbyBackgroundDigest = createHash('sha256')
    .update(STANDBY_BACKGROUND_BYTES)
    .digest('hex')
    .slice(0, 24);
  const standbyBackgroundFileName = `${standbyBackgroundDigest}.png`;
  const standbyBackgroundAssetPath =
    `standby-backgrounds/${standbyBackgroundFileName}`;
  const expectedStandbyBackgroundUrl =
    `displaycore://app/managed/standby-background/${standbyBackgroundFileName}`;
  await fileSystem.writeFile(
    path.join(
      managedStandbyBackgroundDirectory,
      standbyBackgroundFileName,
    ),
    STANDBY_BACKGROUND_BYTES,
  );

  const initialConfig = structuredClone(defaultConfig);
  initialConfig.logo = {
    enabled: true,
    path: logoAssetPath,
    sizePercent: 100,
  };
  initialConfig.standby = {
    backgroundImagePath: standbyBackgroundAssetPath,
  };
  initialConfig.appearance = {
    ...initialConfig.appearance,
    backgroundColor: '#102030',
    fontFamily: 'Arial, sans-serif',
    fontColor: '#F4F5F6',
    minimumFontSizeRem: 3,
  };
  initialConfig.dateTime = {
    enabled: true,
    offsetSeconds: 3_661,
  };
  initialConfig.emergency = {
    inspectionBackgroundColor: '#7F1D1D',
    releaseBackgroundColor: '#14532D',
  };
  initialConfig.marquee = { enabled: false };
  initialConfig.display.renderResolution = 'auto';
  settingsManager = createSettingsManager(initialConfig);

  const appSession = session.fromPartition(
    `displaycore-display-smoke-${process.pid}`,
    { cache: false },
  );
  configureOfflineSession(appSession);
  installLocalProtocol({
    protocol: appSession.protocol,
    net,
    appRoot: projectRoot,
    managedLogoDirectory,
    managedStandbyBackgroundDirectory,
    getAllowedLogoPath: () => {
      const logo = settingsManager.getSnapshot().config.logo;
      return logo.enabled ? logo.path : null;
    },
    getAllowedStandbyBackgroundPath: () =>
      settingsManager.getSnapshot().config.standby.backgroundImagePath,
  });

  displayWindow = new BrowserWindow(
    createDisplayWindowOptions({
      preloadPath: path.join(projectRoot, 'preload', 'display-preload.js'),
      session: appSession,
      windowed: true,
    }),
  );
  hardenWebContents(displayWindow.webContents);

  const timers = createFakeTimers();
  presentationService = new PresentationService({
    store: new PresentationStore(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  coordinator = new IpcCoordinator({
    ipcMain,
    presentationService,
    settingsManager,
    getWindow: (role) => role === IPC_ROLES.DISPLAY ? displayWindow : null,
    allowedUrls: {
      [IPC_ROLES.CONTROL]: CONTROL_URL,
      [IPC_ROLES.DISPLAY]: DISPLAY_URL,
    },
    logger: { warn: () => {}, error: () => {} },
  });
  coordinator.register();

  timeout = setTimeout(() => {
    finish(1, '[DisplayCore] Display window smoke test timed out.');
  }, TIMEOUT_MS);

  displayWindow.webContents.on('render-process-gone', (_event, details) => {
    finish(
      1,
      '[DisplayCore] Display window Renderer exited.',
      new Error(details.reason),
    );
  });
  displayWindow.webContents.on('did-fail-load', (_event, code, description) => {
    finish(
      1,
      '[DisplayCore] Display window failed to load.',
      new Error(`${code}: ${description}`),
    );
  });

  await displayWindow.loadURL(DISPLAY_URL);
  displayWindow.webContents.send(
    IPC_CHANNELS.DISPLAY_REFIT_REQUESTED,
    { displayEpoch: presentationService.getDisplayEpoch() },
  );
  displayWindow.webContents.debugger.attach('1.3');
  await displayWindow.webContents.debugger.sendCommand(
    'Emulation.setEmulatedMedia',
    {
      features: [{
        name: 'prefers-reduced-motion',
        value: 'reduce',
      }],
    },
  );
  await runWorkflow(
    timers,
    expectedLogoUrl,
    expectedStandbyBackgroundUrl,
  );
  finish(0, '[DisplayCore] Display window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Display window smoke test failed.', error);
});
