'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// Regression: ISSUE-001 — 真實畫面退化成水平圓孔 wipe，沙粒肉眼不可見。
// Found by /qa on 2026-07-18.
// Report: .gstack/qa-reports/qa-report-displaycore-2026-07-18.md

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

async function captureFrame(progress = 0.5, seed = null) {
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
    random: seed === null ? () => 0.5 : createSeededRandom(seed),
    maxParticleCount: 7_200,
  });

  engine.start({ width: 1_920, height: 1_080, durationMs: 1_000 });
  pendingFrames.shift().callback(1_000);
  pendingFrames.shift().callback(1_000 + progress * 1_000);
  engine.dispose();
  return capturedFrame;
}

const captureMiddleFrame = () => captureFrame(0.5);

function particleVisibleMass(particle, frame) {
  const left = Math.max(0, particle.x - particle.width / 2);
  const right = Math.min(frame.width, particle.x + particle.width / 2);
  const top = Math.max(0, particle.y - particle.height / 2);
  const bottom = Math.min(frame.height, particle.y + particle.height / 2);
  return particle.opacity *
    Math.max(0, right - left) *
    Math.max(0, bottom - top);
}

function isAirborneSand(particle) {
  return particle.fragmentStrength <= 0.25;
}

function weightedMean(values, getValue, getWeight) {
  const totalWeight = values.reduce(
    (total, value) => total + getWeight(value),
    0,
  );
  return values.reduce(
    (total, value) => total + getValue(value) * getWeight(value),
    0,
  ) / Math.max(totalWeight, Number.EPSILON);
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
    (total, particle) => total + particleVisibleMass(particle, frame),
    0,
  );
  const dustMassRatio = weightedMass / (frame.width * frame.height);
  const driftingParticles = frame.particles.filter(isAirborneSand);
  const driftingMass = driftingParticles.reduce(
    (total, particle) => total + particleVisibleMass(particle, frame),
    0,
  );
  const weightedRightDrift = driftingParticles.reduce(
    (total, particle) => total +
      particleVisibleMass(particle, frame) * (particle.x - particle.sourceX),
    0,
  ) / Math.max(driftingMass, Number.EPSILON) / frame.width;

  assert.ok(
    dustMassRatio >= 0.0015,
    `主粒本體有效覆蓋率不可低於 0.15%，另由初生碎片微粒補足密度：${dustMassRatio}`,
  );
  assert.ok(
    weightedRightDrift >= 0.06,
    `沙粒加權向右位移不可低於畫面寬度 6%：${weightedRightDrift}`,
  );
});

test('左至右風團必須打散全寬水平接縫，不能退化成由下往上的 wipe', async () => {
  const frames = await Promise.all(
    [0.35, 0.5, 0.65].map((progress) =>
      captureFrame(progress, 20_260_718)),
  );
  const width = 240;
  const height = 135;
  const mixedBandRatios = frames.map((frame) => {
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

    return mixedRows / height;
  });
  const averageMixedRegion = mixedBandRatios.reduce(
    (total, ratio) => total + ratio,
    0,
  ) / mixedBandRatios.length;

  assert.ok(
    mixedBandRatios.every((ratio) => ratio >= 0.22 && ratio <= 0.48) &&
      averageMixedRegion >= 0.25 && averageMixedRegion <= 0.44,
    `左清右留的風團過渡區必須佔畫面高度 25%～44%，避免全寬水平線：${JSON.stringify({
      mixedBandRatios,
      averageMixedRegion,
    })}`,
  );
});

