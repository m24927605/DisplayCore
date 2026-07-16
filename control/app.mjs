import { createControlController } from './control-controller.mjs';
import {
  ACTIONS,
  EMERGENCY_CODES,
  composeMessage,
  createEmergencyPresentation,
} from './message-composer.mjs';
import {
  PLAYBACK_MODES,
  PROGRAM_LIMITS,
  appendMessage,
  buildProgram,
  countPages,
  formatDuration,
  removeMessage,
} from './program-builder.mjs';

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
  addMessageButton: document.getElementById('add-message-button'),
  queue: document.getElementById('message-queue'),
  queuePages: document.getElementById('queue-pages'),
  queueEmptyState: document.getElementById('queue-empty-state'),
  queueError: document.getElementById('queue-error'),
  queueMessageCount: document.getElementById('queue-message-count'),
  queuePageCount: document.getElementById('queue-page-count'),
  clearQueueButton: document.getElementById('clear-queue-button'),
  playbackForm: document.getElementById('playback-form'),
  pageDurationInput: document.getElementById('page-duration-input'),
  pageDurationError: document.getElementById('page-duration-error'),
  repeatModeFieldset: document.getElementById('repeat-mode-fieldset'),
  repeatError: document.getElementById('repeat-error'),
  roundCountField: document.getElementById('round-count-field'),
  roundCountInput: document.getElementById('round-count-input'),
  roundCountError: document.getElementById('round-count-error'),
  summaryPageCount: document.getElementById('summary-page-count'),
  roundDuration: document.getElementById('round-duration'),
  totalDuration: document.getElementById('total-duration'),
  startProgramButton: document.getElementById('start-program-button'),
  clearDisplayButton: document.getElementById('clear-display-button'),
  currentMessage: document.getElementById('current-message'),
  currentLayout: document.getElementById('current-layout'),
  currentPageProgress: document.getElementById('current-page-progress'),
  currentRoundProgress: document.getElementById('current-round-progress'),
  currentRevision: document.getElementById('current-revision'),
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
  playbackValidationVisible: false,
  messages: Object.freeze([]),
  queueErrorMessage: null,
  pendingEmergency: null,
  focusBeforeBusy: null,
  controller: null,
};

function getActionInputs() {
  return [...elements.messageForm.querySelectorAll('input[name="action"]')];
}

function getRepeatModeInputs() {
  return [...elements.playbackForm.querySelectorAll(
    'input[name="repeat-mode"]',
  )];
}

function getSelectedAction() {
  return elements.messageForm.querySelector(
    'input[name="action"]:checked',
  )?.value;
}

