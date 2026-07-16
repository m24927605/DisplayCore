'use strict';

const DISPLAY_PLACEMENT_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  ERROR: 'error',
});

const WINDOWED_AREA_RATIO = 0.8;
const DISPLAY_ASPECT_RATIO = 16 / 9;

function isRectangle(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) &&
    value.width > 0 &&
    value.height > 0
  );
}

/**
 * 在指定螢幕可用區內建立 80% 大小、16:9 且置中的視窗。
 * Electron screen 的座標與尺寸皆為 DIP，不可再乘 scaleFactor。
 */
function calculateWindowedBounds(workArea) {
  if (!isRectangle(workArea)) {
    throw new TypeError('workArea 必須是有效矩形。');
  }

  const maximumWidth = Math.max(1, Math.floor(workArea.width * WINDOWED_AREA_RATIO));
  const maximumHeight = Math.max(1, Math.floor(workArea.height * WINDOWED_AREA_RATIO));
  let width;
  let height;

  if (maximumWidth / maximumHeight > DISPLAY_ASPECT_RATIO) {
    height = maximumHeight;
    width = Math.max(1, Math.floor(height * DISPLAY_ASPECT_RATIO));
  } else {
    width = maximumWidth;
    height = Math.max(1, Math.floor(width / DISPLAY_ASPECT_RATIO));
  }

  return Object.freeze({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  });
}

function placementSignature(targetDisplay, fullscreen) {
  return JSON.stringify({
    displayId: targetDisplay.id,
    bounds: fullscreen ? targetDisplay.bounds : targetDisplay.workArea,
    fullscreen,
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
  }) {
    if (!topologyService || typeof getDisplayWindow !== 'function') {
      throw new TypeError('Display 定位控制器缺少必要相依物件。');
    }

    this.topologyService = topologyService;
    this.getDisplayWindow = getDisplayWindow;
    this.logger = logger;
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

    this.applyToWindow(displayWindow);
  }

  updatePendingStatus() {
    const snapshot = this.topologyService.getSnapshot();
    this.setStatus({
      status: DISPLAY_PLACEMENT_STATUSES.PENDING,
      displayId: snapshot.effectiveDisplayId,
      fullscreen: snapshot.fullscreen,
    });
  }

  /**
   * 套用順序固定為退出全螢幕、移動／縮放、依偏好重新進入全螢幕。
   * 這讓 Windows 能在負座標與混合 DPI 拓樸中把全螢幕放到正確螢幕。
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

    const snapshot = this.topologyService.getSnapshot();
    const targetDisplay = this.topologyService.getTargetDisplay();

    if (!targetDisplay) {
      this.updatePendingStatus();
      return false;
    }

    const signature = placementSignature(targetDisplay, snapshot.fullscreen);

    if (this.lastPlacementByWindow.get(displayWindow) === signature) {
      return true;
    }

    try {
      displayWindow.setFullScreen(false);
      displayWindow.setBounds(
        snapshot.fullscreen
          ? targetDisplay.bounds
          : calculateWindowedBounds(targetDisplay.workArea),
        false,
      );

      if (snapshot.fullscreen) {
        displayWindow.setFullScreen(true);
      }

      this.lastPlacementByWindow.set(displayWindow, signature);
      this.setStatus({
        status: DISPLAY_PLACEMENT_STATUSES.APPLIED,
        displayId: targetDisplay.id,
        fullscreen: snapshot.fullscreen,
      }, { force: true });
      return true;
    } catch {
      this.lastPlacementByWindow.delete(displayWindow);
      this.logger.warn('[DisplayCore] Display Window 輸出位置套用失敗。');
      this.setStatus({
        status: DISPLAY_PLACEMENT_STATUSES.ERROR,
        displayId: targetDisplay.id,
        fullscreen: snapshot.fullscreen,
      });
      return false;
    }
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
  calculateWindowedBounds,
};