test('風頭內部必須多孔碎裂，但允許左右兩端保留符合風向的連續區', async () => {
  const frame = await captureFrame(0.5, 20_260_718);
  const { width, height, pixels } = frame.erosionMask;
  const longestInteriorRunRatios = [];
  const transitionCounts = [];

  for (let y = 0; y < height; y += 1) {
    let erasedCount = 0;
    for (let x = 0; x < width; x += 1) {
      erasedCount += pixels[(y * width + x) * 4 + 3] >= 128 ? 1 : 0;
    }
    const erasedRatio = erasedCount / width;
    if (erasedRatio < 0.1 || erasedRatio > 0.9) {
      continue;
    }

    let previousState = pixels[y * width * 4 + 3] >= 128;
    let runLength = 1;
    const runs = [];
    for (let x = 1; x < width; x += 1) {
      const state = pixels[(y * width + x) * 4 + 3] >= 128;
      if (state === previousState) {
        runLength += 1;
      } else {
        runs.push(runLength);
        runLength = 1;
        previousState = state;
      }
    }
    runs.push(runLength);
    const interiorRuns = runs.slice(1, -1);
    longestInteriorRunRatios.push(
      Math.max(0, ...interiorRuns) / width,
    );
    transitionCounts.push(runs.length - 1);
  }

  longestInteriorRunRatios.sort((left, right) => left - right);
  transitionCounts.sort((left, right) => left - right);
  const medianInteriorRun = longestInteriorRunRatios[
    Math.floor(longestInteriorRunRatios.length * 0.5)
  ];
  const ninetiethInteriorRun = longestInteriorRunRatios[
    Math.floor(longestInteriorRunRatios.length * 0.9)
  ];
  const medianTransitionCount = transitionCounts[
    Math.floor(transitionCounts.length * 0.5)
  ];
  const tenthTransitionCount = transitionCounts[
    Math.floor(transitionCounts.length * 0.1)
  ];
  assert.ok(
    medianInteriorRun <= 0.18 &&
      ninetiethInteriorRun <= 0.4 &&
      medianTransitionCount >= 6 &&
      tenthTransitionCount >= 2,
    `風頭內部必須有多次破碎，不能把左右端的正確風向區誤判成墨漬：${JSON.stringify({
      medianInteriorRun,
      ninetiethInteriorRun,
      medianTransitionCount,
      tenthTransitionCount,
    })}`,
  );
});

test('侵蝕遮罩必須接近二值且保持累積單調，不得形成跨圖灰色 crossfade', async () => {
  const frames = await Promise.all(
    [0.2, 0.35, 0.5].map((progress) => captureFrame(progress, 20_260_718)),
  );
  const snapshots = frames.map((frame) => {
    const alphaValues = frame.erosionMask.pixels.filter(
      (_, index) => index % 4 === 3,
    );
    const partialY = [];
    const alphaBins = new Set();
    for (let index = 0; index < alphaValues.length; index += 1) {
      const alpha = alphaValues[index];
      alphaBins.add(Math.min(15, Math.floor(alpha / 16)));
      if (alpha >= 24 && alpha <= 231) {
        partialY.push(Math.floor(index / frame.erosionMask.width) /
          frame.erosionMask.height);
      }
    }
    partialY.sort((left, right) => left - right);
    const localPartialRuns = Array.from({ length: 16 }, (_, sample) => {
      const x = Math.floor((sample + 0.5) / 16 * frame.erosionMask.width);
      let currentRun = 0;
      let longestRun = 0;
      for (let y = 0; y < frame.erosionMask.height; y += 1) {
        const alpha = frame.erosionMask.pixels[
          (y * frame.erosionMask.width + x) * 4 + 3
        ];
        if (alpha >= 24 && alpha <= 231) {
          currentRun += 1;
          longestRun = Math.max(longestRun, currentRun);
        } else {
          currentRun = 0;
        }
      }
      return longestRun / frame.erosionMask.height;
    });
    const partialSpan = partialY.length < 2
      ? 0
      : partialY[Math.floor((partialY.length - 1) * 0.9)] -
        partialY[Math.floor((partialY.length - 1) * 0.1)];
    return {
      alphaValues,
      gradientRatio: partialY.length / alphaValues.length,
      alphaBinCount: alphaBins.size,
      partialSpan,
      maximumLocalPartialRun: Math.max(...localPartialRuns),
    };
  });

  assert.ok(snapshots.every((snapshot) =>
    snapshot.gradientRatio <= 0.01 &&
    snapshot.alphaBinCount >= 2 &&
    snapshot.alphaBinCount <= 4 &&
    snapshot.maximumLocalPartialRun <= 0.025,
  ), `原生 alpha 必須接近二值且前緣很窄：${JSON.stringify(
    snapshots.map(({ alphaValues, ...metrics }) => metrics),
  )}`);
  for (let frameIndex = 1; frameIndex < snapshots.length; frameIndex += 1) {
    assert.ok(snapshots[frameIndex].alphaValues.every((alpha, index) =>
      alpha >= snapshots[frameIndex - 1].alphaValues[index],
    ), '同一像素的累積侵蝕 alpha 不得隨時間倒退');
  }
});

