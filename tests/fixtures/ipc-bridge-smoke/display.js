'use strict';

let latestRevision = -1;
let latestSettingsRevision = -1;
let presentationVerified = false;
let settingsVerified = false;

const EXPECTED_PAGE_MESSAGES = Object.freeze([
  Object.freeze({
    message: '555\nNancy原樣<script>不是標籤</script>',
    alignment: 'left',
  }),
  Object.freeze({ message: '002請至前廳', alignment: 'left' }),
  Object.freeze({ message: '歡迎光臨', alignment: 'center' }),
]);

const DISPLAY_SNAPSHOT_KEYS = Object.freeze([
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

function hasExpectedPageMessages(messages) {
  return (
    Array.isArray(messages) &&
    messages.length === EXPECTED_PAGE_MESSAGES.length &&
    messages.every(
      (item, index) =>
        hasExactKeys(item, ['alignment', 'message']) &&
        item.message === EXPECTED_PAGE_MESSAGES[index].message &&
        item.alignment === EXPECTED_PAGE_MESSAGES[index].alignment,
    )
  );
}

function isExpectedDisplaySnapshot(snapshot) {
  return (
    hasExactKeys(snapshot, DISPLAY_SNAPSHOT_KEYS) &&
    snapshot.mode === 'page' &&
    hasExpectedPageMessages(snapshot.messages) &&
    snapshot.layout === 'single-line' &&
    snapshot.pageDurationSeconds === 3 &&
    snapshot.pageNumber === 1 &&
    snapshot.pageCount === 2 &&
    snapshot.roundNumber === null &&
    snapshot.totalRounds === null &&
    snapshot.emergencyTone === null &&
    snapshot.revision === 2
  );
}

function isExpectedSettingsSnapshot(snapshot) {
  return (
    hasExactKeys(snapshot, [
      'appearance',
      'configVersion',
      'dateTime',
      'display',
      'emergency',
      'logo',
      'marquee',
      'revision',
      'standby',
    ]) &&
    snapshot.configVersion === 6 &&
    !Object.hasOwn(snapshot, 'playback') &&
    snapshot.revision === 1 &&
    hasExactKeys(snapshot.logo, ['enabled', 'sizePercent', 'url']) &&
    snapshot.logo.enabled === false &&
    snapshot.logo.url === null &&
    snapshot.logo.sizePercent === 150 &&
    hasExactKeys(snapshot.standby, ['backgroundImageUrl']) &&
    snapshot.standby.backgroundImageUrl === null &&
    hasExactKeys(snapshot.appearance, [
      'backgroundColor',
      'fontColor',
      'fontFamily',
      'fontSizePercent',
      'lineSpacingPercent',
      'minimumFontSizeRem',
    ]) &&
    hasExactKeys(snapshot.dateTime, ['enabled', 'offsetSeconds']) &&
    snapshot.dateTime.enabled === true &&
    snapshot.dateTime.offsetSeconds === 3_661 &&
    hasExactKeys(snapshot.emergency, [
      'inspectionBackgroundColor',
      'releaseBackgroundColor',
    ]) &&
    hasExactKeys(snapshot.marquee, ['enabled']) &&
    hasExactKeys(snapshot.display, ['renderResolution']) &&
    snapshot.display.renderResolution === '2560x1440'
  );
}

function finishWhenEverythingIsVerified() {
  if (presentationVerified && settingsVerified) {
    document.title = 'DISPLAYCORE_DISPLAY_IPC_OK';
  }
}

async function applySnapshot(snapshot) {
  if (!snapshot || snapshot.revision <= latestRevision) {
    return;
  }

  latestRevision = snapshot.revision;

  if (!isExpectedDisplaySnapshot(snapshot)) {
    return;
  }

  const current = await window.displayCoreDisplay.getPresentation();

  if (current.ok && isExpectedDisplaySnapshot(current.data)) {
    presentationVerified = true;
    finishWhenEverythingIsVerified();
  }
}

async function applySettingsSnapshot(snapshot) {
  if (!snapshot || snapshot.revision <= latestSettingsRevision) {
    return;
  }

  latestSettingsRevision = snapshot.revision;

  if (!isExpectedSettingsSnapshot(snapshot)) {
    return;
  }

  const current = await window.displayCoreDisplay.getSettings();

  if (current.ok && isExpectedSettingsSnapshot(current.data)) {
    settingsVerified = true;
    finishWhenEverythingIsVerified();
  }
}

// 固定順序：先訂閱，再取得初始 snapshot；revision 防止舊回應蓋掉新事件。
window.displayCoreDisplay.onPresentationChanged((snapshot) => {
  void applySnapshot(snapshot);
});

window.displayCoreDisplay.onSettingsChanged((snapshot) => {
  void applySettingsSnapshot(snapshot);
});

void window.displayCoreDisplay.getPresentation().then((result) => {
  if (result.ok) {
    void applySnapshot(result.data);
  }
});

void window.displayCoreDisplay.getSettings().then((result) => {
  if (result.ok) {
    void applySettingsSnapshot(result.data);
  }
});
