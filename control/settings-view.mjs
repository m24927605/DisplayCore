import {
  buildSettingsDraft,
  settingsEqual,
} from './settings-model.mjs';

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * 系統設定視圖只管理設定對話框與草稿狀態。
 *
 * 這個模組不直接存取 window、Node API 或 IPC；所有非同步操作皆交給
 * settings-controller，再由 app.mjs 注入固定用途的 preload bridge。
 */
export function createSettingsView({ document, onGlobalStatus = () => {} }) {
  const elements = Object.freeze({
    trigger: document.getElementById('open-settings-button'),
    dialog: document.getElementById('settings-dialog'),
    form: document.getElementById('settings-form'),
    body: document.querySelector('.settings-dialog-body'),
    fieldsets: Object.freeze([
      document.getElementById('logo-settings-fieldset'),
      document.getElementById('appearance-settings-fieldset'),
      document.getElementById('behavior-settings-fieldset'),
      document.getElementById('display-settings-fieldset'),
    ]),
    dirtyStatus: document.getElementById('settings-dirty-status'),
    notice: document.getElementById('settings-notice'),
    error: document.getElementById('settings-error'),
    status: document.getElementById('settings-status'),
    logoEnabled: document.getElementById('logo-enabled-input'),
    logoPath: document.getElementById('logo-path-input'),
    logoPathError: document.getElementById('logo-path-error'),
    chooseLogoButton: document.getElementById('choose-logo-button'),
    removeLogoButton: document.getElementById('remove-logo-button'),
    backgroundColorPicker: document.getElementById('background-color-picker'),
    backgroundColor: document.getElementById('background-color-input'),
    backgroundColorError: document.getElementById('background-color-error'),
    fontFamily: document.getElementById('font-family-select'),
    fontFamilyError: document.getElementById('font-family-error'),
    fontColorPicker: document.getElementById('font-color-picker'),
    fontColor: document.getElementById('font-color-input'),
    fontColorError: document.getElementById('font-color-error'),
    minimumFontSize: document.getElementById('minimum-font-size-input'),
    minimumFontSizeError: document.getElementById('minimum-font-size-error'),
    dateTimeEnabled: document.getElementById('date-time-enabled-input'),
    hour12: document.getElementById('hour12-input'),
    marqueeEnabled: document.getElementById('marquee-enabled-input'),
    displayModeSummary: document.getElementById('display-mode-summary'),
    loadDefaultsButton: document.getElementById('load-defaults-button'),
    closeButton: document.getElementById('settings-close-button'),
    saveButton: document.getElementById('save-settings-button'),
  });

  const state = {
    controller: null,
    baseline: null,
    defaults: null,
    revision: null,
    logoPath: null,
    ready: false,
    busy: false,
    dirty: false,
    closing: false,
    reopenAfterClose: false,
    bound: false,
  };
  const eventController = new AbortController();

  const fieldTargets = Object.freeze({
    logo: [elements.logoPath, elements.logoPathError],
    'logo.path': [elements.logoPath, elements.logoPathError],
    appearance: [elements.backgroundColor, elements.backgroundColorError],
    'appearance.backgroundColor': [
      elements.backgroundColor,
      elements.backgroundColorError,
    ],
    'appearance.fontFamily': [elements.fontFamily, elements.fontFamilyError],
    'appearance.fontColor': [elements.fontColor, elements.fontColorError],
    'appearance.minimumFontSizeRem': [
      elements.minimumFontSize,
      elements.minimumFontSizeError,
    ],
  });
  const fieldFocusTargets = Object.freeze({
    logo: elements.chooseLogoButton,
    'logo.path': elements.chooseLogoButton,
  });

  function focusWhenUnlocked(target) {
    queueMicrotask(() => {
      if (target?.isConnected && !target.disabled && !target.hidden) {
        target.focus();
      }
    });
  }

  function clearSettingsErrors() {
    elements.error.textContent = '';
    elements.error.hidden = true;

    for (const [control, errorElement] of Object.values(fieldTargets)) {
      control.removeAttribute('aria-invalid');
      errorElement.textContent = '';
      errorElement.hidden = true;
    }
  }

  function readDraft() {
    if (!state.baseline) {
      return { ok: false, error: { field: 'settings', message: '設定尚未載入。' } };
    }

    return buildSettingsDraft({
      baseline: state.baseline,
      logoEnabled: elements.logoEnabled.checked,
      logoPath: state.logoPath,
      backgroundColor: elements.backgroundColor.value,
      fontFamily: elements.fontFamily.value,
      fontColor: elements.fontColor.value,
      minimumFontSizeRem: elements.minimumFontSize.value,
      dateTimeEnabled: elements.dateTimeEnabled.checked,
      hour12: elements.hour12.checked,
      marqueeEnabled: elements.marqueeEnabled.checked,
    });
  }

  function setDirty(dirty) {
    state.dirty = dirty;
    elements.dirtyStatus.textContent = dirty
      ? '有未儲存變更'
      : '所有變更皆已儲存';
    elements.dirtyStatus.classList.toggle('is-dirty', dirty);
    elements.closeButton.textContent = dirty ? '捨棄變更' : '關閉';
    updateControlAvailability();
  }

  function updateControlAvailability() {
    const settingsDisabled = state.busy || !state.ready;

    for (const fieldset of elements.fieldsets) {
      fieldset.disabled = settingsDisabled;
    }

    elements.form.setAttribute('aria-busy', String(state.busy));
    elements.closeButton.disabled = state.busy;
    elements.loadDefaultsButton.disabled = settingsDisabled;
    elements.saveButton.disabled = settingsDisabled || !state.dirty;
    elements.removeLogoButton.disabled =
      settingsDisabled || state.logoPath === null;
  }

  function refreshDirtyState() {
    if (!state.ready || !state.baseline) {
      return;
    }

    const result = readDraft();
    setDirty(!result.ok || !settingsEqual(result.config, state.baseline));
  }

  function ensureFontOption(fontFamily) {
    elements.fontFamily
      .querySelectorAll('option[data-runtime-font]')
      .forEach((option) => option.remove());

    const knownOption = [...elements.fontFamily.options].some(
      (option) => option.value === fontFamily,
    );

    if (!knownOption) {
      const option = document.createElement('option');
      option.value = fontFamily;
      option.textContent = `目前設定：${fontFamily}`;
      option.dataset.runtimeFont = 'true';
      elements.fontFamily.append(option);
    }
  }

  function renderConfig(config) {
    state.logoPath = config.logo.path;
    elements.logoEnabled.checked = config.logo.enabled;
    elements.logoPath.value = config.logo.path ?? '';
    elements.backgroundColor.value = config.appearance.backgroundColor;
    elements.backgroundColorPicker.value =
      config.appearance.backgroundColor.toLowerCase();
    ensureFontOption(config.appearance.fontFamily);
    elements.fontFamily.value = config.appearance.fontFamily;
    elements.fontColor.value = config.appearance.fontColor;
    elements.fontColorPicker.value = config.appearance.fontColor.toLowerCase();
    elements.minimumFontSize.value = String(
      config.appearance.minimumFontSizeRem,
    );
    elements.dateTimeEnabled.checked = config.dateTime.enabled;
    elements.hour12.checked = config.dateTime.hour12;
    elements.marqueeEnabled.checked = config.marquee.enabled;
    elements.displayModeSummary.textContent =
      config.display.selectionMode === 'auto'
        ? '自動選擇，優先外接螢幕'
        : `指定螢幕 ID ${config.display.defaultDisplayId}`;
  }

  function closeDialog() {
    if (elements.dialog.open && !state.busy) {
      state.closing = true;
      elements.dialog.close();
    }
  }

  function handleDraftInput() {
    clearSettingsErrors();
    refreshDirtyState();
  }

  function synchronizeColorText(textInput, picker) {
    if (COLOR_PATTERN.test(textInput.value)) {
      picker.value = textInput.value.toLowerCase();
    }
    handleDraftInput();
  }

  function synchronizeColorPicker(picker, textInput) {
    textInput.value = picker.value.toUpperCase();
    handleDraftInput();
  }

  async function openDialog() {
    if (!state.controller || state.busy) {
      return;
    }

    // dialog.close() 先移除 open，close event 稍後才送達；這段間隙的
    // 重開請求必須排到舊生命週期清理完成後，避免舊 close 清掉新草稿。
    if (state.closing) {
      state.reopenAfterClose = true;
      return;
    }

    if (elements.dialog.open) {
      return;
    }

    state.ready = false;
    state.baseline = null;
    state.defaults = null;
    state.revision = null;
    state.logoPath = null;
    clearSettingsErrors();
    elements.notice.textContent = '';
    elements.notice.hidden = true;
    elements.status.textContent = '正在載入設定…';
    setDirty(false);
    elements.dialog.showModal();
    updateControlAvailability();
    await state.controller.loadSettings();
  }

  async function submitSettings() {
    if (!state.controller || state.busy || !state.ready) {
      return;
    }

    clearSettingsErrors();
    const result = readDraft();

    if (!result.ok) {
      view.renderSettingsError(result.error.message, result.error.field);
      return;
    }

    const saved = await state.controller.saveSettings(
      result.config,
      state.revision,
    );

    if (saved) {
      onGlobalStatus('設定已儲存；尚未套用到電視畫面。');
      closeDialog();
    }
  }

  function bind() {
    if (state.bound) {
      return;
    }

    state.bound = true;
    const signal = eventController.signal;
    elements.trigger.addEventListener('click', () => void openDialog(), { signal });
    elements.chooseLogoButton.addEventListener(
      'click',
      () => void state.controller?.chooseLogo(),
      { signal },
    );
    elements.removeLogoButton.addEventListener('click', () => {
      state.logoPath = null;
      elements.logoPath.value = '';
      elements.logoEnabled.checked = false;
      handleDraftInput();
    }, { signal });
    elements.loadDefaultsButton.addEventListener('click', () => {
      if (!state.defaults || state.busy) {
        return;
      }

      clearSettingsErrors();
      renderConfig(state.defaults);
      refreshDirtyState();
      elements.status.textContent = '已載入預設值；按「儲存設定」後才會保存。';
      elements.body.scrollTo({ top: 0, behavior: 'auto' });
    }, { signal });
    elements.closeButton.addEventListener('click', closeDialog, { signal });
    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitSettings();
    }, { signal });

    elements.backgroundColor.addEventListener(
      'input',
      () => synchronizeColorText(
        elements.backgroundColor,
        elements.backgroundColorPicker,
      ),
      { signal },
    );
    elements.backgroundColorPicker.addEventListener(
      'input',
      () => synchronizeColorPicker(
        elements.backgroundColorPicker,
        elements.backgroundColor,
      ),
      { signal },
    );
    elements.fontColor.addEventListener(
      'input',
      () => synchronizeColorText(elements.fontColor, elements.fontColorPicker),
      { signal },
    );
    elements.fontColorPicker.addEventListener(
      'input',
      () => synchronizeColorPicker(elements.fontColorPicker, elements.fontColor),
      { signal },
    );

    for (const control of [
      elements.logoEnabled,
      elements.fontFamily,
      elements.minimumFontSize,
      elements.dateTimeEnabled,
      elements.hour12,
      elements.marqueeEnabled,
    ]) {
      control.addEventListener('input', handleDraftInput, { signal });
      control.addEventListener('change', handleDraftInput, { signal });
    }

    elements.dialog.addEventListener('cancel', (event) => {
      if (state.busy || state.dirty) {
        event.preventDefault();
        elements.status.textContent = state.busy
          ? '設定作業進行中，請稍候。'
          : '尚有未儲存變更；請儲存或按「捨棄變更」。';
      } else {
        state.closing = true;
      }
    }, { signal });
    elements.dialog.addEventListener('close', () => {
      const shouldReopen = state.reopenAfterClose;
      const activeElement = document.activeElement;
      const shouldRestoreTriggerFocus =
        activeElement === null ||
        activeElement === document.body ||
        elements.dialog.contains(activeElement);
      state.reopenAfterClose = false;
      state.ready = false;
      state.baseline = null;
      state.defaults = null;
      state.revision = null;
      state.logoPath = null;
      setDirty(false);
      state.closing = false;

      queueMicrotask(() => {
        if (shouldReopen) {
          void openDialog();
        } else if (
          shouldRestoreTriggerFocus &&
          elements.trigger.isConnected &&
          !elements.trigger.disabled
        ) {
          elements.trigger.focus();
        }
      });
    }, { signal });
  }

  const view = Object.freeze({
    connectController(controller) {
      state.controller = controller;
      elements.trigger.disabled = false;
    },

    bind,

    setSettingsBusy(busy) {
      state.busy = busy;
      updateControlAvailability();
    },

    renderSettingsError(message, field) {
      elements.error.textContent = message;
      elements.error.hidden = false;

      const target = fieldTargets[field];
      if (target) {
        const [control, errorElement] = target;
        control.setAttribute('aria-invalid', 'true');
        errorElement.textContent = message;
        errorElement.hidden = false;
        focusWhenUnlocked(fieldFocusTargets[field] ?? control);
      } else {
        focusWhenUnlocked(elements.error);
      }
    },

    renderLogoSelection(assetPath) {
      state.logoPath = assetPath;
      elements.logoPath.value = assetPath;
      elements.logoEnabled.checked = true;
      clearSettingsErrors();
      refreshDirtyState();
    },

    renderSettingsSnapshot(snapshot) {
      state.baseline = snapshot.config;
      state.defaults = snapshot.defaults;
      state.revision = snapshot.revision;
      state.ready = true;
      clearSettingsErrors();
      renderConfig(snapshot.config);
      elements.notice.textContent = snapshot.notice?.message ?? '';
      elements.notice.hidden = snapshot.notice === null;
      setDirty(false);
    },

    renderSettingsStatus(message) {
      elements.status.textContent = message;
    },

    dispose() {
      eventController.abort();
      state.controller = null;
      elements.trigger.disabled = true;
    },
  });

  updateControlAvailability();
  return view;
}
