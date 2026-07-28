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
  'liquid-surface-model.mjs',
)).href;

const DEFAULT_FRAME_OPTIONS = Object.freeze({
  durationMilliseconds: 10_000,
  height: 240,
  progress: 0.5,
  seed: 0x5a17,
  timeMilliseconds: 5_000,
  width: 1_000,
});

async function loadModel() {
  return import(moduleUrl);
}

function frameAt(createLiquidSurfaceFrame, overrides = {}) {
  return createLiquidSurfaceFrame({
    ...DEFAULT_FRAME_OPTIONS,
    ...overrides,
  });
}

function range(values) {
  return Math.max(...values) - Math.min(...values);
}

function lowPassSurfaceRange(frame, radius = 5) {
  const values = frame.surfacePoints.map(({ y }) => y - frame.surfaceY);
  const coarse = values.map((_value, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    return values.slice(start, end).reduce(
      (total, value) => total + value,
      0,
    ) / (end - start);
  });
  return range(coarse);
}

function projectSurfaceMode(frame, mode) {
  return frame.surfacePoints.reduce((total, point, index, points) =>
    total + (point.y - frame.surfaceY) * Math.cos(
      mode * Math.PI * index / (points.length - 1),
    ), 0);
}

test('流體影格是可任意 seek 的純函式，同一輸入不受呼叫順序影響', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const targetOptions = {
    ...DEFAULT_FRAME_OPTIONS,
    progress: 0.47,
    timeMilliseconds: 4_713,
  };

  const first = createLiquidSurfaceFrame(targetOptions);
  frameAt(createLiquidSurfaceFrame, {
    progress: 0.81,
    timeMilliseconds: 8_137,
  });
  const seekBack = createLiquidSurfaceFrame(targetOptions);

  assert.deepEqual(seekBack, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.surfacePoints), true);
  assert.equal(
    first.surfacePoints.every(Object.isFrozen),
    true,
    'Renderer 不得反向改寫模型輸出的確定性影格',
  );
});

test('液面以多尺度不規則曲線流動，不重播舊 CSS 週期或鋸齒樣板', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const times = [327, 1_157, 1_677, 6_327];
  const frames = times.map((timeMilliseconds) => frameAt(
    createLiquidSurfaceFrame,
    { progress: 0.52, timeMilliseconds },
  ));

  assert.equal(
    new Set(frames.map(({ bodyPath }) => bodyPath)).size,
    frames.length,
    '相隔舊 1.03s／1.55s 週期後不得回到同一個液面樣板',
  );
  assert.ok(
    new Set(frames.map(({ refractionOffset }) => refractionOffset)).size >= 3,
    '內部折射需跟隨物理回流緩慢漂移，不能固定黏在字形同一位置',
  );

  for (const frame of frames) {
    assert.ok(
      frame.surfacePoints.length >= 33 && frame.surfacePoints.length <= 96,
      '曲線需有足夠取樣形成圓滑液面，同時限制 4K 每幀成本',
    );
    assert.match(frame.bodyPath, /^M[\s\S]*[CQcq][\s\S]*Z$/);
    assert.match(frame.meniscusPath, /^M[\s\S]*[CQcq]/);
    assert.doesNotMatch(frame.bodyPath, /polygon|clip-path/i);
    assert.doesNotMatch(frame.meniscusPath, /polygon|clip-path/i);
    assert.ok(
      frame.refractionOffset >= -0.08 && frame.refractionOffset <= 0.08,
    );
    assert.equal(
      frame.surfacePoints.every(({ x, y }) =>
        x >= 0 &&
        x <= DEFAULT_FRAME_OPTIONS.width &&
        y >= 0 &&
        y <= DEFAULT_FRAME_OPTIONS.height),
      true,
      '模型輸出的液面座標不得越出 SVG 畫布',
    );

    const deviations = frame.surfacePoints.map(
      ({ y }) => y - frame.surfaceY,
    );
    const smoothed = deviations.map((value, index, values) => {
      const start = Math.max(0, index - 3);
      const end = Math.min(values.length, index + 4);
      return values.slice(start, end).reduce(
        (total, item) => total + item,
        0,
      ) / (end - start);
    });
    const fineResidual = deviations.map(
      (value, index) => value - smoothed[index],
    );
    const turnIndexes = [];
    let previousDirection = 0;

    for (let index = 1; index < deviations.length; index += 1) {
      const direction = Math.sign(deviations[index] - deviations[index - 1]);
      if (
        direction !== 0 &&
        previousDirection !== 0 &&
        direction !== previousDirection
      ) {
        turnIndexes.push(index);
      }
      if (direction !== 0) {
        previousDirection = direction;
      }
    }

    const turnGaps = turnIndexes.slice(1).map(
      (index, gapIndex) => index - turnIndexes[gapIndex],
    );

    assert.ok(range(smoothed) >= frame.amplitude * 0.2);
    assert.ok(
      range(fineResidual) >= frame.amplitude * 0.04,
      '主波上仍需有次波／回流細節，不能只畫單一正弦波',
    );
    assert.ok(turnIndexes.length >= 3);
    assert.ok(
      new Set(turnGaps).size >= 2,
      '波峰間距必須不規則，不能使用等距交錯 polygon',
    );
  }
});

