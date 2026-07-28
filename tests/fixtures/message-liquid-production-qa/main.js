'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fileSystem = require('node:fs/promises');
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
const OUTPUT_ENVIRONMENT_VARIABLE =
  'DISPLAYCORE_MESSAGE_LIQUID_QA_DIRECTORY';
const PERFORMANCE_ONLY = process.env[
  'DISPLAYCORE_MESSAGE_LIQUID_QA_PERFORMANCE_ONLY'
] === '1';
const QA_MESSAGES = Object.freeze([
  '001請至前廳',
  'Nancy聯絡櫃台',
  'VIP000請至前廳',
]);
const PROGRESS_STEPS = Object.freeze([
  0,
  0.1,
  0.25,
  0.5,
  0.75,
  0.9,
  0.99,
  1,
]);
// 固定半杯時只抽樣已開始倒酒的四個時間相位；time=0 尚未有
// 注入或氣泡，不能拿來假裝半杯的「同液位動態」驗收。
const PHASE_STEPS = Object.freeze([0.2, 0.35, 0.5, 0.65]);
// 8 秒正式頁以 15fps 取 121 幀（含首尾），可直接編碼成等時長驗收影片。
const VIDEO_FRAME_COUNT = 121;
const PERFORMANCE_FRAME_COUNT = 121;
const PAGE_DURATION_SECONDS = 8;
const WINDOW_WIDTH = 1_920;
const WINDOW_HEIGHT = 1_080;
// 121 張原生 4K capturePage、即時 rAF 效能取樣與極端長字串檢查需保留
// 足夠時間；逾時只負責攔截真正卡死，不應把較慢的測試主機誤判為失敗。
const TIMEOUT_MILLISECONDS = 300_000;
const WINE_SIGNAL_THRESHOLD = 3;
const WINE_SIGNAL_TOLERANCE = 1;
const MASK_ANTIALIAS_RADIUS_DEVICE_PIXELS = 1;
const MASK_DISTANCE_SEARCH_LIMIT_DEVICE_PIXELS = 32;
const MINIMUM_FULL_GLYPH_COVERAGE_RATIO = 0.97;
const MAXIMUM_NINETY_PERCENT_COVERAGE_RATIO = 0.94;
// 新液位不再把 4% 容量擠在最後 1% 時間；4K 像素驗證只要求 99% 仍
// 可量出至少約百個字形像素未填滿，而 100% 才首次完整抵達杯口。
const MINIMUM_LAST_MOMENT_COVERAGE_DELTA = 0.0004;

const outputDirectory = process.env[
  OUTPUT_ENVIRONMENT_VARIABLE
]?.trim();

let displayWindow = null;
let coordinator = null;
let presentationService = null;
let runtimeDataRoot = null;
let timeoutHandle = null;
let completed = false;
let partialReport = null;
const rendererErrors = [];

app.commandLine.appendSwitch('force-device-scale-factor', '1');
registerAppScheme(protocol);

function createFakeTimers() {
  const handles = [];

  return Object.freeze({
    handles,
    setTimer(callback, delay) {
      const handle = {
        callback,
        delay,
        cleared: false,
        unref() {},
      };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      handle.cleared = true;
    },
    active() {
      return handles.filter((handle) => !handle.cleared);
    },
  });
}

