'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/render-resolution.mjs');
}

test('auto 使用目前 viewport 作為邏輯尺寸且不縮放', async () => {
  const { resolveRenderResolution } = await loadModule();

  const result = resolveRenderResolution({
    profile: 'auto',
    viewportWidth: 1536,
    viewportHeight: 864,
  });

  assert.deepEqual(result, {
    profile: 'auto',
    logicalWidth: 1536,
    logicalHeight: 864,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
  assert.equal(Object.isFrozen(result), true);
});

test('六種固定解析度皆建立相同尺寸的邏輯畫布', async () => {
  const { resolveRenderResolution } = await loadModule();
  const profiles = [
    ['1280x720', 1280, 720],
    ['1366x768', 1366, 768],
    ['1600x900', 1600, 900],
    ['1920x1080', 1920, 1080],
    ['2560x1440', 2560, 1440],
    ['3840x2160', 3840, 2160],
  ];

  for (const [profile, width, height] of profiles) {
    const result = resolveRenderResolution({
      profile,
      viewportWidth: width,
      viewportHeight: height,
    });

    assert.deepEqual(result, {
      profile,
      logicalWidth: width,
      logicalHeight: height,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    });
    assert.equal(Object.isFrozen(result), true);
  }
});

test('固定解析度以等比例 contain 置中，不裁切或拉伸', async () => {
  const { resolveRenderResolution } = await loadModule();

  const result = resolveRenderResolution({
    profile: '1920x1080',
    viewportWidth: 1600,
    viewportHeight: 1000,
  });

  assert.deepEqual(result, {
    profile: '1920x1080',
    logicalWidth: 1920,
    logicalHeight: 1080,
    scale: 5 / 6,
    offsetX: 0,
    offsetY: 50,
  });
  assert.equal(
    result.logicalWidth * result.scale + result.offsetX * 2,
    1600,
  );
  assert.equal(
    result.logicalHeight * result.scale + result.offsetY * 2,
    1000,
  );
});

test('拒絕未知 profile、非正整數 viewport 與額外型別', async () => {
  const { resolveRenderResolution } = await loadModule();
  const valid = {
    profile: 'auto',
    viewportWidth: 1920,
    viewportHeight: 1080,
  };
  const invalidCandidates = [
    null,
    {},
    { ...valid, profile: '1920×1080' },
    { ...valid, profile: '1024x768' },
    { ...valid, profile: null },
    { ...valid, viewportWidth: 0 },
    { ...valid, viewportWidth: -1 },
    { ...valid, viewportWidth: 1920.5 },
    { ...valid, viewportWidth: Number.POSITIVE_INFINITY },
    { ...valid, viewportHeight: 0 },
    { ...valid, viewportHeight: '1080' },
  ];

  for (const candidate of invalidCandidates) {
    assert.throws(
      () => resolveRenderResolution(candidate),
      { name: 'TypeError' },
      JSON.stringify(candidate),
    );
  }
});
