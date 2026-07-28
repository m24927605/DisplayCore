/** 單次轉場允許的粒子硬上限，避免 4K 畫面產生與像素數等比例的工作量。 */
const HARD_MAXIMUM_PARTICLE_COUNT = 24_000;
const DEFAULT_PARTICLE_COUNT = 24_000;
const MASK_MAXIMUM_WIDTH = 960;
const MASK_MAXIMUM_HEIGHT = 540;
const MASK_TARGET_PIXEL_EDGE = 2;
// 備援 Canvas 遮罩只保留一個 activation bucket 的柔邊，避免兩張圖片
// 在大片區域交疊成 crossfade；真正的柔和邊緣由細砂粒子接手。
const EROSION_FEATHER_MINIMUM_PROGRESS = 1 / 255;
const EROSION_FEATHER_MAXIMUM_PROGRESS = 1 / 255;
const WIND_START_PROGRESS = 0.01;
const WIND_VERTICAL_TRAVEL_PROGRESS = 0.72;
const WIND_HORIZONTAL_TRAVEL_PROGRESS = 0.18;
const DUST_EMITTER_HORIZONTAL_POSITION = 0.62;
const DUST_EMITTER_HORIZONTAL_SPREAD = 0.105;
const DUST_EMITTER_SAMPLE_SHARE = 0.78;
const MASK_CORE_HORIZONTAL_POSITION = 0.66;
const TAU = Math.PI * 2;

