import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MODULE_URL = new URL('../../display/glyph-liquid-placement.mjs', import.meta.url);

function paintRectangle(alpha, width, left, top, right, bottom) {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      alpha[(y * width + x) * 4 + 3] = 255;
    }
  }
}

/**
 * 以粗筆畫合成「中」與拉丁 N；刻意保留字腔與字間空白，讓測試涵蓋
 * 中文、英文及沒有可行筆畫的候選位置。
 */
function createSyntheticGlyphAlpha() {
  const width = 320;
  const height = 128;
  const alpha = new Uint8ClampedArray(width * height * 4);

  // 「中」：外框、中央直畫。
  paintRectangle(alpha, width, 18, 18, 32, 110);
  paintRectangle(alpha, width, 92, 18, 106, 110);
  paintRectangle(alpha, width, 18, 18, 106, 32);
  paintRectangle(alpha, width, 18, 60, 106, 74);
  paintRectangle(alpha, width, 18, 96, 106, 110);
  paintRectangle(alpha, width, 55, 8, 69, 120);

  // Latin N：兩側直畫加上由左上至右下的粗斜畫。
  paintRectangle(alpha, width, 156, 18, 172, 110);
  paintRectangle(alpha, width, 238, 18, 254, 110);
  for (let y = 18; y < 110; y += 1) {
    const x = 164 + Math.round((y - 18) * 82 / 92);
    paintRectangle(alpha, width, x - 7, y, x + 8, y + 1);
  }

  return { alpha, height, width };
}

function ringCoverage({ alpha, height, width }, bubble, {
  dpr,
  windowStart,
  windowTop,
}) {
  const sampleCount = 96;
  let covered = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = index / sampleCount * Math.PI * 2;
    const logicalX = bubble.x + Math.cos(angle) * bubble.radius;
    const logicalY = bubble.y + Math.sin(angle) * bubble.radius;
    const pixelX = Math.floor((logicalX - windowStart) * dpr);
    const pixelY = Math.floor((logicalY - windowTop) * dpr);
    if (
      pixelX >= 0 && pixelX < width &&
      pixelY >= 0 && pixelY < height &&
      alpha[(pixelY * width + pixelX) * 4 + 3] > 0
    ) {
      covered += 1;
    }
  }
  return covered / sampleCount;
}

