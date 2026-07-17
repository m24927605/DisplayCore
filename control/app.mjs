import { createControlController } from './control-controller.mjs';
import { createOutputController } from './output-controller.mjs';
import { createOutputView } from './output-view.mjs';
import {
  ACTIONS,
  EMERGENCY_CODES,
  OPERATION_MESSAGES,
  composeMessage,
  createEmergencyPresentation,
} from './message-composer.mjs';
import {
  PLAYBACK_MODES,
  PROGRAM_LIMITS,
  appendMessage,
  buildProgram,
  removeMessage,
} from './program-builder.mjs';
import { createSettingsController } from './settings-controller.mjs';
import { createSettingsView } from './settings-view.mjs';
import { paginateMessageList } from './message-list-pagination.mjs';

/**
 * Control Renderer 的 DOM 接線層。
 *
 * 本模組只組合表單、視圖與 preload 的固定用途 API；不直接
 * 存取 Node.js、Electron IPC channel 或完整電視畫面以外的系統資源。
 */
const elements = Object.freeze({
  messageForm: document.getElementById('message-form'),
  recipientInput: document.getElementById('recipient-input'),
  recipientError: document.getElementById('recipient-error'),
  actionFieldset: document.getElementById('action-fieldset'),
  actionError: document.getElementById('action-error'),
  customField: document.getElementById('custom-message-field'),
  customInput: document.getElementById('custom-message-input'),
  customError: document.getElementById('custom-message-error'),
  preview: document.getElementById('message-preview'),
  displayButton: document.getElementById('display-message-button'),
  operationButtons: Object.freeze([
    document.getElementById('operation-quiet-button'),
  ]),
  livePageSummary: document.getElementById('live-page-summary'),
  liveList: document.getElementById('live-message-list'),
  liveEmpty: document.getElementById('live-empty-state'),
  displayListSummary: document.getElementById('display-list-summary'),
  displayList: document.getElementById('display-message-list'),
  displayListEmpty: document.getElementById('display-list-empty-state'),
  displayListPrevious: document.getElementById('display-list-prev'),
  displayListNext: document.getElementById('display-list-next'),
  clearDisplayButton: document.getElementById('clear-display-button'),
  pageDurationInput: document.getElementById('page-duration-input'),
  pageDurationError: document.getElementById('page-duration-error'),
  repeatModeFieldset: document.getElementById('repeat-mode-fieldset'),
  repeatError: document.getElementById('repeat-error'),
  roundCountField: document.getElementById('round-count-field'),
  roundCountInput: document.getElementById('round-count-input'),
  roundCountError: document.getElementById('round-count-error'),
  openSettingsButton: document.getElementById('open-settings-button'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsForm: document.getElementById('settings-form'),
  inspectionButtons: Object.freeze([
    document.getElementById('inspection-555-button'),
    document.getElementById('inspection-888-button'),
  ]),
  dialog: document.getElementById('inspection-confirm-dialog'),
  dialogTitle: document.getElementById('inspection-dialog-title'),
  dialogDescription: document.getElementById('inspection-dialog-description'),
  dialogCode: document.getElementById('inspection-code-preview'),
  dialogError: document.getElementById('inspection-dialog-error'),
  dialogConfirmButton: document.getElementById('inspection-confirm-button'),
  dialogCancelButton: document.getElementById('inspection-cancel-button'),
  operationStatus: document.getElementById('operation-status'),
  operationError: document.getElementById('operation-error'),
});

const uiState = {
  busy: false,
  ready: false,
  draftValidationVisible: false,
  snapshot: null,
  activeMessages: Object.freeze([]),
  listPageNumber: 1,
  lastListContentRevision: -1,
  pendingEmergency: null,
  inspectionClosing: false,
  inspectionReopenButton: null,
  focusBeforeBusy: null,
  controller: null,
};

function getActionInputs() {
  return [...elements.messageForm.querySelectorAll('input[name="action"]')];
}

function getRepeatModeInputs() {
  return [...document.querySelectorAll('input[name="repeat-mode"]')];
}

function getSelectedAction() {
  return elements.messageForm.querySelector(
    'input[name="action"]:checked',
  )?.value;
}

function getSelectedRepeatMode() {
  return document.querySelector(
    'input[name="repeat-mode"]:checked',
  )?.value;
}

function readMessageDraft() {
  return {
    recipient: elements.recipientInput.value,
    action: getSelectedAction(),
    customText: elements.customInput.value,
  };
}

function clearDraftErrors() {
  for (const [control, errorElement] of [
    [elements.recipientInput, elements.recipientError],
    [elements.actionFieldset, elements.actionError],
    [elements.customInput, elements.customError],
  ]) {
    control.removeAttribute('aria-invalid');
    errorElement.textContent = '';
    errorElement.hidden = true;
  }
}

function renderDraftError(error, focus = false) {
  clearDraftErrors();
  const targets = {
    recipient: [elements.recipientInput, elements.recipientError],
    action: [elements.actionFieldset, elements.actionError],
    customText: [elements.customInput, elements.customError],
  };
  const [control, errorElement] = targets[error.field] ?? targets.action;
  control.setAttribute('aria-invalid', 'true');
  errorElement.textContent = error.message;
  errorElement.hidden = false;

  if (focus) {
    (control === elements.actionFieldset ? getActionInputs()[0] : control)
      ?.focus();
  }
}

function clearPlaybackErrors() {
  for (const [control, errorElement] of [
    [elements.pageDurationInput, elements.pageDurationError],
    [elements.repeatModeFieldset, elements.repeatError],
    [elements.roundCountInput, elements.roundCountError],
  ]) {
    control.removeAttribute('aria-invalid');
    errorElement.textContent = '';
    errorElement.hidden = true;
  }
}

/** 等設定 snapshot 載入完成後再對焦，避免原生 dialog 將焦點搶回首個欄位。 */
function focusPlaybackControlWhenReady(control) {
  const focus = () => {
    if (
      elements.settingsDialog.open &&
      control?.isConnected &&
      !control.disabled
    ) {
      control.focus();
    }
  };
  const scheduleFocus = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(focus);
    });
  };

  if (elements.settingsForm.getAttribute('aria-busy') !== 'true') {
    scheduleFocus();
    return;
  }

  const observer = new MutationObserver(() => {
    if (elements.settingsForm.getAttribute('aria-busy') === 'true') {
      return;
    }

    observer.disconnect();
    scheduleFocus();
  });
  observer.observe(elements.settingsForm, {
    attributes: true,
    attributeFilter: ['aria-busy'],
  });
}

