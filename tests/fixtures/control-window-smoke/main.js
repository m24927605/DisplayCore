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
const { createControlWindowOptions } = require(
  path.join(projectRoot, 'main', 'window-options'),
);
const defaultConfig = require(path.join(projectRoot, 'config.json'));

const CONTROL_URL = 'displaycore://app/control/index.html';
const DISPLAY_URL = 'displaycore://app/display/index.html';
const TIMEOUT_MS = 20_000;

let controlWindow = null;
let coordinator = null;
let presentationService = null;
let completed = false;
let timeout = null;

// privileged scheme 必須在 app ready 前註冊，與正式 composition root 相同。
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

function click(elementId) {
  return execute(`(() => {
    const element = document.getElementById(${JSON.stringify(elementId)});
    if (!element) throw new Error('找不到元素：${elementId}');
    element.click();
    return true;
  })()`);
}

function setInput(elementId, value) {
  return execute(`(() => {
    const element = document.getElementById(${JSON.stringify(elementId)});
    if (!element) throw new Error('找不到元素：${elementId}');
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return element.value;
  })()`);
}

function selectRadio(name, value) {
  return execute(`(() => {
    const input = document.querySelector(
      'input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]'
    );
    if (!input) throw new Error('找不到 radio：${name}/${value}');
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked;
  })()`);
}

async function waitForRevision(store, revision) {
  await waitFor(
    () => store.getControlSnapshot().revision === revision,
    `Main presentation revision ${revision}`,
  );
}

async function waitForLiveMessages(expectedMessages, expectedSummary) {
  await waitFor(
    () => execute(`(() => {
      const messages = [...document.querySelectorAll(
        '#live-message-list .current-message-text'
      )]
        .map((element) => element.textContent);
      return JSON.stringify(messages) === ${JSON.stringify(
        JSON.stringify(expectedMessages),
      )} &&
        document.getElementById('live-page-summary').textContent ===
          ${JSON.stringify(expectedSummary)};
    })()`),
    `電視目前內容 ${expectedMessages.join('、') || '空白'}`,
  );
}

function readCurrentDom() {
  return execute(`(() => ({
    liveSummary: document.getElementById('live-page-summary').textContent,
    liveMessages: [...document.querySelectorAll(
      '#live-message-list .current-message-text'
    )]
      .map((element) => element.textContent),
    displaySummary: document.getElementById('display-list-summary').textContent,
    displayMessages: [...document.querySelectorAll(
      '#display-message-list .current-message-text'
    )]
      .map((element) => element.textContent),
    displayIndices: [...document.querySelectorAll(
      '#display-message-list .current-message-index'
    )]
      .map((element) => element.textContent),
    removeIndices: [...document.querySelectorAll(
      '#display-message-list .current-remove-button'
    )]
      .map((element) => element.dataset.messageIndex),
    liveEmptyHidden: document.getElementById('live-empty-state').hidden,
    liveListHidden: document.getElementById('live-message-list').hidden,
    displayEmptyHidden:
      document.getElementById('display-list-empty-state').hidden,
    displayListHidden: document.getElementById('display-message-list').hidden,
    previousDisabled: document.getElementById('display-list-prev').disabled,
    nextDisabled: document.getElementById('display-list-next').disabled,
    clearDisabled: document.getElementById('clear-display-button').disabled,
    status: document.getElementById('operation-status').textContent,
    errorHidden: document.getElementById('operation-error').hidden,
    error: document.getElementById('operation-error').textContent,
  }))()`);
}

function createTopologySnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    topologyStatus: 'ready',
    hdmiConnectionStatus: 'connected',
    displays: [{
      id: 1,
      label: '操作電腦螢幕',
      width: 1920,
      height: 1080,
      scaleFactor: 1,
      isPrimary: true,
      isInternal: true,
    }, {
      id: 2,
      label: '前廳電視',
      width: 3840,
      height: 2160,
      scaleFactor: 1.5,
      isPrimary: false,
      isInternal: false,
    }],
    effectiveDisplayId: 2,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    secondDisplayConnected: true,
    configRevision: 0,
    revision: 0,
    ...overrides,
  };
}

function createPlacementStatus(overrides = {}) {
  return {
    status: 'applied',
    displayId: 2,
    fullscreen: true,
    revision: 0,
    ...overrides,
  };
}