function getSelectedRepeatMode() {
  return elements.playbackForm.querySelector(
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

function readPlaybackDraft() {
  return {
    messages: uiState.messages,
    pageDurationSeconds: elements.pageDurationInput.value,
    repeatMode: getSelectedRepeatMode(),
    rounds: elements.roundCountInput.value,
  };
}

function clearDraftFieldErrors() {
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

function renderDraftFieldError(error, focusInvalidField = false) {
  clearDraftFieldErrors();

  const errorTargets = {
    recipient: [elements.recipientInput, elements.recipientError],
    action: [elements.actionFieldset, elements.actionError],
    customText: [elements.customInput, elements.customError],
  };
  const [control, errorElement] = errorTargets[error.field] ||
    errorTargets.action;

  control.setAttribute('aria-invalid', 'true');
  errorElement.textContent = error.message;
  errorElement.hidden = false;

  if (focusInvalidField) {
    if (control === elements.actionFieldset) {
      getActionInputs()[0]?.focus();
    } else {
      control.focus();
    }
  }
}

function clearPlaybackFieldErrors() {
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

function renderPlaybackFieldError(error, focusInvalidField = false) {
  clearPlaybackFieldErrors();

  const errorTargets = {
    pageDurationSeconds: [
      elements.pageDurationInput,
      elements.pageDurationError,
    ],
    repeat: [elements.repeatModeFieldset, elements.repeatError],
    rounds: [elements.roundCountInput, elements.roundCountError],
  };
  const target = errorTargets[error.field];

  if (!target) {
    return;
  }

  const [control, errorElement] = target;
  control.setAttribute('aria-invalid', 'true');
  errorElement.textContent = error.message;
  errorElement.hidden = false;

  if (focusInvalidField) {
    if (control === elements.repeatModeFieldset) {
      getRepeatModeInputs()[0]?.focus();
    } else {
      control.focus();
    }
  }
}

function renderQueueError() {
  const hasError = typeof uiState.queueErrorMessage === 'string';
  elements.queueError.textContent = hasError ? uiState.queueErrorMessage : '';
  elements.queueError.hidden = !hasError;
}

/**
 * 同步單則草稿、自定義欄位與精確預覽。
 *
 * 預覽不是 live region，避免每次 IME 組字或按鍵都打斷螢幕閱讀器。
 */
function updateMessageDraftView() {
  const selectedAction = getSelectedAction();
  const usesCustomText = selectedAction === ACTIONS.CUSTOM;

  elements.customField.hidden = !usesCustomText;
  elements.customInput.disabled = uiState.busy || !usesCustomText;

  const result = composeMessage(readMessageDraft());

  if (result.ok) {
    elements.preview.textContent = result.presentation.message;
    elements.preview.classList.remove('is-placeholder');

    if (uiState.draftValidationVisible) {
      clearDraftFieldErrors();
    }
  } else {
    elements.preview.textContent = usesCustomText
      ? '請輸入自定義內容'
      : '請先輸入編號或花名';
    elements.preview.classList.add('is-placeholder');

    if (uiState.draftValidationVisible) {
      renderDraftFieldError(result.error);
    }
  }

  elements.addMessageButton.disabled =
    uiState.busy ||
    !uiState.ready ||
    !result.ok ||
    uiState.messages.length >= PROGRAM_LIMITS.MAX_MESSAGE_COUNT;

  return result;
}

function createQueueMessageItem(message, messageIndex) {
  const item = document.createElement('li');
  item.className = 'queue-message-item';

  const sequence = document.createElement('span');
  sequence.className = 'queue-sequence';
  sequence.textContent = String(messageIndex + 1).padStart(2, '0');
  sequence.setAttribute('aria-hidden', 'true');

  const messageText = document.createElement('span');
  messageText.className = 'queue-message-text';
  messageText.textContent = message;

  const removeButton = document.createElement('button');
  removeButton.className = 'queue-remove-button';
  removeButton.type = 'button';
  removeButton.dataset.messageIndex = String(messageIndex);
  removeButton.disabled = uiState.busy;
  removeButton.setAttribute(
    'aria-label',
    `刪除第 ${messageIndex + 1} 則訊息`,
  );
  removeButton.textContent = '×';

  item.append(sequence, messageText, removeButton);
  return item;
}

function createQueuePage(pageNumber, pageMessages, startIndex) {
  const page = document.createElement('section');
  page.className = 'queue-page';
  page.setAttribute('aria-labelledby', `queue-page-title-${pageNumber}`);

  const header = document.createElement('div');
  header.className = 'queue-page-header';

  const title = document.createElement('h3');
  title.id = `queue-page-title-${pageNumber}`;
  title.className = 'queue-page-title';
  title.textContent = `第 ${pageNumber} 頁`;

  const capacity = document.createElement('span');
  capacity.className = 'queue-page-capacity';
  capacity.textContent = `${pageMessages.length} / ${PROGRAM_LIMITS.MESSAGES_PER_PAGE} 則`;

  header.append(title, capacity);

  const list = document.createElement('ol');
  list.className = 'queue-message-list';

  pageMessages.forEach(({ message }, pageIndex) => {
    list.append(createQueueMessageItem(message, startIndex + pageIndex));
  });

  page.append(header, list);
  return page;
}

/** 依每頁五則將本機草稿清單投影成可編輯的分頁預覽。 */
function renderQueue() {
  const messageCount = uiState.messages.length;
  const pageCount = countPages(messageCount);
  elements.queue.dataset.messageCount = String(messageCount);
  elements.queueMessageCount.textContent = `${messageCount} 則`;
  elements.queuePageCount.textContent = `${pageCount} 頁`;
  elements.queueEmptyState.hidden = messageCount > 0;
  elements.queuePages.hidden = messageCount === 0;
  elements.clearQueueButton.disabled = uiState.busy || messageCount === 0;
  elements.queuePages.replaceChildren();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const startIndex = pageIndex * PROGRAM_LIMITS.MESSAGES_PER_PAGE;
    const pageMessages = uiState.messages.slice(
      startIndex,
      startIndex + PROGRAM_LIMITS.MESSAGES_PER_PAGE,
    );
    elements.queuePages.append(
      createQueuePage(pageIndex + 1, pageMessages, startIndex),
    );
  }

  renderQueueError();
}

/** 驗證播放設定，並只以派生值顯示每輪與總播放時間。 */
function updatePlaybackView({ focusInvalidField = false } = {}) {
  const repeatMode = getSelectedRepeatMode();
  const usesFiniteRounds = repeatMode === PLAYBACK_MODES.FINITE;
  const pageCount = countPages(uiState.messages.length);

  elements.pageDurationInput.disabled = uiState.busy || !uiState.ready;
  elements.roundCountInput.disabled =
    uiState.busy || !uiState.ready || !usesFiniteRounds;
  elements.roundCountField.classList.toggle('is-disabled', !usesFiniteRounds);

  for (const input of getRepeatModeInputs()) {
    input.disabled = uiState.busy || !uiState.ready;
  }

  elements.summaryPageCount.textContent = `${pageCount} 頁`;
  const result = buildProgram(readPlaybackDraft());

  if (result.ok) {
    elements.roundDuration.textContent = formatDuration(
      result.summary.secondsPerRound,
    );
    elements.totalDuration.textContent = formatDuration(
      result.summary.totalSeconds,
    );
  } else if (uiState.messages.length === 0) {
    elements.roundDuration.textContent = '—';
    elements.totalDuration.textContent = '—';
  } else {
    elements.roundDuration.textContent = '設定有誤';
    elements.totalDuration.textContent = '設定有誤';
  }

  elements.startProgramButton.disabled =
    uiState.busy || !uiState.ready || !result.ok;

  if (uiState.playbackValidationVisible) {
    clearPlaybackFieldErrors();

    if (!result.ok) {
      renderPlaybackFieldError(result.error, focusInvalidField);
    }
  }

  return result;
}

function setMutationControls() {
  elements.recipientInput.disabled = uiState.busy;

  for (const actionInput of getActionInputs()) {
    actionInput.disabled = uiState.busy;
  }

  elements.clearDisplayButton.disabled = uiState.busy || !uiState.ready;

  for (const button of elements.inspectionButtons) {
    button.disabled = uiState.busy || !uiState.ready;
  }

  elements.dialogConfirmButton.disabled = uiState.busy;
  elements.dialogCancelButton.disabled = uiState.busy;
  updateMessageDraftView();
  renderQueue();
  updatePlaybackView();
}

function renderStatus(message) {
  elements.operationError.textContent = '';
  elements.operationError.hidden = true;
  elements.operationStatus.textContent = message;
  elements.operationStatus.hidden = false;
}

function renderError(message) {
  elements.operationStatus.textContent = '';
  elements.operationStatus.hidden = true;
  elements.operationError.textContent = message;
  elements.operationError.hidden = false;
}

/** Main 只傳現在這一頁；Control 也以逐列純文字顯示。 */
function renderPresentation(snapshot) {
  const isEmpty = snapshot.mode === 'blank';
  const isFillScreen = snapshot.mode === 'emergency';
  elements.currentMessage.replaceChildren();
  elements.currentMessage.classList.toggle('is-placeholder', isEmpty);
  elements.currentMessage.classList.toggle('is-fill-screen', isFillScreen);

  if (isEmpty) {
    elements.currentMessage.textContent = '目前為空白畫面';
  } else if (isFillScreen) {
    elements.currentMessage.textContent = snapshot.messages[0].message;
  } else {
    for (const { message } of snapshot.messages) {
      const row = document.createElement('span');
      row.className = 'current-message-row';
      row.textContent = message;
      elements.currentMessage.append(row);
    }
  }

  elements.currentLayout.textContent = isFillScreen ? '滿屏' : '單行';
  elements.currentPageProgress.textContent = snapshot.mode === 'page'
    ? `第 ${snapshot.pageNumber} / ${snapshot.pageCount} 頁`
    : '—';
  elements.currentRoundProgress.textContent = snapshot.mode !== 'page'
    ? '—'
    : snapshot.totalRounds === null
      ? '持續循環'
      : `第 ${snapshot.roundNumber} / ${snapshot.totalRounds} 輪`;
  elements.currentRevision.textContent = `#${snapshot.revision}`;
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

      if (busy) {
        renderStatus('正在更新顯示畫面…');
      }

      setMutationControls();

      if (!busy) {
        const focusTarget = uiState.focusBeforeBusy;
        uiState.focusBeforeBusy = null;

        queueMicrotask(() => {
          if (focusTarget?.isConnected && !focusTarget.disabled) {
            focusTarget.focus();
          }
        });
      }
    },
    renderPresentation,
    renderStatus,
    renderError,
  });
}

