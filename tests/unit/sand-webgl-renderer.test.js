'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('GPU 風吹砂在 4K 使用有界 1080p 級像素量，比例不得變形', async () => {
  const { calculateSandRenderSize } = await import(
    '../../display/sand-webgl-renderer.mjs'
  );
  assert.deepEqual(calculateSandRenderSize(1_920, 1_080), {
    width: 1_920,
    height: 1_080,
    scale: 1,
  });
  const fourK = calculateSandRenderSize(3_840, 2_160);
  assert.equal(fourK.width * fourK.height <= 2_073_600, true);
  assert.ok(Math.abs(fourK.width / fourK.height - 16 / 9) < 0.001);
});

test('DOM 上緣裁切座標會轉為 WebGL 左下原點座標', async () => {
  const { calculateBottomLeftTextureCrop } = await import(
    '../../display/sand-webgl-renderer.mjs'
  );
  const crop = calculateBottomLeftTextureCrop(
    { naturalWidth: 2_000, naturalHeight: 1_000 },
    {
      sourceX: 200,
      sourceY: 100,
      sourceWidth: 1_600,
      sourceHeight: 800,
    },
  );
  assert.ok(Math.abs(crop.x - 0.1) < Number.EPSILON);
  assert.ok(Math.abs(crop.y - 0.1) < Number.EPSILON);
  assert.ok(Math.abs(crop.width - 0.8) < Number.EPSILON);
  assert.ok(Math.abs(crop.height - 0.8) < Number.EPSILON);
});

