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
  'message-liquid-progress.mjs',
)).href;

function finitePage(overrides = {}) {
  return {
    mode: 'page',
    pageDurationSeconds: 4,
    pageNumber: 1,
    pageCount: 2,
    roundNumber: 1,
    totalRounds: 2,
    revision: 7,
    ...overrides,
  };
}

function createFakeTarget({
  includeFinishedPromise = false,
  throwOnAnimate = false,
} = {}) {
  const properties = new Map();
  const animations = [];

  return {
    animations,
    style: {
      setProperty(name, value) {
        properties.set(name, value);
      },
      removeProperty(name) {
        properties.delete(name);
      },
      getPropertyValue(name) {
        return properties.get(name) ?? '';
      },
    },
    animate(keyframes, options) {
      if (throwOnAnimate) {
        throw new Error('synthetic WAAPI failure');
      }
      let resolveFinished = null;
      const finished = includeFinishedPromise
        ? new Promise((resolve) => {
            resolveFinished = resolve;
          })
        : null;
      const animation = {
        cancelled: false,
        currentTime: 0,
        finished,
        keyframes,
        options,
        cancel() {
          this.cancelled = true;
        },
        resolveFinished() {
          this.currentTime = options.duration;
          resolveFinished?.();
        },
      };
      animations.push(animation);
      return animation;
    },
  };
}

function createFrameHarness() {
  let nextId = 1;
  const callbacks = new Map();

  return {
    cancelFrame(id) {
      callbacks.delete(id);
    },
    pendingCount() {
      return callbacks.size;
    },
    requestFrame(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    step(timestamp = 0) {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of entries) {
        callback(timestamp);
      }
    },
  };
}

test('每一頁的新訊息都從空杯開始，並在該頁停留結束時精確注滿', async () => {
  const { createMessageLiquidTimeline } = await import(moduleUrl);
  const pages = [
    finitePage(),
    finitePage({ pageNumber: 2, revision: 8 }),
    finitePage({ roundNumber: 2, revision: 9 }),
    finitePage({ pageNumber: 2, roundNumber: 2, revision: 10 }),
  ].map(createMessageLiquidTimeline);

  assert.deepEqual(
    pages.map(({ stepNumber, totalSteps, startProgress, endProgress }) => ({
      stepNumber,
      totalSteps,
      startProgress,
      endProgress,
    })),
    [
      { stepNumber: 1, totalSteps: 4, startProgress: 0, endProgress: 1 },
      { stepNumber: 2, totalSteps: 4, startProgress: 0, endProgress: 1 },
      { stepNumber: 3, totalSteps: 4, startProgress: 0, endProgress: 1 },
      { stepNumber: 4, totalSteps: 4, startProgress: 0, endProgress: 1 },
    ],
  );

  for (const page of pages) {
    assert.equal(page.keyframes[0]['--message-liquid-level'], '0%');
    assert.equal(page.keyframes.at(-1)['--message-liquid-level'], '100%');
  }

  assert.equal(pages[0].keyframes[0]['--message-liquid-level'], '0%');
  assert.equal(
    pages.at(-1).keyframes.at(-1)['--message-liquid-level'],
    '100%',
  );
  assert.equal(
    pages.flatMap(({ keyframes }) => keyframes).every((keyframe) =>
      Object.hasOwn(keyframe, '--message-liquid-level') &&
      !Object.hasOwn(keyframe, '--message-liquid-wave') &&
      !Object.hasOwn(keyframe, '--message-liquid-agitation') &&
      !Object.hasOwn(keyframe, '--message-outline-color') &&
      !Object.hasOwn(keyframe, 'color') &&
      !Object.hasOwn(keyframe, 'webkitTextStrokeColor') &&
      !Object.hasOwn(keyframe, 'webkitTextFillColor')),
    true,
    '時間軸只提供可定位進度；波形、外框與填色由 SVG 流體 Renderer 管理',
  );
  assert.equal(pages.at(-1).durationMilliseconds, 4_000);
});

