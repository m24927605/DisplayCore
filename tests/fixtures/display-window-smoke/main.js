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
  nativeImage,
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
// 輸出多張 4K／Retina compositor 截圖會額外經過 GPU readback 與 PNG 編碼。
const TIMEOUT_MS = process.env.DISPLAYCORE_VISUAL_QA_DIRECTORY?.trim()
  ? 60_000
  : 45_000;
const LOGO_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAHCAYAAADEUlfTAAAAGUlEQVR4nGNgQID/SBgDYJX8jwdTIEmegwDYmyDgo5Y0vwAAAABJRU5ErkJggg==',
  'base64',
);

/** 建立具明暗與色差的離線測試背景，讓真實截圖能看見圖片顆粒沙塵。 */
function createStandbyBackgroundBytes(variant) {
  const width = 640;
  const height = 360;
  const bitmap = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const normalizedY = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const normalizedX = x / (width - 1);
      const dune = Math.sin(normalizedX * Math.PI * 3.2 + normalizedY * 2.1);
      const ripple = Math.sin(normalizedX * 42 + normalizedY * 13) * 0.5 + 0.5;
      const grain = ((x * 37 + y * 61 + variant * 97) % 29) / 28;
      const horizon = Math.max(0, normalizedY - 0.28) / 0.72;
      const offset = (y * width + x) * 4;
      const red = variant === 1
        ? 118 + horizon * 105 + dune * 18 + ripple * 12
        : 28 + horizon * 45 + ripple * 8;
      const green = variant === 1
        ? 66 + horizon * 74 + dune * 13 + grain * 10
        : 82 + horizon * 74 + dune * 15 + grain * 12;
      const blue = variant === 1
        ? 38 + horizon * 35 + grain * 8
        : 94 + horizon * 72 + dune * 18 + ripple * 10;

      // Electron bitmap 採 BGRA；明顯色差可驗證砂粒確實取自上一張圖片。
      bitmap[offset] = Math.max(0, Math.min(255, Math.round(blue)));
      bitmap[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
      bitmap[offset + 2] = Math.max(0, Math.min(255, Math.round(red)));
      bitmap[offset + 3] = 255;
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
}

const STANDBY_BACKGROUND_BYTES = createStandbyBackgroundBytes(1);
const SECOND_STANDBY_BACKGROUND_BYTES = createStandbyBackgroundBytes(2);

let displayWindow = null;
let coordinator = null;
let presentationService = null;
let settingsManager = null;
let completed = false;
let timeout = null;
let runtimeDataRoot = null;

// 這套 smoke workflow 專門量測 Canvas2D fallback 的 alpha 分佈。
// 明確關閉 WebGL，避免有 GPU 的機器改走正式 WebGL canvas，
// 導致測試對已隱藏的 2D canvas 做出錯誤斷言。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-webgl');
if (process.env.DISPLAYCORE_EMERGENCY_MATERIAL_QA_ONLY === '1') {
  // 緊急材質驗收要求實體 4K compositor，不可依賴測試主機目前是否為 Retina。
  app.commandLine.appendSwitch('force-device-scale-factor', '2');
}

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

/** 由實際 Chromium CSS 引擎解析顏色，避免綁死 rgb()／color(srgb) 序列化。 */
function resolveComputedBackgroundColor(expression) {
  return execute(`(() => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = ${JSON.stringify(expression)};
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  })()`);
}

/** 僅在人工視覺 QA 時輸出截圖；一般測試不建立額外檔案。 */
async function captureVisualQa(fileName) {
  const visualQaDirectory =
    process.env.DISPLAYCORE_VISUAL_QA_DIRECTORY?.trim();
  if (!visualQaDirectory) {
    return;
  }

  await execute(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  // capturePage 讀取 compositor frame；額外等待可避免截到前一個材質。
  await new Promise((resolve) => setTimeout(resolve, 120));
  await fileSystem.mkdir(visualQaDirectory, { recursive: true });
  const image = await displayWindow.webContents.capturePage();
  await fileSystem.writeFile(
    path.join(visualQaDirectory, fileName),
    image.toPNG(),
  );
}

/**
 * 擷取實際 Electron compositor 右側無文字區的訊息背景；固定抽樣同時限制
 * Retina／4K 成本。全幅文字對比另由共用遮罩與三列實際截圖驗證。
 */
async function captureMessageBackgroundStatisticsSample() {
  await execute(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  const image = await displayWindow.webContents.capturePage();

  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  const startX = Math.floor(width * 0.75);
  const startY = 0;
  const step = Math.max(4, Math.floor(Math.min(width, height) / 180));
  let count = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let lumaTotal = 0;
  let squaredLumaTotal = 0;
  let maximumLuma = 0;
  const sampledLumas = [];
  const signatureColumns = 24;
  const signatureRows = 12;
  const signatureTotals = new Array(signatureColumns * signatureRows).fill(0);
  const signatureCounts = new Array(signatureColumns * signatureRows).fill(0);

  for (let y = startY; y < height; y += step) {
    for (let x = startX; x < width; x += step) {
      const offset = ((y * width) + x) * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      const luma = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
      count += 1;
      redTotal += red;
      greenTotal += green;
      blueTotal += blue;
      lumaTotal += luma;
      squaredLumaTotal += luma * luma;
      maximumLuma = Math.max(maximumLuma, luma);
      sampledLumas.push(luma);
      const signatureColumn = Math.min(
        signatureColumns - 1,
        Math.floor(
          ((x - startX) / Math.max(1, width - startX)) * signatureColumns,
        ),
      );
      const signatureRow = Math.min(
        signatureRows - 1,
        Math.floor(
          ((y - startY) / Math.max(1, height - startY)) * signatureRows,
        ),
      );
      const signatureIndex =
        (signatureRow * signatureColumns) + signatureColumn;
      signatureTotals[signatureIndex] += luma;
      signatureCounts[signatureIndex] += 1;
    }
  }

  const averageLuma = lumaTotal / count;
  sampledLumas.sort((first, second) => first - second);
  return Object.freeze({
    averageRed: redTotal / count,
    averageGreen: greenTotal / count,
    averageBlue: blueTotal / count,
    averageLuma,
    lumaDeviation: Math.sqrt(
      Math.max(0, (squaredLumaTotal / count) - (averageLuma ** 2)),
    ),
    lumaP95: sampledLumas[Math.floor((sampledLumas.length - 1) * 0.95)],
    lumaP99: sampledLumas[Math.floor((sampledLumas.length - 1) * 0.99)],
    maximumLuma,
    spatialLuma: signatureTotals.map((total, index) =>
      total / Math.max(1, signatureCounts[index])),
  });
}

/**
 * 判斷 Electron compositor 是否已交付不同的材質影格。
 * DOM／圖片解碼完成不代表 capturePage 已同步到同一影格，因此測試必須等待
 * 真正的像素改變，不能依賴任意固定毫秒數。
 */
function hasMessageBackgroundFrameChanged(previous, current) {
  if (!previous) {
    return true;
  }

  const averageChannelDistance =
    Math.abs(current.averageRed - previous.averageRed) +
    Math.abs(current.averageGreen - previous.averageGreen) +
    Math.abs(current.averageBlue - previous.averageBlue);
  const spatialDistance = current.spatialLuma.reduce(
    (total, value, index) =>
      total + Math.abs(value - previous.spatialLuma[index]),
    0,
  ) / current.spatialLuma.length;

  return averageChannelDistance > 0.01 || spatialDistance > 0.01;
}

async function captureMessageBackgroundStatistics(previous = null) {
  return waitFor(async () => {
    const current = await captureMessageBackgroundStatisticsSample();
    return hasMessageBackgroundFrameChanged(previous, current)
      ? current
      : false;
  }, 'Electron compositor 套用最新訊息材質影格');
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

/**
 * 暫停並 seek 目前頁面的 WAAPI 液位時鐘，再以指定的物理時間直接繪製
 * SVG 酒液影格。液位與波相位可以分開取樣，避免測試等待真實秒數。
 */
async function sampleMessageLiquid(progress, timePhase = progress) {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new RangeError('訊息酒液取樣進度必須介於 0～1。');
  }
  if (
    !Number.isFinite(timePhase) ||
    timePhase < 0 ||
    timePhase > 1
  ) {
    throw new RangeError('倒酒物理時間相位必須介於 0～1。');
  }

  return waitFor(
    () => execute(`(async () => {
      const { renderMessageLiquidFrame } = await import(
        './message-liquid-svg.mjs'
      );
      const pageLayer = document.getElementById('page-layer');
      const clock = document.getElementById('display-clock');
      const logo = document.getElementById('display-logo');
      const animations = pageLayer.getAnimations();
      const animation = animations.find((candidate) =>
        candidate.effect.getKeyframes().some((keyframe) =>
          Object.hasOwn(keyframe, '--message-liquid-level')
        )
      );
      if (!animation) {
        return false;
      }

      animation.pause();
      try {
        await animation.ready;
      } catch {
        return false;
      }
      const duration = animation.effect.getComputedTiming().duration;
      if (!Number.isFinite(duration) || duration <= 0) {
        return false;
      }
      animation.currentTime = duration * ${progress};
      pageLayer.style.setProperty(
        '--message-liquid-level',
        '${Number((progress * 100).toFixed(6))}%'
      );
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const renderedCount = renderMessageLiquidFrame(pageLayer, {
        progress: ${progress},
        timeMilliseconds: duration * ${timePhase},
        durationMilliseconds: duration,
      });

      const rows = [...document.querySelectorAll('.message-row')];
      const toRect = (element) => {
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          left: rect.left,
          top: rect.top,
          width: rect.width,
        };
      };
      const nearlyEqual = (first, second) =>
        first !== null && second !== null &&
        Math.abs(first.height - second.height) <= 0.5 &&
        Math.abs(first.left - second.left) <= 0.5 &&
        Math.abs(first.top - second.top) <= 0.5 &&
        Math.abs(first.width - second.width) <= 0.5;
      const overlayAligned = (vesselRect, overlayRect) => {
        if (vesselRect === null || overlayRect === null) {
          return false;
        }

        const vesselBottom = vesselRect.top + vesselRect.height;
        const overlayBottom = overlayRect.top + overlayRect.height;
        const maximumOutlineOverflow = Math.max(
          4,
          vesselRect.height * 0.15
        );
        return (
          Math.abs(vesselRect.left - overlayRect.left) <= 0.5 &&
          Math.abs(vesselRect.width - overlayRect.width) <= 0.5 &&
          overlayRect.top <= vesselRect.top + 0.5 &&
          overlayBottom >= vesselBottom - 0.5 &&
          overlayRect.height - vesselRect.height <= maximumOutlineOverflow
        );
      };

      return {
        animationCount: animations.length,
        computedLiquidLevel: getComputedStyle(pageLayer)
          .getPropertyValue('--message-liquid-level').trim(),
        effectKeyframes: animation.effect.getKeyframes(),
        inlineLiquidLevel: pageLayer.style
          .getPropertyValue('--message-liquid-level'),
        liquidPropertySupported: CSS.supports(
          '--message-liquid-level', '50%'
        ),
        clockAnimationCount: clock.getAnimations({ subtree: true }).length,
        clockColor: getComputedStyle(clock).color,
        clockFillColor: getComputedStyle(clock)
          .getPropertyValue('-webkit-text-fill-color'),
        clockStrokeWidth: getComputedStyle(clock)
          .getPropertyValue('-webkit-text-stroke-width'),
        duration,
        renderedCount,
        requestedProgress: ${progress},
        requestedTimePhase: ${timePhase},
        liquidRows: rows.map((row) => {
          const sizing = row.querySelector('.message-glyph-sizing');
          const shell = row.querySelector('.message-glyph-shell');
          const vessel = row.querySelector('.message-vessel');
          const svg = vessel?.querySelector('.message-liquid-svg') ?? null;
          const mask = svg?.querySelector('.message-liquid-mask') ?? null;
          const canonicalGlyph = svg?.querySelector(
            '.message-liquid-canonical-glyph'
          ) ?? null;
          const maskGlyph = mask?.querySelector(
            '.message-liquid-mask-glyph'
          ) ?? null;
          const outlineGlyph = svg?.querySelector(
            '.message-liquid-outline-glyph'
          ) ?? null;
          const paint = svg?.querySelector('.message-liquid-paint') ?? null;
          const body = paint?.querySelector('.message-liquid-body') ?? null;
          const refraction = paint?.querySelector(
            '.message-liquid-refraction'
          ) ?? null;
          const meniscus = paint?.querySelector(
            '.message-liquid-meniscus'
          ) ?? null;
          const sizingRect = toRect(sizing);
          const shellRect = toRect(shell);
          const vesselRect = toRect(vessel);
          const svgRect = toRect(svg);
          const beforeStyle = getComputedStyle(vessel, '::before');
          const afterStyle = getComputedStyle(vessel, '::after');
          const maskId = mask?.id ?? null;
          const expectedMaskUrl = maskId === null
            ? null
            : 'url(#' + maskId + ')';
          const paintMask = paint?.getAttribute('mask') ?? null;
          const bodyPaintMask = body?.closest('.message-liquid-paint')
            ?.getAttribute('mask') ?? null;
          const refractionPaintMask = refraction
            ?.closest('.message-liquid-paint')?.getAttribute('mask') ?? null;
          const meniscusPaintMask = meniscus
            ?.closest('.message-liquid-paint')?.getAttribute('mask') ?? null;
          const viewBox = svg?.viewBox?.baseVal ?? null;
          const readGlyphRuns = (glyph) => [
            ...(glyph?.querySelectorAll('.message-liquid-glyph-run') ?? [])
          ].map((text) => ({
            fontFamily: text.style.getPropertyValue('font-family'),
            isNumber: text.classList.contains('message-liquid-glyph-number'),
            lengthAdjust: text.getAttribute('lengthAdjust'),
            text: text.textContent,
            textLength: text.getAttribute('textLength'),
            x: text.getAttribute('x'),
            y: text.getAttribute('y'),
          }));
          const canonicalRuns = readGlyphRuns(canonicalGlyph);
          const maskRuns = readGlyphRuns(maskGlyph);
          const outlineRuns = readGlyphRuns(outlineGlyph);
          return {
            effect: row.dataset.liquidEffect,
            geometryAligned:
              nearlyEqual(sizingRect, shellRect) &&
              (svg === null || overlayAligned(vesselRect, svgRect)),
            svgCount: vessel?.querySelectorAll('.message-liquid-svg').length ?? 0,
            svgDisplay: svg === null ? 'none' : getComputedStyle(svg).display,
            svgNamespace: svg?.namespaceURI ?? null,
            svgViewBox: svg?.getAttribute('viewBox') ?? null,
            viewBoxWidth: viewBox?.width ?? 0,
            viewBoxHeight: viewBox?.height ?? 0,
            maskCount: svg?.querySelectorAll('.message-liquid-mask').length ?? 0,
            maskId,
            maskType: mask?.getAttribute('mask-type') ?? null,
            foreignObjectCount: mask?.querySelectorAll('foreignObject').length ?? 0,
            canonicalGlyphCount: svg?.querySelectorAll(
              '.message-liquid-canonical-glyph'
            ).length ?? 0,
            maskGlyphCount: mask?.querySelectorAll(
              '.message-liquid-mask-glyph'
            ).length ?? 0,
            outlineGlyphCount: svg?.querySelectorAll(
              '.message-liquid-outline-glyph'
            ).length ?? 0,
            canonicalText: canonicalGlyph?.textContent ?? null,
            maskText: maskGlyph?.textContent ?? null,
            outlineText: outlineGlyph?.textContent ?? null,
            sizingText: sizing?.textContent ?? null,
            canonicalRuns,
            maskRuns,
            outlineRuns,
            sizingNumberTexts: [...(sizing?.querySelectorAll(
              '.message-number'
            ) ?? [])].map((span) => span.textContent),
            outlineFill: outlineGlyph?.getAttribute('fill') ?? null,
            outlineStroke: outlineGlyph?.getAttribute('stroke') ?? null,
            outlineStrokeWidth: Number(
              outlineGlyph?.getAttribute('stroke-width') ?? 0
            ),
            outlineAnimationName: outlineGlyph === null
              ? null
              : getComputedStyle(outlineGlyph).animationName,
            paintMask,
            expectedMaskUrl,
            bodyPaintMask,
            refractionPaintMask,
            meniscusPaintMask,
            bodyPath: body?.getAttribute('d') ?? '',
            refractionPath: refraction?.getAttribute('d') ?? '',
            meniscusPath: meniscus?.getAttribute('d') ?? '',
            bodyOpacity: Number(body?.getAttribute('opacity') ?? 0),
            refractionOpacity: Number(
              refraction?.getAttribute('opacity') ?? 0
            ),
            meniscusOpacity: Number(
              meniscus?.getAttribute('opacity') ?? 0
            ),
            outsideBeforeAnimationName: beforeStyle.animationName,
            outsideBeforeContent: beforeStyle.content,
            outsideAfterAnimationName: afterStyle.animationName,
            outsideAfterContent: afterStyle.content,
            rect: shellRect,
            shellFillColor: getComputedStyle(shell)
              .getPropertyValue('-webkit-text-fill-color'),
            shellStrokeColor: getComputedStyle(shell)
              .getPropertyValue('-webkit-text-stroke-color'),
            shellStrokeWidth: getComputedStyle(shell)
              .getPropertyValue('-webkit-text-stroke-width'),
            shellVisibility: getComputedStyle(shell).visibility,
            sizingFillColor: getComputedStyle(sizing)
              .getPropertyValue('-webkit-text-fill-color'),
            vesselRect,
          };
        }),
        logoAnimationCount: logo.getAnimations({ subtree: true }).length,
      };
    })()`),
    `一般訊息酒液高度 ${progress}`,
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
      const match = /^(\\d{2}):(\\d{2})$/.exec(text);
      if (!match) {
        return false;
      }

      const displayedMinutes = Number(match[1]) * 60 + Number(match[2]);
      const now = new Date();
      const localSeconds =
        now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const expectedSeconds =
        (localSeconds + ${expectedOffsetSeconds} + 86400) % 86400;
      const expectedMinutes = Math.floor(expectedSeconds / 60);
      const absoluteDifference = Math.abs(displayedMinutes - expectedMinutes);
      const circularDifference = Math.min(
        absoluteDifference,
        1440 - absoluteDifference,
      );

      return circularDifference <= 1 ? {
        text,
        dateTime: document.getElementById('display-clock').getAttribute('datetime'),
        circularDifference,
      } : false;
    })()`),
    description,
  );

  assert.match(measurement.text, /^\d{2}:\d{2}$/);
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
  assert.match(inspection.clockText, /^\d{2}:\d{2}$/);
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
    [1280, 720],
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
    [1280, 720],
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
    ['1280x720', 1280, 720],
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
      firstRowLiquidEffect: firstRow.dataset.liquidEffect,
      firstRowLiquidDisplay: (() => {
        const svg = firstRow.querySelector('.message-liquid-svg');
        return svg === null ? 'none' : getComputedStyle(svg).display;
      })(),
      firstRowShellFillColor: getComputedStyle(
        firstRow.querySelector('.message-glyph-shell')
      ).getPropertyValue('-webkit-text-fill-color'),
      liquidAnimationCount: page.getAnimations().filter((animation) =>
        animation.effect.getKeyframes().some((keyframe) =>
          Object.hasOwn(keyframe, '--message-liquid-level')
        )
      ).length,
      inlineLiquidLevel: page.style.getPropertyValue(
        '--message-liquid-level'
      ),
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
  assert.equal(operation.firstRowLiquidEffect, 'static');
  assert.equal(operation.firstRowLiquidDisplay, 'none');
  assert.equal(operation.firstRowShellFillColor, 'rgb(255, 255, 255)');
  assert.equal(operation.liquidAnimationCount, 0);
  assert.equal(operation.inlineLiquidLevel, '');
  assert.ok(Math.abs(operation.firstTextCenterX - operation.pageCenterX) <= 1);
  assert.ok(Math.abs(operation.firstTextCenterY - operation.pageCenterY) <= 1);
}

/** 無結束點的一般訊息沒有可換算的倒數，必須保持白色實心字。 */
async function verifyContinuousMessageIsStatic() {
  presentationService.startProgram({
    messages: [{ message: 'Nancy聯絡櫃台', alignment: 'left' }],
    pageDurationSeconds: 3,
    repeat: { mode: 'continuous' },
  });
  const revision = presentationService.getSnapshot().revision;
  await waitForRevision(revision);

  const inspection = await execute(`(() => {
    const page = document.getElementById('page-layer');
    const row = document.querySelector('.message-row');
    const liquidSvg = row.querySelector('.message-liquid-svg');
    const shell = row.querySelector('.message-glyph-shell');
    return {
      message: row.dataset.message,
      liquidEffect: row.dataset.liquidEffect,
      liquidDisplay: liquidSvg === null
        ? 'none'
        : getComputedStyle(liquidSvg).display,
      shellFillColor: getComputedStyle(shell)
        .getPropertyValue('-webkit-text-fill-color'),
      shellStrokeColor: getComputedStyle(shell)
        .getPropertyValue('-webkit-text-stroke-color'),
      liquidAnimationCount: page.getAnimations().filter((animation) =>
        animation.effect.getKeyframes().some((keyframe) =>
          Object.hasOwn(keyframe, '--message-liquid-level')
        )
      ).length,
      inlineLiquidLevel: page.style.getPropertyValue(
        '--message-liquid-level'
      ),
    };
  })()`);

  assert.deepEqual(inspection, {
    message: 'Nancy聯絡櫃台',
    liquidEffect: 'static',
    liquidDisplay: 'none',
    shellFillColor: 'rgb(255, 255, 255)',
    shellStrokeColor: 'rgb(255, 255, 255)',
    liquidAnimationCount: 0,
    inlineLiquidLevel: '',
  });
}

/** WAAPI 異常時不得留下透明字腔；Display 必須立即退回白色實心字。 */
async function verifyLiquidAnimationFailureFallback() {
  await execute(`(() => {
    const page = document.getElementById('page-layer');
    window.__displayCoreOriginalPageAnimate = page.animate;
    page.animate = () => {
      throw new Error('synthetic WAAPI failure');
    };
  })()`);

  try {
    presentationService.startProgram({
      messages: [{ message: '001聯絡櫃台', alignment: 'left' }],
      pageDurationSeconds: 3,
      repeat: { mode: 'finite', rounds: 1 },
    });
    const revision = presentationService.getSnapshot().revision;
    const inspection = await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        const page = document.getElementById('page-layer');
        const row = document.querySelector('.message-row');
        const liquidSvg = row?.querySelector('.message-liquid-svg');
        const shell = row?.querySelector('.message-glyph-shell');
        const vessel = row?.querySelector('.message-vessel');
        if (
          stage.dataset.revision !== '${revision}' ||
          row?.dataset.liquidEffect !== 'static'
        ) {
          return false;
        }
        return {
          liquidDisplay: liquidSvg === null
            ? 'none'
            : getComputedStyle(liquidSvg).display,
          liquidSvgCount: row?.querySelectorAll('.message-liquid-svg').length,
          shellFillColor: getComputedStyle(shell)
            .getPropertyValue('-webkit-text-fill-color'),
          shellStrokeColor: getComputedStyle(shell)
            .getPropertyValue('-webkit-text-stroke-color'),
          outsideBeforeContent: getComputedStyle(vessel, '::before').content,
          animationCount: page.getAnimations().length,
          inlineLiquidLevel: page.style.getPropertyValue(
            '--message-liquid-level'
          ),
        };
      })()`),
      'WAAPI 失敗時退回白色實心訊息',
    );

    assert.deepEqual(inspection, {
      liquidDisplay: 'none',
      liquidSvgCount: 0,
      shellFillColor: 'rgb(255, 255, 255)',
      shellStrokeColor: 'rgb(255, 255, 255)',
      outsideBeforeContent: 'none',
      animationCount: 0,
      inlineLiquidLevel: '',
    });

    const fallbackTimer = presentationService.timerHandle;
    assert.ok(
      fallbackTimer,
      'WAAPI 降級後仍須以 started 建立 finite 頁面 timer',
    );
    assert.equal(fallbackTimer.delay, 3_000);
    fallbackTimer.cleared = true;
    fallbackTimer.callback();
    assert.equal(presentationService.getSnapshot().mode, 'blank');
    assert.equal(presentationService.getSnapshot().revision, revision + 1);
  } finally {
    await execute(`(() => {
      const page = document.getElementById('page-layer');
      page.animate = window.__displayCoreOriginalPageAnimate;
      delete window.__displayCoreOriginalPageAnimate;
    })()`);
  }
}