test('半杯四相位皆有遠距可辨識的大尺度 slosh', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const frames = [480, 2_500, 5_000, 7_500].map(
    (timeMilliseconds) => frameAt(createLiquidSurfaceFrame, {
      progress: 0.5,
      timeMilliseconds,
    }),
  );
  const coarseRanges = frames.map((frame) => lowPassSurfaceRange(frame));
  const sortedRanges = [...coarseRanges].sort((left, right) => left - right);
  const medianRange = (sortedRanges[1] + sortedRanges[2]) / 2;

  assert.equal(
    coarseRanges.every((value) =>
      value >= DEFAULT_FRAME_OPTIONS.height * 0.05),
    true,
    `至少一個相位的大尺度波幅不足字高 5%：${coarseRanges.join(', ')}`,
  );
  assert.ok(
    medianRange >= DEFAULT_FRAME_OPTIONS.height * 0.065,
    `四相位典型大尺度波幅只有 ${medianRange}px；需達字高 6.5%`,
  );
  assert.ok(
    Math.max(...coarseRanges) >= DEFAULT_FRAME_OPTIONS.height * 0.08,
    '至少一個相位需呈現字高 8% 的完整回流峰谷',
  );
  assert.ok(
    Math.max(...coarseRanges) <= DEFAULT_FRAME_OPTIONS.height * 0.15,
    '大尺度 slosh 不得超過字高 15%，避免像沸騰或飛濺',
  );
});

test('液面在單一字形寬度內也必須持續彎曲，不能只讓整列文字一起傾斜', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const frames = [2_000, 4_000, 6_000].map(
    (timeMilliseconds) => frameAt(createLiquidSurfaceFrame, {
      durationMilliseconds: 8_000,
      progress: 0.5,
      timeMilliseconds,
    }),
  );

  for (const frame of frames) {
    const yValues = frame.surfacePoints.map(({ y }) => y);
    let previousDirection = 0;
    let turnCount = 0;
    for (let index = 1; index < yValues.length; index += 1) {
      const direction = Math.sign(yValues[index] - yValues[index - 1]);
      if (
        direction !== 0 &&
        previousDirection !== 0 &&
        direction !== previousDirection
      ) {
        turnCount += 1;
      }
      if (direction !== 0) {
        previousDirection = direction;
      }
    }

    const glyphSpan = Math.max(
      5,
      Math.round(frame.surfacePoints.length * 0.075),
    );
    const localRanges = [];
    for (let index = 0; index <= yValues.length - glyphSpan; index += 1) {
      localRanges.push(range(yValues.slice(index, index + glyphSpan)));
    }
    localRanges.sort((left, right) => left - right);
    const medianLocalRange = localRanges[Math.floor(localRanges.length / 2)];

    assert.ok(turnCount >= 3, `整列只有 ${turnCount} 次回流轉折。`);
    assert.ok(
      turnCount <= 12,
      `整列出現 ${turnCount} 次轉折，過多高頻模態會像電子波形而非酒液`,
    );
    assert.ok(
      medianLocalRange >= frame.amplitude * 0.02,
      `典型字寬內液面只彎曲 ${medianLocalRange}px，無法看出水波蕩漾`,
    );
  }
});

test('主重力波以真實秒數進行數次回流，不可在四秒內像果凍只慢慢翻一次', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const projections = [];

  for (let timeMilliseconds = 400; timeMilliseconds <= 4_400;
    timeMilliseconds += 40) {
    const frame = frameAt(createLiquidSurfaceFrame, {
      progress: 0.5,
      timeMilliseconds,
    });
    projections.push(projectSurfaceMode(frame, 1));
  }

  const signs = projections.map(Math.sign).filter(Boolean);
  const zeroCrossings = signs.slice(1).filter(
    (sign, index) => sign !== signs[index],
  ).length;
  assert.ok(
    zeroCrossings >= 5,
    `主波四秒內只回流 ${zeroCrossings} 個半週期，會像果凍而不是杯內酒液`,
  );
  assert.ok(
    zeroCrossings <= 12,
    `主波四秒內回流 ${zeroCrossings} 個半週期，過快會像抖動或沸騰`,
  );
});

