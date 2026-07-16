'use strict';

const {
  PAGE_PROGRESS_PHASES,
  PRESENTATION_MODES,
} = require('./channels');
const { PresentationStore } = require('./presentation-store');
const { MAX_MESSAGE_COUNT, MESSAGES_PER_PAGE } = require('./validators');

const MAX_PAGE_NUMBER = Math.ceil(MAX_MESSAGE_COUNT / MESSAGES_PER_PAGE);

function hasExactProgressKeys(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return false;
  }

  const expectedKeys = report.phase === PAGE_PROGRESS_PHASES.READY
    ? [
      'displayEpoch',
      'layoutGeneration',
      'marqueeCount',
      'pageNumber',
      'phase',
      'rendererId',
      'revision',
      'settingsRevision',
    ]
    : [
      'displayEpoch',
      'layoutGeneration',
      'pageNumber',
      'phase',
      'rendererId',
      'revision',
      'settingsRevision',
    ];
  const keys = Object.keys(report).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

/** IPC 外層雖已驗證，service 仍守住自己的信任邊界。 */
function isValidProgressReport(report) {
  if (
    !hasExactProgressKeys(report) ||
    !Object.values(PAGE_PROGRESS_PHASES).includes(report.phase) ||
    !Number.isSafeInteger(report.rendererId) ||
    report.rendererId < 1 ||
    !Number.isSafeInteger(report.displayEpoch) ||
    report.displayEpoch < 1 ||
    !Number.isSafeInteger(report.revision) ||
    report.revision < 0 ||
    !Number.isSafeInteger(report.settingsRevision) ||
    report.settingsRevision < 0 ||
    !Number.isSafeInteger(report.pageNumber) ||
    report.pageNumber < 1 ||
    report.pageNumber > MAX_PAGE_NUMBER ||
    !Number.isSafeInteger(report.layoutGeneration) ||
    report.layoutGeneration < 1
  ) {
    return false;
  }

  return (
    report.phase !== PAGE_PROGRESS_PHASES.READY ||
    (Number.isSafeInteger(report.marqueeCount) &&
      report.marqueeCount >= 0 &&
      report.marqueeCount <= MESSAGES_PER_PAGE)
  );
}

/**
 * 管理 Main Process 唯一的翻頁 timer、Display 版面閘門與狀態發布。
 *
 * 每頁必須同時滿足兩個條件才可前進：Display 完成 layout 後開始計算的
 * 最短停留時間已到，以及目前 layout 的所有跑馬燈皆至少完成一輪。Display
 * 只能回報 pending／ready／complete，不能自行指定下一頁。
 */
