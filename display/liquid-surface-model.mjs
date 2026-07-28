const SURFACE_SAMPLE_COUNT = 73;
const SETTLING_START_PROGRESS = 0.85;
const MAXIMUM_WAVE_HEIGHT_RATIO = 0.165;
const TERMINAL_FLATTEN_PROGRESS = 0.05;
const FLOW_WEIGHT_BASE = 0.7;
const FLOW_WEIGHT_GROWTH = 0.3;
const MINIMUM_FLOW_ATTACK_PROGRESS = 0.015;
const MAXIMUM_FLOW_ATTACK_PROGRESS = 0.12;
const MINIMUM_FLOW_RELEASE_PROGRESS = 0.01;
const MAXIMUM_FLOW_RELEASE_PROGRESS = 0.04;
const MAXIMUM_BUBBLE_EVENT_COUNT = 36;
const TAU = Math.PI * 2;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundCoordinate(value) {
  return Number(value.toFixed(4));
}

function smootherStep(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * progress *
    (progress * ((progress * 6) - 15) + 10);
}

function smoothStep(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

/** 32-bit avalanche hash；同一頁與同一時刻永遠得到相同的流體狀態。 */
function hashUnit(seed, index) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff;
}

function validateFrameOptions(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('Liquid surface options must be an object.');
  }

  const {
    progress,
    timeMilliseconds,
    durationMilliseconds,
    width,
    height,
    seed,
    sourceXRatio,
  } = options;

  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    throw new RangeError('Liquid progress must be between 0 and 1.');
  }
  if (!Number.isFinite(timeMilliseconds) || timeMilliseconds < 0) {
    throw new RangeError('Liquid time must be a finite non-negative number.');
  }
  if (!Number.isFinite(durationMilliseconds) || durationMilliseconds <= 0) {
    throw new RangeError('Liquid duration must be a positive number.');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) {
    throw new RangeError('Liquid surface width and height must be positive.');
  }
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError('Liquid surface seed must be a safe integer.');
  }
  if (
    sourceXRatio !== undefined &&
    (!Number.isFinite(sourceXRatio) || sourceXRatio < 0.14 ||
      sourceXRatio > 0.86)
  ) {
    throw new RangeError(
      'Liquid source X ratio must be between 0.14 and 0.86.',
    );
  }
}

/**
 * 單次倒酒的液位使用輕微 ease-in。1.12 次方讓開頭保留酒的質量感，
 * 同時把最後 1% 容量平均分布在最後 1% 時間內；不再於 30ms 內衝高 4%。
 */
function integrateAttackFlow(progress, attackProgress) {
  const p = clamp(progress, 0, attackProgress);
  const a = attackProgress;
  return FLOW_WEIGHT_BASE * (
    (p ** 3 / a ** 2) - (0.5 * p ** 4 / a ** 3)
  ) + FLOW_WEIGHT_GROWTH * (
    (0.75 * p ** 4 / a ** 2) - (0.4 * p ** 5 / a ** 3)
  );
}

function integrateReleaseTail(distanceToEnd, releaseProgress) {
  const q = clamp(distanceToEnd, 0, releaseProgress);
  const r = releaseProgress;
  return (FLOW_WEIGHT_BASE + FLOW_WEIGHT_GROWTH) * (
    (q ** 3 / r ** 2) - (0.5 * q ** 4 / r ** 3)
  ) - FLOW_WEIGHT_GROWTH * (
    (0.75 * q ** 4 / r ** 2) - (0.4 * q ** 5 / r ** 3)
  );
}

function integrateLinearFlow(progress) {
  return FLOW_WEIGHT_BASE * progress +
    FLOW_WEIGHT_GROWTH * progress ** 2 / 2;
}