function renderPlaybackError(error) {
  clearPlaybackErrors();
  const targets = {
    pageDurationSeconds: [elements.pageDurationInput, elements.pageDurationError],
    repeat: [elements.repeatModeFieldset, elements.repeatError],
    rounds: [elements.roundCountInput, elements.roundCountError],
    messages: [elements.pageDurationInput, elements.pageDurationError],
  };
  const [control, errorElement] = targets[error.field] ?? targets.repeat;
  control.setAttribute('aria-invalid', 'true');
  errorElement.textContent = error.message;
  errorElement.hidden = false;
  const focusTarget = control === elements.repeatModeFieldset
    ? getRepeatModeInputs()[0]
    : control;

  // 播放欄位收在齒輪內；若驗證失敗，直接打開設定讓操作員看到錯誤。
  if (!elements.settingsDialog.open && !elements.openSettingsButton.disabled) {
    elements.openSettingsButton.click();
  }

  focusPlaybackControlWhenReady(focusTarget);
}

/** 以齒輪內的本次播放選項，建立可交給 Main 的完整 program。 */
function buildCurrentProgram(messages) {
  const result = buildProgram({
    messages,
    pageDurationSeconds: elements.pageDurationInput.value,
    repeatMode: getSelectedRepeatMode(),
    rounds: elements.roundCountInput.value,
  });

  if (!result.ok) {
    renderPlaybackError(result.error);
    return null;
  }

  clearPlaybackErrors();
  return result.program;
}

function updateRepeatControls() {
  const finite = getSelectedRepeatMode() === PLAYBACK_MODES.FINITE;
  elements.roundCountField.hidden = !finite;
  elements.roundCountInput.disabled = uiState.busy || !uiState.ready || !finite;
}

