import {
  buildSettingsDraft,
  settingsEqual,
} from './settings-model.mjs';
import {
  calculateClockOffsetSeconds,
  formatClockTime,
  parseClockTime,
} from './time-calibration.mjs';

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * 系統設定對話框的 DOM 與草稿狀態。
 *
 * 本模組不存取 window、Node API 或 raw IPC；非同步工作由
 * settings-controller 轉交 preload 的固定用途 API。輸出螢幕由 Main
 * 全自動管理，因此此處不提供指定螢幕或全螢幕開關。
 */
export function createSettingsView({
  document,
  onGlobalStatus = () => {},
  now = () => new Date(),
}) {
  const elements = Object.freeze({
    trigger: document.getElementById('open-settings-button'),
    dialog: document.getElementById('settings-dialog'),
    form: document.getElementById('settings-form'),
    body: document.querySelector('.settings-dialog-body'),
    fieldsets: Object.freeze([
      document.getElementById('logo-settings-fieldset'),
      document.getElementById('appearance-settings-fieldset'),
      document.getElementById('behavior-settings-fieldset'),
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
    fontSizePercent: document.getElementById('font-size-percent-input'),
    fontSizePercentError: document.getElementById('font-size-percent-error'),
    lineSpacingPercent: document.getElementById('line-spacing-percent-input'),
    lineSpacingPercentError: document.getElementById('line-spacing-percent-error'),
    inspectionBackgroundColorPicker: document.getElementById(
      'inspection-background-color-picker',
    ),
    inspectionBackgroundColor: document.getElementById(
      'inspection-background-color-input',
    ),
    inspectionBackgroundColorError: document.getElementById(
      'inspection-background-color-error',
    ),
    releaseBackgroundColorPicker: document.getElementById(
      'release-background-color-picker',
    ),
    releaseBackgroundColor: document.getElementById(
      'release-background-color-input',
    ),
    releaseBackgroundColorError: document.getElementById(
      'release-background-color-error',
    ),
    clockTime: document.getElementById('clock-time-input'),
    clockTimeError: document.getElementById('clock-time-error'),
    dateTimeEnabled: document.getElementById('date-time-enabled-input'),
    renderResolution: document.getElementById('render-resolution-select'),
    renderResolutionError: document.getElementById(
      'render-resolution-error',
    ),
    marqueeEnabled: document.getElementById('marquee-enabled-input'),
    loadDefaultsButton: document.getElementById('load-defaults-button'),
    closeButton: document.getElementById('settings-close-button'),
    saveButton: document.getElementById('save-settings-button'),
  });

  const required = [
    ...Object.values(elements).filter((value) => !Array.isArray(value)),
    ...elements.fieldsets,
  ];
  if (required.some((element) => element === null)) {
    throw new TypeError('系統設定對話框缺少必要的畫面元素。');
  }

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
    clockTimeTouched: false,
    clockOffsetSeconds: 0,
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
    'appearance.fontSizePercent': [
      elements.fontSizePercent,
      elements.fontSizePercentError,
    ],
    'appearance.lineSpacingPercent': [
      elements.lineSpacingPercent,
      elements.lineSpacingPercentError,
    ],
    emergency: [
      elements.inspectionBackgroundColor,
      elements.inspectionBackgroundColorError,
    ],
    'emergency.inspectionBackgroundColor': [
      elements.inspectionBackgroundColor,
      elements.inspectionBackgroundColorError,
    ],
    'emergency.releaseBackgroundColor': [
      elements.releaseBackgroundColor,
      elements.releaseBackgroundColorError,
    ],
    dateTime: [elements.clockTime, elements.clockTimeError],
    'dateTime.offsetSeconds': [elements.clockTime, elements.clockTimeError],
    display: [elements.renderResolution, elements.renderResolutionError],
    'display.renderResolution': [
      elements.renderResolution,
      elements.renderResolutionError,
    ],
  });

  function getCurrentSecondOfDay() {
    const current = now();
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
      return null;
    }

    return (
      current.getHours() * 3_600 +
      current.getMinutes() * 60 +
      current.getSeconds()
    );
  }

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
      return {
        ok: false,
        error: { field: 'settings', message: '設定尚未載入。' },
      };
    }

    let clockOffsetSeconds = state.clockOffsetSeconds;
    if (state.clockTimeTouched) {
      const targetSeconds = parseClockTime(elements.clockTime.value);
      const currentSeconds = getCurrentSecondOfDay();
      clockOffsetSeconds = calculateClockOffsetSeconds(
        targetSeconds,
        currentSeconds,
      );

      if (clockOffsetSeconds === null) {
        return {
          ok: false,
          error: {
            field: 'dateTime.offsetSeconds',
            message: '時間必須使用 24 小時 HH:mm:ss，例如 17:01:09。',
          },
        };
      }
    }

    return buildSettingsDraft({
      baseline: state.baseline,
      logoEnabled: elements.logoEnabled.checked,
      logoPath: state.logoPath,
      backgroundColor: elements.backgroundColor.value,
      fontFamily: elements.fontFamily.value,
      fontColor: elements.fontColor.value,
      minimumFontSizeRem: elements.minimumFontSize.value,
      fontSizePercent: elements.fontSizePercent.value,
      lineSpacingPercent: elements.lineSpacingPercent.value,
      inspectionBackgroundColor: elements.inspectionBackgroundColor.value,
      releaseBackgroundColor: elements.releaseBackgroundColor.value,
      dateTimeEnabled: elements.dateTimeEnabled.checked,
      dateTimeOffsetSeconds: clockOffsetSeconds,
      marqueeEnabled: elements.marqueeEnabled.checked,
      renderResolution: elements.renderResolution.value,
    });
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

  function setDirty(dirty) {
    state.dirty = dirty;
    elements.dirtyStatus.textContent = dirty
      ? '有未儲存變更'
      : '所有變更皆已儲存';
    elements.dirtyStatus.classList.toggle('is-dirty', dirty);
    elements.closeButton.textContent = dirty ? '捨棄變更' : '關閉';
    updateControlAvailability();
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

    if (![...elements.fontFamily.options].some(({ value }) => value === fontFamily)) {
      const option = document.createElement('option');
      option.value = fontFamily;
      option.textContent = `目前設定：${fontFamily}`;
      option.dataset.runtimeFont = 'true';
      elements.fontFamily.append(option);
    }
  }

  function renderConfig(config) {
    const currentSeconds = getCurrentSecondOfDay();
    if (currentSeconds === null) {
      throw new TypeError('無法讀取主機目前時間。');
    }

    state.logoPath = config.logo.path;
    state.clockOffsetSeconds = config.dateTime.offsetSeconds;
    state.clockTimeTouched = false;
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
    elements.fontSizePercent.value = String(
      config.appearance.fontSizePercent,
    );
    elements.lineSpacingPercent.value = String(
      config.appearance.lineSpacingPercent,
    );
    elements.inspectionBackgroundColor.value =
      config.emergency.inspectionBackgroundColor;
    elements.inspectionBackgroundColorPicker.value =
      config.emergency.inspectionBackgroundColor.toLowerCase();
    elements.releaseBackgroundColor.value =
      config.emergency.releaseBackgroundColor;
    elements.releaseBackgroundColorPicker.value =
      config.emergency.releaseBackgroundColor.toLowerCase();
    elements.clockTime.value = formatClockTime(
      (currentSeconds + config.dateTime.offsetSeconds + 86_400) % 86_400,
    );
    elements.dateTimeEnabled.checked = config.dateTime.enabled;
    elements.renderResolution.value = config.display.renderResolution;
    elements.marqueeEnabled.checked = config.marquee.enabled;
  }

  function handleDraftInput() {
    clearSettingsErrors();
    refreshDirtyState();
  }

  function handleClockInput() {
    state.clockTimeTouched = true;
    handleDraftInput();
  }

  function closeDialog() {
    if (!elements.dialog.open || state.busy) {
      return;
    }

    state.closing = true;
    elements.dialog.close();
    if (elements.trigger.isConnected && !elements.trigger.disabled) {
      elements.trigger.focus();
    }
  }

  async function openDialog() {
    if (!state.controller || state.busy) {
      return;
    }

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
    state.clockTimeTouched = false;
    state.clockOffsetSeconds = 0;
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

    if (await state.controller.saveSettings(result.config, state.revision)) {
      onGlobalStatus('設定已儲存並即時套用到顯示畫面。');
      closeDialog();
    }
  }

  /** 原生檔案選擇結束後，讓鍵盤操作回到發起動作的按鈕。 */
  async function chooseLogo() {
    if (await state.controller?.chooseLogo()) {
      focusWhenUnlocked(elements.chooseLogoButton);
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
      () => void chooseLogo(),
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
      elements.status.textContent = '已載入預設值；儲存後才會保存。';
      elements.body.scrollTo({ top: 0, behavior: 'auto' });
    }, { signal });
    elements.closeButton.addEventListener('click', closeDialog, { signal });
    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
    }, { signal });
    elements.saveButton.addEventListener(
      'click',
      () => void submitSettings(),
      { signal },
    );

    for (const [picker, textInput] of [
      [elements.backgroundColorPicker, elements.backgroundColor],
      [elements.fontColorPicker, elements.fontColor],
      [
        elements.inspectionBackgroundColorPicker,
        elements.inspectionBackgroundColor,
      ],
      [
        elements.releaseBackgroundColorPicker,
        elements.releaseBackgroundColor,
      ],
    ]) {
      picker.addEventListener('input', () => {
        textInput.value = picker.value.toUpperCase();
        handleDraftInput();
      }, { signal });
      textInput.addEventListener('input', () => {
        if (COLOR_PATTERN.test(textInput.value)) {
          picker.value = textInput.value.toLowerCase();
        }
        handleDraftInput();
      }, { signal });
    }

    for (const control of [
      elements.logoEnabled,
      elements.fontFamily,
      elements.minimumFontSize,
      elements.fontSizePercent,
      elements.lineSpacingPercent,
      elements.dateTimeEnabled,
      elements.renderResolution,
      elements.marqueeEnabled,
    ]) {
      control.addEventListener('input', handleDraftInput, { signal });
      control.addEventListener('change', handleDraftInput, { signal });
    }

    elements.clockTime.addEventListener('input', handleClockInput, { signal });
    elements.clockTime.addEventListener('change', handleClockInput, { signal });

    elements.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (state.busy || state.dirty) {
        elements.status.textContent = state.busy
          ? '設定作業進行中，請稍候。'
          : '尚有未儲存變更；請儲存或按「捨棄變更」。';
      } else {
        closeDialog();
      }
    }, { signal });
    elements.dialog.addEventListener('close', () => {
      const shouldReopen = state.reopenAfterClose;
      state.reopenAfterClose = false;
      state.ready = false;
      state.baseline = null;
      state.defaults = null;
      state.revision = null;
      state.logoPath = null;
      state.clockTimeTouched = false;
      state.clockOffsetSeconds = 0;
      state.closing = false;
      setDirty(false);

      if (shouldReopen) {
        queueMicrotask(() => void openDialog());
      }
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
      elements.status.textContent = '';
      elements.error.textContent = message;
      elements.error.hidden = false;
      const target = fieldTargets[field];
      if (target) {
        const [control, errorElement] = target;
        control.setAttribute('aria-invalid', 'true');
        errorElement.textContent = message;
        errorElement.hidden = false;
        focusWhenUnlocked(field === 'logo' || field === 'logo.path'
          ? elements.chooseLogoButton
          : control);
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