/** 液位由同一個單次流量 Q 積分，不再由獨立 easing 假裝倒酒。 */
function createFlowState(progress, durationSeconds) {
  const attackProgress = clamp(
    0.42 / durationSeconds,
    MINIMUM_FLOW_ATTACK_PROGRESS,
    MAXIMUM_FLOW_ATTACK_PROGRESS,
  );
  const releaseProgress = clamp(
    0.1 / durationSeconds,
    MINIMUM_FLOW_RELEASE_PROGRESS,
    MAXIMUM_FLOW_RELEASE_PROGRESS,
  );
  const attackIntegral = integrateAttackFlow(
    attackProgress,
    attackProgress,
  );
  const middleIntegral =
    integrateLinearFlow(1 - releaseProgress) -
    integrateLinearFlow(attackProgress);
  const releaseIntegral = integrateReleaseTail(
    releaseProgress,
    releaseProgress,
  );
  const totalIntegral = attackIntegral + middleIntegral + releaseIntegral;
  let accumulated;
  let envelope;

  if (progress <= attackProgress) {
    accumulated = integrateAttackFlow(progress, attackProgress);
    envelope = smoothStep(progress / attackProgress);
  } else if (progress <= 1 - releaseProgress) {
    accumulated = attackIntegral +
      integrateLinearFlow(progress) -
      integrateLinearFlow(attackProgress);
    envelope = 1;
  } else {
    accumulated = totalIntegral - integrateReleaseTail(
      1 - progress,
      releaseProgress,
    );
    envelope = smoothStep((1 - progress) / releaseProgress);
  }

  return Object.freeze({
    fillRatio: progress === 0 || progress === 1
      ? progress
      : clamp(accumulated / totalIntegral, 0, 1),
    flowRate: progress === 0 || progress === 1
      ? 0
      : envelope * (
        FLOW_WEIGHT_BASE + FLOW_WEIGHT_GROWTH * progress
      ) / totalIntegral,
  });
}

/**
 * 整個頁面只有一個連續倒酒 episode。攻擊只在頁面開頭發生一次；中段
 * 維持單一連續動量源，最後 15% 逐步關閉，讓慣性回流自然受阻尼收斂。
 */
function createDrivenModeState(timeSeconds, frequency, phase) {
  const secondaryFrequency = frequency * 0.613;
  const transientDecay = Math.exp(-timeSeconds / 0.28);
  const secondaryStart = Math.sin(phase);
  return Object.freeze({
    displacement:
      Math.sin(frequency * timeSeconds) +
      0.31 * (
        Math.sin(secondaryFrequency * timeSeconds + phase) -
        secondaryStart * transientDecay
      ),
    velocity:
      frequency * Math.cos(frequency * timeSeconds) +
      0.31 * (
        secondaryFrequency * Math.cos(
          secondaryFrequency * timeSeconds + phase,
        ) + secondaryStart * transientDecay / 0.28
      ),
  });
}

/** 停止受力後，由同一個 q/q̇ 初值解析演進自由阻尼回流。 */
function createFreeModeState(initial, elapsedSeconds, frequency, damping) {
  const dampedFrequency = Math.max(0.001, Math.sqrt(
    Math.max(0.001, frequency ** 2 - damping ** 2),
  ));
  const coefficient =
    (initial.velocity + damping * initial.displacement) /
    dampedFrequency;
  const angle = dampedFrequency * elapsedSeconds;
  const exponential = Math.exp(-damping * elapsedSeconds);
  const oscillation =
    initial.displacement * Math.cos(angle) +
    coefficient * Math.sin(angle);
  const oscillationVelocity =
    -initial.displacement * dampedFrequency * Math.sin(angle) +
    coefficient * dampedFrequency * Math.cos(angle);
  return Object.freeze({
    displacement: exponential * oscillation,
    velocity: exponential * (
      oscillationVelocity - damping * oscillation
    ),
  });
}

