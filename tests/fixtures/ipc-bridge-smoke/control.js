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

function hasExpectedConfigV9(
  config,
  offsetSeconds,
  renderResolution,
  pageDurationSeconds,
  repeatMode,
  roundCount,
  logoSizePercent,
  standbyBackgroundMode = 'fixed',
  standbyBackgroundImagePaths = [],
  standbySlideDurationSeconds = 10,
) {
  return (
    config !== null &&
    typeof config === 'object' &&
    config.configVersion === 9 &&
    hasExactKeys(config.logo, ['enabled', 'path', 'sizePercent']) &&
    config.logo.sizePercent === logoSizePercent &&
    hasExactKeys(config.standby, [
      'backgroundImagePaths',
      'backgroundMode',
      'slideDurationSeconds',
    ]) &&
    config.standby.backgroundMode === standbyBackgroundMode &&
    Array.isArray(config.standby.backgroundImagePaths) &&
    JSON.stringify(config.standby.backgroundImagePaths) ===
      JSON.stringify(standbyBackgroundImagePaths) &&
    config.standby.slideDurationSeconds === standbySlideDurationSeconds &&
    config.appearance?.messageLiquidEffectEnabled === true &&
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
  logoSizePercent,
  standbyBackgroundMode = 'fixed',
  standbyBackgroundImagePaths = [],
  standbySlideDurationSeconds = 10,
) {
  return (
    hasExactKeys(snapshot, ['config', 'defaults', 'notice', 'revision']) &&
    snapshot.revision === revision &&
    snapshot.notice === null &&
    hasExpectedConfigV9(
      snapshot.config,
      offsetSeconds,
      renderResolution,
      pageDurationSeconds,
      repeatMode,
      roundCount,
      logoSizePercent,
      standbyBackgroundMode,
      standbyBackgroundImagePaths,
      standbySlideDurationSeconds,
    ) &&
    hasExpectedConfigV9(snapshot.defaults, 0, 'auto', 3, 'finite', 1, 100)
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
        100,
      )
    ) {
      document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
      return;
    }

    const fixedBackground =
      await window.displayCoreControl.chooseStandbyBackground('fixed');
    const slideshowBackground =
      await window.displayCoreControl.chooseStandbyBackground('slideshow');

    if (
      !fixedBackground.ok ||
      !hasExactKeys(fixedBackground.data, ['assetPaths', 'canceled']) ||
      fixedBackground.data.canceled !== false ||
      JSON.stringify(fixedBackground.data.assetPaths) !== JSON.stringify([
        'standby-backgrounds/0123456789abcdef01234567.png',
      ]) ||
      !slideshowBackground.ok ||
      !hasExactKeys(slideshowBackground.data, ['assetPaths', 'canceled']) ||
      slideshowBackground.data.canceled !== false ||
      JSON.stringify(slideshowBackground.data.assetPaths) !== JSON.stringify([
        'standby-backgrounds/0123456789abcdef01234567.png',
        'standby-backgrounds/abcdef0123456789abcdef01.webp',
      ])
    ) {
      document.title = 'DISPLAYCORE_CONTROL_IPC_FAILED';
      return;
    }

    const selectedBackgroundPaths = [...slideshowBackground.data.assetPaths];
    const nextConfig = structuredClone(loadedSettings.data.config);
    nextConfig.dateTime.offsetSeconds = 3_661;
    nextConfig.playback.pageDurationSeconds = 8;
    nextConfig.playback.repeatMode = 'continuous';
    nextConfig.playback.roundCount = 7;
    nextConfig.display.renderResolution = '2560x1440';
    nextConfig.logo.sizePercent = 150;
    nextConfig.standby = {
      backgroundMode: 'slideshow',
      backgroundImagePaths: selectedBackgroundPaths,
      slideDurationSeconds: 12,
    };
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
        150,
        'slideshow',
        selectedBackgroundPaths,
        12,
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