export const SAND_TRANSITION_LIMITS = Object.freeze({
  maximumParticleCount: HARD_MAXIMUM_PARTICLE_COUNT,
  defaultParticleCount: DEFAULT_PARTICLE_COUNT,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function smootherstep(value) {
  const progress = clamp(value, 0, 1);
  return progress ** 3 * (
    progress * (progress * 6 - 15) + 10
  );
}

/**
 * 產生連續且永不歸零的低頻風團。
 *
 * 兩個不等週期的緩慢波形只會調整粒子揚升、亂流及可見密度，不參與侵蝕
 * 啟動時間，因此風勢會有自然呼吸感，但不會把連續風頭切成數條帶狀動畫。
 */
export function calculateSandGustStrength(progress, phase = 0) {
  const boundedProgress = clamp(progress, 0, 1);
  const slowGust = Math.sin(
    (boundedProgress * 1.17 + phase * 0.23) * TAU - 0.45,
  );
  const secondaryGust = Math.sin(
    (boundedProgress * 2.31 + phase * 0.41) * TAU + 1.12,
  );

  return clamp(1 + slowGust * 0.085 + secondaryGust * 0.035, 0.88, 1.12);
}

/** 每顆沙粒使用自己的淡出起點，完成幀仍保證完全歸零。 */
export function calculateSandParticleFinalFade(progress, fadeStartProgress) {
  const safeFadeStart = clamp(fadeStartProgress, 0, 0.999);
  const fadeProgress = clamp(
    (progress - safeFadeStart) / (1 - safeFadeStart),
    0,
    1,
  );
  return 1 - smootherstep(fadeProgress);
}

function smoothstepRange(minimum, maximum, value) {
  return smoothstep(clamp(
    (value - minimum) / (maximum - minimum),
    0,
    1,
  ));
}

/** 產生不依賴平台與 Canvas 的固定二維雜訊值。 */
function hashNoise(x, y, seed) {
  let hash = Math.imul(x ^ seed, 374_761_393);
  hash = (hash + Math.imul(y, 668_265_263)) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1_274_126_177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4_294_967_295;
}

/** 對格點雜訊做平滑內插，讓侵蝕邊緣像自然沙丘而不是規則圓孔。 */
function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const offsetX = smoothstep(x - x0);
  const offsetY = smoothstep(y - y0);
  const top = hashNoise(x0, y0, seed) * (1 - offsetX) +
    hashNoise(x0 + 1, y0, seed) * offsetX;
  const bottom = hashNoise(x0, y0 + 1, seed) * (1 - offsetX) +
    hashNoise(x0 + 1, y0 + 1, seed) * offsetX;
  return top * (1 - offsetY) + bottom * offsetY;
}

function calculatePlumeStrength(normalizedX) {
  return Math.exp(
    -0.5 * (
      (normalizedX - DUST_EMITTER_HORIZONTAL_POSITION) /
      DUST_EMITTER_HORIZONTAL_SPREAD
    ) ** 2,
  );
}

function calculateMaskCoreStrength(normalizedX) {
  const spread = normalizedX < MASK_CORE_HORIZONTAL_POSITION
    ? 0.09
    : 0.18;
  return Math.exp(
    -0.5 * (
      (normalizedX - MASK_CORE_HORIZONTAL_POSITION) /
      spread
    ) ** 2,
  );
}

/**
 * 為每個位置決定被風吹走的時間。
 *
 * Y 軸只控制整體風牆的中位高度；三尺度二維風蝕場會在活動高度形成提前破口
 * 與延遲殘留島。如此舊圖不會沿單一水平線消失，也不會把整個活動區做灰色
 * crossfade。遮罩以寬廣、破碎的左清右留區建立風向，再由真正向右移動的圖片
 * 砂粒把風勢具體呈現出來。
 */
function calculateMaskActivation(
  normalizedX,
  normalizedY,
  seed,
) {
  const distanceFromBottom = 1 - normalizedY;
  const grain = hashNoise(
    Math.floor(normalizedX * 1_024),
    Math.floor(normalizedY * 1_024),
    seed + 7_919,
  );
  const macro = valueNoise(
    normalizedX * 5.5,
    normalizedY * 10,
    seed + 41_027,
  );
  const meso = valueNoise(
    normalizedX * 21,
    normalizedY * 34,
    seed + 73_919,
  );
  const streak = valueNoise(
    normalizedX * 52,
    normalizedY * 110,
    seed + 24_917,
  );
  // 固定於 X 軸的柱狀亂流不會在整個高度平均後消失，能把左至右的風頭
  // 扭成沙丘般的多孔輪廓，而不是一條可用直線解釋的斜向 wipe。
  const columnGust = valueNoise(
    normalizedX * 11.5,
    0,
    seed + 151_031,
  );
  const fineColumnGust = valueNoise(
    normalizedX * 31,
    0,
    seed + 181_081,
  );
  const coreCenterX = MASK_CORE_HORIZONTAL_POSITION + (
    valueNoise(0, normalizedY * 4.5, seed + 93_931) - 0.5
  ) * 0.05;
  const coreSpread = normalizedX < coreCenterX ? 0.065 : 0.14;
  const maskCoreStrength = Math.exp(
    -0.5 * ((normalizedX - coreCenterX) / coreSpread) ** 2,
  );
  const breakup =
    (macro * 2 - 1) * 0.04 +
    (meso * 2 - 1) * 0.045 +
    (streak * 2 - 1) * 0.03 +
    (columnGust * 2 - 1) * 0.06 +
    (fineColumnGust * 2 - 1) * 0.025 +
    (grain * 2 - 1) * 0.012;
  const holdIsland = 0.065 * smoothstepRange(0.6, 0.82, macro);
  const earlyBreach = 0.05 * smoothstepRange(0.6, 0.82, 1 - macro);
  const localAdvance = -0.055 * maskCoreStrength * (
    0.75 + meso * 0.25
  );
  const horizontalSweep = smootherstep(normalizedX) *
    WIND_HORIZONTAL_TRAVEL_PROGRESS;

  return clamp(
    WIND_START_PROGRESS +
      distanceFromBottom * WIND_VERTICAL_TRAVEL_PROGRESS +
      horizontalSweep +
      breakup +
      holdIsland -
      earlyBreach +
      localAdvance,
    0.005,
    0.975 + grain * 0.015,
  );
}

/** 依 75% 細砂、20% 中砂、5% 小碎片配置實際來源粒徑。 */
function calculateSourceSizeRatio(sizeRandom) {
  if (sizeRandom < 0.75) {
    return 0.0011 + sizeRandom / 0.75 * 0.0012;
  }
  if (sizeRandom < 0.95) {
    return 0.0023 + (sizeRandom - 0.75) / 0.2 * 0.0014;
  }
  return 0.0037 + (sizeRandom - 0.95) / 0.05 * 0.0028;
}

function validateGeometryOptions({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('風吹沙轉場的畫面寬高必須是正數。');
  }
}

function validateStartOptions({
  width,
  height,
  durationMs,
  onComplete,
  onError,
}) {
  validateGeometryOptions({ width, height });

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('風吹沙轉場的時間必須是正數。');
  }

  if (onComplete !== undefined && typeof onComplete !== 'function') {
    throw new TypeError('風吹沙轉場的完成回呼必須是函式。');
  }

  if (onError !== undefined && typeof onError !== 'function') {
    throw new TypeError('風吹沙轉場的失敗回呼必須是函式。');
  }
}

