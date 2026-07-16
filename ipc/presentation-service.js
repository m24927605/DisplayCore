'use strict';

const { PresentationStore } = require('./presentation-store');

/**
 * 管理 Main Process 唯一的翻頁 timer 與狀態發布。
 *
 * 使用串接 setTimeout 而非 setInterval；系統睡眠或負載延遲時只前進一頁，
 * 再重新給下一頁完整停留時間。generation 使已進入 callback queue 的舊
 * timer 無法覆蓋 emergency、clear 或新的播放清單。
 */
class PresentationService {
  constructor({
    store = new PresentationStore(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (handle) => clearTimeout(handle),
    onListenerError = () => {},
  } = {}) {
    this.store = store;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onListenerError = onListenerError;
    this.listeners = new Set();
    this.timerHandle = null;
    this.generation = 0;
    this.disposed = false;
  }

  getSnapshot() {
    return this.store.getSnapshot();
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

    this.cancelScheduledPage();
    const snapshot = this.store.startProgram(program);
    this.publish(snapshot);
    this.scheduleNextPage();
    return snapshot;
  }

  showEmergency(code) {
    if (this.disposed) {
      return false;
    }

    this.cancelScheduledPage();
    const snapshot = this.store.showEmergency(code);
    this.publish(snapshot);
    return snapshot;
  }

  clearPresentation() {
    if (this.disposed) {
      return false;
    }

    this.cancelScheduledPage();
    const snapshot = this.store.clearPresentation();
    this.publish(snapshot);
    return snapshot;
  }

  scheduleNextPage() {
    if (this.disposed || !this.store.shouldScheduleNextPage()) {
      return;
    }

    const generation = this.generation;
    const delay = this.store.getPageDurationMilliseconds();
    const handle = this.setTimer(() => {
      if (this.disposed || generation !== this.generation) {
        return;
      }

      this.timerHandle = null;
      const snapshot = this.store.advanceProgram();
      this.publish(snapshot);
      this.scheduleNextPage();
    }, delay);

    this.timerHandle = handle;
    handle?.unref?.();
  }

  cancelScheduledPage() {
    this.generation += 1;

    if (this.timerHandle !== null) {
      this.clearTimer(this.timerHandle);
      this.timerHandle = null;
    }
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
    this.cancelScheduledPage();
    this.listeners.clear();
  }
}

module.exports = { PresentationService };
