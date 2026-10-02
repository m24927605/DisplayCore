'use strict';

const { parseOutputResolution } = require('../config/config-schema');

const OUTPUT_MONITOR_STATUSES = Object.freeze({
  DETECTING: 'detecting',
  READY: 'ready',
  NO_DISPLAY: 'no-display',
  UNSUPPORTED: 'unsupported',
  ERROR: 'error',
});

/** 亮度／對比的實際控制方式；unknown 表示仍在偵測，暫不套用軟體調整。 */
const ADJUSTMENT_CONTROLS = Object.freeze({
  UNKNOWN: 'unknown',
  HARDWARE: 'hardware',
  SOFTWARE: 'software',
});

const RESOLUTION_ERRORS = Object.freeze({
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
});

const NEUTRAL_ADJUSTMENT_PERCENT = 100;

function formatResolution({ width, height }) {
  return `${width}x${height}`;
}

function sameResolution(a, b) {
  return a.width === b.width && a.height === b.height;
}

function readOutputSettings(settingsSnapshot) {
  const { display } = settingsSnapshot.config;
  return Object.freeze({
    renderResolution: display.renderResolution,
    brightnessPercent: display.brightnessPercent,
    contrastPercent: display.contrastPercent,
  });
}

function settingsSignature(settings) {
  return JSON.stringify(settings);
}

function targetSignature(display) {
  return display === null
    ? null
    : JSON.stringify({ id: display.id, bounds: display.bounds });
}

/**
 * 將輸出解析度與亮度／對比設定套用到訊息視窗所在的實體螢幕。
 *
 * 只在啟動、訊息螢幕變更（含解析度改變後的位置／尺寸）或相關設定變更時
 * 同步；同步依序執行。解析度切換失敗時，同一組螢幕與設定不再重試，避免
 * 與 Windows display-metrics 事件形成迴圈。螢幕不支援 DDC/CI 時，亮度／
 * 對比改由 Display 畫面濾鏡套用。
 */
class OutputMonitorController {
  constructor({
    topologyService,
    settingsManager,
    monitorControl,
    screen,
    logger = console,
  }) {
    if (
      typeof topologyService?.getTargetDisplay !== 'function' ||
      typeof topologyService?.subscribe !== 'function' ||
      typeof settingsManager?.getSnapshot !== 'function' ||
      typeof settingsManager?.subscribe !== 'function' ||
      typeof monitorControl?.isSupported !== 'function' ||
      typeof monitorControl?.query !== 'function' ||
      typeof monitorControl?.apply !== 'function' ||
      // Electron screen 在 app ready 前不可存取；dipToScreenRect 於同步時才使用。
      !screen
    ) {
      throw new TypeError('輸出螢幕控制缺少必要相依物件。');
    }

    this.topologyService = topologyService;
    this.settingsManager = settingsManager;
    this.monitorControl = monitorControl;
    this.screen = screen;
    this.logger = logger;
    this.listeners = new Set();
    this.unsubscribes = [];
    this.running = null;
    this.pending = false;
    this.disposed = false;
    this.settingsSignature = null;
    this.targetSignature = null;
    this.failedResolutionKey = null;
    this.status = Object.freeze({
      status: OUTPUT_MONITOR_STATUSES.DETECTING,
      displayId: null,
      currentResolution: null,
      resolutions: Object.freeze([]),
      resolutionError: null,
      brightnessControl: ADJUSTMENT_CONTROLS.UNKNOWN,
      contrastControl: ADJUSTMENT_CONTROLS.UNKNOWN,
      revision: 0,
    });
  }

  initialize() {
    const settings = readOutputSettings(this.settingsManager.getSnapshot());
    this.settingsSignature = settingsSignature(settings);
    this.targetSignature = targetSignature(
      this.topologyService.getTargetDisplay(),
    );
    this.unsubscribes = [
      this.settingsManager.subscribe((snapshot) => {
        const signature = settingsSignature(readOutputSettings(snapshot));
        if (signature === this.settingsSignature) {
          return;
        }

        this.settingsSignature = signature;
        // 管理員重新儲存設定時，允許再次嘗試先前失敗的解析度。
        this.failedResolutionKey = null;
        this.scheduleSync();
      }),
      this.topologyService.subscribe(() => {
        const signature = targetSignature(
          this.topologyService.getTargetDisplay(),
        );
        if (signature === this.targetSignature) {
          return;
        }

        this.targetSignature = signature;
        this.scheduleSync();
      }),
    ];
    this.scheduleSync();
  }

