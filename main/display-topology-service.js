'use strict';

const { HDMI_CONNECTION_STATUSES } = require('./hdmi-detector');

const DISPLAY_TOPOLOGY_STATUSES = Object.freeze({
  READY: 'ready',
  UNKNOWN: 'unknown',
});

const HDMI_DETECTING_STATUS = 'detecting';

const OUTPUT_SELECTION_MODES = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

const MAX_DISPLAY_COUNT = 32;
const MAX_LABEL_CODE_POINTS = 80;
const ALLOWED_HDMI_STATUSES = new Set(Object.values(HDMI_CONNECTION_STATUSES));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidDisplayId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidRectangle(value) {
  return (
    isPlainObject(value) &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
    value.width > 0 &&
    value.height > 0
  );
}

function freezeRectangle(rectangle) {
  return Object.freeze({
    x: rectangle.x,
    y: rectangle.y,
    width: rectangle.width,
    height: rectangle.height,
  });
}

function sanitizeLabel(label, fallbackLabel) {
  if (typeof label !== 'string') {
    return fallbackLabel;
  }

  const withoutControlCharacters = label
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  const limited = [...withoutControlCharacters]
    .slice(0, MAX_LABEL_CODE_POINTS)
    .join('');

  return limited.length > 0 ? limited : fallbackLabel;
}

function normalizeScaleFactor(value) {
  return Number.isFinite(value) && value > 0 && value <= 8 ? value : 1;
}

function normalizeDisplay(display, fallbackIndex, primaryDisplayId) {
  if (
    !isPlainObject(display) ||
    !isValidDisplayId(display.id) ||
    display.detected === false ||
    !isValidRectangle(display.bounds)
  ) {
    return null;
  }

  const scaleFactor = normalizeScaleFactor(display.scaleFactor);
  const bounds = freezeRectangle(display.bounds);
  const workArea = freezeRectangle(
    isValidRectangle(display.workArea) ? display.workArea : display.bounds,
  );
  const label = sanitizeLabel(display.label, `螢幕 ${fallbackIndex + 1}`);
  const isPrimary = display.id === primaryDisplayId;
  const isInternal = display.internal === true;
  const publicDisplay = Object.freeze({
    id: display.id,
    label,
    width: Math.round(bounds.width * scaleFactor),
    height: Math.round(bounds.height * scaleFactor),
    scaleFactor,
    isPrimary,
    isInternal,
  });

  return Object.freeze({
    id: display.id,
    label,
    bounds,
    workArea,
    scaleFactor,
    isPrimary,
    isInternal,
    publicDisplay,
  });
}

function replacePrimaryFlag(display, isPrimary) {
  const publicDisplay = Object.freeze({
    ...display.publicDisplay,
    isPrimary,
  });

  return Object.freeze({
    ...display,
    isPrimary,
    publicDisplay,
  });
}

/**
 * 將 Electron Display 轉成受限制且順序穩定的內部模型。
 * 無效、尚未偵測、重複或 Electron 保留的負數 id 都不會進入 Renderer。
 */
function normalizeDisplays(rawDisplays, rawPrimaryDisplay) {
  if (!Array.isArray(rawDisplays)) {
    throw new TypeError('screen.getAllDisplays() 必須回傳陣列。');
  }

  const primaryDisplayId = isValidDisplayId(rawPrimaryDisplay?.id)
    ? rawPrimaryDisplay.id
    : null;
  const seenIds = new Set();
  const displays = [];

  for (let index = 0; index < rawDisplays.length; index += 1) {
    if (displays.length >= MAX_DISPLAY_COUNT) {
      break;
    }

    const normalized = normalizeDisplay(
      rawDisplays[index],
      displays.length,
      primaryDisplayId,
    );

    if (!normalized || seenIds.has(normalized.id)) {
      continue;
    }

    seenIds.add(normalized.id);
    displays.push(normalized);
  }

  if (displays.length > 0 && !displays.some(({ isPrimary }) => isPrimary)) {
    displays[0] = replacePrimaryFlag(displays[0], true);
  }

  displays.sort((first, second) => {
    if (first.isPrimary !== second.isPrimary) {
      return first.isPrimary ? -1 : 1;
    }

    return first.id - second.id;
  });

  return Object.freeze(displays);
}

