const MAXIMUM_LIQUID_CODE_POINTS = 512;
const MAXIMUM_STYLED_RUNS = 128;

/**
 * 把一般訊息切成文字與 ASCII 數字段落。
 *
 * Display 不解讀訊息語意；這裡只標記連續 0～9，讓編號與代碼能使用獨立
 * Didot 字型，同時保留原始字序與完整 textContent。
 */
export function splitMessageTypographyRuns(message) {
  if (typeof message !== 'string') {
    throw new TypeError('訊息必須是字串。');
  }

  const runs = [];
  const numberPattern = /[0-9]+/g;
  let textStart = 0;
  let match;

  while ((match = numberPattern.exec(message)) !== null) {
    if (match.index > textStart) {
      runs.push(Object.freeze({
        kind: 'text',
        text: message.slice(textStart, match.index),
      }));
    }
    runs.push(Object.freeze({ kind: 'number', text: match[0] }));
    textStart = match.index + match[0].length;
  }

  if (textStart < message.length) {
    runs.push(Object.freeze({
      kind: 'text',
      text: message.slice(textStart),
    }));
  }

  return Object.freeze(runs);
}

/**
 * 為正式 Display 建立有上限的排版計畫。
 *
 * 一般訊息保留數字 Didot run；若合法輸入刻意交錯數字與文字數千次，則
 * 壓平成單一安全文字節點並停用裝飾性酒液。內容仍完整顯示／跑馬燈播放，
 * 但不會在 4K Renderer 建立數萬個 HTML 與 SVG text 節點。
 */
export function createMessageTypographyPlan(message) {
  const runs = splitMessageTypographyRuns(message);
  const codePointCount = [...message].length;
  const liquidCompatible =
    codePointCount <= MAXIMUM_LIQUID_CODE_POINTS &&
    runs.length > 0 &&
    runs.length <= MAXIMUM_STYLED_RUNS;
  const renderRuns = runs.length <= MAXIMUM_STYLED_RUNS
    ? runs
    : Object.freeze([
        Object.freeze({ kind: 'text', text: message }),
      ]);

  return Object.freeze({
    codePointCount,
    liquidCompatible,
    runs: renderRuns,
  });
}