function createSettingsManager(initialConfig) {
  const validation = validateConfig(initialConfig);
  if (!validation.ok) {
    throw new Error('Production QA 初始設定未通過正式 schema。');
  }

  const listeners = new Set();
  const snapshot = Object.freeze({
    config: validation.value,
    defaults: validation.value,
    revision: 0,
    notice: null,
  });

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

async function writeJson(fileName, value) {
  if (!outputDirectory) {
    return;
  }
  await fileSystem.mkdir(outputDirectory, { recursive: true });
  await fileSystem.writeFile(
    path.join(outputDirectory, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

async function cleanup() {
  clearTimeout(timeoutHandle);
  coordinator?.dispose();
  presentationService?.dispose();

  if (displayWindow?.webContents.debugger.isAttached()) {
    try {
      displayWindow.webContents.debugger.detach();
    } catch {
      // Renderer 已離開時不覆蓋原始 QA 結果。
    }
  }
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.destroy();
  }
  if (runtimeDataRoot) {
    try {
      await fileSystem.rm(runtimeDataRoot, { recursive: true, force: true });
    } catch {
      // QA 專用 temp 清理失敗不影響 production compositor 判定。
    }
  }
}

async function finish(exitCode, message, error = null) {
  if (completed) {
    return;
  }
  completed = true;

  if (error) {
    const failureReport = {
      ...(partialReport || {}),
      pass: false,
      error: {
        message: error.message,
        name: error.name,
        stack: error.stack,
      },
      rendererErrors,
    };
    try {
      await writeJson('qa-report.json', failureReport);
    } catch {
      // 原始錯誤比報告寫入錯誤更重要。
    }
    console.error(message, error);
  } else {
    console.info(message);
  }

  await cleanup();
  // Electron 於部分 macOS runner 會把 app.exit(code) 正規化為 0；此 fixture
  // 必須讓 compositor assertion 的失敗確實傳回 shell／CI。
  process.exit(exitCode);
}

function execute(source) {
  return displayWindow.webContents.executeJavaScript(source, true);
}

async function waitFor(predicate, description, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
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

async function waitForCompositor() {
  await execute(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  // 4K masked SVG 在 macOS GPU process 的 raster 可超過 100ms；這裡是
  // deterministic 截圖驗收，必須等待新 surface，不可讀到上一幀。
  await new Promise((resolve) => setTimeout(resolve, 160));
}

/** 在 production 三列酒液實際播放時量測真實 Renderer rAF cadence。 */
async function measureAnimationFrameCadence() {
  const deltas = await execute(`new Promise((resolve) => {
    const timestamps = [];
    const sample = (timestamp) => {
      timestamps.push(timestamp);
      if (timestamps.length >= ${PERFORMANCE_FRAME_COUNT}) {
        resolve(timestamps.slice(1).map(
          (value, index) => value - timestamps[index]
        ));
        return;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })`);
  const sorted = [...deltas].sort((left, right) => left - right);
  const percentile = (ratio) => sorted[Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  )];
  const average = deltas.reduce((total, value) => total + value, 0) /
    deltas.length;

  return Object.freeze({
    averageMilliseconds: Number(average.toFixed(4)),
    frameCount: deltas.length,
    framesOver25Milliseconds: deltas.filter((value) => value > 25).length,
    framesOver34Milliseconds: deltas.filter((value) => value > 34).length,
    framesOver50Milliseconds: deltas.filter((value) => value > 50).length,
    maximumMilliseconds: Number(Math.max(...deltas).toFixed(4)),
    medianMilliseconds: Number(percentile(0.5).toFixed(4)),
    p95Milliseconds: Number(percentile(0.95).toFixed(4)),
  });
}

async function capture(fileName) {
  // macOS Chromium 對 masked SVG 偶爾會保留上一個 raster surface；
  // 截圖前要求完整重繪，再等待 compositor 提交新幾何。
  displayWindow.webContents.invalidate();
  await waitForCompositor();
  // 第一次 readback 同時強制清掉舊的 masked-SVG surface；
  // 不使用這張可能尚未提交完成的圖。
  await displayWindow.webContents.capturePage();
  displayWindow.webContents.invalidate();
  await waitForCompositor();
  const image = await displayWindow.webContents.capturePage();
  await fileSystem.writeFile(
    path.join(outputDirectory, fileName),
    image.toPNG(),
  );
  return image;
}

function progressLabel(progress) {
  return String(Math.round(progress * 100)).padStart(3, '0');
}

function phaseLabel(phase) {
  return String(Math.round(phase * 100)).padStart(3, '0');
}

/**
 * 把 production Animator 停在結束點，等待它既有的單一 rAF 自行收束。
 * 後續測試才可把液位與物理相位分開 seek，而不被下一個正式影格覆寫。
 */
async function stopProductionFrameLoop() {
  return waitFor(
    () => execute(`(async () => {
      const pageLayer = document.getElementById('page-layer');
      const animation = pageLayer.getAnimations().find((candidate) =>
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
      animation.currentTime = duration;
      await new Promise((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
      });
      return duration;
    })()`),
    '正式 SVG Animator 進入 deterministic seek 模式',
  );
}

/** 使用 production export 繪製指定液位與獨立物理相位。 */
async function seekLiquid(progress, timePhase = progress) {
  const result = await execute(`(async () => {
    const { renderMessageLiquidFrame } = await import(
      './message-liquid-svg.mjs'
    );
    const pageLayer = document.getElementById('page-layer');
    const animation = pageLayer.getAnimations().find((candidate) =>
      candidate.effect.getKeyframes().some((keyframe) =>
        Object.hasOwn(keyframe, '--message-liquid-level')
      )
    );
    if (!animation) {
      return false;
    }
    animation.pause();
    const duration = animation.effect.getComputedTiming().duration;
    animation.currentTime = duration * ${progress};
    const renderedCount = renderMessageLiquidFrame(pageLayer, {
      progress: ${progress},
      timeMilliseconds: duration * ${timePhase},
      durationMilliseconds: duration,
    });
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const rows = [...document.querySelectorAll('.message-row')];
    const round = (value) => Number(value.toFixed(4));
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        height: round(rect.height),
        left: round(rect.left),
        top: round(rect.top),
        width: round(rect.width),
      };
    };

    return {
      duration,
      progress: ${progress},
      timePhase: ${timePhase},
      renderedCount,
      computedLevel: getComputedStyle(pageLayer)
        .getPropertyValue('--message-liquid-level').trim(),
      rows: rows.map((row) => {
        const shell = row.querySelector('.message-glyph-shell');
        const body = row.querySelector('.message-liquid-body');
        const refraction = row.querySelector(
          '.message-liquid-refraction-primary'
        );
        const secondaryRefraction = row.querySelector(
          '.message-liquid-refraction-secondary'
        );
        const caustic = row.querySelector('.message-liquid-caustic');
        const surfaceFocus = row.querySelector(
          '.message-liquid-surface-focus'
        );
        const bubbleBodies = row.querySelector(
          '.message-liquid-bubble-bodies'
        );
        const bubbleHighlights = row.querySelector(
          '.message-liquid-bubble-highlights'
        );
        const meniscusDepth = row.querySelector(
          '.message-liquid-meniscus-depth'
        );
        const meniscus = row.querySelector('.message-liquid-meniscus');
        const outline = row.querySelector('.message-liquid-outline-glyph');
        const shellStyle = getComputedStyle(shell);
        const outlineStyle = getComputedStyle(outline);
        return {
          message: row.dataset.message,
          effect: row.dataset.liquidEffect,
          shellRect: rectOf(shell),
          shellFillColor: shellStyle.getPropertyValue(
            '-webkit-text-fill-color'
          ),
          shellStrokeColor: shellStyle.getPropertyValue(
            '-webkit-text-stroke-color'
          ),
          shellStrokeWidth: shellStyle.getPropertyValue(
            '-webkit-text-stroke-width'
          ),
          shellVisibility: shellStyle.visibility,
          outlineRect: rectOf(outline),
          outlineFillColor: outlineStyle.fill,
          outlineStrokeColor: outlineStyle.stroke,
          outlineStrokeWidth: outlineStyle.strokeWidth,
          outlineVisibility: outlineStyle.visibility,
          bodyPath: body?.getAttribute('d') ?? '',
          refractionPath: refraction?.getAttribute('d') ?? '',
          secondaryRefractionTransform:
            secondaryRefraction?.getAttribute('transform') ?? '',
          causticTransform: caustic?.getAttribute('transform') ?? '',
          surfaceFocusPath: surfaceFocus?.getAttribute('d') ?? '',
          bubbleBodyPath: bubbleBodies?.getAttribute('d') ?? '',
          bubbleHighlightPath: bubbleHighlights?.getAttribute('d') ?? '',
          meniscusDepthPath: meniscusDepth?.getAttribute('d') ?? '',
          meniscusPath: meniscus?.getAttribute('d') ?? '',
          bodyOpacity: Number(getComputedStyle(body).opacity),
          refractionOpacity: Number(getComputedStyle(refraction).opacity),
          secondaryRefractionOpacity: Number(
            getComputedStyle(secondaryRefraction).opacity
          ),
          causticOpacity: Number(getComputedStyle(caustic).opacity),
          surfaceFocusOpacity: Number(
            getComputedStyle(surfaceFocus).opacity
          ),
          bubbleBodyOpacity: Number(
            getComputedStyle(bubbleBodies).opacity
          ),
          bubbleHighlightOpacity: Number(
            getComputedStyle(bubbleHighlights).opacity
          ),
          meniscusDepthOpacity: Number(
            getComputedStyle(meniscusDepth).opacity
          ),
          meniscusOpacity: Number(getComputedStyle(meniscus).opacity),
        };
      }),
    };
  })()`);

  if (!result) {
    throw new Error('Production SVG deterministic seek 失敗。');
  }
  return result;
}

async function inspectProductionStructure() {
  return execute(`(() => {
    const rows = [...document.querySelectorAll('.message-row')];
    const describeRun = (run) => {
      const style = getComputedStyle(run);
      return {
        text: run.textContent,
        namespace: run.namespaceURI,
        isNumber: run.classList.contains('message-liquid-glyph-number'),
        x: Number(run.getAttribute('x')),
        y: Number(run.getAttribute('y')),
        textLength: Number(run.getAttribute('textLength')),
        lengthAdjust: run.getAttribute('lengthAdjust'),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontStyle: style.fontStyle,
        fontWeight: style.fontWeight,
        fontVariantNumeric: style.fontVariantNumeric,
        letterSpacing: style.letterSpacing,
      };
    };
    const describeGlyph = (glyph) => {
      if (!glyph) {
        return null;
      }
      const style = getComputedStyle(glyph);
      const bounds = glyph.getBBox();
      return {
        namespace: glyph.namespaceURI,
        message: glyph.dataset.message ?? null,
        declaredRunCount: Number(glyph.dataset.runCount ?? 0),
        text: glyph.textContent,
        fillAttribute: glyph.getAttribute('fill'),
        strokeAttribute: glyph.getAttribute('stroke'),
        strokeWidthAttribute: glyph.getAttribute('stroke-width'),
        computedFill: style.fill,
        computedStroke: style.stroke,
        computedStrokeWidth: style.strokeWidth,
        fluidBounds: {
          height: Number(glyph.dataset.fluidHeight),
          width: Number(glyph.dataset.fluidWidth),
          x: Number(glyph.dataset.fluidX),
          y: Number(glyph.dataset.fluidY),
        },
        inkBounds: {
          height: bounds.height,
          width: bounds.width,
          x: bounds.x,
          y: bounds.y,
        },
        runs: [...glyph.querySelectorAll(':scope > .message-liquid-glyph-run')]
          .map(describeRun),
      };
    };
    return {
      htmlReady: document.documentElement.dataset.displayReady,
      settingsReady: document.documentElement.dataset.settingsReady,
      stageMode: document.getElementById('display-stage').dataset.mode,
      messages: rows.map((row) => row.dataset.message),
      rowCount: rows.length,
      rows: rows.map((row) => {
        const vessel = row.querySelector('.message-vessel');
        const sizing = vessel?.querySelector('.message-glyph-sizing') ?? null;
        const shell = vessel?.querySelector('.message-glyph-shell') ?? null;
        const svg = vessel?.querySelector('.message-liquid-svg') ?? null;
        const mask = svg?.querySelector('.message-liquid-mask') ?? null;
        const canonicalGlyph = svg?.querySelector(
          'defs > .message-liquid-canonical-glyph'
        ) ?? null;
        const maskGlyph = mask?.querySelector(
          ':scope > .message-liquid-mask-glyph'
        ) ?? null;
        const outlineGlyph = svg?.querySelector(
          ':scope > .message-liquid-outline-glyph'
        ) ?? null;
        const paint = svg?.querySelector('.message-liquid-paint') ?? null;
        const optics = svg?.querySelector('.message-liquid-optics') ?? null;
        const geometry = svg?.querySelector('.message-liquid-geometry') ?? null;
        const fluidClip = svg?.querySelector(
          '.message-liquid-fluid-clip'
        ) ?? null;
        const opticalNodes = [...(svg?.querySelectorAll(
          '.message-liquid-refraction-primary, ' +
          '.message-liquid-refraction-secondary, ' +
          '.message-liquid-caustic, .message-liquid-surface-focus, ' +
          '.message-liquid-bubble-bodies, ' +
          '.message-liquid-bubble-highlights, ' +
          '.message-liquid-meniscus-depth'
        ) ?? [])];
        const wineNodes = [...(svg?.querySelectorAll(
          '.message-liquid-body, .message-liquid-refraction-primary, ' +
          '.message-liquid-refraction-secondary, ' +
          '.message-liquid-caustic, .message-liquid-surface-focus, ' +
          '.message-liquid-bubble-bodies, ' +
          '.message-liquid-bubble-highlights, ' +
          '.message-liquid-meniscus-depth, ' +
          '.message-liquid-meniscus'
        ) ?? [])];
        const maskId = mask?.id ?? null;
        const expectedMask = maskId ? 'url(#' + maskId + ')' : null;
        const fluidClipId = fluidClip?.id ?? null;
        const expectedFluidClip = fluidClipId
          ? 'url(#' + fluidClipId + ')'
          : null;
        const viewBox = svg?.viewBox.baseVal ?? null;
        const shellStyle = shell ? getComputedStyle(shell) : null;
        return {
          effect: row.dataset.liquidEffect,
          message: row.dataset.message,
          vesselCount: row.querySelectorAll('.message-vessel').length,
          sizingText: sizing?.textContent ?? null,
          shellText: shell?.textContent ?? null,
          svgCount: vessel?.querySelectorAll('.message-liquid-svg').length ?? 0,
          svgNamespace: svg?.namespaceURI ?? null,
          viewBoxWidth: viewBox?.width ?? 0,
          viewBoxHeight: viewBox?.height ?? 0,
          maskCount: svg?.querySelectorAll('.message-liquid-mask').length ?? 0,
          maskId,
          maskType: mask?.getAttribute('mask-type') ?? null,
          maskUnits: mask?.getAttribute('maskUnits') ?? null,
          maskContentUnits: mask?.getAttribute('maskContentUnits') ?? null,
          maskRegion: {
            height: Number(mask?.getAttribute('height') ?? 0),
            width: Number(mask?.getAttribute('width') ?? 0),
            x: Number(mask?.getAttribute('x') ?? 0),
            y: Number(mask?.getAttribute('y') ?? 0),
          },
          foreignObjectCount: svg?.querySelectorAll('foreignObject').length ?? 0,
          canonicalGlyphCount: svg?.querySelectorAll(
            'defs > .message-liquid-canonical-glyph'
          ).length ?? 0,
          maskGlyphCount: mask?.querySelectorAll(
            ':scope > .message-liquid-mask-glyph'
          ).length ?? 0,
          outlineGlyphCount: svg?.querySelectorAll(
            ':scope > .message-liquid-outline-glyph'
          ).length ?? 0,
          canonicalGlyph: describeGlyph(canonicalGlyph),
          maskGlyph: describeGlyph(maskGlyph),
          outlineGlyph: describeGlyph(outlineGlyph),
          htmlShellVisibility: shellStyle?.visibility ?? null,
          paintMask: paint?.getAttribute('mask') ?? null,
          expectedMask,
          geometryTransform: geometry?.getAttribute('transform') ?? null,
          fluidClipId,
          opticsClip: optics?.getAttribute('clip-path') ?? null,
          expectedFluidClip,
          opticalNodeCount: opticalNodes.length,
          allOpticalNodesClipped: opticalNodes.every(
            (node) => node.closest('.message-liquid-optics') === optics &&
              optics?.getAttribute('clip-path') === expectedFluidClip
          ),
          wineNodeCount: wineNodes.length,
          allWineNodesMasked: wineNodes.every(
            (node) => node.closest('.message-liquid-paint') === paint &&
              paint?.getAttribute('mask') === expectedMask
          ),
        };
      }),
    };
  })()`);
}

function assertProductionStructure(structure) {
  assert.equal(structure.htmlReady, 'true');
  assert.equal(structure.settingsReady, 'true');
  assert.equal(structure.stageMode, 'page');
  assert.equal(structure.rowCount, 3);
  assert.deepEqual(structure.messages, QA_MESSAGES);
  assert.equal(
    structure.rows.every((row) =>
      row.effect === 'active' &&
      row.vesselCount === 1 &&
      row.sizingText === row.message &&
      row.shellText === row.message &&
      row.svgCount === 1 &&
      row.svgNamespace === 'http://www.w3.org/2000/svg' &&
      row.viewBoxWidth > 0 &&
      row.viewBoxHeight > 0 &&
      row.maskCount === 1 &&
      row.maskType === 'alpha' &&
      row.maskUnits === 'userSpaceOnUse' &&
      row.maskContentUnits === 'userSpaceOnUse' &&
      row.maskRegion.width > 0 &&
      row.maskRegion.height > 0 &&
      row.foreignObjectCount === 0 &&
      row.canonicalGlyphCount === 1 &&
      row.maskGlyphCount === 1 &&
      row.outlineGlyphCount === 1 &&
      row.canonicalGlyph?.namespace === 'http://www.w3.org/2000/svg' &&
      row.canonicalGlyph?.message === row.message &&
      row.canonicalGlyph?.text === row.message &&
      row.canonicalGlyph?.declaredRunCount ===
        row.canonicalGlyph?.runs.length &&
      row.maskGlyph?.fillAttribute === '#ffffff' &&
      row.maskGlyph?.strokeAttribute === 'none' &&
      row.outlineGlyph?.fillAttribute === 'none' &&
      row.outlineGlyph?.strokeAttribute === '#ffffff' &&
      Number.parseFloat(row.outlineGlyph?.strokeWidthAttribute) > 0 &&
      row.htmlShellVisibility === 'hidden' &&
      row.paintMask === row.expectedMask &&
      row.fluidClipId?.startsWith('message-liquid-fluid-clip-') &&
      row.opticsClip === row.expectedFluidClip &&
      row.canonicalGlyph?.fluidBounds?.width > 0 &&
      row.canonicalGlyph?.fluidBounds?.height > 0 &&
      row.geometryTransform ===
        `translate(${row.canonicalGlyph.fluidBounds.x} ` +
          `${row.canonicalGlyph.fluidBounds.y})` &&
      row.opticalNodeCount === 7 &&
      row.allOpticalNodesClipped &&
      row.wineNodeCount === 9 &&
      row.allWineNodesMasked),
    true,
    JSON.stringify(structure.rows),
  );
  assert.equal(
    new Set(structure.rows.map(({ maskId }) => maskId)).size,
    3,
    '每一列必須取得唯一 SVG mask ID。',
  );
  const expectedRuns = [
    [
      { text: '001', isNumber: true },
      { text: '請至前廳', isNumber: false },
    ],
    [{ text: 'Nancy聯絡櫃台', isNumber: false }],
    [
      { text: 'VIP', isNumber: false },
      { text: '000', isNumber: true },
      { text: '請至前廳', isNumber: false },
    ],
  ];

  structure.rows.forEach((row, rowIndex) => {
    assert.deepEqual(row.maskGlyph.runs, row.canonicalGlyph.runs);
    assert.deepEqual(row.outlineGlyph.runs, row.canonicalGlyph.runs);
    assert.deepEqual(
      row.canonicalGlyph.runs.map(({ text, isNumber }) => ({
        text,
        isNumber,
      })),
      expectedRuns[rowIndex],
    );
    assert.equal(
      row.canonicalGlyph.runs.every((run) =>
        run.namespace === 'http://www.w3.org/2000/svg' &&
        Number.isFinite(run.x) &&
        Number.isFinite(run.y) &&
        run.y > 0 &&
        Number.isFinite(run.textLength) &&
        run.textLength > 0 &&
        run.lengthAdjust === 'spacingAndGlyphs' &&
        run.fontFamily.length > 0 &&
        run.fontSize.length > 0 &&
        run.fontWeight.length > 0),
      true,
      JSON.stringify(row.canonicalGlyph.runs),
    );
  });
}

function assertShellStability(samples) {
  const baseline = samples[0].rows;

  for (const sample of samples) {
    assert.equal(sample.renderedCount, 3);
    assert.equal(sample.rows.length, 3);
    for (let index = 0; index < sample.rows.length; index += 1) {
      const row = sample.rows[index];
      const original = baseline[index];
      assert.deepEqual(
        row.shellRect,
        original.shellRect,
        `第 ${index + 1} 列白框不得隨酒液進度位移。`,
      );
      assert.deepEqual(
        row.outlineRect,
        original.outlineRect,
        `第 ${index + 1} 列 native SVG 白框不得隨酒液進度位移。`,
      );
      assert.equal(row.shellFillColor, 'rgba(0, 0, 0, 0)');
      assert.equal(row.shellStrokeColor, 'rgb(255, 255, 255)');
      assert.ok(Number.parseFloat(row.shellStrokeWidth) > 0);
      assert.equal(row.shellVisibility, 'hidden');
      assert.equal(row.outlineFillColor, 'none');
      assert.equal(row.outlineStrokeColor, 'rgb(255, 255, 255)');
      assert.ok(Number.parseFloat(row.outlineStrokeWidth) > 0);
      assert.equal(row.outlineVisibility, 'visible');
    }
  }
}

async function prepareWineOnlyCompositor({ forceOpacity = true } = {}) {
  return execute(`(() => {
    const sentinel = 'rgb(255, 0, 255)';
    const rows = [...document.querySelectorAll('.message-row')];
    for (const row of rows) {
      const shell = row.querySelector('.message-glyph-shell');
      const outline = row.querySelector('.message-liquid-outline-glyph');
      const canvas = row.querySelector('.message-liquid-canvas');
      const body = row.querySelector('.message-liquid-body');
      const primaryRefraction = row.querySelector(
        '.message-liquid-refraction-primary'
      );
      const secondaryRefraction = row.querySelector(
        '.message-liquid-refraction-secondary'
      );
      const caustic = row.querySelector('.message-liquid-caustic');
      const surfaceFocus = row.querySelector(
        '.message-liquid-surface-focus'
      );
      const bubbleBodies = row.querySelector(
        '.message-liquid-bubble-bodies'
      );
      const bubbleHighlights = row.querySelector(
        '.message-liquid-bubble-highlights'
      );
      const meniscusDepth = row.querySelector(
        '.message-liquid-meniscus-depth'
      );
      const meniscus = row.querySelector('.message-liquid-meniscus');
      shell.style.setProperty('visibility', 'hidden');
      // SVG <text> 的 visibility 在部分 macOS compositor 仍會留下抗鋸齒邊；
      // wine-only 像素測試必須完全排除固定白框，改用 display:none。
      outline.style.setProperty('display', 'none');
      outline.style.setProperty('visibility', 'hidden');
      outline.style.setProperty('opacity', '0');
      /*
       * 正式 Renderer 已改為 cached alpha-mask Canvas；像素驗收必須直接
       * 讀它的實際酒色，不能再切回隱藏的 SVG signature 造成假通過。
       */
      if (canvas) {
        canvas.style.setProperty('display', 'block');
        continue;
      }
      body.style.setProperty('fill', sentinel);
      for (const node of [
        primaryRefraction,
        secondaryRefraction,
        caustic,
        surfaceFocus,
        bubbleBodies,
      ]) {
        node.style.setProperty('fill', sentinel);
        node.style.setProperty('mix-blend-mode', 'normal');
      }
      meniscusDepth.style.setProperty('stroke', sentinel);
      meniscusDepth.style.setProperty('mix-blend-mode', 'normal');
      meniscus.style.setProperty('stroke', sentinel);
      bubbleBodies.style.setProperty('stroke', sentinel);
      bubbleHighlights.style.setProperty('stroke', sentinel);
      if (!${forceOpacity}) {
        for (const node of [
          body,
          primaryRefraction,
          secondaryRefraction,
          caustic,
          surfaceFocus,
          bubbleBodies,
          bubbleHighlights,
          meniscusDepth,
          meniscus,
        ]) {
          node.style.setProperty(
            'opacity',
            node.getAttribute('opacity') ?? '0'
          );
        }
      }
      if (${forceOpacity}) {
        for (const node of [
          body,
          primaryRefraction,
          secondaryRefraction,
          caustic,
          surfaceFocus,
          bubbleBodies,
          bubbleHighlights,
          meniscusDepth,
          meniscus,
        ]) {
          node.style.setProperty('opacity', '1');
        }
      }
    }
    document.documentElement.style.setProperty('--viewport-background', '#000000');
    document.documentElement.style.setProperty('--display-background', '#000000');
    return rows.length;
  })()`);
}

async function prepareFullGlyphMaskCompositor() {
  return execute(`(() => {
    const rows = [...document.querySelectorAll('.message-row')];
    for (const row of rows) {
      const shell = row.querySelector('.message-glyph-shell');
      const svg = row.querySelector('.message-liquid-svg');

      // 參考遮罩必須由獨立 HTML shell 自行 rasterize，不能重用被測的
      // native SVG text mask；否則 mask 與 outline 同步漂移會造成假通過。
      svg.style.setProperty('visibility', 'hidden');
      shell.style.setProperty('visibility', 'visible');
      shell.style.setProperty('color', 'rgb(255, 0, 255)');
      shell.style.setProperty('-webkit-text-fill-color', 'rgb(255, 0, 255)');
      shell.style.setProperty('-webkit-text-stroke-width', '0');
      shell.style.setProperty('text-shadow', 'none');
    }
    return rows.length;
  })()`);
}

async function restoreCompositorStyles() {
  await execute(`(() => {
    for (const row of document.querySelectorAll('.message-row')) {
      const shell = row.querySelector('.message-glyph-shell');
      shell.style.removeProperty('visibility');
      shell.style.removeProperty('color');
      shell.style.removeProperty('-webkit-text-fill-color');
      shell.style.removeProperty('-webkit-text-stroke-width');
      shell.style.removeProperty('text-shadow');
      row.querySelector('.message-liquid-svg').style.removeProperty(
        'visibility'
      );
      row.querySelector('.message-liquid-outline-glyph').style.removeProperty(
        'display'
      );
      row.querySelector('.message-liquid-outline-glyph').style.removeProperty(
        'visibility'
      );
      row.querySelector('.message-liquid-outline-glyph').style.removeProperty(
        'opacity'
      );
      row.querySelector('.message-liquid-canvas')?.style.removeProperty(
        'display'
      );
      const body = row.querySelector('.message-liquid-body');
      const primaryRefraction = row.querySelector(
        '.message-liquid-refraction-primary'
      );
      const secondaryRefraction = row.querySelector(
        '.message-liquid-refraction-secondary'
      );
      const caustic = row.querySelector('.message-liquid-caustic');
      const surfaceFocus = row.querySelector(
        '.message-liquid-surface-focus'
      );
      const bubbleBodies = row.querySelector(
        '.message-liquid-bubble-bodies'
      );
      const bubbleHighlights = row.querySelector(
        '.message-liquid-bubble-highlights'
      );
      const meniscusDepth = row.querySelector(
        '.message-liquid-meniscus-depth'
      );
      const meniscus = row.querySelector('.message-liquid-meniscus');
      for (const node of [
        body,
        primaryRefraction,
        secondaryRefraction,
        caustic,
        surfaceFocus,
        bubbleBodies,
        bubbleHighlights,
        meniscusDepth,
        meniscus,
      ]) {
        node.style.removeProperty('opacity');
      }
      body.style.removeProperty('fill');
      for (const node of [
        primaryRefraction,
        secondaryRefraction,
        caustic,
        surfaceFocus,
        bubbleBodies,
      ]) {
        node.style.removeProperty('fill');
        node.style.removeProperty('mix-blend-mode');
      }
      meniscusDepth.style.removeProperty('stroke');
      meniscusDepth.style.removeProperty('mix-blend-mode');
      meniscus.style.removeProperty('stroke');
      bubbleBodies.style.removeProperty('stroke');
      bubbleHighlights.style.removeProperty('stroke');
    }
  })()`);
  await seekLiquid(0.5, 0.5);
}

function wineSignal(bitmap, offset) {
  const blue = bitmap[offset];
  const green = bitmap[offset + 1];
  const red = bitmap[offset + 2];
  return Math.max(0, Math.min(red, blue) - green);
}

function countWinePixels(image) {
  const bitmap = image.toBitmap();
  let count = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (wineSignal(bitmap, offset) >= WINE_SIGNAL_THRESHOLD) {
      count += 1;
    }
  }
  return count;
}

function findNearestMaskDistance(maskBitmap, x, y, width, height) {
  for (
    let distance = 1;
    distance <= MASK_DISTANCE_SEARCH_LIMIT_DEVICE_PIXELS;
    distance += 1
  ) {
    for (let deltaY = -distance; deltaY <= distance; deltaY += 1) {
      const neighbourY = y + deltaY;
      if (neighbourY < 0 || neighbourY >= height) {
        continue;
      }
      for (let deltaX = -distance; deltaX <= distance; deltaX += 1) {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) !== distance) {
          continue;
        }
        const neighbourX = x + deltaX;
        if (neighbourX < 0 || neighbourX >= width) {
          continue;
        }
        const neighbourOffset = (neighbourY * width + neighbourX) * 4;
        if (
          wineSignal(maskBitmap, neighbourOffset) >= WINE_SIGNAL_THRESHOLD
        ) {
          return distance;
        }
      }
    }
  }
  return MASK_DISTANCE_SEARCH_LIMIT_DEVICE_PIXELS + 1;
}

function compareWineToGlyphMask(wineImage, maskImage) {
  assert.deepEqual(wineImage.getSize(), maskImage.getSize());
  const wineBitmap = wineImage.toBitmap();
  const maskBitmap = maskImage.toBitmap();
  assert.equal(wineBitmap.length, maskBitmap.length);

  let winePixelCount = 0;
  let glyphMaskPixelCount = 0;
  let rawOutsidePixelCount = 0;
  let intensityDifferencePixelCount = 0;
  let overflowPixelCount = 0;
  let maximumOverflowSignal = 0;
  let maximumRawOutsideDistanceDevicePixels = 0;
  let outsideBeyondDistanceSearchLimitPixelCount = 0;
  const { width, height } = wineImage.getSize();

  for (
    let offset = 0, pixelIndex = 0;
    offset < wineBitmap.length;
    offset += 4, pixelIndex += 1
  ) {
    const wine = wineSignal(wineBitmap, offset);
    const mask = wineSignal(maskBitmap, offset);
    if (mask >= WINE_SIGNAL_THRESHOLD) {
      glyphMaskPixelCount += 1;
    }
    if (wine < WINE_SIGNAL_THRESHOLD) {
      continue;
    }
    winePixelCount += 1;
    if (wine - mask > WINE_SIGNAL_TOLERANCE) {
      intensityDifferencePixelCount += 1;
    }
    if (mask >= WINE_SIGNAL_THRESHOLD) {
      continue;
    }

    rawOutsidePixelCount += 1;
    const distance = findNearestMaskDistance(
      maskBitmap,
      pixelIndex % width,
      Math.floor(pixelIndex / width),
      width,
      height,
    );
    maximumRawOutsideDistanceDevicePixels = Math.max(
      maximumRawOutsideDistanceDevicePixels,
      distance,
    );
    if (distance > MASK_DISTANCE_SEARCH_LIMIT_DEVICE_PIXELS) {
      outsideBeyondDistanceSearchLimitPixelCount += 1;
    }

    /*
     * SVG text mask 與獨立 HTML shell 由不同 compositor 路徑 rasterize；
     * 同一輪廓在 4K 邊緣最多會落在相鄰 device pixel。只膨脹參考 mask
     * 一個實體像素，仍能抓到陰影、矩形或任何真正離開字形的酒色。
     */
    if (distance > MASK_ANTIALIAS_RADIUS_DEVICE_PIXELS) {
      overflowPixelCount += 1;
      maximumOverflowSignal = Math.max(maximumOverflowSignal, wine);
    }
  }

  return Object.freeze({
    antiAliasingToleranceDevicePixels:
      MASK_ANTIALIAS_RADIUS_DEVICE_PIXELS,
    glyphMaskPixelCount,
    intensityDifferencePixelCount,
    maximumRawOutsideDistanceDevicePixels,
    maximumOverflowSignal,
    outsideBeyondDistanceSearchLimitPixelCount,
    overflowPixelCount,
    rawOutsidePixelCount,
    distanceSearchLimitDevicePixels:
      MASK_DISTANCE_SEARCH_LIMIT_DEVICE_PIXELS,
    winePixelCount,
  });
}

function compareFullGlyphCoverage(fullWineImage, maskImage) {
  assert.deepEqual(fullWineImage.getSize(), maskImage.getSize());
  const wineBitmap = fullWineImage.toBitmap();
  const maskBitmap = maskImage.toBitmap();
  assert.equal(wineBitmap.length, maskBitmap.length);

  let glyphMaskPixelCount = 0;
  let coveredGlyphPixelCount = 0;
  for (let offset = 0; offset < maskBitmap.length; offset += 4) {
    if (wineSignal(maskBitmap, offset) < WINE_SIGNAL_THRESHOLD) {
      continue;
    }
    glyphMaskPixelCount += 1;
    if (wineSignal(wineBitmap, offset) >= WINE_SIGNAL_THRESHOLD) {
      coveredGlyphPixelCount += 1;
    }
  }

  const missingGlyphPixelCount =
    glyphMaskPixelCount - coveredGlyphPixelCount;
  const coverageRatio = glyphMaskPixelCount === 0
    ? 0
    : coveredGlyphPixelCount / glyphMaskPixelCount;
  return Object.freeze({
    coverageRatio,
    coveredGlyphPixelCount,
    glyphMaskPixelCount,
    minimumRequiredCoverageRatio: MINIMUM_FULL_GLYPH_COVERAGE_RATIO,
    missingGlyphPixelCount,
    missingRatio: 1 - coverageRatio,
  });
}

function hashPaths(rows) {
  return rows.map(({
    bodyPath,
    bubbleBodyPath,
    bubbleHighlightPath,
  }) => createHash('sha256')
    .update([bodyPath, bubbleBodyPath, bubbleHighlightPath].join('\n'))
    .digest('hex')
    .slice(0, 16));
}

/**
 * 合法上限 10,000 字的交錯數字／中文不得展開成數萬個字型 run。
 * 裝飾性酒液在此安全退回白字，完整內容與單行排版仍交給正式 Display。
 */
async function verifyPathologicalInputGuard(timers) {
  const message = '1甲'.repeat(5_000);
  const startedAt = process.hrtime.bigint();
  presentationService.startProgram({
    messages: [{ message, alignment: 'left' }],
    pageDurationSeconds: PAGE_DURATION_SECONDS,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const revision = presentationService.getSnapshot().revision;
  const inspection = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const page = document.getElementById('page-layer');
      const row = document.querySelector('.message-row');
      const vessel = row?.querySelector('.message-vessel');
      if (
        stage.dataset.revision !== '${revision}' ||
        stage.dataset.fittedRevision !== '${revision}' ||
        row?.dataset.liquidEffect !== 'static'
      ) {
        return false;
      }
      return {
        descendantElementCount: row.querySelectorAll('*').length,
        fullTextPreserved: vessel?.textContent === ${JSON.stringify(message + message)},
        inlineLiquidLevel: page.style.getPropertyValue(
          '--message-liquid-level'
        ),
        liquidAnimationCount: page.getAnimations().filter((animation) =>
          animation.effect.getKeyframes().some((keyframe) =>
            Object.hasOwn(keyframe, '--message-liquid-level')
          )
        ).length,
        liquidCompatible: vessel?.dataset.liquidCompatible ?? null,
        messageLength: [...(row.dataset.message ?? '')].length,
        numberSpanCount: row.querySelectorAll('.message-number').length,
        svgCount: row.querySelectorAll('.message-liquid-svg').length,
      };
    })()`),
    '10,000 字交錯輸入完成白字安全排版',
    20_000,
  );
  const readyLatencyMilliseconds = Number(
    process.hrtime.bigint() - startedAt,
  ) / 1_000_000;

  assert.equal(inspection.messageLength, 10_000);
  assert.equal(inspection.liquidCompatible, 'false');
  assert.equal(inspection.svgCount, 0);
  assert.equal(inspection.liquidAnimationCount, 0);
  assert.equal(inspection.inlineLiquidLevel, '');
  assert.equal(inspection.numberSpanCount, 0);
  assert.equal(inspection.fullTextPreserved, true);
  assert.ok(
    inspection.descendantElementCount <= 12,
    `極端輸入 DOM 節點過多：${inspection.descendantElementCount}`,
  );
  assert.equal(timers.active().length, 1, '白字 fallback 仍須正常建立頁面 timer');

  return Object.freeze({
    ...inspection,
    readyLatencyMilliseconds: Number(readyLatencyMilliseconds.toFixed(3)),
  });
}

/**
 * 跑馬燈每列會建立兩份無縫副本。以三列、每列剛好 128 個混合字型 run
 * 驗證最壞合法情境：6 個 native SVG／36 個酒色層仍須在真實 4K 視窗流動。
 */
async function verifyMarquee4kCadence(timers) {
  const messages = ['1甲', '2乙', '3丙'].map((pair) => pair.repeat(64));
  const startedAt = process.hrtime.bigint();
  presentationService.startProgram({
    messages: messages.map((message) => ({
      message,
      alignment: 'left',
    })),
    pageDurationSeconds: PAGE_DURATION_SECONDS,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const revision = presentationService.getSnapshot().revision;
  const inspection = await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const page = document.getElementById('page-layer');
      const rows = [...document.querySelectorAll('.message-row')];
      const svgs = [...document.querySelectorAll('.message-liquid-svg')];
      const liquidAnimations = page.getAnimations().filter((animation) =>
        animation.effect.getKeyframes().some((keyframe) =>
          Object.hasOwn(keyframe, '--message-liquid-level')
        )
      );
      if (
        stage.dataset.revision !== '${revision}' ||
        stage.dataset.fittedRevision !== '${revision}' ||
        rows.length !== 3 ||
        svgs.length !== 6 ||
        !rows.every((row) =>
          row.classList.contains('is-marquee') &&
          row.dataset.liquidEffect === 'active' &&
          row.querySelectorAll('.marquee-copy').length === 2
        ) ||
        !svgs.every((svg) =>
          Number(svg.querySelector(
            '.message-liquid-canonical-glyph'
          )?.dataset.runCount) === 128
        ) ||
        liquidAnimations.length !== 1
      ) {
        return false;
      }
      return {
        compatibleVesselCount: [...document.querySelectorAll(
          '.message-vessel[data-liquid-compatible="true"]'
        )].length,
        liquidAnimationCount: liquidAnimations.length,
        marqueeCopyCount: document.querySelectorAll('.marquee-copy').length,
        marqueeTrackCount: document.querySelectorAll('.marquee-track').length,
        maximumRunCount: Math.max(...svgs.map((svg) => Number(
          svg.querySelector('.message-liquid-canonical-glyph')
            ?.dataset.runCount ?? 0
        ))),
        messageLengths: rows.map((row) => [
          ...(row.dataset.message ?? '')
        ].length),
        svgCount: svgs.length,
        wineNodeCount: svgs.reduce((total, svg) => total +
          svg.querySelectorAll(
            '.message-liquid-body, .message-liquid-refraction-primary, ' +
            '.message-liquid-refraction-secondary, ' +
            '.message-liquid-caustic, .message-liquid-surface-focus, ' +
            '.message-liquid-bubble-bodies, ' +
            '.message-liquid-bubble-highlights, ' +
            '.message-liquid-meniscus-depth, ' +
            '.message-liquid-meniscus'
          ).length, 0),
      };
    })()`),
    '三列 128-run 跑馬燈建立六個正式 SVG',
    30_000,
  );
  const readyLatencyMilliseconds = Number(
    process.hrtime.bigint() - startedAt,
  ) / 1_000_000;

  await waitFor(
    () => Promise.resolve(timers.active().length === 1),
    '4K 跑馬燈 Main started gate 建立頁面 timer',
  );
  const performance = await measureAnimationFrameCadence();

  assert.deepEqual(inspection.messageLengths, [128, 128, 128]);
  assert.equal(inspection.marqueeTrackCount, 3);
  assert.equal(inspection.marqueeCopyCount, 6);
  assert.equal(inspection.compatibleVesselCount, 6);
  assert.equal(inspection.svgCount, 6);
  assert.equal(inspection.wineNodeCount, 54);
  assert.equal(inspection.maximumRunCount, 128);
  assert.equal(inspection.liquidAnimationCount, 1);
  assert.equal(performance.frameCount, PERFORMANCE_FRAME_COUNT - 1);

  return Object.freeze({
    ...inspection,
    performance,
    readyLatencyMilliseconds: Number(readyLatencyMilliseconds.toFixed(3)),
  });
}