async function setReducedMotionPreference(value) {
  await displayWindow.webContents.debugger.sendCommand(
    'Emulation.setEmulatedMedia',
    {
      features: [{
        name: 'prefers-reduced-motion',
        value,
      }],
    },
  );
  await waitFor(
    () => execute(
      `matchMedia('(prefers-reduced-motion: reduce)').matches === ` +
      `${value === 'reduce'}`,
    ),
    `prefers-reduced-motion = ${value}`,
  );
}

/** 降低動態時不得建立 SVG 流體，透明字腔必須安全恢復為白色實心字。 */
async function verifyLiquidReducedMotionFallback() {
  await setReducedMotionPreference('reduce');

  try {
    presentationService.startProgram({
      messages: [{ message: 'Nancy聯絡櫃台', alignment: 'left' }],
      pageDurationSeconds: 3,
      repeat: { mode: 'finite', rounds: 1 },
    });
    const revision = presentationService.getSnapshot().revision;
    await waitForRevision(revision);

    const inspection = await execute(`(() => {
      const page = document.getElementById('page-layer');
      const row = document.querySelector('.message-row');
      const vessel = row.querySelector('.message-vessel');
      const svg = vessel.querySelector('.message-liquid-svg');
      const shell = vessel.querySelector('.message-glyph-shell');
      return {
        liquidEffect: row.dataset.liquidEffect,
        svgCount: vessel.querySelectorAll('.message-liquid-svg').length,
        svgHidden: svg === null || getComputedStyle(svg).display === 'none',
        shellFillColor: getComputedStyle(shell)
          .getPropertyValue('-webkit-text-fill-color'),
        shellStrokeColor: getComputedStyle(shell)
          .getPropertyValue('-webkit-text-stroke-color'),
        outsideBeforeContent: getComputedStyle(vessel, '::before').content,
        animationCount: page.getAnimations().length,
        inlineLiquidLevel: page.style.getPropertyValue(
          '--message-liquid-level'
        ),
      };
    })()`);

    assert.deepEqual(inspection, {
      liquidEffect: 'static',
      svgCount: 0,
      svgHidden: true,
      shellFillColor: 'rgb(255, 255, 255)',
      shellStrokeColor: 'rgb(255, 255, 255)',
      outsideBeforeContent: 'none',
      animationCount: 0,
      inlineLiquidLevel: '',
    });
  } finally {
    presentationService.clearPresentation();
    await setReducedMotionPreference('no-preference');
  }
}

/**
 * 播放途中切換系統降低動態時，必須立即停止酒液時鐘並退回固定白字。
 * Main 已開始的頁面 timer 不屬於裝飾效果，不得因媒體偏好變更而重設；
 * 切回一般動態後也只允許下一個新頁重新建立酒液。
 */
async function verifyLiquidRuntimeReducedMotionFallback(timers) {
  await setReducedMotionPreference('no-preference');

  const inspectLiquidState = () => execute(`(() => {
    const page = document.getElementById('page-layer');
    const row = document.querySelector('.message-row');
    const vessel = row?.querySelector('.message-vessel');
    const svg = vessel?.querySelector('.message-liquid-svg');
    const shell = vessel?.querySelector('.message-glyph-shell');
    const liquidAnimationCount = page.getAnimations().filter((animation) =>
      animation.effect.getKeyframes().some((keyframe) =>
        Object.hasOwn(keyframe, '--message-liquid-level')
      )
    ).length;
    return {
      liquidEffect: row?.dataset.liquidEffect ?? null,
      svgCount: vessel?.querySelectorAll('.message-liquid-svg').length ?? 0,
      svgDisplay: svg === null || svg === undefined
        ? 'none'
        : getComputedStyle(svg).display,
      shellFillColor: shell
        ? getComputedStyle(shell).getPropertyValue('-webkit-text-fill-color')
        : null,
      shellStrokeColor: shell
        ? getComputedStyle(shell).getPropertyValue('-webkit-text-stroke-color')
        : null,
      liquidAnimationCount,
      inlineLiquidLevel: page.style.getPropertyValue(
        '--message-liquid-level'
      ),
    };
  })()`);

  try {
    presentationService.startProgram({
      messages: [{ message: 'Nancy聯絡櫃台', alignment: 'left' }],
      pageDurationSeconds: 3_600,
      repeat: { mode: 'finite', rounds: 1 },
    });
    const revision = presentationService.getSnapshot().revision;
    await waitForRevision(revision);

    const running = await waitFor(async () => {
      const state = await inspectLiquidState();
      return state.liquidEffect === 'active' &&
        state.svgCount === 1 &&
        state.svgDisplay === 'block' &&
        state.liquidAnimationCount === 1
        ? state
        : false;
    }, '播放中的訊息酒液');
    assert.equal(running.inlineLiquidLevel, '0%');

    // native SVG text 第一次使用內嵌 Didot 時可能完成一次 FontFaceSet loading；
    // 等該合法 refit 穩定後才量測媒體偏好切換本身是否碰觸 Main timer。
    await execute(`document.fonts.ready.then(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }))`);
    let stableTimer = null;
    let stableTimerSince = 0;
    await waitFor(async () => {
      const state = await inspectLiquidState();
      const candidate = presentationService.timerHandle;
      if (
        state.liquidEffect !== 'active' ||
        state.svgCount !== 1 ||
        state.liquidAnimationCount !== 1 ||
        !candidate ||
        candidate.cleared
      ) {
        stableTimer = null;
        stableTimerSince = 0;
        return false;
      }
      if (candidate !== stableTimer) {
        stableTimer = candidate;
        stableTimerSince = Date.now();
        return false;
      }
      return Date.now() - stableTimerSince >= 300 &&
        state.liquidEffect === 'active' &&
        state.svgCount === 1 &&
        state.liquidAnimationCount === 1;
    }, '內嵌字型完成後至少 300ms 不再 refit 的穩定酒液 layout');

    const pageTimer = stableTimer;
    const timerHandleCount = timers.handles.length;
    assert.ok(pageTimer, '播放開始後 Main 必須已有 started timer');
    assert.equal(pageTimer.cleared, false);
    assert.equal(pageTimer.delay, 3_600_000);

    await setReducedMotionPreference('reduce');
    const reduced = await waitFor(async () => {
      const state = await inspectLiquidState();
      return state.liquidEffect === 'static' &&
        state.svgCount === 0 &&
        state.liquidAnimationCount === 0 &&
        state.inlineLiquidLevel === ''
        ? state
        : false;
    }, '播放途中切換 reduce 後停止酒液並退回白字');

    assert.deepEqual(reduced, {
      liquidEffect: 'static',
      svgCount: 0,
      svgDisplay: 'none',
      shellFillColor: 'rgb(255, 255, 255)',
      shellStrokeColor: 'rgb(255, 255, 255)',
      liquidAnimationCount: 0,
      inlineLiquidLevel: '',
    });
    assert.equal(
      presentationService.timerHandle,
      pageTimer,
      '降低動態只取消 Renderer 裝飾，不得重設 Main started timer',
    );
    assert.equal(pageTimer.cleared, false);
    assert.equal(timers.handles.length, timerHandleCount);

    await setReducedMotionPreference('no-preference');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(
      await inspectLiquidState(),
      reduced,
      '切回 no-preference 不得在同一頁重新啟動酒液',
    );
    assert.equal(presentationService.timerHandle, pageTimer);
    assert.equal(pageTimer.cleared, false);
    assert.equal(timers.handles.length, timerHandleCount);

    presentationService.startProgram({
      messages: [{ message: '002請至前廳', alignment: 'left' }],
      pageDurationSeconds: 3_600,
      repeat: { mode: 'finite', rounds: 1 },
    });
    const nextRevision = presentationService.getSnapshot().revision;
    await waitForRevision(nextRevision);
    const nextPage = await waitFor(async () => {
      const state = await inspectLiquidState();
      return state.liquidEffect === 'active' &&
        state.svgCount === 1 &&
        state.svgDisplay === 'block' &&
        state.liquidAnimationCount === 1
        ? state
        : false;
    }, '切回 no-preference 後的新頁重新啟動酒液');
    assert.equal(nextPage.liquidEffect, 'active');
    assert.equal(pageTimer.cleared, true, '換頁才應取消上一頁 timer');
  } finally {
    presentationService.clearPresentation();
    await setReducedMotionPreference('no-preference');
  }
}

