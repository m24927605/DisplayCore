'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'display', 'text-fit.mjs'),
).toString();

async function loadTextFit() {
  return import(moduleUrl);
}

test('所有字級都容得下時直接使用 responsive 上限', async () => {
  const { findLargestFittingFontSize } = await loadTextFit();
  const result = findLargestFittingFontSize({
    minimumFontSize: 40,
    maximumFontSize: 240,
    precision: 0.25,
    fits: () => true,
  });

  assert.deepEqual(result, {
    fontSize: 240,
    fitsAtMinimum: true,
    iterations: 0,
  });
});

test('二分搜尋在固定迭代內找到不超出容器的最大字級', async () => {
  const { findLargestFittingFontSize } = await loadTextFit();
  const threshold = 93.375;
  const result = findLargestFittingFontSize({
    minimumFontSize: 40,
    maximumFontSize: 240,
    precision: 0.125,
    fits: (fontSize) => fontSize <= threshold,
  });

  assert.equal(result.fitsAtMinimum, true);
  assert.ok(result.fontSize <= threshold);
  assert.ok(threshold - result.fontSize <= 0.125);
  assert.ok(result.iterations > 0);
  assert.ok(result.iterations <= 16);
});

test('設定的最小字級仍放不下時回傳最小值並標記 overflow', async () => {
  const { findLargestFittingFontSize } = await loadTextFit();
  const measured = [];
  const result = findLargestFittingFontSize({
    minimumFontSize: 40,
    maximumFontSize: 240,
    precision: 0.25,
    fits(fontSize) {
      measured.push(fontSize);
      return false;
    },
  });

  assert.deepEqual(result, {
    fontSize: 40,
    fitsAtMinimum: false,
    iterations: 0,
  });
  assert.deepEqual(measured, [40]);
});

test('拒絕無效 bounds、precision 與 measure callback', async () => {
  const { findLargestFittingFontSize } = await loadTextFit();
  const valid = {
    minimumFontSize: 40,
    maximumFontSize: 240,
    precision: 0.25,
    fits: () => true,
  };

  for (const input of [
    { ...valid, minimumFontSize: 0 },
    { ...valid, maximumFontSize: 39 },
    { ...valid, precision: 0 },
    { ...valid, fits: null },
  ]) {
    assert.throws(
      () => findLargestFittingFontSize(input),
      { name: 'TypeError' },
    );
  }
});