/**
 * 以固定數量的完整網格建立舊圖片碎片與侵蝕孔資料。
 *
 * 每個取樣點只保存來源座標、連續侵蝕面的啟動時間及運動參數，不讀取圖片像素，
 * 因此解析度提高到 4K 時，此引擎的取樣計算與粒子資料量仍固定且有界。
 * 呼叫端可用 sourceX、sourceY 從舊圖片裁出粒粒分明的風向沙粒。
 */
function createSamples({
  width,
  height,
  sampleCount,
  random,
  seed,
  erosionMask,
}) {
  const aspectRatio = width / height;
  const columns = Math.max(
    1,
    Math.min(sampleCount, Math.floor(Math.sqrt(sampleCount * aspectRatio))),
  );
  const rows = Math.max(1, Math.floor(sampleCount / columns));
  const actualSampleCount = columns * rows;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const shortestSide = Math.min(width, height);
  const samples = new Array(actualSampleCount);

  for (let index = 0; index < actualSampleCount; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const horizontalJitter = clamp(random(), 0, 1);
    const verticalJitter = clamp(random(), 0, 1);
    const sizeRandom = clamp(random(), 0, 1);
    const driftRandom = clamp(random(), 0, 1);
    const liftRandom = clamp(random(), 0, 1);
    const emitterSample = index % 50 < Math.round(
      DUST_EMITTER_SAMPLE_SHARE * 50,
    );
    const emitterHorizontalRandom = (
      hashNoise(index, 3_571, seed + 20_011) +
      hashNoise(index, 7_919, seed + 40_009)
    ) - 1;
    // 多數樣本由畫面中央偏右的供料區剝落；其餘樣本維持全圖稀疏供料。
    // 供料點沿共用風場向右漂移後，會在 66%～76% 形成肉眼可見的揚砂核心。
    const sourceX = emitterSample
      ? clamp(
          DUST_EMITTER_HORIZONTAL_POSITION +
            emitterHorizontalRandom * DUST_EMITTER_HORIZONTAL_SPREAD,
          0,
          1,
        ) * width
      : Math.min(width, (
          column + 0.38 + horizontalJitter * 0.24
        ) * cellWidth);
    const sourceY = Math.min(height, (
      row + 0.38 + verticalJitter * 0.24
    ) * cellHeight);
    const normalizedX = sourceX / width;
    // 相鄰來源像素共用低頻風場相位，讓沙塵聚成一股連續氣流而非各自亂飄。
    const phase = valueNoise(
      normalizedX * 4.2,
      sourceY / height * 5.1,
      seed + 53_123,
    ) * TAU;
    const plumeStrength = calculatePlumeStrength(normalizedX);
    const maskX = Math.min(
      erosionMask.width - 1,
      Math.floor(sourceX / width * erosionMask.width),
    );
    const maskY = Math.min(
      erosionMask.height - 1,
      Math.floor(sourceY / height * erosionMask.height),
    );
    // 與侵蝕遮罩共用完全相同的啟動 bucket；粒子只能從已被吹開的舊圖像素產生。
    const activation = erosionMask.activations[
      maskY * erosionMask.width + maskX
    ] / 255;
    const grainFineness = 1 - sizeRandom;
    const mobilityNoise = hashNoise(index, 13_087, seed + 61_013);
    // 粒徑與運動共用同一 mobility：細砂懸浮，粗砂貼近表面翻滾。
    const grainMobility = clamp(
      grainFineness * 0.86 + mobilityNoise * 0.14,
      0,
      1,
    );
    const sourceSize = Math.max(
      1.2,
      shortestSide * calculateSourceSizeRatio(sizeRandom),
    );
    const fadeRandom = hashNoise(index, 57_031, seed + 149_051);

    samples[index] = {
      sourceX,
      sourceY,
      sourceSize,
      grainMobility,
      driftDistance: width * (
        0.0775 + driftRandom * 0.155 + plumeStrength * 0.02 +
        grainMobility * (
          0.0725 + driftRandom * 0.125 + plumeStrength * 0.02
        )
      ),
      liftDistance: height * (
        0.008 + liftRandom * 0.012 + plumeStrength * 0.005 +
        grainMobility * (
          0.035 + liftRandom * 0.028 + plumeStrength * 0.009
        )
      ),
      turbulenceDistance: width * (
        0.002 + grainMobility * 0.006 + mobilityNoise * 0.0015
      ),
      wakeDistance: width * (
        0.032 + driftRandom * 0.021 +
        grainMobility * (0.045 + driftRandom * 0.018)
      ),
      suspensionStrength: 0.1 + grainMobility * 0.85,
      particleAspectRatio: 1.75 + sizeRandom * 0.83 + plumeStrength * 0.46,
      phase,
      activation,
      lifeProgress:
        0.18 + grainFineness * 0.035 + grainMobility * 0.075 +
        plumeStrength * 0.02,
      fadeStartProgress: clamp(
        0.86 + fadeRandom * 0.035 + grainMobility * 0.045,
        0.86,
        0.94,
      ),
      opacityScale: (0.075 + plumeStrength * 0.54) *
        (1 - grainMobility * 0.14),
      wakeGrainCount: 3 + Math.floor(
        hashNoise(index, 28_811, seed + 91_021) * 3,
      ),
      wakeOpacityScale: 0.22 + grainMobility * 0.09,
      fragmentGrainCount: 5 + Math.floor(
        hashNoise(index, 39_137, seed + 107_021) * 4,
      ),
      fragmentSpread: sourceSize * (
        1.45 + hashNoise(index, 45_811, seed + 127_031) * 0.9
      ),
    };
  }

  return samples;
}