/**
 * 真實驗證管理員的訊息字體效果設定：關閉後立即清除 SVG／WAAPI 並顯示
 * 固定白字；重新開啟時不從頁面中途重播，下一個新頁才由 0% 啟動。
 */
async function verifyMessageLiquidSettingToggle() {
  const inspectLiquidState = () => execute(`(() => {
    const stage = document.getElementById('display-stage');
    const page = document.getElementById('page-layer');
    const row = document.querySelector('.message-row');
    const vessel = row?.querySelector('.message-vessel');
    const shell = vessel?.querySelector('.message-glyph-shell');
    return {
      settingsRevision: Number(stage.dataset.settingsRevision),
      fittedSettingsRevision: Number(stage.dataset.fittedSettingsRevision),
      effect: row?.dataset.liquidEffect ?? null,
      svgCount: vessel?.querySelectorAll('.message-liquid-svg').length ?? 0,
      animationCount: page.getAnimations().filter((animation) =>
        animation.effect.getKeyframes().some((keyframe) =>
          Object.hasOwn(keyframe, '--message-liquid-level')
        )
      ).length,
      inlineLiquidLevel: page.style.getPropertyValue(
        '--message-liquid-level'
      ),
      shellFillColor: shell
        ? getComputedStyle(shell).getPropertyValue('-webkit-text-fill-color')
        : null,
      shellStrokeColor: shell
        ? getComputedStyle(shell).getPropertyValue('-webkit-text-stroke-color')
        : null,
    };
  })()`);

  presentationService.startProgram({
    messages: [{ message: 'Nancy聯絡櫃台', alignment: 'left' }],
    pageDurationSeconds: 3_600,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const initialPresentationRevision = presentationService.getSnapshot().revision;
  await waitForRevision(initialPresentationRevision);
  const initial = await waitFor(async () => {
    const state = await inspectLiquidState();
    return state.effect === 'active' &&
      state.svgCount === 1 &&
      state.animationCount === 1
      ? state
      : false;
  }, '設定預設啟用訊息倒酒效果');
  assert.equal(initial.inlineLiquidLevel, '0%');

  const disabledConfig = structuredClone(settingsManager.getSnapshot().config);
  disabledConfig.appearance.messageLiquidEffectEnabled = false;
  const disabledSettingsRevision = settingsManager.publish(disabledConfig).revision;
  const disabled = await waitFor(async () => {
    const state = await inspectLiquidState();
    return state.settingsRevision === disabledSettingsRevision &&
      state.fittedSettingsRevision === disabledSettingsRevision &&
      state.effect === 'static' &&
      state.svgCount === 0 &&
      state.animationCount === 0 &&
      state.inlineLiquidLevel === ''
      ? state
      : false;
  }, '管理員關閉效果後立即停止酒液並退回白字');
  assert.equal(disabled.shellFillColor, 'rgb(255, 255, 255)');
  assert.equal(disabled.shellStrokeColor, 'rgb(255, 255, 255)');
  assert.equal(
    settingsManager.getSnapshot().config.appearance.messageLiquidEffectEnabled,
    false,
  );

  const enabledConfig = structuredClone(settingsManager.getSnapshot().config);
  enabledConfig.appearance.messageLiquidEffectEnabled = true;
  const enabledSettingsRevision = settingsManager.publish(enabledConfig).revision;
  const samePage = await waitFor(async () => {
    const state = await inspectLiquidState();
    return state.settingsRevision === enabledSettingsRevision &&
      state.fittedSettingsRevision === enabledSettingsRevision &&
      state.effect === 'static' &&
      state.svgCount === 0 &&
      state.animationCount === 0
      ? state
      : false;
  }, '重新啟用後不在同一頁中途重播酒液');
  assert.equal(samePage.inlineLiquidLevel, '');

  presentationService.startProgram({
    messages: [{ message: '002請至前廳', alignment: 'left' }],
    pageDurationSeconds: 3_600,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const nextPresentationRevision = presentationService.getSnapshot().revision;
  await waitForRevision(nextPresentationRevision);
  const nextPage = await waitFor(async () => {
    const state = await inspectLiquidState();
    return state.effect === 'active' &&
      state.svgCount === 1 &&
      state.animationCount === 1
      ? state
      : false;
  }, '重新啟用後的新頁由 0% 啟動酒液');
  assert.equal(nextPage.inlineLiquidLevel, '0%');
  presentationService.clearPresentation();
}

/**
 * 真實驗證待機風吹沙設定：輪播轉場進行中關閉效果時，動畫與兩個大型
 * Canvas 必須立即釋放；下一次換圖仍要發生，但整段不得短暫重啟沙塵。
 */
async function verifyStandbySandEffectToggle(
  expectedStandbyBackgroundUrls,
  delayedSecondBackgroundRead,
) {
  const [firstStandbyBackgroundUrl, secondStandbyBackgroundUrl] =
    expectedStandbyBackgroundUrls;

  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const image = [...document.querySelectorAll('.standby-background-image')]
        .find((candidate) => !candidate.hidden);
      return stage.dataset.mode === 'blank' &&
        stage.dataset.settingsRevision === '0' &&
        image?.complete && image.naturalWidth > 0 &&
        image.getAttribute('src') === '${firstStandbyBackgroundUrl}';
    })()`),
    '待機風吹沙設定 QA 載入第一張背景',
  );
  assert.equal(
    settingsManager.getSnapshot().config.standby.sandEffectEnabled,
    true,
  );

  await waitFor(
    () => Promise.resolve(delayedSecondBackgroundRead.hasStarted()),
    '待機風吹沙設定 QA 開始載入第二張背景',
  );
  delayedSecondBackgroundRead.release();

  const enabledTransition = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const sand = document.getElementById('standby-sand-transition');
      const particles = document.getElementById('standby-sand-particles');
      const image = [...document.querySelectorAll('.standby-background-image')]
        .find((candidate) => !candidate.hidden);
      return stage.dataset.standbyTransition === 'sand' &&
        image?.getAttribute('src') === '${secondStandbyBackgroundUrl}' &&
        !sand.hidden && !particles.hidden &&
        sand.width > 1 && sand.height > 1 &&
        particles.width > 1 && particles.height > 1
        ? {
            transition: stage.dataset.standbyTransition,
            source: image.getAttribute('src'),
            sand: [sand.width, sand.height],
            particles: [particles.width, particles.height],
          }
        : false;
    })()`),
    '啟用設定時第二張背景進入風吹沙轉場',
  );
  assert.equal(enabledTransition.transition, 'sand');
  assert.equal(enabledTransition.source, secondStandbyBackgroundUrl);

  const disabledConfig = structuredClone(settingsManager.getSnapshot().config);
  disabledConfig.standby.sandEffectEnabled = false;
  const disabledAt = Date.now();
  const disabledSettingsRevision = settingsManager.publish(
    disabledConfig,
  ).revision;
  const released = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const sand = document.getElementById('standby-sand-transition');
      const particles = document.getElementById('standby-sand-particles');
      const image = [...document.querySelectorAll('.standby-background-image')]
        .find((candidate) => !candidate.hidden);
      return stage.dataset.settingsRevision === '${disabledSettingsRevision}' &&
        stage.dataset.standbyTransition === undefined &&
        stage.dataset.sandPreparation === undefined &&
        sand.hidden && particles.hidden &&
        sand.width === 1 && sand.height === 1 &&
        particles.width === 1 && particles.height === 1 &&
        image?.complete && image.naturalWidth > 0
        ? {
            source: image.getAttribute('src'),
            sand: [sand.width, sand.height],
            particles: [particles.width, particles.height],
          }
        : false;
    })()`),
    '關閉待機特效後立即停止轉場並釋放 Canvas',
  );
  assert.ok(
    Date.now() - disabledAt < 1_000,
    '關閉效果必須立即停止，不能等待 2.8 秒沙塵轉場自然結束',
  );
  assert.deepEqual(released.sand, [1, 1]);
  assert.deepEqual(released.particles, [1, 1]);
  assert.equal(
    settingsManager.getSnapshot().config.standby.sandEffectEnabled,
    false,
  );

  /*
   * 除了等待最終 DOM，還監看整段換圖過程。若實作曾短暫加回 sand dataset
   * 或重新放大／顯示 Canvas，即使下一次輪詢時已消失也會被記錄為失敗。
   */
  await execute(`(() => {
    const stage = document.getElementById('display-stage');
    const sand = document.getElementById('standby-sand-transition');
    const particles = document.getElementById('standby-sand-particles');
    const images = [...document.querySelectorAll('.standby-background-image')];
    const trace = {
      sawSandTransition: false,
      sawVisibleOrExpandedCanvas: false,
      observer: null,
      interval: null,
    };
    const sample = () => {
      trace.sawSandTransition ||= stage.dataset.standbyTransition === 'sand';
      trace.sawVisibleOrExpandedCanvas ||=
        !sand.hidden || !particles.hidden ||
        sand.width > 1 || sand.height > 1 ||
        particles.width > 1 || particles.height > 1;
    };
    trace.observer = new MutationObserver(sample);
    trace.observer.observe(stage, {
      attributes: true,
      attributeFilter: ['data-standby-transition'],
    });
    for (const canvas of [sand, particles]) {
      trace.observer.observe(canvas, {
        attributes: true,
        attributeFilter: ['hidden', 'width', 'height'],
      });
    }
    for (const image of images) {
      trace.observer.observe(image, {
        attributes: true,
        attributeFilter: ['hidden', 'src'],
      });
    }
    trace.interval = setInterval(sample, 16);
    sample();
    globalThis.__displayCoreStandbyEffectQaTrace = trace;
  })()`);

  const nextDirectSlide = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const sand = document.getElementById('standby-sand-transition');
      const particles = document.getElementById('standby-sand-particles');
      const image = [...document.querySelectorAll('.standby-background-image')]
        .find((candidate) => !candidate.hidden);
      return stage.dataset.settingsRevision === '${disabledSettingsRevision}' &&
        image?.complete && image.naturalWidth > 0 &&
        image.getAttribute('src') !== '${released.source}' &&
        stage.dataset.standbyTransition === undefined &&
        sand.hidden && particles.hidden &&
        sand.width === 1 && sand.height === 1 &&
        particles.width === 1 && particles.height === 1
        ? {
            source: image.getAttribute('src'),
            sawSandTransition:
              globalThis.__displayCoreStandbyEffectQaTrace
                ?.sawSandTransition ?? true,
            sawVisibleOrExpandedCanvas:
              globalThis.__displayCoreStandbyEffectQaTrace
                ?.sawVisibleOrExpandedCanvas ?? true,
          }
        : false;
    })()`),
    '關閉風吹沙後輪播仍直接切到另一張背景',
  );
  const finalTrace = await execute(`(() => {
    const trace = globalThis.__displayCoreStandbyEffectQaTrace;
    clearInterval(trace?.interval);
    trace?.observer?.disconnect();
    const result = {
      sawSandTransition: trace?.sawSandTransition ?? true,
      sawVisibleOrExpandedCanvas:
        trace?.sawVisibleOrExpandedCanvas ?? true,
    };
    delete globalThis.__displayCoreStandbyEffectQaTrace;
    return result;
  })()`);

  assert.ok(
    [firstStandbyBackgroundUrl, secondStandbyBackgroundUrl].includes(
      nextDirectSlide.source,
    ),
    '關閉效果後仍須輪播設定中的背景',
  );
  assert.equal(nextDirectSlide.sawSandTransition, false);
  assert.equal(nextDirectSlide.sawVisibleOrExpandedCanvas, false);
  assert.deepEqual(finalTrace, {
    sawSandTransition: false,
    sawVisibleOrExpandedCanvas: false,
  });
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
        clockElement.hidden || !/^\\d{2}:\\d{2}$/.test(clockElement.textContent)
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

  const independentClockConfig = structuredClone(
    settingsManager.getSnapshot().config,
  );
  independentClockConfig.appearance.fontSizePercent = 50;
  independentClockConfig.appearance.standbyClockSizePercent = 100;
  const independentClockRevision = settingsManager.publish(
    independentClockConfig,
  ).revision;
  const independentClockSize = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      if (stage.dataset.settingsRevision !== '${independentClockRevision}') {
        return false;
      }
      return Number.parseFloat(
        getComputedStyle(document.getElementById('display-clock')).fontSize
      );
    })()`),
    '待機時間不受一般訊息字級影響',
  );
  assert.ok(
    Math.abs(independentClockSize - standbyClock.fontSize) <= 0.5,
    '一般訊息字級不得連動待機時間',
  );

  const enlargedClockConfig = structuredClone(
    settingsManager.getSnapshot().config,
  );
  enlargedClockConfig.appearance.standbyClockSizePercent = 150;
  const enlargedClockRevision = settingsManager.publish(
    enlargedClockConfig,
  ).revision;
  const enlargedClockSize = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      if (stage.dataset.settingsRevision !== '${enlargedClockRevision}') {
        return false;
      }
      return Number.parseFloat(
        getComputedStyle(document.getElementById('display-clock')).fontSize
      );
    })()`),
    '放大待機時間',
  );
  assert.ok(
    enlargedClockSize >= standbyClock.fontSize * 1.4,
    '待機時間大小設定必須獨立生效',
  );

  // 設定頁允許 50%～300%；每個代表性級距都必須真的放大，且不能溢出畫布。
  const standbyClockMeasurements = [];
  for (const percentage of [50, 100, 150, 200, 250, 300]) {
    const rangeConfig = structuredClone(settingsManager.getSnapshot().config);
    rangeConfig.appearance.standbyClockSizePercent = percentage;
    const rangeRevision = settingsManager.publish(rangeConfig).revision;
    const measurement = await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        if (stage.dataset.settingsRevision !== '${rangeRevision}') {
          return false;
        }
        const stageBounds = stage.getBoundingClientRect();
        const clockElement = document.getElementById('display-clock');
        const clockBounds = clockElement.getBoundingClientRect();
        return {
          percentage: ${percentage},
          fontSize: Number.parseFloat(getComputedStyle(clockElement).fontSize),
          fitsInline:
            clockBounds.left >= stageBounds.left - 0.5 &&
            clockBounds.right <= stageBounds.right + 0.5,
        };
      })()`),
      `待機時間 ${percentage}% 實際字級`,
    );
    standbyClockMeasurements.push(measurement);
  }

  for (let index = 1; index < standbyClockMeasurements.length; index += 1) {
    assert.ok(
      standbyClockMeasurements[index].fontSize >
        standbyClockMeasurements[index - 1].fontSize * 1.1,
      `待機時間級距未持續放大：${JSON.stringify(standbyClockMeasurements)}`,
    );
  }
  assert.equal(
    standbyClockMeasurements.every(({ fitsInline }) => fitsInline),
    true,
    `待機時間不得超出畫布：${JSON.stringify(standbyClockMeasurements)}`,
  );

  const resetClockConfig = structuredClone(settingsManager.getSnapshot().config);
  resetClockConfig.appearance.standbyClockSizePercent = 100;
  const resetClockRevision = settingsManager.publish(resetClockConfig).revision;
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.settingsRevision === ` +
      `'${resetClockRevision}'`,
    ),
    '還原待機時間大小',
  );
}