function updateMessageDraftView() {
  const custom = getSelectedAction() === ACTIONS.CUSTOM;
  elements.customField.hidden = !custom;
  elements.customInput.disabled = uiState.busy || !uiState.ready || !custom;

  const result = composeMessage(readMessageDraft());
  if (result.ok) {
    elements.preview.textContent = result.presentation.message;
    elements.preview.classList.remove('is-placeholder');
    if (uiState.draftValidationVisible) {
      clearDraftErrors();
    }
  } else {
    elements.preview.textContent = '請先輸入編號、花名或自定義內容';
    elements.preview.classList.add('is-placeholder');
    if (uiState.draftValidationVisible) {
      renderDraftError(result.error);
    }
  }

  elements.displayButton.disabled =
    uiState.busy || !uiState.ready || !result.ok;
}

function createCurrentMessageItem(message, globalIndex, removable) {
  const item = document.createElement('li');
  item.className = 'current-message-item';
  item.dataset.messageIndex = String(globalIndex);

  const index = document.createElement('span');
  index.className = 'current-message-index';
  index.textContent = String(globalIndex + 1).padStart(2, '0');

  const text = document.createElement('span');
  text.className = 'current-message-text';
  text.tabIndex = 0;
  text.textContent = message;

  item.append(index, text);
  if (removable) {
    const button = document.createElement('button');
    button.className = 'current-remove-button';
    button.type = 'button';
    button.dataset.messageIndex = String(globalIndex);
    button.textContent = '移除';
    button.setAttribute('aria-label', `移除第 ${globalIndex + 1} 則訊息`);
    button.disabled = uiState.busy;
    item.append(button);
  }

  return item;
}

function updateListControls(page = paginateMessageList(
  uiState.activeMessages,
  uiState.listPageNumber,
)) {
  const disabled = uiState.busy || !uiState.ready;
  elements.displayListPrevious.disabled = disabled || !page.hasPreviousPage;
  elements.displayListNext.disabled = disabled || !page.hasNextPage;
  elements.clearDisplayButton.disabled =
    disabled || uiState.snapshot?.mode === 'blank';
  elements.displayList
    .querySelectorAll('.current-remove-button')
    .forEach((button) => {
      button.disabled = disabled;
    });
}

/** 顯示清單有自己的瀏覽頁碼，不會送出任何切換電視頁面的 IPC。 */
function renderDisplayList() {
  const page = paginateMessageList(
    uiState.activeMessages,
    uiState.listPageNumber,
  );
  uiState.listPageNumber = page.pageNumber || 1;

  elements.displayListSummary.textContent = page.pageCount === 0
    ? '瀏覽第 —'
    : `瀏覽第 ${page.pageNumber} / ${page.pageCount} 頁 · 共 ${uiState.activeMessages.length} 則`;

  const fragment = document.createDocumentFragment();
  for (const { message, globalIndex } of page.visibleMessages) {
    fragment.append(createCurrentMessageItem(message, globalIndex, true));
  }
  elements.displayList.replaceChildren(fragment);
  elements.displayList.hidden = page.visibleMessages.length === 0;
  elements.displayListEmpty.hidden = page.visibleMessages.length > 0;
  updateListControls(page);
}

/** 即時狀態只呈現電視真正正在播放的頁面，沒有任何操作按鈕。 */
function renderLiveStatus(snapshot) {
  let visibleMessages = [];
  if (snapshot.mode === 'page') {
    const pageStart =
      (snapshot.pageNumber - 1) * PROGRAM_LIMITS.MESSAGES_PER_PAGE;
    visibleMessages = snapshot.messages.slice(
      pageStart,
      pageStart + PROGRAM_LIMITS.MESSAGES_PER_PAGE,
    );
    const round = snapshot.totalRounds === null
      ? '持續播放'
      : `第 ${snapshot.roundNumber} / ${snapshot.totalRounds} 輪`;
    elements.livePageSummary.textContent =
      `播放第 ${snapshot.pageNumber} / ${snapshot.pageCount} 頁 · ${round}`;
  } else if (snapshot.mode === 'emergency') {
    visibleMessages = snapshot.messages;
    elements.livePageSummary.textContent = '滿屏顯示';
  } else {
    elements.livePageSummary.textContent = '待機畫面';
  }

  const fragment = document.createDocumentFragment();
  visibleMessages.forEach(({ message }, index) => {
    fragment.append(createCurrentMessageItem(message, index, false));
  });
  elements.liveList.replaceChildren(fragment);
  elements.liveList.hidden = visibleMessages.length === 0;
  elements.liveEmpty.hidden = visibleMessages.length > 0;
}