test('中段侵蝕前緣必須窄且顆粒化，不得以半透明灰幕混合兩張圖片', async () => {
  const frame = await captureFrame(0.5, 20_260_718);
  const { width, height, pixels } = frame.erosionMask;
  let partialAlphaCount = 0;
  const localPartialSpans = [];

  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 24))) {
    let currentPartialRun = 0;
    let longestPartialRun = 0;
    for (let y = 0; y < height; y += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha >= 16 && alpha <= 239) {
        currentPartialRun += 1;
        longestPartialRun = Math.max(longestPartialRun, currentPartialRun);
      } else {
        currentPartialRun = 0;
      }
    }
    localPartialSpans.push(longestPartialRun / height);
  }

  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] >= 16 && pixels[index] <= 239) {
      partialAlphaCount += 1;
    }
  }

  const partialAlphaRatio = partialAlphaCount / (width * height);
  assert.ok(
    partialAlphaRatio <= 0.006 && Math.max(...localPartialSpans) <= 0.018,
    `半透明區必須縮成窄前緣，不能形成 crossfade 灰幕：${JSON.stringify({
      partialAlphaRatio,
      maximumLocalPartialSpan: Math.max(...localPartialSpans),
    })}`,
  );
});

test('遮罩必須由左向右掃過，中右粒子風團負責呈現實際風向', async () => {
  const frame = await captureFrame(0.5, 20_260_718);
  const { width, height, pixels } = frame.erosionMask;
  const quarter = Math.floor(width / 4);

  function erasedRatio(startX, endX) {
    let erasedMass = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        erasedMass += pixels[(y * width + x) * 4 + 3] / 255;
      }
    }
    return erasedMass / ((endX - startX) * height);
  }

  const left = erasedRatio(0, quarter);
  const middleRight = erasedRatio(
    Math.floor(width * 0.5),
    Math.floor(width * 0.75),
  );
  const right = erasedRatio(width - quarter, width);
  const outerAverage = (left + right) / 2;
  assert.ok(
    left - right >= 0.14 && left - right <= 0.34,
    `同一時刻左側必須比右側多清除 14%～34%，不能再形成全寬水平接縫：${JSON.stringify({
      left,
      middleRight,
      right,
      difference: left - right,
    })}`,
  );
  assert.ok(
    middleRight >= right - 0.03 && middleRight <= left + 0.06,
    `中右遮罩必須位於左清右留之間，再由圖片砂粒形成局部風核：${JSON.stringify({
      left,
      middleRight,
      right,
      localLead: middleRight - outerAverage,
    })}`,
  );
});

test('活動高度必須各自形成局部左至右風頭，不得全寬同時像素化', async () => {
  const frame = await captureFrame(0.5, 20_260_718);
  const { width, height, pixels } = frame.erosionMask;
  const activeRows = [];

  for (let y = 0; y < height; y += 1) {
    const states = Array.from({ length: width }, (_, x) =>
      pixels[(y * width + x) * 4 + 3] >= 128 ? 1 : 0,
    );
    const erasedRatio = states.reduce((sum, state) => sum + state, 0) / width;
    if (erasedRatio < 0.12 || erasedRatio > 0.88) {
      continue;
    }

    const quarter = Math.floor(width / 4);
    const leftRatio = states.slice(0, quarter).reduce(
      (sum, state) => sum + state,
      0,
    ) / quarter;
    const rightRatio = states.slice(width - quarter).reduce(
      (sum, state) => sum + state,
      0,
    ) / quarter;
    activeRows.push({
      headX: erasedRatio,
      directionalLead: leftRatio - rightRatio,
    });
  }

  const sortedHeads = activeRows
    .map(({ headX }) => headX)
    .sort((left, right) => left - right);
  const tenthHead = sortedHeads[Math.floor(sortedHeads.length * 0.1)] ?? 0;
  const ninetiethHead = sortedHeads[
    Math.floor(sortedHeads.length * 0.9)
  ] ?? 0;
  const directionalShare = activeRows.filter(
    ({ directionalLead }) => directionalLead >= 0.35,
  ).length / Math.max(1, activeRows.length);

  assert.ok(
    activeRows.length >= height * 0.12 &&
      ninetiethHead - tenthHead >= 0.4 &&
      directionalShare >= 0.65,
    `不同高度必須有錯開的局部右移風頭，而非全寬 dissolve：${JSON.stringify({
      activeRowRatio: activeRows.length / height,
      headSpan: ninetiethHead - tenthHead,
      directionalShare,
    })}`,
  );
});