class FakeOutputService {
  constructor(snapshot, getterName) {
    this.snapshot = snapshot;
    this.getterName = getterName;
    this.listeners = new Set();
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  getStatus() {
    return structuredClone(this.snapshot);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function createSettingsManager() {
  const listeners = new Set();
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
      snapshot = {
        config: structuredClone(config),
        defaults: snapshot.defaults,
        revision: snapshot.revision + 1,
        notice: null,
      };

      for (const listener of listeners) {
        listener(this.getSnapshot());
      }
      return this.getSnapshot();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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

/** Control-only fixture 沒有 Display Window，因此明確模擬靜態頁完成 layout。 */
function reportStaticDisplayReady(layoutGeneration, settingsRevision) {
  const snapshot = presentationService.getSnapshot();
  assert.equal(snapshot.mode, 'page');
  assert.equal(
    presentationService.reportPageProgress({
      rendererId: 1_001,
      phase: 'ready',
      displayEpoch: presentationService.getDisplayEpoch(),
      revision: snapshot.revision,
      pageNumber: snapshot.pageNumber,
      settingsRevision,
      layoutGeneration,
      marqueeCount: 0,
    }),
    true,
  );
}

async function openPlaybackSettings(settingsManager) {
  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open &&
      document.getElementById('settings-status').textContent === '設定已載入。'
    )()`),
    '設定對話框載入',
  );

  const settingsShape = await execute(`(() => ({
    pageDuration: document.getElementById('page-duration-input').value,
    rounds: document.getElementById('round-count-input').value,
    finiteChecked: document.querySelector(
      'input[name="repeat-mode"][value="finite"]'
    ).checked,
    hasManualDisplay: document.getElementById('display-manual-input') !== null,
    hasDisplaySelect: document.getElementById('default-display-select') !== null,
    hasFullscreenToggle:
      document.getElementById('display-fullscreen-input') !== null,
    fontSizePercent: document.getElementById('font-size-percent-input').value,
    lineSpacingPercent:
      document.getElementById('line-spacing-percent-input').value,
    inspectionBackground:
      document.getElementById('inspection-background-color-input').value,
    releaseBackground:
      document.getElementById('release-background-color-input').value,
    standbyBackgroundPath:
      document.getElementById('standby-background-path-input').value,
    hasHour12: document.getElementById('hour12-input') !== null,
    clockTimeUses24HourFormat: /^(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d$/.test(
      document.getElementById('clock-time-input').value
    ),
    clockTimeInputType: document.getElementById('clock-time-input').type,
    renderResolution:
      document.getElementById('render-resolution-select').value,
    renderResolutionOptions: [...document.getElementById(
      'render-resolution-select'
    ).options].map(({ value }) => value),
  }))()`);
  assert.deepEqual(settingsShape, {
    pageDuration: '3',
    rounds: '1',
    finiteChecked: true,
    hasManualDisplay: false,
    hasDisplaySelect: false,
    hasFullscreenToggle: false,
    fontSizePercent: '100',
    lineSpacingPercent: '100',
    inspectionBackground: '#000000',
    releaseBackground: '#000000',
    standbyBackgroundPath: '',
    hasHour12: false,
    clockTimeUses24HourFormat: true,
    clockTimeInputType: 'text',
    renderResolution: 'auto',
    renderResolutionOptions: [
      'auto',
      '1366x768',
      '1600x900',
      '1920x1080',
      '2560x1440',
      '3840x2160',
    ],
  });

  // 原生檔案選擇取消後，焦點必須回到原按鈕，鍵盤操作才不會掉回 body。
  await execute(`(() => {
    const button = document.getElementById('choose-logo-button');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-status').textContent ===
        '已取消選擇 Logo。' &&
      document.getElementById('settings-form').getAttribute('aria-busy') ===
        'false' &&
      document.activeElement?.id === 'choose-logo-button'
    )()`),
    '取消選擇 Logo 後恢復原按鈕焦點',
  );

  // 待機背景以獨立原生選檔匯入，成功後只回傳受管理識別。
  await execute(`(() => {
    const button = document.getElementById('choose-standby-background-button');
    button.focus();
    button.click();
  })()`);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-status').textContent ===
        '待機背景圖片已匯入；儲存設定後才會採用。' &&
      document.getElementById('standby-background-path-input').value ===
        'standby-backgrounds/abcdefabcdefabcdefabcdef.png' &&
      document.getElementById('settings-dirty-status').textContent ===
        '有未儲存變更' &&
      document.activeElement?.id === 'choose-standby-background-button'
    )()`),
    '匯入待機背景並恢復按鈕焦點',
  );

  await setInput('page-duration-input', '4');
  await setInput('round-count-input', '2');

  // Regression: ISSUE-001 — 播放設定變更未被納入系統設定 dirty state。
  // Found by /qa on 2026-07-17
  // Report: .gstack/qa-reports/qa-report-displaycore-electron-2026-07-17.md
  await waitFor(
    () => execute(`(() =>
      document.getElementById('save-settings-button').disabled === false &&
      document.getElementById('settings-dirty-status').textContent ===
        '有未儲存變更'
    )()`),
    '播放設定變更啟用儲存按鈕',
  );

  // 在播放數字欄按 Enter 不應誤存系統設定或關閉對話框。
  await execute(`document.getElementById('settings-form').requestSubmit()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    await execute(`document.getElementById('settings-dialog').open`),
    true,
  );
  assert.equal(settingsManager.getSnapshot().revision, 0);

  // 新錯誤必須取代先前的成功／取消狀態，避免同時顯示矛盾回饋。
  await setInput('background-color-input', '#12345');
  await waitFor(
    () => execute(`document.getElementById('save-settings-button').disabled === false`),
    '無效外觀草稿仍可觸發本機驗證',
  );
  await click('save-settings-button');
  await waitFor(
    () => execute(`document.getElementById('settings-error').hidden === false`),
    '顯示背景色碼錯誤',
  );
  assert.deepEqual(await execute(`(() => ({
    status: document.getElementById('settings-status').textContent,
    error: document.getElementById('settings-error').textContent,
  }))()`), {
    status: '',
    error: '請輸入六位十六進位色碼，例如 #FFFFFF。',
  });
  assert.equal(settingsManager.getSnapshot().revision, 0);

  // 只有明確按下儲存按鈕，才可儲存 Logo／外觀類系統設定。
  await setInput('background-color-input', '#123456');
  await waitFor(
    () => execute(`document.getElementById('save-settings-button').disabled === false`),
    '啟用儲存設定按鈕',
  );
  await click('save-settings-button');
  await waitFor(
    () => settingsManager.getSnapshot().revision === 1 &&
      execute(`document.getElementById('settings-dialog').open === false`),
    '儲存畫面設定並關閉對話框',
  );
  assert.equal(
    settingsManager.getSnapshot().config.appearance.backgroundColor,
    '#123456',
  );
  assert.equal(
    settingsManager.getSnapshot().config.dateTime.offsetSeconds,
    0,
    '未碰時間欄位時，儲存其他設定必須保留既有校正值',
  );
  assert.equal(
    settingsManager.getSnapshot().config.display.renderResolution,
    'auto',
  );
  assert.deepEqual(settingsManager.getSnapshot().config.playback, {
    pageDurationSeconds: 4,
    repeatMode: 'finite',
    roundCount: 2,
  });
  assert.deepEqual(settingsManager.getSnapshot().config.standby, {
    backgroundImagePath:
      'standby-backgrounds/abcdefabcdefabcdefabcdef.png',
  });

  // 第二次開啟測試離線時間校正與邏輯排版解析度，避免與外觀草稿混淆。
  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open &&
      document.getElementById('settings-status').textContent === '設定已載入。'
    )()`),
    '重新載入時間與解析度設定',
  );
  assert.deepEqual(await execute(`(() => ({
    pageDuration: document.getElementById('page-duration-input').value,
    rounds: document.getElementById('round-count-input').value,
    finiteChecked: document.querySelector(
      'input[name="repeat-mode"][value="finite"]'
    ).checked,
    saveDisabled:
      document.getElementById('save-settings-button').disabled,
    dirtyStatus:
      document.getElementById('settings-dirty-status').textContent,
    standbyBackgroundPath:
      document.getElementById('standby-background-path-input').value,
  }))()`), {
    pageDuration: '4',
    rounds: '2',
    finiteChecked: true,
    saveDisabled: true,
    dirtyStatus: '所有變更皆已儲存',
    standbyBackgroundPath:
      'standby-backgrounds/abcdefabcdefabcdefabcdef.png',
  });

  // 移除只改草稿；未儲存就關閉時必須恢復已儲存背景。
  await click('remove-standby-background-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('standby-background-path-input').value === '' &&
      document.getElementById('settings-dirty-status').textContent ===
        '有未儲存變更'
    )()`),
    '待機背景移除草稿',
  );
  await click('settings-close-button');
  await waitFor(
    () => execute(`document.getElementById('settings-dialog').open === false`),
    '捨棄待機背景移除草稿',
  );
  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open &&
      document.getElementById('settings-status').textContent === '設定已載入。' &&
      document.getElementById('standby-background-path-input').value ===
        'standby-backgrounds/abcdefabcdefabcdefabcdef.png'
    )()`),
    '重新載入已儲存待機背景',
  );

