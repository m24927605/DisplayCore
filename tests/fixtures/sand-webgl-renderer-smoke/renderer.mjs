import {
  createSandWebglRenderer,
} from '/display/sand-webgl-renderer.mjs';

const TEST_WIDTH = 640;
const TEST_HEIGHT = 360;
const TEST_PROGRESS_VALUES = Object.freeze([0.25, 0.5, 0.75]);
const captureVisualQa = new URLSearchParams(window.location.search).has('capture');

window.__sandWebglSmoke = Object.freeze({ state: 'running' });

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** 建立完全離線、同時含亮暗與多種色相的來源圖片。 */
async function createColorTestImage() {
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = TEST_WIDTH;
  sourceCanvas.height = TEST_HEIGHT;
  const context = sourceCanvas.getContext('2d');
  assert(context, '無法建立來源圖片 Canvas2D context。');

  const gradient = context.createLinearGradient(0, 0, TEST_WIDTH, TEST_HEIGHT);
  gradient.addColorStop(0, '#ff3b30');
  gradient.addColorStop(0.34, '#ffcc00');
  gradient.addColorStop(0.67, '#34c759');
  gradient.addColorStop(1, '#0a84ff');
  context.fillStyle = gradient;
  context.fillRect(0, 0, TEST_WIDTH, TEST_HEIGHT);

  context.fillStyle = '#ffffff';
  context.fillRect(20, 20, 96, 48);
  context.fillStyle = '#af52de';
  context.beginPath();
  context.arc(240, 106, 48, 0, Math.PI * 2);
  context.fill();

  const image = new Image();
  image.src = sourceCanvas.toDataURL('image/png');
  await image.decode();
  return image;
}

/** 透明畫布上的窄色帶可把向右搬運的粒子與原位圖片完全分離。 */
async function createParticleTransportTestImage() {
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = TEST_WIDTH;
  sourceCanvas.height = TEST_HEIGHT;
  const context = sourceCanvas.getContext('2d');
  assert(context, '無法建立粒子搬運測試 Canvas2D context。');
  const sourceLeft = Math.floor(TEST_WIDTH * 0.54);
  const sourceWidth = Math.floor(TEST_WIDTH * 0.08);
  const gradient = context.createLinearGradient(0, 0, 0, TEST_HEIGHT);
  gradient.addColorStop(0, '#ffcc00');
  gradient.addColorStop(0.5, '#ff453a');
  gradient.addColorStop(1, '#64d2ff');
  context.fillStyle = gradient;
  context.fillRect(sourceLeft, 0, sourceWidth, TEST_HEIGHT);

  const image = new Image();
  image.src = sourceCanvas.toDataURL('image/png');
  await image.decode();
  return image;
}

function inspectCurrentFrame(gl, canvas, progress) {
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(
    0,
    0,
    canvas.width,
    canvas.height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  assert(
    gl.getError() === gl.NO_ERROR,
    `進度 ${progress} readPixels 發生 WebGL 錯誤。`,
  );

  let visiblePixelCount = 0;
  let coloredPixelCount = 0;
  let alphaTotal = 0;
  let colorTotal = 0;
  let translucentPixelCount = 0;
  let translucentAlphaTotal = 0;
  let translucentWeightedX = 0;
  const opaquePixelsByRow = new Uint32Array(canvas.height);
  const opaqueLeftByRow = new Uint32Array(canvas.height);
  const opaqueRightByRow = new Uint32Array(canvas.height);
  const quarterWidth = Math.floor(canvas.width / 4);

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    const color = red + green + blue;
    const pixelIndex = offset / 4;
    const x = pixelIndex % canvas.width;
    const y = Math.floor(pixelIndex / canvas.width);

    if (alpha > 0) {
      visiblePixelCount += 1;
      alphaTotal += alpha;
    }
    if (alpha > 0 && color > 0) {
      coloredPixelCount += 1;
      colorTotal += color;
    }
    if (alpha >= 8 && alpha < 240) {
      translucentPixelCount += 1;
      translucentAlphaTotal += alpha;
      translucentWeightedX += (x + 0.5) * alpha;
    }
    if (alpha >= 240) {
      opaquePixelsByRow[y] += 1;
      if (x < quarterWidth) {
        opaqueLeftByRow[y] += 1;
      } else if (x >= canvas.width - quarterWidth) {
        opaqueRightByRow[y] += 1;
      }
    }
  }

  assert(
    visiblePixelCount > 0 && alphaTotal > 0,
    `進度 ${progress} 沒有任何非零 alpha 像素。`,
  );
  assert(
    coloredPixelCount > 0 && colorTotal > 0,
    `進度 ${progress} 沒有任何非零彩色像素。`,
  );

  let opaqueMass = 0;
  let opaqueWeightedY = 0;
  let mixedRowCount = 0;
  let directionalLeadTotal = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    const opaque = opaquePixelsByRow[y];
    const coverage = opaque / canvas.width;
    opaqueMass += opaque;
    opaqueWeightedY += (y + 0.5) * opaque;
    if (coverage >= 0.08 && coverage <= 0.92) {
      mixedRowCount += 1;
      directionalLeadTotal += (
        opaqueRightByRow[y] - opaqueLeftByRow[y]
      ) / quarterWidth;
    }
  }

  return Object.freeze({
    progress,
    visiblePixelCount,
    coloredPixelCount,
    alphaTotal,
    colorTotal,
    translucentPixelCount,
    translucentCoverage: translucentPixelCount / (canvas.width * canvas.height),
    translucentCenterX: translucentAlphaTotal <= 0
      ? 0
      : translucentWeightedX / translucentAlphaTotal / canvas.width,
    opaqueCenterY: opaqueMass <= 0
      ? 0
      : opaqueWeightedY / opaqueMass / canvas.height,
    mixedRowRatio: mixedRowCount / canvas.height,
    directionalLead: mixedRowCount <= 0
      ? 0
      : directionalLeadTotal / mixedRowCount,
    ...(captureVisualQa ? { dataUrl: canvas.toDataURL('image/png') } : {}),
  });
}