/** 將 Control 專用的完整 active snapshot 投影為「電視當前頁」最多三則。 */
function renderPresentation(snapshot) {
  const previousMessageCount = uiState.activeMessages.length;
  const contentChanged =
    snapshot.contentRevision !== uiState.lastListContentRevision;
  uiState.snapshot = snapshot;
  uiState.activeMessages = snapshot.mode === 'page'
    ? Object.freeze(snapshot.messages.map(({ message, alignment }) =>
      Object.freeze({ message, alignment })))
    : Object.freeze([]);
  renderLiveStatus(snapshot);

  if (contentChanged) {
    uiState.lastListContentRevision = snapshot.contentRevision;
    if (uiState.activeMessages.length > previousMessageCount) {
      uiState.listPageNumber = Math.max(
        1,
        Math.ceil(
          uiState.activeMessages.length / PROGRAM_LIMITS.MESSAGES_PER_PAGE,
        ),
      );
    }
    renderDisplayList();
  } else {
    updateListControls();
  }
}

function renderStatus(message) {
  elements.operationStatus.textContent = message;
  elements.operationError.textContent = '';
  elements.operationError.hidden = true;
}

function renderError(message) {
  elements.operationStatus.textContent = '';
  elements.operationError.textContent = message;
  elements.operationError.hidden = false;
}

function setMutationControls() {
  const disabled = uiState.busy || !uiState.ready;
  elements.recipientInput.disabled = disabled;
  elements.actionFieldset.disabled = disabled;
  elements.pageDurationInput.disabled = disabled;
  elements.repeatModeFieldset.disabled = disabled;
  for (const button of [
    ...elements.operationButtons,
    ...elements.inspectionButtons,
    elements.dialogConfirmButton,
    elements.dialogCancelButton,
  ]) {
    button.disabled = disabled;
  }
  updateRepeatControls();
  updateMessageDraftView();
  updateListControls();
}

function createView() {
  return Object.freeze({
    setBusy(busy) {
      if (busy && !uiState.busy) {
        const activeElement = document.activeElement;
        uiState.focusBeforeBusy =
          activeElement instanceof HTMLElement &&
          activeElement !== document.body
            ? activeElement
            : null;
      }

      uiState.busy = busy;
      setMutationControls();

      if (!busy) {
        const focusTarget = uiState.focusBeforeBusy;
        uiState.focusBeforeBusy = null;
        queueMicrotask(() => {
          if (focusTarget?.isConnected && !focusTarget.disabled) {
            focusTarget.focus();
          } else if (!elements.recipientInput.disabled) {
            elements.recipientInput.focus();
          }
        });
      }
    },
    renderPresentation,
    renderStatus,
    renderError,
  });
}

/** 將新訊息加入 Main 目前內容並立即顯示，不建立 Renderer 待播清單。 */
async function displayMessage(presentation, successMessage) {
  if (uiState.busy || !uiState.ready) {
    return false;
  }

  const baseMessages = uiState.snapshot?.mode === 'page'
    ? uiState.activeMessages
    : [];
  const appended = appendMessage(
    baseMessages,
    presentation.message,
    presentation.alignment,
  );
  if (!appended.ok) {
    renderError(appended.error.message);
    return false;
  }

  const program = buildCurrentProgram(appended.messages);
  return program
    ? uiState.controller.startProgram(program, successMessage)
    : false;
}

async function submitMessage() {
  uiState.draftValidationVisible = true;
  const result = composeMessage(readMessageDraft());
  if (!result.ok) {
    renderDraftError(result.error, true);
    updateMessageDraftView();
    return;
  }

  if (await displayMessage(result.presentation, '訊息已顯示。')) {
    elements.recipientInput.value = '';
    elements.customInput.value = '';
    uiState.draftValidationVisible = false;
    clearDraftErrors();
    updateMessageDraftView();
    elements.recipientInput.focus();
  }
}

