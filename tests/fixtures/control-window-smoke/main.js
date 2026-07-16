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
const { ConfigValidationError } = require(
  path.join(projectRoot, 'config', 'config-manager'),
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
const { createControlWindowOptions } = require(
  path.join(projectRoot, 'main', 'window-options'),
);
const defaultConfig = require(path.join(projectRoot, 'config.json'));

const CONTROL_URL = 'displaycore://app/control/index.html';
const DISPLAY_URL = 'displaycore://app/display/index.html';
const ERROR_SENTINEL = 'DISPLAYCORE_INTERNAL_ERROR_TEST';
const TIMEOUT_MS = 20_000;

let controlWindow = null;
let coordinator = null;
let presentationService = null;
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
  presentationService?.dispose();

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
    rows: [...document.querySelectorAll('.current-message-row')]
      .map((element) => element.textContent),
    layout: document.getElementById('current-layout').textContent,
    page: document.getElementById('current-page-progress').textContent,
    round: document.getElementById('current-round-progress').textContent,
    revision: document.getElementById('current-revision').textContent,
    childCount: document.getElementById('current-message').children.length,
  }))()`);

  assert.deepEqual(state, expected);
}

function expectedPage(
  messages,
  revision,
  {
    pageNumber,
    pageCount,
    roundNumber,
    totalRounds,
  },
) {
  return {
    mode: 'page',
    messages: messages.map((message) => ({ message })),
    layout: 'single-line',
    pageDurationSeconds: 3,
    pageNumber,
    pageCount,
    roundNumber,
    totalRounds,
    revision,
  };
}

function expectedEmergency(code, revision) {
  return {
    mode: 'emergency',
    messages: [{ message: code }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision,
  };
}

function expectedBlank(revision) {
  return {
    mode: 'blank',
    messages: [],
    layout: 'single-line',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision,
  };
}

function createSettingsManager() {
  let pendingValidationError = null;
  let snapshot = {
    config: structuredClone(defaultConfig),
    defaults: structuredClone(defaultConfig),
    revision: 0,
    notice: null,
  };

  return {
    getSnapshot() {
      return structuredClone(snapshot);
    },
    async saveConfig(config, expectedRevision) {
      assert.equal(expectedRevision, snapshot.revision);

      if (pendingValidationError) {
        const validationError = pendingValidationError;
        pendingValidationError = null;
        throw new ConfigValidationError(validationError);
      }

      snapshot = {
        config: structuredClone(config),
        defaults: snapshot.defaults,
        revision: snapshot.revision + 1,
        notice: null,
      };
      return this.getSnapshot();
    },
    rejectNextSave(validationError) {
      pendingValidationError = validationError;
    },
  };
}

async function runSettingsWorkflow(settingsManager, presentationStore) {
  const presentationBefore = structuredClone(presentationStore.getSnapshot());
  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open &&
      document.getElementById('settings-status').textContent === '設定已載入。'
    )()`),
    '設定對話框載入',
  );

  const initial = await execute(`(() => ({
    background: document.getElementById('background-color-input').value,
    fontColor: document.getElementById('font-color-input').value,
    minimumFontSize: document.getElementById('minimum-font-size-input').value,
    dirty: document.getElementById('settings-dirty-status').textContent,
    saveDisabled: document.getElementById('save-settings-button').disabled,
  }))()`);
  assert.deepEqual(initial, {
    background: '#000000',
    fontColor: '#FFFFFF',
    minimumFontSize: '2.5',
    dirty: '所有變更皆已儲存',
    saveDisabled: true,
  });

  await click('logo-enabled-input');
  await execute(`document.getElementById('settings-form').requestSubmit()`);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('logo-path-error').hidden === false &&
      document.activeElement?.id === 'choose-logo-button'
    )()`),
    'Logo 錯誤聚焦可修正操作',
  );
  assert.equal(settingsManager.getSnapshot().revision, 0);

  await setTextInput('background-color-input', '#123456');
  await click('choose-logo-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('logo-path-input').value === 'logos/smoke-logo.png' &&
      document.getElementById('logo-enabled-input').checked
    )()`),
    'Logo 匯入結果',
  );
  assert.equal(
    await execute(`document.getElementById('background-color-picker').value`),
    '#123456',
  );
  assert.equal(
    await execute(`document.getElementById('settings-dirty-status').textContent`),
    '有未儲存變更',
  );

  await setTextInput('minimum-font-size-input', '2.6');
  await execute(`document.getElementById('settings-form').requestSubmit()`);
  await waitFor(
    () => execute(
      `document.getElementById('minimum-font-size-error').hidden === false`,
    ),
    '設定欄位錯誤',
  );
  assert.equal(settingsManager.getSnapshot().revision, 0);
  assert.equal(
    await execute(`document.getElementById('settings-dialog').open`),
    true,
  );

  await setTextInput('minimum-font-size-input', '3.25');
  settingsManager.rejectNextSave({
    code: 'VALIDATION_FAILED',
    field: 'appearance.minimumFontSizeRem',
    message: 'Main 拒絕此最小字級。',
  });
  await execute(`document.getElementById('settings-form').requestSubmit()`);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('minimum-font-size-error').textContent ===
        'Main 拒絕此最小字級。' &&
      document.getElementById('settings-form').getAttribute('aria-busy') ===
        'false' &&
      document.activeElement?.id === 'minimum-font-size-input'
    )()`),
    'Main 欄位錯誤解鎖後聚焦',
  );
  assert.equal(settingsManager.getSnapshot().revision, 0);

  await execute(`(() => {
    const dialog = document.getElementById('settings-dialog');
    const observer = new MutationObserver(() => {
      if (!dialog.open) {
        observer.disconnect();
        document.getElementById('open-settings-button').click();
      }
    });
    observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    document.getElementById('settings-form').requestSubmit();
  })()`);
  await waitFor(
    () => settingsManager.getSnapshot().revision === 1,
    '設定成功儲存',
  );

  const saved = settingsManager.getSnapshot();
  assert.equal(saved.revision, 1);
  assert.equal(saved.config.appearance.backgroundColor, '#123456');
  assert.equal(saved.config.appearance.minimumFontSizeRem, 3.25);
  assert.deepEqual(saved.config.logo, {
    enabled: true,
    path: 'logos/smoke-logo.png',
  });
  assert.deepEqual(presentationStore.getSnapshot(), presentationBefore);

  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open &&
      document.getElementById('background-color-input').value === '#123456' &&
      document.getElementById('settings-status').textContent === '設定已載入。' &&
      document.getElementById('load-defaults-button').disabled === false
    )()`),
    '重新載入已儲存設定',
  );
  await click('load-defaults-button');
  assert.equal(
    await execute(`document.getElementById('background-color-input').value`),
    '#000000',
  );
  assert.equal(
    await execute(`document.getElementById('settings-close-button').textContent`),
    '捨棄變更',
  );
  await click('settings-close-button');
  assert.equal(settingsManager.getSnapshot().revision, 1);

  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open &&
      document.getElementById('background-color-input').value === '#123456' &&
      document.getElementById('settings-status').textContent === '設定已載入。'
    )()`),
    '捨棄預設草稿後重新載入',
  );
  await click('settings-close-button');
}

function createTimerHarness() {
  const timers = [];

  return {
    setTimer(callback, delay) {
      const timer = {
        callback,
        delay,
        cleared: false,
        fired: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    fireNext(expectedDelay) {
      const timer = timers.find((candidate) =>
        !candidate.cleared && !candidate.fired,
      );
      assert.ok(timer, '應有一個等待中的翻頁 timer');
      assert.equal(timer.delay, expectedDelay);
      timer.fired = true;
      timer.callback();
    },
    activeCount() {
      return timers.filter((timer) => !timer.cleared && !timer.fired).length;
    },
  };
}

async function selectRepeatMode(mode) {
  return execute(`(() => {
    const input = document.querySelector(
      'input[name="repeat-mode"][value=${JSON.stringify(mode)}]'
    );
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked;
  })()`);
}

async function addDraftMessage({ recipient, action, customText = '' }) {
  await selectAction(action);
  await setTextInput('recipient-input', recipient);

  if (action === 'custom') {
    await setTextInput('custom-message-input', customText);
  }

  const expectedMessage = action === 'go-to-lobby'
    ? `${recipient}請至前廳`
    : action === 'lobby-code'
      ? `${recipient}前廳000`
      : `${recipient}${customText}`;

  assert.equal(
    await execute(`document.getElementById('message-preview').textContent`),
    expectedMessage,
  );

  const previousCount = Number(await execute(
    `document.getElementById('message-queue').dataset.messageCount || 0`,
  ));
  await execute(`document.getElementById('message-form').requestSubmit()`);
  await waitFor(
    () => execute(
      `Number(document.getElementById('message-queue').dataset.messageCount) === ${previousCount + 1}`,
    ),
    '訊息加入待播清單',
  );
  assert.equal(await execute('document.activeElement.id'), 'recipient-input');

  return expectedMessage;
}

async function runWorkflow(presentationStore, timers, settingsManager) {
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
      'chooseLogo',
      'clearPresentation',
      'getPresentation',
      'getSettings',
      'onPresentationChanged',
      'saveSettings',
      'showEmergency',
      'startProgram',
    ],
  });

  await runSettingsWorkflow(settingsManager, presentationStore);

  // 輸入七則完整 message；加入草稿不可提前修改 Main 畫面。
  const literalHtml =
    '公告\n<img src=x onerror="globalThis.displayCorePwned=true">';
  const messages = [];
  messages.push(await addDraftMessage({
    recipient: '001',
    action: 'go-to-lobby',
  }));
  messages.push(await addDraftMessage({
    recipient: '002',
    action: 'go-to-lobby',
  }));
  messages.push(await addDraftMessage({
    recipient: '003',
    action: 'lobby-code',
  }));
  messages.push(await addDraftMessage({
    recipient: '004',
    action: 'custom',
    customText: '請至櫃檯',
  }));
  messages.push(await addDraftMessage({
    recipient: '005',
    action: 'go-to-lobby',
  }));
  messages.push(await addDraftMessage({
    recipient: '006',
    action: 'go-to-lobby',
  }));
  messages.push(await addDraftMessage({
    recipient: '',
    action: 'custom',
    customText: literalHtml,
  }));
  assert.deepEqual(presentationStore.getSnapshot(), expectedBlank(0));

  const previewState = await execute(`(() => ({
    pageTitles: [...document.querySelectorAll('.queue-page-title')]
      .map((element) => element.textContent),
    messages: [...document.querySelectorAll('.queue-message-text')]
      .map((element) => element.textContent),
    literalChildCount: document.querySelectorAll('.queue-message-text')[6]
      .children.length,
    messageCount: document.getElementById('queue-message-count').textContent,
    pageCount: document.getElementById('queue-page-count').textContent,
    roundDuration: document.getElementById('round-duration').textContent,
    totalDuration: document.getElementById('total-duration').textContent,
    removeButtonCount: document.querySelectorAll('.queue-remove-button').length,
    pwnedType: typeof globalThis.displayCorePwned,
  }))()`);
  assert.deepEqual(previewState, {
    pageTitles: ['第 1 頁', '第 2 頁'],
    messages,
    literalChildCount: 0,
    messageCount: '7 則',
    pageCount: '2 頁',
    roundDuration: '6 秒',
    totalDuration: '6 秒',
    removeButtonCount: 7,
    pwnedType: 'undefined',
  });

  // 按索引刪除後重新加入，重複文字也不會刪錯項目。
  await execute(`document.querySelector(
    '.queue-remove-button[data-message-index="6"]'
  ).click()`);
  await waitFor(
    () => execute(
      `document.getElementById('queue-message-count').textContent === '6 則'`,
    ),
    '刪除待播訊息',
  );
  messages.pop();
  messages.push(await addDraftMessage({
    recipient: '',
    action: 'custom',
    customText: literalHtml,
  }));

  // 七則為兩頁；每頁 3 秒、10 整輪，總時間精確推算為 1 分。
  await setTextInput('round-count-input', '10');
  assert.deepEqual(
    await execute(`(() => ({
      roundDuration: document.getElementById('round-duration').textContent,
      totalDuration: document.getElementById('total-duration').textContent,
      startDisabled: document.getElementById('start-program-button').disabled,
    }))()`),
    { roundDuration: '6 秒', totalDuration: '1 分', startDisabled: false },
  );
  await execute(`(() => {
    const button = document.getElementById('start-program-button');
    button.focus();
    button.click();
  })()`);
  await waitForRevision(presentationStore, 1);
  await waitForCurrentDom(1);
  await waitForIdle();
  assert.equal(await execute('document.activeElement.id'), 'start-program-button');
  assert.deepEqual(
    presentationStore.getSnapshot(),
    expectedPage(messages.slice(0, 5), 1, {
      pageNumber: 1,
      pageCount: 2,
      roundNumber: 1,
      totalRounds: 10,
    }),
  );
  await assertCurrentDom({
    message: messages.slice(0, 5).join(''),
    rows: messages.slice(0, 5),
    layout: '單行',
    page: '第 1 / 2 頁',
    round: '第 1 / 10 輪',
    revision: '#1',
    childCount: 5,
  });

  timers.fireNext(3_000);
  await waitForRevision(presentationStore, 2);
  await waitForCurrentDom(2);
  assert.deepEqual(
    presentationStore.getSnapshot(),
    expectedPage(messages.slice(5), 2, {
      pageNumber: 2,
      pageCount: 2,
      roundNumber: 1,
      totalRounds: 10,
    }),
  );
  await assertCurrentDom({
    message: messages.slice(5).join(''),
    rows: messages.slice(5),
    layout: '單行',
    page: '第 2 / 2 頁',
    round: '第 1 / 10 輪',
    revision: '#2',
    childCount: 2,
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
  assert.equal(presentationStore.getSnapshot().revision, 2);
  await click('inspection-confirm-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('operation-error').hidden === false &&
      document.getElementById('inspection-confirm-button').disabled === false
    )()`),
    '555 失敗後恢復確認操作',
  );
  assert.equal(presentationStore.getSnapshot().revision, 2);
  assert.deepEqual(
    await execute(`(() => ({
      dialogOpen: document.getElementById('inspection-confirm-dialog').open,
      errorText: document.getElementById('operation-error').textContent,
      dialogError: document.getElementById('inspection-dialog-error').textContent,
      confirmText: document.getElementById('inspection-confirm-button').textContent,
    }))()`),
    {
      dialogOpen: true,
      errorText: '操作失敗，請稍後再試。',
      dialogError:
        '無法確認代碼是否已顯示。請先查看目前顯示狀態或電視畫面，再決定是否重試。',
      confirmText: '確認顯示 555',
    },
  );

  // 保留原本 pending code 後可直接重試，連點仍只能產生一次 revision。
  await execute(`(() => {
    const button = document.getElementById('inspection-confirm-button');
    button.click();
    button.click();
  })()`);
  await waitForRevision(presentationStore, 3);
  await waitForCurrentDom(3);
  await waitForIdle();
  assert.deepEqual(
    presentationStore.getSnapshot(),
    expectedEmergency('555', 3),
  );
  await assertCurrentDom({
    message: '555',
    rows: [],
    layout: '滿屏',
    page: '—',
    round: '—',
    revision: '#3',
    childCount: 0,
  });
  assert.equal(
    await execute(`document.getElementById('queue-message-count').textContent`),
    '7 則',
  );
  assert.equal(timers.activeCount(), 0, '滿屏必須取消原播放 timer');

  // 888 的取消流程不改狀態；再次確認才送出。
  await click('inspection-888-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('inspection-confirm-dialog').open &&
      document.getElementById('inspection-confirm-button').textContent ===
        '確認顯示 888'
    )()`),
    '開啟 888 對話框',
  );
  await execute(`(() => {
    const dialog = document.getElementById('inspection-confirm-dialog');
    const observer = new MutationObserver(() => {
      if (!dialog.open) {
        observer.disconnect();
        document.getElementById('inspection-888-button').click();
      }
    });
    observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
    document.getElementById('inspection-cancel-button').click();
  })()`);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('inspection-confirm-dialog').open &&
      document.getElementById('inspection-confirm-button').textContent ===
        '確認顯示 888'
    )()`),
    '取消後立即重新開啟 888 對話框',
  );
  assert.equal(presentationStore.getSnapshot().revision, 3);

  await click('inspection-confirm-button');
  await waitForRevision(presentationStore, 4);
  await waitForCurrentDom(4);
  await waitForIdle();
  assert.deepEqual(
    presentationStore.getSnapshot(),
    expectedEmergency('888', 4),
  );

  // 清除必須回到空白 single-line，不能把 888 誤當 clear。
  await execute(`(() => {
    const button = document.getElementById('clear-display-button');
    button.focus();
    button.click();
  })()`);
  await waitForRevision(presentationStore, 5);
  await waitForCurrentDom(5);
  await waitForIdle();
  assert.equal(
    await execute('document.activeElement.id'),
    'clear-display-button',
  );
  assert.deepEqual(presentationStore.getSnapshot(), expectedBlank(5));
  await assertCurrentDom({
    message: '目前為空白畫面',
    rows: [],
    layout: '單行',
    page: '—',
    round: '—',
    revision: '#5',
    childCount: 0,
  });

  // 清空本機草稿與清除電視是完全獨立的操作。
  await click('clear-queue-button');
  assert.deepEqual(presentationStore.getSnapshot(), expectedBlank(5));
  assert.deepEqual(
    await execute(`(() => ({
      count: document.getElementById('queue-message-count').textContent,
      emptyHidden: document.getElementById('queue-empty-state').hidden,
    }))()`),
    { count: '0 則', emptyHidden: false },
  );

  // 持續模式不得夾帶舊的 rounds，單頁也不排無意義 timer。
  await addDraftMessage({
    recipient: '',
    action: 'custom',
    customText: '公告持續顯示',
  });
  await selectRepeatMode('continuous');
  await click('start-program-button');
  await waitForRevision(presentationStore, 6);
  await waitForCurrentDom(6);
  await waitForIdle();
  assert.deepEqual(
    presentationStore.getSnapshot(),
    expectedPage(['公告持續顯示'], 6, {
      pageNumber: 1,
      pageCount: 1,
      roundNumber: null,
      totalRounds: null,
    }),
  );
  assert.equal(timers.activeCount(), 0);
  await click('clear-display-button');
  await waitForRevision(presentationStore, 7);
  await waitForCurrentDom(7);
  await waitForIdle();
  await click('clear-queue-button');

  // Main 內部例外只能顯示固定錯誤，草稿不消失也不改變畫面。
  await selectRepeatMode('finite');
  await setTextInput('round-count-input', '1');
  await addDraftMessage({
    recipient: '',
    action: 'custom',
    customText: ERROR_SENTINEL,
  });
  await click('start-program-button');
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
  assert.deepEqual(presentationStore.getSnapshot(), expectedBlank(7));
  assert.equal(
    await execute(`document.getElementById('queue-message-count').textContent`),
    '1 則',
  );
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
  const timers = createTimerHarness();
  presentationService = new PresentationService({
    store: presentationStore,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const startProgram = presentationService.startProgram.bind(
    presentationService,
  );
  const showEmergency = presentationService.showEmergency.bind(
    presentationService,
  );
  let failNextInspection = true;
  presentationService.showEmergency = (code) => {
    if (code === '555' && failNextInspection) {
      failNextInspection = false;
      throw new Error('/private/inspection.json: simulated emergency failure');
    }

    return showEmergency(code);
  };

  presentationService.startProgram = (program) => {
    if (program.messages.some(({ message }) => message === ERROR_SENTINEL)) {
      throw new Error('/private/config.json: simulated internal stack');
    }

    return startProgram(program);
  };

  const settingsManager = createSettingsManager();
  const logoImporter = {
    async chooseAndImport() {
      return {
        canceled: false,
        assetPath: 'logos/smoke-logo.png',
      };
    },
  };

  coordinator = new IpcCoordinator({
    ipcMain,
    presentationService,
    settingsManager,
    logoImporter,
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
  await runWorkflow(presentationStore, timers, settingsManager);
  finish(0, '[DisplayCore] Control window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Control window smoke test failed.', error);
});