function createModalStates(options) {
  const {
    durationSeconds,
    fillRatio,
    height,
    seed,
    sourceXRatio,
    timeSeconds,
    width,
  } = options;
  const stopTime = durationSeconds * SETTLING_START_PROGRESS;
  const aspectRatio = clamp(width / height, 1.2, 8);
  const depthFactor = Math.sqrt(clamp(fillRatio, 0.08, 1));
  const states = [];

  for (let mode = 1; mode <= 10; mode += 1) {
    const capillary = mode > 6;
    const phase = hashUnit(seed, 457 + mode) * TAU;
    const frequencyHertz = capillary
      ? 2.15 + (mode - 7) * 0.42 + hashUnit(seed, 521 + mode) * 0.16
      : (0.82 + (mode - 1) * 0.19 +
          hashUnit(seed, 521 + mode) * 0.08) *
        (0.82 + depthFactor * 0.18) *
        clamp(Math.sqrt(4.1 / aspectRatio), 0.82, 1.12);
    const frequency = TAU * frequencyHertz;
    const damping = capillary
      ? 2.4 + (mode - 7) * 0.38
      : 0.72 + mode * 0.12;
    const atStop = createDrivenModeState(stopTime, frequency, phase);
    const response = timeSeconds <= stopTime
      ? createDrivenModeState(timeSeconds, frequency, phase)
      : createFreeModeState(
        atStop,
        timeSeconds - stopTime,
        frequency,
        damping,
      );
    states.push(Object.freeze({
      coupling: 0.62 + 0.38 * Math.cos(
        mode * Math.PI * sourceXRatio,
      ),
      displacement: response.displacement,
      mode,
      velocity: response.velocity / Math.max(frequency, 0.001),
      weight: capillary
        ? 0.22 * Math.pow(mode - 5, -1.2)
        : 0.86 * Math.pow(mode, -1.28),
    }));
  }
  return Object.freeze(states);
}

function createPourDynamics(options) {
  const {
    durationSeconds,
    fillRatio,
    flowState,
    height,
    progress,
    seed,
    sourceXRatio: snappedSourceXRatio,
    timeSeconds,
    width,
  } = options;
  const primaryPhase = hashUnit(seed, 269) * TAU;
  const secondaryPhase = hashUnit(seed, 277) * TAU;
  const sourceCenter = 0.28 + hashUnit(seed, 313) * 0.44;
  const sourceXRatio = snappedSourceXRatio ?? clamp(
    sourceCenter +
      Math.sin(timeSeconds * 0.23 + primaryPhase) * 0.018 +
      Math.sin(timeSeconds * 0.51 + secondaryPhase) * 0.009,
    0.14,
    0.86,
  );
  const modalStates = createModalStates({
    durationSeconds,
    fillRatio,
    height,
    seed,
    sourceXRatio,
    timeSeconds,
    width,
  });
  const weightedVelocity = modalStates.reduce(
    (total, state) => total +
      state.velocity * state.weight * state.coupling,
    0,
  );
  const circulationVelocity = modalStates.reduce(
    (total, state) => total +
      state.velocity * state.weight * (state.mode % 2 === 0 ? -1 : 1),
    0,
  );
  const entryEnvelope = 1 - Math.exp(-timeSeconds / 0.24);
  const settlingSeconds = Math.max(
    0,
    timeSeconds - durationSeconds * SETTLING_START_PROGRESS,
  );
  const terminalEnvelope = progress >= 1 - TERMINAL_FLATTEN_PROGRESS
    ? smootherStep((1 - progress) / TERMINAL_FLATTEN_PROGRESS)
    : 1;
  /*
   * 斷流後自由模態仍會往返，但「可見波高」必須隨剩餘時間單調收斂。
   * 若只依賴瞬時 modal phase，即使總能量下降，峰谷差仍可能短暫反彈，
   * 肉眼就會像最後又被倒了一次。這個阻尼窗只縮小幾何，不重寫相位。
   */
  const settlingEnvelope = progress >= SETTLING_START_PROGRESS
    ? smoothStep(
      (1 - progress) / (1 - SETTLING_START_PROGRESS),
    )
    : 1;
  const waveEnergy = progress === 0 || progress === 1
    ? 0
    : entryEnvelope * Math.exp(-settlingSeconds * 0.92) * terminalEnvelope;
  const forceRelease = progress < SETTLING_START_PROGRESS
      ? smoothStep(
      (SETTLING_START_PROGRESS - progress) / 0.01,
    )
    : 0;
  const forcing = clamp(flowState.flowRate * forceRelease, 0, 1);
  const pressureVariation =
    0.84 +
    Math.sin(timeSeconds * 0.43 + primaryPhase) * 0.09 +
    Math.sin(timeSeconds * 0.91 + secondaryPhase) * 0.045 +
    Math.cos(timeSeconds * 1.37 + primaryPhase) * 0.025;
  const waveVelocity = waveEnergy === 0
    ? 0
    : clamp(weightedVelocity, -1, 1);
  const pour = Object.freeze({
    ageMilliseconds: roundCoordinate(timeSeconds * 1_000),
    circulation: roundCoordinate(clamp(circulationVelocity, -1, 1)),
    durationMilliseconds: roundCoordinate(durationSeconds * 1_000),
    energy: roundCoordinate(waveEnergy),
    episodeIndex: 0,
    flowRate: roundCoordinate(flowState.flowRate),
    forcing: roundCoordinate(forcing),
    geometryEnvelope: roundCoordinate(
      entryEnvelope * settlingEnvelope * terminalEnvelope,
    ),
    impactStrength: roundCoordinate(clamp(
      forcing * pressureVariation,
      0,
      1,
    )),
    lateralFlow: roundCoordinate(waveVelocity),
    sourceXRatio: roundCoordinate(sourceXRatio),
    waveEnergy: roundCoordinate(waveEnergy),
    waveVelocity: roundCoordinate(waveVelocity),
  });
  return Object.freeze({ modalStates, pour });
}

