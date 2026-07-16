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

test('響應式字級邊界會在三行空間不足時安全下修設定最小值', async () => {
  const { calculateResponsiveFontBounds } = await loadTextFit();
  const bounds = calculateResponsiveFontBounds({
    availableWidth: 1200,
    smallestRowHeight: 92,
    rootFontSize: 16,
    minimumFontSizeRem: 12,
    lineHeight: 1.08,
  });

  assert.equal(bounds.configuredMinimumFontSize, 192);
  assert.ok(bounds.minimumFontSize < bounds.configuredMinimumFontSize);
  assert.ok(bounds.minimumFontSize <= 92 / 1.08);
  assert.ok(bounds.maximumFontSize >= bounds.minimumFontSize);
  assert.equal(bounds.minimumWasClamped, true);
});

test('響應式字級邊界在空間足夠時保留設定最小值與 viewport 上限', async () => {
  const { calculateResponsiveFontBounds } = await loadTextFit();
  const bounds = calculateResponsiveFontBounds({
    availableWidth: 1920,
    smallestRowHeight: 800,
    rootFontSize: 16,
    minimumFontSizeRem: 3,
    lineHeight: 1.08,
  });

  assert.deepEqual(bounds, {
    configuredMinimumFontSize: 48,
    minimumFontSize: 48,
    maximumFontSize: 1920 * 0.24,
    minimumWasClamped: false,
  });
});

test('響應式字級邊界拒絕零尺寸、非法 rem 與 line-height', async () => {
  const { calculateResponsiveFontBounds } = await loadTextFit();
  const valid = {
    availableWidth: 1920,
    smallestRowHeight: 200,
    rootFontSize: 16,
    minimumFontSizeRem: 2.5,
    lineHeight: 1.08,
  };

  for (const partial of [
    { availableWidth: 0 },
    { smallestRowHeight: 0 },
    { rootFontSize: 0 },
    { minimumFontSizeRem: 0 },
    { lineHeight: 0 },
  ]) {
    assert.throws(
      () => calculateResponsiveFontBounds({ ...valid, ...partial }),
      { name: 'TypeError', message: '響應式字級邊界參數不正確。' },
    );
  }
});

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
