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

/**
 * 將 Main 內部拓樸與定位狀態投影為 Control Renderer 可讀取的最小快照。
 * 僅逐欄複製公開資料，避免未來服務新增內部欄位時意外跨越 IPC 邊界。
 */
function createControlOutputSnapshot(topology, placement) {
  if (
    !isPlainObject(topology) ||
    topology.schemaVersion !== 1 ||
    !TOPOLOGY_STATUSES.has(topology.topologyStatus) ||
    !HDMI_STATUSES.has(topology.hdmiConnectionStatus) ||
    !Array.isArray(topology.displays) ||
    topology.displays.length > MAX_DISPLAY_COUNT ||
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
    (topology.selectionMode === 'auto' && topology.configuredDisplayId !== null) ||
    (topology.selectionMode === 'manual' && topology.configuredDisplayId === null)
  ) {
    return invalidOutputStatus();
  }

  const displays = topology.displays.map(projectDisplay);
  const displayIds = new Set(displays.map(({ id }) => id));

  if (
    displayIds.size !== displays.length ||
    (topology.effectiveDisplayId !== null &&
      !displayIds.has(topology.effectiveDisplayId))
  ) {
    return invalidOutputStatus();
  }

  return Object.freeze({
    schemaVersion: 1,
    topologyStatus: topology.topologyStatus,
    hdmiConnectionStatus: topology.hdmiConnectionStatus,
    displays: Object.freeze(displays),
    effectiveDisplayId: topology.effectiveDisplayId,
    configuredDisplayId: topology.configuredDisplayId,
    selectionMode: topology.selectionMode,
    fullscreen: topology.fullscreen,
    usingFallback: topology.usingFallback,
    configRevision: topology.configRevision,
    topologyRevision: topology.revision,
    placement: projectPlacement(placement),
  });
}

module.exports = {
  createControlOutputSnapshot,
};
