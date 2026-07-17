'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/settings-state.mjs');
}

function createSnapshot(revision = 0) {
  return {
    configVersion: 7,
    logo: {
      enabled: true,
      url: 'displaycore://app/managed/logo/0123456789abcdef01234567.png',
      sizePercent: 1_000,
    },
    standby: {
      backgroundMode: 'slideshow',
      backgroundImageUrls: [
        'displaycore://app/managed/standby-background/fedcba987654321001234567.webp',
        'displaycore://app/managed/standby-background/0123456789abcdef01234567.png',
      ],
      slideDurationSeconds: 15,
    },
    appearance: {
      backgroundColor: '#102030',
      fontFamily: 'Microsoft JhengHei UI, sans-serif',
      fontColor: '#F4F5F6',
      minimumFontSizeRem: 3.25,
      fontSizePercent: 125,
      lineSpacingPercent: 150,
    },
    dateTime: { enabled: true, offsetSeconds: -3661 },
    emergency: {
      inspectionBackgroundColor: '#7F1D1D',
      releaseBackgroundColor: '#14532D',
    },
    marquee: { enabled: false },
    display: { renderResolution: '2560x1440' },
    revision,
  };
}

test('Display 接受完整設定投影並建立深層凍結副本', async () => {
  const { acceptDisplaySettingsSnapshot } = await loadModule();
  const source = createSnapshot(4);
  const result = acceptDisplaySettingsSnapshot(-1, source);

  assert.equal(result.accepted, true);
  assert.deepEqual(result.snapshot, source);
  assert.notEqual(result.snapshot, source);
  assert.notEqual(result.snapshot.logo, source.logo);
  assert.notEqual(result.snapshot.standby, source.standby);
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.logo), true);
  assert.equal(Object.isFrozen(result.snapshot.standby), true);
  assert.equal(
    Object.isFrozen(result.snapshot.standby.backgroundImageUrls),
    true,
  );
  assert.equal(Object.isFrozen(result.snapshot.appearance), true);
  assert.equal(Object.isFrozen(result.snapshot.dateTime), true);
  assert.equal(Object.isFrozen(result.snapshot.emergency), true);
  assert.equal(Object.isFrozen(result.snapshot.marquee), true);
  assert.equal(Object.isFrozen(result.snapshot.display), true);
  assert.equal(Object.hasOwn(result.snapshot, 'playback'), false);

  source.appearance.backgroundColor = '#000000';
  source.standby.backgroundImageUrls.push(
    'displaycore://app/managed/standby-background/ffffffffffffffffffffffff.jpg',
  );
  assert.equal(result.snapshot.appearance.backgroundColor, '#102030');
  assert.equal(result.snapshot.standby.backgroundImageUrls.length, 2);
});

test('Display 設定 revision 單調遞增且 exact schema 拒絕未知欄位', async () => {
  const { acceptDisplaySettingsSnapshot } = await loadModule();

  assert.equal(acceptDisplaySettingsSnapshot(4, createSnapshot(4)).accepted, false);
  assert.equal(acceptDisplaySettingsSnapshot(4, createSnapshot(3)).accepted, false);
  assert.equal(
    acceptDisplaySettingsSnapshot(4, { ...createSnapshot(5), unknown: true })
      .accepted,
    false,
  );
  assert.equal(
    acceptDisplaySettingsSnapshot(4, {
      ...createSnapshot(5),
      playback: {
        pageDurationSeconds: 3,
        repeatMode: 'finite',
        roundCount: 1,
      },
    }).accepted,
    false,
  );
  assert.equal(
    acceptDisplaySettingsSnapshot(4, {
      ...createSnapshot(5),
      logo: { ...createSnapshot(5).logo, path: 'logos/private.png' },
    }).accepted,
    false,
  );
  assert.equal(
    acceptDisplaySettingsSnapshot(4, {
      ...createSnapshot(5),
      standby: {
        ...createSnapshot(5).standby,
        backgroundImagePath: 'standby-backgrounds/private.png',
      },
    }).accepted,
    false,
  );
});

