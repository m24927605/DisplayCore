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
const { createControlWindowOptions } = require(
  path.join(projectRoot, 'main', 'window-options'),
);

const CONTROL_URL = 'displaycore://app/control/index.html';
const DISPLAY_URL = 'displaycore://app/display/index.html';
const ERROR_SENTINEL = 'DISPLAYCORE_INTERNAL_ERROR_TEST';
const TIMEOUT_MS = 20_000;

let controlWindow = null;
let coordinator = null;
let completed = false;
let timeout = null;

// privileged scheme 必須在 ready 前註冊，與正式 composition root 相同。
registerAppScheme(protocol);

function finish(exitCode, message, error) {
  if (completed) {
    return;
  }

  completed = true;

  if (timeout) {
    clearTimeout(timeout);
  }

  coordinator?.dispose();

  if (error) {
    console.error(message, error);
  } else {
    console.info(message);
  }

  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.destroy();
  }

  app.exit(exitCode);
}

async function waitFor(predicate, description, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();

      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const error = new Error(`等待逾時：${description}`);

  if (lastError) {
    error.cause = lastError;
  }

  throw error;
}

function execute(source) {
  return controlWindow.webContents.executeJavaScript(source, true);
}

function setTextInput(elementId, value) {
  return execute(`(() => {
    const element = document.getElementById(${JSON.stringify(elementId)});
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return element.value;
  })()`);
}

function selectAction(action) {
  return execute(`(() => {
    const input = document.querySelector(
      'input[name="action"][value=${JSON.stringify(action)}]'
    );
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked;
  })()`);
}

function click(elementId) {
  return execute(`(() => {
    const element = document.getElementById(${JSON.stringify(elementId)});
    element.click();
    return true;
  })()`);
}

async function waitForRevision(store, revision) {
  await waitFor(
    () => store.getSnapshot().revision >= revision,
    `Main revision ${revision}`,
  );
  assert.equal(store.getSnapshot().revision, revision);
}

async function waitForCurrentDom(revision) {
  await waitFor(
    () => execute(
      `document.getElementById('current-revision').textContent === '#${revision}'`,
    ),
    `Control DOM revision ${revision}`,
  );
}

async function waitForIdle() {
  await waitFor(
    () => execute(`(() =>
      document.getElementById('clear-display-button').disabled === false &&
      document.getElementById('inspection-confirm-dialog').open === false
    )()`),
    'Control 操作完成',
  );
}

async function assertCurrentDom(expected) {
  const state = await execute(`(() => ({
    message: document.getElementById('current-message').textContent,
    layout: document.getElementById('current-layout').textContent,
    revision: document.getElementById('current-revision').textContent,
    childCount: document.getElementById('current-message').children.length,
  }))()`);

  assert.deepEqual(state, expected);
}