test('液位具有慣性但始終單調上升，首尾精確為空杯與滿杯', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const progressSteps = Array.from({ length: 21 }, (_value, index) =>
    index / 20);
  const frames = progressSteps.map((progress) => frameAt(
    createLiquidSurfaceFrame,
    {
      progress,
      timeMilliseconds: progress * DEFAULT_FRAME_OPTIONS.durationMilliseconds,
    },
  ));
  const fillRatios = frames.map(({ fillRatio }) => fillRatio);
  const increments = fillRatios.slice(1).map(
    (value, index) => value - fillRatios[index],
  );

  assert.equal(fillRatios[0], 0);
  assert.equal(fillRatios.at(-1), 1);
  assert.equal(
    increments.every((increment) => increment >= 0),
    true,
    '酒液不得因晃動而整體倒退',
  );
  assert.ok(
    range(increments) >= 0.015,
    '液位增量必須有加速與減速，不能是等速進度條',
  );
  assert.ok(
    frames[2].fillRatio >= 0.04 && frames[2].fillRatio <= 0.1,
    '10% 時應已看得到杯底酒液，不能前四分之一幾乎保持全空',
  );
  assert.ok(
    frames[5].fillRatio >= 0.16 && frames[5].fillRatio < 0.25,
    '25% 時保留入酒慣性，但不可只填到約一成而顯得停滯',
  );
  assert.ok(
    frames[15].fillRatio >= 0.7 && frames[15].fillRatio <= 0.76,
    '75% 時應保留最後四分之一的可見容量，不能提早接近滿杯',
  );
  assert.ok(
    frames[18].fillRatio >= 0.86 && frames[18].fillRatio <= 0.92,
    '90% 時仍需留下肉眼可見的杯口空間，不能看起來已經倒滿',
  );

  const almostFinished = atProgress(createLiquidSurfaceFrame, 0.99);
  assert.ok(
    almostFinished.fillRatio >= 0.985 && almostFinished.fillRatio < 1,
    '99% 時應自然接近杯口，不可把最後 4% 壓進單一 30fps 畫面',
  );
  assert.ok(
    atProgress(createLiquidSurfaceFrame, 0.992).fillRatio >
      almostFinished.fillRatio,
    '期限前液位仍需平順向杯口推進',
  );
  assert.ok(
    atProgress(createLiquidSurfaceFrame, 0.995).fillRatio >= 0.99,
    '最後 0.5% 應只留下細小杯口空隙，不可突然衝高',
  );
  assert.ok(
    atProgress(createLiquidSurfaceFrame, 0.999).fillRatio < 1,
    '期限結束前的任何有限進度都不得完全滿杯',
  );
  assert.equal(
    atProgress(createLiquidSurfaceFrame, 1).fillRatio,
    1,
    '訊息顯示期限的最後一幀必須精確倒滿',
  );

  const fineProgress = Array.from({ length: 1_001 }, (_value, index) =>
    index / 1_000);
  const fineFill = fineProgress.map((progress) =>
    atProgress(createLiquidSurfaceFrame, progress).fillRatio);
  const maximumSlope = Math.max(...fineFill.slice(1).map(
    (value, index) => (value - fineFill[index]) * 1_000,
  ));
  assert.ok(
    maximumSlope <= 1.5,
    `液位曲線最大斜率 ${maximumSlope}，代表期限前仍有不自然的衝頂`,
  );
});

test('波幅受現有酒深與杯口空間限制，不可被畫布上下邊硬切平', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();

  for (const progress of [0.05, 0.1, 0.25, 0.75, 0.9, 0.95]) {
    const frame = atProgress(createLiquidSurfaceFrame, progress);
    assert.equal(
      frame.surfacePoints.every(({ y }) =>
        y > 0.05 && y < DEFAULT_FRAME_OPTIONS.height - 0.05),
      true,
      `${progress * 100}% 液位的波面被容器邊界硬切斷`,
    );
  }
});

test('液位由同一個單次流量積分，流量在期限終點自然降為零', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const frames = Array.from({ length: 201 }, (_value, index) =>
    atProgress(createLiquidSurfaceFrame, index / 200));

  assert.equal(frames[0].pour.flowRate, 0);
  assert.equal(frames.at(-1).pour.flowRate, 0);
  assert.ok(frames.slice(10, 180).every(({ pour }) => pour.flowRate > 0));
  assert.equal(
    frames.slice(1, -1).every((frame, index) =>
      frame.fillRatio > frames[index].fillRatio &&
      frame.fillRatio < frames[index + 2].fillRatio),
    true,
    '只要還在倒酒，累積液位就必須連續上升',
  );
  assert.ok(frames.at(-2).fillRatio < 1);
  assert.ok(
    frames.at(-2).pour.flowRate < frames[190].pour.flowRate,
    '結束前的入流需自然收尾，不可到 100% 才瞬間斷流',
  );
});

function atProgress(createLiquidSurfaceFrame, progress) {
  return frameAt(createLiquidSurfaceFrame, {
    progress,
    timeMilliseconds: progress * DEFAULT_FRAME_OPTIONS.durationMilliseconds,
  });
}

test('注入位置的亂數必須覆蓋左右兩側，且永遠位於文字容器內', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const sourceRatios = [];

  for (let seed = 1; seed <= 64; seed += 1) {
    for (let timeMilliseconds = 80; timeMilliseconds <= 6_400;
      timeMilliseconds += 320) {
      sourceRatios.push(frameAt(createLiquidSurfaceFrame, {
        seed,
        timeMilliseconds,
      }).surfaceFocus.sourceXRatio);
    }
  }

  assert.ok(Math.min(...sourceRatios) >= 0.14);
  assert.ok(Math.max(...sourceRatios) <= 0.86);
  assert.ok(
    sourceRatios.some((ratio) => ratio < 0.4) &&
      sourceRatios.some((ratio) => ratio > 0.6),
    '注入動量不可因 signed hash 錯誤全部偏在左半部',
  );
});