/**
 * 評估一維自由液面的阻尼模態響應。
 *
 * 低階模態形成大幅 slosh 與回流，高階模態以更快阻尼形成細波；不規則的
 * 注入事件會同時向左右傳播。沒有 n=0 模態，因此波浪本身不改變酒量。
 */
function evaluateModalSurface(x, modalStates, pour) {
  if (pour.waveEnergy === 0) {
    return 0;
  }

  const sourceX = pour.sourceXRatio;
  const dimpleWidth = 0.055 + 0.014 * (1 - pour.forcing);
  const gaussian = (distance) => Math.exp(-Math.pow(
    distance / dimpleWidth,
    2,
  ));
  const mirroredDimple =
    gaussian(Math.abs(x - sourceX)) +
    gaussian(Math.abs(x + sourceX)) +
    gaussian(Math.abs((2 - sourceX) - x));
  let displacement = pour.impactStrength * mirroredDimple * 0.95;

  /*
   * 六個低頻重力模態負責杯內整體 slosh 與壁面反射；四個低能量毛細
   * 模態只補表面細節。所有模態由同一個 pour energy 驅動，不會自行重啟。
   * cos(nπx) 在左右邊界的導數為零，視覺上不會折出尖角。
   */
  for (const state of modalStates) {
    displacement += state.weight * state.coupling *
      Math.cos(state.mode * Math.PI * x) * state.displacement;
  }

  return displacement;
}

function createSmoothCurve(points) {
  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const following = points[Math.min(points.length - 1, index + 2)];
    const firstControlX = current.x + (next.x - previous.x) / 6;
    const firstControlY = current.y + (next.y - previous.y) / 6;
    const secondControlX = next.x - (following.x - current.x) / 6;
    const secondControlY = next.y - (following.y - current.y) / 6;

    path += ` C ${roundCoordinate(firstControlX)} ` +
      `${roundCoordinate(firstControlY)} ` +
      `${roundCoordinate(secondControlX)} ` +
      `${roundCoordinate(secondControlY)} ${next.x} ${next.y}`;
  }

  return path;
}

function interpolateSurfaceY(points, x) {
  if (x <= points[0].x) {
    return points[0].y;
  }
  if (x >= points.at(-1).x) {
    return points.at(-1).y;
  }

  const width = points.at(-1).x;
  const position = (x / width) * (points.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(points.length - 1, lowerIndex + 1);
  const localProgress = position - lowerIndex;
  return points[lowerIndex].y +
    (points[upperIndex].y - points[lowerIndex].y) * localProgress;
}

/**
 * 在真正液面下方建立一小段柔和弧形焦點。它不是酒柱／酒滴，而是液面受
 * 到動量後的折射帶；Renderer 還會用 body path 再裁一次，杜絕越過液面。
 */
function createSurfaceFocusPath(
  surfacePoints,
  { opacity, propagationRadius, sourceX },
  height,
) {
  if (opacity <= 0 || propagationRadius <= 0) {
    return '';
  }

  const firstX = Math.max(0, sourceX - propagationRadius);
  const lastX = Math.min(surfacePoints.at(-1).x, sourceX + propagationRadius);
  if (lastX - firstX <= 0) {
    return '';
  }

  const upperPoints = [];
  const lowerPoints = [];
  const sampleCount = 13;
  const inset = Math.max(0.35, height * 0.0035);

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / (sampleCount - 1);
    const x = firstX + (lastX - firstX) * progress;
    const arch = Math.pow(Math.sin(Math.PI * progress), 0.72);
    const surfaceY = interpolateSurfaceY(surfacePoints, x);
    const upperY = clamp(surfaceY + inset, 0, height);
    const depth = height * (0.009 + opacity * 0.022) * arch;

    upperPoints.push(Object.freeze({
      x: roundCoordinate(x),
      y: roundCoordinate(upperY),
    }));
    lowerPoints.push(Object.freeze({
      x: roundCoordinate(x),
      y: roundCoordinate(clamp(upperY + depth, 0, height)),
    }));
  }

  const upperCurve = createSmoothCurve(upperPoints);
  const lowerCurve = createSmoothCurve(lowerPoints.reverse())
    .replace(/^M /, ' L ');
  return `${upperCurve}${lowerCurve} Z`;
}

