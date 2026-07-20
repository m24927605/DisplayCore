'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.resolve(
  __dirname,
  '..',
  '..',
  'display',
  'message-liquid-canvas-style.mjs',
)).href;

function createFrame(overrides = {}) {
  return {
    refractionLayers: [
      { offsetX: 32, offsetY: -4, opacity: 0.42, rotation: 3.5 },
      { offsetX: -18, offsetY: 7, opacity: 0.27, rotation: -5.25 },
    ],
    refractionOffset: 0.036,
    ...overrides,
  };
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      assertDeepFrozen(child);
    }
  }
}

test('Canvas 酒液線條依字腔高度縮放，液面與氣泡仍維持細緻上限', async () => {
  const { resolveMessageLiquidCanvasStyle } = await import(moduleUrl);
  const style = resolveMessageLiquidCanvasStyle({ width: 1_200, height: 240 });

  assert.ok(style.meniscusDepthWidth > style.meniscusCoreWidth);
  assert.ok(style.meniscusDepthWidth <= 240 * 0.012);
  assert.ok(style.meniscusCoreWidth <= 240 * 0.007);
  assert.ok(style.bubbleBodyWidth > style.bubbleHighlightWidth);
  assert.ok(style.bubbleBodyWidth > 0 && style.bubbleBodyWidth <= 240 * 0.006);
  assert.ok(
    style.bubbleHighlightWidth > 0 &&
    style.bubbleHighlightWidth <= 240 * 0.004,
  );
  for (const alphaName of [
    'meniscusDepthAlpha',
    'meniscusCoreAlpha',
    'bubbleBodyAlpha',
    'bubbleHighlightAlpha',
  ]) {
    assert.ok(style[alphaName] > 0 && style[alphaName] <= 1);
  }

  const doubleSize = resolveMessageLiquidCanvasStyle({
    width: 2_400,
    height: 480,
  });
  assert.equal(doubleSize.meniscusDepthWidth, style.meniscusDepthWidth * 2);
  assert.equal(doubleSize.meniscusCoreWidth, style.meniscusCoreWidth * 2);
  assert.equal(doubleSize.bubbleBodyWidth, style.bubbleBodyWidth * 2);
  assert.equal(doubleSize.bubbleHighlightWidth, style.bubbleHighlightWidth * 2);
  assert.deepEqual(
    resolveMessageLiquidCanvasStyle({ width: 1_200, height: 240 }),
    style,
  );
  assertDeepFrozen(style);
});

test('兩條折射帶很窄且總 support 受限，不會把酒體洗成廉價粉色', async () => {
  const { resolveMessageLiquidRefractionBands } = await import(moduleUrl);
  const bands = resolveMessageLiquidRefractionBands({
    width: 1_200,
    height: 240,
    frame: createFrame(),
  });

  assert.equal(bands.length, 2);
  assert.ok(bands.every(({ supportRatio }) => supportRatio > 0));
  assert.ok(bands.every(({ supportRatio }) => supportRatio <= 0.18));
  assert.ok(
    bands.reduce((total, { supportRatio }) => total + supportRatio, 0) <= 0.22,
  );

  for (const band of bands) {
    assert.equal(band.geometry.length, 4);
    assert.equal(band.geometry.every(Number.isFinite), true);
    assert.ok(band.alpha >= 0 && band.alpha <= 1);
    assert.ok(band.stops.length >= 5);
    assert.equal(band.stops[0].offset, 0);
    assert.equal(band.stops.at(-1).offset, 1);
    assert.equal(band.stops.every((stop, index, stops) =>
      index === 0 || stop.offset >= stops[index - 1].offset), true);
    assert.equal(band.stops.every(({ alpha }) => alpha >= 0 && alpha <= 1), true);
    const litStops = band.stops.filter(({ alpha }) => alpha > 0);
    assert.ok(litStops.at(-1).offset - litStops[0].offset <= band.supportRatio);
  }
  assertDeepFrozen(bands);
});

test('折射位置、轉角與透明度只跟隨當幀流場，不是固定貼圖', async () => {
  const { resolveMessageLiquidRefractionBands } = await import(moduleUrl);
  const still = resolveMessageLiquidRefractionBands({
    width: 1_200,
    height: 240,
    frame: createFrame({
      refractionLayers: [
        { offsetX: 0, offsetY: 0, opacity: 0.16, rotation: 0 },
        { offsetX: 0, offsetY: 0, opacity: 0.12, rotation: 0 },
      ],
      refractionOffset: 0,
    }),
  });
  const moving = resolveMessageLiquidRefractionBands({
    width: 1_200,
    height: 240,
    frame: createFrame(),
  });
  const reverse = resolveMessageLiquidRefractionBands({
    width: 1_200,
    height: 240,
    frame: createFrame({
      refractionLayers: [
        { offsetX: -32, offsetY: 4, opacity: 0.31, rotation: -3.5 },
        { offsetX: 18, offsetY: -7, opacity: 0.19, rotation: 5.25 },
      ],
      refractionOffset: -0.036,
    }),
  });

  assert.notDeepEqual(moving.map(({ geometry }) => geometry),
    still.map(({ geometry }) => geometry));
  assert.notDeepEqual(moving.map(({ rotationDegrees }) => rotationDegrees),
    still.map(({ rotationDegrees }) => rotationDegrees));
  assert.notDeepEqual(reverse.map(({ geometry }) => geometry),
    moving.map(({ geometry }) => geometry));
  assert.notDeepEqual(reverse.map(({ rotationDegrees }) => rotationDegrees),
    moving.map(({ rotationDegrees }) => rotationDegrees));
  assert.notDeepEqual(moving.map(({ alpha }) => alpha),
    reverse.map(({ alpha }) => alpha));
  assert.deepEqual(
    resolveMessageLiquidRefractionBands({
      width: 1_200,
      height: 240,
      frame: createFrame(),
    }),
    moving,
  );
});

test('純樣式函式拒絕無效尺寸與不完整折射影格', async () => {
  const {
    resolveMessageLiquidCanvasStyle,
    resolveMessageLiquidRefractionBands,
  } = await import(moduleUrl);

  for (const options of [
    undefined,
    null,
    {},
    { width: 0, height: 240 },
    { width: 1_200, height: -1 },
    { width: Number.POSITIVE_INFINITY, height: 240 },
    { width: '1200', height: 240 },
  ]) {
    assert.throws(() => resolveMessageLiquidCanvasStyle(options), TypeError);
  }

  for (const frame of [
    undefined,
    {},
    { refractionLayers: [], refractionOffset: 0 },
    {
      refractionLayers: [
        { offsetX: 0, offsetY: 0, opacity: 0.2, rotation: 0 },
        { offsetX: 0, offsetY: 0, opacity: 0.2, rotation: Number.NaN },
      ],
      refractionOffset: 0,
    },
    createFrame({ refractionOffset: Number.NaN }),
  ]) {
    assert.throws(() => resolveMessageLiquidRefractionBands({
      width: 1_200,
      height: 240,
      frame,
    }), TypeError);
  }
});
