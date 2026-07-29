'use strict';

const {
  applyDisplayFullscreenPlacement,
} = require('./display-signage-mode');

const DISPLAY_PLACEMENT_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  ERROR: 'error',
});

function waitForDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function placementSignature(targetDisplay) {
  return JSON.stringify({
    displayId: targetDisplay.id,
    bounds: targetDisplay.bounds,
    fullscreen: true,
  });
}

function createStatus({ status, displayId, fullscreen, revision }) {
  return Object.freeze({ status, displayId, fullscreen, revision });
}

/**
 * 將 DisplayTopologyService 的目標安全套用至 Display BrowserWindow。
 *
 * 本控制器不查詢 screen、不寫入設定，也不建立視窗。WindowManager 在建立或
 * 重建 Display 時傳入新視窗；拓樸改變時則透過 getDisplayWindow 取得目前視窗。
 */
class DisplayPlacementController {
  constructor({
    topologyService,
    getDisplayWindow = () => null,
    logger = console,
    platform = process.platform,
    placementRetryAttempts = 3,
    placementRetryDelayMilliseconds = 150,
    waitForRetry = waitForDelay,
  }) {
    if (
      !topologyService ||
      typeof getDisplayWindow !== 'function' ||
      !Number.isSafeInteger(placementRetryAttempts) ||
      placementRetryAttempts < 1 ||
      placementRetryAttempts > 10 ||
      !Number.isSafeInteger(placementRetryDelayMilliseconds) ||
      placementRetryDelayMilliseconds < 0 ||
      placementRetryDelayMilliseconds > 5000 ||
      typeof waitForRetry !== 'function'
    ) {
      throw new TypeError('Display 定位控制器缺少必要相依物件。');
    }

    this.topologyService = topologyService;
    this.getDisplayWindow = getDisplayWindow;
    this.logger = logger;
    this.platform = platform;
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

    const displayWindow = this.getDisplayWindow();

    if (displayWindow) {
      this.applyToWindow(displayWindow);
    }

    return true;
  }

  getStatus() {
    if (!this.status) {
      throw new Error('Display 定位控制器尚未初始化。');
    }

    return this.status;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Display 定位狀態訂閱者必須是函式。');
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleTopologyChanged() {
    if (this.disposed) {
      return;
    }

    const displayWindow = this.getDisplayWindow();

    if (!displayWindow) {
      this.updatePendingStatus();
      return;
    }

    void this.applyToWindowWithRetry(displayWindow).catch(() => {
      this.logger.warn('[DisplayCore] Display Window 輸出位置重試失敗。');
    });
  }

  updatePendingStatus() {
    const snapshot = this.topologyService.getSnapshot();
    this.setStatus({
      status: DISPLAY_PLACEMENT_STATUSES.PENDING,
      displayId: snapshot.effectiveDisplayId,
      fullscreen: true,
    });
  }

  /**
   * 套用順序固定為退出全螢幕、移動／縮放、重新進入全螢幕。
   * Windows 使用原生全螢幕；macOS signage 使用可可靠覆蓋選單列的簡易全螢幕。
   */
  applyToWindow(displayWindow) {
    if (this.disposed || !displayWindow) {
      return false;
    }

    try {
      if (displayWindow.isDestroyed()) {
        return false;
      }
    } catch {
      return false;
    }

    const targetDisplay = this.topologyService.getTargetDisplay();

    if (!targetDisplay) {
      this.updatePendingStatus();
      return false;
    }

    const signature = placementSignature(targetDisplay);

    if (this.lastPlacementByWindow.get(displayWindow) === signature) {
      return true;
    }

    try {
      applyDisplayFullscreenPlacement(displayWindow, targetDisplay.bounds, {
        platform: this.platform,
      });

      this.lastPlacementByWindow.set(displayWindow, signature);
      this.setStatus({
        status: DISPLAY_PLACEMENT_STATUSES.APPLIED,
        displayId: targetDisplay.id,
        fullscreen: true,
      }, { force: true });
      return true;
    } catch {
      this.lastPlacementByWindow.delete(displayWindow);
      this.logger.warn('[DisplayCore] Display Window 輸出位置套用失敗。');
      this.setStatus({
        status: DISPLAY_PLACEMENT_STATUSES.ERROR,
        displayId: targetDisplay.id,
        fullscreen: true,
      });
      return false;
    }
  }

  /**
   * Windows 可能短暫拒絕跨螢幕 bounds／fullscreen 切換。初次建立與
   * 執行中熱插拔都使用有限次重試；初次建立達上限時仍由 WindowManager
   * 原子銷毀雙視窗，絕不在錯誤螢幕上顯示內容。
   */
  async applyToWindowWithRetry(displayWindow) {
    for (let attempt = 1; attempt <= this.placementRetryAttempts; attempt += 1) {
      if (this.applyToWindow(displayWindow)) {
        return true;
      }

      if (
        this.disposed ||
        !this.topologyService.getTargetDisplay() ||
        attempt === this.placementRetryAttempts
      ) {
        return false;
      }

      try {
        if (displayWindow.isDestroyed()) {
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
      this.status.displayId === nextStatus.displayId &&
      this.status.fullscreen === nextStatus.fullscreen;

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
          this.logger.warn('[DisplayCore] Display 定位狀態發布失敗。');
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
  DISPLAY_PLACEMENT_STATUSES,
  DisplayPlacementController,
};