function createRefractionLayers({
  amplitudeEnvelope,
  height,
  pour,
  progress,
  width,
}) {
  if (progress === 0) {
    return Object.freeze([
      Object.freeze({ offsetX: 0, offsetY: 0, opacity: 0, rotation: 0 }),
      Object.freeze({ offsetX: 0, offsetY: 0, opacity: 0, rotation: 0 }),
    ]);
  }

  const motion = progress === 1 ? 0 : amplitudeEnvelope;
  const primaryFlow = pour.lateralFlow;
  const secondaryFlow = pour.circulation;

  return Object.freeze([
    Object.freeze({
      offsetX: roundCoordinate(width * 0.14 * motion * primaryFlow),
      offsetY: roundCoordinate(height * 0.028 * motion * secondaryFlow),
      opacity: roundCoordinate(0.32 + 0.15 * pour.energy),
      rotation: roundCoordinate(5 * motion * secondaryFlow),
    }),
    Object.freeze({
      offsetX: roundCoordinate(width * -0.065 * motion * secondaryFlow),
      offsetY: roundCoordinate(height * 0.036 * motion * primaryFlow),
      opacity: roundCoordinate(0.2 + 0.12 * pour.energy),
      rotation: roundCoordinate(-7.5 * motion * primaryFlow),
    }),
  ]);
}

function createSurfaceFocus({
  amplitudeEnvelope,
  height,
  pour,
  progress,
  surfacePoints,
  surfaceY,
  width,
}) {
  const isEndpoint = progress === 0 || progress === 1;
  const focusOpacity = isEndpoint
    ? 0
    : clamp(
      pour.impactStrength * (0.72 + 0.18 * amplitudeEnvelope),
      0,
      1,
    );
  const sourceX = width * pour.sourceXRatio;
  const propagationRadius = isEndpoint
    ? 0
    : width * clamp(
      0.045 + smootherStep(pour.ageMilliseconds / 900) * 0.035,
      0.045,
      0.08,
    );
  const focus = {
    ageMilliseconds: pour.ageMilliseconds,
    episodeIndex: pour.episodeIndex,
    opacity: roundCoordinate(focusOpacity),
    path: '',
    propagationRadius: roundCoordinate(propagationRadius),
    sourceX: roundCoordinate(sourceX),
    sourceXRatio: pour.sourceXRatio,
    surfaceY: roundCoordinate(surfaceY),
  };
  focus.path = createSurfaceFocusPath(surfacePoints, focus, height);
  return Object.freeze(focus);
}