test('中段必須形成來源座標各異的圖片微粒，並聚成中右風砂主體', async () => {
  const frame = await captureFrame(0.5, 20_260_718);
  const visibleParticles = frame.particles.filter(
    (particle) => particle.opacity >= 0.035,
  );
  const airborneParticles = visibleParticles.filter(isAirborneSand);
  const uniqueSourcePixels = new Set(visibleParticles.map((particle) =>
    `${Math.round(particle.sourceX)}:${Math.round(particle.sourceY)}`,
  ));
  const visibleMass = airborneParticles.reduce(
    (total, particle) => total + particleVisibleMass(particle, frame),
    0,
  );
  const middleRightMass = airborneParticles.reduce(
    (total, particle) => particle.x / frame.width >= 0.58 &&
      particle.x / frame.width <= 0.86
      ? total + particleVisibleMass(particle, frame)
      : total,
    0,
  );

  assert.ok(
    visibleParticles.length >= 1_200 &&
      uniqueSourcePixels.size >= visibleParticles.length * 0.9 &&
      middleRightMass / Math.max(visibleMass, Number.EPSILON) >= 0.72,
    `圖片像素必須成為大量獨立微粒，且主要落在中右風帶：${JSON.stringify({
      visible: visibleParticles.length,
      uniqueSources: uniqueSourcePixels.size,
      middleRightShare: middleRightMass /
        Math.max(visibleMass, Number.EPSILON),
    })}`,
  );
});

test('沙粒必須細小，且可見沙塵集中在畫面中間偏右', async () => {
  const frame = await captureMiddleFrame();
  const particleWidths = frame.particles
    .map(({ width }) => width)
    .sort((left, right) => left - right);
  const ninetiethParticleWidth = particleWidths[
    Math.floor((particleWidths.length - 1) * 0.9)
  ];
  const horizontalMass = new Array(5).fill(0);

  for (const particle of frame.particles) {
    const bucket = Math.min(
      horizontalMass.length - 1,
      Math.floor(particle.x / frame.width * horizontalMass.length),
    );
    horizontalMass[bucket] += particleVisibleMass(particle, frame);
  }

  const totalMass = horizontalMass.reduce((total, mass) => total + mass, 0);
  const middleRightShare = horizontalMass[3] / totalMass;
  assert.ok(
    ninetiethParticleWidth <= Math.min(frame.width, frame.height) * 0.0035,
    `90% 實際繪製粒寬不可超過畫面短邊 0.35%，避免變成雪花圓點：${ninetiethParticleWidth}`,
  );
  assert.ok(
    middleRightShare >= 0.4,
    `畫面 60%～80% 必須承載至少 40% 的可見沙塵：${JSON.stringify({
      horizontalMass,
      middleRightShare,
    })}`,
  );
  assert.ok(
    frame.width / frame.erosionMask.width <= 2.5 &&
      frame.height / frame.erosionMask.height <= 2.5,
    `1920×1080 遮罩顆粒邊長不可超過 2.5px：${JSON.stringify({
      maskWidth: frame.erosionMask.width,
      maskHeight: frame.erosionMask.height,
    })}`,
  );
});

