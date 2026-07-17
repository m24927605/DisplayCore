'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'control', 'presentation-state.mjs'),
).toString();

async function loadPresentationState() {
  return import(moduleUrl);
}

function createPageSnapshot(revision = 3) {
  return {
    mode: 'page',
    messages: [
      { message: '001請至前廳', alignment: 'left' },
      { message: 'Nancy前廳000', alignment: 'left' },
    ],
    layout: 'single-line',
    pageDurationSeconds: 3,
    pageNumber: 1,
    pageCount: 1,
    roundNumber: 1,
    totalRounds: 10,
    emergencyTone: null,
    revision,
    contentRevision: 2,
  };
}

test('Control 接受結構完整且 revision 較新的 page snapshot', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const snapshot = createPageSnapshot();

  assert.deepEqual(acceptPresentationSnapshot(2, snapshot), {
    accepted: true,
    snapshot,
  });
  assert.deepEqual(
    acceptPresentationSnapshot(3, createPageSnapshot(2)),
    { accepted: false },
  );
});

test('Control 接受 blank／emergency discriminated shape', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const blank = {
    mode: 'blank',
    messages: [],
    layout: 'single-line',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    emergencyTone: null,
    revision: 0,
    contentRevision: 0,
  };
  const emergency = {
    mode: 'emergency',
    messages: [{ message: '555', alignment: 'center' }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    emergencyTone: 'inspection',
    revision: 1,
    contentRevision: 1,
  };

  assert.equal(acceptPresentationSnapshot(-1, blank).accepted, true);
  assert.equal(acceptPresentationSnapshot(0, emergency).accepted, true);
});

test('相同 revision 一律視為已處理，不允許衝突內容重畫', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();

  assert.deepEqual(acceptPresentationSnapshot(5, createPageSnapshot(5)), {
    accepted: false,
  });
});

test('Control 接受完整 active 清單，並拒絕超量、頁數不一致與不安全版本', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const valid = createPageSnapshot();
  const invalidSnapshots = [
    null,
    [],
    { ...valid, title: '禁止欄位' },
    { ...valid, mode: 'unknown' },
    { ...valid, messages: [] },
    {
      ...valid,
      messages: Array.from({ length: 501 }, () => ({
        message: '超量',
        alignment: 'left',
      })),
      pageCount: 167,
    },
    { ...valid, messages: [{ message: '合法', alignment: 'right' }] },
    {
      ...valid,
      messages: [{ message: '合法', alignment: 'left', title: '禁止欄位' }],
    },
    { ...valid, emergencyTone: 'release' },
    { ...valid, pageDurationSeconds: null },
    { ...valid, pageCount: 2 },
    { ...valid, pageNumber: 2 },
    { ...valid, roundNumber: null, totalRounds: 10 },
    { ...valid, roundNumber: 1, totalRounds: 1_000 },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, contentRevision: -1 },
    { ...valid, contentRevision: 1.5 },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.deepEqual(acceptPresentationSnapshot(-1, snapshot), {
      accepted: false,
    });
  }
});

test('Control 的七則 active 訊息必須對應三頁，且接受翻頁時不變的內容版本', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const messages = Array.from({ length: 7 }, (_value, index) => ({
    message: `訊息${index + 1}`,
    alignment: 'left',
  }));
  const snapshot = {
    ...createPageSnapshot(8),
    messages,
    pageNumber: 2,
    pageCount: 3,
    contentRevision: 4,
  };

  assert.equal(acceptPresentationSnapshot(7, snapshot).accepted, true);
});

test('接受後深層複製 messages，不保留可被外部修改的物件', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const input = createPageSnapshot(8);
  const result = acceptPresentationSnapshot(7, input);

  assert.equal(result.accepted, true);
  assert.notEqual(result.snapshot, input);
  assert.notEqual(result.snapshot.messages, input.messages);
  assert.notEqual(result.snapshot.messages[0], input.messages[0]);

  input.messages[0].message = '被修改';
  assert.equal(result.snapshot.messages[0].message, '001請至前廳');
});