function createCaustic({
  amplitudeEnvelope,
  height,
  pour,
  progress,
  surfaceFocus,
  surfaceY,
  width,
}) {
  if (progress === 0 || progress === 1 || surfaceFocus.opacity === 0) {
    return Object.freeze({
      centerX: roundCoordinate(surfaceFocus.sourceX),
      centerY: roundCoordinate(surfaceY),
      opacity: 0,
      radiusX: roundCoordinate(width * 0.14),
      radiusY: roundCoordinate(height * 0.07),
      rotation: 0,
    });
  }

  const availableDepth = Math.max(0, height - surfaceY);
  const slowDrift = pour.circulation * 0.68 + pour.lateralFlow * 0.32;
  const centerY = surfaceY + availableDepth *
    clamp(0.14 + 0.1 * slowDrift, 0.055, 0.235);

  return Object.freeze({
    centerX: roundCoordinate(clamp(
      surfaceFocus.sourceX + width * 0.06 * slowDrift,
      0,
      width,
    )),
    centerY: roundCoordinate(clamp(centerY, surfaceY, height)),
    opacity: roundCoordinate(clamp(
      surfaceFocus.opacity * (0.48 + 0.25 * amplitudeEnvelope),
      0,
      0.72,
    )),
    radiusX: roundCoordinate(width * (0.14 + 0.055 * surfaceFocus.opacity)),
    radiusY: roundCoordinate(height * (0.052 + 0.035 * surfaceFocus.opacity)),
    rotation: roundCoordinate(14 * amplitudeEnvelope * slowDrift),
  });
}

function createBubbleCirclePath(bubbles) {
  return bubbles.map(({ radius, x, y }) => {
    const horizontalRadius = radius;
    const verticalRadius = radius * 0.9;
    return `M ${roundCoordinate(x + horizontalRadius)} ${roundCoordinate(y)} ` +
      `A ${roundCoordinate(horizontalRadius)} ${roundCoordinate(verticalRadius)} ` +
      `0 1 0 ${roundCoordinate(x - horizontalRadius)} ${roundCoordinate(y)} ` +
      `A ${roundCoordinate(horizontalRadius)} ${roundCoordinate(verticalRadius)} ` +
      `0 1 0 ${roundCoordinate(x + horizontalRadius)} ${roundCoordinate(y)} Z`;
  }).join(' ');
}

function createBubbleHighlightPath(bubbles) {
  return bubbles.map(({ radius, x, y }) => {
    const radiusX = radius * 0.46;
    const radiusY = radius * 0.38;
    const startX = x - radius * 0.42;
    const startY = y - radius * 0.08;
    const endX = x - radius * 0.03;
    const endY = y - radius * 0.48;
    return `M ${roundCoordinate(startX)} ${roundCoordinate(startY)} ` +
      `A ${roundCoordinate(radiusX)} ${roundCoordinate(radiusY)} ` +
      `0 0 1 ${roundCoordinate(endX)} ${roundCoordinate(endY)}`;
  }).join(' ');
}

/**
 * 倒酒撞擊會捲入空氣。有限的解析式軌跡可在任意時間 seek，卻不需為
 * 每顆氣泡建立 DOM；Renderer 只畫兩條合併 path。氣泡的出生、尺寸、橫向
 * 回流與上浮速度皆由 seed 決定，最後仍由酒體 clip 與字形 mask 雙重裁切。
 */