test('Renderer 可將撞擊點 snap 至 glyph alpha 可見欄位', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  /*
   * Renderer 擁有 cached glyph alpha，因此由 Renderer 找出可見筆畫
   * 欄位，再以正規化座標覆寫模型的 seed 預設點。模型必須
   * 精確採用這個座標，否則撞擊凹陷仍會落在透明字腔而看不見。
   */
  const snappedSourceRatios = [0.22, 0.78];
  const frames = snappedSourceRatios.map((sourceXRatio) => frameAt(
    createLiquidSurfaceFrame,
    { sourceXRatio },
  ));

  assert.deepEqual(
    frames.map(({ pour }) => pour.sourceXRatio),
    snappedSourceRatios,
    '模型必須接受 Renderer 依 glyph alpha 選出的精確撞擊欄位',
  );
  assert.deepEqual(
    frames.map(({ surfaceFocus }) => surfaceFocus.sourceXRatio),
    snappedSourceRatios,
    '可見撞擊焦點必須與 renderer snap 後的液面欄位完全一致',
  );
  assert.notEqual(
    frames[0].bodyPath,
    frames[1].bodyPath,
    '撞擊點從左側筆畫移到右側筆畫時，液面凹陷幾何必須跟著移動',
  );
});

test('注入事件開始與退出都必須連續，不得在相鄰 1ms 讓液面瞬移', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const height = DEFAULT_FRAME_OPTIONS.height;
  let previous = frameAt(createLiquidSurfaceFrame, {
    seed: 3,
    timeMilliseconds: 0,
  });
  let maximumJump = 0;

  for (let timeMilliseconds = 1; timeMilliseconds <= 8_000;
    timeMilliseconds += 1) {
    const current = frameAt(createLiquidSurfaceFrame, {
      seed: 3,
      timeMilliseconds,
    });
    const jump = Math.max(...current.surfacePoints.map((point, index) =>
      Math.abs(point.y - previous.surfacePoints[index].y)));
    maximumJump = Math.max(maximumJump, jump);
    previous = current;
  }

  assert.ok(
    maximumJump <= height * 0.015,
    `液面在 1ms 內跳動 ${maximumJump}px，代表注入不是連續受力`,
  );
});

test('容器左右壁維持近似零斜率，反射波不可在邊界折出尖角', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();

  for (const timeMilliseconds of [417, 1_936, 3_771, 6_208]) {
    const frame = frameAt(createLiquidSurfaceFrame, { timeMilliseconds });
    const points = frame.surfacePoints;
    const leftSlope = Math.abs(points[1].y - points[0].y);
    const rightSlope = Math.abs(points.at(-1).y - points.at(-2).y);

    assert.ok(
      leftSlope <= frame.amplitude * 0.08,
      `左側容器壁斜率過大：${leftSlope}px`,
    );
    assert.ok(
      rightSlope <= frame.amplitude * 0.08,
      `右側容器壁斜率過大：${rightSlope}px`,
    );
  }
});

test('注入後先建立晃動，最後 10～15% 依阻尼連續沉降', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const at = (progress) => frameAt(createLiquidSurfaceFrame, {
    progress,
    timeMilliseconds: progress * DEFAULT_FRAME_OPTIONS.durationMilliseconds,
  });
  const entry = [at(0), at(0.006), at(0.024), at(0.08)];
  const settling = [at(0.84), at(0.9), at(0.94), at(0.97), at(0.99), at(1)];

  assert.equal(entry[0].amplitude, 0);
  assert.ok(entry[1].amplitude > 0);
  assert.ok(entry[2].amplitude > entry[1].amplitude);
  assert.ok(entry[3].amplitude >= entry[2].amplitude * 0.9);
  assert.ok(settling[0].amplitude > settling[1].amplitude);
  assert.ok(settling[1].amplitude > settling[2].amplitude);
  assert.ok(settling[2].amplitude > settling[3].amplitude);
  assert.ok(settling[3].amplitude > settling[4].amplitude);
  assert.equal(settling.at(-1).amplitude, 0);
  assert.equal(settling.at(-1).meniscusOpacity, 0);

  const nearlyFull = at(0.999);
  assert.ok(
    nearlyFull.meniscusOpacity <= 0.02,
    '液面收平時高光也必須連續淡出，不能在 100% 前一幀突然消失',
  );
});