test('細沙必須比粗沙飛得更遠、更高，並留下更長尾流', async () => {
  const frame = await captureFrame(0.5, 20_260_718);
  const sortedSizes = frame.particles
    .map(({ sourceSize }) => sourceSize)
    .sort((left, right) => left - right);
  const fineThreshold = sortedSizes[Math.floor(sortedSizes.length * 0.3)];
  const coarseThreshold = sortedSizes[Math.floor(sortedSizes.length * 0.85)];
  const fineSand = frame.particles.filter(
    ({ sourceSize }) => sourceSize <= fineThreshold,
  );
  const coarseSand = frame.particles.filter(
    ({ sourceSize }) => sourceSize >= coarseThreshold,
  );
  const mean = (particles, select) => particles.reduce(
    (total, particle) => total + select(particle),
    0,
  ) / Math.max(1, particles.length);
  const metrics = {
    fineDrift: mean(
      fineSand,
      (particle) => (particle.x - particle.sourceX) / frame.width,
    ),
    coarseDrift: mean(
      coarseSand,
      (particle) => (particle.x - particle.sourceX) / frame.width,
    ),
    fineLift: mean(
      fineSand,
      (particle) => (particle.sourceY - particle.y) / frame.height,
    ),
    coarseLift: mean(
      coarseSand,
      (particle) => (particle.sourceY - particle.y) / frame.height,
    ),
    fineWake: mean(fineSand, ({ wakeLength }) => wakeLength / frame.width),
    coarseWake: mean(
      coarseSand,
      ({ wakeLength }) => wakeLength / frame.width,
    ),
  };

  assert.ok(
    fineSand.length >= 300 && coarseSand.length >= 100,
    `必須有足夠的細砂與粗砂樣本：${JSON.stringify({
      fine: fineSand.length,
      coarse: coarseSand.length,
    })}`,
  );
  assert.ok(
    metrics.fineDrift >= metrics.coarseDrift * 1.2,
    `細沙的向右位移至少應比粗沙多 20%：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.fineLift >= metrics.coarseLift * 1.6,
    `細沙的上揚高度至少應是粗沙的 1.6 倍：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.fineWake >= metrics.coarseWake * 1.2,
    `細沙的尾流至少應比粗沙長 20%：${JSON.stringify(metrics)}`,
  );
});

test('同一時刻的可見沙塵必須集中成連續風帶，不能散落整個高度', async () => {
  const frame = await captureMiddleFrame();
  const particlesByHeight = frame.particles
    .map((particle) => ({
      normalizedY: particle.sourceY / frame.height,
      mass: particleVisibleMass(particle, frame),
    }))
    .sort((left, right) => left.normalizedY - right.normalizedY);
  const totalMass = particlesByHeight.reduce(
    (total, particle) => total + particle.mass,
    0,
  );

  function weightedQuantile(target) {
    let accumulatedMass = 0;
    for (const particle of particlesByHeight) {
      accumulatedMass += particle.mass;
      if (accumulatedMass >= totalMass * target) {
        return particle.normalizedY;
      }
    }
    return particlesByHeight.at(-1).normalizedY;
  }

  const visibleVerticalSpan = weightedQuantile(0.9) - weightedQuantile(0.1);
  assert.ok(
    visibleVerticalSpan <= 0.39,
    `80% 可見沙塵不可散布超過畫面高度 39%：${visibleVerticalSpan}`,
  );
});

test('可見圖片沙粒必須來自同一時刻已被吹開的遮罩像素', async () => {
  const frames = await Promise.all(
    [0.2, 0.35, 0.5, 0.65].map((progress) =>
      captureFrame(progress, 20_260_718)),
  );
  const coupledShares = frames.map((frame) => {
    const { width, height, pixels } = frame.erosionMask;
    let visibleMass = 0;
    let coupledMass = 0;

    for (const particle of frame.particles) {
      const mass = particleVisibleMass(particle, frame);
      const sourceX = Math.min(
        width - 1,
        Math.floor(particle.sourceX / frame.width * width),
      );
      const sourceY = Math.min(
        height - 1,
        Math.floor(particle.sourceY / frame.height * height),
      );
      const sourceAlpha = pixels[(sourceY * width + sourceX) * 4 + 3] / 255;
      visibleMass += mass;
      coupledMass += mass * sourceAlpha;
    }

    return coupledMass / Math.max(visibleMass, Number.EPSILON);
  });

  assert.ok(
    coupledShares.every((share) => share >= 0.85),
    `至少 85% 的可見粒子質量必須來自同幀已侵蝕位置：${JSON.stringify(
      coupledShares,
    )}`,
  );
});

