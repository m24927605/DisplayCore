'use strict';

const TOPOLOGY_STATUSES = new Set(['ready', 'unknown']);
const HDMI_STATUSES = new Set([
  'detecting',
  'connected',
  'not-connected',
  'unknown',
]);
const SELECTION_MODES = new Set(['auto', 'manual']);
const PLACEMENT_STATUSES = new Set(['pending', 'applied', 'error']);
const MONITOR_STATUSES = new Set([
  'detecting',
  'ready',
  'no-display',
  'unsupported',
  'error',
]);
const ADJUSTMENT_CONTROLS = new Set(['unknown', 'hardware', 'software']);
const RESOLUTION_ERRORS = new Set(['unsupported', 'failed']);
const RESOLUTION_PATTERN = /^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$/;
const MAX_RESOLUTION_COUNT = 512;
const MAX_DISPLAY_COUNT = 32;
const MAX_DISPLAY_LABEL_CODE_POINTS = 80;

function invalidOutputStatus() {
  throw new TypeError('Control 輸出狀態格式不正確。');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDisplayId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDisplayLabel(value) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    [...value].length <= MAX_DISPLAY_LABEL_CODE_POINTS &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function projectDisplay(display) {
  if (
    !isPlainObject(display) ||
    !isDisplayId(display.id) ||
    !isDisplayLabel(display.label) ||
    !Number.isSafeInteger(display.width) ||
    display.width <= 0 ||
    display.width > 65535 ||
    !Number.isSafeInteger(display.height) ||
    display.height <= 0 ||
    display.height > 65535 ||
    !Number.isFinite(display.scaleFactor) ||
    display.scaleFactor <= 0 ||
    display.scaleFactor > 8 ||
    typeof display.isPrimary !== 'boolean' ||
    typeof display.isInternal !== 'boolean'
  ) {
    return invalidOutputStatus();
  }

  return Object.freeze({
    id: display.id,
    label: display.label,
    width: display.width,
    height: display.height,
    scaleFactor: display.scaleFactor,
    isPrimary: display.isPrimary,
    isInternal: display.isInternal,
  });
}

function projectPlacement(placement) {
  if (
    !isPlainObject(placement) ||
    !PLACEMENT_STATUSES.has(placement.status) ||
    !(placement.displayId === null || isDisplayId(placement.displayId)) ||
    typeof placement.fullscreen !== 'boolean' ||
    !isRevision(placement.revision)
  ) {
    return invalidOutputStatus();
  }

  return Object.freeze({
    status: placement.status,
    displayId: placement.displayId,
    fullscreen: placement.fullscreen,
    revision: placement.revision,
  });
}

function isCurrentPercent(value) {
  return value === null ||
    (Number.isSafeInteger(value) && value >= 0 && value <= 100);
}

function isResolution(value) {
  return typeof value === 'string' && RESOLUTION_PATTERN.test(value);
}

function projectMonitor(monitor) {
  if (
    !isPlainObject(monitor) ||
    !MONITOR_STATUSES.has(monitor.status) ||
    !(monitor.displayId === null || isDisplayId(monitor.displayId)) ||
    !(monitor.currentResolution === null ||
      isResolution(monitor.currentResolution)) ||
    !Array.isArray(monitor.resolutions) ||
    monitor.resolutions.length > MAX_RESOLUTION_COUNT ||
    !monitor.resolutions.every(isResolution) ||
    !(monitor.resolutionError === null ||
      RESOLUTION_ERRORS.has(monitor.resolutionError)) ||
    !ADJUSTMENT_CONTROLS.has(monitor.brightnessControl) ||
    !ADJUSTMENT_CONTROLS.has(monitor.contrastControl) ||
    !isCurrentPercent(monitor.brightnessPercent) ||
    !isCurrentPercent(monitor.contrastPercent) ||
    !isRevision(monitor.revision)
  ) {
    return invalidOutputStatus();
  }

  return Object.freeze({
    status: monitor.status,
    displayId: monitor.displayId,
    currentResolution: monitor.currentResolution,
    resolutions: Object.freeze([...monitor.resolutions]),
    resolutionError: monitor.resolutionError,
    brightnessControl: monitor.brightnessControl,
    contrastControl: monitor.contrastControl,
    brightnessPercent: monitor.brightnessPercent,
    contrastPercent: monitor.contrastPercent,
    revision: monitor.revision,
  });
}

/**
 * 將 Main 內部拓樸與定位狀態投影為 Control Renderer 可讀取的最小快照。
 * 僅逐欄複製公開資料，避免未來服務新增內部欄位時意外跨越 IPC 邊界。
 */
function createControlOutputSnapshot(topology, placement, monitor) {
  if (
    !isPlainObject(topology) ||
    topology.schemaVersion !== 1 ||
    !TOPOLOGY_STATUSES.has(topology.topologyStatus) ||
    !HDMI_STATUSES.has(topology.hdmiConnectionStatus) ||
    !Array.isArray(topology.displays) ||
    topology.displays.length > MAX_DISPLAY_COUNT ||
    !(
      topology.effectiveControlDisplayId === null ||
      isDisplayId(topology.effectiveControlDisplayId)
    ) ||
    !(
      topology.configuredControlDisplayId === null ||
      isDisplayId(topology.configuredControlDisplayId)
    ) ||
    typeof topology.controlUsingFallback !== 'boolean' ||
    !(topology.effectiveDisplayId === null || isDisplayId(topology.effectiveDisplayId)) ||
    !(topology.configuredDisplayId === null || isDisplayId(topology.configuredDisplayId)) ||
    !SELECTION_MODES.has(topology.selectionMode) ||
    typeof topology.fullscreen !== 'boolean' ||
    typeof topology.usingFallback !== 'boolean' ||
    !isRevision(topology.configRevision) ||
    !isRevision(topology.revision)
  ) {
    return invalidOutputStatus();
  }

  if (
    (
      topology.selectionMode === 'auto' &&
      (
        topology.configuredControlDisplayId !== null ||
        topology.configuredDisplayId !== null ||
        topology.controlUsingFallback ||
        topology.usingFallback
      )
    ) ||
    (
      topology.selectionMode === 'manual' &&
      (
        topology.configuredControlDisplayId === null ||
        topology.configuredDisplayId === null ||
        topology.configuredControlDisplayId === topology.configuredDisplayId
      )
    )
  ) {
    return invalidOutputStatus();
  }

  const displays = topology.displays.map(projectDisplay);
  const displayIds = new Set(displays.map(({ id }) => id));
  const primaryDisplayCount = displays.filter(
    ({ isPrimary }) => isPrimary,
  ).length;
  const configuredControlDisplayPresent = displayIds.has(
    topology.configuredControlDisplayId,
  );
  const configuredDisplayPresent = displayIds.has(
    topology.configuredDisplayId,
  );

  if (
    displayIds.size !== displays.length ||
    primaryDisplayCount !== (displays.length > 0 ? 1 : 0) ||
    (topology.effectiveControlDisplayId !== null &&
      !displayIds.has(topology.effectiveControlDisplayId)) ||
    (topology.effectiveDisplayId !== null &&
      !displayIds.has(topology.effectiveDisplayId)) ||
    (
      topology.selectionMode === 'manual' &&
      (
        topology.controlUsingFallback === configuredControlDisplayPresent ||
        topology.usingFallback === configuredDisplayPresent
      )
    )
  ) {
    return invalidOutputStatus();
  }

  return Object.freeze({
    schemaVersion: 1,
    topologyStatus: topology.topologyStatus,
    hdmiConnectionStatus: topology.hdmiConnectionStatus,
    displays: Object.freeze(displays),
    effectiveControlDisplayId: topology.effectiveControlDisplayId,
    configuredControlDisplayId: topology.configuredControlDisplayId,
    controlUsingFallback: topology.controlUsingFallback,
    effectiveDisplayId: topology.effectiveDisplayId,
    configuredDisplayId: topology.configuredDisplayId,
    selectionMode: topology.selectionMode,
    fullscreen: topology.fullscreen,
    usingFallback: topology.usingFallback,
    configRevision: topology.configRevision,
    topologyRevision: topology.revision,
    placement: projectPlacement(placement),
    monitor: projectMonitor(monitor),
  });
}

module.exports = {
  createControlOutputSnapshot,
};