/** 驗證五種訊息背景、離線典雅宋體與材質只作用於一般訊息頁。 */
async function verifyLuxuryMessageAppearance() {
  presentationService.startProgram({
    messages: [
      { message: 'Nancy請至前廳', alignment: 'left' },
      { message: '007請至櫃台', alignment: 'left' },
      { message: 'Alexandra聯絡櫃台', alignment: 'left' },
    ],
    pageDurationSeconds: 3_600,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const pageRevision = presentationService.getSnapshot().revision;
  await waitForRevision(pageRevision);

  const presets = [
    'solid',
    'obsidian',
    'dark-marble',
    'walnut',
    'emerald-onyx',
  ];
  const materialAssetFileNames = Object.freeze({
    obsidian: 'obsidian.jpg',
    'dark-marble': 'dark-marble.jpg',
    walnut: 'walnut.jpg',
    'emerald-onyx': 'emerald-onyx.jpg',
  });
  const materialStatistics = new Map();
  let previousBackgroundStatistics = null;

  for (const preset of presets) {
    const config = structuredClone(settingsManager.getSnapshot().config);
    config.logo.enabled = false;
    config.dateTime.enabled = false;
    config.appearance.backgroundColor = '#102030';
    config.appearance.fontColor = '#F4F0E7';
    config.appearance.fontFamily =
      '"DisplayCore Source Han Serif TC", "Noto Serif TC", serif';
    config.appearance.fontSizePercent = 100;
    config.appearance.messageBackgroundPreset = preset;
    const settingsRevision = settingsManager.publish(config).revision;

    const appearance = await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        if (
          stage.dataset.mode !== 'page' ||
          stage.dataset.settingsRevision !== '${settingsRevision}' ||
          stage.dataset.messageBackground !== '${preset}' ||
          stage.dataset.messageBackgroundState !== 'ready'
        ) {
          return false;
        }
        const style = getComputedStyle(stage);
        const overlay = getComputedStyle(stage, '::after');
        return {
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          overlayContent: overlay.content,
          fontColor: style.color,
          fontFamily: getComputedStyle(
            document.querySelector('.message-row')
          ).fontFamily,
        };
      })()`),
      `訊息背景 ${preset}`,
    );

    assert.equal(appearance.fontColor, 'rgb(244, 240, 231)');
    assert.match(appearance.fontFamily, /DisplayCore Source Han Serif TC/);
    assert.equal(
      await waitFor(
        () => execute(
          `document.fonts.check(` +
          `'600 32px "DisplayCore Source Han Serif TC"', '高級會所')`,
        ),
        '內嵌繁體中文字型完成載入',
      ),
      true,
    );
    if (preset === 'solid') {
      const previousLayoutGeneration = await execute(
        `Number(document.getElementById('display-stage')` +
        `.dataset.layoutGeneration)`,
      );
      await execute(`document.fonts.dispatchEvent(new Event('loadingdone'))`);
      const fontRefit = await waitFor(
        () => execute(`(() => {
          const stage = document.getElementById('display-stage');
          const layoutGeneration = Number(stage.dataset.layoutGeneration);
          if (
            stage.dataset.fittedSettingsRevision !== '${settingsRevision}' ||
            layoutGeneration <= ${previousLayoutGeneration}
          ) {
            return false;
          }
          return {
            layoutGeneration,
            rowsProtected: [...document.querySelectorAll('.message-row')]
              .every((row) => {
                const text = row.querySelector('.message-text');
                return !text || text.getBoundingClientRect().width <=
                  row.getBoundingClientRect().width + 0.5;
              }),
          };
        })()`),
        '內嵌字型載入完成後重新量測訊息',
      );
      assert.equal(fontRefit.rowsProtected, true);
    }
    if (preset === 'solid') {
      assert.equal(appearance.backgroundColor, 'rgb(16, 32, 48)');
      assert.equal(appearance.backgroundImage, 'none');
      assert.equal(appearance.overlayContent, 'none');
      previousBackgroundStatistics =
        await captureMessageBackgroundStatistics(previousBackgroundStatistics);
    } else {
      assert.equal(
        appearance.backgroundImage,
        `url("displaycore://app/assets/message-backgrounds/` +
        `${materialAssetFileNames[preset]}")`,
      );
      assert.doesNotMatch(appearance.backgroundImage, /gradient/);
      assert.notEqual(appearance.overlayContent, 'none');
      const statistics = await captureMessageBackgroundStatistics(
        previousBackgroundStatistics,
      );
      previousBackgroundStatistics = statistics;
      materialStatistics.set(preset, statistics);
      assert.ok(
        statistics.averageLuma >= 55,
        `${preset} 材質過暗：${JSON.stringify(statistics)}`,
      );
      assert.ok(
        statistics.averageLuma <= 92,
        `${preset} 材質不得亮成高彩度色塊：${JSON.stringify(statistics)}`,
      );
      assert.ok(
        statistics.lumaDeviation >= 4,
        `${preset} 缺少肉眼可辨識紋理：${JSON.stringify(statistics)}`,
      );
      assert.ok(
        statistics.lumaP95 <= 145 && statistics.lumaP99 <= 190,
        `${preset} 材質亮區會干擾任意位置文字：${JSON.stringify(statistics)}`,
      );
    }

    await captureVisualQa(`message-${preset}.png`);
  }

  const materialEntries = [...materialStatistics.entries()];
  for (let firstIndex = 0; firstIndex < materialEntries.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < materialEntries.length;
      secondIndex += 1
    ) {
      const [firstName, first] = materialEntries[firstIndex];
      const [secondName, second] = materialEntries[secondIndex];
      const firstMean = first.spatialLuma.reduce(
        (total, value) => total + value,
        0,
      ) / first.spatialLuma.length;
      const secondMean = second.spatialLuma.reduce(
        (total, value) => total + value,
        0,
      ) / second.spatialLuma.length;
      const firstCentered = first.spatialLuma.map((value) => value - firstMean);
      const secondCentered = second.spatialLuma.map(
        (value) => value - secondMean,
      );
      const firstScale = Math.sqrt(
        firstCentered.reduce((total, value) => total + (value ** 2), 0) /
          firstCentered.length,
      );
      const secondScale = Math.sqrt(
        secondCentered.reduce((total, value) => total + (value ** 2), 0) /
          secondCentered.length,
      );
      const textureDistance = Math.sqrt(
        firstCentered.reduce((total, value, index) =>
          total + ((
            (value / firstScale) - (secondCentered[index] / secondScale)
          ) ** 2), 0,
        ) / firstCentered.length,
      );
      assert.ok(
        textureDistance >= 0.35,
        `${firstName} 與 ${secondName} 空間紋理過於相似：${JSON.stringify({
          textureDistance,
          first,
          second,
        })}`,
      );
    }
  }

  // contain 邏輯解析度會產生上下邊帶；材質模式不得露出舊的純色（例如藍色）。
  const letterboxConfig = structuredClone(settingsManager.getSnapshot().config);
  letterboxConfig.appearance.messageBackgroundPreset = 'emerald-onyx';
  letterboxConfig.appearance.backgroundColor = '#102030';
  letterboxConfig.display.renderResolution = '1920x1080';
  const letterboxSettingsRevision = settingsManager.publish(
    letterboxConfig,
  ).revision;
  displayWindow.setContentSize(1600, 1000, false);
  const materialLetterbox = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const surface = document.getElementById('display-render-surface')
        .getBoundingClientRect();
      if (
        stage.dataset.settingsRevision !== '${letterboxSettingsRevision}' ||
        stage.dataset.mode !== 'page' ||
        stage.dataset.messageBackground !== 'emerald-onyx' ||
        window.innerWidth !== 1600 || window.innerHeight !== 1000 ||
        surface.top <= 1
      ) {
        return false;
      }
      return {
        viewportBackground: getComputedStyle(document.body).backgroundColor,
        surfaceTop: surface.top,
      };
    })()`),
    '材質訊息的非 16:9 邊帶背景',
  );
  assert.equal(materialLetterbox.viewportBackground, 'rgb(15, 48, 38)');
  assert.ok(materialLetterbox.surfaceTop > 1);

  presentationService.clearPresentation();
  const blankRevision = presentationService.getSnapshot().revision;
  await waitForRevision(blankRevision, false);
  assert.equal(
    await execute(`(() => {
      const stage = document.getElementById('display-stage');
      return stage.dataset.mode === 'blank' &&
        getComputedStyle(stage).backgroundImage === 'none' &&
        getComputedStyle(stage, '::after').content === 'none';
    })()`),
    true,
    '訊息材質不得污染待機背景',
  );
}

/**
 * 在指定進度區間擷取真實 Canvas alpha 分佈與圖片幾何。
 * 使用區間 waitFor 避免依賴單一毫秒時點，降低不同機器幀率差異。
 */
async function captureSandFrame({
  minimumProgress,
  maximumProgress,
  minimumRightTailMassRatio = 0,
  expectedVisibleSource,
  description,
}) {
  return waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const progress = Number(stage.dataset.sandProgress);
      const layerElement = document.getElementById('standby-background-layer');
      const layer = layerElement.getBoundingClientRect();
      const canvas = document.getElementById('standby-sand-transition');
      const canvasBox = canvas.getBoundingClientRect();
      const particleCanvas = document.getElementById('standby-sand-particles');
      const particleCanvasBox = particleCanvas.getBoundingClientRect();
      const images = [...document.querySelectorAll('.standby-background-image')];
      const visibleImage = images.find((image) => !image.hidden);

      if (
        stage.dataset.mode !== 'blank' ||
        stage.dataset.standbyTransition !== 'sand' ||
        progress < ${minimumProgress} || progress > ${maximumProgress} ||
        canvas.hidden || canvas.width <= 1 || canvas.height <= 1 ||
        particleCanvas.hidden ||
        particleCanvas.width <= 1 || particleCanvas.height <= 1 ||
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
      // 粒子已改由單次 putImageData 寫入獨立 Canvas；直接量測最後輸出像素，
      // 避免測試綁死 drawImage 等內部實作，也確保數據與肉眼截圖完全一致。
      const particleContext = particleCanvas.getContext('2d');
      const particlePixels = particleContext.getImageData(
        0,
        0,
        particleCanvas.width,
        particleCanvas.height,
      ).data;
      const particleHorizontalMass = new Array(5).fill(0);
      let maximumAlpha = 0;
      let visiblePixelCount = 0;
      let totalParticleMass = 0;
      let weightedX = 0;
      let weightedY = 0;
      let weightedY2 = 0;
      let longestHorizontalRun = 0;
      for (let y = 0; y < particleCanvas.height; y += 1) {
        let horizontalRun = 0;
        for (let x = 0; x < particleCanvas.width; x += 1) {
          const alpha = particlePixels[(y * particleCanvas.width + x) * 4 + 3];
          maximumAlpha = Math.max(maximumAlpha, alpha);
          if (alpha < 8) {
            horizontalRun = 0;
            continue;
          }

          horizontalRun += 1;
          longestHorizontalRun = Math.max(longestHorizontalRun, horizontalRun);
          visiblePixelCount += 1;
          totalParticleMass += alpha;
          weightedX += (x + 0.5) * alpha;
          weightedY += (y + 0.5) * alpha;
          weightedY2 += (y + 0.5) ** 2 * alpha;
          const bucket = Math.min(
            particleHorizontalMass.length - 1,
            Math.floor((x + 0.5) / particleCanvas.width *
              particleHorizontalMass.length),
          );
          particleHorizontalMass[bucket] += alpha;
        }
      }
      const destinationCenterX = totalParticleMass <= 0
        ? 0
        : weightedX / totalParticleMass;
      const destinationCenterY = totalParticleMass <= 0
        ? 0
        : weightedY / totalParticleMass;
      const rightTailMassRatio = totalParticleMass <= 0
        ? 0
        : particleHorizontalMass[4] / totalParticleMass;
      if (
        ${minimumRightTailMassRatio} > 0 &&
        rightTailMassRatio <= ${minimumRightTailMassRatio}
      ) {
        return false;
      }
      let strongParticleMass = 0;
      let strongWeightedX = 0;
      let strongWeightedY = 0;
      const strongAlphaThreshold = Math.max(8, maximumAlpha * 0.55);
      for (let y = 0; y < particleCanvas.height; y += 1) {
        for (let x = 0; x < particleCanvas.width; x += 1) {
          const alpha = particlePixels[(y * particleCanvas.width + x) * 4 + 3];
          if (alpha < strongAlphaThreshold) {
            continue;
          }
          strongParticleMass += alpha;
          strongWeightedX += (x + 0.5) * alpha;
          strongWeightedY += (y + 0.5) * alpha;
        }
      }
      const totalCanvasPixels = particleCanvas.width * particleCanvas.height;
      const verticalVariance = totalParticleMass <= 0
        ? 0
        : weightedY2 / totalParticleMass - destinationCenterY ** 2;
      const surfaceCandidates = Array.from({ length: 31 }, (_, index) => {
        const centerY = 0.04 + index / 30 * 0.92;
        const region = sampleRegion(
          0.04,
          0.96,
          Math.max(0.005, centerY - 0.018),
          Math.min(0.995, centerY + 0.018),
          48,
          4,
        );
        const erodedRatio = region.transparentRatio + region.partial /
          (region.transparent + region.partial + region.opaque) * 0.5;
        return { centerY, region, distance: Math.abs(erodedRatio - 0.5) };
      });
      const activeSurfaceCandidate = surfaceCandidates.reduce(
        (closest, candidate) =>
          candidate.distance < closest.distance ? candidate : closest,
      );
      const surfaceCenterY = activeSurfaceCandidate.centerY;
      const surfaceMinimumY = Math.max(0.005, surfaceCenterY - 0.04);
      const surfaceMaximumY = Math.min(0.995, surfaceCenterY + 0.04);
      const toBox = (box) => ({
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      });
      const layerStyle = getComputedStyle(layerElement);
      const coversLayer = (box) =>
        Math.abs(box.left - layer.left) <= 0.5 &&
        Math.abs(box.top - layer.top) <= 0.5 &&
        Math.abs(box.width - layer.width) <= 0.5 &&
        Math.abs(box.height - layer.height) <= 0.5;

      return {
        progress,
        transition: stage.dataset.standbyTransition,
        canvasCoversLayer: coversLayer(canvasBox),
        particleCanvasCoversLayer: coversLayer(particleCanvasBox),
        visibleSource: visibleImage.getAttribute('src'),
        visibleImageCoversLayer: coversLayer(visibleBox),
        layerBox: toBox(layer),
        canvasBox: toBox(canvasBox),
        visibleImageBox: toBox(visibleBox),
        layerMotion: {
          transform: layerStyle.transform,
          translate: layerStyle.translate || 'none',
          animationName: layerStyle.animationName,
        },
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
          canvasWidth: particleCanvas.width,
          canvasHeight: particleCanvas.height,
          visiblePixelCount,
          visiblePixelCoverage: visiblePixelCount / totalCanvasPixels,
          horizontalMass: particleHorizontalMass,
          strongestBucket: particleHorizontalMass.indexOf(
            Math.max(...particleHorizontalMass),
          ),
          strongCenterX: strongParticleMass <= 0
            ? 0
            : strongWeightedX / strongParticleMass / particleCanvas.width,
          strongCenterY: strongParticleMass <= 0
            ? 0
            : strongWeightedY / strongParticleMass / particleCanvas.height,
          destinationCenterX: destinationCenterX / particleCanvas.width,
          destinationCenterY: destinationCenterY / particleCanvas.height,
          alphaCoverage:
            totalParticleMass / (255 * totalCanvasPixels),
          rightTailMassRatio,
          destinationVerticalSpread:
            Math.sqrt(Math.max(0, verticalVariance)) / particleCanvas.height,
          longestHorizontalRunRatio:
            longestHorizontalRun / particleCanvas.width,
        },
        activeSurface: {
          centerY: surfaceCenterY,
          left: sampleRegion(
            0.04,
            0.28,
            surfaceMinimumY,
            surfaceMaximumY,
            18,
            10,
          ),
          center: sampleRegion(
            0.42,
            0.66,
            surfaceMinimumY,
            surfaceMaximumY,
            18,
            10,
          ),
          right: sampleRegion(
            0.72,
            0.96,
            surfaceMinimumY,
            surfaceMaximumY,
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

function assertImagesRemainStationary(imageMotion, description) {
  assert.equal(imageMotion.length, 2, `${description} 雙緩衝圖片`);
  for (const image of imageMotion) {
    assert.equal(image.transform, 'none', `${description} image transform`);
    assert.equal(image.translate, 'none', `${description} image translate`);
    assert.equal(image.animationName, 'none', `${description} image animation`);
  }
}

function assertBoxUnchanged(reference, current, description) {
  for (const property of ['left', 'top', 'width', 'height']) {
    assert.ok(
      Math.abs(current[property] - reference[property]) <= 0.5,
      `${description} ${property} 不得改變：${JSON.stringify({
        reference,
        current,
      })}`,
    );
  }
}

/** 背景父層與圖片在整段轉場都必須原地不動，避免任何隱性 slide／wipe。 */
function assertSandGeometryStationary(reference, frame, description) {
  assert.equal(frame.layerMotion.transform, 'none', `${description} layer transform`);
  assert.equal(frame.layerMotion.translate, 'none', `${description} layer translate`);
  assert.equal(
    frame.layerMotion.animationName,
    'none',
    `${description} layer animation`,
  );
  assertBoxUnchanged(reference.layerBox, frame.layerBox, `${description} 背景層`);
  assertBoxUnchanged(
    reference.visibleImageBox,
    frame.visibleImageBox,
    `${description} 背景圖片`,
  );
}

function srgbChannelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function resolveHue(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;

  if (delta === 0) {
    return null;
  }

  let hue;
  if (maximum === red) {
    hue = 60 * (((green - blue) / delta) % 6);
  } else if (maximum === green) {
    hue = 60 * (((blue - red) / delta) + 2);
  } else {
    hue = 60 * (((red - green) / delta) + 4);
  }

  return hue < 0 ? hue + 360 : hue;
}

/** 從真實 Electron compositor 量測材質，不把九個白色數字誤算成背景。 */
async function captureEmergencyMaterialStatistics(tone) {
  await execute(`(() => {
    for (const cell of document.querySelectorAll('.fill-cell')) {
      cell.style.setProperty('color', 'transparent', 'important');
      cell.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      cell.style.setProperty('text-shadow', 'none', 'important');
      cell.style.setProperty('box-shadow', 'none', 'important');
    }
  })()`);
  await execute(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);

  let image;
  try {
    image = await displayWindow.webContents.capturePage();
    const visualQaDirectory =
      process.env.DISPLAYCORE_VISUAL_QA_DIRECTORY?.trim();
    if (visualQaDirectory) {
      await fileSystem.mkdir(visualQaDirectory, { recursive: true });
      await fileSystem.writeFile(
        path.join(visualQaDirectory, `emergency-${tone}-background-only.png`),
        image.toPNG(),
      );
    }
  } finally {
    await execute(`(() => {
      for (const cell of document.querySelectorAll('.fill-cell')) {
        cell.removeAttribute('style');
      }
    })()`);
  }

  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  assert.equal(
    bitmap.length,
    width * height * 4,
    'Electron bitmap 尺寸必須與 compositor 截圖一致',
  );
  const step = Math.max(4, Math.floor(Math.min(width, height) / 360));
  const lumas = [];
  const relativeLuminances = [];
  const colorBins = new Map();
  let sampledPixelCount = 0;
  let chromaticPixelCount = 0;
  let redPixelCount = 0;
  let greenPixelCount = 0;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = ((y * width) + x) * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
      const hue = resolveHue(red, green, blue);
      const luma = (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
      const relativeLuminance =
        (srgbChannelToLinear(red) * 0.2126) +
        (srgbChannelToLinear(green) * 0.7152) +
        (srgbChannelToLinear(blue) * 0.0722);
      // 每色版 5 bits 可保留木纖維／晶體的細微層次，純色仍只會落在單一 bin。
      const colorBin = `${red >> 3}:${green >> 3}:${blue >> 3}`;

      sampledPixelCount += 1;
      redTotal += red;
      greenTotal += green;
      blueTotal += blue;
      lumas.push(luma);
      colorBins.set(colorBin, (colorBins.get(colorBin) ?? 0) + 1);

      if (saturation >= 0.3 && hue !== null) {
        chromaticPixelCount += 1;
        // 白字與格線不是材質；對比只取紅／綠材質本身的最亮 1%。
        relativeLuminances.push(relativeLuminance);
        if (hue >= 345 || hue <= 30) {
          redPixelCount += 1;
        }
        if (hue >= 100 && hue <= 175) {
          greenPixelCount += 1;
        }
      }
    }
  }

  lumas.sort((first, second) => first - second);
  relativeLuminances.sort((first, second) => first - second);
  const percentile = (values, ratio) =>
    values[Math.floor((values.length - 1) * ratio)];
  let entropy = 0;
  for (const count of colorBins.values()) {
    const probability = count / sampledPixelCount;
    entropy -= probability * Math.log2(probability);
  }

  const relativeLuminanceP99 = percentile(relativeLuminances, 0.99);
  return Object.freeze({
    width,
    height,
    averageRed: redTotal / sampledPixelCount,
    averageGreen: greenTotal / sampledPixelCount,
    averageBlue: blueTotal / sampledPixelCount,
    redHueRatio: redPixelCount / Math.max(1, chromaticPixelCount),
    greenHueRatio: greenPixelCount / Math.max(1, chromaticPixelCount),
    chromaticRatio: chromaticPixelCount / sampledPixelCount,
    lumaP5: percentile(lumas, 0.05),
    lumaP95: percentile(lumas, 0.95),
    lumaRange: percentile(lumas, 0.95) - percentile(lumas, 0.05),
    colorEntropy: entropy,
    whiteContrastAtP99: 1.05 / (relativeLuminanceP99 + 0.05),
  });
}

async function inspectEmergencyMaterial(tone, expectedFileName) {
  const expectedPositions = [
    '0% 0%', '50% 0%', '100% 0%',
    '0% 50%', '50% 50%', '100% 50%',
    '0% 100%', '50% 100%', '100% 100%',
  ];
  const dom = await execute(`(() => {
    const stage = document.getElementById('display-stage');
    const cells = [...document.querySelectorAll('.fill-cell')];
    return {
      mode: stage.dataset.mode,
      tone: stage.dataset.emergencyTone,
      viewport: [window.innerWidth, window.innerHeight],
      renderResolution: stage.dataset.renderResolution,
      cellCount: cells.length,
      clockHidden: document.getElementById('display-clock').hidden,
      liquidCount: document.querySelectorAll('.message-liquid-canvas').length,
      animationCount: cells.reduce(
        (total, cell) => total + cell.getAnimations().length,
        0,
      ),
      cells: cells.map((cell) => {
        const style = getComputedStyle(cell);
        return {
          image: style.backgroundImage,
          size: style.backgroundSize,
          position: style.backgroundPosition,
          color: style.color,
          fillColor: style.getPropertyValue('-webkit-text-fill-color'),
        };
      }),
    };
  })()`);

  assert.equal(dom.mode, 'emergency');
  assert.equal(dom.tone, tone);
  assert.deepEqual(dom.viewport, [1920, 1080]);
  assert.equal(dom.renderResolution, '3840x2160');
  assert.equal(dom.cellCount, 9);
  assert.equal(dom.clockHidden, true);
  assert.equal(dom.liquidCount, 0);
  assert.equal(dom.animationCount, 0);

  dom.cells.forEach((cell, index) => {
    assert.match(cell.image, new RegExp(expectedFileName.replaceAll('.', '\\.')));
    assert.doesNotMatch(cell.image, /https?:|data:/i);
    assert.equal(cell.size, '100% 100%, 300% 300%');
    assert.equal(cell.position, `50% 50%, ${expectedPositions[index]}`);
    assert.equal(cell.color, 'rgb(255, 255, 255)');
    assert.equal(cell.fillColor, 'rgb(255, 255, 255)');
  });

  return waitFor(async () => {
    const statistics = await captureEmergencyMaterialStatistics(tone);
    const toneDelivered = tone === 'inspection'
      ? statistics.redHueRatio >= 0.75 &&
        statistics.averageRed >= statistics.averageGreen * 1.25
      : statistics.greenHueRatio >= 0.75 &&
        statistics.averageGreen >= statistics.averageRed * 1.25 &&
        statistics.averageGreen >= statistics.averageBlue * 1.1;
    return (
      toneDelivered &&
      statistics.lumaRange >= 16 &&
      statistics.colorEntropy >= 3.5
    )
      ? statistics
      : false;
  }, `${tone} 材質已交付至 Electron compositor`, 8_000);
}

async function verifyEmergencyLetterboxColor(tone) {
  displayWindow.setContentSize(1600, 1000, false);
  await waitFor(
    () => execute(`window.innerWidth === 1600 && window.innerHeight === 1000`),
    `${tone} 建立非 16:9 letterbox`,
  );
  await execute(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  const image = await displayWindow.webContents.capturePage({
    x: 796,
    y: 992,
    width: 8,
    height: 8,
  });
  const bitmap = image.toBitmap();
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let offset = 0; offset <= bitmap.length - 4; offset += 4) {
    blue += bitmap[offset];
    green += bitmap[offset + 1];
    red += bitmap[offset + 2];
    count += 1;
  }
  const average = {
    red: red / count,
    green: green / count,
    blue: blue / count,
  };
  if (tone === 'inspection') {
    assert.ok(
      average.red >= average.green * 1.25 &&
        average.red >= average.blue * 1.25,
      JSON.stringify(average),
    );
  } else {
    assert.ok(
      average.green >= average.red * 1.25 &&
        average.green >= average.blue * 1.1,
      JSON.stringify(average),
    );
  }

  displayWindow.setContentSize(1920, 1080, false);
  await waitFor(
    () => execute(`window.innerWidth === 1920 && window.innerHeight === 1080`),
    `${tone} 還原 16:9 4K compositor`,
  );
}

async function verifyEmergencyMaterialPresentation(timers) {
  // Retina 測試主機以 1920×1080 viewport 產生實際 3840×2160 compositor；
  // Display 本身仍使用 4K 邏輯解析度，與 Windows 4K HDMI 的排版座標一致。
  displayWindow.setContentSize(1920, 1080, false);
  await waitFor(
    () => execute(`window.innerWidth === 1920 && window.innerHeight === 1080`),
    '建立 4K 緊急材質驗收視窗',
  );

  // 即使管理員舊設定仍是黑色，固定信號色也必須保住紅／綠辨識。
  const blackEmergencyConfig = structuredClone(
    settingsManager.getSnapshot().config,
  );
  blackEmergencyConfig.emergency = {
    inspectionBackgroundColor: '#000000',
    releaseBackgroundColor: '#000000',
  };
  blackEmergencyConfig.display.renderResolution = '3840x2160';
  const settingsRevision = settingsManager.publish(blackEmergencyConfig).revision;
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.settingsRevision === ` +
      `'${settingsRevision}'`,
    ),
    '套用黑色舊設定後仍保留固定緊急信號色',
  );

  await execute(`Promise.all([
    '../assets/emergency-materials/red-cypress-4k.jpg',
    '../assets/emergency-materials/emerald-4k.jpg',
  ].map(async (source) => {
    const image = new Image();
    image.src = new URL(source, document.baseURI).href;
    await image.decode();
  }))`);

  presentationService.showEmergency('555');
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.emergencyTone === ` +
      `'inspection' && document.querySelectorAll('.fill-cell').length === 9`,
    ),
    '顯示 555 紅檜木九宮格',
  );
  const inspection = await inspectEmergencyMaterial(
    'inspection',
    'red-cypress-4k.jpg',
  );
  assert.deepEqual(
    [inspection.width, inspection.height],
    [3840, 2160],
    JSON.stringify(inspection),
  );
  assert.ok(inspection.chromaticRatio >= 0.75, JSON.stringify(inspection));
  assert.ok(inspection.redHueRatio >= 0.75, JSON.stringify(inspection));
  assert.ok(
    inspection.averageRed >= inspection.averageGreen * 1.25,
    JSON.stringify(inspection),
  );
  assert.ok(inspection.lumaRange >= 16, JSON.stringify(inspection));
  assert.ok(inspection.colorEntropy >= 3.5, JSON.stringify(inspection));
  assert.ok(inspection.whiteContrastAtP99 >= 4.5, JSON.stringify(inspection));
  assert.equal(timers.active().length, 0);
  await captureVisualQa('emergency-555-red-cypress-4k.png');
  await verifyEmergencyLetterboxColor('inspection');

  presentationService.showEmergency('888');
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.emergencyTone === ` +
      `'release' && [...document.querySelectorAll('.fill-cell')]` +
      `.every((cell) => cell.textContent === '8')`,
    ),
    '顯示 888 祖母綠九宮格',
  );
  const release = await inspectEmergencyMaterial('release', 'emerald-4k.jpg');
  assert.deepEqual(
    [release.width, release.height],
    [3840, 2160],
    JSON.stringify(release),
  );
  assert.ok(release.chromaticRatio >= 0.75, JSON.stringify(release));
  assert.ok(release.greenHueRatio >= 0.75, JSON.stringify(release));
  assert.ok(
    release.averageGreen >= release.averageRed * 1.25 &&
      release.averageGreen >= release.averageBlue * 1.1,
    JSON.stringify(release),
  );
  assert.ok(release.lumaRange >= 16, JSON.stringify(release));
  assert.ok(release.colorEntropy >= 3.5, JSON.stringify(release));
  assert.ok(release.whiteContrastAtP99 >= 4.5, JSON.stringify(release));
  assert.equal(timers.active().length, 0);
  await captureVisualQa('emergency-888-emerald-4k.png');
  await verifyEmergencyLetterboxColor('release');

  const visualQaDirectory =
    process.env.DISPLAYCORE_VISUAL_QA_DIRECTORY?.trim();
  if (visualQaDirectory) {
    await fileSystem.mkdir(visualQaDirectory, { recursive: true });
    await fileSystem.writeFile(
      path.join(visualQaDirectory, 'emergency-material-report.json'),
      `${JSON.stringify({ inspection, release }, null, 2)}\n`,
    );
  }
}