test('移動中的圖片沙粒必須是柔邊橢圓所需的有效幾何，不可退化成零尺寸', async () => {
  const frame = await captureMiddleFrame();
  assert.ok(frame.particles.every((particle) =>
    particle.width > 0 &&
    particle.height > 0 &&
    Number.isFinite(particle.rotation) &&
    Math.abs(particle.rotation) <= 0.13 &&
    particle.opacity <= 0.82 &&
    particle.fragmentStrength >= 0 &&
    particle.fragmentStrength <= 1,
  ));

  const attachedFragments = frame.particles.filter(
    (particle) => particle.fragmentStrength >= 0.5,
  );
  assert.ok(
    attachedFragments.length >= frame.particles.length * 0.05 &&
      attachedFragments.every((particle) =>
        particle.size <= particle.sourceSize * 1.25 &&
        particle.opacity >= 0.45 &&
        Number.isInteger(particle.fragmentGrainCount) &&
        particle.fragmentGrainCount >= 5 &&
        particle.fragmentGrainCount <= 8 &&
        particle.fragmentSpread > particle.size),
    `剛被遮罩吹開的至少 5% 粒子必須以 5～8 顆微粒承接原圖，不可放大成圓斑：${JSON.stringify({
      attached: attachedFragments.length,
      particles: frame.particles.length,
    })}`,
  );
});

test('主要圖片沙粒必須帶少量非條紋子粒，避免等距亮點形成數位紙屑', async () => {
  const frame = await captureMiddleFrame();
  const wakeParticles = frame.particles.filter((particle) =>
    Number.isInteger(particle.wakeGrainCount) &&
    particle.wakeGrainCount >= 3 &&
    particle.wakeGrainCount <= 5 &&
    particle.wakeLength >= frame.width * 0.02 &&
    particle.wakeLength <= frame.width * 0.09 &&
    particle.wakeCurl >= particle.height * 2 &&
    particle.wakeOpacityScale > 0 &&
    particle.wakeOpacityScale <= 0.32,
  );

  assert.ok(
    wakeParticles.length >= frame.particles.length * 0.95,
    `至少 95% 的主粒必須只有 3～5 顆低透明子粒：${JSON.stringify({
      wake: wakeParticles.length,
      particles: frame.particles.length,
    })}`,
  );
  assert.ok(
    frame.particles.every((particle) =>
      particle.trailWidth === undefined ||
      particle.trailWidth <= particle.width * 2.4,
    ),
    '禁止以超長扁橢圓產生掃描線拖影',
  );
});