function readOutputPreference(settingsSnapshot) {
  const display = settingsSnapshot?.config?.display;
  const revision = settingsSnapshot?.revision;

  if (
    !isPlainObject(display) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Object.values(OUTPUT_SELECTION_MODES).includes(display.selectionMode) ||
    typeof display.fullscreen !== 'boolean' ||
    (display.selectionMode === OUTPUT_SELECTION_MODES.AUTO &&
      display.defaultDisplayId !== null) ||
    (display.selectionMode === OUTPUT_SELECTION_MODES.MANUAL &&
      !isValidDisplayId(display.defaultDisplayId))
  ) {
    throw new TypeError('設定管理器回傳無效的輸出偏好。');
  }

  return Object.freeze({
    selectionMode: display.selectionMode,
    configuredDisplayId: display.defaultDisplayId,
    fullscreen: display.fullscreen,
    configRevision: revision,
  });
}

/** 依設定與目前有效目標決定下一個 Display。 */
function selectTargetDisplay(displays, preference, currentEffectiveDisplayId) {
  const primaryDisplay = displays.find(({ isPrimary }) => isPrimary) || null;

  if (preference.selectionMode === OUTPUT_SELECTION_MODES.MANUAL) {
    const configured = displays.find(
      ({ id }) => id === preference.configuredDisplayId,
    );

    return Object.freeze({
      display: configured || primaryDisplay,
      usingFallback: !configured,
    });
  }

  const externalDisplays = displays.filter(({ isInternal }) => !isInternal);
  const externalSecondaryDisplays = externalDisplays.filter(
    ({ isPrimary }) => !isPrimary,
  );
  const currentExternalSecondary = externalSecondaryDisplays.find(
    ({ id }) => id === currentEffectiveDisplayId,
  );
  const preferredExternalSecondary = externalSecondaryDisplays[0];
  const currentExternal = externalDisplays.find(
    ({ id }) => id === currentEffectiveDisplayId,
  );
  const preferredExternal = externalDisplays[0];
  const secondaryDisplays = displays.filter(({ isPrimary }) => !isPrimary);
  const currentSecondary = secondaryDisplays.find(
    ({ id }) => id === currentEffectiveDisplayId,
  );
  const preferredSecondary = secondaryDisplays[0];

  return Object.freeze({
    display:
      currentExternalSecondary ||
      preferredExternalSecondary ||
      currentExternal ||
      preferredExternal ||
      currentSecondary ||
      preferredSecondary ||
      primaryDisplay,
    usingFallback: false,
  });
}

function createPublicSnapshot(candidate, revision) {
  return Object.freeze({
    schemaVersion: 1,
    topologyStatus: candidate.topologyStatus,
    hdmiConnectionStatus: candidate.hdmiConnectionStatus,
    displays: Object.freeze(candidate.displays.map(({ publicDisplay }) => publicDisplay)),
    effectiveDisplayId: candidate.targetDisplay?.id ?? null,
    configuredDisplayId: candidate.preference.configuredDisplayId,
    selectionMode: candidate.preference.selectionMode,
    fullscreen: candidate.preference.fullscreen,
    usingFallback: candidate.usingFallback,
    secondDisplayConnected: candidate.displays.length > 1,
    configRevision: candidate.preference.configRevision,
    revision,
  });
}

function createStateSignature(snapshot, displays) {
  return JSON.stringify({
    snapshot: {
      ...snapshot,
      revision: undefined,
    },
    placement: displays.map(({ id, bounds, workArea }) => ({
      id,
      bounds,
      workArea,
    })),
  });
}

/**
 * 監聽 Electron screen 與 ConfigManager，維護輸出螢幕拓樸狀態。
 *
 * 本服務不直接操作 BrowserWindow；視窗定位由獨立 placement controller
 * 訂閱本服務，避免螢幕查詢、設定持久化與原生視窗操作互相耦合。
 */
