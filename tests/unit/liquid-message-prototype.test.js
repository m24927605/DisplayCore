'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(path.resolve(
  __dirname,
  '..',
  'fixtures',
  'liquid-message-prototype',
  'liquid-state.mjs',
));

async function loadLiquidStateModule() {
  return import(moduleUrl.href);
}

test('酒液原型固定提供 0、25、50、75、100 五個評審階段', async () => {
  const {
    LIQUID_PROTOTYPE_PROGRESS_STEPS,
    createLiquidVisualState,
  } = await loadLiquidStateModule();

  assert.deepEqual(LIQUID_PROTOTYPE_PROGRESS_STEPS, [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(Object.isFrozen(LIQUID_PROTOTYPE_PROGRESS_STEPS), true);

  const states = LIQUID_PROTOTYPE_PROGRESS_STEPS.map(
    (progress) => createLiquidVisualState(progress),
  );
  assert.deepEqual(
    states.map(({ fillPercent }) => fillPercent),
    [0, 25, 50, 75, 100],
  );
  assert.deepEqual(
    states.map(({ surfacePercent }) => surfacePercent),
    [100, 75, 50, 25, 0],
  );
  assert.equal(states.every(Object.isFrozen), true);
});

test('酒液使用固定酒紅漸層，容器外框在所有進度維持純白', async () => {
  const {
    LIQUID_PROTOTYPE_PROGRESS_STEPS,
    createLiquidVisualState,
  } = await loadLiquidStateModule();

  const states = LIQUID_PROTOTYPE_PROGRESS_STEPS.map(
    (progress) => createLiquidVisualState(progress),
  );

  assert.deepEqual(
    states.map(({ liquidColor }) => liquidColor),
    Array(5).fill('#B65B43'),
  );
  assert.equal(states.every(({ rimColor }) => rimColor === '#FFFFFF'), true);
  assert.equal(states.every(({ surfaceColor }) => surfaceColor === '#E0B06A'), true);
  assert.equal(
    states.every(({ deepColor }) => deepColor === '#5A0D25'),
    true,
  );
});

test('中段液面具有細微連續波紋，空杯與滿杯端點保持穩定', async () => {
  const { createLiquidVisualState } = await loadLiquidStateModule();

  for (const progress of [0.25, 0.5, 0.75]) {
    const state = createLiquidVisualState(progress);
    const yValues = state.surfacePoints.map(({ y }) => y);
    const spread = Math.max(...yValues) - Math.min(...yValues);

    assert.ok(state.surfacePoints.length >= 17);
    assert.equal(state.surfacePoints[0].x, 0);
    assert.equal(state.surfacePoints.at(-1).x, 100);
    assert.ok(spread >= 1, `進度 ${progress} 的液面不可退化成平直 wipe。`);
    assert.ok(spread <= 4, `進度 ${progress} 的液面波幅不可像遊戲大浪。`);
    assert.ok(
      yValues.every((y) => Math.abs(y - state.surfacePercent) <= 2.1),
      `進度 ${progress} 的液面必須維持在目標高度附近。`,
    );
    assert.match(state.fillClipPath, /^polygon\(/);
    assert.match(state.surfaceClipPath, /^polygon\(/);
    assert.ok(state.surfaceOpacity >= 0.35 && state.surfaceOpacity <= 0.45);
  }

  const empty = createLiquidVisualState(0);
  const full = createLiquidVisualState(1);
  assert.equal(new Set(empty.surfacePoints.map(({ y }) => y)).size, 1);
  assert.equal(new Set(full.surfacePoints.map(({ y }) => y)).size, 1);
  assert.equal(empty.surfaceOpacity, 0);
  assert.equal(full.surfaceOpacity, 0);
});

test('酒液狀態拒絕無效進度，避免預覽與正式時間軸產生隱性跳值', async () => {
  const { createLiquidVisualState } = await loadLiquidStateModule();

  for (const progress of [-0.01, 1.01, Number.NaN, Infinity, '0.5', null]) {
    assert.throws(
      () => createLiquidVisualState(progress),
      /進度必須是 0 至 1 之間的有限數字/,
    );
  }
});
