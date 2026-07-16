'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'display', 'presentation-state.mjs'),
).toString();

async function loadState() {
  return import(moduleUrl);
}

function createPage(revision = 1, count = 5) {
  return {
    mode: 'page',
    messages: Array.from({ length: count }, (_value, index) => ({
      message: `訊息${index + 1}`,
    })),
    layout: 'single-line',
    pageDurationSeconds: 3,
    pageNumber: 1,
    pageCount: 3,
    roundNumber: 2,
    totalRounds: 10,
    revision,
  };
}

test('Display 接受 Main 發出的 1 至 5 則 page 並深層複製', async () => {
  const { acceptDisplaySnapshot } = await loadState();

  for (const count of [1, 5]) {
    const input = createPage(2, count);
    const result = acceptDisplaySnapshot(1, input);

    assert.equal(result.accepted, true);
    assert.deepEqual(result.snapshot, input);
    assert.notEqual(result.snapshot, input);
    assert.notEqual(result.snapshot.messages, input.messages);
    assert.notEqual(result.snapshot.messages[0], input.messages[0]);

    input.messages[0].message = '被外部修改';
    assert.equal(result.snapshot.messages[0].message, '訊息1');
  }
});

test('Display 接受空白與任意 fill-screen message，但不判斷 555／888 語意', async () => {
  const { acceptDisplaySnapshot } = await loadState();
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
    messages: [{ message: '任意滿屏文字<script>純文字</script>' }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision: 1,
  };

  assert.equal(acceptDisplaySnapshot(-1, blank).accepted, true);
  assert.equal(acceptDisplaySnapshot(0, emergency).accepted, true);
});

test('Display 拒絕相同／較舊 revision、未知欄位與不可能的頁面 metadata', async () => {
  const { acceptDisplaySnapshot } = await loadState();
  const valid = createPage(5);
  const invalid = [
    null,
    [],
    { ...valid, revision: 4 },
    { ...valid, title: '禁止欄位' },
    { ...valid, mode: 'emergency' },
    { ...valid, layout: 'fill-screen' },
    { ...valid, messages: [] },
    { ...valid, messages: createPage(6, 6).messages },
    { ...valid, messages: [{ message: '' }] },
    { ...valid, messages: [{ message: '合法', extra: true }] },
    { ...valid, pageDurationSeconds: 0 },
    { ...valid, pageNumber: 0 },
    { ...valid, pageNumber: 4, pageCount: 3 },
    { ...valid, pageCount: 101 },
    { ...valid, roundNumber: null, totalRounds: 10 },
    { ...valid, roundNumber: 11, totalRounds: 10 },
    { ...valid, totalRounds: 1_000 },
    { ...valid, revision: 1.5 },
  ];

  for (const candidate of invalid) {
    assert.deepEqual(acceptDisplaySnapshot(4, candidate), {
      accepted: false,
    });
  }

  assert.deepEqual(acceptDisplaySnapshot(5, valid), { accepted: false });
});