function addMessageDraft() {
  uiState.draftValidationVisible = true;
  const composed = updateMessageDraftView();

  if (!composed.ok) {
    renderDraftFieldError(composed.error, true);
    return;
  }

  const appended = appendMessage(
    uiState.messages,
    composed.presentation.message,
  );

  if (!appended.ok) {
    uiState.queueErrorMessage = appended.error.message;
    renderQueue();
    return;
  }

  uiState.messages = appended.messages;
  uiState.queueErrorMessage = null;
  uiState.draftValidationVisible = false;
  uiState.playbackValidationVisible = false;
  elements.recipientInput.value = '';
  elements.customInput.value = '';
  clearDraftFieldErrors();
  clearPlaybackFieldErrors();
  updateMessageDraftView();
  renderQueue();
  updatePlaybackView();
  renderStatus(`已加入第 ${uiState.messages.length} 則訊息，尚未送到電視。`);
  elements.recipientInput.focus();
}

function removeQueuedMessage(index) {
  const removed = removeMessage(uiState.messages, index);

  if (!removed.ok) {
    uiState.queueErrorMessage = removed.error.message;
    renderQueue();
    return;
  }

  uiState.messages = removed.messages;
  uiState.queueErrorMessage = null;
  uiState.playbackValidationVisible = false;
  renderQueue();
  updatePlaybackView();
  renderStatus('已從待播清單刪除訊息，電視畫面未改變。');

  queueMicrotask(() => {
    const nextIndex = Math.min(index, uiState.messages.length - 1);
    const focusTarget = nextIndex >= 0
      ? elements.queuePages.querySelector(
        `.queue-remove-button[data-message-index="${nextIndex}"]`,
      )
      : elements.recipientInput;
    focusTarget?.focus();
  });
}