test('多組種子的風蝕前緣不得被單一斜面解釋，必須維持多孔破碎輪廓', async () => {
  const frames = await Promise.all(
    [11, 29, 47, 83, 131].map((seed) => captureFrame(0.5, seed)),
  );
  const metrics = frames.map((frame) => {
    const { width, height, pixels } = frame.erosionMask;
    const frontier = Array.from({ length: 48 }, (_, sample) => {
      const x = Math.floor((sample + 0.5) / 48 * width);
      let erasedMass = 0;
      for (let y = 0; y < height; y += 1) {
        erasedMass += pixels[(y * width + x) * 4 + 3] / 255;
      }
      return 1 - erasedMass / height;
    });
    const xValues = frontier.map((_, index) => index / (frontier.length - 1));
    const meanX = xValues.reduce((sum, value) => sum + value, 0) /
      xValues.length;
    const meanY = frontier.reduce((sum, value) => sum + value, 0) /
      frontier.length;
    const covariance = frontier.reduce(
      (sum, value, index) =>
        sum + (xValues[index] - meanX) * (value - meanY),
      0,
    );
    const varianceX = xValues.reduce(
      (sum, value) => sum + (value - meanX) ** 2,
      0,
    );
    const slope = covariance / varianceX;
    const residuals = frontier.map((value, index) =>
      value - (meanY + slope * (xValues[index] - meanX)),
    );
    const residualSquareSum = residuals.reduce(
      (sum, value) => sum + value ** 2,
      0,
    );
    const totalSquareSum = frontier.reduce(
      (sum, value) => sum + (value - meanY) ** 2,
      0,
    );
    const meaningfulDirections = frontier.slice(1)
      .map((value, index) => value - frontier[index])
      .filter((difference) => Math.abs(difference) >= 0.002);
    const signs = meaningfulDirections.map(Math.sign);
    const absoluteDeltas = meaningfulDirections
      .map(Math.abs)
      .sort((left, right) => left - right);

    return {
      slope,
      standardDeviation: Math.sqrt(totalSquareSum / frontier.length),
      residualStandardDeviation: Math.sqrt(
        residualSquareSum / frontier.length,
      ),
      linearR2: 1 - residualSquareSum /
        Math.max(totalSquareSum, Number.EPSILON),
      negativeShare: meaningfulDirections.filter((value) => value < 0).length /
        Math.max(1, meaningfulDirections.length),
      directionChanges: signs.slice(1).filter(
        (sign, index) => sign !== signs[index],
      ).length,
      ninetiethDelta: absoluteDeltas[
        Math.floor(Math.max(0, absoluteDeltas.length - 1) * 0.9)
      ] ?? 0,
    };
  });
  const medianMetric = (property) => metrics
    .map((metric) => metric[property])
    .sort((left, right) => left - right)[Math.floor(metrics.length / 2)];

  assert.ok(metrics.every((metric) =>
    metric.slope >= 0.14 &&
    metric.slope <= 0.38 &&
    metric.residualStandardDeviation >= 0.03 &&
    metric.linearR2 <= 0.82 &&
    metric.negativeShare >= 0.18 &&
    metric.directionChanges >= 6 &&
    metric.ninetiethDelta <= 0.08,
  ), `每個種子都必須保留左至右正斜率，同時打散成非直線風頭：${JSON.stringify(metrics)}`);
  assert.ok(
    medianMetric('slope') >= 0.16 &&
      medianMetric('slope') <= 0.32 &&
      medianMetric('standardDeviation') >= 0.025 &&
      medianMetric('standardDeviation') <= 0.14 &&
      medianMetric('residualStandardDeviation') >= 0.03 &&
      medianMetric('linearR2') <= 0.68 &&
      medianMetric('negativeShare') >= 0.3 &&
      medianMetric('directionChanges') >= 8,
    `五組種子的中位輪廓必須兼具風向與非線性，不可退化成 affine wipe：${JSON.stringify(metrics)}`,
  );
});

test('早中段沙塵核心必須穩定留在中間偏右並隨風勢連續上移', async () => {
  const checkpoints = await Promise.all(
    [0.2, 0.35, 0.5].map((progress) => captureFrame(progress, 20_260_718)),
  );
  const centers = checkpoints.map((frame) => {
    const airborneParticles = frame.particles.filter(isAirborneSand);
    const x = weightedMean(
      airborneParticles,
      (particle) => particle.x / frame.width,
      (particle) => particleVisibleMass(particle, frame),
    );
    const y = weightedMean(
      airborneParticles,
      (particle) => particle.y / frame.height,
      (particle) => particleVisibleMass(particle, frame),
    );
    const totalMass = airborneParticles.reduce(
      (sum, particle) => sum + particleVisibleMass(particle, frame),
      0,
    );
    const coreMass = airborneParticles.reduce((sum, particle) =>
      Math.abs(particle.x / frame.width - x) <= 0.15 &&
      Math.abs(particle.y / frame.height - y) <= 0.12
        ? sum + particleVisibleMass(particle, frame)
        : sum,
    0);
    return { progress: frame.progress, x, y, coreShare: coreMass / totalMass };
  });

  assert.ok(
    centers.every(({ x }) => x >= 0.64 && x <= 0.79),
    `沙塵主體必須穩定落在畫面 64%～79% 的中右區：${JSON.stringify(centers)}`,
  );
  assert.ok(
    centers[0].y - centers[1].y >= 0.1 &&
      centers[1].y - centers[2].y >= 0.1,
    `沙塵核心必須逐段向上至少移動畫面高度 10%：${JSON.stringify(centers)}`,
  );
  assert.ok(
    centers.every(({ coreShare }) => coreShare >= 0.6),
    `主沙塵質量至少 60% 必須聚成單一核心：${JSON.stringify(centers)}`,
  );
});