class PresentationService {
  constructor({
    store = new PresentationStore(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (handle) => clearTimeout(handle),
    onListenerError = () => {},
    displayAvailable = true,
    settingsRevision = 0,
  } = {}) {
    if (
      typeof displayAvailable !== 'boolean' ||
      !Number.isSafeInteger(settingsRevision) ||
      settingsRevision < 0
    ) {
      throw new TypeError('Display 可用狀態或設定版本不正確。');
    }

    this.store = store;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onListenerError = onListenerError;
    this.listeners = new Set();
    this.timerHandle = null;
    this.pageGate = null;
    this.invalidatedLayout = null;
    this.displayAvailable = displayAvailable;
    this.displayEpoch = displayAvailable ? 1 : 0;
    this.settingsRevision = settingsRevision;
    this.generation = 0;
    this.disposed = false;
  }

  getSnapshot() {
    return this.store.getSnapshot();
  }

  /** Main 將此世代隨 refit 通知送給目前可見的 Display。 */
  getDisplayEpoch() {
    return this.displayEpoch;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('listener 必須是函式。');
    }

    if (this.disposed) {
      return () => {};
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startProgram(program) {
    if (this.disposed) {
      return false;
    }

    this.invalidatePageGate();
    const snapshot = this.store.startProgram(program);
    this.publish(snapshot);
    return snapshot;
  }

  showEmergency(code) {
    if (this.disposed) {
      return false;
    }

    this.invalidatePageGate();
    const snapshot = this.store.showEmergency(code);
    this.publish(snapshot);
    return snapshot;
  }

  clearPresentation() {
    if (this.disposed) {
      return false;
    }

    this.invalidatePageGate();
    const snapshot = this.store.clearPresentation();
    this.publish(snapshot);
    return snapshot;
  }

  /** 設定 revision 變更時先封鎖舊 layout，再接受新版 Display 回報。 */
  updateSettingsRevision(settingsRevision) {
    if (
      this.disposed ||
      !Number.isSafeInteger(settingsRevision) ||
      settingsRevision < this.settingsRevision
    ) {
      return false;
    }

    if (settingsRevision === this.settingsRevision) {
      return true;
    }

    this.invalidatePageGate();
    this.settingsRevision = settingsRevision;
    return true;
  }

  /** 隱藏或失效的 Display 不得消耗使用者設定的最短顯示時間。 */
  setDisplayAvailable(displayAvailable) {
    if (this.disposed || typeof displayAvailable !== 'boolean') {
      return false;
    }

    if (displayAvailable === this.displayAvailable) {
      return true;
    }

    if (displayAvailable && this.displayEpoch >= Number.MAX_SAFE_INTEGER) {
      return false;
    }

    this.invalidatePageGate();
    this.displayAvailable = displayAvailable;
    if (displayAvailable) {
      // 每次重新顯示都核發新世代，拒絕顯示前產生但延遲抵達的 IPC。
      this.displayEpoch += 1;
    }
    return true;
  }

  /**
   * 接收經 Coordinator 授權後的 Display 版面回報。
   * stale revision、舊 layout、未先 ready 的 complete 一律不改變狀態。
   */
  reportPageProgress(report) {
    if (
      this.disposed ||
      !this.displayAvailable ||
      !isValidProgressReport(report) ||
      report.displayEpoch !== this.displayEpoch ||
      report.settingsRevision !== this.settingsRevision
    ) {
      return false;
    }

    const snapshot = this.store.getSnapshot();
    if (
      snapshot.mode !== PRESENTATION_MODES.PAGE ||
      report.revision !== snapshot.revision ||
      report.pageNumber !== snapshot.pageNumber ||
      this.wasLayoutInvalidated(report)
    ) {
      return false;
    }

    const gate = this.pageGate;
    const sameRenderer = gate?.rendererId === report.rendererId;
    const sameLayout = Boolean(
      sameRenderer &&
      gate.settingsRevision === report.settingsRevision &&
      gate.layoutGeneration === report.layoutGeneration,
    );

    if (
      sameRenderer &&
      report.layoutGeneration < gate.layoutGeneration
    ) {
      return false;
    }

    if (!sameLayout) {
      // complete 本身不能建立可信 layout；必須先收到 pending 或 ready。
      if (report.phase === PAGE_PROGRESS_PHASES.COMPLETE) {
        return false;
      }

      this.invalidatePageGate();
      this.pageGate = this.createGate(report);
      if (report.phase === PAGE_PROGRESS_PHASES.READY) {
        this.markReady(this.pageGate, report.marqueeCount);
      }
      return true;
    }

    if (report.phase === PAGE_PROGRESS_PHASES.PENDING) {
      // 同一 layout 的重送不得把 ready 降級或重新啟動 timer。
      return true;
    }

    if (report.phase === PAGE_PROGRESS_PHASES.READY) {
      if (gate.ready) {
        return true;
      }

      this.markReady(gate, report.marqueeCount);
      return true;
    }

    if (!gate.ready) {
      return false;
    }

    gate.traversalSatisfied = true;
    this.advanceIfSatisfied(gate);
    return true;
  }

  createGate(report) {
    return {
      rendererId: report.rendererId,
      displayEpoch: report.displayEpoch,
      revision: report.revision,
      pageNumber: report.pageNumber,
      settingsRevision: report.settingsRevision,
      layoutGeneration: report.layoutGeneration,
      ready: false,
      marqueeCount: null,
      minimumElapsed: false,
      traversalSatisfied: false,
    };
  }

  markReady(gate, marqueeCount) {
    gate.ready = true;
    gate.marqueeCount = marqueeCount;
    gate.traversalSatisfied = marqueeCount === 0;

    if (!this.store.shouldScheduleNextPage()) {
      return;
    }

    const generation = this.generation;
    const delay = this.store.getPageDurationMilliseconds();
    const handle = this.setTimer(() => {
      if (
        this.disposed ||
        generation !== this.generation ||
        this.pageGate !== gate
      ) {
        return;
      }

      this.timerHandle = null;
      gate.minimumElapsed = true;
      this.advanceIfSatisfied(gate);
    }, delay);

    this.timerHandle = handle;
    handle?.unref?.();
  }

  advanceIfSatisfied(gate) {
    if (
      this.disposed ||
      this.pageGate !== gate ||
      !gate.minimumElapsed ||
      !gate.traversalSatisfied ||
      !this.store.shouldScheduleNextPage()
    ) {
      return false;
    }

    this.invalidatePageGate();
    const snapshot = this.store.advanceProgram();
    this.publish(snapshot);
    return true;
  }

  /** 設定、resize 或 Display 重建時，使舊 timer 與 animation 事件失效。 */
  invalidateCurrentPageLayout() {
    if (this.disposed) {
      return false;
    }

    this.invalidatePageGate();
    return true;
  }

  /** 保留既有方法名稱供生命週期內部一致取消，但不再自行排下一頁。 */
  cancelScheduledPage() {
    this.invalidatePageGate();
  }

  invalidatePageGate() {
    this.generation += 1;

    if (this.pageGate) {
      const gate = this.pageGate;
      const previous = this.invalidatedLayout;
      const sameScope = previous &&
        previous.rendererId === gate.rendererId &&
        previous.displayEpoch === gate.displayEpoch &&
        previous.revision === gate.revision &&
        previous.pageNumber === gate.pageNumber &&
        previous.settingsRevision === gate.settingsRevision;
      this.invalidatedLayout = {
        rendererId: gate.rendererId,
        displayEpoch: gate.displayEpoch,
        revision: gate.revision,
        pageNumber: gate.pageNumber,
        settingsRevision: gate.settingsRevision,
        layoutGeneration: sameScope
          ? Math.max(previous.layoutGeneration, gate.layoutGeneration)
          : gate.layoutGeneration,
      };
    }

    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }

    this.pageGate = null;
  }

  wasLayoutInvalidated(report) {
    const invalidated = this.invalidatedLayout;
    return Boolean(
      invalidated &&
      invalidated.rendererId === report.rendererId &&
      invalidated.displayEpoch === report.displayEpoch &&
      invalidated.revision === report.revision &&
      invalidated.pageNumber === report.pageNumber &&
      invalidated.settingsRevision === report.settingsRevision &&
      report.layoutGeneration <= invalidated.layoutGeneration
    );
  }

  publish(snapshot) {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.invalidatePageGate();
    this.listeners.clear();
  }
}

module.exports = { PresentationService };
