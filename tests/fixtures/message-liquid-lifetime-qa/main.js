'use strict';

const assert = require('node:assert/strict');
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
const EVIDENCE_MARKER = 'MESSAGE_LIQUID_LIFETIME_EVIDENCE ';
const OUTPUT_ENVIRONMENT_VARIABLE =
  'DISPLAYCORE_MESSAGE_LIQUID_LIFETIME_QA_DIRECTORY';
const outputDirectory = process.env[OUTPUT_ENVIRONMENT_VARIABLE]?.trim() || null;
const PAGE_DURATION_SECONDS = outputDirectory ? 4 : 2;
const TIMEOUT_MILLISECONDS = 12_000;

let displayWindow = null;
let coordinator = null;
let presentationService = null;
let timeoutHandle = null;
let completed = false;
let frameSubscriptionActive = false;
let recordingActive = false;
let lastRecordedFrameAt = null;
const recordedFrames = [];
const rendererErrors = [];

registerAppScheme(protocol);

/** 建立只供本 fixture 讀取的設定快照，不寫入使用者的 config.json。 */
function createSettingsManager() {
  const config = structuredClone(defaultConfig);
  config.logo.enabled = false;
  config.logo.path = null;
  config.standby.backgroundMode = 'fixed';
  config.standby.backgroundImagePaths = [];
  config.appearance.backgroundColor = '#000000';
  config.appearance.fontColor = '#FFFFFF';
  config.appearance.fontFamily = 'Arial, sans-serif';
  config.appearance.messageBackgroundPreset = 'solid';
  config.appearance.messageLiquidEffectEnabled = true;
  config.dateTime.enabled = false;
  config.marquee.enabled = false;
  config.display.renderResolution = 'auto';

  const snapshot = Object.freeze({
    config,
    defaults: structuredClone(config),
    revision: 0,
    notice: null,
  });

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  });
}

/**
 * 此函式會序列化後注入正式 Display Renderer。只觀察真正的 WAAPI currentTime、
 * rAF 與 DOM 移除順序，不改 currentTime、不 pause，也不呼叫任何手動 seek。
 */
