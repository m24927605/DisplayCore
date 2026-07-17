import { PROGRAM_LIMITS } from './program-builder.mjs';

const MESSAGE_KEYS = Object.freeze(['alignment', 'message']);
const MESSAGE_ALIGNMENTS = new Set(['left', 'center']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidMessage(item) {
  if (!isPlainObject(item)) {
    return false;
  }

  const keys = Object.keys(item).sort();
  return (
    keys.length === MESSAGE_KEYS.length &&
    keys.every((key, index) => key === MESSAGE_KEYS[index]) &&
    typeof item.message === 'string' &&
    item.message.length > 0 &&
    MESSAGE_ALIGNMENTS.has(item.alignment)
  );
}

/**
 * 將完整顯示清單投影成 Control 端獨立瀏覽的一頁。
 *
 * requestedPage 使用一為起點的頁碼；超出目前頁數時會自動縮回有效範圍。
 * 空清單沒有可瀏覽頁，因此頁數、頁碼及相鄰頁皆回傳零。
 */
export function paginateMessageList(messages, requestedPage) {
  if (!Array.isArray(messages) || !messages.every(isValidMessage)) {
    throw new TypeError('messages 必須是有效的完整訊息清單。');
  }

  if (!Number.isSafeInteger(requestedPage)) {
    throw new TypeError('requestedPage 必須是安全整數。');
  }

  const pageCount = Math.ceil(
    messages.length / PROGRAM_LIMITS.MESSAGES_PER_PAGE,
  );

  if (pageCount === 0) {
    return Object.freeze({
      pageCount: 0,
      pageNumber: 0,
      pageStart: 0,
      visibleMessages: Object.freeze([]),
      hasPreviousPage: false,
      hasNextPage: false,
      previousPageNumber: 0,
      nextPageNumber: 0,
    });
  }

  const pageNumber = Math.min(Math.max(requestedPage, 1), pageCount);
  const pageStart = (
    (pageNumber - 1) * PROGRAM_LIMITS.MESSAGES_PER_PAGE
  );
  const visibleMessages = messages
    .slice(pageStart, pageStart + PROGRAM_LIMITS.MESSAGES_PER_PAGE)
    .map(({ message, alignment }, index) => Object.freeze({
      message,
      alignment,
      globalIndex: pageStart + index,
    }));

  return Object.freeze({
    pageCount,
    pageNumber,
    pageStart,
    visibleMessages: Object.freeze(visibleMessages),
    hasPreviousPage: pageNumber > 1,
    hasNextPage: pageNumber < pageCount,
    previousPageNumber: Math.max(1, pageNumber - 1),
    nextPageNumber: Math.min(pageCount, pageNumber + 1),
  });
}