function clearMessageQueue() {
  if (uiState.busy || uiState.messages.length === 0) {
    return;
  }

  uiState.messages = Object.freeze([]);
  uiState.queueErrorMessage = null;
  uiState.playbackValidationVisible = false;
  renderQueue();
  updatePlaybackView();
  renderStatus('待播清單已清空，電視畫面未改變。');
  elements.recipientInput.focus();
}

async function startProgram() {
  if (!uiState.ready || !uiState.controller || uiState.busy) {
    renderError('控制介面尚未就緒，請稍後再試。');
    return;
  }

  uiState.playbackValidationVisible = true;
  const result = updatePlaybackView({ focusInvalidField: true });

  if (!result.ok) {
    return;
  }

  clearPlaybackFieldErrors();
  const succeeded = await uiState.controller.startProgram(
    result.program,
    result.program.repeat.mode === PLAYBACK_MODES.FINITE
      ? `訊息清單已開始顯示 ${result.program.repeat.rounds} 整輪。`
      : '訊息清單已開始持續顯示。',
  );

  // 無論成功或失敗都保留草稿，便於重播或修正。
  if (!succeeded) {
    renderQueue();
  }
}

function openEmergencyDialog(triggerButton) {
  if (uiState.busy || !uiState.ready || elements.dialog.open) {
    return;
  }

  const code = triggerButton.dataset.emergencyCode;
  const result = createEmergencyPresentation(code);

  if (!result.ok) {
    renderError('無法辨識滿屏代碼，請重新啟動 DisplayCore。');
    return;
  }

  uiState.pendingEmergency = Object.freeze({ code, triggerButton });

  const isInspection = code === EMERGENCY_CODES.INSPECTION;
  elements.dialog.dataset.tone = isInspection ? 'inspection' : 'clear';
  elements.dialogTitle.textContent = isInspection
    ? '確認顯示臨檢代碼 555？'
    : '確認顯示解除代碼 888？';
  elements.dialogDescription.textContent =
    '此操作會立即覆蓋目前訊息，並切換為不受單行限制的滿屏模式。';
  elements.dialogCode.textContent = code;
  elements.dialogError.textContent = '';
  elements.dialogError.hidden = true;
  elements.dialogConfirmButton.textContent = `確認顯示 ${code}`;
  elements.dialog.showModal();
}

