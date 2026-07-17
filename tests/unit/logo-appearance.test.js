'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/logo-appearance.mjs');
}

function createPixels(alphaValues) {
  return Uint8ClampedArray.from(
    alphaValues.flatMap((alpha) => [0, 0, 0, alpha]),
  );
}

test('透明背景占樣本至少一成時使用亮白輪廓', async () => {
  const { classifyLogoAlpha, LOGO_TREATMENTS } = await loadModule();

  assert.equal(
    classifyLogoAlpha(createPixels([0, 255, 255, 255, 255, 255, 255, 255, 255, 255])),
    LOGO_TREATMENTS.BRIGHT_WHITE,
  );
  assert.equal(
    classifyLogoAlpha(createPixels([249, 255, 255, 255, 255, 255, 255, 255, 255, 255])),
    LOGO_TREATMENTS.BRIGHT_WHITE,
  );
});

test('JPG 或近乎不透明圖片使用亮白底襯，避免整張被濾成白塊', async () => {
  const { classifyLogoAlpha, LOGO_TREATMENTS } = await loadModule();

  assert.equal(
    classifyLogoAlpha(createPixels([255, 255, 255, 255])),
    LOGO_TREATMENTS.LIGHT_PLATE,
  );
  assert.equal(
    classifyLogoAlpha(createPixels([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255])),
    LOGO_TREATMENTS.LIGHT_PLATE,
  );
  assert.equal(classifyLogoAlpha(new Uint8ClampedArray()), LOGO_TREATMENTS.LIGHT_PLATE);
  assert.equal(classifyLogoAlpha(null), LOGO_TREATMENTS.LIGHT_PLATE);
});
