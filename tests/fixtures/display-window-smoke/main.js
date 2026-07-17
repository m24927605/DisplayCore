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
      const normal = document.getElementById('normal-layer').getBoundingClientRect();
      const chrome = document.getElementById('display-chrome').getBoundingClientRect();
      const logo = document.getElementById('display-logo').getBoundingClientRect();
      const clock = document.getElementById('display-clock').getBoundingClientRect();
      const page = document.getElementById('page-layer').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.message-row')];
      return {
        viewport,
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

async function runWorkflow(timers, expectedLogoUrl) {
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
  assert.match(firstPage.clockDateTime, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(firstPage.fontFamily, /^Arial/i);
  assert.doesNotMatch(firstPage.logoSource, /file:|Users|userData/i);
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

  presentationService.showEmergency('555');
  await waitForRevision(5, false);
  const inspection = await execute(`(() => ({
    mode: document.getElementById('display-stage').dataset.mode,
    normalHidden: document.getElementById('normal-layer').hidden,
    chromeHidden: document.getElementById('display-chrome').hidden,
    pageHidden: document.getElementById('page-layer').hidden,
    fillHidden: document.getElementById('fill-layer').hidden,
    cells: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => cell.textContent
    ),
    marqueeCount: document.querySelectorAll('.marquee-track').length,
    announcement: document.getElementById('display-announcement').textContent,
    ariaLive: document.getElementById('display-announcement').getAttribute('aria-live'),
    backgroundColor: getComputedStyle(document.getElementById('display-stage')).backgroundColor,
    fontColor: getComputedStyle(document.getElementById('display-stage')).color,
  }))()`);
  assert.equal(inspection.mode, 'emergency');
  assert.equal(inspection.normalHidden, true);
  assert.equal(inspection.chromeHidden, true);
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
  assert.equal(standby.standbyHidden, false);
  assert.equal(standby.standbyText, '歡迎光臨');
  assert.match(standby.clockText, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(Math.abs(standby.messageCenter - standby.stageCenter) < 1);
  assert.ok(Math.abs(standby.clockCenter - standby.stageCenter) < 1);
}

async function run() {
  await app.whenReady();

  runtimeDataRoot = path.join(
    app.getPath('temp'),
    `displaycore-display-smoke-data-${process.pid}`,
  );
  const managedLogoDirectory = path.join(runtimeDataRoot, 'logos');
  await fileSystem.rm(runtimeDataRoot, { recursive: true, force: true });
  await fileSystem.mkdir(managedLogoDirectory, { recursive: true });
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

  const initialConfig = structuredClone(defaultConfig);
  initialConfig.logo = { enabled: true, path: logoAssetPath };
  initialConfig.appearance = {
    ...initialConfig.appearance,
    backgroundColor: '#102030',
    fontFamily: 'Arial, sans-serif',
    fontColor: '#F4F5F6',
    minimumFontSizeRem: 3,
  };
  initialConfig.dateTime = {
    enabled: true,
  };
  initialConfig.emergency = {
    inspectionBackgroundColor: '#7F1D1D',
    releaseBackgroundColor: '#14532D',
  };
  initialConfig.marquee = { enabled: false };
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
    getAllowedLogoPath: () => {
      const logo = settingsManager.getSnapshot().config.logo;
      return logo.enabled ? logo.path : null;
    },
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
  await runWorkflow(timers, expectedLogoUrl);
  finish(0, '[DisplayCore] Display window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Display window smoke test failed.', error);
});
