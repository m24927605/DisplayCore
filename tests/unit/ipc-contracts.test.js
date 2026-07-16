'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IPC_CHANNELS,
  IPC_ROLES,
  PRESENTATION_LAYOUTS,
} = require('../../ipc/channels');
const {
  MAX_MESSAGE_CODE_POINTS,
  validateShowMessagePayload,
} = require('../../ipc/validators');

test('IPC channel 具有版本命名空間且彼此不重複', () => {
  const channels = Object.values(IPC_CHANNELS);

  assert.equal(new Set(channels).size, channels.length);
  assert.equal(channels.every((channel) => channel.startsWith('dc:v1:')), true);
  assert.deepEqual(IPC_ROLES, {
    CONTROL: 'control',
    DISPLAY: 'display',
  });
  assert.deepEqual(PRESENTATION_LAYOUTS, {
    SINGLE_LINE: 'single-line',
    FILL_SCREEN: 'fill-screen',
  });
  assert.equal(Object.isFrozen(IPC_CHANNELS), true);
  assert.equal(Object.isFrozen(IPC_ROLES), true);
  assert.equal(Object.isFrozen(PRESENTATION_LAYOUTS), true);
});

test('message 保留原始內容且 layout 可表達單行與滿屏模式', () => {
  const standardMessage = '  Nancy請至前廳\n原樣保留  ';
  const standard = validateShowMessagePayload({
    message: standardMessage,
    layout: PRESENTATION_LAYOUTS.SINGLE_LINE,
  });
  const inspection = validateShowMessagePayload({
    message: '555\n555<script>不是標籤</script>',
    layout: PRESENTATION_LAYOUTS.FILL_SCREEN,
  });

  assert.deepEqual(standard, {
    ok: true,
    value: {
      message: standardMessage,
      layout: 'single-line',
    },
  });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.value.message, '555\n555<script>不是標籤</script>');
  assert.equal(inspection.value.layout, 'fill-screen');
});

test('顯示 payload 嚴格拒絕錯誤型別、未知欄位與不支援的 layout', () => {
  const invalidPayloads = [
    null,
    [],
    '001請至前廳',
    {},
    { message: 1, layout: 'single-line' },
    { message: '001請至前廳', layout: 'unknown' },
    { message: '001請至前廳', layout: 'single-line', title: '禁止欄位' },
  ];

  for (const payload of invalidPayloads) {
    const result = validateShowMessagePayload(payload);

    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.error.code, 'VALIDATION_FAILED');
    assert.equal(typeof result.error.message, 'string');
  }
});

test('message 使用 Unicode code point 上限防止過大 IPC payload', () => {
  assert.equal(MAX_MESSAGE_CODE_POINTS, 10_000);

  const accepted = validateShowMessagePayload({
    message: '😀'.repeat(MAX_MESSAGE_CODE_POINTS),
    layout: 'single-line',
  });
  const rejected = validateShowMessagePayload({
    message: '😀'.repeat(MAX_MESSAGE_CODE_POINTS + 1),
    layout: 'single-line',
  });

  assert.equal(accepted.ok, true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.field, 'message');
});
