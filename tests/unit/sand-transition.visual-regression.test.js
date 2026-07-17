'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// Regression: ISSUE-001 — 真實畫面退化成水平圓孔 wipe，沙粒肉眼不可見。
// Found by /qa on 2026-07-18.
// Report: .gstack/qa-reports/qa-report-displaycore-2026-07-18.md

async function captureMiddleFrame() {
  const { createSandTransition } = await import('../../display/sand-transition.mjs');
  const pendingFrames = [];
  let capturedFrame = null;
  const engine = createSandTransition({
    requestFrame(callback) {
      const handle = { callback, canceled: false };
      pendingFrames.push(handle);
      return handle;
    },
    cancelFrame(handle) {
      handle.canceled = true;
    },
    onFrame(frame) {
      capturedFrame = frame;
    },
    random: () => 0.5,
    maxParticleCount: 1_600,
  });

  engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 });
  pendingFrames.shift().callback(1_000);
  pendingFrames.shift().callback(1_500);
  engine.dispose();
  return capturedFrame;
}

function rasterizeErosion(frame, width = 240, height = 135) {
  const pixels = new Uint8Array(width * height);

  if (frame.erosionMask) {
    const { width: maskWidth, height: maskHeight, pixels: rgba } =
      frame.erosionMask;
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(maskHeight - 1, Math.floor(y / height * maskHeight));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(maskWidth - 1, Math.floor(x / width * maskWidth));
        pixels[y * width + x] = rgba[(sourceY * maskWidth + sourceX) * 4 + 3];
      }
    }
    return pixels;
  }

  for (const patch of frame.erosionPatches ?? []) {
    const centerX = patch.x / frame.width * width;
    const centerY = patch.y / frame.height * height;
    const radiusX = patch.radius / frame.width * width;
    const radiusY = patch.radius / frame.height * height;
    const left = Math.max(0, Math.floor(centerX - radiusX));
    const right = Math.min(width - 1, Math.ceil(centerX + radiusX));
    const top = Math.max(0, Math.floor(centerY - radiusY));
    const bottom = Math.min(height - 1, Math.ceil(centerY + radiusY));

    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const normalizedX = (x - centerX) / Math.max(radiusX, 0.001);
        const normalizedY = (y - centerY) / Math.max(radiusY, 0.001);
        if (normalizedX ** 2 + normalizedY ** 2 <= 1) {
          pixels[y * width + x] = 255;
        }
      }
    }
  }

  return pixels;
}

test('中段必須有肉眼可見且明確向右飄移的圖片沙塵', async () => {
  const frame = await captureMiddleFrame();
  const weightedMass = frame.particles.reduce(
    (total, particle) => total + particle.opacity * particle.size ** 2,
    0,
  );
  const dustMassRatio = weightedMass / (frame.width * frame.height);
  const weightedRightDrift = frame.particles.reduce(
    (total, particle) => total +
      particle.opacity * particle.size ** 2 * (particle.x - particle.sourceX),
    0,
  ) / Math.max(weightedMass, Number.EPSILON) / frame.width;

  assert.ok(
    dustMassRatio >= 0.004,
    `沙塵有效覆蓋率不可低於 0.4%：${dustMassRatio}`,
  );
  assert.ok(
    weightedRightDrift >= 0.06,
    `沙粒加權向右位移不可低於畫面寬度 6%：${weightedRightDrift}`,
  );
});

test('中段侵蝕面必須有寬廣不規則的顆粒混合區，不能是水平硬邊', async () => {
  const frame = await captureMiddleFrame();
  const width = 240;
  const height = 135;
  const pixels = rasterizeErosion(frame, width, height);
  let mixedRows = 0;

  for (let y = 0; y < height; y += 1) {
    let erased = 0;
    for (let x = 0; x < width; x += 1) {
      erased += pixels[y * width + x] >= 128 ? 1 : 0;
    }
    const erasedRatio = erased / width;
    if (erasedRatio >= 0.1 && erasedRatio <= 0.9) {
      mixedRows += 1;
    }
  }

  const mixedBandRatio = mixedRows / height;
  assert.ok(
    mixedBandRatio >= 0.1,
    `10%～90% 顆粒混合區不可低於畫面高度 10%：${mixedBandRatio}`,
  );
});
