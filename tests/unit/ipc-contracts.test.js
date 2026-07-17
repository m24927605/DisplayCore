'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IPC_CHANNELS,
  IPC_ROLES,
  EMERGENCY_TONES,
  MESSAGE_ALIGNMENTS,
  PAGE_PROGRESS_PHASES,
  PLAYBACK_MODES,
  PRESENTATION_LAYOUTS,
  PRESENTATION_MODES,
} = require('../../ipc/channels');
const {
  MAX_CYCLE_COUNT,
  MAX_MESSAGE_CODE_POINTS,
  MAX_MESSAGE_COUNT,
  MAX_PAGE_DURATION_SECONDS,
  MESSAGES_PER_PAGE,
  MIN_PAGE_DURATION_SECONDS,
  validateEmergencyPayload,
  validateClearPresentationPayload,
  validatePageProgressPayload,
  validateSaveSettingsPayload,
  validateStartProgramPayload,
} = require('../../ipc/validators');

const defaultConfig = require('../../config.json');

function createMessages(count, prefix = '訊息') {
  return Array.from({ length: count }, (_value, index) => ({
    message: `${prefix}${index + 1}`,
    alignment: 'left',
  }));
}

test('IPC v2 channel、角色與顯示列舉皆固定且不可修改', () => {
  const channels = Object.values(IPC_CHANNELS);

  assert.equal(new Set(channels).size, channels.length);
  assert.equal(channels.every((channel) => channel.startsWith('dc:v2:')), true);
  assert.deepEqual(IPC_ROLES, {
    CONTROL: 'control',
    DISPLAY: 'display',
  });
  assert.deepEqual(PRESENTATION_LAYOUTS, {
    SINGLE_LINE: 'single-line',
    FILL_SCREEN: 'fill-screen',
  });
  assert.deepEqual(PRESENTATION_MODES, {
    BLANK: 'blank',
    PAGE: 'page',
    EMERGENCY: 'emergency',
  });
  assert.deepEqual(MESSAGE_ALIGNMENTS, {
    LEFT: 'left',
    CENTER: 'center',
  });
  assert.deepEqual(EMERGENCY_TONES, {
    INSPECTION: 'inspection',
    RELEASE: 'release',
  });
  assert.deepEqual(PLAYBACK_MODES, {
    CONTINUOUS: 'continuous',
    FINITE: 'finite',
  });
  assert.deepEqual(PAGE_PROGRESS_PHASES, {
    PENDING: 'pending',
    READY: 'ready',
    COMPLETE: 'complete',
  });
  assert.equal(
    IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
    'dc:v2:control:output-status:get',
  );
  assert.equal(
    IPC_CHANNELS.CONTROL_OUTPUT_STATUS_CHANGED,
    'dc:v2:control:output-status:changed',
  );
  assert.equal(
    IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
    'dc:v2:display:page-progress:report',
  );
  assert.equal(
    IPC_CHANNELS.DISPLAY_REFIT_REQUESTED,
    'dc:v2:display:layout:refit-requested',
  );

  for (const value of [
    IPC_CHANNELS,
    IPC_ROLES,
    EMERGENCY_TONES,
    MESSAGE_ALIGNMENTS,
    PAGE_PROGRESS_PHASES,
    PRESENTATION_LAYOUTS,
    PRESENTATION_MODES,
    PLAYBACK_MODES,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test('Display 頁面進度只接受目前版面雙閘門需要的 exact payload', () => {
  const common = {
    displayEpoch: 1,
    revision: 7,
    pageNumber: 2,
    settingsRevision: 4,
    layoutGeneration: 11,
  };
  const pending = validatePageProgressPayload({
    ...common,
    phase: 'pending',
  });
  const ready = validatePageProgressPayload({
    ...common,
    phase: 'ready',
    marqueeCount: 2,
  });
  const complete = validatePageProgressPayload({
    ...common,
    phase: 'complete',
  });

  assert.deepEqual(pending, {
    ok: true,
    value: { ...common, phase: 'pending' },
  });
  assert.deepEqual(ready, {
    ok: true,
    value: { ...common, phase: 'ready', marqueeCount: 2 },
  });
  assert.deepEqual(complete, {
    ok: true,
    value: { ...common, phase: 'complete' },
  });

  for (const payload of [
    null,
    {},
    { ...common, phase: 'unknown' },
    { ...common, phase: 'pending', marqueeCount: 0 },
    { ...common, phase: 'complete', marqueeCount: 1 },
    { ...common, phase: 'ready' },
    { ...common, phase: 'ready', marqueeCount: -1 },
    { ...common, phase: 'ready', marqueeCount: 4 },
    { ...common, phase: 'ready', marqueeCount: 1.5 },
    { ...common, phase: 'pending', revision: -1 },
    { ...common, phase: 'pending', revision: 1.5 },
    { ...common, phase: 'pending', displayEpoch: 0 },
    { ...common, phase: 'pending', displayEpoch: 1.5 },
    { ...common, phase: 'pending', pageNumber: 0 },
    { ...common, phase: 'pending', pageNumber: 168 },
    { ...common, phase: 'pending', settingsRevision: -1 },
    { ...common, phase: 'pending', settingsRevision: 1.5 },
    { ...common, phase: 'pending', layoutGeneration: 0 },
    {
      ...common,
      phase: 'pending',
      layoutGeneration: Number.MAX_SAFE_INTEGER + 1,
    },
    { ...common, phase: 'pending', nextPage: true },
  ]) {
    const result = validatePageProgressPayload(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.error.code, 'VALIDATION_FAILED');
  }
});

test('一般顯示接受完整 message 清單與明確的持續／有限輪播模式', () => {
  const messages = [
    { message: '001請至前廳', alignment: 'left' },
    { message: '歡迎光臨', alignment: 'center' },
    {
      message: '公告\n原始換行保留<script>純文字</script>',
      alignment: 'left',
    },
  ];
  const continuous = validateStartProgramPayload({
    messages,
    pageDurationSeconds: 3,
    repeat: { mode: PLAYBACK_MODES.CONTINUOUS },
    expectedContentRevision: 0,
  });
  const finite = validateStartProgramPayload({
    messages,
    pageDurationSeconds: 8,
    repeat: { mode: PLAYBACK_MODES.FINITE, rounds: 10 },
    expectedContentRevision: 7,
  });

  assert.deepEqual(continuous, {
    ok: true,
    value: {
      messages,
      pageDurationSeconds: 3,
      repeat: { mode: 'continuous' },
      expectedContentRevision: 0,
    },
  });
  assert.deepEqual(finite, {
    ok: true,
    value: {
      messages,
      pageDurationSeconds: 8,
      repeat: { mode: 'finite', rounds: 10 },
      expectedContentRevision: 7,
    },
  });
  assert.notEqual(continuous.value.messages, messages);
  assert.notEqual(continuous.value.messages[0], messages[0]);
});

test('每頁固定最多三則，並為訊息數、時間、輪次與總字數設定資源上限', () => {
  assert.equal(MESSAGES_PER_PAGE, 3);
  assert.equal(MAX_MESSAGE_COUNT, 500);
  assert.equal(MAX_MESSAGE_CODE_POINTS, 10_000);
  assert.equal(MIN_PAGE_DURATION_SECONDS, 1);
  assert.equal(MAX_PAGE_DURATION_SECONDS, 3_600);
  assert.equal(MAX_CYCLE_COUNT, 999);

  for (const count of [1, 3, 4, 6, 7, MAX_MESSAGE_COUNT]) {
    assert.equal(
      validateStartProgramPayload({
        messages: createMessages(count),
        pageDurationSeconds: 3,
        repeat: { mode: 'continuous' },
        expectedContentRevision: 0,
      }).ok,
      true,
      `${count} 則應通過`,
    );
  }

  const exactlyAtLimit = validateStartProgramPayload({
    messages: [{
      message: '😀'.repeat(MAX_MESSAGE_CODE_POINTS),
      alignment: 'left',
    }],
    pageDurationSeconds: MAX_PAGE_DURATION_SECONDS,
    repeat: { mode: 'finite', rounds: MAX_CYCLE_COUNT },
    expectedContentRevision: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(exactlyAtLimit.ok, true);
});

test('一般顯示原子拒絕未知欄位、空項目、錯誤 repeat 與超量資料', () => {
  const valid = {
    messages: [{ message: '001請至前廳', alignment: 'left' }],
    pageDurationSeconds: 3,
    repeat: { mode: 'continuous' },
    expectedContentRevision: 0,
  };
  const invalidPayloads = [
    null,
    [],
    {},
    { ...valid, title: '禁止欄位' },
    { ...valid, messages: [] },
    { ...valid, messages: createMessages(MAX_MESSAGE_COUNT + 1) },
    { ...valid, messages: ['不是 message 物件'] },
    { ...valid, messages: [{ message: '', alignment: 'left' }] },
    { ...valid, messages: [{ message: '合法' }] },
    { ...valid, messages: [{ message: '合法', alignment: 'right' }] },
    {
      ...valid,
      messages: [{ message: '合法', alignment: 'left', title: '禁止欄位' }],
    },
    {
      ...valid,
      messages: [{
        message: '😀'.repeat(MAX_MESSAGE_CODE_POINTS + 1),
        alignment: 'left',
      }],
    },
    { ...valid, pageDurationSeconds: 0 },
    { ...valid, pageDurationSeconds: 1.5 },
    { ...valid, pageDurationSeconds: MAX_PAGE_DURATION_SECONDS + 1 },
    { ...valid, repeat: { mode: 'unknown' } },
    { ...valid, repeat: { mode: 'continuous', rounds: 1 } },
    { ...valid, repeat: { mode: 'finite' } },
    { ...valid, repeat: { mode: 'finite', rounds: 0 } },
    { ...valid, repeat: { mode: 'finite', rounds: 1.5 } },
    {
      ...valid,
      repeat: { mode: 'finite', rounds: MAX_CYCLE_COUNT + 1 },
    },
  ];

  for (const payload of invalidPayloads) {
    const result = validateStartProgramPayload(payload);

    assert.equal(result.ok, false, JSON.stringify(payload)?.slice(0, 200));
    assert.equal(result.error.code, 'VALIDATION_FAILED');
    assert.equal(typeof result.error.message, 'string');
  }
});

test('清除畫面只接受 exact contentRevision，比對值不得為負數或小數', () => {
  assert.deepEqual(validateClearPresentationPayload({
    expectedContentRevision: 12,
  }), {
    ok: true,
    value: { expectedContentRevision: 12 },
  });

  for (const payload of [
    undefined,
    {},
    { expectedContentRevision: -1 },
    { expectedContentRevision: 1.5 },
    { expectedContentRevision: 0, extra: true },
  ]) {
    assert.equal(validateClearPresentationPayload(payload).ok, false);
  }
});

test('緊急操作只接受獨立白名單代碼，Main 不從一般 message 推論', () => {
  assert.deepEqual(validateEmergencyPayload({ code: '555' }), {
    ok: true,
    value: { code: '555' },
  });
  assert.deepEqual(validateEmergencyPayload({ code: '888' }), {
    ok: true,
    value: { code: '888' },
  });

  for (const payload of [
    null,
    '555',
    {},
    { code: 555 },
    { code: '999' },
    { code: '555', layout: 'fill-screen' },
  ]) {
    assert.equal(validateEmergencyPayload(payload).ok, false);
  }
});

test('設定儲存只接受完整 config 與目前 revision', () => {
  const valid = validateSaveSettingsPayload({
    config: defaultConfig,
    expectedRevision: 0,
  });

  assert.equal(valid.ok, true);
  assert.notEqual(valid.value.config, defaultConfig);
  assert.equal(valid.value.expectedRevision, 0);

  for (const payload of [
    null,
    {},
    { config: defaultConfig },
    { config: defaultConfig, expectedRevision: -1 },
    { config: defaultConfig, expectedRevision: 0, unknown: true },
    {
      config: { ...defaultConfig, unknown: true },
      expectedRevision: 0,
    },
  ]) {
    const result = validateSaveSettingsPayload(payload);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_FAILED');
  }
});
