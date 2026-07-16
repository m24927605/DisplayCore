'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PresentationStore } = require('../../ipc/presentation-store');

function createProgram(messageCount, repeat = { mode: 'finite', rounds: 2 }) {
  return {
    messages: Array.from({ length: messageCount }, (_value, index) => ({
      message: `訊息${index + 1}`,
    })),
    pageDurationSeconds: 3,
    repeat,
  };
}

function expectedBlank(revision) {
  return {
    mode: 'blank',
    messages: [],
    layout: 'single-line',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision,
  };
}

test('PresentationStore 以空白 snapshot 與 revision 0 啟動', () => {
  const store = new PresentationStore();

  assert.deepEqual(store.getSnapshot(), expectedBlank(0));
  assert.equal(store.shouldScheduleNextPage(), false);
});

test('四則訊息依三則上限完成兩頁兩輪，最後一頁完整停留後才清空', () => {
  const store = new PresentationStore();
  const page1Round1 = store.startProgram(createProgram(4));
  const page2Round1 = store.advanceProgram();
  const page1Round2 = store.advanceProgram();
  const page2Round2 = store.advanceProgram();
  const completed = store.advanceProgram();

  assert.deepEqual(page1Round1, {
    mode: 'page',
    messages: [
      { message: '訊息1' },
      { message: '訊息2' },
      { message: '訊息3' },
    ],
    layout: 'single-line',
    pageDurationSeconds: 3,
    pageNumber: 1,
    pageCount: 2,
    roundNumber: 1,
    totalRounds: 2,
    revision: 1,
  });
  assert.equal(page2Round1.pageNumber, 2);
  assert.equal(page2Round1.roundNumber, 1);
  assert.deepEqual(page2Round1.messages, [{ message: '訊息4' }]);
  assert.equal(page1Round2.pageNumber, 1);
  assert.equal(page1Round2.roundNumber, 2);
  assert.equal(page2Round2.pageNumber, 2);
  assert.equal(page2Round2.roundNumber, 2);
  assert.deepEqual(completed, expectedBlank(5));
  assert.equal(store.shouldScheduleNextPage(), false);
});

test('持續模式最後一頁回到第一頁，單頁持續模式不建立無意義 transition', () => {
  const multiPageStore = new PresentationStore();
  multiPageStore.startProgram(createProgram(4, { mode: 'continuous' }));
  const secondPage = multiPageStore.advanceProgram();
  const firstPageAgain = multiPageStore.advanceProgram();

  assert.equal(secondPage.pageNumber, 2);
  assert.equal(secondPage.roundNumber, null);
  assert.equal(secondPage.totalRounds, null);
  assert.equal(firstPageAgain.pageNumber, 1);
  assert.equal(firstPageAgain.revision, 3);
  assert.equal(multiPageStore.shouldScheduleNextPage(), true);

  const singlePageStore = new PresentationStore();
  singlePageStore.startProgram(createProgram(1, { mode: 'continuous' }));
  assert.equal(singlePageStore.shouldScheduleNextPage(), false);
});

test('555／888 是 sticky 滿屏狀態，既不是 clear 也不能被舊翻頁推進', () => {
  const store = new PresentationStore();
  store.startProgram(createProgram(6));
  const inspection = store.showEmergency('555');
  const staleAdvance = store.advanceProgram();
  const release = store.showEmergency('888');

  assert.deepEqual(inspection, {
    mode: 'emergency',
    messages: [{ message: '555' }],
    layout: 'fill-screen',
    pageDurationSeconds: null,
    pageNumber: null,
    pageCount: null,
    roundNumber: null,
    totalRounds: null,
    revision: 2,
  });
  assert.deepEqual(staleAdvance, inspection);
  assert.equal(release.messages[0].message, '888');
  assert.equal(release.mode, 'emergency');
  assert.equal(release.revision, 3);
  assert.equal(store.shouldScheduleNextPage(), false);
});

test('snapshot 與輸入 program 都使用深層副本，Renderer 無法反向改 Main 狀態', () => {
  const store = new PresentationStore();
  const program = createProgram(2);
  const first = store.startProgram(program);

  program.messages[0].message = '輸入被修改';
  first.messages[0].message = 'snapshot 被修改';

  assert.equal(store.getSnapshot().messages[0].message, '訊息1');
});

test('Control 取得完整 active 內容，翻頁不改 contentRevision，內容替換才遞增', () => {
  const store = new PresentationStore();
  const firstDisplayPage = store.startProgram(
    createProgram(4, { mode: 'finite', rounds: 1 }),
  );
  const firstControlPage = store.getControlSnapshot();

  assert.equal(Object.hasOwn(firstDisplayPage, 'contentRevision'), false);
  assert.deepEqual(firstDisplayPage.messages, [
    { message: '訊息1' },
    { message: '訊息2' },
    { message: '訊息3' },
  ]);
  assert.deepEqual(firstControlPage.messages, [
    { message: '訊息1' },
    { message: '訊息2' },
    { message: '訊息3' },
    { message: '訊息4' },
  ]);
  assert.equal(firstControlPage.contentRevision, 1);

  store.advanceProgram();
  const secondControlPage = store.getControlSnapshot();
  assert.equal(secondControlPage.pageNumber, 2);
  assert.equal(secondControlPage.revision, 2);
  assert.equal(secondControlPage.contentRevision, 1);
  assert.equal(secondControlPage.messages.length, 4);

  store.advanceProgram();
  assert.equal(store.getControlSnapshot().mode, 'blank');
  assert.equal(store.getControlSnapshot().contentRevision, 2);

  store.showEmergency('555');
  assert.equal(store.getControlSnapshot().contentRevision, 3);
  store.clearPresentation();
  assert.equal(store.getControlSnapshot().contentRevision, 4);
});