/** 驗證風蝕區是左清右留的多孔二值風頭，而不是灰色淡化或無方向 dissolve。 */
function assertContinuousSandSurface(frame, description) {
  const regions = [
    frame.activeSurface.left,
    frame.activeSurface.center,
    frame.activeSurface.right,
  ];
  const transparentSamples = regions.reduce(
    (total, region) => total + region.transparent,
    0,
  );
  const partialSamples = regions.reduce(
    (total, region) => total + region.partial,
    0,
  );
  const opaqueSamples = regions.reduce(
    (total, region) => total + region.opaque,
    0,
  );
  const totalSamples = transparentSamples + partialSamples + opaqueSamples;

  assert.ok(
    transparentSamples > 0 &&
      opaqueSamples > 0 &&
      regions.some((region) => region.transparent > 0 && region.opaque > 0),
    `${description}整體必須同時存在已吹散、仍保留及局部破碎區：` +
      JSON.stringify(frame.activeSurface),
  );
  assert.ok(
    partialSamples / totalSamples <= 0.08,
    `${description}半透明樣本不得形成 crossfade 灰帶：` +
      JSON.stringify(frame.activeSurface),
  );
  /*
   * 多孔隨機前緣在單一窄水平帶可能左右顛倒，不以該瞬時切片判斷風向；
   * 完整左至右方向由實際粒子尾流及多組固定種子的單元測試驗證。
   */
}