test('單頁進度從 0% 至 100%，不再把假波形編碼進 CSS keyframe', async () => {
  const { createMessageLiquidTimeline } = await import(moduleUrl);
  const timeline = createMessageLiquidTimeline(finitePage({
    pageCount: 1,
    totalRounds: 1,
  }));

  const first = timeline.keyframes[0];
  const last = timeline.keyframes.at(-1);

  assert.deepEqual(first, {
    offset: 0,
    '--message-liquid-level': '0%',
  });
  assert.deepEqual(last, {
    offset: 1,
    '--message-liquid-level': '100%',
  });
  assert.equal(
    timeline.keyframes.every((keyframe, index, keyframes) =>
      index === 0 || keyframe.offset > keyframes[index - 1].offset),
    true,
    '所有進度 offset 必須嚴格遞增，避免 seek 時跳格',
  );
  assert.equal(
    timeline.keyframes.every((keyframe) =>
      !Object.hasOwn(keyframe, '--message-liquid-wave') &&
      !Object.hasOwn(keyframe, '--message-liquid-agitation')),
    true,
  );
});

test('大量頁面仍各自使用完整液位，禁止重新產生 CSS 波浪參數', async () => {
  const { createMessageLiquidTimeline } = await import(moduleUrl);
  const timeline = createMessageLiquidTimeline(finitePage({
    pageDurationSeconds: 60,
    pageCount: 300,
    totalRounds: 100,
  }));

  assert.equal(timeline.startProgress, 0);
  assert.equal(timeline.endProgress, 1);
  assert.equal(
    timeline.keyframes.every((keyframe) =>
      Object.keys(keyframe).every((key) =>
        key === 'offset' || key === '--message-liquid-level')),
    true,
  );
});

test('跑馬燈可在 ready 前依實際 traversal 延長液面時軸', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const animator = createMessageLiquidAnimator();
  const snapshot = finitePage({ pageDurationSeconds: 1 });

  assert.equal(animator.prepare(snapshot, target), true);
  assert.equal(animator.retime(snapshot.revision, 8_400), true);
  assert.equal(animator.start(snapshot.revision, 1), true);
  assert.equal(target.animations[0].options.duration, 8_400);
  assert.equal(
    target.animations[0].keyframes[0]['--message-liquid-level'],
    '0%',
  );
  assert.equal(
    target.animations[0].keyframes.at(-1)['--message-liquid-level'],
    '100%',
  );
  assert.equal(animator.retime(snapshot.revision + 1, 9_000), false);
  assert.equal(animator.retime(snapshot.revision, 0), false);
});

test('數十分鐘跑馬燈重新計時仍只輸出可 seek 的液位端點', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const animator = createMessageLiquidAnimator();
  const snapshot = finitePage({ pageDurationSeconds: 1 });
  const traversalMilliseconds = 4_756_754;

  animator.prepare(snapshot, target);
  animator.retime(snapshot.revision, traversalMilliseconds);
  animator.start(snapshot.revision, 1);
  assert.equal(target.animations[0].options.duration, traversalMilliseconds);
  assert.deepEqual(
    target.animations[0].keyframes.map((keyframe) => ({
      level: keyframe['--message-liquid-level'],
      offset: keyframe.offset,
    })),
    [
      { level: '0%', offset: 0 },
      { level: '100%', offset: 1 },
    ],
  );
});

test('持續輪播的多頁仍有頁面終點；單頁持續、待機與臨檢不倒數', async () => {
  const { createMessageLiquidTimeline } = await import(moduleUrl);
  const continuousPage = createMessageLiquidTimeline(finitePage({
    roundNumber: null,
    totalRounds: null,
  }));

  assert.deepEqual({
    startProgress: continuousPage.startProgress,
    endProgress: continuousPage.endProgress,
    stepNumber: continuousPage.stepNumber,
    totalSteps: continuousPage.totalSteps,
  }, {
    startProgress: 0,
    endProgress: 1,
    stepNumber: 1,
    totalSteps: 2,
  });

  for (const snapshot of [
    finitePage({
      pageCount: 1,
      roundNumber: null,
      totalRounds: null,
    }),
    finitePage({ mode: 'emergency', pageNumber: null, pageCount: null }),
    finitePage({ mode: 'blank', pageNumber: null, pageCount: null }),
  ]) {
    assert.equal(createMessageLiquidTimeline(snapshot), null);
  }
});