function createBubbles({
  durationSeconds,
  height,
  pour,
  progress,
  seed,
  surfacePoints,
  surfaceY,
  timeSeconds,
  width,
}) {
  const liquidDepth = height - surfaceY;
  if (
    progress === 0 ||
    progress === 1 ||
    liquidDepth <= height * 0.045
  ) {
    return Object.freeze({
      bodyPath: '',
      bubbles: Object.freeze([]),
      highlightPath: '',
      opacity: 0,
    });
  }

  const bubbleBirthCutoffSeconds =
    durationSeconds * SETTLING_START_PROGRESS;
  const lastBirthSeconds = Math.max(
    0.35,
    bubbleBirthCutoffSeconds - 0.3,
  );
  const eventCount = Math.min(
    MAXIMUM_BUBBLE_EVENT_COUNT,
    Math.max(12, Math.ceil(lastBirthSeconds / 0.24)),
  );
  const bubbles = [];

  for (let slot = 0; slot < eventCount; slot += 1) {
    const identity = 1_701 + slot * 97;
    const birthDistribution = (
      slot + 0.2 + hashUnit(seed, identity) * 0.6
    ) / eventCount;
    const birthSeconds = 0.08 + birthDistribution *
      Math.max(0, lastBirthSeconds - 0.08);
    const lifetimeSeconds =
      1.05 + hashUnit(seed, identity + 1) * 0.8;
    const ageSeconds = timeSeconds - birthSeconds;
    if (ageSeconds < 0 || ageSeconds >= lifetimeSeconds) {
      continue;
    }

    const age = ageSeconds / lifetimeSeconds;
    const appearance =
      smootherStep(ageSeconds / 0.11) *
      smootherStep((lifetimeSeconds - ageSeconds) / 0.2);
    if (appearance <= 0.012) {
      continue;
    }
    /* 用半徑編碼每顆氣泡的生滅，合併 path 也不會被最亮氣泡帶著閃現。 */
    const radius = height * (
      0.0108 + hashUnit(seed, identity + 2) * 0.0235
    ) * Math.sqrt(appearance);
    const birthOffset = (hashUnit(seed, identity + 3) - 0.5) * 0.2;
    const swayPhase = hashUnit(seed, identity + 4) * TAU;
    const startingDepth = liquidDepth * (
      0.16 + hashUnit(seed, identity + 5) * 0.22
    );
    const entrainmentProgress = clamp(ageSeconds / 0.24, 0, 1);
    const downwardEntrainment = liquidDepth * 0.09 *
      Math.sin(Math.PI * entrainmentProgress);
    const riseProgress = clamp(
      (ageSeconds - 0.1) / Math.max(0.1, lifetimeSeconds - 0.1),
      0,
      1,
    );
    const terminalRise = (
      1 - Math.exp(-4.2 * riseProgress)
    ) / (1 - Math.exp(-4.2));
    const x = clamp(
      width * (
        pour.sourceXRatio +
        birthOffset +
        pour.waveVelocity * age * 0.032 +
        Math.sin(age * Math.PI * (1.15 + slot * 0.031) + swayPhase) *
          0.016
      ),
      radius,
      width - radius,
    );
    const localSurfaceY = interpolateSurfaceY(surfacePoints, x);
    const returnFlow = liquidDepth * pour.circulation *
      Math.sin(age * Math.PI) * 0.018;
    const y = surfaceY + startingDepth + downwardEntrainment -
      terminalRise * startingDepth * 1.04 + returnFlow;
    if (
      y - radius <= localSurfaceY + 0.1 ||
      y + radius > height
    ) {
      continue;
    }

    bubbles.push(Object.freeze({
      id: `bubble-${slot}`,
      opacity: roundCoordinate(clamp(
        appearance * (0.42 + hashUnit(seed, identity + 6) * 0.3),
        0.01,
        0.72,
      )),
      radius: roundCoordinate(radius),
      x: roundCoordinate(x),
      y: roundCoordinate(y),
    }));
  }

  const frozenBubbles = Object.freeze(bubbles);
  return Object.freeze({
    bodyPath: createBubbleCirclePath(frozenBubbles),
    bubbles: frozenBubbles,
    highlightPath: createBubbleHighlightPath(frozenBubbles),
    opacity: roundCoordinate(
      bubbles.length === 0
        ? 0
        : Math.max(...bubbles.map(({ opacity }) => opacity)),
    ),
  });
}

/**
 * 產生任意時間都可直接定位的流體影格；不保存狀態，也不依賴呼叫順序。
 */