/**
 * 建立低解析度、固定上限的顆粒侵蝕遮罩。
 *
 * 遮罩最多 960×540，不會隨 4K 像素數無界增加；每個遮罩像素保存自己的啟動
 * 門檻，再以 counting sort 排好順序，使播放時只更新這一幀新被吹走的像素。
 */
function createErosionMask({ width, height, seed }) {
  const scale = Math.min(
    1 / MASK_TARGET_PIXEL_EDGE,
    MASK_MAXIMUM_WIDTH / width,
    MASK_MAXIMUM_HEIGHT / height,
  );
  const maskWidth = Math.max(1, Math.round(width * scale));
  const maskHeight = Math.max(1, Math.round(height * scale));
  const totalPixelCount = maskWidth * maskHeight;
  const activations = new Uint8Array(totalPixelCount);
  const featherBuckets = new Uint8Array(totalPixelCount);
  const bucketCounts = new Uint32Array(256);
  const pixels = new Uint8ClampedArray(totalPixelCount * 4);
  const deltaPixels = new Uint8ClampedArray(totalPixelCount * 4);

  for (let index = 0; index < totalPixelCount; index += 1) {
    const x = index % maskWidth;
    const y = Math.floor(index / maskWidth);
    const activation = calculateMaskActivation(
      maskWidth === 1 ? 0 : x / (maskWidth - 1),
      maskHeight === 1 ? 0 : y / (maskHeight - 1),
      seed,
    );
    const bucket = clamp(Math.ceil(activation * 255), 1, 255);
    const plumeStrength = calculatePlumeStrength(
      maskWidth === 1 ? 0 : x / (maskWidth - 1),
    );
    activations[index] = bucket;
    featherBuckets[index] = Math.max(1, Math.round((
      EROSION_FEATHER_MINIMUM_PROGRESS +
      plumeStrength * (
        EROSION_FEATHER_MAXIMUM_PROGRESS -
        EROSION_FEATHER_MINIMUM_PROGRESS
      )
    ) * 255));
    bucketCounts[bucket] += 1;
    pixels[index * 4] = 255;
    pixels[index * 4 + 1] = 255;
    pixels[index * 4 + 2] = 255;
    deltaPixels[index * 4] = 255;
    deltaPixels[index * 4 + 1] = 255;
    deltaPixels[index * 4 + 2] = 255;
  }

  const bucketOffsets = new Uint32Array(257);
  for (let bucket = 0; bucket < 256; bucket += 1) {
    bucketOffsets[bucket + 1] = bucketOffsets[bucket] + bucketCounts[bucket];
  }

  const bucketPositions = bucketOffsets.slice(0, 256);
  const revealOrder = new Uint32Array(totalPixelCount);
  for (let index = 0; index < totalPixelCount; index += 1) {
    const bucket = activations[index];
    revealOrder[bucketPositions[bucket]] = index;
    bucketPositions[bucket] += 1;
  }

  return {
    width: maskWidth,
    height: maskHeight,
    totalPixelCount,
    activations,
    pixels,
    deltaPixels,
    featherBuckets,
    bucketOffsets,
    revealOrder,
    previousTarget: 0,
    previousDeltaBounds: null,
    erasedPixelCount: 0,
  };
}