test('動畫器先固定空字腔液面，Display ready 後才開始注酒', async () => {
  const {
    createMessageLiquidAnimator,
    createMessageLiquidTimeline,
  } = await import(moduleUrl);
  const target = createFakeTarget();
  const animator = createMessageLiquidAnimator();
  const snapshot = finitePage();

  assert.equal(animator.prepare(snapshot, target), true);
  assert.equal(
    target.style.getPropertyValue('--message-liquid-level'),
    '0%',
  );
  assert.equal(target.style.getPropertyValue('--message-liquid-wave'), '');
  assert.equal(target.style.getPropertyValue('--message-liquid-agitation'), '');
  assert.equal(target.style.getPropertyValue('--message-outline-color'), '');
  assert.equal(target.animations.length, 0, '排版完成前不得偷跑倒數');

  assert.equal(animator.start(snapshot.revision, 1), true);
  assert.equal(
    animator.start(snapshot.revision, 1),
    true,
    '同一 layout 的重複 ready 不得重啟',
  );
  assert.equal(target.animations.length, 1);
  assert.deepEqual(
    target.animations[0].keyframes,
    createMessageLiquidTimeline(snapshot).keyframes,
  );
  assert.deepEqual(target.animations[0].options, {
    duration: 4_000,
    easing: 'linear',
    fill: 'forwards',
    iterations: 1,
  });

  assert.equal(animator.start(snapshot.revision + 1, 2), false);

  target.animations[0].currentTime = 1_600;
  target.style.setProperty('--message-liquid-level', '40%');
  assert.equal(
    animator.start(snapshot.revision, 2),
    true,
    '同 revision 的新 layout 只能接管 completion token，不得重新倒酒',
  );
  assert.equal(target.animations[0].cancelled, false);
  assert.equal(target.animations.length, 1);
  assert.equal(target.style.getPropertyValue('--message-liquid-level'), '40%');
  animator.reset();
  assert.equal(target.animations[0].cancelled, true);
  assert.equal(target.style.getPropertyValue('--message-liquid-level'), '');
});

test('新 layout pending 與重新量測不得把同一頁酒液倒回起點', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const animator = createMessageLiquidAnimator();
  const snapshot = finitePage({ pageNumber: 2 });

  animator.prepare(snapshot, target);
  animator.start(snapshot.revision, 1);
  target.animations[0].currentTime = 1_960;
  target.style.setProperty('--message-liquid-level', '49%');

  assert.equal(animator.holdAtStart(snapshot.revision), true);
  assert.equal(target.animations[0].cancelled, false);
  assert.equal(target.style.getPropertyValue('--message-liquid-level'), '49%');
  assert.equal(target.style.getPropertyValue('--message-liquid-wave'), '');
  assert.equal(target.style.getPropertyValue('--message-liquid-agitation'), '');
  assert.equal(animator.holdAtStart(snapshot.revision + 1), false);
  assert.equal(animator.retime(snapshot.revision, 5_000), true);
  assert.equal(target.animations[0].cancelled, false);

  assert.equal(animator.start(snapshot.revision, 2), true);
  assert.equal(target.animations.length, 1);
});

test('換頁顯示新的訊息時重新由空杯開始', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const animator = createMessageLiquidAnimator();

  animator.prepare(finitePage(), target);
  animator.start(7, 1);
  animator.prepare(finitePage({ pageNumber: 2, revision: 8 }), target);
  assert.equal(target.animations[0].cancelled, true);
  assert.equal(
    target.style.getPropertyValue('--message-liquid-level'),
    '0%',
  );
  animator.start(8, 2);

  animator.prepare(finitePage({ pageCount: 3, revision: 10 }), target);
  assert.equal(target.animations[1].cancelled, true);
  assert.equal(
    target.style.getPropertyValue('--message-liquid-level'),
    '0%',
  );

  assert.equal(animator.prepare(finitePage({
    roundNumber: null,
    totalRounds: null,
    revision: 11,
  }), target), true);
  assert.equal(
    target.style.getPropertyValue('--message-liquid-level'),
    '0%',
  );
  animator.start(11, 3);

  assert.equal(animator.prepare(finitePage({
    pageCount: 1,
    roundNumber: null,
    totalRounds: null,
    revision: 12,
  }), target), false);
  assert.equal(target.animations[2].cancelled, true);
  assert.equal(target.style.getPropertyValue('--message-liquid-level'), '');
});