test('cached glyph row runs 以最小位移把有限氣泡放進中文與拉丁筆畫', async () => {
  const {
    createGlyphAlphaRowRuns,
    placeBubblesInGlyphMask,
  } = await import(MODULE_URL);
  const pixels = createSyntheticGlyphAlpha();
  const coordinates = Object.freeze({
    dpr: 2,
    windowStart: 120,
    windowTop: 24,
  });
  const mask = createGlyphAlphaRowRuns({
    ...pixels,
    ...coordinates,
  });
  const bubbles = Object.freeze([
    Object.freeze({ id: 'zh-left', bornAt: 0.1, lifetime: 1.2, opacity: 0.61, radius: 4, x: 132, y: 53 }),
    Object.freeze({ id: 'zh-middle', bornAt: 0.2, lifetime: 1.3, opacity: 0.54, radius: 4, x: 150, y: 49 }),
    Object.freeze({ id: 'zh-right', bornAt: 0.3, lifetime: 1.4, opacity: 0.48, radius: 4, x: 172, y: 60 }),
    Object.freeze({ id: 'zh-cross', bornAt: 0.4, lifetime: 1.5, opacity: 0.43, radius: 4, x: 160, y: 58 }),
    Object.freeze({ id: 'latin-left', bornAt: 0.5, lifetime: 1.6, opacity: 0.39, radius: 4, x: 201, y: 60 }),
    Object.freeze({ id: 'latin-diagonal', bornAt: 0.6, lifetime: 1.7, opacity: 0.35, radius: 4, x: 224, y: 59 }),
    Object.freeze({ id: 'latin-right', bornAt: 0.7, lifetime: 1.8, opacity: 0.31, radius: 4, x: 246, y: 66 }),
    Object.freeze({ id: 'near-zh', bornAt: 0.8, lifetime: 1.9, opacity: 0.29, radius: 4, x: 178, y: 76 }),
    Object.freeze({ id: 'near-latin', bornAt: 0.9, lifetime: 2, opacity: 0.27, radius: 4, x: 230, y: 85 }),
    Object.freeze({ id: 'impossible', bornAt: 1, lifetime: 2.1, opacity: 0.25, radius: 4, x: 315, y: 84 }),
  ]);
  const snapshot = structuredClone(bubbles);

  const first = placeBubblesInGlyphMask({ bubbles, mask });
  const second = placeBubblesInGlyphMask({ bubbles, mask });

  assert.deepEqual(first, second, '相同模型與 mask 必須產生完全相同的座標');
  assert.deepEqual(bubbles, snapshot, '不得修改模型輸入的氣泡');
  assert.ok(
    first.length >= Math.ceil(bubbles.length * 0.6),
    `合成中文／拉丁筆畫至少要保留 60% 候選，實際 ${first.length}/${bubbles.length}`,
  );
  assert.equal(first.some(({ id }) => id === 'impossible'), false);

  const inputById = new Map(bubbles.map((bubble) => [bubble.id, bubble]));
  const coverages = first.map((bubble) => {
    const input = inputById.get(bubble.id);
    assert.ok(input, '不得新增模型不存在的氣泡');
    assert.equal(bubble.id, input.id);
    assert.equal(bubble.bornAt, input.bornAt, '不得重設出生時間');
    assert.equal(bubble.lifetime, input.lifetime, '不得重設生命週期');
    assert.equal(bubble.radius, input.radius, '不得改變半徑');
    assert.equal(bubble.opacity, input.opacity, '不得改變透明度');
    return ringCoverage(pixels, bubble, coordinates);
  });

  for (const coverage of coverages) {
    assert.ok(
      coverage >= 0.25,
      `每個保留氣泡至少 25% 圓環需落在 glyph alpha，實際 ${coverage}`,
    );
  }
  const aggregateCoverage = coverages.reduce((sum, value) => sum + value, 0) /
    coverages.length;
  assert.ok(
    aggregateCoverage >= 0.45,
    `全部保留氣泡的圓環覆蓋率至少 45%，實際 ${aggregateCoverage}`,
  );
});

test('alpha 只在 sync 階段解析；placement 重用 row runs 並支援 DPR/windowStart', async () => {
  const {
    createGlyphAlphaRowRuns,
    placeBubblesInGlyphMask,
  } = await import(MODULE_URL);
  const pixels = createSyntheticGlyphAlpha();
  const mask = createGlyphAlphaRowRuns({
    ...pixels,
    dpr: 2,
    windowStart: 900,
    windowTop: 40,
  });
  pixels.alpha.fill(0);

  const placed = placeBubblesInGlyphMask({
    bubbles: [{ id: 'cached', opacity: 0.5, radius: 4, x: 928, y: 72 }],
    mask,
  });

  assert.equal(placed.length, 1, '原始 alpha 清空後仍應使用已解析的 cached runs');
  assert.ok(placed[0].x >= 900, '輸出 x 必須保留 windowStart 的全域邏輯座標');
  assert.ok(placed[0].y >= 40, '輸出 y 必須保留 windowTop 的全域邏輯座標');
});

test('無可行筆畫時捨棄氣泡，純模組不得依賴 DOM', async () => {
  const {
    createGlyphAlphaRowRuns,
    placeBubblesInGlyphMask,
  } = await import(MODULE_URL);
  const width = 80;
  const height = 40;
  const mask = createGlyphAlphaRowRuns({
    alpha: new Uint8ClampedArray(width * height),
    width,
    height,
    dpr: 1,
    windowStart: 0,
  });

  assert.deepEqual(placeBubblesInGlyphMask({
    bubbles: [{ id: 'none', opacity: 0.5, radius: 3, x: 20, y: 20 }],
    mask,
  }), []);

  const source = await readFile(MODULE_URL, 'utf8');
  assert.doesNotMatch(source, /\b(?:document|window|HTMLElement|CanvasRenderingContext2D)\b/);
});
