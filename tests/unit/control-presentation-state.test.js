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
      { message: '001請至前廳' },
      { message: 'Nancy前廳000' },
    ],
    layout: 'single-line',
    pageDurationSeconds: 3,
    pageNumber: 1,
    pageCount: 2,
    roundNumber: 1,
    totalRounds: 10,
    revision,
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
    revision: 0,
  };
  const emergency = {
    mode: 'emergency',
    messages: [{ message: '555' }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision: 1,
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

test('Control 拒絕未知欄位、超過三則、錯誤 metadata 與不安全 revision', async () => {
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
      messages: Array.from({ length: 4 }, () => ({ message: '超量' })),
    },
    { ...valid, messages: [{ message: '合法', title: '禁止欄位' }] },
    { ...valid, pageDurationSeconds: null },
    { ...valid, pageNumber: 3 },
    { ...valid, roundNumber: null, totalRounds: 10 },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.deepEqual(acceptPresentationSnapshot(-1, snapshot), {
      accepted: false,
    });
  }
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
