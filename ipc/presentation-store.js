'use strict';

const {
  PLAYBACK_MODES,
  EMERGENCY_TONES,
  MESSAGE_ALIGNMENTS,
  PRESENTATION_LAYOUTS,
  PRESENTATION_MODES,
} = require('./channels');
const { MESSAGES_PER_PAGE } = require('./validators');

const EMERGENCY_TONE_BY_CODE = Object.freeze({
  '555': EMERGENCY_TONES.INSPECTION,
  '888': EMERGENCY_TONES.RELEASE,
});

function copyMessages(messages) {
  return messages.map(({ message, alignment }) => ({ message, alignment }));
}

function freezeProgram(program) {
  const messages = program.messages.map(({ message, alignment }) =>
    Object.freeze({ message, alignment }),
  );

  return Object.freeze({
    messages: Object.freeze(messages),
    pageDurationSeconds: program.pageDurationSeconds,
    repeat: Object.freeze({ ...program.repeat }),
  });
}

function createBlankState(revision, contentRevision) {
  return Object.freeze({
    mode: PRESENTATION_MODES.BLANK,
    program: null,
    pageIndex: null,
    roundNumber: null,
    emergencyCode: null,
    emergencyTone: null,
    revision,
    contentRevision,
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
    this.state = createBlankState(0, 0);
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
        emergencyTone: null,
        revision: state.revision,
      };
    }

    if (state.mode === PRESENTATION_MODES.EMERGENCY) {
      return {
        mode: PRESENTATION_MODES.EMERGENCY,
        messages: [{
          message: state.emergencyCode,
          alignment: MESSAGE_ALIGNMENTS.CENTER,
        }],
        layout: PRESENTATION_LAYOUTS.FILL_SCREEN,
        pageDurationSeconds: null,
        pageNumber: null,
        pageCount: null,
        roundNumber: null,
        totalRounds: null,
        emergencyTone: state.emergencyTone,
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
      emergencyTone: null,
      revision: state.revision,
    };
  }

  /** Control 需要完整 active 內容；Display 仍只取得 getSnapshot() 的當頁。 */
  getControlSnapshot() {
    const snapshot = this.getSnapshot();
    const messages = this.state.mode === PRESENTATION_MODES.PAGE
      ? copyMessages(this.state.program.messages)
      : copyMessages(snapshot.messages);

    return {
      ...snapshot,
      messages,
      contentRevision: this.state.contentRevision,
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
      emergencyTone: null,
      revision: this.state.revision + 1,
      contentRevision: this.state.contentRevision + 1,
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

    this.state = createBlankState(
      state.revision + 1,
      state.contentRevision + 1,
    );
    return this.getSnapshot();
  }

  showEmergency(code) {
    const emergencyTone = EMERGENCY_TONE_BY_CODE[code];
    if (!emergencyTone) {
      throw new TypeError('不支援的滿屏代碼。');
    }

    this.state = Object.freeze({
      mode: PRESENTATION_MODES.EMERGENCY,
      program: null,
      pageIndex: null,
      roundNumber: null,
      emergencyCode: code,
      emergencyTone,
      revision: this.state.revision + 1,
      contentRevision: this.state.contentRevision + 1,
    });

    return this.getSnapshot();
  }

  clearPresentation() {
    this.state = createBlankState(
      this.state.revision + 1,
      this.state.contentRevision + 1,
    );
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
