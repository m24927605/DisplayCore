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
  APP_SCHEME,
  createLocalProtocolHandler,
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

function createDelayedReadFileSystem(delayedFileName) {
  let started = false;
  let released = false;
  let releaseRead;
  const releasedPromise = new Promise((resolve) => {
    releaseRead = resolve;
  });

  return Object.freeze({
    fileSystem: Object.freeze({
      lstat: (...args) => fileSystem.lstat(...args),
      async readFile(filePath, ...args) {
        if (
          path.basename(path.dirname(filePath)) === 'standby-backgrounds' &&
          path.basename(filePath) === delayedFileName &&
          !released
        ) {
          started = true;
          await releasedPromise;
        }

        return fileSystem.readFile(filePath, ...args);
      },
    }),
    hasStarted: () => started,
    release() {
      if (released) {
        return;
      }

      released = true;
      releaseRead();
    },
  });
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

/** 真實 BrowserWindow 驗證待機只顯示大時鐘並保留 Logo、背景層級。 */
async function verifyStandbyPresentation(
  expectedLogoUrl,
  expectedStandbyBackgroundUrl,
) {
  await waitFor(
    () => execute(`(() => {
      const background = [...document.querySelectorAll('.standby-background-image')]
        .find((image) => !image.hidden);
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
    const backgroundElement = [...document.querySelectorAll(
      '.standby-background-image'
    )].find((image) => !image.hidden);
    const background = backgroundElement.getBoundingClientRect();
    const logoElement = document.getElementById('display-logo');
    const logo = logoElement.getBoundingClientRect();
    const clockElement = document.getElementById('display-clock');
    const clock = clockElement.getBoundingClientRect();
    const canvas = document.getElementById('standby-sand-transition');
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
      clockCenterError: Math.abs(center(clock) - center(stage)),
      logoAboveClock: logo.bottom <= clock.top + 0.5,
      clockText: clockElement.textContent,
      clockFontSize: Number.parseFloat(getComputedStyle(clockElement).fontSize),
      expectedClockFontSize: Math.min(stage.width, stage.height) * 0.14,
      standbyLayerExists: document.getElementById('standby-layer') !== null,
      standbyMessageExists: document.getElementById('standby-message') !== null,
      hasWelcomeText: document.body.innerText.includes('歡迎光臨'),
      firstImageTransition: document.getElementById('display-stage')
        .dataset.standbyTransition ?? null,
      firstImageCanvasHidden: canvas.hidden,
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
  assert.ok(inspection.clockCenterError < 1);
  assert.equal(inspection.logoAboveClock, true);
  assert.match(inspection.clockText, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(
    Math.abs(inspection.clockFontSize - inspection.expectedClockFontSize) <= 1,
    `待機時鐘未使用原歡迎文字 14cqmin 大字級：${JSON.stringify(inspection)}`,
  );
  assert.equal(inspection.standbyLayerExists, false);
  assert.equal(inspection.standbyMessageExists, false);
  assert.equal(inspection.hasWelcomeText, false);
  assert.equal(inspection.firstImageTransition, null);
  assert.equal(inspection.firstImageCanvasHidden, true);
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
        frameWidth: frame.getBoundingClientRect().width,
        imageHeight: logo.getBoundingClientRect().height,
        imageWidth: logo.getBoundingClientRect().width,
        filter: getComputedStyle(logo).filter,
        treatment: frame.dataset.logoTreatment,
        standbyBackgroundHidden:
          document.getElementById('standby-background-layer').hidden,
      };
    })()`);

    assert.equal(measurement.scale, String(sizePercent / 100));
    assert.ok(measurement.frameHeight > 0);
    assert.ok(Math.abs(measurement.frameHeight - measurement.imageHeight) <= 0.5);
    assert.ok(measurement.frameWidth > 0);
    assert.ok(measurement.imageWidth > 0);
    assert.equal(measurement.standbyBackgroundHidden, mode === 'page');
    assertLogoHighlight(measurement.filter, `${mode} ${sizePercent}%`);
    assert.equal(measurement.treatment, 'bright-white');
    measurements.push(measurement);
  }

  const [half, normal, double] = measurements;
  for (const [field, label] of [
    ['frameHeight', 'frame 高度'],
    ['imageHeight', 'image 高度'],
    ['frameWidth', 'frame 寬度'],
    ['imageWidth', 'image 寬度'],
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

  const maximumResolutions = [
    [1366, 768],
    [1600, 900],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ];

  for (const [width, height] of maximumResolutions) {
    displayWindow.setContentSize(width, height, false);
    await waitFor(
      () => execute(
        `window.innerWidth === ${width} && window.innerHeight === ${height}`,
      ),
      `${mode} ${width}×${height} viewport`,
    );
    const growthMeasurements = [];

    for (const sizePercent of [500, 1_000]) {
      const config = structuredClone(settingsManager.getSnapshot().config);
      config.logo.sizePercent = sizePercent;
      config.display.renderResolution = 'auto';
      const revision = settingsManager.publish(config).revision;
      await waitFor(
        () => execute(`(() => {
          const stage = document.getElementById('display-stage');
          const logo = document.getElementById('display-logo');
          return stage.dataset.mode === '${mode}' &&
            stage.dataset.settingsRevision === '${revision}' &&
            ${mode === 'page'
              ? `stage.dataset.fittedSettingsRevision === '${revision}' &&`
              : ''}
            logo && !logo.hidden && logo.complete && logo.naturalWidth > 0;
        })()`),
        `${mode} ${width}×${height} Logo ${sizePercent}% 安全排版`,
      );
      await execute(
        `new Promise((resolve) => requestAnimationFrame(() => resolve(true)))`,
      );

      growthMeasurements.push(await execute(`(() => {
        const stage = document.getElementById('display-stage').getBoundingClientRect();
        const frame = document.getElementById('logo-frame').getBoundingClientRect();
        const logo = document.getElementById('display-logo').getBoundingClientRect();
        const rows = [...document.querySelectorAll('.message-row')];
        return {
          scale: getComputedStyle(document.documentElement)
            .getPropertyValue('--logo-size-scale').trim(),
          stageWidth: stage.width,
          stageHeight: stage.height,
          frameWidth: frame.width,
          frameHeight: frame.height,
          imageWidth: logo.width,
          imageHeight: logo.height,
          insideStage:
            frame.left >= stage.left - 0.5 && frame.top >= stage.top - 0.5 &&
            frame.right <= stage.right + 0.5 && frame.bottom <= stage.bottom + 0.5 &&
            logo.left >= stage.left - 0.5 && logo.top >= stage.top - 0.5 &&
            logo.right <= stage.right + 0.5 && logo.bottom <= stage.bottom + 0.5,
          rowsRemainUsable: rows.every((row) => {
            const text = row.querySelector('.message-text, .marquee-copy');
            return row.clientHeight > 0 && text &&
              text.getBoundingClientRect().height <= row.clientHeight + 0.5;
          }),
          viewportHasOverflow:
            document.documentElement.scrollWidth > document.documentElement.clientWidth ||
            document.documentElement.scrollHeight > document.documentElement.clientHeight,
        };
      })()`));
    }

    const label = `${mode} ${width}×${height}`;
    const [fiveHundred, maximum] = growthMeasurements;
    assert.ok(
      maximum.frameHeight > fiveHundred.frameHeight + 0.5,
      `${label} 500% 至 1000% frame 必須繼續成長`,
    );
    assert.ok(
      maximum.imageHeight > fiveHundred.imageHeight + 0.5,
      `${label} 500% 至 1000% image 必須繼續成長`,
    );
    assert.equal(maximum.scale, '10', label);
    assert.ok(
      maximum.frameWidth <= maximum.stageWidth * 0.92 + 0.75,
      `${label} frame 寬度`,
    );
    assert.ok(
      maximum.imageWidth <= maximum.stageWidth * 0.92 + 0.75,
      `${label} image 寬度`,
    );
    const maximumBlockRatio = mode === 'blank' ? 0.42 : 0.30;
    assert.ok(
      maximum.frameHeight <=
        maximum.stageHeight * maximumBlockRatio + 0.75,
      `${label} frame 高度`,
    );
    assert.ok(
      maximum.imageHeight <= maximum.frameHeight + 0.5,
      `${label} image 高度`,
    );
    assert.equal(maximum.insideStage, true, `${label} 舞台邊界`);
    assert.equal(maximum.rowsRemainUsable, true, `${label} 訊息列`);
    assert.equal(maximum.viewportHasOverflow, false, `${label} viewport overflow`);
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
        clockInTopRight:
          clock.top <= normal.top + normal.height * 0.25 &&
          Math.abs(clock.right - page.right) <= 0.75,
        logoAndClockSameTopRow:
          Math.abs(
            (logo.top + logo.height / 2) -
            (clock.top + clock.height / 2)
          ) <= 1,
        clockAndPageSeparate: clock.bottom <= page.top + 0.5,
        clockFontSize: Number.parseFloat(
          getComputedStyle(document.getElementById('display-clock')).fontSize
        ),
        minimumProminentClockFontSize:
          Math.min(stageElement.clientWidth, stageElement.clientHeight) * 0.04,
        clockEvidence: {
          clockTop: clock.top,
          clockRight: clock.right,
          clockBottom: clock.bottom,
          clockCenterY: clock.top + clock.height / 2,
          logoTop: logo.top,
          logoBottom: logo.bottom,
          logoCenterY: logo.top + logo.height / 2,
          pageTop: page.top,
          pageRight: page.right,
          normalTop: normal.top,
          normalHeight: normal.height,
        },
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
      inspection.clockInTopRight,
      true,
      `${width}×${height} clock 必須位於右上角：` +
        JSON.stringify(inspection.clockEvidence),
    );
    assert.equal(
      inspection.logoAndClockSameTopRow,
      true,
      `${width}×${height} Logo 與 clock 必須在同一頂部列：` +
        JSON.stringify(inspection.clockEvidence),
    );
    assert.equal(
      inspection.clockAndPageSeparate,
      true,
      `${width}×${height} 訊息區不得與 clock 重疊：` +
        JSON.stringify(inspection.clockEvidence),
    );
    assert.ok(
      inspection.clockFontSize >= inspection.minimumProminentClockFontSize,
      `${width}×${height} clock 字級必須明顯放大：` +
        `${inspection.clockFontSize}px < ` +
        `${inspection.minimumProminentClockFontSize}px`,
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

async function showAndMeasurePage(messages, description) {
  presentationService.startProgram({
    messages,
    pageDurationSeconds: 3_600,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const revision = presentationService.getSnapshot().revision;
  await waitForRevision(revision);

  return execute(`(() => {
    const page = document.getElementById('page-layer');
    const pageBox = page.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.message-row')];
    const firstRow = rows[0];
    const firstRowBox = firstRow.getBoundingClientRect();
    const firstText = firstRow.querySelector('.message-text, .marquee-copy');
    const firstTextBox = firstText.getBoundingClientRect();
    return {
      description: ${JSON.stringify(description)},
      layout: page.dataset.layout,
      rowCount: rows.length,
      gridTrackCount: getComputedStyle(page).gridTemplateRows
        .split(/\\s+/).filter(Boolean).length,
      fontSize: Number.parseFloat(getComputedStyle(page).fontSize),
      pageTop: pageBox.top,
      pageLeft: pageBox.left,
      pageCenterX: pageBox.left + pageBox.width / 2,
      pageCenterY: pageBox.top + pageBox.height / 2,
      firstRowTop: firstRowBox.top,
      firstRowLeft: firstRowBox.left,
      firstRowHeight: firstRowBox.height,
      firstRowCenterX: firstRowBox.left + firstRowBox.width / 2,
      firstRowCenterY: firstRowBox.top + firstRowBox.height / 2,
      firstTextTop: firstTextBox.top,
      firstTextLeft: firstTextBox.left,
      firstTextCenterX: firstTextBox.left + firstTextBox.width / 2,
      firstTextCenterY: firstTextBox.top + firstTextBox.height / 2,
      firstRowAlignItems: getComputedStyle(firstRow).alignItems,
      firstRowJustifyContent: getComputedStyle(firstRow).justifyContent,
      firstRowTextAlign: getComputedStyle(firstRow).textAlign,
      marquee: firstRow.classList.contains('is-marquee'),
      marqueeTrackCount: firstRow.querySelectorAll('.marquee-track').length,
    };
  })()`);
}

/** 實際排版驗證：一般訊息固定三槽置頂置左，營運訊息保持居中。 */
async function verifyFixedMessageLayout() {
  displayWindow.setContentSize(1_600, 900, false);
  await waitFor(
    () => execute('window.innerWidth === 1600 && window.innerHeight === 900'),
    '固定訊息排版 viewport',
  );

  const config = structuredClone(settingsManager.getSnapshot().config);
  config.logo.enabled = false;
  config.dateTime.enabled = false;
  config.display.renderResolution = 'auto';
  config.appearance.fontSizePercent = 100;
  config.appearance.lineSpacingPercent = 100;
  config.marquee.enabled = true;
  const settingsRevision = settingsManager.publish(config).revision;
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.settingsRevision === ` +
      `'${settingsRevision}'`,
    ),
    '固定訊息排版設定套用',
  );

  const shortMessages = [
    { message: '001請至前廳', alignment: 'left' },
    { message: '002前廳000', alignment: 'left' },
    { message: '003聯絡櫃台', alignment: 'left' },
  ];
  const layouts = [];

  for (let count = 1; count <= 3; count += 1) {
    layouts.push(await showAndMeasurePage(
      shortMessages.slice(0, count),
      `${count} 則一般訊息`,
    ));
  }

  const [oneMessage] = layouts;
  for (const [index, layout] of layouts.entries()) {
    assert.equal(layout.layout, 'messages', layout.description);
    assert.equal(layout.rowCount, index + 1, layout.description);
    assert.equal(layout.gridTrackCount, 3, `${layout.description} 固定三槽`);
    assert.equal(layout.firstRowAlignItems, 'flex-start', layout.description);
    assert.equal(layout.firstRowJustifyContent, 'flex-start', layout.description);
    assert.equal(layout.firstRowTextAlign, 'left', layout.description);
    assert.ok(
      Math.abs(layout.fontSize - oneMessage.fontSize) <= 0.1,
      `${layout.description} 字級不得隨數量改變`,
    );
    assert.ok(
      Math.abs(layout.firstRowHeight - oneMessage.firstRowHeight) <= 0.5,
      `${layout.description} 第一槽高度必須一致`,
    );
    assert.ok(
      Math.abs(layout.firstRowTop - oneMessage.firstRowTop) <= 0.5 &&
        Math.abs(layout.firstRowLeft - oneMessage.firstRowLeft) <= 0.5,
      `${layout.description} 第一列必須保持置頂置左`,
    );
    assert.ok(
      Math.abs(layout.firstRowTop - layout.pageTop) <= 0.5 &&
        Math.abs(layout.firstRowLeft - layout.pageLeft) <= 0.5 &&
        Math.abs(layout.firstTextTop - layout.firstRowTop) <= 0.5 &&
        Math.abs(layout.firstTextLeft - layout.firstRowLeft) <= 0.5,
      `${layout.description} 文字必須貼齊第一槽左上角`,
    );
  }

  const longMessage = '超長一般訊息'.repeat(1_000);
  const marquee = await showAndMeasurePage(
    [{ message: longMessage, alignment: 'left' }],
    '長一般訊息',
  );
  assert.equal(marquee.layout, 'messages');
  assert.equal(marquee.gridTrackCount, 3);
  assert.equal(marquee.marquee, true);
  assert.equal(marquee.marqueeTrackCount, 1);
  assert.ok(
    Math.abs(marquee.fontSize - oneMessage.fontSize) <= 0.1,
    '長訊息啟用跑馬燈後仍必須保持固定字級',
  );
  assert.ok(
    Math.abs(marquee.firstRowTop - oneMessage.firstRowTop) <= 0.5 &&
      Math.abs(marquee.firstRowLeft - oneMessage.firstRowLeft) <= 0.5,
    '長訊息仍必須保持置頂置左',
  );

  const operation = await showAndMeasurePage(
    [{ message: '請輕聲細語', alignment: 'center' }],
    '單獨營運訊息',
  );
  assert.equal(operation.layout, 'operation');
  assert.equal(operation.gridTrackCount, 1);
  assert.equal(operation.firstRowAlignItems, 'center');
  assert.equal(operation.firstRowJustifyContent, 'center');
  assert.equal(operation.firstRowTextAlign, 'center');
  assert.ok(Math.abs(operation.firstTextCenterX - operation.pageCenterX) <= 1);
  assert.ok(Math.abs(operation.firstTextCenterY - operation.pageCenterY) <= 1);
}

/** 關閉 Logo 後，一般訊息的大時鐘仍必須固定在右上角。 */
async function verifyClockWithoutLogo() {
  displayWindow.setContentSize(1_600, 900, false);
  await waitFor(
    () => execute('window.innerWidth === 1600 && window.innerHeight === 900'),
    '無 Logo 時鐘排版 viewport',
  );

  const config = structuredClone(settingsManager.getSnapshot().config);
  config.logo.enabled = false;
  config.dateTime.enabled = true;
  config.display.renderResolution = 'auto';
  const settingsRevision = settingsManager.publish(config).revision;
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.settingsRevision === ` +
      `'${settingsRevision}'`,
    ),
    '無 Logo 時鐘設定套用',
  );

  presentationService.startProgram({
    messages: [{ message: '001請至前廳', alignment: 'left' }],
    pageDurationSeconds: 3_600,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const pageRevision = presentationService.getSnapshot().revision;
  await waitForRevision(pageRevision);

  const pageClock = await execute(`(() => {
    const stage = document.getElementById('display-stage').getBoundingClientRect();
    const normal = document.getElementById('normal-layer').getBoundingClientRect();
    const page = document.getElementById('page-layer').getBoundingClientRect();
    const clockElement = document.getElementById('display-clock');
    const clock = clockElement.getBoundingClientRect();
    return {
      clockHidden: clockElement.hidden,
      logoHidden: document.getElementById('display-logo').hidden,
      clockInTopRight:
        clock.top <= normal.top + normal.height * 0.25 &&
        Math.abs(clock.right - page.right) <= 0.75,
      clockAndPageSeparate: clock.bottom <= page.top + 0.5,
      clockFontSize: Number.parseFloat(getComputedStyle(clockElement).fontSize),
      minimumProminentClockFontSize: Math.min(stage.width, stage.height) * 0.04,
    };
  })()`);
  assert.equal(pageClock.clockHidden, false);
  assert.equal(pageClock.logoHidden, true);
  assert.equal(pageClock.clockInTopRight, true, '無 Logo 時 clock 仍必須在右上角');
  assert.equal(
    pageClock.clockAndPageSeparate,
    true,
    '無 Logo 時訊息區不得與 clock 重疊',
  );
  assert.ok(
    pageClock.clockFontSize >= pageClock.minimumProminentClockFontSize,
    `無 Logo 時 clock 字級未明顯放大：${JSON.stringify(pageClock)}`,
  );

  presentationService.clearPresentation();
  const blankRevision = presentationService.getSnapshot().revision;
  await waitForRevision(blankRevision, false);
  const standbyClock = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage').getBoundingClientRect();
      const clockElement = document.getElementById('display-clock');
      const clock = clockElement.getBoundingClientRect();
      if (
        document.getElementById('display-stage').dataset.mode !== 'blank' ||
        clockElement.hidden || !/^\\d{2}:\\d{2}:\\d{2}$/.test(clockElement.textContent)
      ) {
        return false;
      }
      return {
        centerErrorX: Math.abs(
          (clock.left + clock.width / 2) - (stage.left + stage.width / 2)
        ),
        centerErrorY: Math.abs(
          (clock.top + clock.height / 2) - (stage.top + stage.height / 2)
        ),
        fontSize: Number.parseFloat(getComputedStyle(clockElement).fontSize),
        minimumLargeFontSize: Math.min(stage.width, stage.height) * 0.12,
      };
    })()`),
    '無 Logo 待機大時鐘',
  );
  assert.ok(standbyClock.centerErrorX <= 1);
  assert.ok(standbyClock.centerErrorY <= 1);
  assert.ok(standbyClock.fontSize >= standbyClock.minimumLargeFontSize);
}

/**
 * 在指定進度區間擷取真實 Canvas alpha 分佈與圖片幾何。
 * 使用區間 waitFor 避免依賴單一毫秒時點，降低不同機器幀率差異。
 */
async function captureSandFrame({
  minimumProgress,
  maximumProgress,
  expectedVisibleSource,
  description,
}) {
  return waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const progress = Number(stage.dataset.sandProgress);
      const layer = document.getElementById('standby-background-layer')
        .getBoundingClientRect();
      const canvas = document.getElementById('standby-sand-transition');
      const canvasBox = canvas.getBoundingClientRect();
      const images = [...document.querySelectorAll('.standby-background-image')];
      const visibleImage = images.find((image) => !image.hidden);

      if (
        stage.dataset.mode !== 'blank' ||
        stage.dataset.standbyTransition !== 'sand' ||
        progress < ${minimumProgress} || progress > ${maximumProgress} ||
        canvas.hidden || canvas.width <= 1 || canvas.height <= 1 ||
        visibleImage?.getAttribute('src') !== '${expectedVisibleSource}'
      ) {
        return false;
      }

      const context = canvas.getContext('2d');
      const sampleRegion = (
        minimumX,
        maximumX,
        minimumY,
        maximumY,
        columns = 14,
        rows = 14,
      ) => {
        let transparent = 0;
        let partial = 0;
        let opaque = 0;

        for (let column = 0; column < columns; column += 1) {
          const normalizedX = minimumX +
            ((column + 0.5) / columns) * (maximumX - minimumX);
          const x = Math.min(
            canvas.width - 1,
            Math.floor(normalizedX * canvas.width),
          );
          for (let row = 0; row < rows; row += 1) {
            const normalizedY = minimumY +
              ((row + 0.5) / rows) * (maximumY - minimumY);
            const y = Math.min(
              canvas.height - 1,
              Math.floor(normalizedY * canvas.height),
            );
            const alpha = context.getImageData(x, y, 1, 1).data[3];
            if (alpha <= 24) {
              transparent += 1;
            } else if (alpha >= 231) {
              opaque += 1;
            } else {
              partial += 1;
            }
          }
        }

        const total = transparent + partial + opaque;
        return {
          transparent,
          partial,
          opaque,
          transparentRatio: transparent / total,
          opaqueRatio: opaque / total,
        };
      };

      const visibleBox = visibleImage.getBoundingClientRect();
      const particleDraws = canvas.__displayCoreSandTelemetry?.draws ?? [];
      const particleHorizontalMass = new Array(5).fill(0);
      for (const particle of particleDraws) {
        const bucket = Math.min(
          particleHorizontalMass.length - 1,
          Math.max(
            0,
            Math.floor(
              particle.centerX / canvas.width * particleHorizontalMass.length,
            ),
          ),
        );
        particleHorizontalMass[bucket] +=
          particle.opacity * particle.width * particle.height;
      }
      const activeBandIndex = Math.max(
        0,
        Math.min(13, Math.round((progress - 0.082) / 0.052)),
      );
      const activeBandCenterY = 1 - (activeBandIndex + 0.5) / 14;
      const activeBandMinimumY = Math.max(0.005, activeBandCenterY - 0.025);
      const activeBandMaximumY = Math.min(0.995, activeBandCenterY + 0.025);
      const toBox = (box) => ({
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      });
      const coversLayer = (box) =>
        Math.abs(box.left - layer.left) <= 0.5 &&
        Math.abs(box.top - layer.top) <= 0.5 &&
        Math.abs(box.width - layer.width) <= 0.5 &&
        Math.abs(box.height - layer.height) <= 0.5;

      return {
        progress,
        transition: stage.dataset.standbyTransition,
        canvasCoversLayer: coversLayer(canvasBox),
        visibleSource: visibleImage.getAttribute('src'),
        visibleImageCoversLayer: coversLayer(visibleBox),
        layerBox: toBox(layer),
        canvasBox: toBox(canvasBox),
        visibleImageBox: toBox(visibleBox),
        regions: {
          topLeft: sampleRegion(0.04, 0.28, 0.03, 0.11, 18, 12),
          topRight: sampleRegion(0.72, 0.96, 0.03, 0.11, 18, 12),
          middleLeft: sampleRegion(0.04, 0.28, 0.39, 0.48, 18, 12),
          middleRight: sampleRegion(0.72, 0.96, 0.39, 0.48, 18, 12),
          bottomLeft: sampleRegion(0.04, 0.28, 0.77, 0.86, 18, 12),
          bottomRight: sampleRegion(0.72, 0.96, 0.77, 0.86, 18, 12),
          leftColumn: sampleRegion(0.115, 0.125, 0.04, 0.96, 1, 64),
        },
        particleTelemetry: {
          drawCount: particleDraws.length,
          horizontalMass: particleHorizontalMass,
          strongestBucket: particleHorizontalMass.indexOf(
            Math.max(...particleHorizontalMass),
          ),
        },
        activeBand: {
          index: activeBandIndex,
          centerY: activeBandCenterY,
          left: sampleRegion(
            0.04,
            0.28,
            activeBandMinimumY,
            activeBandMaximumY,
            18,
            10,
          ),
          right: sampleRegion(
            0.72,
            0.96,
            activeBandMinimumY,
            activeBandMaximumY,
            18,
            10,
          ),
        },
        imageMotion: images.map((image) => {
          const style = getComputedStyle(image);
          return {
            source: image.getAttribute('src'),
            hidden: image.hidden,
            transform: style.transform,
            translate: style.translate || 'none',
            animationName: style.animationName,
          };
        }),
      };
    })()`),
    description,
  );
}

/**
 * 僅在 smoke Renderer 包裝既有 Canvas 方法；每次仍呼叫原生 drawImage，
 * 但額外記錄小型來源圖塊的實際繪製位置，避免把侵蝕圓反鋸齒誤判成沙粒。
 */
async function installSandParticleTelemetry() {
  const installed = await execute(`(() => {
    const canvas = document.getElementById('standby-sand-transition');
    const context = canvas.getContext('2d');
    if (!context) {
      return false;
    }
    if (canvas.__displayCoreSandTelemetry) {
      return true;
    }

    const telemetry = { draws: [] };
    const originalClearRect = context.clearRect.bind(context);
    const originalDrawImage = context.drawImage.bind(context);

    context.clearRect = (...args) => {
      telemetry.draws = [];
      return originalClearRect(...args);
    };
    context.drawImage = (...args) => {
      if (args.length === 9) {
        const destinationX = Number(args[5]);
        const destinationY = Number(args[6]);
        const destinationWidth = Number(args[7]);
        const destinationHeight = Number(args[8]);
        const isParticle =
          destinationWidth > 0 && destinationHeight > 0 &&
          destinationWidth < canvas.width * 0.1 &&
          destinationHeight < canvas.height * 0.1;
        if (isParticle) {
          telemetry.draws.push({
            centerX: destinationX + destinationWidth / 2,
            centerY: destinationY + destinationHeight / 2,
            width: destinationWidth,
            height: destinationHeight,
            opacity: context.globalAlpha,
          });
        }
      }
      return originalDrawImage(...args);
    };

    Object.defineProperty(canvas, '__displayCoreSandTelemetry', {
      value: telemetry,
      configurable: true,
    });
    return true;
  })()`);

  assert.equal(installed, true, '必須能觀測真實 Canvas 沙粒繪製');
}

function assertImagesRemainStationary(imageMotion, description) {
  assert.equal(imageMotion.length, 2, `${description} 雙緩衝圖片`);
  for (const image of imageMotion) {
    assert.equal(image.transform, 'none', `${description} image transform`);
    assert.equal(image.translate, 'none', `${description} image translate`);
    assert.equal(image.animationName, 'none', `${description} image animation`);
  }
}

async function runWorkflow(
  timers,
  expectedLogoUrl,
  expectedStandbyBackgroundUrls,
  delayedSecondBackgroundRead,
) {
  const [expectedStandbyBackgroundUrl, secondStandbyBackgroundUrl] =
    expectedStandbyBackgroundUrls;
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

  await waitFor(
    () => Promise.resolve(delayedSecondBackgroundRead.hasStarted()),
    '第二張待機背景開始載入',
  );

  const whileSecondBackgroundLoads = await execute(`(() => {
    const layer = document.getElementById('standby-background-layer');
    const images = [...document.querySelectorAll('.standby-background-image')];
    const visibleImages = images.filter((image) => !image.hidden);
    const pendingImage = images.find(
      (image) => image.getAttribute('src') === '${secondStandbyBackgroundUrl}'
    );
    return {
      imageCount: images.length,
      layerHidden: layer.hidden,
      visibleSources: visibleImages.map((image) => image.getAttribute('src')),
      pendingSource: pendingImage?.getAttribute('src') ?? null,
      pendingHidden: pendingImage?.hidden ?? null,
    };
  })()`);
  assert.deepEqual(whileSecondBackgroundLoads, {
    imageCount: 2,
    layerHidden: false,
    visibleSources: [expectedStandbyBackgroundUrl],
    pendingSource: secondStandbyBackgroundUrl,
    pendingHidden: true,
  });

  const beforeSandGeometry = await execute(`(() => {
    const layer = document.getElementById('standby-background-layer')
      .getBoundingClientRect();
    const images = [...document.querySelectorAll('.standby-background-image')];
    const visibleImage = images.find((image) => !image.hidden);
    const visibleBox = visibleImage.getBoundingClientRect();
    return {
      visibleSource: visibleImage.getAttribute('src'),
      visibleImageCoversLayer:
        Math.abs(visibleBox.left - layer.left) <= 0.5 &&
        Math.abs(visibleBox.top - layer.top) <= 0.5 &&
        Math.abs(visibleBox.width - layer.width) <= 0.5 &&
        Math.abs(visibleBox.height - layer.height) <= 0.5,
      imageMotion: images.map((image) => {
        const style = getComputedStyle(image);
        return {
          source: image.getAttribute('src'),
          hidden: image.hidden,
          transform: style.transform,
          translate: style.translate || 'none',
          animationName: style.animationName,
        };
      }),
    };
  })()`);
  assert.equal(beforeSandGeometry.visibleSource, expectedStandbyBackgroundUrl);
  assert.equal(beforeSandGeometry.visibleImageCoversLayer, true);
  assertImagesRemainStationary(beforeSandGeometry.imageMotion, '轉場前');

  await installSandParticleTelemetry();
  delayedSecondBackgroundRead.release();
  const earlySandFrame = await captureSandFrame({
    minimumProgress: 0.15,
    maximumProgress: 0.34,
    expectedVisibleSource: secondStandbyBackgroundUrl,
    description: '下層水平風帶 Canvas 幀',
  });
  assert.equal(earlySandFrame.transition, 'sand');
  assert.equal(earlySandFrame.canvasCoversLayer, true);
  assert.equal(earlySandFrame.visibleImageCoversLayer, true);
  assert.equal(earlySandFrame.visibleSource, secondStandbyBackgroundUrl);
  assertImagesRemainStationary(earlySandFrame.imageMotion, '轉場早段');
  assert.ok(
    earlySandFrame.activeBand.centerY > 0.6,
    `早段風帶必須位於畫面下方：${JSON.stringify(earlySandFrame.activeBand)}`,
  );
  assert.ok(
    earlySandFrame.activeBand.left.transparentRatio >=
      earlySandFrame.activeBand.right.transparentRatio + 0.08,
    `下層作用中的風帶必須由左吹向右：` +
      JSON.stringify(earlySandFrame.activeBand),
  );
  assert.ok(
    earlySandFrame.regions.leftColumn.transparent > 0 &&
      earlySandFrame.regions.leftColumn.opaque > 0,
    `同一左側欄必須同時有透明與不透明點，不可是 vertical wipe：` +
      JSON.stringify(earlySandFrame.regions.leftColumn),
  );
  assert.ok(
    earlySandFrame.particleTelemetry.drawCount > 0,
    '下層風帶必須繪出舊圖片來源沙粒',
  );

  const middleSandFrame = await captureSandFrame({
    minimumProgress: 0.35,
    maximumProgress: 0.62,
    expectedVisibleSource: secondStandbyBackgroundUrl,
    description: '中層水平風帶 Canvas 幀',
  });
  assert.equal(middleSandFrame.transition, 'sand');
  assert.equal(middleSandFrame.canvasCoversLayer, true);
  assert.equal(middleSandFrame.visibleImageCoversLayer, true);
  assert.equal(middleSandFrame.visibleSource, secondStandbyBackgroundUrl);
  assertImagesRemainStationary(middleSandFrame.imageMotion, '轉場中段');
  assert.ok(
    middleSandFrame.regions.bottomLeft.transparentRatio >= 0.75 &&
      middleSandFrame.regions.bottomRight.transparentRatio >= 0.75,
    `風帶上移後下層左右都必須已吹散：${JSON.stringify(middleSandFrame.regions)}`,
  );
  assert.ok(
    middleSandFrame.activeBand.centerY >= 0.2 &&
      middleSandFrame.activeBand.centerY <= 0.65,
    `中段風帶必須位於畫面中層：${JSON.stringify(middleSandFrame.activeBand)}`,
  );
  assert.ok(
    middleSandFrame.activeBand.left.transparentRatio >=
      middleSandFrame.activeBand.right.transparentRatio + 0.08,
    `中層作用中的風帶仍必須由左吹向右：` +
      JSON.stringify(middleSandFrame.activeBand),
  );
  assert.ok(
    middleSandFrame.particleTelemetry.drawCount > 0,
    '中層風帶必須持續繪出舊圖片來源沙粒',
  );
  assert.equal(
    middleSandFrame.particleTelemetry.strongestBucket,
    3,
    `實際 Canvas 沙粒質量峰值必須位於畫面 60%～80%：` +
      JSON.stringify(middleSandFrame.particleTelemetry.horizontalMass),
  );
  assert.ok(
    middleSandFrame.regions.bottomLeft.transparentRatio >=
      earlySandFrame.regions.bottomLeft.transparentRatio,
    '下層侵蝕量不得隨進度倒退',
  );
  assert.ok(
    Math.abs(
      middleSandFrame.visibleImageBox.left -
        earlySandFrame.visibleImageBox.left,
    ) <= 0.5 &&
      Math.abs(
        middleSandFrame.visibleImageBox.top -
          earlySandFrame.visibleImageBox.top,
      ) <= 0.5 &&
      Math.abs(
        middleSandFrame.visibleImageBox.width -
          earlySandFrame.visibleImageBox.width,
      ) <= 0.5 &&
      Math.abs(
        middleSandFrame.visibleImageBox.height -
          earlySandFrame.visibleImageBox.height,
      ) <= 0.5,
    '新圖不得在轉場期間平移或縮放',
  );

  const lateSandFrame = await captureSandFrame({
    minimumProgress: 0.63,
    maximumProgress: 0.82,
    expectedVisibleSource: secondStandbyBackgroundUrl,
    description: '上層水平風帶 Canvas 幀',
  });
  assert.equal(lateSandFrame.transition, 'sand');
  assert.equal(lateSandFrame.canvasCoversLayer, true);
  assert.equal(lateSandFrame.visibleImageCoversLayer, true);
  assert.equal(lateSandFrame.visibleSource, secondStandbyBackgroundUrl);
  assertImagesRemainStationary(lateSandFrame.imageMotion, '轉場晚段');
  assert.ok(
    lateSandFrame.regions.middleLeft.transparentRatio >= 0.75 &&
      lateSandFrame.regions.middleRight.transparentRatio >= 0.75,
    `風帶到達上層時中層必須已吹散：${JSON.stringify(lateSandFrame.regions)}`,
  );
  assert.ok(
    lateSandFrame.activeBand.centerY < 0.25,
    `晚段風帶必須位於畫面上方：${JSON.stringify(lateSandFrame.activeBand)}`,
  );
  assert.ok(
    lateSandFrame.activeBand.left.transparentRatio >=
      lateSandFrame.activeBand.right.transparentRatio + 0.08,
    `上層作用中的風帶仍必須由左吹向右：` +
      JSON.stringify(lateSandFrame.activeBand),
  );
  assert.ok(
    lateSandFrame.particleTelemetry.drawCount > 0,
    '上層風帶必須延續舊圖片來源沙粒，不能在結尾前中斷',
  );
  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const canvas = document.getElementById('standby-sand-transition');
      const image = [...document.querySelectorAll('.standby-background-image')]
        .find((candidate) => !candidate.hidden);
      return stage.dataset.mode === 'blank' &&
        stage.dataset.standbyTransition === undefined &&
        canvas.hidden && image?.complete && image.naturalWidth > 0 &&
        image.getAttribute('src') === '${secondStandbyBackgroundUrl}';
    })()`),
    '吹沙轉場完成後保留第二張背景',
  );

  const literalHtml = '<img src=x onerror="globalThis.displayPwned=true">\n純文字';
  const messages = [
    { message: '001請至前廳', alignment: 'left' },
    { message: '002請至前廳', alignment: 'left' },
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
  const pausedStandbySources = await execute(
    `[...document.querySelectorAll('.standby-background-image')]
      .map((image) => image.getAttribute('src'))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.deepEqual(
    await execute(
      `[...document.querySelectorAll('.standby-background-image')]
        .map((image) => image.getAttribute('src'))`,
    ),
    pausedStandbySources,
    '一般訊息頁不得繼續輪播待機背景',
  );
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
      standbyBackgroundSources: [
        ...document.querySelectorAll('.standby-background-image')
      ].map((image) => image.getAttribute('src')),
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
    alignments: ['left', 'left', 'left'],
    justifyContents: ['flex-start', 'flex-start', 'flex-start'],
    textAlignments: ['left', 'left', 'left'],
    rowCount: 3,
    pageHidden: false,
    fillHidden: true,
    normalHidden: false,
    normalHasLogo: true,
    normalHasClock: true,
    chromeHidden: false,
    standbyBackgroundHidden: true,
    standbyBackgroundSources: pausedStandbySources,
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
  for (const source of firstPage.standbyBackgroundSources.filter(Boolean)) {
    assert.doesNotMatch(
      source,
      /file:|Users|userData|standby-backgrounds/i,
    );
  }
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
  assert.equal(timers.active().length, 0, '555 不得建立時間限制 timer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentationService.getSnapshot().revision, 5);
  assert.equal(presentationService.getSnapshot().mode, 'emergency');
  assert.equal(presentationService.getSnapshot().messages[0].message, '555');

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
  assert.equal(
    await execute(`document.getElementById('display-clock').hidden`),
    true,
    '888 解除臨檢時仍不得顯示 clock',
  );
  assert.equal(timers.active().length, 0, '888 不得建立時間限制 timer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentationService.getSnapshot().revision, 6);
  assert.equal(presentationService.getSnapshot().mode, 'emergency');
  assert.equal(presentationService.getSnapshot().messages[0].message, '888');

  presentationService.clearPresentation();
  await waitForRevision(7, false);
  const standby = await waitFor(() => execute(`(() => {
    const stage = document.getElementById('display-stage').getBoundingClientRect();
    const clock = document.getElementById('display-clock').getBoundingClientRect();
    const background = [...document.querySelectorAll('.standby-background-image')]
      .find((image) => !image.hidden);
    const canvas = document.getElementById('standby-sand-transition');
    const result = {
      mode: document.getElementById('display-stage').dataset.mode,
      announcement: document.getElementById('display-announcement').textContent,
      pageChildren: document.getElementById('page-layer').children.length,
      fillChildren: document.getElementById('fill-layer').children.length,
      normalHidden: document.getElementById('normal-layer').hidden,
      chromeHidden: document.getElementById('display-chrome').hidden,
      standbyBackgroundHidden:
        document.getElementById('standby-background-layer').hidden,
      standbyBackgroundSource: background?.getAttribute('src') ?? null,
      standbyBackgroundObjectFit: background
        ? getComputedStyle(background).objectFit
        : null,
      clockText: document.getElementById('display-clock').textContent,
      clockCenter: clock.left + (clock.width / 2),
      stageCenter: stage.left + (stage.width / 2),
      standbyLayerExists: document.getElementById('standby-layer') !== null,
      standbyMessageExists: document.getElementById('standby-message') !== null,
      hasWelcomeText: document.body.innerText.includes('歡迎光臨'),
      transition: document.getElementById('display-stage')
        .dataset.standbyTransition ?? null,
      canvasHidden: canvas.hidden,
    };
    return result.mode === 'blank' &&
      result.standbyBackgroundSource === '${expectedStandbyBackgroundUrl}' &&
      result.transition === null && result.canvasHidden
      ? result
      : false;
  })()`), '由訊息或緊急畫面回待機時第一張直接顯示');
  assert.equal(standby.mode, 'blank');
  assert.equal(standby.announcement, '');
  assert.equal(standby.pageChildren, 0);
  assert.equal(standby.fillChildren, 0);
  assert.equal(standby.normalHidden, false);
  assert.equal(
    standby.chromeHidden,
    false,
    '待機時 chrome 必須保留，才能呈現置中的大時鐘',
  );
  assert.equal(standby.standbyBackgroundHidden, false);
  assert.equal(
    standby.standbyBackgroundSource,
    expectedStandbyBackgroundUrl,
  );
  assert.equal(standby.standbyBackgroundObjectFit, 'cover');
  assert.equal(standby.standbyLayerExists, false);
  assert.equal(standby.standbyMessageExists, false);
  assert.equal(standby.hasWelcomeText, false);
  assert.equal(standby.transition, null);
  assert.equal(standby.canvasHidden, true);
  assert.equal(
    await execute(`getComputedStyle(document.body).backgroundColor`),
    'rgb(32, 64, 96)',
  );
  assert.match(standby.clockText, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(Math.abs(standby.clockCenter - standby.stageCenter) < 1);
  await verifyDisplayedClockOffset(3_661, '待機時保留離線時間偏移');

  const resumedSlideshow = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const canvas = document.getElementById('standby-sand-transition');
      const image = [...document.querySelectorAll('.standby-background-image')]
        .find((candidate) => !candidate.hidden);
      return stage.dataset.mode === 'blank' &&
        stage.dataset.standbyTransition === 'sand' && !canvas.hidden &&
        image?.getAttribute('src') === '${secondStandbyBackgroundUrl}'
        ? {
            transition: stage.dataset.standbyTransition,
            source: image.getAttribute('src'),
          }
        : false;
    })()`),
    '回待機後第一張停留結束並進入第二張吹沙轉場',
  );
  assert.deepEqual(resumedSlideshow, {
    transition: 'sand',
    source: secondStandbyBackgroundUrl,
  });

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
  await verifyFixedMessageLayout();
  await verifyClockWithoutLogo();
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
  const secondStandbyBackgroundDigest = createHash('sha256')
    .update(LOGO_BYTES)
    .digest('hex')
    .slice(0, 24);
  const secondStandbyBackgroundFileName =
    `${secondStandbyBackgroundDigest}.png`;
  const secondStandbyBackgroundAssetPath =
    `standby-backgrounds/${secondStandbyBackgroundFileName}`;
  const secondExpectedStandbyBackgroundUrl =
    `displaycore://app/managed/standby-background/${secondStandbyBackgroundFileName}`;
  await fileSystem.writeFile(
    path.join(
      managedStandbyBackgroundDirectory,
      secondStandbyBackgroundFileName,
    ),
    LOGO_BYTES,
  );

  const initialConfig = structuredClone(defaultConfig);
  initialConfig.logo = {
    enabled: true,
    path: logoAssetPath,
    sizePercent: 100,
  };
  initialConfig.standby = {
    backgroundMode: 'slideshow',
    backgroundImagePaths: [
      standbyBackgroundAssetPath,
      secondStandbyBackgroundAssetPath,
    ],
    slideDurationSeconds: 1,
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
  const delayedSecondBackgroundRead = createDelayedReadFileSystem(
    secondStandbyBackgroundFileName,
  );
  appSession.protocol.handle(APP_SCHEME, createLocalProtocolHandler({
    net,
    appRoot: projectRoot,
    managedLogoDirectory,
    managedStandbyBackgroundDirectory,
    getAllowedLogoPath: () => {
      const logo = settingsManager.getSnapshot().config.logo;
      return logo.enabled ? logo.path : null;
    },
    getAllowedStandbyBackgroundPaths: () =>
      settingsManager.getSnapshot().config.standby.backgroundImagePaths,
    fileSystem: delayedSecondBackgroundRead.fileSystem,
  }));

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
    [
      expectedStandbyBackgroundUrl,
      secondExpectedStandbyBackgroundUrl,
    ],
    delayedSecondBackgroundRead,
  );
  finish(0, '[DisplayCore] Display window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Display window smoke test failed.', error);
});