test('最後 15% 可見幾何波幅必須單調衰減，不得因回流相位反彈', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const progressSteps = [0.85, 0.9, 0.95, 0.99, 1];
  /*
   * 使用 v10 真實 4K QA 第二列 Nancy 的 production 尺寸與
   * deterministic seed；這個字型寬高比會揭露 envelope 數值下降、
   * 但真正 surfacePoints 峰谷範圍反而變大的相位反彈。
   */
  const productionFrame = Object.freeze({
    durationMilliseconds: 4_000,
    height: 121.28400421142578,
    seed: 2_301_248_780,
    width: 806,
  });
  const visibleRanges = progressSteps.map((progress) => {
    const frame = frameAt(createLiquidSurfaceFrame, {
      ...productionFrame,
      progress,
      timeMilliseconds: progress * productionFrame.durationMilliseconds,
    });
    return range(frame.surfacePoints.map(({ y }) => y));
  });
  const epsilon = productionFrame.height * 0.0001;
  const rebounds = visibleRanges.slice(1).flatMap((value, index) =>
    value <= visibleRanges[index] + epsilon
      ? []
      : [{
        after: value,
        before: visibleRanges[index],
        from: progressSteps[index],
        to: progressSteps[index + 1],
      }]);

  assert.deepEqual(
    rebounds,
    [],
    `最後 15% 的可見液面峰谷不得反彈：${progressSteps.map(
      (progress, index) => `${progress}=${visibleRanges[index].toFixed(4)}`,
    ).join(', ')}`,
  );
  assert.equal(visibleRanges.at(-1), 0);
});

test('停止受力後保留自由回流，不得把注入力與剩餘波能當成同一數值', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const beforeStop = atProgress(createLiquidSurfaceFrame, 0.8499);
  const afterStop = atProgress(createLiquidSurfaceFrame, 0.8501);
  const later = atProgress(createLiquidSurfaceFrame, 0.9);

  assert.ok(beforeStop.pour.forcing > 0);
  assert.equal(afterStop.pour.forcing, 0);
  assert.ok(afterStop.pour.waveEnergy > 0);
  assert.ok(
    afterStop.pour.waveEnergy >= beforeStop.pour.waveEnergy * 0.9,
    '斷流後第一幀不得把杯內慣性一起消失',
  );
  assert.ok(later.pour.waveEnergy < afterStop.pour.waveEnergy);
  assert.notEqual(afterStop.pour.waveVelocity, 0);
  assert.equal(atProgress(createLiquidSurfaceFrame, 1).pour.waveEnergy, 0);
});

test('單次連續倒酒只 attack 一次，顯示秒數不得改變倒酒次數', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  for (const durationMilliseconds of [3_000, 10_000, 60_000]) {
    const frames = Array.from({ length: 101 }, (_value, index) => {
      const progress = index / 100;
      return frameAt(createLiquidSurfaceFrame, {
        durationMilliseconds,
        progress,
        timeMilliseconds: progress * durationMilliseconds,
      });
    });
    const attackCount = frames.slice(1).filter((frame, index) =>
      frames[index].pour.energy <= 0.05 && frame.pour.energy > 0.05).length;

    assert.equal(attackCount, 1, `${durationMilliseconds}ms 只能開始倒酒一次`);
    assert.deepEqual(
      [...new Set(frames.map(({ pour }) => pour.episodeIndex))],
      [0],
      '整頁只能存在一個連續 pour episode，不得隨秒數新增事件',
    );
    assert.equal(
      frames.slice(12, 83).every(({ pour }) => pour.energy > 0.2),
      true,
      '持續注入期間能量不可每隔固定時間歸零再 attack',
    );
    const settlingEnergy = frames.slice(85).map(({ pour }) => pour.energy);
    assert.equal(
      settlingEnergy.slice(1).every(
        (value, index) => value <= settlingEnergy[index] + 0.0001,
      ),
      true,
      '最後 15% 只能阻尼沉降，不得再次補一個撞擊脈衝',
    );
  }
});

