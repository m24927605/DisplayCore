'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(
    __dirname,
    '..',
    '..',
    'control',
    'message-list-pagination.mjs',
  ),
).toString();

async function loadPagination() {
  return import(moduleUrl);
}

function createMessages(count) {
  return Array.from({ length: count }, (_value, index) => ({
    message: `訊息${index + 1}`,
  }));
}

test('七則訊息固定分成三頁，並保留每則訊息的全域索引', async () => {
  const { paginateMessageList } = await loadPagination();
  const messages = createMessages(7);
  const page = paginateMessageList(messages, 2);

  assert.deepEqual(page, {
    pageCount: 3,
    pageNumber: 2,
    pageStart: 3,
    visibleMessages: [
      { message: '訊息4', globalIndex: 3 },
      { message: '訊息5', globalIndex: 4 },
      { message: '訊息6', globalIndex: 5 },
    ],
    hasPreviousPage: true,
    hasNextPage: true,
    previousPageNumber: 1,
    nextPageNumber: 3,
  });
  assert.equal(messages.length, 7);
  assert.equal(messages[3].message, '訊息4');
});

test('刪除第三頁唯一訊息後，要求第三頁會安全縮回第二頁', async () => {
  const { paginateMessageList } = await loadPagination();
  const page = paginateMessageList(createMessages(6), 3);

  assert.deepEqual(page, {
    pageCount: 2,
    pageNumber: 2,
    pageStart: 3,
    visibleMessages: [
      { message: '訊息4', globalIndex: 3 },
      { message: '訊息5', globalIndex: 4 },
      { message: '訊息6', globalIndex: 5 },
    ],
    hasPreviousPage: true,
    hasNextPage: false,
    previousPageNumber: 1,
    nextPageNumber: 2,
  });
});

test('超出範圍的頁碼會 clamp，上一頁與下一頁永遠維持安全範圍', async () => {
  const { paginateMessageList } = await loadPagination();

  assert.deepEqual(
    paginateMessageList(createMessages(7), -20),
    {
      pageCount: 3,
      pageNumber: 1,
      pageStart: 0,
      visibleMessages: [
        { message: '訊息1', globalIndex: 0 },
        { message: '訊息2', globalIndex: 1 },
        { message: '訊息3', globalIndex: 2 },
      ],
      hasPreviousPage: false,
      hasNextPage: true,
      previousPageNumber: 1,
      nextPageNumber: 2,
    },
  );
  assert.equal(paginateMessageList(createMessages(7), 999).pageNumber, 3);
  assert.equal(paginateMessageList(createMessages(7), 999).nextPageNumber, 3);
});

test('空清單回傳零頁、零頁碼及空的不可變頁面', async () => {
  const { paginateMessageList } = await loadPagination();
  const page = paginateMessageList([], 8);

  assert.deepEqual(page, {
    pageCount: 0,
    pageNumber: 0,
    pageStart: 0,
    visibleMessages: [],
    hasPreviousPage: false,
    hasNextPage: false,
    previousPageNumber: 0,
    nextPageNumber: 0,
  });
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.visibleMessages), true);
});

test('頁面結果、可見清單與每則訊息皆為不可變副本', async () => {
  const { paginateMessageList } = await loadPagination();
  const messages = createMessages(4);
  const page = paginateMessageList(messages, 1);

  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.visibleMessages), true);
  assert.equal(page.visibleMessages.every(Object.isFrozen), true);
  assert.notEqual(page.visibleMessages[0], messages[0]);

  messages[0].message = '外部改寫';
  assert.equal(page.visibleMessages[0].message, '訊息1');
});

test('拒絕非清單、畸形訊息與非安全整數頁碼', async () => {
  const { paginateMessageList } = await loadPagination();

  for (const messages of [
    null,
    '訊息',
    [{}],
    [{ message: '' }],
    [{ message: '訊息', extra: true }],
  ]) {
    assert.throws(
      () => paginateMessageList(messages, 1),
      /messages/,
    );
  }

  for (const pageNumber of ['1', 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => paginateMessageList(createMessages(1), pageNumber),
      /requestedPage/,
    );
  }
});