  await setInput('clock-time-input', '24:00:00');
  await click('save-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('clock-time-error').hidden === false &&
      document.getElementById('clock-time-input').getAttribute('aria-invalid') ===
        'true'
    )()`),
    '拒絕無效的 24 小時制時間',
  );
  assert.equal(
    await execute(`document.getElementById('clock-time-error').textContent`),
    '時間必須使用 24 小時 HH:mm:ss，例如 17:01:09。',
  );
  assert.equal(settingsManager.getSnapshot().revision, 1);

  const targetClockSeconds = await execute(`(() => {
    const now = new Date();
    const currentSeconds =
      now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const targetSeconds = (currentSeconds + 600) % 86400;
    const clock = [
      Math.floor(targetSeconds / 3600),
      Math.floor((targetSeconds % 3600) / 60),
      targetSeconds % 60,
    ].map((part) => String(part).padStart(2, '0')).join(':');
    const clockInput = document.getElementById('clock-time-input');
    clockInput.value = clock;
    clockInput.dispatchEvent(new Event('input', { bubbles: true }));

    const resolution = document.getElementById('render-resolution-select');
    resolution.value = '2560x1440';
    resolution.dispatchEvent(new Event('change', { bubbles: true }));
    return targetSeconds;
  })()`);
  await waitFor(
    () => execute(`document.getElementById('save-settings-button').disabled === false`),
    '啟用時間與解析度儲存按鈕',
  );
  await click('save-settings-button');
  await waitFor(
    () => settingsManager.getSnapshot().revision === 2 &&
      execute(`document.getElementById('settings-dialog').open === false`),
    '儲存時間校正與解析度並關閉對話框',
  );

  const calibratedConfig = settingsManager.getSnapshot().config;
  assert.equal(calibratedConfig.display.renderResolution, '2560x1440');
  assert.ok(
    Number.isSafeInteger(calibratedConfig.dateTime.offsetSeconds) &&
      calibratedConfig.dateTime.offsetSeconds >= -43_199 &&
      calibratedConfig.dateTime.offsetSeconds <= 43_200,
    '時間校正值必須是 schema 接受的日內偏移秒數',
  );
  const currentDate = new Date();
  const currentSeconds =
    currentDate.getHours() * 3_600 +
    currentDate.getMinutes() * 60 +
    currentDate.getSeconds();
  const calibratedSeconds = (
    currentSeconds + calibratedConfig.dateTime.offsetSeconds + 86_400
  ) % 86_400;
  const elapsedSeconds = (
    calibratedSeconds - targetClockSeconds + 86_400
  ) % 86_400;
  assert.ok(
    elapsedSeconds <= 5,
    `校正後時間應貼近輸入值，實際相差 ${elapsedSeconds} 秒`,
  );
  assert.deepEqual(calibratedConfig.playback, {
    pageDurationSeconds: 4,
    repeatMode: 'finite',
    roundCount: 2,
  });

  // 移除並儲存後才真正回到純色待機背景。
  await click('open-settings-button');
  await waitFor(
    () => execute(`document.getElementById('settings-dialog').open === true`),
    '開啟待機背景移除驗證',
  );
  await click('remove-standby-background-button');
  await click('save-settings-button');
  await waitFor(
    () => settingsManager.getSnapshot().revision === 3 &&
      execute(`document.getElementById('settings-dialog').open === false`),
    '儲存移除待機背景',
  );
  assert.deepEqual(settingsManager.getSnapshot().config.standby, {
    backgroundImagePath: null,
  });
}

async function submitNormalMessage(recipient, action, expectedMessage) {
  await selectRadio('action', action);
  await setInput('recipient-input', recipient);
  assert.equal(
    await execute(`document.getElementById('message-preview').textContent`),
    expectedMessage,
  );
  await execute(`document.getElementById('message-form').requestSubmit()`);
}

async function runWorkflow(store, timers, settingsManager, metrics) {
  await waitFor(
    () => execute(`(() =>
      document.getElementById('operation-status').textContent ===
        '控制介面已就緒。' &&
      document.getElementById('operation-quiet-button').disabled === false &&
      document.getElementById('inspection-555-button').disabled === false
    )()`),
    'Control 啟動',
  );

  assert.deepEqual(await execute(`(() => ({
    hdmi: document.getElementById('hdmi-status-text').textContent,
    target: document.getElementById('output-target').textContent,
    hasQueue: document.getElementById('message-queue') !== null,
    hasQueueStart: document.getElementById('start-program-button') !== null,
    hasQueueClear: document.getElementById('clear-queue-button') !== null,
    hasOutputSettings:
      document.getElementById('manage-output-settings-button') !== null,
    panelsShareFirstRow: (() => {
      const composer = document.querySelector('.composer-panel').getBoundingClientRect();
      const current = document.querySelector('.current-panel').getBoundingClientRect();
      return Math.abs(composer.top - current.top) < 2 && current.left > composer.right;
    })(),
  }))()`), {
    hdmi: 'HDMI 已連接',
    target: '前廳電視',
    hasQueue: false,
    hasQueueStart: false,
    hasQueueClear: false,
    hasOutputSettings: false,
    panelsShareFirstRow: true,
  });

  // 當前操作失敗時不可同時留著舊的成功狀態，避免相互矛盾。
  await selectRadio('action', 'custom');
  await setInput('custom-message-input', '甲'.repeat(10_001));
  await execute(`document.getElementById('message-form').requestSubmit()`);
  await waitFor(
    () => execute(`document.getElementById('operation-error').hidden === false`),
    '顯示訊息資源上限錯誤',
  );
  assert.deepEqual(await execute(`(() => ({
    status: document.getElementById('operation-status').textContent,
    error: document.getElementById('operation-error').textContent,
  }))()`), {
    status: '',
    error: '所有訊息合計不得超過 10000 個字元。',
  });
  assert.equal(store.getControlSnapshot().revision, 0);
  await setInput('custom-message-input', '');
  await selectRadio('action', 'go-to-lobby');

  await openPlaybackSettings(settingsManager);

  // 儲存並重新開啟確認後，下一次顯示必須採用偏好的 4 秒／2 輪。
  await execute(`(() => {
    const button = document.getElementById('operation-quiet-button');
    button.focus();
    button.click();
  })()`);
  await waitForRevision(store, 1);
  await waitForLiveMessages(
    ['請輕聲細語'],
    '播放第 1 / 1 頁 · 第 1 / 2 輪',
  );
  await waitFor(
    () => execute(`document.activeElement?.id === 'operation-quiet-button'`),
    '罐頭訊息顯示後恢復原操作焦點',
  );
  assert.deepEqual(store.getControlSnapshot(), {
    mode: 'page',
    messages: [{ message: '請輕聲細語', alignment: 'center' }],
    layout: 'single-line',
    pageDurationSeconds: 4,
    pageNumber: 1,
    pageCount: 1,
    roundNumber: 1,
    totalRounds: 2,
    emergencyTone: null,
    revision: 1,
    contentRevision: 1,
  });
  assert.deepEqual(settingsManager.getSnapshot().config.playback, {
    pageDurationSeconds: 4,
    repeatMode: 'finite',
    roundCount: 2,
  });

  await click('operation-quiet-button');
  await waitForRevision(store, 2);
  await waitForLiveMessages(
    ['請輕聲細語', '請輕聲細語'],
    '播放第 1 / 1 頁 · 第 1 / 2 輪',
  );

  // 一般表單也是一次 submit 就立即更新 Main 內容。
  await submitNormalMessage('001', 'go-to-lobby', '001請至前廳');
  await waitForRevision(store, 3);
  await waitForLiveMessages(
    ['請輕聲細語', '請輕聲細語', '001請至前廳'],
    '播放第 1 / 1 頁 · 第 1 / 2 輪',
  );

  await submitNormalMessage('Nancy', 'lobby-code', 'Nancy前廳000');
  await waitForRevision(store, 4);
  const allMessages = [
    '請輕聲細語',
    '請輕聲細語',
    '001請至前廳',
    'Nancy前廳000',
  ];
  const allPresentations = [
    { message: '請輕聲細語', alignment: 'center' },
    { message: '請輕聲細語', alignment: 'center' },
    { message: '001請至前廳', alignment: 'left' },
    { message: 'Nancy前廳000', alignment: 'left' },
  ];
  await waitForLiveMessages(
    allMessages.slice(0, 3),
    '播放第 1 / 2 頁 · 第 1 / 2 輪',
  );
  assert.deepEqual(store.getControlSnapshot().messages, allPresentations);
  assert.deepEqual(
    store.getSnapshot().messages.map(({ message }) => message),
    allMessages.slice(0, 3),
  );
  assert.deepEqual(await readCurrentDom(), {
    liveSummary: '播放第 1 / 2 頁 · 第 1 / 2 輪',
    liveMessages: allMessages.slice(0, 3),
    displaySummary: '瀏覽第 2 / 2 頁 · 共 4 則',
    displayMessages: ['Nancy前廳000'],
    displayIndices: ['04'],
    removeIndices: ['3'],
    liveEmptyHidden: true,
    liveListHidden: false,
    displayEmptyHidden: true,
    displayListHidden: false,
    previousDisabled: false,
    nextDisabled: true,
    clearDisabled: false,
    status: '訊息已顯示。',
    errorHidden: true,
    error: '',
  });

  // 瀏覽清單切回第一頁不會切換電視實際播放頁面。
  await click('display-list-prev');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('display-list-summary').textContent ===
        '瀏覽第 1 / 2 頁 · 共 4 則' &&
      JSON.stringify([...document.querySelectorAll(
        '#display-message-list .current-message-text'
      )].map((element) => element.textContent)) ===
        ${JSON.stringify(JSON.stringify(allMessages.slice(0, 3)))}
    )()`),
    '顯示清單獨立瀏覽第一頁',
  );

  // 每頁最多三則；完成第一頁的 4 秒後，只有即時狀態切到第二頁。
  assert.equal(timers.activeCount(), 0, 'Display ready 前不得啟動 timer');
  reportStaticDisplayReady(1, settingsManager.getSnapshot().revision);
  assert.equal(timers.activeCount(), 1);
  await execute(`document.querySelector(
    '#display-message-list .current-remove-button[data-message-index="0"]'
  ).focus()`);
  timers.fireNext(4_000);
  await waitForRevision(store, 5);
  await waitForLiveMessages(
    ['Nancy前廳000'],
    '播放第 2 / 2 頁 · 第 1 / 2 輪',
  );
  await waitFor(
    () => execute(`(() =>
      document.activeElement?.dataset?.messageIndex === '0' &&
      document.getElementById('display-list-summary').textContent ===
        '瀏覽第 1 / 2 頁 · 共 4 則'
    )()`),
    '電視翻頁不重建顯示清單或移走操作焦點',
  );
  assert.deepEqual((await readCurrentDom()).removeIndices, ['0', '1', '2']);

  await click('display-list-next');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('display-list-summary').textContent ===
        '瀏覽第 2 / 2 頁 · 共 4 則' &&
      document.querySelector(
        '#display-message-list .current-remove-button'
      )?.dataset.messageIndex === '3'
    )()`),
    '顯示清單獨立瀏覽第二頁',
  );

  // 播放中的頁面不得回寫設定偏好；捨棄有效草稿後必須立刻回復 baseline。
  const beforeInvalidRemoval = structuredClone(store.getControlSnapshot());
  const startCallsBeforeInvalidRemoval = metrics.startProgramCalls;
  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open === true &&
      document.getElementById('settings-status').textContent === '設定已載入。' &&
      document.getElementById('page-duration-input').value === '4' &&
      document.getElementById('round-count-input').value === '2'
    )()`),
    '播放中重新載入已儲存的播放偏好',
  );

  await setInput('page-duration-input', '6');
  await setInput('round-count-input', '3');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('save-settings-button').disabled === false &&
      document.getElementById('settings-dirty-status').textContent ===
        '有未儲存變更' &&
      document.getElementById('settings-close-button').textContent ===
        '捨棄變更'
    )()`),
    '有效播放草稿標示為未儲存',
  );
  await click('settings-close-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open === false &&
      document.getElementById('page-duration-input').value === '4' &&
      document.getElementById('round-count-input').value === '2' &&
      document.getElementById('settings-dirty-status').textContent ===
        '所有變更皆已儲存'
    )()`),
    '捨棄播放草稿並回復 baseline',
  );
  assert.equal(settingsManager.getSnapshot().revision, 3);
  assert.deepEqual(settingsManager.getSnapshot().config.playback, {
    pageDurationSeconds: 4,
    repeatMode: 'finite',
    roundCount: 2,
  });
  assert.deepEqual(store.getControlSnapshot(), beforeInvalidRemoval);
  assert.equal(metrics.startProgramCalls, startCallsBeforeInvalidRemoval);

  // 防護：無效播放秒數只能在設定內顯示錯誤，不得送出或改變目前內容。
  await click('open-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open === true &&
      document.getElementById('settings-status').textContent === '設定已載入。' &&
      document.getElementById('page-duration-input').value === '4' &&
      document.getElementById('round-count-input').value === '2'
    )()`),
    '捨棄後重新載入播放 baseline',
  );
  await setInput('page-duration-input', '0');
  await click('save-settings-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('page-duration-error').hidden === false &&
      document.getElementById('page-duration-error').textContent.length > 0 &&
      document.activeElement?.id === 'page-duration-input'
    )()`),
    '無效播放秒數顯示欄位錯誤並聚焦',
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settingsManager.getSnapshot().revision, 3);
  assert.deepEqual(store.getControlSnapshot(), beforeInvalidRemoval);
  assert.equal(metrics.startProgramCalls, startCallsBeforeInvalidRemoval);
  assert.deepEqual(await execute(`(() => ({
    operationErrorHidden: document.getElementById('operation-error').hidden,
    liveMessages: [...document.querySelectorAll(
      '#live-message-list .current-message-text'
    )]
      .map((element) => element.textContent),
    displayMessages: [...document.querySelectorAll(
      '#display-message-list .current-message-text'
    )]
      .map((element) => element.textContent),
    liveSummary: document.getElementById('live-page-summary').textContent,
    displaySummary: document.getElementById('display-list-summary').textContent,
  }))()`), {
    operationErrorHidden: true,
    liveMessages: ['Nancy前廳000'],
    displayMessages: ['Nancy前廳000'],
    liveSummary: '播放第 2 / 2 頁 · 第 1 / 2 輪',
    displaySummary: '瀏覽第 2 / 2 頁 · 共 4 則',
  });

  // 關閉設定會捨棄無效草稿並重繪已儲存偏好，不再保留隱藏的無效 DOM。
  await click('settings-close-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('settings-dialog').open === false &&
      document.getElementById('page-duration-input').value === '4' &&
      document.getElementById('round-count-input').value === '2' &&
      document.getElementById('page-duration-error').hidden === true
    )()`),
    '捨棄無效播放草稿並重繪已儲存偏好',
  );
  assert.deepEqual(settingsManager.getSnapshot().config.playback, {
    pageDurationSeconds: 4,
    repeatMode: 'finite',
    roundCount: 2,
  });
  await execute(`document.querySelector(
    '#display-message-list .current-remove-button[data-message-index="3"]'
  ).click()`);
  await waitForRevision(store, 6);
  await waitForLiveMessages(
    allMessages.slice(0, 3),
    '播放第 1 / 1 頁 · 第 1 / 2 輪',
  );
  assert.equal(metrics.startProgramCalls, startCallsBeforeInvalidRemoval + 1);
  assert.equal((await readCurrentDom()).status, '訊息已移除。');

  // 清除畫面直接清除 Main 目前內容。
  await execute(`(() => {
    const button = document.getElementById('clear-display-button');
    button.focus();
    button.click();
  })()`);
  await waitForRevision(store, 7);
  await waitFor(
    () => execute(`(() =>
      document.getElementById('live-empty-state').hidden === false &&
      document.getElementById('live-message-list').hidden === true &&
      document.getElementById('display-list-empty-state').hidden === false &&
      document.getElementById('display-message-list').hidden === true &&
      document.getElementById('display-list-prev').disabled === true &&
      document.getElementById('display-list-next').disabled === true &&
      document.getElementById('clear-display-button').disabled === true
    )()`),
    '清除目前畫面',
  );
  assert.equal(store.getControlSnapshot().mode, 'blank');
  assert.equal(await execute(`document.activeElement?.id`), 'recipient-input');

  // 關閉確認對話框後，若操作員已主動移動焦點，不得延遲搶回 555。
  await click('inspection-555-button');
  await execute(`new Promise((resolve) => {
    const dialog = document.getElementById('inspection-confirm-dialog');
    dialog.addEventListener('close', () => resolve(true), { once: true });
    dialog.close();
    document.getElementById('recipient-input').focus();
  })`);
  await waitFor(
    () => execute(`document.activeElement?.id === 'recipient-input'`),
    '臨檢對話框關閉後保留操作員的新焦點',
  );
  assert.equal(await execute(`document.activeElement?.id`), 'recipient-input');

  // 555／888 都經確認後立即切換 fill-screen，且不受一般三則分頁限制。
  await click('inspection-555-button');
  assert.deepEqual(await execute(`(() => ({
    open: document.getElementById('inspection-confirm-dialog').open,
    code: document.getElementById('inspection-code-preview').textContent,
    confirm: document.getElementById('inspection-confirm-button').textContent,
  }))()`), {
    open: true,
    code: '555',
    confirm: '確認顯示 555',
  });
  assert.equal(store.getControlSnapshot().revision, 7);
  await click('inspection-confirm-button');
  await waitForRevision(store, 8);
  await waitForLiveMessages(['555'], '滿屏顯示');
  assert.deepEqual(store.getControlSnapshot(), {
    mode: 'emergency',
    messages: [{ message: '555', alignment: 'center' }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    emergencyTone: 'inspection',
    revision: 8,
    contentRevision: 7,
  });
  assert.equal((await readCurrentDom()).removeIndices.length, 0);

  await waitFor(
    () => execute(`(() =>
      document.getElementById('inspection-confirm-dialog').open === false &&
      document.getElementById('inspection-888-button').disabled === false
    )()`),
    '555 確認對話框完整關閉',
  );
  await click('inspection-888-button');
  await waitFor(
    () => execute(`(() =>
      document.getElementById('inspection-confirm-dialog').open &&
      document.getElementById('inspection-code-preview').textContent === '888'
    )()`),
    '開啟 888 確認',
  );
  await click('inspection-confirm-button');
  await waitForRevision(store, 9);
  await waitForLiveMessages(['888'], '滿屏顯示');
  assert.deepEqual(store.getControlSnapshot(), {
    mode: 'emergency',
    messages: [{ message: '888', alignment: 'center' }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    emergencyTone: 'release',
    revision: 9,
    contentRevision: 8,
  });

  await click('clear-display-button');
  await waitForRevision(store, 10);
  assert.equal(store.getControlSnapshot().mode, 'blank');

  // 新增固定動作必須從真實表單預覽、IPC 到 Main 完整送出。
  await submitNormalMessage('Nancy', 'contact-counter', 'Nancy聯絡櫃台');
  await waitForRevision(store, 11);
  await waitForLiveMessages(
    ['Nancy聯絡櫃台'],
    '播放第 1 / 1 頁 · 第 1 / 2 輪',
  );
  assert.deepEqual(store.getControlSnapshot().messages, [
    { message: 'Nancy聯絡櫃台', alignment: 'left' },
  ]);
  assert.deepEqual((await readCurrentDom()).displayMessages, [
    'Nancy聯絡櫃台',
  ]);

  await click('clear-display-button');
  await waitForRevision(store, 12);
  assert.equal(store.getControlSnapshot().mode, 'blank');
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

  const store = new PresentationStore();
  const timers = createTimerHarness();
  const metrics = { startProgramCalls: 0 };
  presentationService = new PresentationService({
    store,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const startProgram = presentationService.startProgram.bind(
    presentationService,
  );
  presentationService.startProgram = (program) => {
    assert.ok(program && typeof program === 'object', '不得呼叫 startProgram(null)');
    metrics.startProgramCalls += 1;
    return startProgram(program);
  };

  const topologyService = new FakeOutputService(
    createTopologySnapshot(),
    'getSnapshot',
  );
  const placementService = new FakeOutputService(
    createPlacementStatus(),
    'getStatus',
  );
  const settingsManager = createSettingsManager();
  const logoImporter = {
    async chooseAndImport() {
      return { canceled: true, assetPath: null };
    },
  };
  const standbyBackgroundImporter = {
    async chooseAndImport() {
      return {
        canceled: false,
        assetPath:
          'standby-backgrounds/abcdefabcdefabcdefabcdef.png',
      };
    },
  };

  coordinator = new IpcCoordinator({
    ipcMain,
    presentationService,
    settingsManager,
    logoImporter,
    standbyBackgroundImporter,
    displayTopologyService: topologyService,
    displayPlacementController: placementService,
    getWindow: (role) => role === IPC_ROLES.CONTROL ? controlWindow : null,
    allowedUrls: {
      [IPC_ROLES.CONTROL]: CONTROL_URL,
      [IPC_ROLES.DISPLAY]: DISPLAY_URL,
    },
    logger: { warn() {}, error() {} },
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
  await runWorkflow(store, timers, settingsManager, metrics);
  finish(0, '[DisplayCore] Control window workflow succeeded.');
}

run().catch((error) => {
  finish(1, '[DisplayCore] Control window smoke test failed.', error);
});