  getStatus() {
    return this.status;
  }

  /** Display 畫面濾鏡的百分比；100 代表不調整。 */
  getSoftwareAdjustment() {
    const settings = readOutputSettings(this.settingsManager.getSnapshot());
    const resolve = (control, percent) =>
      control === ADJUSTMENT_CONTROLS.SOFTWARE && percent !== null
        ? percent
        : NEUTRAL_ADJUSTMENT_PERCENT;

    return Object.freeze({
      brightnessPercent: resolve(
        this.status.brightnessControl,
        settings.brightnessPercent,
      ),
      contrastPercent: resolve(
        this.status.contrastControl,
        settings.contrastPercent,
      ),
    });
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('輸出螢幕控制訂閱者必須是函式。');
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 測試與關閉流程使用：等待目前排程中的同步完成。 */
  async whenIdle() {
    while (this.running) {
      await this.running;
    }
  }

  dispose() {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes = [];
    this.listeners.clear();
  }

  /** @private */
  scheduleSync() {
    if (this.disposed) {
      return;
    }

    if (this.running) {
      this.pending = true;
      return;
    }

    this.running = this.runSyncLoop();
  }

  /** @private */
  async runSyncLoop() {
    try {
      do {
        this.pending = false;
        try {
          await this.syncOnce();
        } catch (error) {
          this.logger.warn('[DisplayCore] 輸出螢幕控制同步失敗。', error);
          this.publish({
            status: OUTPUT_MONITOR_STATUSES.ERROR,
            brightnessControl: ADJUSTMENT_CONTROLS.SOFTWARE,
            contrastControl: ADJUSTMENT_CONTROLS.SOFTWARE,
          });
        }
      } while (this.pending && !this.disposed);
    } finally {
      this.running = null;
    }
  }

  /** @private */
  async syncOnce() {
    const target = this.topologyService.getTargetDisplay();
    const settings = readOutputSettings(this.settingsManager.getSnapshot());

    if (target === null) {
      this.publish({
        status: OUTPUT_MONITOR_STATUSES.NO_DISPLAY,
        displayId: null,
        currentResolution: null,
        resolutions: Object.freeze([]),
        resolutionError: null,
        brightnessControl: ADJUSTMENT_CONTROLS.UNKNOWN,
        contrastControl: ADJUSTMENT_CONTROLS.UNKNOWN,
      });
      return;
    }

    if (!this.monitorControl.isSupported()) {
      this.publish({
        status: OUTPUT_MONITOR_STATUSES.UNSUPPORTED,
        displayId: target.id,
        currentResolution: null,
        resolutions: Object.freeze([]),
        resolutionError: null,
        brightnessControl: ADJUSTMENT_CONTROLS.SOFTWARE,
        contrastControl: ADJUSTMENT_CONTROLS.SOFTWARE,
      });
      return;
    }

    if (this.status.displayId !== target.id) {
      this.publish({
        status: OUTPUT_MONITOR_STATUSES.DETECTING,
        displayId: target.id,
        currentResolution: null,
        resolutions: Object.freeze([]),
        resolutionError: null,
        brightnessControl: ADJUSTMENT_CONTROLS.UNKNOWN,
        contrastControl: ADJUSTMENT_CONTROLS.UNKNOWN,
      });
    }

    const nativeBounds = this.screen.dipToScreenRect(null, target.bounds);
    const origin = {
      x: Math.round(nativeBounds.x),
      y: Math.round(nativeBounds.y),
    };
    let info = await this.monitorControl.query(origin);
    if (this.disposed) {
      return;
    }

    if (!info.found) {
      this.publish({
        status: OUTPUT_MONITOR_STATUSES.ERROR,
        displayId: target.id,
        currentResolution: null,
        resolutions: Object.freeze([]),
        resolutionError: null,
        brightnessControl: ADJUSTMENT_CONTROLS.SOFTWARE,
        contrastControl: ADJUSTMENT_CONTROLS.SOFTWARE,
      });
      return;
    }

    const desired = parseOutputResolution(settings.renderResolution);
    const resolutionKey = `${target.id}:${settings.renderResolution}`;
    let resolutionError = null;
    let resolutionRequest = null;

    if (desired) {
      if (!info.modes.some((mode) => sameResolution(mode, desired))) {
        resolutionError = RESOLUTION_ERRORS.UNSUPPORTED;
      } else if (!sameResolution(info.current, desired)) {
        if (this.failedResolutionKey === resolutionKey) {
          resolutionError = RESOLUTION_ERRORS.FAILED;
        } else {
          resolutionRequest = desired;
        }
      }
    }

    const hardwareRequest = (vcp, percent) =>
      percent !== null && vcp.supported && vcp.percent !== percent
        ? percent
        : null;
    const brightnessRequest = hardwareRequest(
      info.brightness,
      settings.brightnessPercent,
    );
    const contrastRequest = hardwareRequest(
      info.contrast,
      settings.contrastPercent,
    );
    let brightnessControl = info.brightness.supported
      ? ADJUSTMENT_CONTROLS.HARDWARE
      : ADJUSTMENT_CONTROLS.SOFTWARE;
    let contrastControl = info.contrast.supported
      ? ADJUSTMENT_CONTROLS.HARDWARE
      : ADJUSTMENT_CONTROLS.SOFTWARE;

    if (
      resolutionRequest !== null ||
      brightnessRequest !== null ||
      contrastRequest !== null
    ) {
      const result = await this.monitorControl.apply(origin, {
        resolution: resolutionRequest,
        brightnessPercent: brightnessRequest,
        contrastPercent: contrastRequest,
      });
      if (this.disposed) {
        return;
      }

      const failed = (outcome) =>
        !result.found || outcome === 'failed' || outcome === 'unsupported';
      if (brightnessRequest !== null && failed(result.brightness)) {
        brightnessControl = ADJUSTMENT_CONTROLS.SOFTWARE;
      }
      if (contrastRequest !== null && failed(result.contrast)) {
        contrastControl = ADJUSTMENT_CONTROLS.SOFTWARE;
      }

      const requeried = await this.monitorControl.query(origin);
      if (this.disposed) {
        return;
      }
      if (requeried.found) {
        info = requeried;
      }

      if (
        resolutionRequest !== null &&
        (failed(result.resolution) ||
          !sameResolution(info.current, resolutionRequest))
      ) {
        this.failedResolutionKey = resolutionKey;
        resolutionError = result.resolution === 'unsupported'
          ? RESOLUTION_ERRORS.UNSUPPORTED
          : RESOLUTION_ERRORS.FAILED;
        this.logger.warn(
          `[DisplayCore] 無法將訊息螢幕切換為 ${settings.renderResolution}。`,
        );
      }
    }

    this.publish({
      status: OUTPUT_MONITOR_STATUSES.READY,
      displayId: target.id,
      currentResolution: formatResolution(info.current),
      resolutions: Object.freeze(info.modes.map(formatResolution)),
      resolutionError,
      brightnessControl,
      contrastControl,
    });
  }

  /** @private */
  publish(changes) {
    const next = { ...this.status, ...changes };
    const { revision: _previousRevision, ...comparableNext } = next;
    const { revision: _currentRevision, ...comparableCurrent } = this.status;

    if (JSON.stringify(comparableNext) === JSON.stringify(comparableCurrent)) {
      return;
    }

    this.status = Object.freeze({ ...next, revision: this.status.revision + 1 });
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch (error) {
        this.logger.error('[DisplayCore] 輸出螢幕狀態發布失敗。', error);
      }
    }
  }
}

module.exports = {
  ADJUSTMENT_CONTROLS,
  OUTPUT_MONITOR_STATUSES,
  OutputMonitorController,
  RESOLUTION_ERRORS,
};