test('單一撞擊點連續漂移，先壓低液面再向左右傳播與回流', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const frames = Array.from({ length: 181 }, (_value, index) => frameAt(
    createLiquidSurfaceFrame,
    {
      progress: 0.55,
      timeMilliseconds: 40 + (index * 40),
    },
  ));
  const activeFrames = frames.filter(
    ({ surfaceFocus }) => surfaceFocus.opacity >= 0.12,
  );

  assert.ok(activeFrames.length >= 12, '連續倒入時必須有可辨識的局部液面反應');
  assert.deepEqual(
    [...new Set(activeFrames.map(({ surfaceFocus }) =>
      surfaceFocus.episodeIndex))],
    [0],
    '撞擊點只能屬於同一次倒酒，不得每 0.82 秒換一個事件',
  );
  assert.equal(
    activeFrames.every(({ surfaceFocus }) =>
      !Object.hasOwn(surfaceFocus, 'eventIndex')),
    true,
    '舊的離散 eventIndex 不得留在正式物理模型',
  );

  const adjacentFocusJumps = activeFrames.slice(1).map((frame, index) => ({
    opacity: Math.abs(
      frame.surfaceFocus.opacity - activeFrames[index].surfaceFocus.opacity,
    ),
    x: Math.abs(
      frame.surfaceFocus.sourceX - activeFrames[index].surfaceFocus.sourceX,
    ),
  }));
  assert.ok(
    Math.max(...adjacentFocusJumps.map(({ opacity }) => opacity)) <= 0.12,
    '局部焦點不得瞬間熄滅再亮起',
  );
  assert.ok(
    Math.max(...adjacentFocusJumps.map(({ x }) => x)) <=
      DEFAULT_FRAME_OPTIONS.width * 0.012,
    '撞擊位置只能平順漂移，不得瞬間跳到另一處',
  );

  const strongest = activeFrames.reduce((selected, frame) =>
    frame.surfaceFocus.opacity > selected.surfaceFocus.opacity
      ? frame
      : selected);
  const focus = strongest.surfaceFocus;
  const closestIndex = strongest.surfacePoints.reduce(
    (selected, point, index, points) =>
      Math.abs(point.x - focus.sourceX) <
        Math.abs(points[selected].x - focus.sourceX)
        ? index
        : selected,
    0,
  );
  const localDisplacement =
    strongest.surfacePoints[closestIndex].y - strongest.surfaceY;
  const shoulderDistance = Math.max(
    2,
    Math.round(strongest.surfacePoints.length * 0.09),
  );
  const shoulders = [
    strongest.surfacePoints[Math.max(0, closestIndex - shoulderDistance)],
    strongest.surfacePoints[Math.min(
      strongest.surfacePoints.length - 1,
      closestIndex + shoulderDistance,
    )],
  ];
  const shoulderDisplacement = shoulders.reduce(
    (total, point) => total + point.y - strongest.surfaceY,
    0,
  ) / shoulders.length;
  const impactDimpleDepth = localDisplacement - shoulderDisplacement;

  assert.ok(
    impactDimpleDepth >= DEFAULT_FRAME_OPTIONS.height * 0.04,
    `撞擊凹陷只有 ${impactDimpleDepth}px；至少需達字高 4% 才能和大尺度 slosh 分離`,
  );
  assert.ok(
    impactDimpleDepth >= range(
      strongest.surfacePoints.map(({ y }) => y),
    ) * 0.42,
    '局部撞擊不得被整體波面吃掉；凹陷至少應佔同幀可見波幅 42%',
  );
  assert.match(focus.path, /^M[\s\S]*[CQcq][\s\S]*Z$/);
  assert.equal(focus.surfaceY, strongest.surfaceY);
  assert.ok(focus.sourceX >= 0 && focus.sourceX <= DEFAULT_FRAME_OPTIONS.width);
  assert.ok(focus.propagationRadius > 0);

  const sameEpisode = activeFrames.slice().sort((left, right) =>
    left.surfaceFocus.ageMilliseconds - right.surfaceFocus.ageMilliseconds);
  assert.ok(sameEpisode.length >= 3);
  assert.ok(
    sameEpisode.at(-1).surfaceFocus.propagationRadius >
      sameEpisode[0].surfaceFocus.propagationRadius,
    '受擾動區域必須由注入點向兩側擴散',
  );
  assert.ok(
    new Set(sameEpisode.map(({ surfaceFocus }) => surfaceFocus.path)).size >= 3,
    '局部液面弧線必須隨傳播與回流持續變形',
  );
});

test('捲入空氣形成有限且不規則的杯內氣泡，氣泡隨回流上浮並受液面裁切', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const first = atProgress(createLiquidSurfaceFrame, 0.45);
  const later = frameAt(createLiquidSurfaceFrame, {
    progress: 0.46,
    timeMilliseconds: 4_600,
  });

  for (const frame of [first, later]) {
    assert.ok(frame.bubbles.length >= 1 && frame.bubbles.length <= 16);
    assert.equal(Object.isFrozen(frame.bubbles), true);
    assert.equal(frame.bubbles.every(Object.isFrozen), true);
    assert.match(frame.bubbleBodyPath, /^M[\s\S]*[Aa][\s\S]*Z$/);
    assert.match(frame.bubbleHighlightPath, /^M[\s\S]*[Aa]/);
    assert.equal(
      new Set(frame.bubbles.map(({ radius }) => radius)).size,
      frame.bubbles.length,
      '同一幀內每顆有限生命週期氣泡都應保有不同半徑',
    );

    for (const bubble of frame.bubbles) {
      const position = (bubble.x / DEFAULT_FRAME_OPTIONS.width) *
        (frame.surfacePoints.length - 1);
      const lowerIndex = Math.floor(position);
      const upperIndex = Math.min(
        frame.surfacePoints.length - 1,
        lowerIndex + 1,
      );
      const localProgress = position - lowerIndex;
      const localSurfaceY = frame.surfacePoints[lowerIndex].y +
        (frame.surfacePoints[upperIndex].y - frame.surfacePoints[lowerIndex].y) *
          localProgress;

      assert.ok(bubble.x >= 0 && bubble.x <= DEFAULT_FRAME_OPTIONS.width);
      assert.ok(bubble.y - bubble.radius >= localSurfaceY - 0.001);
      assert.ok(bubble.y + bubble.radius <= DEFAULT_FRAME_OPTIONS.height);
      assert.ok(bubble.opacity > 0 && bubble.opacity <= 1);
    }
  }

  const viewingFrames = [0.45, 0.55, 0.65, 0.75].map((progress) =>
    atProgress(createLiquidSurfaceFrame, progress));
  const radii = viewingFrames.flatMap(({ bubbles }) =>
    bubbles.map(({ radius }) => radius)).sort((left, right) => left - right);
  const medianRadius = radii[Math.floor(radii.length / 2)];
  const largeBubbleCount = radii.filter((radius) =>
    radius >= DEFAULT_FRAME_OPTIONS.height * 0.022).length;

  assert.ok(radii.length >= 8, '正常觀看區間需有足夠樣本驗證尺寸分布');
  assert.ok(
    medianRadius >= DEFAULT_FRAME_OPTIONS.height * 0.018,
    `典型氣泡半徑只有 ${medianRadius}px；至少需達字高 1.8%`,
  );
  assert.ok(
    Math.max(...radii) >= DEFAULT_FRAME_OPTIONS.height * 0.03,
    '至少一顆氣泡半徑需達字高 3%（直徑 6%），遠距才辨識得出氣泡',
  );
  assert.ok(
    largeBubbleCount >= Math.ceil(radii.length * 0.25),
    '至少四分之一氣泡半徑需達字高 2.2%，不能全是微小亮點',
  );
  assert.ok(
    Math.min(...radii) <= DEFAULT_FRAME_OPTIONS.height * 0.016,
    '仍需保留小泡，避免所有氣泡成為同尺寸圓點',
  );

  const laterById = new Map(later.bubbles.map((bubble) => [bubble.id, bubble]));
  const shared = first.bubbles.filter((bubble) => laterById.has(bubble.id));
  assert.ok(shared.length >= 1, '相鄰影格需保留同一批氣泡，不能每幀重新亂數閃爍');
  assert.ok(
    shared.filter((bubble) => laterById.get(bubble.id).y <= bubble.y).length >=
      Math.ceil(shared.length * 0.6),
    '多數氣泡需受浮力向液面上升，並允許少數被回流短暫帶下',
  );

  assert.deepEqual(atProgress(createLiquidSurfaceFrame, 0).bubbles, []);
  assert.deepEqual(atProgress(createLiquidSurfaceFrame, 1).bubbles, []);
});