test('關閉待機特效會釋放 WebGL 來源 texture，而非只清空畫面', async () => {
  const [rendererSource, appSource] = await Promise.all([
    readFile(
      path.join(projectRoot, 'display', 'sand-webgl-renderer.mjs'),
      'utf8',
    ),
    readFile(path.join(projectRoot, 'display', 'app.mjs'), 'utf8'),
  ]);

  assert.match(
    rendererSource,
    /releaseSourceTexture\(\)\s*\{[\s\S]*?texImage2D\([\s\S]*?\b1,\s*\b1,\s*\b0,[\s\S]*?null[\s\S]*?ready\s*=\s*false;[\s\S]*?cropUniform\s*=\s*null;/,
  );
  assert.match(
    appSource,
    /function clearStandbySandCanvas\(\{\s*releaseBuffers\s*=\s*false\s*\}\s*=\s*\{\}\)[\s\S]*?releaseBuffers[\s\S]*?sandWebglRenderer\?\.releaseSourceTexture\(\)/,
  );
});

test('shader 必須從固定來源格點向右搬運真實圖片砂粒', async () => {
  const {
    SAND_PARTICLE_PROFILE,
    PARTICLE_VERTEX_SHADER_SOURCE,
    PARTICLE_FRAGMENT_SHADER_SOURCE,
    SAND_WIND_PROFILE,
    SAND_FRAGMENT_SHADER_SOURCE,
  } = await import(
    '../../display/sand-webgl-renderer.mjs'
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.coreOpacity >= 0.32 &&
      SAND_PARTICLE_PROFILE.coreOpacity <= 0.45,
    '砂核要清楚但不可疊成實心白團，明顯度應來自細砂密度',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.coreColorGain >= 0.94 &&
      SAND_PARTICLE_PROFILE.coreColorGain <= 1.05,
    '砂核不得把圖片白階推到飽和，必須保留來源色階',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.gammaLiftMix <= 0.12,
    '來源像素只能輕微提亮，禁止洗成銀白色數位雜訊',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.coreColorGain +
      SAND_PARTICLE_PROFILE.lateProgressColorGain <= 1.12,
    '右上末段可補強可見度，但不得再次把來源色洗白',
  );
  const heightAtEightyPercent = Math.min(
    SAND_PARTICLE_PROFILE.maximumWindHeight,
    Math.max(
      SAND_PARTICLE_PROFILE.minimumWindHeight,
      SAND_PARTICLE_PROFILE.windHeightOffset +
        SAND_PARTICLE_PROFILE.windHeightSpeed * 0.8,
    ),
  );
  assert.ok(
    heightAtEightyPercent >= 0.74 && heightAtEightyPercent <= 0.8,
    '80% 進度的砂核必須停留於右上安全區，不能被上緣裁切',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.tailDensity >= 0.65,
    '下風尾流必須連續且足夠密集，不能只剩零星侵蝕點',
  );
  assert.ok(
    SAND_WIND_PROFILE.coreX >= 0.58 && SAND_WIND_PROFILE.coreX <= 0.62,
    '揚砂核心必須位於中間偏右，右側需留下明顯尾流空間',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.maximumPointSize <= 4.2,
    '砂塵必須粒粒分明，禁止放大成煙霧或泡泡',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.minimumHorizontalSpeed *
      SAND_WIND_PROFILE.horizontalSweepDuration >= 1.05,
    '砂粒必須明顯快於侵蝕前緣，才能在右側形成可見尾流',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.maximumTrailDelay >= 0.003 &&
      SAND_PARTICLE_PROFILE.maximumTrailDelay <= 0.006,
    '尾跡取樣要拉開成可見的水平風線，同時不得斷成數段',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.fineHorizontalSpeed >=
      SAND_PARTICLE_PROFILE.coarseHorizontalSpeed * 1.2,
    '細沙的 GPU 水平風速必須至少比粗沙快 20%',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.fineLiftStrength >=
      SAND_PARTICLE_PROFILE.coarseLiftStrength * 1.6,
    '細沙的 GPU 上揚強度必須至少是粗沙的 1.6 倍',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.fineTrailScale >=
      SAND_PARTICLE_PROFILE.coarseTrailScale * 1.2,
    '細沙的 GPU 尾流必須至少比粗沙長 20%',
  );
  assert.ok(
    SAND_PARTICLE_PROFILE.minimumGustStrength >= 0.8 &&
      SAND_PARTICLE_PROFILE.maximumGustStrength <= 1.2 &&
      SAND_PARTICLE_PROFILE.maximumGustStrength -
        SAND_PARTICLE_PROFILE.minimumGustStrength >= 0.18,
    '低頻風團必須有明顯強弱，但不可掉到零造成斷流',
  );
  const coreBaseTime = SAND_WIND_PROFILE.baseTimeOffset +
    SAND_WIND_PROFILE.horizontalSweepDuration * SAND_WIND_PROFILE.coreX;
  const coreHeightAt = (progress) => (
    progress - coreBaseTime
  ) / SAND_WIND_PROFILE.verticalRiseDuration;
  assert.ok(
    SAND_WIND_PROFILE.horizontalSweepDuration <
      SAND_WIND_PROFILE.verticalRiseDuration,
    '每一高度的風必須先向右掃過，同時與相鄰高度重疊成連續風帶',
  );
  assert.ok(
    coreHeightAt(0.2) >= 0.1 && coreHeightAt(0.2) <= 0.15 &&
      coreHeightAt(0.5) >= 0.42 && coreHeightAt(0.5) <= 0.48 &&
      coreHeightAt(0.8) >= 0.75 && coreHeightAt(0.8) <= 0.81,
    '中右揚砂核心必須在 20%/50%/80% 進度持續位於下／中／上方',
  );
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /gl_VertexID/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /trail_index/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /trail_samples\s*=\s*4/);
  assert.match(
    PARTICLE_VERTEX_SHADER_SOURCE,
    /source_index\s*=\s*u_haze_pass\s*==\s*1/,
  );
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /airborne/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /grain_fineness/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /gust_strength/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /particle_fade_end/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /wind_gust_strength/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /source_core/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /destination_core/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /wind_height_center/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /height_core/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /plume_core/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /tail_stream/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /wake_turbulence/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /ridge_density/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /color_sample_uv/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /band_convergence/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /updraft/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /scatter_x/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /scatter_y/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /main_density/);
  assert.match(
    PARTICLE_VERTEX_SHADER_SOURCE,
    /density_random\s*>\s*\(trail_index\s*==\s*0\s*\?\s*main_density/,
  );
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /u_haze_pass/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /obvious_plume_alpha/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /v_particle_kind/);
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /trail_index\s*==\s*0/);
  assert.match(
    PARTICLE_VERTEX_SHADER_SOURCE,
    /destination_uv\s*=\s*source_uv\s*\+\s*displacement/,
  );
  assert.match(PARTICLE_VERTEX_SHADER_SOURCE, /right_edge_fade/);
  assert.match(
    PARTICLE_VERTEX_SHADER_SOURCE,
    /gl_PointSize\s*=\s*min\(\s*4\.2\s*,/,
    'GLSL min 的粒徑上限必須輸出浮點常值，避免 WebGL2 overload 編譯失敗',
  );
  assert.match(
    PARTICLE_FRAGMENT_SHADER_SOURCE,
    /texture\(u_outgoing_image,\s*texture_uv\)/,
  );
  assert.match(PARTICLE_FRAGMENT_SHADER_SOURCE, /uniform\s+vec4\s+u_scrim/);
  assert.match(PARTICLE_FRAGMENT_SHADER_SOURCE, /light_scrim/);
  assert.match(PARTICLE_FRAGMENT_SHADER_SOURCE, /source_sample\.a/);
  assert.match(PARTICLE_FRAGMENT_SHADER_SOURCE, /v_source_uv/);
  assert.match(
    PARTICLE_FRAGMENT_SHADER_SOURCE,
    /haze_distance\s*=\s*length\(point\s*\*\s*vec2/,
  );
  assert.match(
    PARTICLE_FRAGMENT_SHADER_SOURCE,
    /vec4\(source_color\s*\*\s*alpha,\s*alpha\)/,
  );
  assert.doesNotMatch(PARTICLE_VERTEX_SHADER_SOURCE, /destination_uv\s*-/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /detach_profile\(v_uv\)/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /uniform\s+vec4\s+u_scrim/);
  assert.match(
    SAND_FRAGMENT_SHADER_SOURCE,
    /mix\(\s*intact_color\s*,\s*u_scrim\.rgb\s*,\s*u_scrim\.a\s*\)/,
    'GPU 舊圖必須自行套用待機遮罩，才能讓砂粒獨立顯示在遮罩上方',
  );
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /wind_sweep_delay/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /continuous_detach_time/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /erosion_feather/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /coherent_edge/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /anchor_breakup/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /island_detach_time/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /clump_noise/);
  assert.doesNotMatch(SAND_FRAGMENT_SHADER_SOURCE, /gust_bands/);
  assert.doesNotMatch(SAND_FRAGMENT_SHADER_SOURCE, /9\.3\s*\*\s*band_y/);
  assert.doesNotMatch(SAND_FRAGMENT_SHADER_SOURCE, /17\.7\s*\*\s*band_y/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /stable_noise/);
  assert.doesNotMatch(SAND_FRAGMENT_SHADER_SOURCE, /ribbon_index/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /half_width/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /detach\.half_width/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /spatial_antialias/);
  assert.match(SAND_FRAGMENT_SHADER_SOURCE, /fwidth\(raw_anchor_center\)/);
  assert.match(
    SAND_FRAGMENT_SHADER_SOURCE,
    /vec4\(screened_color\s*\*\s*rendered_alpha,\s*rendered_alpha\)/,
  );
  assert.doesNotMatch(SAND_FRAGMENT_SHADER_SOURCE, /mix\([^;]+u_progress/);
  assert.doesNotMatch(SAND_FRAGMENT_SHADER_SOURCE, /horizontal_delay/);
});
