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

test('Control 只接受結構完整且 revision 未過期的 presentation', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const snapshot = {
    message: '001請至前廳',
    layout: 'single-line',
    revision: 3,
  };

  assert.deepEqual(acceptPresentationSnapshot(2, snapshot), {
    accepted: true,
    snapshot,
  });
  assert.deepEqual(
    acceptPresentationSnapshot(3, {
      message: '過期內容',
      layout: 'single-line',
      revision: 2,
    }),
    { accepted: false },
  );
});

test('相同 revision 可安全重放，避免 snapshot 與 event 競態誤判', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const snapshot = {
    message: '555',
    layout: 'fill-screen',
    revision: 5,
  };

  assert.deepEqual(acceptPresentationSnapshot(5, snapshot), {
    accepted: true,
    snapshot,
  });
});

test('Control 拒絕錯誤型別、未知 layout 與不安全 revision', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const invalidSnapshots = [
    null,
    [],
    { message: 1, layout: 'single-line', revision: 0 },
    { message: '', layout: 'unknown', revision: 0 },
    { message: '', layout: 'single-line', revision: -1 },
    { message: '', layout: 'single-line', revision: 1.5 },
    { message: '', layout: 'single-line', revision: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.deepEqual(acceptPresentationSnapshot(-1, snapshot), {
      accepted: false,
    });
  }
});

test('接受後建立獨立副本，不保留可被外部修改的物件', async () => {
  const { acceptPresentationSnapshot } = await loadPresentationState();
  const input = {
    message: 'Nancy前廳000',
    layout: 'single-line',
    revision: 8,
  };
  const result = acceptPresentationSnapshot(7, input);

  assert.equal(result.accepted, true);
  assert.notEqual(result.snapshot, input);

  input.message = '被修改';
  assert.equal(result.snapshot.message, 'Nancy前廳000');
});

