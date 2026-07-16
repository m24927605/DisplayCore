import { createControlController } from './control-controller.mjs';
import {
  ACTIONS,
  EMERGENCY_CODES,
  composeMessage,
  createEmergencyPresentation,
} from './message-composer.mjs';

const elements = Object.freeze({
  form: document.getElementById('message-form'),
  recipientInput: document.getElementById('recipient-input'),
  recipientError: document.getElementById('recipient-error'),
  actionFieldset: document.getElementById('action-fieldset'),
  actionError: document.getElementById('action-error'),
  customField: document.getElementById('custom-message-field'),
  customInput: document.getElementById('custom-message-input'),
  customError: document.getElementById('custom-message-error'),
  preview: document.getElementById('message-preview'),
  showButton: document.getElementById('show-message-button'),
  clearButton: document.getElementById('clear-display-button'),
  currentMessage: document.getElementById('current-message'),
  currentLayout: document.getElementById('current-layout'),
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
  validationVisible: false,
  pendingEmergency: null,
  focusBeforeBusy: null,
  controller: null,
};

function getActionInputs() {
  return [...elements.form.querySelectorAll('input[name="action"]')];
}

function getSelectedAction() {
  return elements.form.querySelector('input[name="action"]:checked')?.value;
}

function readDraft() {
  return {
    recipient: elements.recipientInput.value,
    action: getSelectedAction(),
    customText: elements.customInput.value,
  };
}

function clearFieldErrors() {
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

function renderFieldError(error, focusInvalidField = false) {
  clearFieldErrors();

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

/**
 * 同步草稿、動作區與精確預覽。
 *
 * 預覽不是 live region，避免每次 IME 組字或按鍵都打斷螢幕閱讀器。
 */
function updateDraftView() {
  const selectedAction = getSelectedAction();
  const usesCustomText = selectedAction === ACTIONS.CUSTOM;

  elements.customField.hidden = !usesCustomText;
  elements.customInput.disabled = uiState.busy || !usesCustomText;

  const result = composeMessage(readDraft());

  if (result.ok) {
    elements.preview.textContent = result.presentation.message;
    elements.preview.classList.remove('is-placeholder');

    if (uiState.validationVisible) {
      clearFieldErrors();
    }
  } else {
    elements.preview.textContent = usesCustomText
      ? '請輸入自定義內容'
      : '請先輸入編號或花名';
    elements.preview.classList.add('is-placeholder');

    if (uiState.validationVisible) {
      renderFieldError(result.error);
    }
  }

  elements.showButton.disabled =
    uiState.busy || !uiState.ready || !result.ok;

  return result;
}

function setMutationControls() {
  elements.recipientInput.disabled = uiState.busy;

  for (const actionInput of getActionInputs()) {
    actionInput.disabled = uiState.busy;
  }

  elements.clearButton.disabled = uiState.busy || !uiState.ready;

  for (const button of elements.inspectionButtons) {
    button.disabled = uiState.busy || !uiState.ready;
  }

  elements.dialogConfirmButton.disabled = uiState.busy;
  elements.dialogCancelButton.disabled = uiState.busy;
  updateDraftView();
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

function renderPresentation(snapshot) {
  const isEmpty = snapshot.message.length === 0;

  elements.currentMessage.textContent = isEmpty
    ? '目前為空白畫面'
    : snapshot.message;
  elements.currentMessage.classList.toggle('is-placeholder', isEmpty);
  elements.currentLayout.textContent =
    snapshot.layout === 'fill-screen' ? '滿屏' : '單行';
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

async function submitDraft() {
  if (!uiState.ready || !uiState.controller || uiState.busy) {
    renderError('控制介面尚未就緒，請稍後再試。');
    return;
  }

  uiState.validationVisible = true;
  const result = updateDraftView();

  if (!result.ok) {
    renderFieldError(result.error, true);
    return;
  }

  clearFieldErrors();
  await uiState.controller.showPresentation(
    result.presentation,
    '一般訊息已顯示到電視。',
  );
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

  uiState.pendingEmergency = Object.freeze({
    code,
    presentation: Object.freeze({ ...result.presentation }),
    triggerButton,
  });

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

  const succeeded = await uiState.controller.showPresentation(
    pendingEmergency.presentation,
    successMessage,
  );

  if (!succeeded) {
    elements.dialogError.textContent =
      '代碼尚未顯示，原畫面未變更。請確認後重試。';
    elements.dialogError.hidden = false;
    return;
  }

  if (elements.dialog.open) {
    elements.dialog.close();
  }
}

function bindUiEvents() {
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitDraft();
  });

  elements.recipientInput.addEventListener('input', updateDraftView);
  elements.customInput.addEventListener('input', updateDraftView);

  for (const actionInput of getActionInputs()) {
    actionInput.addEventListener('change', updateDraftView);
  }

  elements.clearButton.addEventListener('click', () => {
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
  return ['onPresentationChanged', 'getPresentation', 'showMessage', 'clearMessage']
    .every((methodName) => typeof api?.[methodName] === 'function');
}

async function boot() {
  bindUiEvents();
  updateDraftView();

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
    showMessage: (message, layout) => bridge.showMessage(message, layout),
    clearMessage: () => bridge.clearMessage(),
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
