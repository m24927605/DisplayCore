'use strict';

const { PRESENTATION_LAYOUTS } = require('./channels');

/**
 * Main Process 內唯一的顯示狀態來源。
 *
 * 狀態不直接暴露給 Renderer；每次讀取都回傳普通物件副本，並以 revision
 * 讓後續 Renderer 忽略較舊的非同步事件。
 */
class PresentationStore {
  constructor() {
    this.state = Object.freeze({
      message: '',
      layout: PRESENTATION_LAYOUTS.SINGLE_LINE,
      revision: 0,
    });
  }

  /**
   * @returns {{message: string, layout: string, revision: number}}
   */
  getSnapshot() {
    return { ...this.state };
  }

  /**
   * @param {{message: string, layout: string}} presentation
   */
  showMessage({ message, layout }) {
    this.state = Object.freeze({
      message,
      layout,
      revision: this.state.revision + 1,
    });

    return this.getSnapshot();
  }

  clearMessage() {
    this.state = Object.freeze({
      message: '',
      layout: PRESENTATION_LAYOUTS.SINGLE_LINE,
      revision: this.state.revision + 1,
    });

    return this.getSnapshot();
  }
}

module.exports = { PresentationStore };