/** 4K 會被 renderer 限制為 1080p 級像素量，因此直接量測完整最壞工作量。 */
function measureFullHdDrawTimes(renderer, gl, image) {
  assert(renderer.prepare({
    image,
    crop: {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: image.naturalWidth,
      sourceHeight: image.naturalHeight,
    },
    width: 1_920,
    height: 1_080,
    scrim: { red: 0, green: 0, blue: 0, alpha: 0.48 },
  }), 'WebGL2 renderer 無法準備 1920×1080 最壞工作量。');

  renderer.draw(0.5);
  gl.finish();
  return TEST_PROGRESS_VALUES.map((progress) => {
    const startedAt = performance.now();
    assert(renderer.draw(progress), `1080p 進度 ${progress} 繪製失敗。`);
    gl.finish();
    return Object.freeze({
      progress,
      elapsedMs: performance.now() - startedAt,
    });
  });
}

/** 驗證離開窄來源色帶的可見像素只出現在下風處，排除反向搬運。 */
function inspectParticleTransport(renderer, gl, image) {
  assert(renderer.prepare({
    image,
    crop: {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: image.naturalWidth,
      sourceHeight: image.naturalHeight,
    },
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    scrim: { red: 0, green: 0, blue: 0, alpha: 0 },
  }), 'WebGL2 renderer 無法準備透明粒子搬運測試圖。');
  assert(renderer.draw(0.5), '透明粒子搬運測試繪製失敗。');
  gl.finish();

  const pixels = new Uint8Array(TEST_WIDTH * TEST_HEIGHT * 4);
  gl.readPixels(
    0,
    0,
    TEST_WIDTH,
    TEST_HEIGHT,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
  let downwindPixelCount = 0;
  let downwindAlpha = 0;
  let downwindWeightedX = 0;
  let upwindPixelCount = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha <= 0) {
      continue;
    }
    const x = (offset / 4) % TEST_WIDTH;
    if (x >= TEST_WIDTH * 0.66) {
      downwindPixelCount += 1;
      downwindAlpha += alpha;
      downwindWeightedX += (x + 0.5) * alpha;
    } else if (x < TEST_WIDTH * 0.5) {
      upwindPixelCount += 1;
    }
  }

  return Object.freeze({
    downwindPixelCount,
    downwindCenterX: downwindAlpha <= 0
      ? 0
      : downwindWeightedX / downwindAlpha / TEST_WIDTH,
    upwindPixelCount,
  });
}

async function runSmokeWorkflow() {
  const canvas = document.getElementById('sand-canvas');
  assert(canvas instanceof HTMLCanvasElement, '缺少 WebGL 測試 Canvas。');

  const renderer = createSandWebglRenderer({
    canvas,
    random: () => 0.375,
  });
  assert(renderer !== null, 'WebGL2 renderer 建立失敗或 shader 編譯／連結失敗。');

  const gl = canvas.getContext('webgl2');
  assert(gl instanceof WebGL2RenderingContext, '未取得真實 WebGL2 context。');
  const image = await createColorTestImage();
  const prepared = renderer.prepare({
    image,
    crop: {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: image.naturalWidth,
      sourceHeight: image.naturalHeight,
    },
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    scrim: { red: 0, green: 0, blue: 0, alpha: 0 },
  });
  assert(prepared, 'WebGL2 renderer 無法上傳來源圖片。');

  const frames = TEST_PROGRESS_VALUES.map((progress) => {
    assert(renderer.draw(progress), `進度 ${progress} 繪製失敗。`);
    return inspectCurrentFrame(gl, canvas, progress);
  });
  const particleTransportImage = await createParticleTransportTestImage();
  const particleTransport = inspectParticleTransport(
    renderer,
    gl,
    particleTransportImage,
  );
  const fullHdDrawTimes = measureFullHdDrawTimes(renderer, gl, image);
  assert(
    renderer.releaseSourceTexture(),
    'WebGL2 renderer 無法釋放來源 texture。',
  );
  assert(
    renderer.draw(0.5) === false,
    '釋放來源 texture 後仍使用舊圖片繪製。',
  );
  assert(renderer.prepare({
    image,
    crop: {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: image.naturalWidth,
      sourceHeight: image.naturalHeight,
    },
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    scrim: { red: 0, green: 0, blue: 0, alpha: 0 },
  }), '釋放來源 texture 後無法重新準備 Renderer。');
  assert(
    renderer.draw(0.5),
    '釋放來源 texture 後無法重新上傳並繪製。',
  );

  renderer.dispose();
  assert(renderer.draw(0.5) === false, 'dispose 後仍可繼續繪製。');
  renderer.clear();
  renderer.dispose();
  assert(gl.getError() === gl.NO_ERROR, 'dispose 流程留下 WebGL 錯誤。');

  window.__sandWebglSmoke = Object.freeze({
    state: 'succeeded',
    rendererCreated: true,
    webglVersion: gl.getParameter(gl.VERSION),
    frames,
    particleTransport,
    fullHdDrawTimes,
    releasedAndReprepared: true,
    disposed: true,
  });
}

runSmokeWorkflow().catch((error) => {
  window.__sandWebglSmoke = Object.freeze({
    state: 'failed',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
  });
});