test('Display 拒絕不安全圖片 URL、顏色、字型、字級與日期設定', async () => {
  const { acceptDisplaySettingsSnapshot } = await loadModule();
  const valid = createSnapshot(1);
  const invalidCandidates = [
    { ...valid, configVersion: 6 },
    { ...valid, configVersion: 8 },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
    { ...valid, logo: { ...valid.logo, url: null } },
    { ...valid, logo: { ...valid.logo, enabled: false } },
    { ...valid, logo: { ...valid.logo, url: 'file:///C:/private/logo.png' } },
    {
      ...valid,
      logo: {
        ...valid.logo,
        enabled: true,
        url: 'displaycore://app/managed/logo/operator-logo.png',
      },
    },
    { ...valid, logo: { ...valid.logo, sizePercent: 49 } },
    { ...valid, logo: { ...valid.logo, sizePercent: 1_001 } },
    { ...valid, logo: { ...valid.logo, sizePercent: 101 } },
    { ...valid, logo: { ...valid.logo, sizePercent: 100.5 } },
    { ...valid, logo: { ...valid.logo, sizePercent: '100' } },
    {
      ...valid,
      standby: {
        ...valid.standby,
        backgroundImageUrls: ['file:///C:/private/background.png'],
      },
    },
    {
      ...valid,
      standby: {
        ...valid.standby,
        backgroundImageUrls: [
          'displaycore://app/managed/standby-background/operator.png',
        ],
      },
    },
    {
      ...valid,
      standby: {
        ...valid.standby,
        backgroundImageUrls: [
          'displaycore://app/managed/standby-background/fedcba987654321001234567.webp?cache=1',
        ],
      },
    },
    {
      ...valid,
      standby: { ...valid.standby, backgroundImageUrls: 42 },
    },
    {
      ...valid,
      standby: { ...valid.standby, backgroundMode: 'random' },
    },
    {
      ...valid,
      standby: { ...valid.standby, slideDurationSeconds: 0 },
    },
    {
      ...valid,
      standby: { ...valid.standby, slideDurationSeconds: 3_601 },
    },
    {
      ...valid,
      standby: { ...valid.standby, slideDurationSeconds: 1.5 },
    },
    {
      ...valid,
      standby: {
        ...valid.standby,
        backgroundImageUrls: [
          valid.standby.backgroundImageUrls[0],
          valid.standby.backgroundImageUrls[0],
        ],
      },
    },
    {
      ...valid,
      standby: {
        ...valid.standby,
        backgroundImageUrls: Array.from(
          { length: 21 },
          (_, index) =>
            `displaycore://app/managed/standby-background/${index
              .toString(16)
              .padStart(24, '0')}.png`,
        ),
      },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, backgroundColor: 'black' },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, fontColor: '#FFF' },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, fontFamily: '   ' },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, minimumFontSizeRem: 2.6 },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, minimumFontSizeRem: 12.25 },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, fontSizePercent: 101 },
    },
    {
      ...valid,
      appearance: { ...valid.appearance, lineSpacingPercent: 305 },
    },
    { ...valid, dateTime: { ...valid.dateTime, enabled: 1 } },
    { ...valid, dateTime: { ...valid.dateTime, offsetSeconds: 1.5 } },
    {
      ...valid,
      emergency: { ...valid.emergency, inspectionBackgroundColor: 'black' },
    },
    {
      ...valid,
      emergency: { ...valid.emergency, releaseBackgroundColor: '#00000080' },
    },
    { ...valid, marquee: { enabled: 1 } },
    { ...valid, display: { renderResolution: '1280x720' } },
    {
      ...valid,
      display: { renderResolution: '1920x1080', selectionMode: 'auto' },
    },
  ];

  for (const candidate of invalidCandidates) {
    assert.equal(
      acceptDisplaySettingsSnapshot(-1, candidate).accepted,
      false,
      JSON.stringify(candidate),
    );
  }
});

test('安全預設值為黑底白字且不顯示 Logo、待機背景與日期', async () => {
  const { SAFE_DISPLAY_SETTINGS } = await loadModule();

  assert.deepEqual(SAFE_DISPLAY_SETTINGS, {
    configVersion: 7,
    logo: { enabled: false, url: null, sizePercent: 100 },
    standby: {
      backgroundMode: 'fixed',
      backgroundImageUrls: [],
      slideDurationSeconds: 10,
    },
    appearance: {
      backgroundColor: '#000000',
      fontFamily:
        'Microsoft JhengHei UI, Microsoft JhengHei, sans-serif',
      fontColor: '#FFFFFF',
      minimumFontSizeRem: 2.5,
      fontSizePercent: 100,
      lineSpacingPercent: 100,
    },
    dateTime: { enabled: false, offsetSeconds: 0 },
    emergency: {
      inspectionBackgroundColor: '#000000',
      releaseBackgroundColor: '#000000',
    },
    marquee: { enabled: true },
    display: { renderResolution: 'auto' },
    revision: -1,
  });
  assert.equal(Object.isFrozen(SAFE_DISPLAY_SETTINGS), true);
  assert.equal(Object.isFrozen(SAFE_DISPLAY_SETTINGS.standby), true);
  assert.equal(
    Object.isFrozen(SAFE_DISPLAY_SETTINGS.standby.backgroundImageUrls),
    true,
  );
  assert.equal(Object.isFrozen(SAFE_DISPLAY_SETTINGS.appearance), true);
  assert.equal(Object.hasOwn(SAFE_DISPLAY_SETTINGS, 'playback'), false);
});