function installLifetimeObserver() {
  const propertyName = '--message-liquid-level';
  const state = {
    status: 'waiting',
    restartCount: 0,
    lastUnderOne: null,
    fullBeforeRemoval: null,
    transition: null,
    failure: null,
  };
  let active = null;
  let frameHandle = null;
  let mutationObserver = null;

  function findLiquidAnimation(pageLayer) {
    return pageLayer.getAnimations().find((animation) =>
      animation.effect?.getKeyframes().some((keyframe) =>
        Object.hasOwn(keyframe, propertyName),
      ),
    ) ?? null;
  }

  function readFrame(animation, progress, source) {
    const stage = document.getElementById('display-stage');
    const pageLayer = document.getElementById('page-layer');
    const row = pageLayer.querySelector('.message-row');
    const body = row?.querySelector('.message-liquid-body') ?? null;
    const duration = Number(animation.effect.getComputedTiming().duration);

    return {
      source,
      performanceNow: performance.now(),
      wallTime: Date.now(),
      progress: Number(progress.toFixed(6)),
      currentTime: Number(Number(animation.currentTime).toFixed(3)),
      durationMilliseconds: duration,
      mode: stage.dataset.mode ?? null,
      revision: Number(stage.dataset.revision),
      layoutGeneration: Number(stage.dataset.layoutGeneration),
      rowConnected: row?.isConnected === true,
      rowCount: pageLayer.querySelectorAll('.message-row').length,
      svgCount: pageLayer.querySelectorAll('.message-liquid-svg').length,
      bodyPathPresent: Boolean(body?.getAttribute('d')),
      inlineLevel: pageLayer.style.getPropertyValue(propertyName),
      computedLevel: getComputedStyle(pageLayer)
        .getPropertyValue(propertyName)
        .trim(),
    };
  }

  function recordFull(animation, progress, source) {
    if (!active || active.animation !== animation || active.full !== null) {
      return;
    }

    const sample = readFrame(animation, progress, source);
    if (
      sample.mode !== 'page' ||
      sample.rowConnected !== true ||
      sample.svgCount < 1 ||
      sample.bodyPathPresent !== true ||
      sample.inlineLevel !== '100%'
    ) {
      return;
    }

    active.full = sample;
    state.fullBeforeRemoval = sample;
  }

  function observeAnimation(animation) {
    const stage = document.getElementById('display-stage');
    const duration = Number(animation.effect.getComputedTiming().duration);
    const currentTime = Number(animation.currentTime);
    const now = performance.now();

    active = {
      animation,
      revision: Number(stage.dataset.revision),
      layoutGeneration: Number(stage.dataset.layoutGeneration),
      durationMilliseconds: duration,
      estimatedStartedAt: now - (Number.isFinite(currentTime) ? currentTime : 0),
      lastUnderOne: null,
      full: null,
    };
    state.restartCount += 1;
    state.lastUnderOne = null;
    state.fullBeforeRemoval = null;

    Promise.resolve(animation.finished).then(
      () => {
        if (!active || active.animation !== animation) {
          return;
        }
        const resolvedDuration = active.durationMilliseconds;
        const progress = Number(animation.currentTime) / resolvedDuration;
        recordFull(animation, Math.min(1, progress), 'waapi-finished');
      },
      () => {
        // refit 或換頁取消舊 WAAPI 是正式流程；新 animation 會建立新觀察世代。
      },
    );
  }

  function recordTransition(source) {
    if (!active || state.status !== 'waiting') {
      return false;
    }

    const stage = document.getElementById('display-stage');
    const pageLayer = document.getElementById('page-layer');
    const revision = Number(stage.dataset.revision);
    if (stage.dataset.mode === 'page' && revision === active.revision) {
      return false;
    }

    state.transition = {
      source,
      performanceNow: performance.now(),
      wallTime: Date.now(),
      mode: stage.dataset.mode ?? null,
      revision,
      previousRevision: active.revision,
      previousLayoutGeneration: active.layoutGeneration,
      rowCount: pageLayer.querySelectorAll('.message-row').length,
      liquidAnimationCount: pageLayer.getAnimations().filter((animation) =>
        animation.effect?.getKeyframes().some((keyframe) =>
          Object.hasOwn(keyframe, propertyName),
        ),
      ).length,
      svgCount: pageLayer.querySelectorAll('.message-liquid-svg').length,
    };
    state.lastUnderOne = active.lastUnderOne;
    state.fullBeforeRemoval = active.full;

    if (active.lastUnderOne === null || active.full === null) {
      state.status = 'failed';
      state.failure = '訊息移除前沒有同一 layout 的未滿影格與 100% 可見終幀。';
    } else {
      state.status = 'complete';
    }

    mutationObserver?.disconnect();
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    return true;
  }

  function sample() {
    if (state.status !== 'waiting') {
      return;
    }

    if (recordTransition('animation-frame')) {
      return;
    }

    const stage = document.getElementById('display-stage');
    const pageLayer = document.getElementById('page-layer');
    const animation = findLiquidAnimation(pageLayer);
    if (stage.dataset.mode === 'page' && animation !== null) {
      if (active?.animation !== animation) {
        observeAnimation(animation);
      }

      const duration = Number(animation.effect.getComputedTiming().duration);
      const currentTime = Number(animation.currentTime);
      if (
        active?.animation === animation &&
        Number.isFinite(duration) &&
        duration > 0 &&
        Number.isFinite(currentTime)
      ) {
        const progress = Math.min(1, Math.max(0, currentTime / duration));
        if (progress < 1) {
          const underOne = readFrame(animation, progress, 'animation-frame');
          active.lastUnderOne = underOne;
          state.lastUnderOne = underOne;
        } else {
          recordFull(animation, progress, 'animation-frame');
        }
      }
    }

    frameHandle = requestAnimationFrame(sample);
  }

  mutationObserver = new MutationObserver(() => {
    recordTransition('mutation-observer');
  });
  mutationObserver.observe(document.getElementById('display-stage'), {
    attributes: true,
    attributeFilter: ['data-mode', 'data-revision'],
    childList: true,
    subtree: true,
  });
  frameHandle = requestAnimationFrame(sample);
  window.__displayCoreLiquidLifetimeEvidence = state;
  return true;
}