/** 移除完整 active 內容的指定項目，再以內容版本 CAS 原子取代 Main program。 */
async function removeCurrentMessage(index) {
  if (uiState.snapshot?.mode !== 'page' || uiState.busy) {
    return;
  }

  const removed = removeMessage(uiState.activeMessages, index);
  if (!removed.ok) {
    renderError(removed.error.message);
    return;
  }

  let succeeded;
  if (removed.messages.length === 0) {
    succeeded = await uiState.controller.clearPresentation();
  } else {
    const program = buildCurrentProgram(removed.messages);
    if (!program) {
      return;
    }

    succeeded = await uiState.controller.startProgram(
      program,
      '訊息已移除。',
    );
  }

  if (succeeded) {
    queueMicrotask(() => {
      const buttons = [...elements.displayList.querySelectorAll(
        '.current-remove-button',
      )];
      buttons[Math.min(
        index % PROGRAM_LIMITS.MESSAGES_PER_PAGE,
        buttons.length - 1,
      )]?.focus();
    });
  }
}

/** 開啟 555／888 確認；不在 Renderer 的一般 message 流程推論緊急語意。 */
function openEmergencyDialog(triggerButton) {
  if (uiState.busy) {
    return;
  }

  if (uiState.inspectionClosing) {
    uiState.inspectionReopenButton = triggerButton;
    return;
  }
  if (elements.dialog.open) {
    return;
  }

  const code = triggerButton.dataset.emergencyCode;
  const result = createEmergencyPresentation(code);
  if (!result.ok) {
    renderError('無法辨識滿屏代碼，請重新啟動 DisplayCore。');
    return;
  }

  uiState.pendingEmergency = Object.freeze({ code, triggerButton });
  const inspection = code === EMERGENCY_CODES.INSPECTION;
  elements.dialog.dataset.tone = inspection ? 'inspection' : 'release';
  elements.dialogTitle.textContent = inspection
    ? '確認顯示臨檢代碼 555？'
    : '確認顯示解除代碼 888？';
  elements.dialogDescription.textContent =
    inspection
      ? '不受顯示時間限制；會持續滿屏顯示，直到顯示 888、清除或送出新的訊息。'
      : '不受顯示時間限制；會持續滿屏顯示，直到清除或送出新的訊息。';
  elements.dialogCode.textContent = code;
  elements.dialogError.textContent = '';
  elements.dialogError.hidden = true;
  elements.dialogConfirmButton.textContent = `確認顯示 ${code}`;
  elements.dialog.showModal();
}

function closeEmergencyDialog() {
  if (elements.dialog.open && !uiState.busy) {
    uiState.inspectionClosing = true;
    elements.dialog.close();
  }
}

async function confirmEmergency() {
  const pending = uiState.pendingEmergency;
  if (!pending || uiState.busy) {
    return;
  }

  const succeeded = await uiState.controller.showEmergency(
    pending.code,
    pending.code === EMERGENCY_CODES.INSPECTION
      ? '臨檢代碼 555 已滿屏顯示。'
      : '解除代碼 888 已滿屏顯示。',
  );
  if (succeeded) {
    closeEmergencyDialog();
  } else {
    elements.dialogError.textContent = '無法確認代碼是否已顯示，請查看電視畫面。';
    elements.dialogError.hidden = false;
  }
}