async function runQaWorkflow(timers) {
  await waitFor(
    () => execute(`document.documentElement.dataset.displayReady === 'true' &&
      document.documentElement.dataset.settingsReady === 'true'`),
    '正式 Display app 與設定完成啟動',
  );

  presentationService.startProgram({
    messages: QA_MESSAGES.map((message) => ({
      message,
      alignment: 'left',
    })),
    pageDurationSeconds: PAGE_DURATION_SECONDS,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const revision = presentationService.getSnapshot().revision;

  await waitFor(
    () => execute(`(() => {
      const stage = document.getElementById('display-stage');
      const rows = [...document.querySelectorAll('.message-row')];
      const pageLayer = document.getElementById('page-layer');
      return stage.dataset.revision === '${revision}' &&
        stage.dataset.fittedRevision === '${revision}' &&
        Number(stage.dataset.layoutGeneration) >= 1 &&
        rows.length === 3 &&
        rows.every((row) =>
          row.dataset.liquidEffect === 'active' &&
          row.querySelectorAll('.message-liquid-svg').length === 1
        ) &&
        pageLayer.getAnimations().some((animation) =>
          animation.effect.getKeyframes().some((keyframe) =>
            Object.hasOwn(keyframe, '--message-liquid-level')
          )
        );
    })()`),
    '有限三列訊息完成正式 createMessageVessel／sync／ready 流程',
  );
  await waitFor(
    () => Promise.resolve(timers.active().length === 1),
    'Main 接受 ready 並建立正式頁面 timer',
  );

  const coldStartPerformance = await measureAnimationFrameCadence();
  assert.equal(
    coldStartPerformance.frameCount,
    PERFORMANCE_FRAME_COUNT - 1,
  );
  const performance = await measureAnimationFrameCadence();
  assert.equal(performance.frameCount, PERFORMANCE_FRAME_COUNT - 1);

  if (PERFORMANCE_ONLY) {
    const durationMilliseconds = await stopProductionFrameLoop();
    const checks = Object.freeze({
      real4kColdStartCadenceAcceptable:
        coldStartPerformance.p95Milliseconds <= 34 &&
        coldStartPerformance.framesOver50Milliseconds <= 2,
      real4kCadenceAcceptable:
        performance.p95Milliseconds <= 34 &&
        performance.framesOver50Milliseconds <= 2,
      noRendererErrors: rendererErrors.length === 0,
    });
    const pass = Object.values(checks).every(Boolean);
    partialReport = {
      pass,
      fixture: 'message-liquid-production-qa-performance-only',
      productionUrl: DISPLAY_URL,
      messages: QA_MESSAGES,
      durationMilliseconds,
      coldStartPerformance,
      performance,
      checks,
      rendererErrors,
    };
    await writeJson('qa-report.json', partialReport);
    assert.equal(pass, true, JSON.stringify(checks));
    return;
  }

  const durationMilliseconds = await stopProductionFrameLoop();
  assert.equal(durationMilliseconds, PAGE_DURATION_SECONDS * 1_000);

  const structure = await inspectProductionStructure();
  assertProductionStructure(structure);

  const capturedFiles = [];
  const progressSamples = [];
  const progressWinePixelCounts = [];
  for (const progress of PROGRESS_STEPS) {
    const sample = await seekLiquid(progress);
    progressSamples.push(sample);
    const fileName = `progress-${progressLabel(progress)}.png`;
    const image = await capture(fileName);
    progressWinePixelCounts.push(Object.freeze({
      progress,
      winePixelCount: countWinePixels(image),
    }));
    capturedFiles.push(fileName);
  }
  assertShellStability(progressSamples);

  const phaseSamples = [];
  for (const phase of PHASE_STEPS) {
    const sample = await seekLiquid(0.5, phase);
    phaseSamples.push(sample);
    const fileName = `phase-050-${phaseLabel(phase)}.png`;
    await capture(fileName);
    capturedFiles.push(fileName);
  }
  assertShellStability([progressSamples[0], ...phaseSamples]);
  for (let rowIndex = 0; rowIndex < QA_MESSAGES.length; rowIndex += 1) {
    const activeBubbleSamples = phaseSamples.filter(({ rows }) =>
      rows[rowIndex].bubbleBodyPath.length > 0 &&
      rows[rowIndex].bubbleHighlightPath.length > 0 &&
      rows[rowIndex].bubbleBodyOpacity > 0 &&
      rows[rowIndex].bubbleHighlightOpacity > 0);
    assert.ok(
      new Set(phaseSamples.map(({ rows }) =>
        rows[rowIndex].bodyPath)).size >= 3,
      `第 ${rowIndex + 1} 列在 50% 液位必須至少呈現三種波相。`,
    );
    assert.ok(
      activeBubbleSamples.length >= 2,
      `第 ${rowIndex + 1} 列在 50% 液位至少兩個相位需有間歇捲入的杯內氣泡。`,
    );
    assert.ok(
      new Set(activeBubbleSamples.map(({ rows }) =>
        rows[rowIndex].bubbleBodyPath)).size >= 2,
      `第 ${rowIndex + 1} 列在 50% 液位必須呈現持續變化的氣泡軌跡。`,
    );
  }

  const animationFrameFiles = [];
  for (let index = 0; index < VIDEO_FRAME_COUNT; index += 1) {
    const progress = index / (VIDEO_FRAME_COUNT - 1);
    await seekLiquid(progress);
    const fileName = `frame-${String(index).padStart(3, '0')}.png`;
    await capture(fileName);
    animationFrameFiles.push(fileName);
    capturedFiles.push(fileName);
  }

  // 0% 必須檢查使用者真正看到的 production 圖，不重著色 SVG。
  // 白色外框的 wineSignal 為 0，不會干擾酒色像素計數。
  const zeroProgressWineFile = 'progress-000.png';
  const zeroProgressWinePixelCount =
    progressWinePixelCounts[0].winePixelCount;

  await seekLiquid(0.9, 0.9);
  assert.equal(await prepareWineOnlyCompositor({ forceOpacity: false }), 3);
  const ninetyProgressWineFile = 'wine-only-progress-090.png';
  const ninetyProgressWineImage = await capture(ninetyProgressWineFile);
  capturedFiles.push(ninetyProgressWineFile);
  await restoreCompositorStyles();

  await seekLiquid(0.99, 0.99);
  assert.equal(await prepareWineOnlyCompositor({ forceOpacity: false }), 3);
  const almostFullProgressWineFile = 'wine-only-progress-099.png';
  const almostFullProgressWineImage = await capture(
    almostFullProgressWineFile,
  );
  capturedFiles.push(almostFullProgressWineFile);
  await restoreCompositorStyles();

  await seekLiquid(1, 1);
  assert.equal(await prepareWineOnlyCompositor({ forceOpacity: false }), 3);
  const fullProgressWineFile = 'wine-only-progress-100.png';
  const fullProgressWineImage = await capture(fullProgressWineFile);
  capturedFiles.push(fullProgressWineFile);
  await restoreCompositorStyles();

  await seekLiquid(0.5, 0.375);
  assert.equal(await prepareWineOnlyCompositor(), 3);
  const wineOnlyFile = 'wine-only.png';
  const wineOnlyImage = await capture(wineOnlyFile);
  capturedFiles.push(wineOnlyFile);

  assert.equal(await prepareFullGlyphMaskCompositor(), 3);
  const fullGlyphMaskFile = 'full-glyph-mask.png';
  const fullGlyphMaskImage = await capture(fullGlyphMaskFile);
  capturedFiles.push(fullGlyphMaskFile);

  const pixelContainment = compareWineToGlyphMask(
    wineOnlyImage,
    fullGlyphMaskImage,
  );
  const fullGlyphCoverage = compareFullGlyphCoverage(
    fullProgressWineImage,
    fullGlyphMaskImage,
  );
  const ninetyProgressGlyphCoverage = compareFullGlyphCoverage(
    ninetyProgressWineImage,
    fullGlyphMaskImage,
  );
  const almostFullProgressGlyphCoverage = compareFullGlyphCoverage(
    almostFullProgressWineImage,
    fullGlyphMaskImage,
  );
  await restoreCompositorStyles();

  const marquee4k = await verifyMarquee4kCadence(timers);
  const pathologicalInput = await verifyPathologicalInputGuard(timers);

  const screenshotSize = wineOnlyImage.getSize();
  const checks = Object.freeze({
    allWinePixelsInsideGlyphMask:
      pixelContainment.winePixelCount > 0 &&
      pixelContainment.overflowPixelCount === 0,
    exactMessageOrder:
      JSON.stringify(structure.messages) === JSON.stringify(QA_MESSAGES),
    noRendererErrors: rendererErrors.length === 0,
    pathologicalInputSafelyDegraded:
      pathologicalInput.liquidCompatible === 'false' &&
      pathologicalInput.svgCount === 0 &&
      pathologicalInput.liquidAnimationCount === 0 &&
      pathologicalInput.fullTextPreserved,
    real4kColdStartCadenceAcceptable:
      coldStartPerformance.p95Milliseconds <= 34 &&
      coldStartPerformance.framesOver50Milliseconds <= 2,
    real4kCadenceAcceptable:
      performance.p95Milliseconds <= 34 &&
      performance.framesOver50Milliseconds <= 2,
    real4kMarqueeCadenceAcceptable:
      marquee4k.performance.p95Milliseconds <= 34 &&
      marquee4k.performance.framesOver50Milliseconds <= 2,
    nativeGlyphClonesIdentical: structure.rows.every((row) =>
      JSON.stringify(row.maskGlyph.runs) ===
        JSON.stringify(row.canonicalGlyph.runs) &&
      JSON.stringify(row.outlineGlyph.runs) ===
        JSON.stringify(row.canonicalGlyph.runs)),
    noForeignObjectMask: structure.rows.every(
      (row) => row.foreignObjectCount === 0,
    ),
    shellColorStable: true,
    shellGeometryStable: true,
    svgStructureValid: true,
    progressCapturesMonotonic: progressWinePixelCounts.every(
      ({ winePixelCount }, index) => index === 0 ||
        winePixelCount > progressWinePixelCounts[index - 1].winePixelCount,
    ),
    zeroProgressHasNoWine: zeroProgressWinePixelCount === 0,
    fullProgressCoversGlyph:
      fullGlyphCoverage.coverageRatio >=
        MINIMUM_FULL_GLYPH_COVERAGE_RATIO,
    ninetyPercentStillVisiblyUnfilled:
      ninetyProgressGlyphCoverage.coverageRatio <=
        MAXIMUM_NINETY_PERCENT_COVERAGE_RATIO,
    onlyDeadlineReachesFullGlyph:
      almostFullProgressGlyphCoverage.coverageRatio <=
        fullGlyphCoverage.coverageRatio -
          MINIMUM_LAST_MOMENT_COVERAGE_DELTA,
    glyphMaskRasterized: pixelContainment.glyphMaskPixelCount > 0,
    uniqueMaskIds: new Set(
      structure.rows.map(({ maskId }) => maskId),
    ).size === 3,
  });
  const pass = Object.values(checks).every(Boolean) &&
    pixelContainment.winePixelCount > 0;

  partialReport = {
    pass,
    fixture: 'message-liquid-production-qa',
    productionUrl: DISPLAY_URL,
    messages: QA_MESSAGES,
    durationMilliseconds,
    coldStartPerformance,
    performance,
    marquee4k,
    pathologicalInput,
    screenshotSize,
    progressSteps: PROGRESS_STEPS,
    progressWinePixelCounts,
    phaseStepsAtHalfFill: PHASE_STEPS,
    animationFrameCount: animationFrameFiles.length,
    animationFrameFiles,
    capturedFiles,
    structure,
    shellBaseline: progressSamples[0].rows.map((row) => ({
      message: row.message,
      htmlShell: {
        rect: row.shellRect,
        fillColor: row.shellFillColor,
        strokeColor: row.shellStrokeColor,
        strokeWidth: row.shellStrokeWidth,
        visibility: row.shellVisibility,
      },
      nativeSvgOutline: {
        rect: row.outlineRect,
        fillColor: row.outlineFillColor,
        strokeColor: row.outlineStrokeColor,
        strokeWidth: row.outlineStrokeWidth,
        visibility: row.outlineVisibility,
      },
    })),
    progressPathSignatures: progressSamples.map((sample) => ({
      progress: sample.progress,
      signatures: hashPaths(sample.rows),
    })),
    halfFillPhasePathSignatures: phaseSamples.map((sample) => ({
      phase: sample.timePhase,
      signatures: hashPaths(sample.rows),
    })),
    pixelContainment,
    endpointCoverage: {
      zeroProgressWineFile,
      zeroProgressWinePixelCount,
      ninetyProgressWineFile,
      ninetyProgressGlyphCoverage,
      almostFullProgressWineFile,
      almostFullProgressGlyphCoverage,
      fullProgressWineFile,
      fullGlyphCoverage,
    },
    checks,
    rendererErrors,
  };
  await writeJson('qa-report.json', partialReport);

  assert.ok(pixelContainment.winePixelCount > 0, 'wine-only 必須包含酒色像素。');
  assert.equal(
    zeroProgressWinePixelCount,
    0,
    '0% 液位不得產生任何酒色像素。',
  );
  assert.ok(
    fullGlyphCoverage.coverageRatio >= MINIMUM_FULL_GLYPH_COVERAGE_RATIO,
    `100% 液位字形覆蓋率不足：${fullGlyphCoverage.coverageRatio}`,
  );
  assert.ok(
    ninetyProgressGlyphCoverage.coverageRatio <=
      MAXIMUM_NINETY_PERCENT_COVERAGE_RATIO,
    `90% 已過早接近滿杯：${ninetyProgressGlyphCoverage.coverageRatio}`,
  );
  assert.ok(
    almostFullProgressGlyphCoverage.coverageRatio <=
      fullGlyphCoverage.coverageRatio -
        MINIMUM_LAST_MOMENT_COVERAGE_DELTA,
    `99% 與 100% 覆蓋差距不足：${
      almostFullProgressGlyphCoverage.coverageRatio
    } / ${fullGlyphCoverage.coverageRatio}`,
  );
  assert.ok(
    pixelContainment.glyphMaskPixelCount > 0,
    '獨立完整字形 alpha 參考必須包含字形像素。',
  );
  assert.equal(
    pixelContainment.overflowPixelCount,
    0,
    `發現 ${pixelContainment.overflowPixelCount} 個字形外酒色像素。`,
  );
  assert.equal(rendererErrors.length, 0, JSON.stringify(rendererErrors));
  assert.equal(pass, true, JSON.stringify(checks));
}

async function run() {
  if (!outputDirectory) {
    throw new Error(
      `必須設定 ${OUTPUT_ENVIRONMENT_VARIABLE} 指定 QA 輸出目錄。`,
    );
  }

  await app.whenReady();
  await fileSystem.mkdir(outputDirectory, { recursive: true });
  runtimeDataRoot = path.join(
    app.getPath('temp'),
    `displaycore-message-liquid-production-qa-${process.pid}`,
  );
  await fileSystem.mkdir(runtimeDataRoot, { recursive: true });

  const initialConfig = structuredClone(defaultConfig);
  initialConfig.logo.enabled = false;
  initialConfig.logo.path = null;
  initialConfig.standby.backgroundMode = 'fixed';
  initialConfig.standby.backgroundImagePaths = [];
  initialConfig.appearance.backgroundColor = '#000000';
  initialConfig.appearance.fontColor = '#FFFFFF';
  initialConfig.appearance.messageBackgroundPreset = 'solid';
  initialConfig.appearance.fontFamily =
    '"DisplayCore Source Han Serif TC", "Noto Serif TC", serif';
  initialConfig.appearance.fontSizePercent = 100;
  initialConfig.appearance.lineSpacingPercent = 100;
  initialConfig.dateTime.enabled = false;
  // 短訊息仍是靜態三列；後段另用 128-run 長訊息觸發六 SVG 跑馬燈。
  initialConfig.marquee.enabled = true;
  initialConfig.display.renderResolution = 'auto';
  const settingsManager = createSettingsManager(initialConfig);

  const appSession = session.fromPartition(
    `displaycore-message-liquid-production-qa-${process.pid}`,
    { cache: false },
  );
  configureOfflineSession(appSession);
  appSession.protocol.handle(APP_SCHEME, createLocalProtocolHandler({
    appRoot: projectRoot,
    net,
    managedLogoDirectory: path.join(runtimeDataRoot, 'logos'),
    managedStandbyBackgroundDirectory: path.join(
      runtimeDataRoot,
      'standby-backgrounds',
    ),
    getAllowedLogoPath: () => null,
    getAllowedStandbyBackgroundPaths: () => [],
  }));

  const windowOptions = createDisplayWindowOptions({
    preloadPath: path.join(projectRoot, 'preload', 'display-preload.js'),
    session: appSession,
    windowed: true,
  });
  windowOptions.width = WINDOW_WIDTH;
  windowOptions.height = WINDOW_HEIGHT;
  displayWindow = new BrowserWindow(windowOptions);
  hardenWebContents(displayWindow.webContents);

  displayWindow.webContents.on('console-message', function handleConsoleMessage(
    _event,
    detailsOrLevel,
    legacyMessage,
  ) {
    const level = typeof detailsOrLevel === 'object'
      ? detailsOrLevel.level
      : detailsOrLevel;
    const message = typeof detailsOrLevel === 'object'
      ? detailsOrLevel.message
      : legacyMessage;
    if (level === 'error' || Number(level) >= 3) {
      rendererErrors.push(String(message));
    }
  });
  displayWindow.webContents.on('render-process-gone', (_event, details) => {
    void finish(
      1,
      '[DisplayCore QA] Renderer 意外離開。',
      new Error(details.reason),
    );
  });
  displayWindow.webContents.on(
    'did-fail-load',
    (_event, code, description) => {
      void finish(
        1,
        '[DisplayCore QA] 正式 Display 載入失敗。',
        new Error(`${code}: ${description}`),
      );
    },
  );

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
    logger: {
      error: (message) => rendererErrors.push(String(message)),
      warn: (message) => rendererErrors.push(String(message)),
    },
  });
  coordinator.register();

  timeoutHandle = setTimeout(() => {
    void finish(
      1,
      '[DisplayCore QA] Production 視覺驗收逾時。',
      new Error(`QA 超過 ${TIMEOUT_MILLISECONDS}ms。`),
    );
  }, TIMEOUT_MILLISECONDS);

  await displayWindow.loadURL(DISPLAY_URL);
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
  displayWindow.webContents.send(
    IPC_CHANNELS.DISPLAY_REFIT_REQUESTED,
    { displayEpoch: presentationService.getDisplayEpoch() },
  );

  await runQaWorkflow(timers);
  await finish(
    0,
    `[DisplayCore QA] Production 酒液驗收通過：${outputDirectory}`,
  );
}

run().catch((error) => {
  void finish(1, '[DisplayCore QA] Production 酒液驗收失敗。', error);
});
