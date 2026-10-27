'use strict';

const CONTROL_PLACEMENT_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  ERROR: 'error',
});

function waitForDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRectangle(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
    value.width > 0 &&
    value.height > 0
  );
}

function isSize(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

/**
 * 將 Control 現有大小限制在目標螢幕工作區內並置中。
 *
 * 使用 workArea 而非完整 bounds，避免 Windows 工作列遮住控制按鈕；
 * Control 始終維持一般可操作視窗，不切換全螢幕。
 */
function calculateControlBounds(currentBounds, workArea) {
  if (!isSize(currentBounds) || !isRectangle(workArea)) {
    throw new TypeError('Control 視窗與螢幕工作區必須是有效矩形。');
  }

  const width = Math.min(
    Math.max(1, Math.round(currentBounds.width)),
    Math.max(1, Math.floor(workArea.width)),
  );
  const height = Math.min(
    Math.max(1, Math.round(currentBounds.height)),
    Math.max(1, Math.floor(workArea.height)),
  );

  return Object.freeze({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  });
}

function isCenterInside(bounds, area) {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  return (
    centerX >= area.x &&
    centerX < area.x + area.width &&
    centerY >= area.y &&
    centerY < area.y + area.height
  );
}

function placementSignature(targetDisplay) {
  return JSON.stringify({
    displayId: targetDisplay.id,
    workArea: targetDisplay.workArea,
  });
}

function createStatus({ status, displayId, revision }) {
  return Object.freeze({ status, displayId, revision });
}

/**
 * 將 Control BrowserWindow 定位到拓樸服務指定的管理螢幕。
 *
 * 本控制器不讀寫設定、不建立視窗，也不將原生 bounds 傳給 Renderer。
 */
class ControlPlacementController {
  constructor({
    topologyService,
    getControlWindow = () => null,
    logger = console,
    placementRetryAttempts = 3,
    placementRetryDelayMilliseconds = 150,
    waitForRetry = waitForDelay,
  }) {
    if (
      !topologyService ||
      typeof topologyService.getControlTargetDisplay !== 'function' ||
      typeof topologyService.subscribe !== 'function' ||
      typeof getControlWindow !== 'function' ||
      !Number.isSafeInteger(placementRetryAttempts) ||
      placementRetryAttempts < 1 ||
      placementRetryAttempts > 10 ||
      !Number.isSafeInteger(placementRetryDelayMilliseconds) ||
      placementRetryDelayMilliseconds < 0 ||
      placementRetryDelayMilliseconds > 5000 ||
      typeof waitForRetry !== 'function'
    ) {
      throw new TypeError('Control 定位控制器缺少必要相依物件。');
    }

    this.topologyService = topologyService;
    this.getControlWindow = getControlWindow;
    this.logger = logger;
    this.placementRetryAttempts = placementRetryAttempts;
    this.placementRetryDelayMilliseconds = placementRetryDelayMilliseconds;
    this.waitForRetry = waitForRetry;
    this.status = null;
    this.listeners = new Set();
    this.lastPlacementByWindow = new WeakMap();
    this.unsubscribe = null;
    this.initialized = false;
    this.disposed = false;
    this.handleTopologyChanged = this.handleTopologyChanged.bind(this);
  }

  initialize() {
    if (this.initialized || this.disposed) {
      return false;
    }

    this.initialized = true;
    this.unsubscribe = this.topologyService.subscribe(
      this.handleTopologyChanged,
    );
    this.updatePendingStatus();

    const controlWindow = this.getControlWindow();
    if (controlWindow) {
      this.applyToWindow(controlWindow);
    }

    return true;
  }

  getStatus() {
    if (!this.status) {
      throw new Error('Control 定位控制器尚未初始化。');
    }

    return this.status;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Control 定位狀態訂閱者必須是函式。');
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleTopologyChanged() {
    if (this.disposed) {
      return;
    }

    const controlWindow = this.getControlWindow();
    if (!controlWindow) {
      this.updatePendingStatus();
      return;
    }

    void this.applyToWindowWithRetry(controlWindow).catch(() => {
      this.logger.warn('[DisplayCore] Control Window 位置重試失敗。');
    });
  }

  updatePendingStatus() {
    const targetDisplay = this.topologyService.getControlTargetDisplay();
    this.setStatus({
      status: CONTROL_PLACEMENT_STATUSES.PENDING,
      displayId: targetDisplay?.id ?? null,
    });
  }

  applyToWindow(controlWindow) {
    if (this.disposed || !controlWindow) {
      return false;
    }

    try {
      if (controlWindow.isDestroyed()) {
        return false;
      }
    } catch {
      return false;
    }

    const targetDisplay = this.topologyService.getControlTargetDisplay();
    if (!targetDisplay) {
      this.updatePendingStatus();
      return false;
    }

    const signature = placementSignature(targetDisplay);
    if (this.lastPlacementByWindow.get(controlWindow) === signature) {
      return true;
    }

    try {
      const bounds = calculateControlBounds(
        controlWindow.getBounds(),
        targetDisplay.workArea,
      );
      controlWindow.setBounds(bounds, false);

      // Windows can mis-place a window moved across displays with different
      // scale factors; a second setBounds lands it once the DPI has switched.
      if (!isCenterInside(controlWindow.getBounds(), targetDisplay.workArea)) {
        controlWindow.setBounds(bounds, false);
      }

      if (!isCenterInside(controlWindow.getBounds(), targetDisplay.workArea)) {
        throw new Error('Control Window 未落在目標螢幕。');
      }

      this.lastPlacementByWindow.set(controlWindow, signature);
      this.setStatus({
        status: CONTROL_PLACEMENT_STATUSES.APPLIED,
        displayId: targetDisplay.id,
      }, { force: true });
      return true;
    } catch {
      this.lastPlacementByWindow.delete(controlWindow);
      this.logger.warn('[DisplayCore] Control Window 位置套用失敗。');
      this.setStatus({
        status: CONTROL_PLACEMENT_STATUSES.ERROR,
        displayId: targetDisplay.id,
      });
      return false;
    }
  }

  /** Re-applies placement even when the cached placement looks current. */
  async forceReapply() {
    const controlWindow = this.getControlWindow();

    if (this.disposed || !controlWindow) {
      return false;
    }

    this.lastPlacementByWindow.delete(controlWindow);
    return this.applyToWindowWithRetry(controlWindow);
  }

  async applyToWindowWithRetry(controlWindow) {
    for (let attempt = 1; attempt <= this.placementRetryAttempts; attempt += 1) {
      if (this.applyToWindow(controlWindow)) {
        return true;
      }

      if (
        this.disposed ||
        !this.topologyService.getControlTargetDisplay() ||
        attempt === this.placementRetryAttempts
      ) {
        return false;
      }

      try {
        if (controlWindow.isDestroyed()) {
          return false;
        }
      } catch {
        return false;
      }

      await this.waitForRetry(this.placementRetryDelayMilliseconds);
    }

    return false;
  }

  setStatus(nextStatus, { force = false } = {}) {
    const unchanged =
      this.status &&
      this.status.status === nextStatus.status &&
      this.status.displayId === nextStatus.displayId;

    if (unchanged && !force) {
      return false;
    }

    const revision = this.status ? this.status.revision + 1 : 0;
    this.status = createStatus({ ...nextStatus, revision });

    if (revision > 0) {
      for (const listener of this.listeners) {
        try {
          listener(this.status);
        } catch {
          this.logger.warn('[DisplayCore] Control 定位狀態發布失敗。');
        }
      }
    }

    return true;
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}

module.exports = {
  CONTROL_PLACEMENT_STATUSES,
  ControlPlacementController,
  calculateControlBounds,
};