/** 驗證最終輸出 Canvas 像素形成中間偏右、向右延伸的可見沙塵雲。 */
function assertDesertDustCloud(frame, description) {
  const telemetry = frame.particleTelemetry;

  assert.ok(
    telemetry.visiblePixelCount >= 500,
    `${description}必須繪出足量且肉眼可見的舊圖片像素沙粒：` +
      JSON.stringify(telemetry),
  );
  assert.ok(
    telemetry.strongCenterX >= 0.55 && telemetry.strongCenterX <= 0.82,
    `${description}高密度沙塵核心必須位於畫面中間偏右：` +
      JSON.stringify(telemetry),
  );
  /* 隨機細砂尾流在單幀約落於 1%～2%；方向主體另由峰值區與單元測試驗證。 */
  assert.ok(
    telemetry.strongestBucket === 3 && telemetry.rightTailMassRatio > 0.01,
    `${description}沙塵質量峰值必須在 60%～80%，並向最右側留下尾流：` +
      JSON.stringify(telemetry),
  );
  assert.ok(
    telemetry.alphaCoverage >= 0.0005,
    `${description}沙塵必須具有肉眼可見的圖片粒覆蓋：` +
      JSON.stringify(telemetry),
  );
  assert.ok(
    telemetry.longestHorizontalRunRatio <= 0.2,
    `${description}不能退化成貫穿畫面的掃描線：` +
      JSON.stringify(telemetry),
  );
  assert.ok(
    telemetry.destinationVerticalSpread >= 0.03,
    `${description}沙塵必須有可見厚度，不能退化成細掃描線：` +
      JSON.stringify(telemetry),
  );
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
    reducedMotion: false,
  });

  if (process.env.DISPLAYCORE_STANDBY_EFFECT_QA_ONLY === '1') {
    await verifyStandbySandEffectToggle(
      expectedStandbyBackgroundUrls,
      delayedSecondBackgroundRead,
    );
    return;
  }

  if (process.env.DISPLAYCORE_RUNTIME_REDUCED_MOTION_QA_ONLY === '1') {
    await verifyLiquidRuntimeReducedMotionFallback(timers);
    return;
  }

  if (process.env.DISPLAYCORE_LIQUID_SETTING_QA_ONLY === '1') {
    await verifyMessageLiquidSettingToggle();
    return;
  }

  if (process.env.DISPLAYCORE_MESSAGE_BACKGROUND_QA_ONLY === '1') {
    await verifyLuxuryMessageAppearance();
    return;
  }

  if (process.env.DISPLAYCORE_EMERGENCY_MATERIAL_QA_ONLY === '1') {
    await verifyEmergencyMaterialPresentation(timers);
    return;
  }

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
    const layerElement = document.getElementById('standby-background-layer');
    const layer = layerElement.getBoundingClientRect();
    const images = [...document.querySelectorAll('.standby-background-image')];
    const visibleImage = images.find((image) => !image.hidden);
    const visibleBox = visibleImage.getBoundingClientRect();
    const layerStyle = getComputedStyle(layerElement);
    const toBox = (box) => ({
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    });
    return {
      visibleSource: visibleImage.getAttribute('src'),
      layerBox: toBox(layer),
      visibleImageBox: toBox(visibleBox),
      visibleImageCoversLayer:
        Math.abs(visibleBox.left - layer.left) <= 0.5 &&
        Math.abs(visibleBox.top - layer.top) <= 0.5 &&
        Math.abs(visibleBox.width - layer.width) <= 0.5 &&
        Math.abs(visibleBox.height - layer.height) <= 0.5,
      layerMotion: {
        transform: layerStyle.transform,
        translate: layerStyle.translate || 'none',
        animationName: layerStyle.animationName,
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
  })()`);
  assert.equal(beforeSandGeometry.visibleSource, expectedStandbyBackgroundUrl);
  assert.equal(beforeSandGeometry.visibleImageCoversLayer, true);
  assertImagesRemainStationary(beforeSandGeometry.imageMotion, '轉場前');
  assertSandGeometryStationary(beforeSandGeometry, beforeSandGeometry, '轉場前');

  delayedSecondBackgroundRead.release();
  const earlySandFrame = await captureSandFrame({
    minimumProgress: 0.22,
    maximumProgress: 0.3,
    minimumRightTailMassRatio: 0.01,
    expectedVisibleSource: secondStandbyBackgroundUrl,
    description: '下層連續沙丘侵蝕 Canvas 幀',
  });
  assert.equal(earlySandFrame.transition, 'sand');
  assert.equal(earlySandFrame.canvasCoversLayer, true);
  assert.equal(earlySandFrame.particleCanvasCoversLayer, true);
  assert.equal(earlySandFrame.visibleImageCoversLayer, true);
  assert.equal(earlySandFrame.visibleSource, secondStandbyBackgroundUrl);
  assertImagesRemainStationary(earlySandFrame.imageMotion, '轉場早段');
  assertSandGeometryStationary(beforeSandGeometry, earlySandFrame, '轉場早段');
  assert.ok(
    earlySandFrame.activeSurface.centerY > 0.6,
    `早段沙丘表面必須位於畫面下方：` +
      JSON.stringify(earlySandFrame.activeSurface),
  );
  assertContinuousSandSurface(earlySandFrame, '早段沙丘表面');
  assert.ok(
    earlySandFrame.regions.leftColumn.transparent > 0 &&
      earlySandFrame.regions.leftColumn.opaque > 0,
    `同一左側欄必須同時有透明與不透明點，不能是整齊直線 wipe：` +
      JSON.stringify(earlySandFrame.regions.leftColumn),
  );
  assertDesertDustCloud(earlySandFrame, '早段沙塵雲');
  await captureVisualQa('sand-early.png');

  const middleSandFrame = await captureSandFrame({
    minimumProgress: 0.47,
    maximumProgress: 0.55,
    minimumRightTailMassRatio: 0.01,
    expectedVisibleSource: secondStandbyBackgroundUrl,
    description: '中層連續沙丘侵蝕 Canvas 幀',
  });
  assert.equal(middleSandFrame.transition, 'sand');
  assert.equal(middleSandFrame.canvasCoversLayer, true);
  assert.equal(middleSandFrame.particleCanvasCoversLayer, true);
  assert.equal(middleSandFrame.visibleImageCoversLayer, true);
  assert.equal(middleSandFrame.visibleSource, secondStandbyBackgroundUrl);
  assertImagesRemainStationary(middleSandFrame.imageMotion, '轉場中段');
  assertSandGeometryStationary(beforeSandGeometry, middleSandFrame, '轉場中段');
  assert.ok(
    middleSandFrame.regions.bottomLeft.transparentRatio >= 0.75 &&
      middleSandFrame.regions.bottomRight.transparentRatio >= 0.75,
    `侵蝕面上移後下層左右都必須已吹散：${JSON.stringify(middleSandFrame.regions)}`,
  );
  assert.ok(
    middleSandFrame.activeSurface.centerY >= 0.2 &&
      middleSandFrame.activeSurface.centerY <= 0.65,
    `中段沙丘表面必須位於畫面中層：` +
      JSON.stringify(middleSandFrame.activeSurface),
  );
  assertContinuousSandSurface(middleSandFrame, '中段沙丘表面');
  assertDesertDustCloud(middleSandFrame, '中段沙塵雲');
  await captureVisualQa('sand-middle.png');
  assert.ok(
    middleSandFrame.regions.bottomLeft.transparentRatio >=
      earlySandFrame.regions.bottomLeft.transparentRatio,
    '下層侵蝕量不得隨進度倒退',
  );
  const lateSandFrame = await captureSandFrame({
    minimumProgress: 0.72,
    maximumProgress: 0.8,
    expectedVisibleSource: secondStandbyBackgroundUrl,
    description: '上層連續沙丘侵蝕 Canvas 幀',
  });
  assert.equal(lateSandFrame.transition, 'sand');
  assert.equal(lateSandFrame.canvasCoversLayer, true);
  assert.equal(lateSandFrame.particleCanvasCoversLayer, true);
  assert.equal(lateSandFrame.visibleImageCoversLayer, true);
  assert.equal(lateSandFrame.visibleSource, secondStandbyBackgroundUrl);
  assertImagesRemainStationary(lateSandFrame.imageMotion, '轉場晚段');
  assertSandGeometryStationary(beforeSandGeometry, lateSandFrame, '轉場晚段');
  assert.ok(
    lateSandFrame.regions.middleLeft.transparentRatio >= 0.75 &&
      lateSandFrame.regions.middleRight.transparentRatio >= 0.75,
    `侵蝕面到達上層時中層必須已吹散：${JSON.stringify(lateSandFrame.regions)}`,
  );
  assert.ok(
    lateSandFrame.activeSurface.centerY < 0.35,
    `晚段沙丘表面必須位於畫面上方：` +
      JSON.stringify(lateSandFrame.activeSurface),
  );
  assertContinuousSandSurface(lateSandFrame, '晚段沙丘表面');
  assertDesertDustCloud(lateSandFrame, '晚段沙塵雲');
  await captureVisualQa('sand-late.png');
  assert.ok(
    earlySandFrame.particleTelemetry.strongCenterY >
        middleSandFrame.particleTelemetry.strongCenterY + 0.12 &&
      middleSandFrame.particleTelemetry.strongCenterY >
        lateSandFrame.particleTelemetry.strongCenterY + 0.12,
    `沙塵核心必須隨風勢由下往上連續移動：${JSON.stringify([
      earlySandFrame.particleTelemetry.strongCenterY,
      middleSandFrame.particleTelemetry.strongCenterY,
      lateSandFrame.particleTelemetry.strongCenterY,
    ])}`,
  );
  assert.ok(
    earlySandFrame.activeSurface.centerY >
        middleSandFrame.activeSurface.centerY + 0.12 &&
      middleSandFrame.activeSurface.centerY >
        lateSandFrame.activeSurface.centerY + 0.12,
    `單一侵蝕面必須由下往上連續移動：${JSON.stringify([
      earlySandFrame.activeSurface.centerY,
      middleSandFrame.activeSurface.centerY,
      lateSandFrame.activeSurface.centerY,
    ])}`,
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
  assert.match(firstPage.clockText, /^\d{2}:\d{2}$/);
  assert.equal(firstPage.clockDateTime, firstPage.clockText);
  await verifyDisplayedClockOffset(3_661, 'Display 套用離線時間偏移');
  assert.match(firstPage.fontFamily, /^Arial/i);

  const numeralTypography = await waitFor(
    () => execute(`(() => {
      const numberSpans = [
        ...document.querySelectorAll('.message-glyph-sizing .message-number')
      ];
      const clock = document.getElementById('display-clock');
      const didotFace = [...document.fonts].find(
        (face) => face.family === 'DisplayCore GFS Didot'
      );
      if (!didotFace || didotFace.status !== 'loaded') {
        return false;
      }
      return {
        clockFontFamily: getComputedStyle(clock).fontFamily,
        didotFaceStatus: didotFace.status,
        numberFontFamilies: numberSpans.map(
          (span) => getComputedStyle(span).fontFamily
        ),
        numberTexts: numberSpans.map((span) => span.textContent),
      };
    })()`),
    '專案內建 Didot 數字字型載入並套用',
  );
  assert.equal(numeralTypography.didotFaceStatus, 'loaded');
  assert.deepEqual(numeralTypography.numberTexts, ['001', '002']);
  assert.equal(
    numeralTypography.numberFontFamilies.every((family) =>
      family.includes('DisplayCore GFS Didot')),
    true,
  );
  assert.match(numeralTypography.clockFontFamily, /DisplayCore GFS Didot/);

  const transparentColors = new Set(['rgba(0, 0, 0, 0)', 'transparent']);
  const assertLiquidSample = (
    sample,
    expectedLevel,
    expectedProgress,
    baselineRects = null,
    expectedActiveCount = 3,
  ) => {
    assert.equal(sample.computedLiquidLevel, expectedLevel);
    assert.equal(sample.requestedProgress, expectedProgress);
    assert.equal(sample.liquidPropertySupported, true);
    assert.equal(sample.liquidRows.length, 3);
    const activeRows = sample.liquidRows.filter(
      (row) => row.effect === 'active',
    );
    const staticRows = sample.liquidRows.filter(
      (row) => row.effect === 'static',
    );
    assert.equal(
      activeRows.length,
      expectedActiveCount,
    );
    assert.equal(sample.renderedCount, expectedActiveCount);
    assert.equal(
      activeRows.every((row) => row.geometryAligned),
      true,
      JSON.stringify(activeRows),
    );
    assert.equal(
      activeRows.every((row) =>
        transparentColors.has(row.sizingFillColor) &&
        transparentColors.has(row.shellFillColor) &&
        row.shellVisibility === 'hidden'),
      true,
      '有限訊息的 HTML 尺寸層須透明，active 白框改由同幾何 SVG 固定繪製',
    );
    assert.equal(
      activeRows.every((row) =>
        row.outlineFill === 'none' &&
        row.outlineStroke === '#ffffff' &&
        row.outlineStrokeWidth > 0 &&
        row.outlineAnimationName === 'none'),
      true,
      '每個進度的 canonical SVG 外框都必須固定為純白且沒有動畫',
    );
    assert.equal(
      activeRows.every((row) =>
        row.svgCount === 1 &&
        row.svgDisplay === 'block' &&
        row.svgNamespace === 'http://www.w3.org/2000/svg' &&
        row.svgViewBox !== null &&
        row.viewBoxWidth > 0 &&
        row.viewBoxHeight > 0 &&
        row.maskCount === 1 &&
        row.maskType === 'alpha' &&
        row.foreignObjectCount === 0 &&
        row.canonicalGlyphCount === 1 &&
        row.maskGlyphCount === 1 &&
        row.outlineGlyphCount === 1 &&
        row.canonicalText === row.sizingText &&
        row.maskText === row.sizingText &&
        row.outlineText === row.sizingText &&
        row.canonicalRuns.length > 0 &&
        JSON.stringify(row.maskRuns) === JSON.stringify(row.canonicalRuns) &&
        JSON.stringify(row.outlineRuns) === JSON.stringify(row.canonicalRuns) &&
        JSON.stringify(row.canonicalRuns
          .filter(({ isNumber }) => isNumber)
          .map(({ text }) => text)) ===
            JSON.stringify(row.sizingNumberTexts) &&
        row.canonicalRuns.every(({ lengthAdjust, textLength }) =>
          lengthAdjust === 'spacingAndGlyphs' &&
          Number.parseFloat(textLength) > 0
        ) &&
        row.canonicalRuns
          .filter(({ isNumber }) => isNumber)
          .every(({ fontFamily }) =>
            fontFamily.includes('DisplayCore GFS Didot')
          )),
      true,
      `native SVG mask、固定白框與 canonical 中英 Didot runs 必須完全同幾何：${JSON.stringify(activeRows)}`,
    );
    assert.equal(
      activeRows.every((row) =>
        row.paintMask === row.expectedMaskUrl &&
        row.bodyPaintMask === row.expectedMaskUrl &&
        row.refractionPaintMask === row.expectedMaskUrl &&
        row.meniscusPaintMask === row.expectedMaskUrl &&
        row.bodyPath.startsWith('M ') &&
        row.bodyPath.endsWith(' Z') &&
        / C /.test(row.bodyPath) &&
        !/polygon/i.test(row.bodyPath) &&
        row.refractionPath === row.bodyPath &&
        row.meniscusPath.startsWith('M ') &&
        / C /.test(row.meniscusPath) &&
        !/polygon/i.test(row.meniscusPath) &&
        row.outsideBeforeContent === 'none' &&
        row.outsideAfterContent === 'none' &&
        row.outsideBeforeAnimationName === 'none' &&
        row.outsideAfterAnimationName === 'none'),
      true,
      `酒體、折射與 meniscus 必須共用字形 mask 且不得有字外酒液：${JSON.stringify(activeRows)}`,
    );
    assert.equal(
      new Set(activeRows.map((row) => row.maskId)).size,
      expectedActiveCount,
      '每個訊息 vessel 必須使用唯一 mask id',
    );
    assert.equal(
      activeRows.every((row) => {
        if (expectedProgress === 0) {
          return row.bodyOpacity === 0 &&
            row.refractionOpacity === 0 &&
            row.meniscusOpacity === 0;
        }
        if (expectedProgress === 1) {
          return row.bodyOpacity === 1 &&
            row.refractionOpacity > 0 &&
            row.meniscusOpacity === 0;
        }
        return row.bodyOpacity === 1 &&
          row.refractionOpacity > 0 &&
          row.meniscusOpacity > 0;
      }),
      true,
      '酒體與 meniscus 透明度必須符合空杯、流動、滿杯三階段',
    );
    assert.equal(
      staticRows.every((row) =>
        row.shellFillColor === 'rgb(255, 255, 255)' &&
        row.shellStrokeColor === 'rgb(255, 255, 255)' &&
        row.shellVisibility === 'visible' &&
        row.svgCount === 0 &&
        row.svgDisplay === 'none' &&
        row.outsideBeforeContent === 'none' &&
        row.outsideAfterContent === 'none'),
      true,
      '置中營運訊息不得套用液面倒數，必須維持白色實心字',
    );
    if (baselineRects !== null) {
      assert.deepEqual(
        sample.liquidRows.map(({ rect }) => rect),
        baselineRects,
        '液面推進不得造成任何文字位移或尺寸改變',
      );
    }
  };

  const firstPageLiquidStart = await sampleMessageLiquid(0);
  assert.equal(firstPageLiquidStart.animationCount, 1);
  assert.equal(
    firstPageLiquidStart.effectKeyframes.every((keyframe) =>
      Object.hasOwn(keyframe, '--message-liquid-level') &&
      !Object.hasOwn(keyframe, '--message-liquid-wave') &&
      !Object.hasOwn(keyframe, '--message-liquid-agitation') &&
      !Object.hasOwn(keyframe, '--message-outline-color') &&
      !Object.hasOwn(keyframe, 'color') &&
      !Object.hasOwn(keyframe, 'webkitTextStrokeColor')),
    true,
    'WAAPI 只允許提供 0～100% 液位時鐘，不得再合成 CSS 假波形',
  );
  assert.equal(firstPageLiquidStart.inlineLiquidLevel, '0%');
  assert.equal(firstPageLiquidStart.duration, 1_000);
  assertLiquidSample(firstPageLiquidStart, '0%', 0);
  assert.equal(firstPageLiquidStart.clockColor, 'rgb(244, 245, 246)');
  assert.equal(
    firstPageLiquidStart.clockFillColor,
    firstPageLiquidStart.clockColor,
  );
  assert.equal(firstPageLiquidStart.clockStrokeWidth, '0px');
  assert.equal(firstPageLiquidStart.clockAnimationCount, 0);
  assert.equal(firstPageLiquidStart.logoAnimationCount, 0);
  const baselineLiquidRects = firstPageLiquidStart.liquidRows.map(
    ({ rect }) => rect,
  );
  await captureVisualQa('message-liquid-000.png');

  const firstPageLiquidTen = await sampleMessageLiquid(0.1, 0.1);
  assertLiquidSample(firstPageLiquidTen, '10%', 0.1, baselineLiquidRects);
  await captureVisualQa('message-liquid-010.png');

  const firstPageLiquidQuarter = await sampleMessageLiquid(0.25, 0.25);
  assertLiquidSample(firstPageLiquidQuarter, '25%', 0.25, baselineLiquidRects);
  await captureVisualQa('message-liquid-025.png');

  const firstPageHalfPhases = [];
  for (const timePhase of [0.17, 0.39, 0.63, 0.88]) {
    firstPageHalfPhases.push(await sampleMessageLiquid(0.5, timePhase));
  }
  for (const sample of firstPageHalfPhases) {
    assertLiquidSample(sample, '50%', 0.5, baselineLiquidRects);
    assert.equal(
      sample.computedLiquidLevel,
      firstPageHalfPhases[0].computedLiquidLevel,
      '物理時間相位不得改變 50% 液位',
    );
  }
  for (let index = 0; index < firstPageHalfPhases[0].liquidRows.length; index += 1) {
    const phaseRows = firstPageHalfPhases.map(
      (sample) => sample.liquidRows[index],
    );
    if (phaseRows[0].effect !== 'active') {
      continue;
    }
    assert.equal(
      new Set(phaseRows.map(({ bodyPath }) => bodyPath)).size,
      4,
      `同一 50% 液位的四個時間相位必須各有不同曲線：${JSON.stringify(phaseRows)}`,
    );
  }
  await sampleMessageLiquid(0.5, 0.63);
  await captureVisualQa('message-liquid-050.png');

  const firstPageLiquidThreeQuarters = await sampleMessageLiquid(0.75, 0.75);
  assertLiquidSample(
    firstPageLiquidThreeQuarters,
    '75%',
    0.75,
    baselineLiquidRects,
  );
  await captureVisualQa('message-liquid-075.png');

  const firstPageLiquidNinety = await sampleMessageLiquid(0.9, 0.9);
  assertLiquidSample(firstPageLiquidNinety, '90%', 0.9, baselineLiquidRects);
  await captureVisualQa('message-liquid-090.png');

  const firstPageLiquidFull = await sampleMessageLiquid(1, 1);
  assertLiquidSample(firstPageLiquidFull, '100%', 1, baselineLiquidRects);
  assert.equal(firstPageLiquidFull.clockColor, firstPageLiquidStart.clockColor);
  await captureVisualQa('message-liquid-100.png');

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
  const secondPageLiquidStart = await sampleMessageLiquid(0);
  assertLiquidSample(secondPageLiquidStart, '0%', 0, null, 2);
  assert.equal(secondPageLiquidStart.inlineLiquidLevel, '0%');
  assert.equal(
    secondPageLiquidStart.clockColor,
    firstPageLiquidStart.clockColor,
  );

  const secondPageLiquidHalf = await sampleMessageLiquid(0.5, 0.44);
  assertLiquidSample(secondPageLiquidHalf, '50%', 0.5, null, 2);
  assert.equal(
    secondPageLiquidHalf.clockColor,
    firstPageLiquidStart.clockColor,
  );

  const secondPageLiquidFull = await sampleMessageLiquid(1);
  assertLiquidSample(secondPageLiquidFull, '100%', 1, null, 2);
  assert.equal(
    secondPageLiquidFull.clockColor,
    firstPageLiquidStart.clockColor,
  );

  // 這一段要驗證「仍可套用酒液」的壓縮／跑馬燈文字，因此維持在
  // 512 code point 裝飾特效上限內；10,000 字安全退回另由 production QA 驗證。
  const longMessage = '超長訊息'.repeat(100);
  const secondLongMessage = '第二列更長訊息'.repeat(60);
  presentationService.startProgram({
    messages: [
      { message: longMessage, alignment: 'left' },
      { message: secondLongMessage, alignment: 'left' },
    ],
    pageDurationSeconds: 1,
    repeat: { mode: 'finite', rounds: 1 },
  });
  await waitForRevision(3);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('display-stage').dataset.revision === '3' &&
      document.getElementById('page-layer').getAnimations().some(
        (animation) => animation.effect.getKeyframes().some(
          (keyframe) => Object.hasOwn(keyframe, '--message-liquid-level')
        )
      )
    )()`),
    'revision 3 的 started 已被 Main 接受並啟動酒液時鐘',
  );
  const staticOverflow = await execute(`(() => {
    const rows = [...document.querySelectorAll('.message-row')];
    return {
      marquee: rows.map((row) => row.classList.contains('is-marquee')),
      compressed: rows.map((row) => row.classList.contains('is-compressed')),
      vesselBeforeContents: rows.map((row) => getComputedStyle(
        row.querySelector('.message-vessel'),
        '::before'
      ).content),
      vesselAfterContents: rows.map((row) => getComputedStyle(
        row.querySelector('.message-vessel'),
        '::after'
      ).content),
      liquidSvgCounts: rows.map((row) =>
        row.querySelectorAll('.message-liquid-svg').length
      ),
      liquidEffects: rows.map((row) => row.dataset.liquidEffect),
      liquidCompatible: rows.map((row) =>
        row.querySelector('.message-vessel')?.dataset.liquidCompatible
      ),
      liquidAnimationCount: document.getElementById('page-layer')
        .getAnimations()
        .filter((animation) => animation.effect.getKeyframes()
          .some((keyframe) => Object.hasOwn(
            keyframe,
            '--message-liquid-level'
          ))).length,
      numberSpanCounts: rows.map((row) =>
        row.querySelectorAll('.message-number').length
      ),
      messages: rows.map((row) =>
        row.querySelector('.message-glyph-sizing')?.textContent
      ),
    };
  })()`);
  assert.deepEqual(staticOverflow, {
    marquee: [false, false],
    compressed: [true, true],
    vesselBeforeContents: Array(2).fill('none'),
    vesselAfterContents: Array(2).fill('none'),
    liquidSvgCounts: Array(2).fill(1),
    liquidEffects: Array(2).fill('active'),
    liquidCompatible: Array(2).fill('true'),
    liquidAnimationCount: 1,
    numberSpanCounts: Array(2).fill(0),
    messages: [longMessage, secondLongMessage],
  });

  const nextConfig = structuredClone(settingsManager.getSnapshot().config);
  nextConfig.logo.enabled = false;
  nextConfig.appearance.backgroundColor = '#204060';
  nextConfig.appearance.messageBackgroundPreset = 'solid';
  nextConfig.appearance.fontColor = '#ABCDEF';
  nextConfig.appearance.fontSizePercent = 75;
  nextConfig.appearance.lineSpacingPercent = 200;
  nextConfig.dateTime.enabled = false;
  nextConfig.marquee.enabled = true;

  /*
   * 刻意延遲這次 ready 的 IPC 回應，驗證跑馬燈不能在 Main 正式接受頁面前
   * 偷跑；接受後則必須和酒液時軸從同一個顯示週期開始。
   */
  const originalReportPageProgress =
    coordinator.reportPageProgress.bind(coordinator);
  const delayedReadyReports = [];
  let delayMarqueeReady = true;
  coordinator.reportPageProgress = (event, payload) => {
    if (
      delayMarqueeReady &&
      payload?.phase === 'ready' &&
      payload.revision === 3 &&
      payload.settingsRevision === 1
    ) {
      return new Promise((resolve) => {
        delayedReadyReports.push({ event, payload, resolve });
      });
    }

    return originalReportPageProgress(event, payload);
  };
  settingsManager.publish(nextConfig);
  await waitFor(
    () => Promise.resolve(delayedReadyReports.length > 0),
    '攔截跑馬燈頁面的 ready 回應',
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const beforeMarqueeReady = await execute(`(() => {
    const tracks = [...document.querySelectorAll('.marquee-track')];
    const liquidSvgs = [...document.querySelectorAll('.message-liquid-svg')];
    const liquidAnimations = document.getElementById('page-layer')
      .getAnimations()
      .filter((animation) => animation.effect.getKeyframes().some(
        (keyframe) => Object.hasOwn(keyframe, '--message-liquid-level')
      ));
    return {
      count: tracks.length,
      playStates: tracks.map((track) =>
        getComputedStyle(track).animationPlayState
      ),
      currentTimes: tracks.map((track) =>
        track.getAnimations()[0]?.currentTime ?? null
      ),
      liquidAnimationCount: liquidAnimations.length,
      liquidAnimationCurrentTimes: liquidAnimations.map(
        (animation) => animation.currentTime
      ),
      liquidAnimationPlayStates: liquidAnimations.map(
        (animation) => animation.playState
      ),
      liquidSvgCount: liquidSvgs.length,
      liquidSvgReadyCount: liquidSvgs.filter((svg) =>
        svg.closest('.message-vessel')?.dataset.liquidSvg === 'ready'
      ).length,
      liquidBodyOpacities: liquidSvgs.map((svg) => Number(
        svg.querySelector('.message-liquid-body')?.getAttribute('opacity') ?? 0
      )),
    };
  })()`);
  assert.equal(beforeMarqueeReady.count, 2);
  assert.deepEqual(beforeMarqueeReady.playStates, ['paused', 'paused']);
  assert.equal(
    beforeMarqueeReady.currentTimes.every(
      (currentTime) => currentTime === null || Math.abs(currentTime) <= 1,
    ),
    true,
    `Main 接受 ready 前跑馬燈不得偷跑：${JSON.stringify(beforeMarqueeReady)}`,
  );
  /*
   * 這是同一 revision 的設定 refit，不是新頁面。既有倒酒時鐘必須保留，
   * 否則每次改設定都會把酒量歸零重倒；只有新跑馬燈要等 Main 接受後啟動。
   */
  assert.equal(beforeMarqueeReady.liquidAnimationCount, 1);
  assert.deepEqual(beforeMarqueeReady.liquidAnimationPlayStates, ['running']);
  assert.equal(
    beforeMarqueeReady.liquidAnimationCurrentTimes.every(
      (currentTime) => Number.isFinite(currentTime) && currentTime > 0,
    ),
    true,
    `同一頁 refit 不得把倒酒時鐘歸零：${JSON.stringify(beforeMarqueeReady)}`,
  );
  assert.ok(beforeMarqueeReady.liquidSvgCount > 0);
  assert.equal(
    beforeMarqueeReady.liquidSvgReadyCount,
    beforeMarqueeReady.liquidSvgCount,
  );
  assert.equal(
    beforeMarqueeReady.liquidBodyOpacities.every((opacity) => opacity === 1),
    true,
    `同一頁 refit 必須保留既有酒液狀態：` +
      JSON.stringify(beforeMarqueeReady),
  );

  delayMarqueeReady = false;
  coordinator.reportPageProgress = originalReportPageProgress;
  for (const delayedReport of delayedReadyReports) {
    delayedReport.resolve(originalReportPageProgress(
      delayedReport.event,
      delayedReport.payload,
    ));
  }
  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const tracks = [...document.querySelectorAll('.marquee-track')];
      const liquidSvgs = [...document.querySelectorAll('.message-liquid-svg')];
      return stage.dataset.revision === '3' &&
        stage.dataset.settingsRevision === '1' &&
        stage.dataset.fittedSettingsRevision === '1' &&
        stage.dataset.marqueeCount === '2' &&
        tracks.length === 2 &&
        tracks.every((track) =>
          getComputedStyle(track).animationPlayState === 'running'
        ) &&
        liquidSvgs.length > 0 &&
        liquidSvgs.every((svg) =>
          svg.querySelector('.message-liquid-body')?.getAttribute('d')
        ) &&
        document.getElementById('page-layer').getAnimations().some(
          (animation) => animation.effect.getKeyframes().some(
            (keyframe) => Object.hasOwn(keyframe, '--message-liquid-level')
          )
        );
    })()`),
    '播放中即時套用設定',
  );

  const marquee = await execute(`(() => {
    const stage = document.getElementById('display-stage');
    const rows = [...document.querySelectorAll('.message-row')];
    const row = rows[0];
    const copies = [...row.querySelectorAll('.marquee-copy')];
    const liquidAnimation = document.getElementById('page-layer')
      .getAnimations()
      .find((animation) => animation.effect.getKeyframes().some(
        (keyframe) => Object.hasOwn(keyframe, '--message-liquid-level')
      ));
    return {
      active: rows.map((item) => item.classList.contains('is-marquee')),
      trackCount: document.querySelectorAll('.marquee-track').length,
      copyCount: copies.length,
      copiesMatch: copies.every((copy) =>
        copy.querySelector('.message-glyph-sizing')?.textContent ===
          ${JSON.stringify(longMessage)}
      ),
      copiesHaveVessels: copies.every((copy) => {
        const mask = copy.querySelector('.message-liquid-mask');
        const paint = copy.querySelector('.message-liquid-paint');
        const fluidClip = copy.querySelector('.message-liquid-fluid-clip');
        const optics = copy.querySelector('.message-liquid-optics');
        const wineNodes = [...copy.querySelectorAll(
          '.message-liquid-body, .message-liquid-refraction-primary, ' +
          '.message-liquid-refraction-secondary, ' +
          '.message-liquid-caustic, .message-liquid-surface-focus, ' +
          '.message-liquid-meniscus'
        )];
        const opticalNodes = [...copy.querySelectorAll(
          '.message-liquid-refraction-primary, ' +
          '.message-liquid-refraction-secondary, ' +
          '.message-liquid-caustic, .message-liquid-surface-focus'
        )];
        return copy.querySelectorAll('.message-vessel').length === 1 &&
          copy.querySelectorAll('.message-glyph-sizing').length === 1 &&
          copy.querySelectorAll('.message-liquid-svg').length === 1 &&
          copy.querySelectorAll('.message-liquid-mask').length === 1 &&
          wineNodes.length === 6 &&
          opticalNodes.length === 4 &&
          wineNodes.every((node) =>
            node.closest('.message-liquid-paint') === paint
          ) &&
          opticalNodes.every((node) =>
            node.closest('.message-liquid-optics') === optics
          ) &&
          paint?.getAttribute('mask') === 'url(#' + mask?.id + ')' &&
          optics?.getAttribute('clip-path') ===
            'url(#' + fluidClip?.id + ')' &&
          copy.querySelectorAll('.message-glyph-shell').length === 1;
      }),
      copyMaskIds: copies.map((copy) =>
        copy.querySelector('.message-liquid-mask')?.id ?? null
      ),
      copyBeforeContents: copies.map((copy) => getComputedStyle(
        copy.querySelector('.message-vessel'),
        '::before'
      ).content),
      copyAfterContents: copies.map((copy) => getComputedStyle(
        copy.querySelector('.message-vessel'),
        '::after'
      ).content),
      rowBeforeContent: getComputedStyle(row, '::before').content,
      ariaHidden: row.querySelector('.marquee-track')?.getAttribute('aria-hidden'),
      presentationRevision: stage.dataset.revision,
      settingsRevision: stage.dataset.settingsRevision,
      backgroundColor: getComputedStyle(stage).backgroundColor,
      fontColor: getComputedStyle(stage).color,
      messageColors: rows.map((item) => getComputedStyle(item).color),
      messageStrokeWidths: rows.map((item) => getComputedStyle(
        item.querySelector('.message-glyph-shell')
      ).getPropertyValue('-webkit-text-stroke-width')),
      messageShellFillColors: rows.map((item) => getComputedStyle(
        item.querySelector('.message-glyph-shell')
      ).getPropertyValue('-webkit-text-fill-color')),
      liquidDisplays: rows.map((item) => getComputedStyle(
        item.querySelector('.message-liquid-svg')
      ).display),
      chromeHidden: document.getElementById('display-chrome').hidden,
      logoSource: document.getElementById('display-logo').getAttribute('src'),
      clockText: document.getElementById('display-clock').textContent,
      normalHasLogo: document.getElementById('normal-layer').classList.contains('has-logo'),
      normalHasClock: document.getElementById('normal-layer').classList.contains('has-clock'),
      normalGap: getComputedStyle(document.getElementById('normal-layer')).gap,
      animationName: getComputedStyle(row.querySelector('.marquee-track')).animationName,
      animationDurations: rows.map((item) => Number.parseFloat(
        getComputedStyle(item.querySelector('.marquee-track')).animationDuration
      )),
      inlineAnimationDurations: rows.map((item) => Number.parseFloat(
        item.querySelector('.marquee-track').style.getPropertyValue(
          '--marquee-duration'
        )
      )),
      trackCurrentTimes: rows.map((item) =>
        item.querySelector('.marquee-track').getAnimations()[0]?.currentTime
      ),
      liquidCurrentTime: liquidAnimation?.currentTime,
      liquidTimelineDuration:
        liquidAnimation?.effect.getComputedTiming().duration,
    };
  })()`);
  assert.deepEqual(marquee, {
    active: [true, true],
    trackCount: 2,
    copyCount: 2,
    copiesMatch: true,
    copiesHaveVessels: true,
    copyMaskIds: marquee.copyMaskIds,
    copyBeforeContents: Array(2).fill('none'),
    copyAfterContents: Array(2).fill('none'),
    rowBeforeContent: 'none',
    ariaHidden: 'true',
    presentationRevision: '3',
    settingsRevision: '1',
    backgroundColor: 'rgb(32, 64, 96)',
    fontColor: 'rgb(171, 205, 239)',
    messageColors: Array(2).fill('rgb(255, 255, 255)'),
    messageStrokeWidths: marquee.messageStrokeWidths,
    messageShellFillColors: Array(2).fill('rgba(0, 0, 0, 0)'),
    liquidDisplays: Array(2).fill('block'),
    chromeHidden: true,
    logoSource: null,
    clockText: '',
    normalHasLogo: false,
    normalHasClock: false,
    normalGap: '0px',
    animationName: 'display-marquee',
    animationDurations: marquee.animationDurations,
    inlineAnimationDurations: marquee.inlineAnimationDurations,
    trackCurrentTimes: marquee.trackCurrentTimes,
    liquidCurrentTime: marquee.liquidCurrentTime,
    liquidTimelineDuration: marquee.liquidTimelineDuration,
  });
  assert.equal(
    new Set(marquee.copyMaskIds).size,
    marquee.copyMaskIds.length,
    '跑馬燈的每份 SVG 必須使用唯一 mask id',
  );
  assert.equal(
    marquee.trackCurrentTimes.every(Number.isFinite) &&
      Number.isFinite(marquee.liquidCurrentTime),
    true,
  );
  assert.equal(
    marquee.trackCurrentTimes.every(
      (currentTime) =>
        marquee.liquidCurrentTime > currentTime + 50,
    ),
    true,
    `同一頁 refit 必須保留既有酒量，不能隨新跑馬燈歸零重倒：${JSON.stringify({
      trackCurrentTimes: marquee.trackCurrentTimes,
      liquidCurrentTime: marquee.liquidCurrentTime,
    })}`,
  );
  assert.equal(
    marquee.animationDurations.every((duration) => duration >= 8),
    true,
  );
  assert.equal(
    marquee.liquidTimelineDuration,
    1_000,
    '同 revision 的設定 refit 不得取消或重建已經開始的一秒倒酒時鐘',
  );
  assert.equal(
    marquee.messageStrokeWidths.every((width) => Number.parseFloat(width) > 0),
    true,
  );

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
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    presentationService.getSnapshot().revision,
    3,
    '所有跑馬燈 traversal 完成仍須等待酒液真正到達 100% 終幀',
  );

  // 此處只加速 refit 前已啟動的同一條正式 WAAPI 時鐘，驗證它完成後仍須
  // 等新跑馬燈 traversal，且 finished → 100% → complete 流程不會重複。
  assert.equal(await execute(`(() => {
    const liquidAnimation = document.getElementById('page-layer')
      .getAnimations()
      .find((animation) => animation.effect.getKeyframes().some(
        (keyframe) => Object.hasOwn(keyframe, '--message-liquid-level')
      ));
    if (!liquidAnimation) {
      return false;
    }
    liquidAnimation.updatePlaybackRate(100);
    return true;
  })()`), true);
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
    pageColorAnimationCount:
      document.getElementById('page-layer').getAnimations().length,
    pageInlineColor: document.getElementById('page-layer').style.color,
    pageInlineStrokeColor: document.getElementById('page-layer').style
      .getPropertyValue('-webkit-text-stroke-color'),
    pageInlineLiquidLevel: document.getElementById('page-layer').style
      .getPropertyValue('--message-liquid-level'),
    liquidVesselCount: document.querySelectorAll('.message-vessel').length,
    cellColors: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => getComputedStyle(cell).color
    ),
    cellFillColors: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => getComputedStyle(cell)
        .getPropertyValue('-webkit-text-fill-color')
    ),
    cellFontFamilies: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => getComputedStyle(cell).fontFamily
    ),
    cellStrokeWidths: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => getComputedStyle(cell)
        .getPropertyValue('-webkit-text-stroke-width')
    ),
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
  assert.equal(inspection.cells.length, 9);
  assert.equal(inspection.cells.every((value) => value === '5'), true);
  assert.equal(inspection.marqueeCount, 0);
  assert.equal(inspection.announcement, '555');
  assert.equal(inspection.ariaLive, 'assertive');
  const expectedInspectionBackground = await resolveComputedBackgroundColor(
    'color-mix(in srgb, #7F1D1D 18%, #A70F22)',
  );
  assert.equal(inspection.backgroundColor, expectedInspectionBackground);
  assert.equal(
    inspection.viewportBackgroundColor,
    expectedInspectionBackground,
  );
  assert.equal(inspection.fontColor, 'rgb(255, 255, 255)');
  assert.equal(inspection.pageColorAnimationCount, 0);
  assert.equal(inspection.pageInlineColor, '');
  assert.equal(inspection.pageInlineStrokeColor, '');
  assert.equal(inspection.pageInlineLiquidLevel, '');
  assert.equal(inspection.liquidVesselCount, 0);
  assert.equal(
    inspection.cellColors.every((color) => color === 'rgb(255, 255, 255)'),
    true,
  );
  assert.equal(
    inspection.cellFillColors.every(
      (color) => color === 'rgb(255, 255, 255)'),
    true,
  );
  assert.equal(
    inspection.cellFontFamilies.every((family) =>
      family.includes('DisplayCore GFS Didot')),
    true,
  );
  assert.equal(
    inspection.cellStrokeWidths.every((width) => width === '0px'),
    true,
  );
  assert.equal(timers.active().length, 0, '555 不得建立時間限制 timer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentationService.getSnapshot().revision, 5);
  assert.equal(presentationService.getSnapshot().mode, 'emergency');
  assert.equal(presentationService.getSnapshot().messages[0].message, '555');

  // 555／888 共用一般字級設定；九宮格受限於單格高度，但完整 50%～200%
  // 範圍仍須逐級有差異，不能在 150% 左右提前封頂。
  const emergencyFontSizes = [];
  for (const percentage of [50, 100, 150, 200]) {
    const fontConfig = structuredClone(settingsManager.getSnapshot().config);
    fontConfig.appearance.fontSizePercent = percentage;
    const fontSettingsRevision = settingsManager.publish(fontConfig).revision;
    const fontSize = await waitFor(
      () => execute(`(() => {
        const stage = document.getElementById('display-stage');
        const cell = document.querySelector('.fill-cell');
        if (
          stage.dataset.settingsRevision !== '${fontSettingsRevision}' ||
          !cell
        ) {
          return false;
        }
        return Number.parseFloat(getComputedStyle(cell).fontSize);
      })()`),
      `555 九宮格字級 ${percentage}%`,
    );
    emergencyFontSizes.push(fontSize);
  }
  for (let index = 1; index < emergencyFontSizes.length; index += 1) {
    assert.ok(
      emergencyFontSizes[index] > emergencyFontSizes[index - 1] * 1.1,
      `555／888 字級未持續放大：${JSON.stringify(emergencyFontSizes)}`,
    );
  }

  const resetEmergencyFontConfig = structuredClone(
    settingsManager.getSnapshot().config,
  );
  resetEmergencyFontConfig.appearance.fontSizePercent = 100;
  const resetEmergencyFontRevision = settingsManager.publish(
    resetEmergencyFontConfig,
  ).revision;
  await waitFor(
    () => execute(
      `document.getElementById('display-stage').dataset.settingsRevision === ` +
      `'${resetEmergencyFontRevision}'`,
    ),
    '還原 555／888 字級',
  );
  await captureVisualQa('emergency-555.png');

  presentationService.showEmergency('888');
  await waitForRevision(6, false);
  assert.equal(
    await execute(`(() => {
      const cells = [...document.querySelectorAll('.fill-cell')];
      const pageLayer = document.getElementById('page-layer');
      return cells.length === 9 &&
        cells.every((cell) => cell.textContent === '8') &&
        cells.every((cell) => getComputedStyle(cell).fontFamily.includes(
          'DisplayCore GFS Didot'
        )) &&
        cells.every((cell) => getComputedStyle(cell)
          .getPropertyValue('-webkit-text-stroke-width') === '0px') &&
        pageLayer.getAnimations().length === 0 &&
        pageLayer.style.color === '' &&
        pageLayer.style.getPropertyValue('-webkit-text-stroke-color') === '' &&
        pageLayer.style.getPropertyValue('--message-liquid-level') === '' &&
        document.querySelectorAll('.message-vessel').length === 0;
    })()`),
    true,
  );
  const expectedReleaseBackground = await resolveComputedBackgroundColor(
    'color-mix(in srgb, #14532D 18%, #087A46)',
  );
  assert.equal(
    await execute(`getComputedStyle(document.getElementById('display-stage')).backgroundColor`),
    expectedReleaseBackground,
  );
  assert.equal(
    await execute(`getComputedStyle(document.body).backgroundColor`),
    expectedReleaseBackground,
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
  await captureVisualQa('emergency-888.png');

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
  assert.match(standby.clockText, /^\d{2}:\d{2}$/);
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

  /*
   * 輪播中途切回固定背景後，不得讓下一輪永遠不會使用的 4K Canvas 與
   * 預建幾何留在 Renderer。等待本輪安全收斂後，所有 backing store 都要縮回。
   */
  const fixedBackgroundConfig = structuredClone(
    settingsManager.getSnapshot().config,
  );
  fixedBackgroundConfig.standby.backgroundMode = 'fixed';
  fixedBackgroundConfig.standby.backgroundImagePaths = [
    fixedBackgroundConfig.standby.backgroundImagePaths[0],
  ];
  const fixedBackgroundRevision = settingsManager.publish(
    fixedBackgroundConfig,
  ).revision;
  const releasedSandBuffers = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const sand = document.getElementById('standby-sand-transition');
      const particles = document.getElementById('standby-sand-particles');
      return stage.dataset.settingsRevision === '${fixedBackgroundRevision}' &&
        stage.dataset.standbyTransition === undefined &&
        stage.dataset.sandPreparation === undefined &&
        sand.hidden && particles.hidden &&
        sand.width === 1 && sand.height === 1 &&
        particles.width === 1 && particles.height === 1
        ? {
            sand: [sand.width, sand.height],
            particles: [particles.width, particles.height],
          }
        : false;
    })()`),
    '輪播切回固定背景後釋放沙塵 Canvas buffers',
  );
  assert.deepEqual(releasedSandBuffers, {
    sand: [1, 1],
    particles: [1, 1],
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
  await verifyLuxuryMessageAppearance();
  await verifyContinuousMessageIsStatic();
  await verifyLiquidAnimationFailureFallback();
  await verifyLiquidReducedMotionFallback();
  await verifyLiquidRuntimeReducedMotionFallback(timers);
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
    .update(SECOND_STANDBY_BACKGROUND_BYTES)
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
    SECOND_STANDBY_BACKGROUND_BYTES,
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
    sandEffectEnabled: true,
    slideDurationSeconds: 1,
  };
  initialConfig.appearance = {
    ...initialConfig.appearance,
    backgroundColor: '#102030',
    messageBackgroundPreset: 'solid',
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
        value: 'no-preference',
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
  const successMessage =
    process.env.DISPLAYCORE_STANDBY_EFFECT_QA_ONLY === '1'
      ? '[DisplayCore] Display window standby effect workflow succeeded.'
      : '[DisplayCore] Display window workflow succeeded.';
  finish(0, successMessage);
}

run().catch((error) => {
  finish(1, '[DisplayCore] Display window smoke test failed.', error);
});
