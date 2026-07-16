'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PresentationStore } = require('../../ipc/presentation-store');

test('PresentationStore 以空白單行 message 與 revision 0 啟動', () => {
  const store = new PresentationStore();

  assert.deepEqual(store.getSnapshot(), {
    message: '',
    layout: 'single-line',
    revision: 0,
  });
});

test('顯示與清除只保存單一 message 並遞增 revision', () => {
  const store = new PresentationStore();
  const shown = store.showMessage({
    message: 'Nancy前廳000',
    layout: 'single-line',
  });
  const cleared = store.clearMessage();

  assert.deepEqual(shown, {
    message: 'Nancy前廳000',
    layout: 'single-line',
    revision: 1,
  });
  assert.deepEqual(cleared, {
    message: '',
    layout: 'single-line',
    revision: 2,
  });
});

test('取得的 snapshot 是副本，Renderer 無法反向修改 Main 狀態', () => {
  const store = new PresentationStore();
  const first = store.showMessage({
    message: '888',
    layout: 'fill-screen',
  });

  first.message = '被修改';
  first.revision = 99;

  assert.deepEqual(store.getSnapshot(), {
    message: '888',
    layout: 'fill-screen',
    revision: 1,
  });
});