test('圖片沙粒必須形成由核心向右漸淡的尾流，風向不得只靠遮罩假裝', async () => {
  const checkpoints = await Promise.all(
    [0.2, 0.35, 0.5].map((progress) => captureFrame(progress, 20_260_718)),
  );
  const metrics = checkpoints.map((frame) => {
    const weightedParticles = frame.particles.filter(isAirborneSand)
      .map((particle) => ({
      dx: (particle.x - particle.sourceX) / frame.width,
      destinationX: particle.x / frame.width,
      mass: particleVisibleMass(particle, frame),
      }));
    const totalMass = weightedParticles.reduce(
      (sum, particle) => sum + particle.mass,
      0,
    );
    const meanDx = weightedParticles.reduce(
      (sum, particle) => sum + particle.dx * particle.mass,
      0,
    ) / totalMass;
    const sortedByDx = [...weightedParticles].sort(
      (left, right) => left.dx - right.dx,
    );
    const sortedByDestination = [...weightedParticles].sort(
      (left, right) => left.destinationX - right.destinationX,
    );
    const quantile = (particles, property, target) => {
      let mass = 0;
      for (const particle of particles) {
        mass += particle.mass;
        if (mass >= totalMass * target) {
          return particle[property];
        }
      }
      return particles.at(-1)?.[property] ?? 0;
    };
    const coreX = weightedParticles.reduce(
      (sum, particle) => sum + particle.destinationX * particle.mass,
      0,
    ) / totalMass;
    return {
      meanDx,
      p85Dx: quantile(sortedByDx, 'dx', 0.85),
      tailMassShare: weightedParticles.reduce(
        (sum, particle) => particle.dx >= 0.06
          ? sum + particle.mass
          : sum,
        0,
      ) / totalMass,
      destinationTail: quantile(
        sortedByDestination,
        'destinationX',
        0.9,
      ) - coreX,
    };
  });

  const minimums = [
    { meanDx: 0.035, p85Dx: 0.055, tailMassShare: 0.1, destinationTail: 0.08 },
    { meanDx: 0.052, p85Dx: 0.09, tailMassShare: 0.3, destinationTail: 0.085 },
    { meanDx: 0.052, p85Dx: 0.09, tailMassShare: 0.33, destinationTail: 0.09 },
  ];
  assert.ok(metrics.every((metric, index) =>
    metric.meanDx >= minimums[index].meanDx &&
    metric.p85Dx >= minimums[index].p85Dx &&
    metric.tailMassShare >= minimums[index].tailMassShare &&
    metric.destinationTail >= minimums[index].destinationTail,
  ), `右向尾流必須有可見長度與漸淡質量：${JSON.stringify(metrics)}`);
  const meanDrifts = metrics.map(({ meanDx }) => meanDx);
  assert.ok(
    Math.max(...meanDrifts) - Math.min(...meanDrifts) <= 0.05,
    `連續陣風的右向位移不得在不同高度突然縮短：${JSON.stringify(metrics)}`,
  );
});

test('中段粒子必須維持有界風帶，避免 4K 每幀繪製過多碎片', async () => {
  const frame = await captureMiddleFrame();
  const rasterOperationCount = frame.particles.reduce(
    (total, particle) => total + particle.wakeGrainCount + 1,
    0,
  );
  assert.ok(
    frame.particles.length <= frame.sampleCount * 0.45,
    `同時活動粒子不可超過樣本的 45%：${JSON.stringify({
      particles: frame.particles.length,
      sampleCount: frame.sampleCount,
    })}`,
  );
  assert.ok(
    rasterOperationCount <= frame.sampleCount * 4.5,
    `主粒加尾流的每幀 raster 呼叫不得超過樣本數 4.5 倍：${JSON.stringify({
      rasterOperationCount,
      sampleCount: frame.sampleCount,
    })}`,
  );
});