async function startRealCompositorRecording() {
  if (!outputDirectory) {
    return;
  }

  await fileSystem.mkdir(outputDirectory, { recursive: true });
  recordedFrames.length = 0;
  lastRecordedFrameAt = null;
  recordingActive = true;
  frameSubscriptionActive = true;
  displayWindow.webContents.beginFrameSubscription(false, (image) => {
    if (!recordingActive || image.isEmpty() || recordedFrames.length >= 300) {
      return;
    }
    const capturedAtMonotonicNanoseconds = process.hrtime.bigint();
    if (
      lastRecordedFrameAt !== null &&
      capturedAtMonotonicNanoseconds - lastRecordedFrameAt < 30_000_000n
    ) {
      return;
    }
    lastRecordedFrameAt = capturedAtMonotonicNanoseconds;
    recordedFrames.push({
      capturedAtMonotonicNanoseconds,
      capturedAtWallTime: Date.now(),
      jpeg: image.toJPEG(88),
      size: image.getSize(),
    });
  });
}

async function stopRealCompositorRecording({
  fullWallTime = null,
  transitionWallTime = null,
} = {}) {
  if (!outputDirectory) {
    return null;
  }

  recordingActive = false;
  if (frameSubscriptionActive) {
    displayWindow.webContents.endFrameSubscription();
    frameSubscriptionActive = false;
  }

  const firstTimestamp = recordedFrames[0]?.capturedAtMonotonicNanoseconds;
  const frameMetadata = [];
  for (let index = 0; index < recordedFrames.length; index += 1) {
    const frame = recordedFrames[index];
    const fileName = `real-frame-${String(index).padStart(4, '0')}.jpg`;
    await fileSystem.writeFile(path.join(outputDirectory, fileName), frame.jpeg);
    frameMetadata.push({
      fileName,
      capturedAtWallTime: frame.capturedAtWallTime,
      elapsedMilliseconds: firstTimestamp === undefined
        ? 0
        : Number(
          frame.capturedAtMonotonicNanoseconds - firstTimestamp,
        ) / 1_000_000,
      size: frame.size,
    });
  }

  const elapsedMilliseconds = frameMetadata.at(-1)?.elapsedMilliseconds ?? 0;
  const averageFramesPerSecond = elapsedMilliseconds > 0
    ? (Math.max(0, frameMetadata.length - 1) * 1_000) / elapsedMilliseconds
    : 0;
  const fullEndpointFrames = Number.isFinite(fullWallTime) &&
    Number.isFinite(transitionWallTime)
    ? frameMetadata.filter((frame) =>
      frame.capturedAtWallTime >= fullWallTime &&
      frame.capturedAtWallTime <= transitionWallTime)
    : [];
  const summary = {
    captureKind: 'electron-beginFrameSubscription',
    frameCount: frameMetadata.length,
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(3)),
    averageFramesPerSecond: Number(averageFramesPerSecond.toFixed(3)),
    endpointWindow: {
      fullWallTime,
      transitionWallTime,
    },
    fullEndpointFrameCount: fullEndpointFrames.length,
    fullEndpointFrameFiles: fullEndpointFrames.map(({ fileName }) => fileName),
    frames: frameMetadata,
  };
  await fileSystem.writeFile(
    path.join(outputDirectory, 'real-recording.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  return summary;
}

async function waitForRenderer(expression, label, timeoutMilliseconds = 8_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await displayWindow.webContents.executeJavaScript(
      expression,
      true,
    );
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待 ${label} 逾時。`);
}

async function cleanup() {
  clearTimeout(timeoutHandle);
  coordinator?.dispose();
  presentationService?.dispose();

  recordingActive = false;
  if (
    frameSubscriptionActive &&
    displayWindow &&
    !displayWindow.isDestroyed()
  ) {
    displayWindow.webContents.endFrameSubscription();
    frameSubscriptionActive = false;
  }

  if (displayWindow?.webContents.debugger.isAttached()) {
    try {
      displayWindow.webContents.debugger.detach();
    } catch {
      // Renderer 已離開時不覆蓋真正的測試結果。
    }
  }
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.destroy();
  }
}

async function finish(exitCode, message, error = null) {
  if (completed) {
    return;
  }
  completed = true;
  await cleanup();

  if (error) {
    console.error(message, error);
  } else {
    console.info(message);
  }
  app.exit(exitCode);
}

async function run() {
  await app.whenReady();

  const settingsManager = createSettingsManager();
  const appSession = session.fromPartition(
    `displaycore-message-liquid-lifetime-${process.pid}`,
    { cache: false },
  );
  configureOfflineSession(appSession);
  appSession.protocol.handle(APP_SCHEME, createLocalProtocolHandler({
    appRoot: projectRoot,
    net,
    managedLogoDirectory: path.join(app.getPath('temp'), 'unused-logos'),
    managedStandbyBackgroundDirectory: path.join(
      app.getPath('temp'),
      'unused-standby-backgrounds',
    ),
    getAllowedLogoPath: () => null,
    getAllowedStandbyBackgroundPaths: () => [],
  }));

  const windowOptions = createDisplayWindowOptions({
    preloadPath: path.join(projectRoot, 'preload', 'display-preload.js'),
    session: appSession,
    windowed: true,
  });
  if (outputDirectory) {
    // 即時影片使用 720p／30fps；4K 畫質與效能另由 production QA 驗證。
    // 這裡優先避免錄影壓縮反向阻塞被測動畫的正式計時。
    windowOptions.width = 1_280;
    windowOptions.height = 720;
  }
  displayWindow = new BrowserWindow(windowOptions);
  hardenWebContents(displayWindow.webContents);

  presentationService = new PresentationService({
    store: new PresentationStore(),
  });
  const mainStarted = [];
  let mainBlank = null;
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
      error: (...values) => rendererErrors.push(values.map(String).join(' ')),
      warn: (...values) => rendererErrors.push(values.map(String).join(' ')),
    },
  });

  const reportPageProgress = coordinator.reportPageProgress.bind(coordinator);
  coordinator.reportPageProgress = (event, payload) => {
    const response = reportPageProgress(event, payload);
    if (
      payload?.phase === 'started' &&
      response?.ok === true &&
      response.data?.accepted === true
    ) {
      mainStarted.push({
        revision: payload.revision,
        layoutGeneration: payload.layoutGeneration,
        wallTime: Date.now(),
        monotonicTime: process.hrtime.bigint(),
      });
    }
    return response;
  };
  presentationService.subscribe((snapshot) => {
    if (snapshot.mode === 'blank' && snapshot.revision > 0) {
      mainBlank = {
        revision: snapshot.revision,
        wallTime: Date.now(),
        monotonicTime: process.hrtime.bigint(),
      };
    }
  });
  coordinator.register();

  timeoutHandle = setTimeout(() => {
    void finish(
      1,
      '[DisplayCore Lifetime QA] 真實頁面生命週期驗收逾時。',
    );
  }, TIMEOUT_MILLISECONDS);

  displayWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      rendererErrors.push(String(details.message));
    }
  });
  displayWindow.webContents.on('render-process-gone', (_event, details) => {
    void finish(
      1,
      '[DisplayCore Lifetime QA] Renderer 意外離開。',
      new Error(details.reason),
    );
  });
  displayWindow.webContents.on('did-fail-load', (_event, code, description) => {
    void finish(
      1,
      '[DisplayCore Lifetime QA] Display 載入失敗。',
      new Error(`${code}: ${description}`),
    );
  });

  await displayWindow.loadURL(DISPLAY_URL);
  displayWindow.showInactive();
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

  await waitForRenderer(
    "document.documentElement.dataset.displayReady === 'true' && " +
      "document.documentElement.dataset.settingsReady === 'true'",
    '正式 Display 與設定啟動',
  );
  assert.equal(
    await displayWindow.webContents.executeJavaScript(
      `(${installLifetimeObserver.toString()})()`,
      true,
    ),
    true,
  );
  await startRealCompositorRecording();

  presentationService.startProgram({
    messages: [{ message: '001聯絡櫃台', alignment: 'left' }],
    pageDurationSeconds: PAGE_DURATION_SECONDS,
    repeat: { mode: 'finite', rounds: 1 },
  });
  const pageRevision = presentationService.getSnapshot().revision;

  const rendererEvidence = await waitForRenderer(
    `(() => {
      const evidence = window.__displayCoreLiquidLifetimeEvidence;
      if (evidence?.status !== 'complete' && evidence?.status !== 'failed') {
        return false;
      }
      return JSON.parse(JSON.stringify(evidence));
    })()`,
    '酒液滿杯後才移除訊息的 Renderer 證據',
  );
  assert.equal(rendererEvidence.status, 'complete', JSON.stringify(rendererEvidence));
  assert.equal(rendererEvidence.failure, null);
  assert.equal(rendererErrors.length, 0, JSON.stringify(rendererErrors));
  assert.equal(rendererEvidence.lastUnderOne.revision, pageRevision);
  assert.equal(rendererEvidence.lastUnderOne.progress < 1, true);
  assert.ok(
    rendererEvidence.lastUnderOne.progress >= 0.85,
    `缺少接近頁面終點的未滿影格：${JSON.stringify(rendererEvidence)}`,
  );
  assert.equal(rendererEvidence.fullBeforeRemoval.revision, pageRevision);
  assert.equal(rendererEvidence.fullBeforeRemoval.progress, 1);
  assert.equal(rendererEvidence.fullBeforeRemoval.mode, 'page');
  assert.equal(rendererEvidence.fullBeforeRemoval.rowConnected, true);
  assert.equal(rendererEvidence.fullBeforeRemoval.rowCount, 1);
  assert.equal(rendererEvidence.fullBeforeRemoval.svgCount, 1);
  assert.equal(rendererEvidence.fullBeforeRemoval.bodyPathPresent, true);
  assert.equal(rendererEvidence.fullBeforeRemoval.inlineLevel, '100%');
  assert.equal(rendererEvidence.transition.mode, 'blank');
  assert.equal(rendererEvidence.transition.previousRevision, pageRevision);
  assert.equal(rendererEvidence.transition.rowCount, 0);
  assert.equal(rendererEvidence.transition.svgCount, 0);
  assert.equal(rendererEvidence.transition.liquidAnimationCount, 0);

  const fullDelay = rendererEvidence.fullBeforeRemoval.performanceNow -
    rendererEvidence.lastUnderOne.performanceNow;
  const removalDelay = rendererEvidence.transition.performanceNow -
    rendererEvidence.fullBeforeRemoval.performanceNow;
  assert.ok(fullDelay >= 0 && fullDelay <= 150, `終幀取樣間距異常：${fullDelay}ms`);
  assert.ok(
    removalDelay >= 0 && removalDelay <= 350,
    `100% 終幀與訊息移除未落在同一頁面結束區間：${removalDelay}ms`,
  );

  const acceptedStart = mainStarted.findLast((entry) =>
    entry.revision === pageRevision &&
    entry.layoutGeneration ===
      rendererEvidence.fullBeforeRemoval.layoutGeneration,
  );
  assert.ok(
    acceptedStart,
    JSON.stringify(mainStarted.map(({ monotonicTime: _time, ...entry }) => entry)),
  );
  assert.ok(mainBlank, 'Main 未發布有限頁結束後的 blank snapshot。');
  const mainLifetimeMilliseconds = Number(
    mainBlank.monotonicTime - acceptedStart.monotonicTime,
  ) / 1_000_000;
  assert.ok(
    mainLifetimeMilliseconds >= PAGE_DURATION_SECONDS * 1_000 - 50,
    `Main 提早結束頁面：${mainLifetimeMilliseconds}ms`,
  );
  assert.ok(
    mainLifetimeMilliseconds <= PAGE_DURATION_SECONDS * 1_000 + 750,
    `Main 實際頁面 timer 過度延遲：${mainLifetimeMilliseconds}ms`,
  );

  const evidence = {
    timerKind: 'real',
    manualSeekUsed: false,
    configuredDurationMilliseconds: PAGE_DURATION_SECONDS * 1_000,
    mainLifetimeMilliseconds: Number(mainLifetimeMilliseconds.toFixed(3)),
    restartCount: rendererEvidence.restartCount,
    lastUnderOne: rendererEvidence.lastUnderOne,
    fullBeforeRemoval: rendererEvidence.fullBeforeRemoval,
    transition: rendererEvidence.transition,
  };
  evidence.recording = await stopRealCompositorRecording({
    fullWallTime: rendererEvidence.fullBeforeRemoval.wallTime,
    transitionWallTime: rendererEvidence.transition.wallTime,
  });
  if (evidence.recording) {
    assert.ok(
      evidence.recording.fullEndpointFrameCount >= 1,
      '真實 compositor 錄影沒有捕捉到 100% 滿杯且尚未移除的影格。',
    );
    await fileSystem.writeFile(
      path.join(outputDirectory, 'lifetime-evidence.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
      'utf8',
    );
  }
  await finish(0, `${EVIDENCE_MARKER}${JSON.stringify(evidence)}`);
}

run().catch((error) => {
  void finish(1, '[DisplayCore Lifetime QA] 驗收失敗。', error);
});

app.on('window-all-closed', () => {
  if (!completed) {
    void finish(1, '[DisplayCore Lifetime QA] Display 視窗提早關閉。');
  }
});
