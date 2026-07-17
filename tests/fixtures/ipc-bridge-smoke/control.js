'use strict';

const PROGRAM_MESSAGES = Object.freeze([
  Object.freeze({
    message: '555\nNancy原樣<script>不是標籤</script>',
    alignment: 'left',
  }),
  Object.freeze({ message: '002請至前廳', alignment: 'left' }),
  Object.freeze({ message: '歡迎光臨', alignment: 'center' }),
  Object.freeze({ message: '請輕聲細語', alignment: 'center' }),
]);

const CONTROL_SNAPSHOT_KEYS = Object.freeze([
  'contentRevision',
  'emergencyTone',
  'layout',
  'messages',
  'mode',
  'pageCount',
  'pageDurationSeconds',
  'pageNumber',
  'revision',
  'roundNumber',
  'totalRounds',
]);

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function hasExpectedMessages(messages, expectedMessages) {
  return (
    Array.isArray(messages) &&
    messages.length === expectedMessages.length &&
    messages.every(
      (item, index) =>
        hasExactKeys(item, ['alignment', 'message']) &&
        item.message === expectedMessages[index].message &&
        item.alignment === expectedMessages[index].alignment,
    )
  );
}

function isExpectedBlankSnapshot(snapshot, revision, contentRevision) {
  return (
    hasExactKeys(snapshot, CONTROL_SNAPSHOT_KEYS) &&
    snapshot.mode === 'blank' &&
    hasExpectedMessages(snapshot.messages, []) &&
    snapshot.layout === 'single-line' &&
    snapshot.pageDurationSeconds === null &&
    snapshot.pageNumber === null &&
    snapshot.pageCount === null &&
    snapshot.roundNumber === null &&
    snapshot.totalRounds === null &&
    snapshot.emergencyTone === null &&
    snapshot.revision === revision &&
    snapshot.contentRevision === contentRevision
  );
}

function isExpectedControlSnapshot(snapshot) {
  return (
    hasExactKeys(snapshot, CONTROL_SNAPSHOT_KEYS) &&
    snapshot.mode === 'page' &&
    hasExpectedMessages(snapshot.messages, PROGRAM_MESSAGES) &&
    snapshot.layout === 'single-line' &&
    snapshot.pageDurationSeconds === 3 &&
    snapshot.pageNumber === 1 &&
    snapshot.pageCount === 2 &&
    snapshot.roundNumber === null &&
    snapshot.totalRounds === null &&
    snapshot.emergencyTone === null &&
    snapshot.revision === 2 &&
    snapshot.contentRevision === 2
  );
}

function hasExpectedConfigV5(
  config,
  offsetSeconds,
  renderResolution,
  pageDurationSeconds,
  repeatMode,
  roundCount,
) {
  return (
    config !== null &&
    typeof config === 'object' &&
    config.configVersion === 5 &&
    hasExactKeys(config.standby, ['backgroundImagePath']) &&
    config.standby.backgroundImagePath === null &&
    config.dateTime?.enabled === true &&
    config.dateTime?.offsetSeconds === offsetSeconds &&
    hasExactKeys(config.playback, [
      'pageDurationSeconds',
      'repeatMode',
      'roundCount',
    ]) &&
    config.playback.pageDurationSeconds === pageDurationSeconds &&
    config.playback.repeatMode === repeatMode &&
    config.playback.roundCount === roundCount &&
    config.display?.renderResolution === renderResolution
  );
}

function isExpectedSettingsSnapshot(
  snapshot,
  revision,
  offsetSeconds,
  renderResolution,
  pageDurationSeconds,
  repeatMode,
  roundCount,
) {
  return (
    hasExactKeys(snapshot, ['config', 'defaults', 'notice', 'revision']) &&
    snapshot.revision === revision &&
    snapshot.notice === null &&
    hasExpectedConfigV5(
      snapshot.config,
      offsetSeconds,
      renderResolution,
      pageDurationSeconds,
      repeatMode,
      roundCount,
    ) &&
    hasExpectedConfigV5(snapshot.defaults, 0, 'auto', 3, 'finite', 1)
  );
}

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const loadedSettings = await window.displayCoreControl.getSettings();

    if (
      !loadedSettings.ok ||
      !isExpectedSettingsSnapshot(
        loadedSettings.data,
        0,
        0,
        'auto',
        3,
        'finite',
        1,
      )
    ) {
      document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
      return;
    }

    const nextConfig = structuredClone(loadedSettings.data.config);
    nextConfig.dateTime.offsetSeconds = 3_661;
    nextConfig.playback.pageDurationSeconds = 8;
    nextConfig.playback.repeatMode = 'continuous';
    nextConfig.playback.roundCount = 7;
    nextConfig.display.renderResolution = '2560x1440';
    const savedSettings = await window.displayCoreControl.saveSettings(
      nextConfig,
      loadedSettings.data.revision,
    );

    if (
      !savedSettings.ok ||
      !isExpectedSettingsSnapshot(
        savedSettings.data,
        1,
        3_661,
        '2560x1440',
        8,
        'continuous',
        7,
      )
    ) {
      document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
      return;
    }

    const initial = await window.displayCoreControl.getPresentation();

    if (!initial.ok || !isExpectedBlankSnapshot(initial.data, 0, 0)) {
      document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
      return;
    }

    const cleared = await window.displayCoreControl.clearPresentation(
      initial.data.contentRevision,
    );

    if (!cleared.ok || !isExpectedBlankSnapshot(cleared.data, 1, 1)) {
      document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
      return;
    }

    const started = await window.displayCoreControl.startProgram(
      PROGRAM_MESSAGES,
      3,
      { mode: 'continuous' },
      cleared.data.contentRevision,
    );

    document.title = started.ok && isExpectedControlSnapshot(started.data)
      ? 'DISPLAYCORE_CONTROL_IPC_OK'
      : 'DISPLAYCORE_CONTROL_IPC_FAILED';
  } catch {
    document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
  }
});
