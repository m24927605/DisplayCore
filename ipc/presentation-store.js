'use strict';

const {
  PLAYBACK_MODES,
  PRESENTATION_LAYOUTS,
  PRESENTATION_MODES,
} = require('./channels');
const { MESSAGES_PER_PAGE } = require('./validators');

function copyMessages(messages) {
  return messages.map(({ message }) => ({ message }));
}

function freezeProgram(program) {
  const messages = program.messages.map(({ message }) =>
    Object.freeze({ message }),
  );

  return Object.freeze({
    messages: Object.freeze(messages),
    pageDurationSeconds: program.pageDurationSeconds,
    repeat: Object.freeze({ ...program.repeat }),
  });
}

function createBlankState(revision) {
  return Object.freeze({
    mode: PRESENTATION_MODES.BLANK,
    program: null,
    pageIndex: null,
    roundNumber: null,
    emergencyCode: null,
    revision,
  });
}

/**
 * Main Process 的純顯示狀態機。
 *
 * 本類別只負責不可變狀態轉移與分頁投影；timer、IPC 及廣播由外層 service
 * 管理，讓每個頁面與輪次邊界可用同步單元測試精確驗證。
 */
class PresentationStore {
  constructor() {
    this.state = createBlankState(0);
  }

  getSnapshot() {
    const state = this.state;

    if (state.mode === PRESENTATION_MODES.BLANK) {
      return {
        mode: PRESENTATION_MODES.BLANK,
        messages: [],
        layout: PRESENTATION_LAYOUTS.SINGLE_LINE,
        pageDurationSeconds: null,
        pageNumber: null,
        pageCount: null,
        roundNumber: null,
        totalRounds: null,
        revision: state.revision,
      };
    }

    if (state.mode === PRESENTATION_MODES.EMERGENCY) {
      return {
        mode: PRESENTATION_MODES.EMERGENCY,
        messages: [{ message: state.emergencyCode }],
        layout: PRESENTATION_LAYOUTS.FILL_SCREEN,
        pageDurationSeconds: null,
        pageNumber: null,
        pageCount: null,
        roundNumber: null,
        totalRounds: null,
        revision: state.revision,
      };
    }

    const pageCount = Math.ceil(
      state.program.messages.length / MESSAGES_PER_PAGE,
    );
    const pageStart = state.pageIndex * MESSAGES_PER_PAGE;
    const messages = state.program.messages.slice(
      pageStart,
      pageStart + MESSAGES_PER_PAGE,
    );
    const isFinite = state.program.repeat.mode === PLAYBACK_MODES.FINITE;

    return {
      mode: PRESENTATION_MODES.PAGE,
      messages: copyMessages(messages),
      layout: PRESENTATION_LAYOUTS.SINGLE_LINE,
      pageDurationSeconds: state.program.pageDurationSeconds,
      pageNumber: state.pageIndex + 1,
      pageCount,
      roundNumber: isFinite ? state.roundNumber : null,
      totalRounds: isFinite ? state.program.repeat.rounds : null,
      revision: state.revision,
    };
  }

  startProgram(program) {
    const frozenProgram = freezeProgram(program);
    const isFinite = frozenProgram.repeat.mode === PLAYBACK_MODES.FINITE;

    this.state = Object.freeze({
      mode: PRESENTATION_MODES.PAGE,
      program: frozenProgram,
      pageIndex: 0,
      roundNumber: isFinite ? 1 : null,
      emergencyCode: null,
      revision: this.state.revision + 1,
    });

    return this.getSnapshot();
  }

  advanceProgram() {
    if (this.state.mode !== PRESENTATION_MODES.PAGE) {
      return this.getSnapshot();
    }

    const state = this.state;
    const pageCount = Math.ceil(
      state.program.messages.length / MESSAGES_PER_PAGE,
    );

    if (state.pageIndex + 1 < pageCount) {
      this.state = Object.freeze({
        ...state,
        pageIndex: state.pageIndex + 1,
        revision: state.revision + 1,
      });
      return this.getSnapshot();
    }

    if (state.program.repeat.mode === PLAYBACK_MODES.CONTINUOUS) {
      this.state = Object.freeze({
        ...state,
        pageIndex: 0,
        revision: state.revision + 1,
      });
      return this.getSnapshot();
    }

    if (state.roundNumber < state.program.repeat.rounds) {
      this.state = Object.freeze({
        ...state,
        pageIndex: 0,
        roundNumber: state.roundNumber + 1,
        revision: state.revision + 1,
      });
      return this.getSnapshot();
    }

    this.state = createBlankState(state.revision + 1);
    return this.getSnapshot();
  }

  showEmergency(code) {
    this.state = Object.freeze({
      mode: PRESENTATION_MODES.EMERGENCY,
      program: null,
      pageIndex: null,
      roundNumber: null,
      emergencyCode: code,
      revision: this.state.revision + 1,
    });

    return this.getSnapshot();
  }

  clearPresentation() {
    this.state = createBlankState(this.state.revision + 1);
    return this.getSnapshot();
  }

  shouldScheduleNextPage() {
    if (this.state.mode !== PRESENTATION_MODES.PAGE) {
      return false;
    }

    const pageCount = Math.ceil(
      this.state.program.messages.length / MESSAGES_PER_PAGE,
    );

    return (
      pageCount > 1 ||
      this.state.program.repeat.mode === PLAYBACK_MODES.FINITE
    );
  }

  getPageDurationMilliseconds() {
    if (this.state.mode !== PRESENTATION_MODES.PAGE) {
      return null;
    }

    return this.state.program.pageDurationSeconds * 1_000;
  }
}

module.exports = { PresentationStore };