class DisplayTopologyService {
  constructor({
    screen,
    settingsManager,
    hdmiDetector,
    logger = console,
    hdmiDebounceMilliseconds = 250,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (
      !screen ||
      !settingsManager ||
      !hdmiDetector ||
      !Number.isSafeInteger(hdmiDebounceMilliseconds) ||
      hdmiDebounceMilliseconds < 0 ||
      hdmiDebounceMilliseconds > 5000 ||
      typeof setTimer !== 'function' ||
      typeof clearTimer !== 'function'
    ) {
      throw new TypeError('螢幕拓樸服務缺少必要相依物件。');
    }

    this.screen = screen;
    this.settingsManager = settingsManager;
    this.hdmiDetector = hdmiDetector;
    this.logger = logger;
    this.hdmiDebounceMilliseconds = hdmiDebounceMilliseconds;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.snapshot = null;
    this.displays = Object.freeze([]);
    this.targetDisplay = null;
    this.signature = null;
    this.listeners = new Set();
    this.initializationPromise = null;
    this.initialized = false;
    this.disposed = false;
    this.refreshScheduled = false;
    this.refreshPendingDuringInitialization = false;
    this.hdmiRefreshTimer = null;
    this.hdmiProbePromise = null;
    this.hdmiProbeQueued = false;
    this.settingsUnsubscribe = null;
    this.handleScreenChange = this.handleScreenChange.bind(this);
    this.handleSettingsChange = this.handleSettingsChange.bind(this);
  }

  async initialize() {
    if (this.disposed) {
      throw new Error('螢幕拓樸服務已停止。');
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce();
    }

    return this.initializationPromise;
  }

  async initializeOnce() {
    this.bindSources();
    this.commitCurrentTopology({
      hdmiConnectionStatus: HDMI_DETECTING_STATUS,
      initial: true,
    });
    this.initialized = true;

    if (this.refreshPendingDuringInitialization) {
      this.refreshPendingDuringInitialization = false;
      this.scheduleRefresh();
    }

    // HDMI 是額外的 Windows 連接器資訊，不參與螢幕選擇；背景探測可避免
    // PowerShell／WMI timeout 阻塞 Control 與 Display Window 建立。
    void this.refreshHdmiStatus();

    return this.snapshot;
  }

  bindSources() {
    for (const eventName of [
      'display-added',
      'display-removed',
      'display-metrics-changed',
    ]) {
      this.screen.on(eventName, this.handleScreenChange);
    }

    this.settingsUnsubscribe = this.settingsManager.subscribe(
      this.handleSettingsChange,
    );
  }

  getSnapshot() {
    if (!this.snapshot) {
      throw new Error('螢幕拓樸服務尚未初始化。');
    }

    return this.snapshot;
  }

  getTargetDisplay() {
    return this.targetDisplay;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('螢幕拓樸訂閱者必須是函式。');
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleScreenChange() {
    if (this.disposed) {
      return;
    }

    if (!this.initialized) {
      this.refreshPendingDuringInitialization = true;
      return;
    }

    this.scheduleRefresh();
  }

  handleSettingsChange() {
    if (!this.disposed && this.initialized) {
      this.commitCurrentTopology({
        hdmiConnectionStatus: this.snapshot.hdmiConnectionStatus,
      });
    }
  }

  scheduleRefresh() {
    if (this.refreshScheduled || this.disposed) {
      return;
    }

    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;

      if (this.disposed) {
        return;
      }

      this.commitCurrentTopology({
        hdmiConnectionStatus: this.snapshot.hdmiConnectionStatus,
      });
      this.scheduleHdmiRefresh();
    });
  }

  /**
   * 顯示器 docking 常會連續送出 added／metrics 多個事件。拓樸仍於下一個
   * microtask 立即更新，但成本較高的 PowerShell／WMI 查詢延後合併。
   */
  scheduleHdmiRefresh() {
    if (this.disposed) {
      return;
    }

    if (this.hdmiRefreshTimer !== null) {
      this.clearTimer(this.hdmiRefreshTimer);
    }

    this.hdmiRefreshTimer = this.setTimer(() => {
      this.hdmiRefreshTimer = null;

      if (!this.disposed) {
        void this.refreshHdmiStatus();
      }
    }, this.hdmiDebounceMilliseconds);
    this.hdmiRefreshTimer?.unref?.();
  }

  commitCurrentTopology({ hdmiConnectionStatus, initial = false }) {
    let candidate;

    try {
      const preference = readOutputPreference(this.settingsManager.getSnapshot());
      const displays = normalizeDisplays(
        this.screen.getAllDisplays(),
        this.screen.getPrimaryDisplay(),
      );
      const selected = selectTargetDisplay(
        displays,
        preference,
        this.snapshot?.effectiveDisplayId ?? null,
      );

      candidate = {
        topologyStatus: DISPLAY_TOPOLOGY_STATUSES.READY,
        hdmiConnectionStatus,
        displays,
        preference,
        targetDisplay: selected.display,
        usingFallback: selected.usingFallback,
      };
    } catch {
      this.logger.warn('[DisplayCore] 作業系統螢幕拓樸查詢失敗。');
      candidate = this.createUnknownCandidate(hdmiConnectionStatus);
    }

    this.commitCandidate(candidate, { initial });
  }