function bindUiEvents() {
  elements.messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitMessage();
  });
  elements.recipientInput.addEventListener('input', updateMessageDraftView);
  elements.customInput.addEventListener('input', updateMessageDraftView);
  getActionInputs().forEach((input) =>
    input.addEventListener('change', updateMessageDraftView));

  const operationMessages = new Set(Object.values(OPERATION_MESSAGES));
  for (const button of elements.operationButtons) {
    button.addEventListener('click', () => {
      const message = button.dataset.operationMessage;
      if (operationMessages.has(message)) {
        void displayMessage(
          { message, alignment: 'center' },
          `「${message}」已顯示。`,
        );
      }
    });
  }

  elements.displayList.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('.current-remove-button')
      : null;
    if (button) {
      void removeCurrentMessage(Number(button.dataset.messageIndex));
    }
  });
  elements.displayListPrevious.addEventListener('click', () => {
    const page = paginateMessageList(
      uiState.activeMessages,
      uiState.listPageNumber,
    );
    uiState.listPageNumber = page.previousPageNumber || 1;
    renderDisplayList();
  });
  elements.displayListNext.addEventListener('click', () => {
    const page = paginateMessageList(
      uiState.activeMessages,
      uiState.listPageNumber,
    );
    uiState.listPageNumber = page.nextPageNumber || 1;
    renderDisplayList();
  });
  elements.clearDisplayButton.addEventListener('click', () =>
    void uiState.controller.clearPresentation());

  for (const control of [
    elements.pageDurationInput,
    elements.roundCountInput,
  ]) {
    control.addEventListener('input', clearPlaybackErrors);
    control.addEventListener('change', clearPlaybackErrors);
  }
  getRepeatModeInputs().forEach((input) =>
    input.addEventListener('change', () => {
      clearPlaybackErrors();
      updateRepeatControls();
    }));
  for (const button of elements.inspectionButtons) {
    button.addEventListener('click', () => openEmergencyDialog(button));
  }
  elements.dialogCancelButton.addEventListener('click', closeEmergencyDialog);
  elements.dialogConfirmButton.addEventListener('click', () =>
    void confirmEmergency());
  elements.dialog.addEventListener('cancel', (event) => {
    if (uiState.busy) {
      event.preventDefault();
    } else {
      uiState.inspectionClosing = true;
    }
  });
  elements.dialog.addEventListener('close', () => {
    const trigger = uiState.pendingEmergency?.triggerButton;
    const reopen = uiState.inspectionReopenButton;
    const activeElement = document.activeElement;
    const shouldRestoreTriggerFocus =
      activeElement === null ||
      activeElement === document.body ||
      elements.dialog.contains(activeElement);
    uiState.pendingEmergency = null;
    uiState.inspectionReopenButton = null;
    uiState.inspectionClosing = false;
    elements.dialogError.textContent = '';
    elements.dialogError.hidden = true;
    queueMicrotask(() => {
      if (reopen?.isConnected && !reopen.disabled) {
        openEmergencyDialog(reopen);
      } else if (
        shouldRestoreTriggerFocus &&
        trigger?.isConnected &&
        !trigger.disabled
      ) {
        trigger.focus();
      }
    });
  });
}

function hasRequiredBridge(api) {
  return [
    'onPresentationChanged',
    'getPresentation',
    'startProgram',
    'showEmergency',
    'clearPresentation',
    'getSettings',
    'saveSettings',
    'chooseLogo',
    'chooseStandbyBackground',
    'getOutputStatus',
    'onOutputStatusChanged',
  ].every((methodName) => typeof api?.[methodName] === 'function');
}

/** 先完成事件綁定與各控制器訂閱，再將可變更操作解鎖。 */
async function boot() {
  bindUiEvents();
  updateRepeatControls();
  updateMessageDraftView();
  const bridge = window.displayCoreControl;
  if (!hasRequiredBridge(bridge)) {
    renderError('安全通訊橋接未載入，請重新啟動 DisplayCore。');
    return;
  }

  const api = Object.freeze({
    onPresentationChanged: (listener) =>
      bridge.onPresentationChanged(listener),
    getPresentation: () => bridge.getPresentation(),
    startProgram: (program, expectedContentRevision) => bridge.startProgram(
      program.messages,
      program.pageDurationSeconds,
      program.repeat,
      expectedContentRevision,
    ),
    showEmergency: (code) => bridge.showEmergency(code),
    clearPresentation: (expectedContentRevision) =>
      bridge.clearPresentation(expectedContentRevision),
    getSettings: () => bridge.getSettings(),
    saveSettings: (config, expectedRevision) =>
      bridge.saveSettings(config, expectedRevision),
    chooseLogo: () => bridge.chooseLogo(),
    chooseStandbyBackground: (backgroundMode) =>
      bridge.chooseStandbyBackground(backgroundMode),
    getOutputStatus: () => bridge.getOutputStatus(),
    onOutputStatusChanged: (listener) =>
      bridge.onOutputStatusChanged(listener),
  });

  const settingsView = createSettingsView({
    document,
    onGlobalStatus: renderStatus,
  });
  const settingsController = createSettingsController({ api, view: settingsView });
  settingsView.connectController(settingsController);
  settingsView.bind();

  const outputController = createOutputController({
    api,
    view: createOutputView({ document }),
  });
  void outputController.start();

  uiState.controller = createControlController({ api, view: createView() });
  const [settingsReady, presentationReady] = await Promise.all([
    settingsController.loadSettings(),
    uiState.controller.start(),
  ]);
  uiState.ready = settingsReady && presentationReady;
  setMutationControls();

  window.addEventListener('beforeunload', () => {
    uiState.controller?.dispose();
    settingsController.dispose();
    settingsView.dispose();
    outputController.dispose();
  }, { once: true });
}

void boot();