test('氣泡是有限出生事件，斷流後不再新生但既有氣泡繼續上浮', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const stopped = atProgress(createLiquidSurfaceFrame, 0.86);
  const later = atProgress(createLiquidSurfaceFrame, 0.88);
  const stoppedIds = new Set(stopped.bubbles.map(({ id }) => id));
  const laterIds = new Set(later.bubbles.map(({ id }) => id));
  const sharedIds = [...laterIds].filter((id) => stoppedIds.has(id));

  assert.ok(stoppedIds.size > 0 && laterIds.size > 0);
  assert.equal(
    [...laterIds].every((id) => stoppedIds.has(id)),
    true,
    '停止注入後不得用 modulo 週期從杯底重生氣泡',
  );
  assert.ok(sharedIds.length > 0);
  const stoppedById = new Map(stopped.bubbles.map((bubble) => [bubble.id, bubble]));
  assert.ok(sharedIds.some((id) =>
    later.bubbles.find((bubble) => bubble.id === id).y <
      stoppedById.get(id).y));
});

test('酒體具有兩層不同步折射與隨液面的局部焦散，不退化為單色進度填色', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const frames = [480, 2_500, 5_000, 7_500].map(
    (timeMilliseconds) => frameAt(createLiquidSurfaceFrame, {
      progress: 0.5,
      timeMilliseconds,
    }),
  );

  for (const frame of frames) {
    assert.equal(frame.refractionLayers.length, 2);
    assert.equal(Object.isFrozen(frame.refractionLayers), true);
    assert.equal(frame.refractionLayers.every(Object.isFrozen), true);
    assert.notDeepEqual(frame.refractionLayers[0], frame.refractionLayers[1]);
    assert.ok(frame.refractionLayers.every(({ opacity }) => opacity > 0));
    assert.ok(frame.caustic.opacity >= 0 && frame.caustic.opacity <= 1);
    assert.ok(frame.caustic.centerY >= frame.surfaceY);
    assert.ok(frame.caustic.centerY <= DEFAULT_FRAME_OPTIONS.height);
    assert.ok(frame.caustic.radiusX > 0 && frame.caustic.radiusY > 0);
  }

  const span = (selector) => range(frames.map(selector));
  const primaryEffectiveX = span((frame) =>
    frame.refractionLayers[0].offsetX +
      frame.refractionOffset * DEFAULT_FRAME_OPTIONS.width);
  const secondaryX = span((frame) => frame.refractionLayers[1].offsetX);
  const primaryRotation = span(
    (frame) => frame.refractionLayers[0].rotation,
  );
  const secondaryRotation = span(
    (frame) => frame.refractionLayers[1].rotation,
  );
  const causticRelativeX = span((frame) =>
    frame.caustic.centerX - frame.surfaceFocus.sourceX);
  const causticRelativeY = span((frame) =>
    frame.caustic.centerY - frame.surfaceY);
  const causticRotation = span((frame) => frame.caustic.rotation);

  assert.ok(
    primaryEffectiveX >= DEFAULT_FRAME_OPTIONS.width * 0.09,
    `主折射總位移僅 ${primaryEffectiveX}px；需達字寬 9%`,
  );
  assert.ok(
    secondaryX >= DEFAULT_FRAME_OPTIONS.width * 0.075,
    `次折射總位移僅 ${secondaryX}px；需達字寬 7.5%`,
  );
  assert.ok(
    primaryRotation >= 6 && secondaryRotation >= 5,
    '兩層折射旋轉幅度需分別達 6°/5°，否則寬漸層看似靜止',
  );
  assert.ok(
    causticRelativeX >= DEFAULT_FRAME_OPTIONS.width * 0.055,
    `焦散相對撞擊點只漂移 ${causticRelativeX}px；需達字寬 5.5%`,
  );
  assert.ok(
    causticRelativeY >= DEFAULT_FRAME_OPTIONS.height * 0.035,
    `焦散垂直漂移只有 ${causticRelativeY}px；需達字高 3.5%`,
  );
  assert.ok(
    causticRotation >= 12,
    `焦散旋轉總幅僅 ${causticRotation}°；需達 12° 才有流體折射感`,
  );

  const directionSamples = frames.filter(({ pour, refractionLayers }) =>
    Math.abs(pour.waveVelocity) >= 0.02 &&
    Math.abs(refractionLayers[0].offsetX) >= 0.02);
  assert.ok(directionSamples.length >= 2);
  assert.equal(
    directionSamples.every(({ pour, refractionLayers }) =>
      Math.sign(pour.waveVelocity) ===
        Math.sign(refractionLayers[0].offsetX)),
    true,
    '主折射方向必須跟隨同幀液面速度，不能自己播另一組 sine',
  );
});

