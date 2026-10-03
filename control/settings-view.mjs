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
const MAXIMUM_STANDBY_BACKGROUND_IMAGES = 20;

/**
 * 系統設定對話框的 DOM 與草稿狀態。
 *
 * 本模組不存取 window、Node API 或 raw IPC；非同步工作由
 * settings-controller 轉交 preload 的固定用途 API。螢幕清單只使用
 * Main 經安全投影後的輸出快照，不直接存取 Electron screen API。
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
      document.getElementById('playback-settings-fieldset'),
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
    logoSizePercent: document.getElementById('logo-size-percent-input'),
    logoSizePercentError: document.getElementById(
      'logo-size-percent-error',
    ),
    chooseLogoButton: document.getElementById('choose-logo-button'),
    removeLogoButton: document.getElementById('remove-logo-button'),
    standbyBackgroundMode: document.getElementById(
      'standby-background-mode-select',
    ),
    standbyBackgroundSummary: document.getElementById(
      'standby-background-summary',
    ),
    standbyBackgroundError: document.getElementById(
      'standby-background-error',
    ),
    standbySlideDurationField: document.getElementById(
      'standby-slide-duration-field',
    ),
    standbySlideDuration: document.getElementById(
      'standby-slide-duration-input',
    ),
    standbySlideDurationError: document.getElementById(
      'standby-slide-duration-error',
    ),
    chooseStandbyBackgroundButton: document.getElementById(
      'choose-standby-background-button',
    ),
    removeStandbyBackgroundButton: document.getElementById(
      'remove-standby-background-button',
    ),
    standbyBackgroundList: document.getElementById('standby-background-list'),
    backgroundColorField: document.getElementById('background-color-field'),
    backgroundColorPicker: document.getElementById('background-color-picker'),
    backgroundColor: document.getElementById('background-color-input'),
    backgroundColorError: document.getElementById('background-color-error'),
    messageBackgroundPreset: document.getElementById(
      'message-background-preset-select',
    ),
    messageBackgroundPresetError: document.getElementById(
      'message-background-preset-error',
    ),
    fontFamily: document.getElementById('font-family-select'),
    fontFamilyError: document.getElementById('font-family-error'),
    fontColorPicker: document.getElementById('font-color-picker'),
    fontColor: document.getElementById('font-color-input'),
    fontColorError: document.getElementById('font-color-error'),
    minimumFontSize: document.getElementById('minimum-font-size-input'),
    minimumFontSizeError: document.getElementById('minimum-font-size-error'),
    fontSizePercent: document.getElementById('font-size-percent-input'),
    fontSizePercentError: document.getElementById('font-size-percent-error'),
    standbyClockSizePercent: document.getElementById(
      'standby-clock-size-percent-input',
    ),
    standbyClockSizePercentError: document.getElementById(
      'standby-clock-size-percent-error',
    ),
    lineSpacingPercent: document.getElementById('line-spacing-percent-input'),
    lineSpacingPercentError: document.getElementById('line-spacing-percent-error'),
    messageLiquidEffectEnabled: document.getElementById(
      'message-liquid-effect-enabled-input',
    ),
    standbySandEffectEnabled: document.getElementById(
      'standby-sand-effect-enabled-input',
    ),
    standbySandEffectError: document.getElementById(
      'standby-sand-effect-error',
    ),
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
    controlDisplay: document.getElementById('control-display-select'),
    defaultDisplay: document.getElementById('default-display-select'),
    displayAssignmentError: document.getElementById(
      'display-assignment-error',
    ),
    clockTime: document.getElementById('clock-time-input'),
    clockTimeError: document.getElementById('clock-time-error'),
    dateTimeEnabled: document.getElementById('date-time-enabled-input'),
    renderResolution: document.getElementById('render-resolution-select'),
    renderResolutionError: document.getElementById(
      'render-resolution-error',
    ),
    outputMonitorStatus: document.getElementById('output-monitor-status'),
    brightnessEnabled: document.getElementById('brightness-enabled-input'),
    brightnessPercent: document.getElementById('brightness-percent-input'),
    brightnessPercentError: document.getElementById(
      'brightness-percent-error',
    ),
    contrastEnabled: document.getElementById('contrast-enabled-input'),
    contrastPercent: document.getElementById('contrast-percent-input'),
    contrastPercentError: document.getElementById('contrast-percent-error'),
    marqueeEnabled: document.getElementById('marquee-enabled-input'),
    loadDefaultsButton: document.getElementById('load-defaults-button'),
    closeButton: document.getElementById('settings-close-button'),
    saveButton: document.getElementById('save-settings-button'),
    pageDuration: document.getElementById('page-duration-input'),
    pageDurationError: document.getElementById('page-duration-error'),
    repeatModeFieldset: document.getElementById('repeat-mode-fieldset'),
    repeatModeError: document.getElementById('repeat-error'),
    repeatModeFinite: document.querySelector(
      'input[name="repeat-mode"][value="finite"]',
    ),
    repeatModeContinuous: document.querySelector(
      'input[name="repeat-mode"][value="continuous"]',
    ),
    roundCountField: document.getElementById('round-count-field'),
    roundCount: document.getElementById('round-count-input'),
    roundCountError: document.getElementById('round-count-error'),
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
    standbyBackgroundImagePaths: [],
    ready: false,
    busy: false,
    dirty: false,
    closing: false,
    reopenAfterClose: false,
    bound: false,
    clockTimeTouched: false,
    clockOffsetSeconds: 0,
    outputDisplays: [],
    outputMonitor: null,
  };
  const eventController = new AbortController();
  const fieldTargets = Object.freeze({
    logo: [elements.logoPath, elements.logoPathError],
    'logo.path': [elements.logoPath, elements.logoPathError],
    'logo.sizePercent': [
      elements.logoSizePercent,
      elements.logoSizePercentError,
    ],
    standby: [
      elements.standbyBackgroundSummary,
      elements.standbyBackgroundError,
    ],
    'standby.backgroundMode': [
      elements.standbyBackgroundMode,
      elements.standbyBackgroundError,
    ],
    'standby.backgroundImagePaths': [
      elements.standbyBackgroundSummary,
      elements.standbyBackgroundError,
    ],
    'standby.slideDurationSeconds': [
      elements.standbySlideDuration,
      elements.standbySlideDurationError,
    ],
    'standby.sandEffectEnabled': [
      elements.standbySandEffectEnabled,
      elements.standbySandEffectError,
    ],
    appearance: [elements.backgroundColor, elements.backgroundColorError],
    'appearance.backgroundColor': [
      elements.backgroundColor,
      elements.backgroundColorError,
    ],
    'appearance.messageBackgroundPreset': [
      elements.messageBackgroundPreset,
      elements.messageBackgroundPresetError,
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
    'appearance.standbyClockSizePercent': [
      elements.standbyClockSizePercent,
      elements.standbyClockSizePercentError,
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
    display: [
      elements.controlDisplay,
      elements.displayAssignmentError,
    ],
    'display.controlDisplayId': [
      elements.controlDisplay,
      elements.displayAssignmentError,
    ],
    'display.defaultDisplayId': [
      elements.defaultDisplay,
      elements.displayAssignmentError,
    ],
    'display.renderResolution': [
      elements.renderResolution,
      elements.renderResolutionError,
    ],
    'display.brightnessPercent': [
      elements.brightnessPercent,
      elements.brightnessPercentError,
    ],
    'display.contrastPercent': [
      elements.contrastPercent,
      elements.contrastPercentError,
    ],
    playback: [elements.pageDuration, elements.pageDurationError],
    'playback.pageDurationSeconds': [
      elements.pageDuration,
      elements.pageDurationError,
    ],
    'playback.repeatMode': [
      elements.repeatModeFieldset,
      elements.repeatModeError,
    ],
    'playback.roundCount': [
      elements.roundCount,
      elements.roundCountError,
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

    const messageBackgroundPreset = elements.messageBackgroundPreset.value;
    return buildSettingsDraft({
      baseline: state.baseline,
      logoEnabled: elements.logoEnabled.checked,
      logoPath: state.logoPath,
      logoSizePercent: elements.logoSizePercent.value,
      standbyBackgroundMode: elements.standbyBackgroundMode.value,
      standbyBackgroundImagePaths: [...state.standbyBackgroundImagePaths],
      standbySlideDurationSeconds: elements.standbySlideDuration.value,
      standbySandEffectEnabled: elements.standbySandEffectEnabled.checked,
      backgroundColor: messageBackgroundPreset === 'solid'
        ? elements.backgroundColor.value
        : state.baseline.appearance.backgroundColor,
      messageBackgroundPreset,
      fontFamily: elements.fontFamily.value,
      fontColor: elements.fontColor.value,
      minimumFontSizeRem: elements.minimumFontSize.value,
      fontSizePercent: elements.fontSizePercent.value,
      standbyClockSizePercent: elements.standbyClockSizePercent.value,
      lineSpacingPercent: elements.lineSpacingPercent.value,
      messageLiquidEffectEnabled: elements.messageLiquidEffectEnabled.checked,
      inspectionBackgroundColor: elements.inspectionBackgroundColor.value,
      releaseBackgroundColor: elements.releaseBackgroundColor.value,
      dateTimeEnabled: elements.dateTimeEnabled.checked,
      dateTimeOffsetSeconds: clockOffsetSeconds,
      marqueeEnabled: elements.marqueeEnabled.checked,
      pageDurationSeconds: elements.pageDuration.value,
      repeatMode: elements.repeatModeContinuous.checked
        ? 'continuous'
        : 'finite',
      roundCount: elements.roundCount.value,
      controlDisplayId: elements.controlDisplay.value,
      defaultDisplayId: elements.defaultDisplay.value,
      renderResolution: elements.renderResolution.value,
      brightnessEnabled: elements.brightnessEnabled.checked,
      brightnessPercent: elements.brightnessPercent.value,
      contrastEnabled: elements.contrastEnabled.checked,
      contrastPercent: elements.contrastPercent.value,
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
    elements.removeStandbyBackgroundButton.disabled =
      settingsDisabled || state.standbyBackgroundImagePaths.length === 0;
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

  function createDisplayOption(value, textContent) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = textContent;
    return option;
  }

  function renderDisplayAssignmentOptions({
    controlDisplayId = elements.controlDisplay.value || 'auto',
    defaultDisplayId = elements.defaultDisplay.value || 'auto',
  } = {}) {
    const desiredControlValue = controlDisplayId === null
      ? 'auto'
      : String(controlDisplayId);
    const desiredDisplayValue = defaultDisplayId === null
      ? 'auto'
      : String(defaultDisplayId);

    const renderSelect = (select, autoLabel, selectedValue) => {
      const options = [
        createDisplayOption('auto', autoLabel),
        ...state.outputDisplays.map((display, index) => {
          const primarySuffix = display.isPrimary ? '（主螢幕）' : '';
          return createDisplayOption(
            String(display.id),
            `${index + 1}. ${display.label} · ${display.width}×${display.height}${primarySuffix}`,
          );
        }),
      ];

      if (
        selectedValue !== 'auto' &&
        !state.outputDisplays.some(({ id }) => String(id) === selectedValue)
      ) {
        options.push(createDisplayOption(
          selectedValue,
          `原指定螢幕 ID ${selectedValue}（目前未連接）`,
        ));
      }

      select.replaceChildren(...options);
      select.value = selectedValue;
    };

    renderSelect(
      elements.controlDisplay,
      '自動（Windows 主螢幕）',
      desiredControlValue,
    );
    renderSelect(
      elements.defaultDisplay,
      '自動（外接螢幕優先）',
      desiredDisplayValue,
    );
  }

  function formatResolution(value) {
    return value.replace('x', '×');
  }

  /** 解析度選項只列出訊息螢幕實際支援的模式；已儲存但不支援者另外標示。 */
  function renderResolutionOptions(
    selectedValue = elements.renderResolution.value || 'auto',
  ) {
    const current = state.outputMonitor?.currentResolution ?? null;
    const resolutions = state.outputMonitor?.resolutions ?? [];
    const options = [
      createDisplayOption(
        'auto',
        current === null
          ? '維持目前解析度'
          : `維持目前解析度（${formatResolution(current)}）`,
      ),
      ...resolutions.map((resolution) => createDisplayOption(
        resolution,
        resolution === current
          ? `${formatResolution(resolution)}（目前）`
          : formatResolution(resolution),
      )),
    ];

    if (selectedValue !== 'auto' && !resolutions.includes(selectedValue)) {
      options.push(createDisplayOption(
        selectedValue,
        `${formatResolution(selectedValue)}（此螢幕不支援）`,
      ));
    }

    elements.renderResolution.replaceChildren(...options);
    elements.renderResolution.value = selectedValue;
  }

  function describeAdjustmentControl(label, control, currentPercent) {
    if (control === 'hardware') {
      return currentPercent === null
        ? `${label}直接調整螢幕本身`
        : `${label}直接調整螢幕本身（目前 ${currentPercent}%）`;
    }

    if (control === 'software') {
      return `${label}以畫面模擬（螢幕不支援 DDC/CI，100% 為原始畫面）`;
    }

    return `${label}偵測中`;
  }

  function renderOutputMonitorStatus() {
    const monitor = state.outputMonitor;
    let message;

    if (monitor === null || monitor.status === 'detecting') {
      message = '正在偵測訊息螢幕…';
    } else if (monitor.status === 'no-display') {
      message = '找不到訊息螢幕。';
    } else if (monitor.status === 'unsupported') {
      message =
        '此電腦無法切換螢幕解析度；亮度與對比以畫面模擬，100% 為原始畫面。';
    } else if (monitor.status === 'error') {
      message =
        '無法讀取訊息螢幕資訊；亮度與對比以畫面模擬，100% 為原始畫面。';
    } else {
      const parts = [
        `訊息螢幕目前 ${formatResolution(monitor.currentResolution)}`,
        describeAdjustmentControl(
          '亮度',
          monitor.brightnessControl,
          monitor.brightnessPercent,
        ),
        describeAdjustmentControl(
          '對比',
          monitor.contrastControl,
          monitor.contrastPercent,
        ),
      ];
      if (monitor.resolutionError === 'unsupported') {
        parts.push('所選解析度不受此螢幕支援，維持目前解析度');
      } else if (monitor.resolutionError === 'failed') {
        parts.push('Windows 無法切換到所選解析度，維持目前解析度');
      }
      message = `${parts.join('；')}。`;
    }

    elements.outputMonitorStatus.textContent = message;
  }

  /**
   * 未啟用調整時，欄位顯示螢幕目前的實際值（DDC/CI 可讀時），否則顯示
   * 100%（畫面模擬的原始畫面）；開啟開關後即從這個值開始調整。
   */
  function renderAdjustmentControls() {
    for (const [enabled, input, currentPercent] of [
      [
        elements.brightnessEnabled,
        elements.brightnessPercent,
        state.outputMonitor?.brightnessPercent ?? null,
      ],
      [
        elements.contrastEnabled,
        elements.contrastPercent,
        state.outputMonitor?.contrastPercent ?? null,
      ],
    ]) {
      input.disabled = !enabled.checked;
      if (!enabled.checked) {
        input.value = String(currentPercent ?? 100);
      }
    }
  }

  function renderStandbyBackgroundControls() {
    const imageCount = state.standbyBackgroundImagePaths.length;
    const slideshow = elements.standbyBackgroundMode.value === 'slideshow';

    elements.standbySlideDurationField.hidden = !slideshow;
    elements.standbySlideDuration.disabled = !slideshow;
    elements.chooseStandbyBackgroundButton.textContent = slideshow
      ? '選擇多張背景圖片'
      : '選擇固定背景圖片';
    elements.standbyBackgroundSummary.value = imageCount === 0
      ? '尚未選擇背景圖片'
      : slideshow
        ? `已選擇 ${imageCount} 張圖片`
        : imageCount === 1
          ? '已選擇 1 張圖片'
          : `已選擇 ${imageCount} 張圖片（固定顯示第 1 張）`;
    renderStandbyBackgroundList(slideshow);
  }

  function createStandbyBackgroundButton(action, index, text, ariaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action === 'remove'
      ? 'standby-background-remove'
      : 'standby-background-move';
    button.dataset.action = action;
    button.dataset.index = String(index);
    button.textContent = text;
    button.setAttribute('aria-label', ariaLabel);
    return button;
  }

  /**
   * 每張背景顯示縮圖、往前／往後與移除按鈕；清單順序即輪播順序。
   * 縮圖經同源受管理路由載入。
   */
  function renderStandbyBackgroundList(slideshow) {
    const count = state.standbyBackgroundImagePaths.length;
    const items = state.standbyBackgroundImagePaths.map((assetPath, index) => {
      const item = document.createElement('li');
      item.className = 'standby-background-item';

      const thumbnail = document.createElement('img');
      thumbnail.className = 'standby-background-thumbnail';
      thumbnail.alt = `待機背景第 ${index + 1} 張`;
      thumbnail.src = `displaycore://app/managed/standby-background/${
        assetPath.slice('standby-backgrounds/'.length)
      }`;

      const footer = document.createElement('div');
      footer.className = 'standby-background-item-footer';
      const label = document.createElement('span');
      label.textContent = !slideshow && index === 0
        ? `第 ${index + 1} 張（顯示中）`
        : `第 ${index + 1} 張`;
      const actions = document.createElement('div');
      actions.className = 'standby-background-actions';
      const earlier = createStandbyBackgroundButton(
        'earlier',
        index,
        '◀',
        `待機背景第 ${index + 1} 張往前移`,
      );
      earlier.disabled = index === 0;
      const later = createStandbyBackgroundButton(
        'later',
        index,
        '▶',
        `待機背景第 ${index + 1} 張往後移`,
      );
      later.disabled = index === count - 1;
      actions.append(
        earlier,
        later,
        createStandbyBackgroundButton(
          'remove',
          index,
          '移除',
          `移除待機背景第 ${index + 1} 張`,
        ),
      );

      footer.append(label, actions);
      item.append(thumbnail, footer);
      return item;
    });
    elements.standbyBackgroundList.replaceChildren(...items);
  }

  function renderMessageBackgroundControls() {
    const usesCustomColor = elements.messageBackgroundPreset.value === 'solid';
    elements.backgroundColorField.hidden = !usesCustomColor;
    elements.backgroundColorPicker.disabled = !usesCustomColor;
    elements.backgroundColor.disabled = !usesCustomColor;
  }

  function renderConfig(config) {
    const currentSeconds = getCurrentSecondOfDay();
    if (currentSeconds === null) {
      throw new TypeError('無法讀取主機目前時間。');
    }

    state.logoPath = config.logo.path;
    state.standbyBackgroundImagePaths = [
      ...config.standby.backgroundImagePaths,
    ];
    state.clockOffsetSeconds = config.dateTime.offsetSeconds;
    state.clockTimeTouched = false;
    renderDisplayAssignmentOptions({
      controlDisplayId: config.display.controlDisplayId,
      defaultDisplayId: config.display.defaultDisplayId,
    });
    elements.logoEnabled.checked = config.logo.enabled;
    elements.logoPath.value = config.logo.path ?? '';
    elements.logoSizePercent.value = String(config.logo.sizePercent);
    elements.standbyBackgroundMode.value = config.standby.backgroundMode;
    elements.standbySlideDuration.value = String(
      config.standby.slideDurationSeconds,
    );
    elements.standbySandEffectEnabled.checked =
      config.standby.sandEffectEnabled;
    renderStandbyBackgroundControls();
    elements.backgroundColor.value = config.appearance.backgroundColor;
    elements.backgroundColorPicker.value =
      config.appearance.backgroundColor.toLowerCase();
    elements.messageBackgroundPreset.value =
      config.appearance.messageBackgroundPreset;
    renderMessageBackgroundControls();
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
    elements.standbyClockSizePercent.value = String(
      config.appearance.standbyClockSizePercent,
    );
    elements.lineSpacingPercent.value = String(
      config.appearance.lineSpacingPercent,
    );
    elements.messageLiquidEffectEnabled.checked =
      config.appearance.messageLiquidEffectEnabled;
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
    renderResolutionOptions(config.display.renderResolution);
    elements.brightnessEnabled.checked =
      config.display.brightnessPercent !== null;
    elements.contrastEnabled.checked = config.display.contrastPercent !== null;
    if (config.display.brightnessPercent !== null) {
      elements.brightnessPercent.value = String(
        config.display.brightnessPercent,
      );
    }
    if (config.display.contrastPercent !== null) {
      elements.contrastPercent.value = String(config.display.contrastPercent);
    }
    renderAdjustmentControls();
    elements.marqueeEnabled.checked = config.marquee.enabled;
    elements.pageDuration.value = String(
      config.playback.pageDurationSeconds,
    );
    elements.repeatModeFinite.checked =
      config.playback.repeatMode === 'finite';
    elements.repeatModeContinuous.checked =
      config.playback.repeatMode === 'continuous';
    elements.roundCount.value = String(config.playback.roundCount);
    renderPlaybackMode();
  }

  function renderPlaybackMode() {
    const finite = elements.repeatModeFinite.checked;
    elements.roundCountField.hidden = !finite;
    elements.roundCount.disabled = !finite;
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

    if (state.dirty && state.baseline) {
      clearSettingsErrors();
      renderConfig(state.baseline);
      setDirty(false);
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
    state.standbyBackgroundImagePaths = [];
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

  async function chooseStandbyBackground() {
    if (
      await state.controller?.chooseStandbyBackground(
        elements.standbyBackgroundMode.value,
      )
    ) {
      focusWhenUnlocked(elements.chooseStandbyBackgroundButton);
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
    elements.chooseStandbyBackgroundButton.addEventListener(
      'click',
      () => void chooseStandbyBackground(),
      { signal },
    );
    elements.removeLogoButton.addEventListener('click', () => {
      state.logoPath = null;
      elements.logoPath.value = '';
      elements.logoEnabled.checked = false;
      handleDraftInput();
    }, { signal });
    elements.removeStandbyBackgroundButton.addEventListener('click', () => {
      state.standbyBackgroundImagePaths = [];
      renderStandbyBackgroundControls();
      handleDraftInput();
    }, { signal });
    elements.standbyBackgroundList.addEventListener('click', (event) => {
      const button = event.target.closest?.('button[data-action]');
      const index = Number(button?.dataset.index);
      const paths = state.standbyBackgroundImagePaths;
      if (
        !button ||
        button.disabled ||
        state.busy ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= paths.length
      ) {
        return;
      }

      const { action } = button.dataset;
      let focusIndex = index;
      if (action === 'remove') {
        state.standbyBackgroundImagePaths = paths
          .filter((_assetPath, candidate) => candidate !== index);
      } else if (action === 'earlier' || action === 'later') {
        const target = action === 'earlier' ? index - 1 : index + 1;
        if (target < 0 || target >= paths.length) {
          return;
        }
        const reordered = [...paths];
        [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
        state.standbyBackgroundImagePaths = reordered;
        focusIndex = target;
      } else {
        return;
      }

      renderStandbyBackgroundControls();
      handleDraftInput();
      // 焦點跟著被移動的圖片；移到端點後改到仍可用的按鈕。
      const sameAction = elements.standbyBackgroundList.querySelector(
        `button[data-action="${action}"][data-index="${
          Math.min(focusIndex, state.standbyBackgroundImagePaths.length - 1)
        }"]`,
      );
      const fallback = elements.standbyBackgroundList.querySelector(
        `button[data-index="${focusIndex}"]:not(:disabled)`,
      );
      (sameAction && !sameAction.disabled
        ? sameAction
        : fallback ?? elements.chooseStandbyBackgroundButton).focus();
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
      elements.logoSizePercent,
      elements.standbySlideDuration,
      elements.fontFamily,
      elements.minimumFontSize,
      elements.fontSizePercent,
      elements.standbyClockSizePercent,
      elements.lineSpacingPercent,
      elements.messageLiquidEffectEnabled,
      elements.standbySandEffectEnabled,
      elements.dateTimeEnabled,
      elements.controlDisplay,
      elements.defaultDisplay,
      elements.renderResolution,
      elements.brightnessPercent,
      elements.contrastPercent,
      elements.marqueeEnabled,
      elements.pageDuration,
      elements.roundCount,
    ]) {
      control.addEventListener('input', handleDraftInput, { signal });
      control.addEventListener('change', handleDraftInput, { signal });
    }

    elements.standbyBackgroundMode.addEventListener('change', () => {
      renderStandbyBackgroundControls();
      handleDraftInput();
    }, { signal });

    elements.messageBackgroundPreset.addEventListener('change', () => {
      renderMessageBackgroundControls();
      handleDraftInput();
    }, { signal });

    for (const control of [
      elements.brightnessEnabled,
      elements.contrastEnabled,
    ]) {
      control.addEventListener('change', () => {
        renderAdjustmentControls();
        handleDraftInput();
      }, { signal });
    }

    elements.clockTime.addEventListener('input', handleClockInput, { signal });
    elements.clockTime.addEventListener('change', handleClockInput, { signal });
    for (const control of [
      elements.repeatModeFinite,
      elements.repeatModeContinuous,
    ]) {
      control.addEventListener('change', () => {
        renderPlaybackMode();
        handleDraftInput();
      }, { signal });
    }

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
      state.standbyBackgroundImagePaths = [];
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
        const focusTarget = field === 'logo' || field === 'logo.path'
          ? elements.chooseLogoButton
          : field === 'standby' || field === 'standby.backgroundImagePaths'
            ? elements.chooseStandbyBackgroundButton
          : field === 'playback.repeatMode'
            ? elements.repeatModeFinite
            : control;
        focusWhenUnlocked(focusTarget);
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

    /**
     * 多張輪播時把新選的圖片接在既有清單後（去重、最多 20 張）；固定圖片
     * 只有一張，直接取代。
     */
    renderStandbyBackgroundSelection(assetPaths) {
      clearSettingsErrors();
      if (elements.standbyBackgroundMode.value !== 'slideshow') {
        state.standbyBackgroundImagePaths = [...assetPaths];
      } else {
        const merged = [...state.standbyBackgroundImagePaths];
        for (const assetPath of assetPaths) {
          if (!merged.includes(assetPath)) {
            merged.push(assetPath);
          }
        }
        state.standbyBackgroundImagePaths = merged.slice(
          0,
          MAXIMUM_STANDBY_BACKGROUND_IMAGES,
        );
        const skipped = merged.length - state.standbyBackgroundImagePaths.length;
        if (skipped > 0) {
          elements.standbyBackgroundError.textContent =
            `待機背景最多 ${MAXIMUM_STANDBY_BACKGROUND_IMAGES} 張，已略過 ${skipped} 張。`;
          elements.standbyBackgroundError.hidden = false;
        }
      }
      renderStandbyBackgroundControls();
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

    renderOutputTopology(snapshot) {
      if (
        !snapshot ||
        !Array.isArray(snapshot.displays) ||
        snapshot.displays.some((display) =>
          !display ||
          !Number.isSafeInteger(display.id) ||
          display.id < 0 ||
          typeof display.label !== 'string' ||
          !Number.isSafeInteger(display.width) ||
          !Number.isSafeInteger(display.height) ||
          typeof display.isPrimary !== 'boolean')
      ) {
        return false;
      }

      state.outputDisplays = snapshot.displays.map((display) => ({
        id: display.id,
        label: display.label,
        width: display.width,
        height: display.height,
        isPrimary: display.isPrimary,
      }));
      renderDisplayAssignmentOptions();
      state.outputMonitor = snapshot.monitor ?? null;
      renderResolutionOptions();
      renderOutputMonitorStatus();
      renderAdjustmentControls();
      return true;
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
