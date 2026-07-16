'use strict';

const assert = require('node:assert/strict');
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
const { IPC_ROLES } = require(path.join(projectRoot, 'ipc', 'channels'));
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

let displayWindow = null;
let coordinator = null;
let presentationService = null;
let completed = false;
let timeout = null;

registerAppScheme(protocol);

function finish(exitCode, message, error) {
  if (completed) {
    return;
  }

  completed = true;
  clearTimeout(timeout);
  coordinator?.dispose();
  presentationService?.dispose();

  if (error) {
    console.error(message, error);
  } else {
    console.info(message);
  }

  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.destroy();
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
  };
}

async function runWorkflow(timers) {
  await waitFor(
    () => execute(
      `document.documentElement.dataset.displayReady === 'true'`,
    ),
    'Display bridge 初始化',
  );

  const security = await execute(`(() => ({
    requireType: typeof globalThis.require,
    processType: typeof globalThis.process,
    moduleType: typeof globalThis.module,
    bridgeMethods: Object.keys(window.displayCoreDisplay).sort(),
    interactiveCount: document.querySelectorAll(
      'button,input,select,textarea,a,video,audio,[tabindex],[contenteditable]'
    ).length,
  }))()`);
  assert.deepEqual(security, {
    requireType: 'undefined',
    processType: 'undefined',
    moduleType: 'undefined',
    bridgeMethods: [
      'getPresentation',
      'getSettings',
      'onPresentationChanged',
      'onSettingsChanged',
    ],
    interactiveCount: 0,
  });

  const literalHtml = '<img src=x onerror="globalThis.displayPwned=true">\n純文字';
  const messages = [
    { message: '001請至前廳' },
    { message: '002請至前廳' },
    { message: literalHtml },
    { message: '004請至櫃檯' },
    { message: '005請至前廳' },
    { message: '006請至前廳' },
  ];
  presentationService.startProgram({
    messages,
    pageDurationSeconds: 1,
    repeat: { mode: 'finite', rounds: 1 },
  });
  await waitForRevision(1);

  const firstPage = await execute(`(() => {
    const stage = document.getElementById('display-stage');
    const rows = [...document.querySelectorAll('.message-row')];
    return {
      mode: stage.dataset.mode,
      messages: rows.map((row) => row.dataset.message),
      rowCount: rows.length,
      pageHidden: document.getElementById('page-layer').hidden,
      fillHidden: document.getElementById('fill-layer').hidden,
      whiteSpaces: rows.map((row) => getComputedStyle(row).whiteSpace),
      hasInjectedImage: Boolean(document.querySelector('.message-row img')),
      pwnedType: typeof globalThis.displayPwned,
      announcement: document.getElementById('display-announcement').textContent,
      fontSize: Number.parseFloat(
        getComputedStyle(document.getElementById('page-layer')).fontSize
      ),
      viewportHasOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth ||
        document.documentElement.scrollHeight > document.documentElement.clientHeight,
    };
  })()`);
  assert.deepEqual(firstPage, {
    mode: 'page',
    messages: messages.slice(0, 5).map(({ message }) => message),
    rowCount: 5,
    pageHidden: false,
    fillHidden: true,
    whiteSpaces: Array(5).fill('nowrap'),
    hasInjectedImage: false,
    pwnedType: 'undefined',
    announcement: messages.slice(0, 5).map(({ message }) => message).join('\n'),
    fontSize: firstPage.fontSize,
    viewportHasOverflow: false,
  });
  assert.ok(firstPage.fontSize >= 40);

  assert.equal(timers.handles[0].delay, 1_000);
  timers.fire(0);
  await waitForRevision(2);
  assert.deepEqual(
    await execute(
      `[...document.querySelectorAll('.message-row')].map((row) => row.dataset.message)`,
    ),
    ['006請至前廳'],
  );

  const longMessage = '超長訊息'.repeat(1_000);
  presentationService.startProgram({
    messages: [{ message: longMessage }],
    pageDurationSeconds: 3,
    repeat: { mode: 'continuous' },
  });
  await waitForRevision(3);
  const marquee = await execute(`(() => {
    const row = document.querySelector('.message-row');
    const copies = [...row.querySelectorAll('.marquee-copy')];
    return {
      active: row.classList.contains('is-marquee'),
      copyCount: copies.length,
      copiesMatch: copies.every((copy) => copy.textContent === ${JSON.stringify(longMessage)}),
      ariaHidden: row.querySelector('.marquee-track')?.getAttribute('aria-hidden'),
    };
  })()`);
  assert.deepEqual(marquee, {
    active: true,
    copyCount: 2,
    copiesMatch: true,
    ariaHidden: 'true',
  });

  presentationService.showEmergency('555');
  await waitForRevision(4, false);
  const inspection = await execute(`(() => ({
    mode: document.getElementById('display-stage').dataset.mode,
    pageHidden: document.getElementById('page-layer').hidden,
    fillHidden: document.getElementById('fill-layer').hidden,
    cells: [...document.querySelectorAll('.fill-cell')].map(
      (cell) => cell.textContent
    ),
    marqueeCount: document.querySelectorAll('.marquee-track').length,
    announcement: document.getElementById('display-announcement').textContent,
  }))()`);
  assert.equal(inspection.mode, 'emergency');
  assert.equal(inspection.pageHidden, true);
  assert.equal(inspection.fillHidden, false);
  assert.equal(inspection.cells.length, 24);
  assert.equal(inspection.cells.every((value) => value === '555'), true);
  assert.equal(inspection.marqueeCount, 0);
  assert.equal(inspection.announcement, '555');

  presentationService.showEmergency('888');
  await waitForRevision(5, false);
  assert.equal(
    await execute(`document.querySelector('.fill-cell').textContent`),
    '888',
  );

  presentationService.clearPresentation();
  await waitForRevision(6, false);
  assert.deepEqual(
    await execute(`(() => ({
      mode: document.getElementById('display-stage').dataset.mode,
      announcement: document.getElementById('display-announcement').textContent,
      pageChildren: document.getElementById('page-layer').children.length,
      fillChildren: document.getElementById('fill-layer').children.length,
    }))()`),
    { mode: 'blank', announcement: '', pageChildren: 0, fillChildren: 0 },
  );
}

async function run() {
  await app.whenReady();

  const appSession = session.fromPartition(
    `displaycore-display-smoke-${process.pid}`,
    { cache: false },
  );
  configureOfflineSession(appSession);
  installLocalProtocol({
    protocol: appSession.protocol,
    net,
    appRoot: projectRoot,
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
  await runWorkflow(timers);
  finish(0, '[DisplayCore] Display window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Display window smoke test failed.', error);
});
