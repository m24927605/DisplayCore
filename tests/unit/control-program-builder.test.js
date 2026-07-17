'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const mainLimits = require('../../ipc/validators');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'control', 'program-builder.mjs'),
).toString();

async function loadBuilder() {
  return import(moduleUrl);
}

function createMessages(count) {
  return Array.from({ length: count }, (_, index) => ({
    message: `${String(index + 1).padStart(3, '0')}請至前廳`,
    alignment: 'left',
  }));
}

test('加入訊息會保留完整文字、輸入順序與不可變資料', async () => {
  const { appendMessage } = await loadBuilder();
  const original = [{ message: '001請至前廳', alignment: 'left' }];
  const literal = '  Nancy\n<img src=x>  ';
  const result = appendMessage(original, literal, 'center');

  assert.deepEqual(result, {
    ok: true,
    messages: [
      { message: '001請至前廳', alignment: 'left' },
      { message: literal, alignment: 'center' },
    ],
  });
  assert.notEqual(result.messages, original);
  assert.notEqual(result.messages[0], original[0]);
  assert.ok(Object.isFrozen(result.messages));
  assert.ok(result.messages.every(Object.isFrozen));

  original[0].message = '被外部修改';
  assert.equal(result.messages[0].message, '001請至前廳');
});

test('Control UX 限制與 Main 安全邊界常數保持一致', async () => {
  const { PROGRAM_LIMITS } = await loadBuilder();

  assert.deepEqual(PROGRAM_LIMITS, {
    MESSAGES_PER_PAGE: mainLimits.MESSAGES_PER_PAGE,
    MAX_MESSAGE_COUNT: mainLimits.MAX_MESSAGE_COUNT,
    MAX_MESSAGE_CODE_POINTS: mainLimits.MAX_MESSAGE_CODE_POINTS,
    MIN_PAGE_DURATION_SECONDS: mainLimits.MIN_PAGE_DURATION_SECONDS,
    MAX_PAGE_DURATION_SECONDS: mainLimits.MAX_PAGE_DURATION_SECONDS,
    MIN_ROUNDS: 1,
    MAX_ROUNDS: mainLimits.MAX_CYCLE_COUNT,
  });
});

test('頁數計算集中於 builder 且覆蓋每頁三則的邊界', async () => {
  const { countPages } = await loadBuilder();

  assert.equal(countPages(0), 0);
  assert.equal(countPages(1), 1);
  assert.equal(countPages(3), 1);
  assert.equal(countPages(4), 2);
  assert.equal(countPages(500), 167);
  assert.throws(() => countPages(-1), /messageCount/);
  assert.throws(() => countPages(1.5), /messageCount/);
});

test('刪除指定訊息不會改動原清單，且拒絕無效索引', async () => {
  const { removeMessage } = await loadBuilder();
  const original = createMessages(3);

  assert.deepEqual(removeMessage(original, 1), {
    ok: true,
    messages: [original[0], original[2]],
  });
  assert.equal(original.length, 3);
  assert.deepEqual(removeMessage(original, -1), {
    ok: false,
    error: {
      field: 'messages',
      message: '無法刪除指定的訊息。',
    },
  });
});

test('七則訊息以每頁三則分成三頁，並依整輪次數計算時間', async () => {
  const { PLAYBACK_MODES, buildProgram } = await loadBuilder();
  const result = buildProgram({
    messages: createMessages(7),
    pageDurationSeconds: '3',
    repeatMode: PLAYBACK_MODES.FINITE,
    rounds: '10',
  });

  assert.deepEqual(result, {
    ok: true,
    program: {
      messages: createMessages(7),
      pageDurationSeconds: 3,
      repeat: { mode: 'finite', rounds: 10 },
    },
    summary: {
      messageCount: 7,
      pageCount: 3,
      secondsPerRound: 9,
      totalSeconds: 90,
    },
  });
  assert.ok(Object.isFrozen(result.program));
  assert.ok(Object.isFrozen(result.program.messages));
  assert.ok(Object.isFrozen(result.program.repeat));
  assert.ok(Object.isFrozen(result.summary));
});