export function createLiquidSurfaceFrame(options) {
  validateFrameOptions(options);
  const {
    progress,
    timeMilliseconds,
    durationMilliseconds,
    width,
    height,
    seed,
    sourceXRatio,
  } = options;
  const durationSeconds = durationMilliseconds / 1_000;
  const flowState = createFlowState(progress, durationSeconds);
  const fillRatio = flowState.fillRatio;
  const surfaceY = height * (1 - fillRatio);
  const timeSeconds = timeMilliseconds / 1_000;
  const { modalStates, pour } = createPourDynamics({
    durationSeconds,
    fillRatio,
    flowState,
    height,
    progress,
    seed,
    sourceXRatio,
    timeSeconds,
    width,
  });
  const amplitudeEnvelope = pour.waveEnergy;
  /*
   * 薄薄一層酒不可能產生比酒深更高的波，接近杯口時也不能把自由液面
   * 切在畫布外。以現有酒深與杯口空間共同限制波幅，避免 clamp 形成一段
   * 貼死上下邊界的假平面，同時保留半杯時完整的大尺度 slosh。
   */
  const availableWaveHeight = Math.min(surfaceY, height - surfaceY) * 0.72;
  const amplitude = Math.min(
    height * MAXIMUM_WAVE_HEIGHT_RATIO * amplitudeEnvelope,
    availableWaveHeight,
  );
  const geometryAmplitude = Math.min(
    height * MAXIMUM_WAVE_HEIGHT_RATIO,
    availableWaveHeight,
  ) * pour.geometryEnvelope;
  const rawValues = [];

  for (let index = 0; index < SURFACE_SAMPLE_COUNT; index += 1) {
    const xRatio = index / (SURFACE_SAMPLE_COUNT - 1);
    rawValues.push(evaluateModalSurface(
      xRatio,
      modalStates,
      pour,
    ));
  }

  const mean = rawValues.reduce((total, value) => total + value, 0) /
    rawValues.length;
  const centered = rawValues.map((value) => value - mean);
  /*
   * 使用固定軟飽和尺度保留真實能量差：注入後波幅會增強，接著依各模態
   * 阻尼下降。不可再以「當幀最大值」正規化，否則每一幀都會被硬拉成
   * 相同高度，物理上的注入、慣性與沉降就只剩形狀假象。
   */
  const saturated = centered.map((value) => Math.tanh(value / 1.72));
  const saturatedMean = saturated.reduce(
    (total, value) => total + value,
    0,
  ) / saturated.length;
  const physicalDisplacements = saturated.map(
    (value) => clamp((value - saturatedMean) / 0.88, -1, 1),
  );
  const refractionOffset = amplitudeEnvelope === 0
    ? 0
    : roundCoordinate(clamp(
      ((physicalDisplacements[8] - physicalDisplacements[40]) * 0.072) +
      ((physicalDisplacements[19] - physicalDisplacements[30]) * 0.04) +
      pour.lateralFlow * 0.018,
      -0.08,
      0.08,
    ));
  const surfacePoints = physicalDisplacements.map((value, index) =>
    Object.freeze({
      x: roundCoordinate(width * index / (SURFACE_SAMPLE_COUNT - 1)),
      y: roundCoordinate(clamp(
        surfaceY + (value * geometryAmplitude),
        0,
        height,
      )),
    }));

  if (amplitude === 0) {
    for (let index = 0; index < surfacePoints.length; index += 1) {
      surfacePoints[index] = Object.freeze({
        x: surfacePoints[index].x,
        y: roundCoordinate(surfaceY),
      });
    }
  }

  const curve = createSmoothCurve(surfacePoints);
  const bodyPath = `${curve} L ${roundCoordinate(width)} ` +
    `${roundCoordinate(height)} L 0 ${roundCoordinate(height)} Z`;
  /* 表面高光和波幅共用阻尼包絡，避免滿杯前仍亮著、最後一幀才跳消失。 */
  const meniscusOpacity = roundCoordinate(
    0.92 * smootherStep(amplitudeEnvelope),
  );
  const surfaceFocus = createSurfaceFocus({
    amplitudeEnvelope,
    height,
    pour,
    progress,
    surfacePoints,
    surfaceY,
    width,
  });
  const refractionLayers = createRefractionLayers({
    amplitudeEnvelope,
    height,
    pour,
    progress,
    width,
  });
  const caustic = createCaustic({
    amplitudeEnvelope,
    height,
    pour,
    progress,
    surfaceFocus,
    surfaceY,
    width,
  });
  const bubbleState = createBubbles({
    durationSeconds,
    height,
    pour,
    progress,
    seed,
    surfacePoints,
    surfaceY,
    timeSeconds,
    width,
  });

  return Object.freeze({
    amplitude: roundCoordinate(amplitude),
    bodyOpacity: progress === 0 ? 0 : 1,
    bodyPath,
    bubbleBodyPath: bubbleState.bodyPath,
    bubbleHighlightPath: bubbleState.highlightPath,
    bubbleOpacity: bubbleState.opacity,
    bubbles: bubbleState.bubbles,
    caustic,
    fillRatio: Number(fillRatio.toFixed(8)),
    meniscusOpacity,
    meniscusPath: curve,
    pour,
    refractionLayers,
    refractionOffset,
    surfaceFocus,
    surfacePoints: Object.freeze(surfacePoints),
    surfaceY: roundCoordinate(surfaceY),
  });
}