function unionBounds(left, right) {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }

  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return {
    x,
    y,
    width: rightEdge - x,
    height: bottomEdge - y,
  };
}

/** 清掉上一幀的增量 alpha；RGB 固定為白色，不必重建整張 ImageData。 */
function clearDeltaBounds(mask, bounds) {
  if (bounds === null) {
    return;
  }

  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      mask.deltaPixels[(y * mask.width + x) * 4 + 3] = 0;
    }
  }
}

/**
 * 建立帶有真實漸層 alpha 的侵蝕前緣。
 *
 * pixels 是供檢測的累積遮罩；deltaPixels 只保存本幀新增的不透明度，Renderer
 * 可將它局部 destination-out 到持久舊圖，而不必每幀重畫整張圖片。兩個陣列都
 * 會由後續幀原地更新，呼叫端只可在 onFrame 同步讀取。
 */
function createErosionFrame(mask, progress) {
  const maximumFeatherBuckets = EROSION_FEATHER_MAXIMUM_PROGRESS * 255;
  const target = progress >= 1
    ? 255 + maximumFeatherBuckets
    : clamp(progress, 0, 1) * 255;
  const previousDeltaBounds = mask.previousDeltaBounds;
  clearDeltaBounds(mask, previousDeltaBounds);

  let minimumX = mask.width;
  let minimumY = mask.height;
  let maximumX = -1;
  let maximumY = -1;
  const firstCandidateBucket = Math.max(
    1,
    Math.floor(mask.previousTarget - maximumFeatherBuckets),
  );
  const lastCandidateBucket = Math.min(255, Math.ceil(target));

  for (let bucket = firstCandidateBucket; bucket <= lastCandidateBucket; bucket += 1) {
    const start = mask.bucketOffsets[bucket];
    const end = mask.bucketOffsets[bucket + 1];
    for (let orderIndex = start; orderIndex < end; orderIndex += 1) {
      const pixelIndex = mask.revealOrder[orderIndex];
      const featherBucketCount = mask.featherBuckets[pixelIndex];
      const alphaProgress = clamp(
        (target - bucket) / featherBucketCount,
        0,
        1,
      );
      const newAlpha = progress >= 1
        ? 255
        : Math.round(smoothstep(alphaProgress) * 255);
      const alphaIndex = pixelIndex * 4 + 3;
      const previousAlpha = mask.pixels[alphaIndex];

      if (newAlpha <= previousAlpha) {
        continue;
      }

      const x = pixelIndex % mask.width;
      const y = Math.floor(pixelIndex / mask.width);
      const remainingAlpha = 255 - previousAlpha;
      mask.pixels[alphaIndex] = newAlpha;
      mask.deltaPixels[alphaIndex] = Math.round(
        (newAlpha - previousAlpha) / remainingAlpha * 255,
      );
      if (previousAlpha === 0) {
        mask.erasedPixelCount += 1;
      }
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }

  const currentDeltaBounds = maximumX < minimumX
    ? null
    : {
        x: minimumX,
        y: minimumY,
        width: maximumX - minimumX + 1,
        height: maximumY - minimumY + 1,
      };
  const dirtyBounds = unionBounds(previousDeltaBounds, currentDeltaBounds);
  mask.previousDeltaBounds = currentDeltaBounds;
  mask.previousTarget = Math.max(mask.previousTarget, target);

  return {
    width: mask.width,
    height: mask.height,
    activations: mask.activations,
    pixels: mask.pixels,
    deltaPixels: mask.deltaPixels,
    erasedPixelCount: mask.erasedPixelCount,
    totalPixelCount: mask.totalPixelCount,
    dirtyBounds,
  };
}

function createParticleFrame(samples, progress) {
  if (progress <= 0 || progress >= 1) {
    return [];
  }

  const particles = [];

  for (const sample of samples) {
    const age = (progress - sample.activation) / sample.lifeProgress;

    if (age < 0 || age >= 1) {
      continue;
    }

    // 所有顆粒共用向右的 ease-out 風場；位移永遠不超過預先配置的有界距離。
    const travelProgress = age * (2 - age);
    // 較大的砂粒貼近表面跳動，細砂則懸浮上升，兩者共同形成翻滾沙塵。
    const saltationArc = Math.sin(Math.PI * age) ** 0.82;
    const suspensionRise = 1 - (1 - age) ** 1.4;
    const liftProgress =
      saltationArc * (1 - sample.suspensionStrength) * 0.65 +
      suspensionRise * sample.suspensionStrength;
    const turbulenceEnvelope = Math.sin(Math.PI * age);
    const horizontalTurbulence = Math.sin(
      sample.phase + age * 9,
    ) * sample.turbulenceDistance * turbulenceEnvelope;
    const gustStrength = calculateSandGustStrength(
      progress,
      sample.phase / TAU,
    );
    const verticalTurbulence = Math.cos(
      sample.phase * 1.7 + age * 11,
    ) * sample.liftDistance * 0.12 * turbulenceEnvelope * gustStrength;
    const horizontalTravel = Math.max(
      0,
      sample.driftDistance * travelProgress +
        horizontalTurbulence * gustStrength,
    );
    const upwardTravel = Math.max(
      0,
      sample.liftDistance * liftProgress * gustStrength + verticalTurbulence,
    );
    /*
     * 遮罩挖開像素的同一刻，先以較密、較大的原圖碎片留在表面；碎片隨即
     * 拆成細砂並進入風場。這段質量銜接避免「圖片先消失，再另外撒亮點」。
     */
    const fragmentStrength = clamp(1 - age / 0.22, 0, 1);
    const fragmentBlend = Math.sqrt(fragmentStrength);
    const entranceFade = 0.72 + clamp(age / 0.16, 0, 1) * 0.28;
    const size = Math.max(
      1.25,
      sample.sourceSize * (1 + fragmentBlend * 0.2) * (1 - age * 0.38),
    );
    const aspectScale = Math.sqrt(sample.particleAspectRatio);
    const finalFade = calculateSandParticleFinalFade(
      progress,
      sample.fadeStartProgress,
    );
    const airborneOpacity = clamp(
      sample.opacityScale * entranceFade *
        (1 - age) ** 0.78 * finalFade * gustStrength * 1.3,
      0,
      0.55,
    );
    const opacity = clamp(
      airborneOpacity + fragmentBlend * (0.62 - airborneOpacity),
      0,
      0.62,
    );
    const width = size * aspectScale;
    const height = size / aspectScale;
    const rotation = Math.sin(sample.phase + age * 4.5) * 0.12;
    const wakeLength = sample.wakeDistance;
    particles.push({
      sourceX: sample.sourceX,
      sourceY: sample.sourceY,
      sourceSize: sample.sourceSize,
      x: sample.sourceX + horizontalTravel,
      y: sample.sourceY - upwardTravel,
      size,
      width,
      height,
      rotation,
      opacity,
      fragmentStrength,
      fragmentGrainCount: sample.fragmentGrainCount,
      fragmentSpread: sample.fragmentSpread,
      wakeGrainCount: sample.wakeGrainCount,
      wakeLength,
      wakeCurl: sample.sourceSize * (
        3.2 + sample.suspensionStrength * 2.4
      ),
      wakePhase: sample.phase + age * 5,
      wakeOpacityScale: sample.wakeOpacityScale,
      grainMobility: sample.grainMobility,
      finalFade,
    });
  }

  return particles;
}

/**
 * 建立與 DOM、Canvas 解耦的風吹沙時間軸。
 *
 * 引擎只回傳每幀的顆粒遮罩與粒子座標；圖片裁切及繪製方式由呼叫端決定。
 * 建立後不會自行播放，只有呼叫 start 才會向注入的 requestFrame 排程。
 */
export function createSandTransition({
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  onFrame,
  random = Math.random,
  maxParticleCount = DEFAULT_PARTICLE_COUNT,
} = {}) {
  if (
    typeof requestFrame !== 'function' ||
    typeof cancelFrame !== 'function' ||
    typeof onFrame !== 'function' ||
    typeof random !== 'function'
  ) {
    throw new TypeError('風吹沙轉場缺少必要相依函式。');
  }

  if (!Number.isInteger(maxParticleCount) || maxParticleCount <= 0) {
    throw new RangeError('風吹沙轉場的粒子上限必須是正整數。');
  }

  const sampleCount = Math.min(maxParticleCount, HARD_MAXIMUM_PARTICLE_COUNT);
  let disposed = false;
  let running = false;
  let generation = 0;
  let frameHandle = null;
  let startTimestamp = null;
  let transition = null;
  let preparedGeometry = null;

  function createGeometry({ width, height }) {
    const seed = (
      Math.floor(clamp(random(), 0, 1) * 2_147_483_647) ^
      Math.imul(Math.round(width), 73_856_093) ^
      Math.imul(Math.round(height), 19_349_663)
    ) | 0;
    const erosionMask = createErosionMask({ width, height, seed });
    const samples = createSamples({
      width,
      height,
      sampleCount,
      random,
      seed,
      erosionMask,
    });
    return {
      width,
      height,
      samples,
      erosionMask,
    };
  }

  function cancelScheduledFrame() {
    if (frameHandle === null) {
      return;
    }

    cancelFrame(frameHandle);
    frameHandle = null;
  }

  function scheduleFrame(scheduledGeneration) {
    let scheduledHandle = null;
    scheduledHandle = requestFrame((timestamp) => {
      if (
        disposed ||
        !running ||
        scheduledGeneration !== generation ||
        frameHandle !== scheduledHandle
      ) {
        return;
      }

      frameHandle = null;

      if (startTimestamp === null) {
        startTimestamp = timestamp;
      }

      const elapsed = Math.max(0, timestamp - startTimestamp);
      const progress = clamp(elapsed / transition.durationMs, 0, 1);
      const frame = {
        width: transition.width,
        height: transition.height,
        progress,
        sampleCount: transition.samples.length,
        erosionMask: createErosionFrame(transition.erosionMask, progress),
        particles: createParticleFrame(transition.samples, progress),
      };

      try {
        onFrame(frame);
      } catch {
        const fail = transition.onError;
        running = false;
        startTimestamp = null;
        transition = null;
        try {
          fail?.();
        } catch {
          // 失敗清理本身也不得讓 Renderer 事件迴圈中斷。
        }
        return;
      }

      // onFrame 可能同步要求取消或開始下一次轉場，舊幀不得再排程或完成。
      if (disposed || !running || scheduledGeneration !== generation) {
        return;
      }

      if (progress >= 1) {
        const complete = transition.onComplete;
        running = false;
        transition = null;
        complete?.();
        return;
      }

      scheduleFrame(scheduledGeneration);
    });
    frameHandle = scheduledHandle;
  }

  function cancel() {
    if (!running) {
      return false;
    }

    generation += 1;
    running = false;
    startTimestamp = null;
    transition = null;
    cancelScheduledFrame();
    return true;
  }

  return Object.freeze({
    /**
     * 在靜止圖片停留期間預先建立下一輪固定幾何。
     * 同尺寸 start 只會消耗這份資料，不再於轉場起點同步重算。
     */
    prepare(options) {
      if (disposed || running) {
        return false;
      }

      validateGeometryOptions(options);
      preparedGeometry = createGeometry(options);
      return true;
    },

    /**
     * 丟棄尚未開始播放的預建幾何，讓離開待機或切回固定背景時立即釋放記憶體。
     */
    discardPrepared() {
      if (disposed || preparedGeometry === null) {
        return false;
      }

      preparedGeometry = null;
      return true;
    },

    /** 開始一輪新轉場；若上一輪仍執行中，會先使其所有回呼失效。 */
    start(options) {
      if (disposed) {
        return false;
      }

      validateStartOptions(options);
      cancel();
      generation += 1;
      running = true;
      startTimestamp = null;
      const geometry = preparedGeometry?.width === options.width &&
        preparedGeometry?.height === options.height
        ? preparedGeometry
        : createGeometry(options);
      preparedGeometry = null;
      transition = {
        width: geometry.width,
        height: geometry.height,
        durationMs: options.durationMs,
        onComplete: options.onComplete,
        onError: options.onError,
        samples: geometry.samples,
        erosionMask: geometry.erosionMask,
      };
      scheduleFrame(generation);
      return true;
    },

    cancel,

    isRunning() {
      return running;
    },

    /** 永久停止引擎；dispose 後的 start 與 stale callback 都不再生效。 */
    dispose() {
      if (disposed) {
        return;
      }

      cancel();
      preparedGeometry = null;
      disposed = true;
      generation += 1;
    },
  });
}