test('持續模式不傳送整輪次數，總播放時間也不作有限推算', async () => {
  const { PLAYBACK_MODES, buildProgram } = await loadBuilder();
  const result = buildProgram({
    messages: createMessages(6),
    pageDurationSeconds: 8,
    repeatMode: PLAYBACK_MODES.CONTINUOUS,
    rounds: '不應驗證',
  });

  assert.deepEqual(result.program.repeat, { mode: 'continuous' });
  assert.deepEqual(result.summary, {
    messageCount: 6,
    pageCount: 2,
    secondsPerRound: 16,
    totalSeconds: null,
  });
});

test('空清單、非整數秒數、錯誤模式與非法整輪次數都安全失敗', async () => {
  const { PLAYBACK_MODES, buildProgram } = await loadBuilder();
  const valid = {
    messages: createMessages(1),
    pageDurationSeconds: '3',
    repeatMode: PLAYBACK_MODES.FINITE,
    rounds: '1',
  };

  for (const [input, field] of [
    [{ ...valid, messages: [] }, 'messages'],
    [{ ...valid, pageDurationSeconds: '3.5' }, 'pageDurationSeconds'],
    [{ ...valid, pageDurationSeconds: '1e2' }, 'pageDurationSeconds'],
    [{ ...valid, pageDurationSeconds: '0' }, 'pageDurationSeconds'],
    [{ ...valid, pageDurationSeconds: '3601' }, 'pageDurationSeconds'],
    [{ ...valid, repeatMode: 'unknown' }, 'repeat'],
    [{ ...valid, rounds: '0' }, 'rounds'],
    [{ ...valid, rounds: '1.5' }, 'rounds'],
    [{ ...valid, rounds: '1000' }, 'rounds'],
  ]) {
    const result = buildProgram(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.field, field);
  }
});

test('清單上限與 Unicode code point 總量上限在 Control 先行擋下', async () => {
  const { appendMessage, buildProgram } = await loadBuilder();

  assert.equal(appendMessage(createMessages(500), '超量', 'left').ok, false);
  assert.equal(appendMessage([], '😀'.repeat(10_000), 'left').ok, true);
  assert.equal(appendMessage([], '😀'.repeat(10_001), 'left').ok, false);
  assert.equal(
    appendMessage(
      [{ message: '甲'.repeat(6_000), alignment: 'left' }],
      '乙'.repeat(4_001),
      'left',
    ).ok,
    false,
  );
  assert.equal(appendMessage([], '', 'left').ok, false);
  assert.equal(appendMessage([], 555, 'left').ok, false);
  assert.equal(appendMessage([], '合法', 'right').ok, false);

  const malformedMessages = createMessages(1);
  malformedMessages[0].extra = true;
  assert.equal(
    buildProgram({
      messages: malformedMessages,
      pageDurationSeconds: 3,
      repeatMode: 'finite',
      rounds: 1,
    }).ok,
    false,
  );

  assert.equal(
    buildProgram({
      messages: [{ message: '缺少排版資訊' }],
      pageDurationSeconds: 3,
      repeatMode: 'finite',
      rounds: 1,
    }).ok,
    false,
  );
});

test('每頁秒數與整輪次數的最小、最大邊界都可建立', async () => {
  const { buildProgram } = await loadBuilder();

  for (const [pageDurationSeconds, rounds] of [
    [1, 1],
    [3_600, 999],
  ]) {
    const result = buildProgram({
      messages: createMessages(500),
      pageDurationSeconds,
      repeatMode: 'finite',
      rounds,
    });
    assert.equal(result.ok, true);
    assert.equal(result.program.pageDurationSeconds, pageDurationSeconds);
    assert.deepEqual(result.program.repeat, { mode: 'finite', rounds });
    assert.equal(result.summary.pageCount, 167);
  }
});

test('播放時間以中文小時、分、秒顯示', async () => {
  const { formatDuration } = await loadBuilder();

  assert.equal(formatDuration(3), '3 秒');
  assert.equal(formatDuration(60), '1 分');
  assert.equal(formatDuration(63), '1 分 3 秒');
  assert.equal(formatDuration(3_661), '1 小時 1 分 1 秒');
  assert.equal(formatDuration(null), '持續顯示');
  assert.throws(() => formatDuration(-1), /duration/);
});