test('0% 與 100% 端點完全收平，酒液不可能越出字形遮罩', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const empty = frameAt(createLiquidSurfaceFrame, {
    progress: 0,
    timeMilliseconds: 0,
  });
  const full = frameAt(createLiquidSurfaceFrame, {
    progress: 1,
    timeMilliseconds: DEFAULT_FRAME_OPTIONS.durationMilliseconds,
  });

  assert.deepEqual(
    {
      amplitude: empty.amplitude,
      bodyOpacity: empty.bodyOpacity,
      fillRatio: empty.fillRatio,
      meniscusOpacity: empty.meniscusOpacity,
      refractionOffset: empty.refractionOffset,
      surfaceY: empty.surfaceY,
      yValues: [...new Set(empty.surfacePoints.map(({ y }) => y))],
    },
    {
      amplitude: 0,
      bodyOpacity: 0,
      fillRatio: 0,
      meniscusOpacity: 0,
      refractionOffset: 0,
      surfaceY: DEFAULT_FRAME_OPTIONS.height,
      yValues: [DEFAULT_FRAME_OPTIONS.height],
    },
  );
  assert.deepEqual(
    {
      causticOpacity: empty.caustic.opacity,
      focusOpacity: empty.surfaceFocus.opacity,
      focusPath: empty.surfaceFocus.path,
      refractionOpacities: empty.refractionLayers.map(({ opacity }) => opacity),
    },
    {
      causticOpacity: 0,
      focusOpacity: 0,
      focusPath: '',
      refractionOpacities: [0, 0],
    },
  );
  assert.deepEqual(
    {
      amplitude: full.amplitude,
      bodyOpacity: full.bodyOpacity,
      fillRatio: full.fillRatio,
      meniscusOpacity: full.meniscusOpacity,
      refractionOffset: full.refractionOffset,
      surfaceY: full.surfaceY,
      yValues: [...new Set(full.surfacePoints.map(({ y }) => y))],
    },
    {
      amplitude: 0,
      bodyOpacity: 1,
      fillRatio: 1,
      meniscusOpacity: 0,
      refractionOffset: 0,
      surfaceY: 0,
      yValues: [0],
    },
  );
  assert.deepEqual(
    {
      causticOpacity: full.caustic.opacity,
      focusOpacity: full.surfaceFocus.opacity,
      focusPath: full.surfaceFocus.path,
      refractionMotion: full.refractionLayers.map((layer) => ({
        offsetX: layer.offsetX,
        offsetY: layer.offsetY,
        rotation: layer.rotation,
      })),
      bubbles: full.bubbles,
    },
    {
      causticOpacity: 0,
      focusOpacity: 0,
      focusPath: '',
      refractionMotion: [
        { offsetX: 0, offsetY: 0, rotation: 0 },
        { offsetX: 0, offsetY: 0, rotation: 0 },
      ],
      bubbles: [],
    },
    '100% 時注入焦點與折射運動必須一起收斂，滿杯保持平穩',
  );
});

test('流體模型拒絕無效時間、進度與畫布尺寸', async () => {
  const { createLiquidSurfaceFrame } = await loadModel();
  const invalidOverrides = [
    { progress: -0.001 },
    { progress: 1.001 },
    { progress: Number.NaN },
    { timeMilliseconds: -1 },
    { timeMilliseconds: Infinity },
    { durationMilliseconds: 0 },
    { width: 0 },
    { height: 0 },
  ];

  for (const overrides of invalidOverrides) {
    assert.throws(
      () => frameAt(createLiquidSurfaceFrame, overrides),
      /progress|time|duration|width|height|進度|時間|尺寸/i,
    );
  }
});
