const SNAPSHOT_KEYS = Object.freeze([
  'configRevision',
  'configuredControlDisplayId',
  'configuredDisplayId',
  'controlUsingFallback',
  'displays',
  'effectiveControlDisplayId',
  'effectiveDisplayId',
  'fullscreen',
  'hdmiConnectionStatus',
  'monitor',
  'placement',
  'schemaVersion',
  'selectionMode',
  'topologyRevision',
  'topologyStatus',
  'usingFallback',
]);
const DISPLAY_KEYS = Object.freeze([
  'height',
  'id',
  'isInternal',
  'isPrimary',
  'label',
  'scaleFactor',
  'width',
]);
const PLACEMENT_KEYS = Object.freeze([
  'displayId',
  'fullscreen',
  'revision',
  'status',
]);
const MONITOR_KEYS = Object.freeze([
  'brightnessControl',
  'brightnessPercent',
  'contrastControl',
  'contrastPercent',
  'currentResolution',
  'displayId',
  'resolutionError',
  'resolutions',
  'revision',
  'status',
]);
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
const TOPOLOGY_STATUSES = new Set(['ready', 'unknown']);
const HDMI_STATUSES = new Set([
  'detecting',
  'connected',
  'not-connected',
  'unknown',
]);
const SELECTION_MODES = new Set(['auto', 'manual']);
const PLACEMENT_STATUSES = new Set(['pending', 'applied', 'error']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const MAX_DISPLAY_COUNT = 32;
const MAX_DISPLAY_LABEL_CODE_POINTS = 80;
const MAX_DISPLAY_LABEL_CODE_UNITS = MAX_DISPLAY_LABEL_CODE_POINTS * 2;
const MAX_DISPLAY_DIMENSION = 65_535;
const MAX_SCALE_FACTOR = 8;

const INVALID_RESULT = Object.freeze({ ok: false });
const REJECTED_RESULT = Object.freeze({ accepted: false });

const HDMI_MESSAGES = Object.freeze({
  detecting: '正在偵測 HDMI 連接狀態。',
  connected: '已偵測到 HDMI 連接。',
  'not-connected': '未偵測到作用中的 HDMI 連接。',
  unknown: '無法判定 HDMI 連接狀態。',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * IPC structured clone 只應產生可列舉的資料欄位。拒絕 accessor、Symbol、
 * 非列舉欄位與額外欄位，避免 getter 副作用及未經審查的資料進入 Renderer。
 */
function hasExactDataKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);

  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  return expectedKeys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isDisplayId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedDisplayArray(value) {
  if (!Array.isArray(value) || value.length > MAX_DISPLAY_COUNT) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);

  if (
    ownKeys.length !== value.length + 1 ||
    !ownKeys.includes('length') ||
    Array.from({ length: value.length }, (_item, index) => String(index))
      .some((key) => !ownKeys.includes(key))
  ) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Array.from({ length: value.length }, (_item, index) => {
    const descriptor = descriptors[index];
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  }).every(Boolean);
}

function isDisplayLabel(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_LABEL_CODE_UNITS ||
    value.trim().length === 0 ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return false;
  }

  let codePointCount = 0;

  for (const _character of value) {
    codePointCount += 1;

    if (codePointCount > MAX_DISPLAY_LABEL_CODE_POINTS) {
      return false;
    }
  }

  return true;
}