test('WAAPI 建立失敗會清除液體屬性，讓畫面可安全退回白色實心字', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget({ throwOnAnimate: true });
  const animator = createMessageLiquidAnimator();
  const snapshot = finitePage();

  assert.equal(animator.prepare(snapshot, target), true);
  assert.equal(animator.start(snapshot.revision, 1), false);
  assert.equal(target.style.getPropertyValue('--message-liquid-level'), '');
  assert.equal(animator.start(snapshot.revision, 1), false);
});

test('單一 rAF 依 WAAPI 實際時間繪製物理液面，100% 至少呈現一幀後停止', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const frames = [];
  const scheduler = createFrameHarness();
  const animator = createMessageLiquidAnimator({
    cancelFrame: scheduler.cancelFrame,
    renderFrame: (frame) => frames.push(frame),
    requestFrame: scheduler.requestFrame,
  });
  const snapshot = finitePage();

  animator.prepare(snapshot, target);
  animator.start(snapshot.revision, 5);
  assert.equal(scheduler.pendingCount(), 1);

  target.animations[0].currentTime = 1_000;
  scheduler.step(1_000);
  assert.deepEqual(frames.at(-1), {
    durationMilliseconds: 4_000,
    progress: 0.25,
    timeMilliseconds: 1_000,
  });
  assert.equal(scheduler.pendingCount(), 1);

  target.animations[0].currentTime = 4_000;
  scheduler.step(4_000);
  assert.deepEqual(frames.at(-1), {
    durationMilliseconds: 4_000,
    progress: 1,
    timeMilliseconds: 4_000,
  });
  assert.equal(scheduler.pendingCount(), 1, '滿杯終幀需先留給 compositor 呈現');
  scheduler.step(4_017);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_034);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_051);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_068);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_099);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_116);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_117);
  assert.equal(scheduler.pendingCount(), 0);
});

test('液體只有在 WAAPI 真正到達期限終點時才通知頁面可以 complete', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const completions = [];
  const scheduler = createFrameHarness();
  const animator = createMessageLiquidAnimator({
    cancelFrame: scheduler.cancelFrame,
    onComplete: (completion) => completions.push(completion),
    renderFrame: () => {},
    requestFrame: scheduler.requestFrame,
  });
  const snapshot = finitePage();

  animator.prepare(snapshot, target);
  animator.start(snapshot.revision, 12);
  target.animations[0].currentTime = 3_999;
  scheduler.step(3_999);
  assert.deepEqual(completions, [], '期限前 1ms 不得提早宣告滿杯');

  target.animations[0].currentTime = 4_000;
  scheduler.step(4_000);
  assert.deepEqual(completions, [], '同一 rAF 內不得立刻移除剛畫好的滿杯終幀');
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_017);
  assert.deepEqual(completions, [], '第一個呈現 rAF 後才可等待下一幀通知 Main');
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_034);
  assert.deepEqual(completions, [], '滿杯需跨過第二個刷新週期才可換頁');
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_051);
  assert.deepEqual(completions, [], '需保留足以被 30fps 輸出捕捉的滿杯終幀');
  assert.equal(scheduler.pendingCount(), 1);
  for (const timestamp of [4_068, 4_099, 4_116]) {
    scheduler.step(timestamp);
    assert.deepEqual(completions, [], '滿杯實際呈現未滿 100ms，不得通知 Main');
    assert.equal(scheduler.pendingCount(), 1);
  }
  scheduler.step(4_117);
  assert.deepEqual(completions, [{
    durationMilliseconds: 4_000,
    layoutGeneration: 12,
    revision: snapshot.revision,
  }]);
  assert.equal(scheduler.pendingCount(), 0);
});