async function runWorkflow(presentationStore) {
  await waitFor(
    () => execute(
      `document.getElementById('clear-display-button').disabled === false`,
    ),
    'Control bridge 初始化',
  );

  const securityState = await execute(`(() => ({
    requireType: typeof globalThis.require,
    processType: typeof globalThis.process,
    moduleType: typeof globalThis.module,
    bufferType: typeof globalThis.Buffer,
    bridgeMethods: Object.keys(window.displayCoreControl).sort(),
  }))()`);
  assert.deepEqual(securityState, {
    requireType: 'undefined',
    processType: 'undefined',
    moduleType: 'undefined',
    bufferType: 'undefined',
    bridgeMethods: [
      'clearMessage',
      'getPresentation',
      'onPresentationChanged',
      'showMessage',
    ],
  });

  // 固定動作：001 + 請至前廳。
  await setTextInput('recipient-input', '001');
  assert.equal(
    await execute(`document.getElementById('message-preview').textContent`),
    '001請至前廳',
  );
  await click('show-message-button');
  await waitForRevision(presentationStore, 1);
  await waitForIdle();
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: '001請至前廳',
    layout: 'single-line',
    revision: 1,
  });

  // 固定動作：Nancy + 前廳000。
  await setTextInput('recipient-input', 'Nancy');
  await selectAction('lobby-code');
  assert.equal(
    await execute(`document.getElementById('message-preview').textContent`),
    'Nancy前廳000',
  );
  await click('show-message-button');
  await waitForRevision(presentationStore, 2);
  await waitForIdle();
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: 'Nancy前廳000',
    layout: 'single-line',
    revision: 2,
  });

  // 自定義內容必須保留為文字，不可建立任何 HTML 節點。
  const literalHtml = '<img src=x onerror="globalThis.displayCorePwned=true">';
  await selectAction('custom');
  await setTextInput('recipient-input', '');
  await setTextInput('custom-message-input', literalHtml);
  const previewState = await execute(`(() => ({
    text: document.getElementById('message-preview').textContent,
    childCount: document.getElementById('message-preview').children.length,
    pwnedType: typeof globalThis.displayCorePwned,
  }))()`);
  assert.deepEqual(previewState, {
    text: literalHtml,
    childCount: 0,
    pwnedType: 'undefined',
  });
  await click('show-message-button');
  await waitForRevision(presentationStore, 3);
  await waitForCurrentDom(3);
  await waitForIdle();
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: literalHtml,
    layout: 'single-line',
    revision: 3,
  });
  await assertCurrentDom({
    message: literalHtml,
    layout: '單行',
    revision: '#3',
    childCount: 0,
  });

  // 555 開啟 dialog 時尚未送出；確認後一次原子切換為滿屏。
  await click('inspection-555-button');
  const inspectionDialog = await execute(`(() => ({
    open: document.getElementById('inspection-confirm-dialog').open,
    code: document.getElementById('inspection-code-preview').textContent,
    confirmText: document.getElementById('inspection-confirm-button').textContent,
    cancelFocused: document.activeElement.id === 'inspection-cancel-button',
  }))()`);
  assert.deepEqual(inspectionDialog, {
    open: true,
    code: '555',
    confirmText: '確認顯示 555',
    cancelFocused: true,
  });
  assert.equal(presentationStore.getSnapshot().revision, 3);
  await execute(`(() => {
    const button = document.getElementById('inspection-confirm-button');
    button.click();
    button.click();
  })()`);
  await waitForRevision(presentationStore, 4);
  await waitForCurrentDom(4);
  await waitForIdle();
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: '555',
    layout: 'fill-screen',
    revision: 4,
  });

  // 888 的取消流程不改狀態；再次確認才送出。
  await click('inspection-888-button');
  await click('inspection-cancel-button');
  assert.equal(
    await execute(`document.getElementById('inspection-confirm-dialog').open`),
    false,
  );
  assert.equal(presentationStore.getSnapshot().revision, 4);

  await click('inspection-888-button');
  await click('inspection-confirm-button');
  await waitForRevision(presentationStore, 5);
  await waitForCurrentDom(5);
  await waitForIdle();
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: '888',
    layout: 'fill-screen',
    revision: 5,
  });

  // 清除必須回到空白 single-line，不能把 888 誤當 clear。
  await click('clear-display-button');
  await waitForRevision(presentationStore, 6);
  await waitForCurrentDom(6);
  await waitForIdle();
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: '',
    layout: 'single-line',
    revision: 6,
  });
  await assertCurrentDom({
    message: '目前為空白畫面',
    layout: '單行',
    revision: '#6',
    childCount: 0,
  });

  // Main 內部例外只能顯示固定錯誤，不得洩漏路徑或改變既有狀態。
  await setTextInput('custom-message-input', ERROR_SENTINEL);
  await click('show-message-button');
  await waitFor(
    () => execute(
      `document.getElementById('operation-error').hidden === false`,
    ),
    'Control 錯誤訊息',
  );
  const errorText = await execute(
    `document.getElementById('operation-error').textContent`,
  );
  assert.equal(errorText, '操作失敗，請稍後再試。');
  assert.doesNotMatch(errorText, /private|config|stack/i);
  assert.deepEqual(presentationStore.getSnapshot(), {
    message: '',
    layout: 'single-line',
    revision: 6,
  });
}

async function run() {
  await app.whenReady();

  const appSession = session.fromPartition(
    `displaycore-control-smoke-${process.pid}`,
    { cache: false },
  );
  configureOfflineSession(appSession);
  installLocalProtocol({
    protocol: appSession.protocol,
    net,
    appRoot: projectRoot,
  });

  controlWindow = new BrowserWindow(
    createControlWindowOptions({
      preloadPath: path.join(projectRoot, 'preload.js'),
      session: appSession,
      devTools: false,
    }),
  );
  hardenWebContents(controlWindow.webContents);

  const presentationStore = new PresentationStore();
  const showMessage = presentationStore.showMessage.bind(presentationStore);
  presentationStore.showMessage = (presentation) => {
    if (presentation.message === ERROR_SENTINEL) {
      throw new Error('/private/config.json: simulated internal stack');
    }

    return showMessage(presentation);
  };

  coordinator = new IpcCoordinator({
    ipcMain,
    presentationStore,
    getWindow: (role) =>
      role === IPC_ROLES.CONTROL ? controlWindow : null,
    allowedUrls: {
      [IPC_ROLES.CONTROL]: CONTROL_URL,
      [IPC_ROLES.DISPLAY]: DISPLAY_URL,
    },
    logger: {
      warn: () => {},
      error: () => {},
    },
  });
  coordinator.register();

  timeout = setTimeout(() => {
    finish(1, '[DisplayCore] Control window smoke test timed out.');
  }, TIMEOUT_MS);

  controlWindow.webContents.on('render-process-gone', (_event, details) => {
    finish(
      1,
      '[DisplayCore] Control window Renderer exited.',
      new Error(details.reason),
    );
  });
  controlWindow.webContents.on('did-fail-load', (_event, code, description) => {
    finish(
      1,
      '[DisplayCore] Control window failed to load.',
      new Error(`${code}: ${description}`),
    );
  });

  await controlWindow.loadURL(CONTROL_URL);
  await runWorkflow(presentationStore);
  finish(0, '[DisplayCore] Control window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Control window smoke test failed.', error);
});