async function confirmEmergency() {
  const pendingEmergency = uiState.pendingEmergency;

  if (!pendingEmergency || uiState.busy) {
    return;
  }

  const successMessage =
    pendingEmergency.code === EMERGENCY_CODES.INSPECTION
      ? '臨檢代碼 555 已使用滿屏顯示。'
      : '解除代碼 888 已使用滿屏顯示。';

  const succeeded = await uiState.controller.showEmergency(
    pendingEmergency.code,
    successMessage,
  );

  if (!succeeded) {
    elements.dialogError.textContent =
      '無法確認代碼是否已顯示。請先查看目前顯示狀態或電視畫面，再決定是否重試。';
    elements.dialogError.hidden = false;
    return;
  }

  if (elements.dialog.open) {
    elements.dialog.close();
  }
}

function bindUiEvents() {
  elements.messageForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addMessageDraft();
  });

  elements.recipientInput.addEventListener('input', updateMessageDraftView);
  elements.customInput.addEventListener('input', updateMessageDraftView);

  for (const actionInput of getActionInputs()) {
    actionInput.addEventListener('change', updateMessageDraftView);
  }

  elements.queuePages.addEventListener('click', (event) => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const removeButton = target.closest('.queue-remove-button');

    if (!removeButton || uiState.busy) {
      return;
    }

    removeQueuedMessage(Number(removeButton.dataset.messageIndex));
  });

  elements.clearQueueButton.addEventListener('click', clearMessageQueue);

  elements.pageDurationInput.addEventListener('input', () => {
    updatePlaybackView();
  });
  elements.roundCountInput.addEventListener('input', () => {
    updatePlaybackView();
  });

  for (const repeatModeInput of getRepeatModeInputs()) {
    repeatModeInput.addEventListener('change', () => {
      updatePlaybackView();
    });
  }

  elements.playbackForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void startProgram();
  });

  elements.clearDisplayButton.addEventListener('click', () => {
    void uiState.controller.clearPresentation();
  });

  for (const button of elements.inspectionButtons) {
    button.addEventListener('click', () => openEmergencyDialog(button));
  }

  elements.dialogCancelButton.addEventListener('click', () => {
    if (!uiState.busy) {
      elements.dialog.close();
    }
  });

  elements.dialogConfirmButton.addEventListener('click', () => {
    void confirmEmergency();
  });

  elements.dialog.addEventListener('cancel', (event) => {
    if (uiState.busy) {
      event.preventDefault();
    }
  });

  elements.dialog.addEventListener('close', () => {
    const triggerButton = uiState.pendingEmergency?.triggerButton;
    uiState.pendingEmergency = null;
    elements.dialogError.textContent = '';
    elements.dialogError.hidden = true;

    queueMicrotask(() => {
      if (triggerButton?.isConnected && !triggerButton.disabled) {
        triggerButton.focus();
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
  ].every((methodName) => typeof api?.[methodName] === 'function');
}

async function boot() {
  bindUiEvents();
  updateMessageDraftView();
  renderQueue();
  updatePlaybackView();

  const bridge = window.displayCoreControl;

  if (!hasRequiredBridge(bridge)) {
    renderError('安全通訊橋接未載入，請重新啟動 DisplayCore。');
    return;
  }

  // Renderer 只轉接固定用途方法，不接觸 channel、底層 IPC 或 Node API。
  const api = Object.freeze({
    onPresentationChanged: (listener) =>
      bridge.onPresentationChanged(listener),
    getPresentation: () => bridge.getPresentation(),
    startProgram: (program) => bridge.startProgram(
      program.messages,
      program.pageDurationSeconds,
      program.repeat,
    ),
    showEmergency: (code) => bridge.showEmergency(code),
    clearPresentation: () => bridge.clearPresentation(),
  });

  uiState.controller = createControlController({ api, view: createView() });
  const started = await uiState.controller.start();
  uiState.ready = started;
  setMutationControls();

  window.addEventListener(
    'beforeunload',
    () => {
      uiState.controller?.dispose();
    },
    { once: true },
  );
}

void boot();