test('4K 流體幾何最多以 30fps 更新，但 WAAPI 終點仍不會漏幀', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const frames = [];
  const scheduler = createFrameHarness();
  const animator = createMessageLiquidAnimator({
    cancelFrame: scheduler.cancelFrame,
    renderFrame: (frame) => frames.push(frame),
    requestFrame: scheduler.requestFrame,
  });
  const snapshot = finitePage({ pageDurationSeconds: 1 });

  animator.prepare(snapshot, target);
  animator.start(snapshot.revision, 6);

  for (const timeMilliseconds of [0, 8, 17, 25, 34, 42, 51, 68]) {
    target.animations[0].currentTime = timeMilliseconds;
    scheduler.step(timeMilliseconds);
  }

  assert.deepEqual(
    frames.map(({ timeMilliseconds }) => timeMilliseconds),
    [0, 34, 68],
    '高刷新率螢幕不可讓三列 SVG 在每次 rAF 都重建 4K 幾何',
  );

  target.animations[0].currentTime = 1_000;
  scheduler.step(1_000);
  assert.deepEqual(frames.at(-1), {
    durationMilliseconds: 1_000,
    progress: 1,
    timeMilliseconds: 1_000,
  });
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_017);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_034);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_051);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_068);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_099);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_116);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(1_117);
  assert.equal(scheduler.pendingCount(), 0);
});

test('動畫器不得暴露可在期限前強制注滿的旁路', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget();
  const frames = [];
  const scheduler = createFrameHarness();
  const animator = createMessageLiquidAnimator({
    cancelFrame: scheduler.cancelFrame,
    renderFrame: (frame) => frames.push(frame),
    requestFrame: scheduler.requestFrame,
  });
  const snapshot = finitePage();

  animator.prepare(snapshot, target);
  animator.start(snapshot.revision, 9);
  target.animations[0].currentTime = 2_800;
  scheduler.step(2_800);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(
    animator.finishAtEnd,
    undefined,
    '跑馬燈或其他呼叫端不得把尚未到期的酒液直接跳到 100%',
  );
  assert.equal(frames.at(-1).progress, 0.7);
  assert.notEqual(
    target.style.getPropertyValue('--message-liquid-level'),
    '100%',
  );

  target.animations[0].currentTime = 4_000;
  scheduler.step(4_000);
  assert.deepEqual(frames.at(-1), {
    durationMilliseconds: 4_000,
    progress: 1,
    timeMilliseconds: 4_000,
  });
  scheduler.step(4_017);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_034);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_051);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_068);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_099);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_116);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_117);
  assert.equal(scheduler.pendingCount(), 0);
});

test('沒有跑馬燈的有限頁在 WAAPI 完成時也會保證繪製滿杯終幀', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const target = createFakeTarget({ includeFinishedPromise: true });
  const frames = [];
  const scheduler = createFrameHarness();
  const animator = createMessageLiquidAnimator({
    cancelFrame: scheduler.cancelFrame,
    renderFrame: (frame) => frames.push(frame),
    requestFrame: scheduler.requestFrame,
  });
  const snapshot = finitePage();

  animator.prepare(snapshot, target);
  animator.start(snapshot.revision, 11);
  target.animations[0].resolveFinished();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(frames, [{
    durationMilliseconds: 4_000,
    progress: 1,
    timeMilliseconds: 4_000,
  }]);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_017);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_034);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_051);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_068);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_099);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_116);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.step(4_117);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(
    target.style.getPropertyValue('--message-liquid-level'),
    '100%',
  );
});

test('偏好減少動態或 Renderer 失敗時立即取消並通知白字 fallback', async () => {
  const { createMessageLiquidAnimator } = await import(moduleUrl);
  const reducedTarget = createFakeTarget();
  const reduced = createMessageLiquidAnimator({
    shouldReduceMotion: () => true,
  });

  assert.equal(reduced.prepare(finitePage(), reducedTarget), false);
  assert.equal(reducedTarget.animations.length, 0);

  const target = createFakeTarget();
  const scheduler = createFrameHarness();
  let failures = 0;
  const animator = createMessageLiquidAnimator({
    cancelFrame: scheduler.cancelFrame,
    onFailure: () => {
      failures += 1;
    },
    renderFrame: () => {
      throw new Error('synthetic renderer failure');
    },
    requestFrame: scheduler.requestFrame,
  });

  animator.prepare(finitePage(), target);
  animator.start(7, 1);
  scheduler.step();
  assert.equal(failures, 1);
  assert.equal(target.animations[0].cancelled, true);
  assert.equal(target.style.getPropertyValue('--message-liquid-level'), '');
  assert.equal(scheduler.pendingCount(), 0);
});