  createUnknownCandidate(hdmiConnectionStatus) {
    let preference;

    try {
      preference = readOutputPreference(this.settingsManager.getSnapshot());
    } catch {
      preference = this.snapshot
        ? Object.freeze({
          selectionMode: this.snapshot.selectionMode,
          configuredDisplayId: this.snapshot.configuredDisplayId,
          fullscreen: this.snapshot.fullscreen,
          configRevision: this.snapshot.configRevision,
        })
        : Object.freeze({
          selectionMode: OUTPUT_SELECTION_MODES.AUTO,
          configuredDisplayId: null,
          fullscreen: true,
          configRevision: 0,
        });
    }

    return {
      topologyStatus: DISPLAY_TOPOLOGY_STATUSES.UNKNOWN,
      hdmiConnectionStatus,
      displays: this.displays,
      preference,
      targetDisplay: this.targetDisplay,
      usingFallback: this.snapshot?.usingFallback ?? false,
    };
  }

  commitCandidate(candidate, { initial = false } = {}) {
    const revision = initial || !this.snapshot ? 0 : this.snapshot.revision + 1;
    const snapshot = createPublicSnapshot(candidate, revision);
    const signature = createStateSignature(snapshot, candidate.displays);

    if (!initial && this.snapshot && signature === this.signature) {
      return false;
    }

    this.snapshot = snapshot;
    this.displays = candidate.displays;
    this.targetDisplay = candidate.targetDisplay;
    this.signature = signature;

    if (!initial) {
      this.publish(snapshot);
    }

    return true;
  }

  async safeDetectHdmi() {
    try {
      const result = await this.hdmiDetector.detect();

      if (!isPlainObject(result) || !ALLOWED_HDMI_STATUSES.has(result.status)) {
        return { status: HDMI_CONNECTION_STATUSES.UNKNOWN };
      }

      return { status: result.status };
    } catch {
      return { status: HDMI_CONNECTION_STATUSES.UNKNOWN };
    }
  }

  async refreshHdmiStatus() {
    if (this.disposed) {
      return;
    }

    if (this.hdmiProbePromise) {
      this.hdmiProbeQueued = true;
      return this.hdmiProbePromise;
    }

    const probePromise = this.performHdmiProbe();
    this.hdmiProbePromise = probePromise;

    try {
      await probePromise;
    } finally {
      if (this.hdmiProbePromise === probePromise) {
        this.hdmiProbePromise = null;
      }

      if (this.hdmiProbeQueued && !this.disposed) {
        this.hdmiProbeQueued = false;
        void this.refreshHdmiStatus();
      }
    }
  }

  async performHdmiProbe() {
    const result = await this.safeDetectHdmi();

    if (
      this.disposed ||
      result.status === this.snapshot.hdmiConnectionStatus
    ) {
      return;
    }

    this.commitCandidate({
      topologyStatus: this.snapshot.topologyStatus,
      hdmiConnectionStatus: result.status,
      displays: this.displays,
      preference: Object.freeze({
        selectionMode: this.snapshot.selectionMode,
        configuredDisplayId: this.snapshot.configuredDisplayId,
        fullscreen: this.snapshot.fullscreen,
        configRevision: this.snapshot.configRevision,
      }),
      targetDisplay: this.targetDisplay,
      usingFallback: this.snapshot.usingFallback,
    });
  }

  publish(snapshot) {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        this.logger.warn('[DisplayCore] 螢幕拓樸狀態發布失敗。');
      }
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.hdmiProbeQueued = false;

    if (this.hdmiRefreshTimer !== null) {
      this.clearTimer(this.hdmiRefreshTimer);
      this.hdmiRefreshTimer = null;
    }

    for (const eventName of [
      'display-added',
      'display-removed',
      'display-metrics-changed',
    ]) {
      this.screen.removeListener(eventName, this.handleScreenChange);
    }

    this.settingsUnsubscribe?.();
    this.settingsUnsubscribe = null;
    this.listeners.clear();
  }
}

module.exports = {
  DISPLAY_TOPOLOGY_STATUSES,
  DisplayTopologyService,
  normalizeDisplays,
  selectTargetDisplay,
};