function normalizeDisplay(display) {
  if (
    !hasExactDataKeys(display, DISPLAY_KEYS) ||
    !isDisplayId(display.id) ||
    !isDisplayLabel(display.label) ||
    !Number.isSafeInteger(display.width) ||
    display.width <= 0 ||
    display.width > MAX_DISPLAY_DIMENSION ||
    !Number.isSafeInteger(display.height) ||
    display.height <= 0 ||
    display.height > MAX_DISPLAY_DIMENSION ||
    !Number.isFinite(display.scaleFactor) ||
    display.scaleFactor <= 0 ||
    display.scaleFactor > MAX_SCALE_FACTOR ||
    typeof display.isPrimary !== 'boolean' ||
    typeof display.isInternal !== 'boolean'
  ) {
    return null;
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

function normalizePlacement(placement) {
  if (
    !hasExactDataKeys(placement, PLACEMENT_KEYS) ||
    !PLACEMENT_STATUSES.has(placement.status) ||
    !(placement.displayId === null || isDisplayId(placement.displayId)) ||
    typeof placement.fullscreen !== 'boolean' ||
    !isRevision(placement.revision)
  ) {
    return null;
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

function normalizeMonitor(monitor) {
  if (
    !hasExactDataKeys(monitor, MONITOR_KEYS) ||
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
    return null;
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

function normalizeSnapshot(candidate) {
  if (
    !hasExactDataKeys(candidate, SNAPSHOT_KEYS) ||
    candidate.schemaVersion !== 1 ||
    !TOPOLOGY_STATUSES.has(candidate.topologyStatus) ||
    !HDMI_STATUSES.has(candidate.hdmiConnectionStatus) ||
    !isBoundedDisplayArray(candidate.displays) ||
    !(
      candidate.effectiveControlDisplayId === null ||
      isDisplayId(candidate.effectiveControlDisplayId)
    ) ||
    !(
      candidate.configuredControlDisplayId === null ||
      isDisplayId(candidate.configuredControlDisplayId)
    ) ||
    typeof candidate.controlUsingFallback !== 'boolean' ||
    !(candidate.effectiveDisplayId === null || isDisplayId(candidate.effectiveDisplayId)) ||
    !(candidate.configuredDisplayId === null || isDisplayId(candidate.configuredDisplayId)) ||
    !SELECTION_MODES.has(candidate.selectionMode) ||
    typeof candidate.fullscreen !== 'boolean' ||
    typeof candidate.usingFallback !== 'boolean' ||
    !isRevision(candidate.configRevision) ||
    !isRevision(candidate.topologyRevision)
  ) {
    return null;
  }

  const displays = [];

  for (const displayCandidate of candidate.displays) {
    const display = normalizeDisplay(displayCandidate);

    if (!display) {
      return null;
    }

    displays.push(display);
  }

  const placement = normalizePlacement(candidate.placement);
  const monitor = normalizeMonitor(candidate.monitor);

  if (!placement || !monitor) {
    return null;
  }

  const displayIds = new Set(displays.map(({ id }) => id));
  const primaryDisplayCount = displays.filter(({ isPrimary }) => isPrimary).length;
  const configuredControlDisplayPresent = displayIds.has(
    candidate.configuredControlDisplayId,
  );
  const configuredDisplayPresent = displayIds.has(candidate.configuredDisplayId);

  if (
    displayIds.size !== displays.length ||
    primaryDisplayCount !== (displays.length > 0 ? 1 : 0) ||
    (
      displays.length === 0 &&
      (
        candidate.effectiveControlDisplayId !== null ||
        candidate.effectiveDisplayId !== null
      )
    ) ||
    (
      displays.length > 0 &&
      (
        !displayIds.has(candidate.effectiveControlDisplayId) ||
        !displayIds.has(candidate.effectiveDisplayId)
      )
    ) ||
    (candidate.selectionMode === 'auto' &&
      (
        candidate.configuredControlDisplayId !== null ||
        candidate.configuredDisplayId !== null ||
        candidate.controlUsingFallback ||
        candidate.usingFallback
      )) ||
    (candidate.selectionMode === 'manual' &&
      (
        (
          candidate.configuredControlDisplayId === null &&
          candidate.configuredDisplayId === null
        ) ||
        candidate.controlUsingFallback !== (
          candidate.configuredControlDisplayId !== null &&
          !configuredControlDisplayPresent
        ) ||
        candidate.usingFallback !== (
          candidate.configuredDisplayId !== null &&
          !configuredDisplayPresent
        )
      ))
  ) {
    return null;
  }

  return Object.freeze({
    schemaVersion: 1,
    topologyStatus: candidate.topologyStatus,
    hdmiConnectionStatus: candidate.hdmiConnectionStatus,
    displays: Object.freeze(displays),
    effectiveControlDisplayId: candidate.effectiveControlDisplayId,
    configuredControlDisplayId: candidate.configuredControlDisplayId,
    controlUsingFallback: candidate.controlUsingFallback,
    effectiveDisplayId: candidate.effectiveDisplayId,
    configuredDisplayId: candidate.configuredDisplayId,
    selectionMode: candidate.selectionMode,
    fullscreen: candidate.fullscreen,
    usingFallback: candidate.usingFallback,
    configRevision: candidate.configRevision,
    topologyRevision: candidate.topologyRevision,
    placement,
    monitor,
  });
}

function routingStatus(snapshot) {
  if (snapshot.placement.status === 'error') {
    return 'error';
  }

  if (snapshot.effectiveDisplayId === null) {
    return 'no-target';
  }

  if (snapshot.selectionMode === 'manual' && snapshot.usingFallback) {
    return 'manual-fallback';
  }

  if (snapshot.topologyStatus === 'unknown') {
    return 'unknown';
  }

  if (
    snapshot.placement.status !== 'applied' ||
    snapshot.placement.displayId !== snapshot.effectiveDisplayId ||
    snapshot.placement.fullscreen !== snapshot.fullscreen
  ) {
    return 'pending';
  }

  return 'applied';
}

function routingMessage(snapshot, status) {
  const target = snapshot.displays.find(
    ({ id }) => id === snapshot.effectiveDisplayId,
  );

  switch (status) {
    case 'error':
      return '畫面輸出失敗，請確認顯示器連接狀態。';
    case 'no-target':
      return '目前沒有可用的輸出螢幕。';
    case 'manual-fallback':
      return `指定螢幕目前不可用，暫時輸出至${target.label}。`;
    case 'unknown':
      return '目前無法確認輸出螢幕狀態。';
    case 'pending':
      return '正在套用輸出螢幕設定。';
    default:
      return `畫面已輸出至${target.label}。`;
  }
}

function deriveUx(snapshot) {
  const status = routingStatus(snapshot);

  return Object.freeze({
    hdmi: Object.freeze({
      status: snapshot.hdmiConnectionStatus,
      message: HDMI_MESSAGES[snapshot.hdmiConnectionStatus],
    }),
    routing: Object.freeze({
      status,
      message: routingMessage(snapshot, status),
    }),
  });
}

/**
 * 驗證並正規化 Main 的 Control 輸出快照。
 *
 * 失敗結果不包含原始 payload 或例外內容，避免 IPC 資料被帶入畫面或日誌。
 */
export function validateOutputSnapshot(candidate) {
  try {
    const snapshot = normalizeSnapshot(candidate);

    if (!snapshot) {
      return INVALID_RESULT;
    }

    return Object.freeze({
      ok: true,
      snapshot,
      ux: deriveUx(snapshot),
    });
  } catch {
    return INVALID_RESULT;
  }
}

/**
 * 兩個 revision 形成 component-wise 偏序：任一分量變小即為回滾；兩者
 * 完全相同則是重複快照。只有至少一個分量前進且另一個不倒退時才接受。
 */
export function acceptOutputSnapshot(currentSnapshot, candidate) {
  const candidateResult = validateOutputSnapshot(candidate);

  if (!candidateResult.ok) {
    return REJECTED_RESULT;
  }

  if (currentSnapshot === null) {
    return Object.freeze({
      accepted: true,
      snapshot: candidateResult.snapshot,
      ux: candidateResult.ux,
    });
  }

  const currentResult = validateOutputSnapshot(currentSnapshot);

  if (!currentResult.ok) {
    return REJECTED_RESULT;
  }

  const topologyDelta =
    candidateResult.snapshot.topologyRevision -
    currentResult.snapshot.topologyRevision;
  const placementDelta =
    candidateResult.snapshot.placement.revision -
    currentResult.snapshot.placement.revision;
  const monitorDelta =
    candidateResult.snapshot.monitor.revision -
    currentResult.snapshot.monitor.revision;

  if (
    topologyDelta < 0 ||
    placementDelta < 0 ||
    monitorDelta < 0 ||
    (topologyDelta === 0 && placementDelta === 0 && monitorDelta === 0)
  ) {
    return REJECTED_RESULT;
  }

  return Object.freeze({
    accepted: true,
    snapshot: candidateResult.snapshot,
    ux: candidateResult.ux,
  });
}
