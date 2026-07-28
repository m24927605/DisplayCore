const MAXIMUM_RENDER_PIXEL_COUNT = 2_073_600;
const MAXIMUM_RENDER_EDGE = 2_560;

/**
 * 風帶不是一條由下往上的遮罩：每一條高度帶都要先由左向右完整通過，
 * 且在前一條尚未消散時啟動下一條，才會形成連續上移的沙漠風。
 */
export const SAND_WIND_PROFILE = Object.freeze({
  baseTimeOffset: -0.114,
  verticalRiseDuration: 0.91,
  horizontalSweepDuration: 0.34,
  coreX: 0.6,
});

/**
 * 砂塵可見度規格。
 *
 * 待機背景上方固定覆蓋 48% 黑色遮罩，因此砂粒在 WebGL 畫布內必須先補償
 * 亮度與不透明度，實際輸出到電視後才不會退化成幾乎看不見的侵蝕雜點。
 * 最大點尺寸仍限制為細砂尺度，避免高可見度被誤讀為煙霧或泡泡。
 */
export const SAND_PARTICLE_PROFILE = Object.freeze({
  coreOpacity: 0.44,
  baseColorGain: 0.9,
  coreColorGain: 0.98,
  tailColorGain: 0.08,
  gammaLiftMix: 0.09,
  tailDensity: 0.78,
  maximumPointSize: 4.2,
  minimumHorizontalSpeed: 3.25,
  coarseHorizontalSpeed: 3.25,
  fineHorizontalSpeed: 4.35,
  coarseLiftStrength: 0.065,
  fineLiftStrength: 0.135,
  coarseTrailScale: 0.78,
  fineTrailScale: 1.18,
  minimumGustStrength: 0.88,
  maximumGustStrength: 1.12,
  maximumTrailDelay: 0.0046,
  windHeightOffset: -0.0987,
  windHeightSpeed: 1.0989,
  minimumWindHeight: 0.1,
  maximumWindHeight: 0.88,
  lateProgressColorGain: 0.08,
  lateProgressOpacityBoost: 0.3,
});

const FULLSCREEN_VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SAND_FIELD_GLSL = `
float saturate(float value) {
  return clamp(value, 0.0, 1.0);
}

float smooth01(float value) {
  float progress = saturate(value);
  return progress * progress * (3.0 - 2.0 * progress);
}

float smoother01(float value) {
  float progress = saturate(value);
  return progress * progress * progress * (
    progress * (progress * 6.0 - 15.0) + 10.0
  );
}

float hash21(vec2 point) {
  vec3 position = fract(vec3(point.xyx) * 0.1031);
  position += dot(position, position.yzx + 33.33 + u_seed * 0.001);
  return fract((position.x + position.y) * position.z);
}

float value_noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 offset = fract(point);
  vec2 blend = offset * offset * (3.0 - 2.0 * offset);
  float top = mix(
    hash21(cell),
    hash21(cell + vec2(1.0, 0.0)),
    blend.x
  );
  float bottom = mix(
    hash21(cell + vec2(0.0, 1.0)),
    hash21(cell + vec2(1.0, 1.0)),
    blend.x
  );
  return mix(top, bottom, blend.y);
}

float gaussian(float value, float center, float spread) {
  float normalized = (value - center) / spread;
  return exp(-0.5 * normalized * normalized);
}

float core_center(float y) {
  return ${SAND_WIND_PROFILE.coreX} +
    (value_noise(vec2(0.37, y * 4.5 + 19.0)) - 0.5) * 0.024;
}

float core_strength(vec2 uv) {
  float center = core_center(uv.y);
  return gaussian(uv.x, center, 0.07);
}

float material_threshold(vec2 uv) {
  vec2 material_cell = floor(uv * u_resolution / vec2(2.2, 2.2));
  float material = hash21(material_cell + 173.0);
  float broken_surface = value_noise(
    uv * vec2(11.0, 9.0) + vec2(29.0, 83.0)
  );
  return mix(0.08, 0.92, broken_surface * 0.58 + material * 0.42);
}

struct DetachProfile {
  float center;
  float half_width;
  float core;
  float material;
};

float wind_sweep_delay(vec2 uv) {
  return uv.x * ${SAND_WIND_PROFILE.horizontalSweepDuration};
}

float continuous_detach_time(vec2 uv, float material) {
  float coherent_edge = value_noise(
    uv * vec2(3.4, 3.0) + vec2(7.0, 17.0 + u_seed * 0.003)
  ) - 0.5;
  float macro = value_noise(vec2(
    uv.x * 5.0 - uv.y * 0.45,
    uv.y * 5.5
  ) + vec2(19.0, 31.0)) - 0.5;
  float meso = value_noise(vec2(
    uv.x * 12.0 - uv.y * 0.7,
    uv.y * 13.0
  ) + vec2(53.0, 71.0)) - 0.5;
  float fine = value_noise(
    uv * vec2(23.0, 79.0) + vec2(89.0, 101.0)
  ) - 0.5;
  float grain = hash21(
    floor(uv * u_resolution / vec2(2.0, 1.4)) + 97.0
  ) - 0.5;
  return clamp(
    ${SAND_WIND_PROFILE.baseTimeOffset} +
    uv.y * ${SAND_WIND_PROFILE.verticalRiseDuration} +
    wind_sweep_delay(uv) +
    coherent_edge * 0.16 + macro * 0.07 + meso * 0.035 +
    fine * 0.012 + grain * 0.01 + (material - 0.5) * 0.06,
    0.015,
    0.965
  );
}

DetachProfile detach_profile(vec2 uv) {
  float core = core_strength(uv);
  float material = material_threshold(uv);
  float activation = continuous_detach_time(uv, material);
  float half_width = 0.065;

  DetachProfile result;
  result.center = clamp(
    activation,
    half_width + 0.006,
    0.994 - half_width
  );
  result.half_width = half_width;
  result.core = core;
  result.material = material;
  return result;
}

float right_edge_fade(float x, float random_offset) {
  float start = 0.945 + random_offset * 0.012;
  float end = 1.025 + random_offset * 0.01;
  return 1.0 - smoother01((x - start) / max(0.001, end - start));
}
`;

/** 原位舊圖只負責顯示尚未脫落的來源像素。 */
export const SAND_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_outgoing_image;
uniform vec2 u_resolution;
uniform vec4 u_crop;
uniform vec4 u_scrim;
uniform float u_progress;
uniform float u_seed;

in vec2 v_uv;
out vec4 out_color;

${SAND_FIELD_GLSL}

vec2 source_texture_uv(vec2 screen_uv) {
  return u_crop.xy + screen_uv * u_crop.zw;
}

vec4 sample_source(vec2 screen_uv) {
  return texture(u_outgoing_image, source_texture_uv(screen_uv));
}

void main() {
  DetachProfile detach = detach_profile(v_uv);
  // 舊圖以大尺度崩解島脫落，不讓線性時間場顯露成斜向 wipe。
  float island_macro = value_noise(
    v_uv * vec2(2.2, 2.6) + vec2(37.0, 59.0)
  );
  float island_detail = value_noise(
    v_uv * vec2(6.0, 5.2) + vec2(73.0, 91.0)
  );
  float island_detach_time = 0.06 + 0.88 * (
    island_macro * 0.42 + island_detail * 0.44 + detach.material * 0.14
  );
  float anchor_breakup = (island_detail - 0.5) * 0.06;
  float raw_anchor_center = mix(
    island_detach_time,
    detach.center,
    0.65
  ) + anchor_breakup;
  float spatial_antialias = max(
    fwidth(raw_anchor_center),
    1.0 / max(u_resolution.x, u_resolution.y)
  );
  // 在厚實的破碎區內以穩定網點逐顆脫落，避免形成一條掃描線。
  float erosion_feather = detach.half_width + spatial_antialias;
  float anchor_center = clamp(
    raw_anchor_center,
    erosion_feather,
    1.0 - erosion_feather
  );
  float coverage = smoother01(
    (anchor_center - u_progress + erosion_feather) /
      (erosion_feather * 2.0)
  );
  float clump_noise = value_noise(
    gl_FragCoord.xy / vec2(8.0, 6.0) + vec2(13.0, 29.0)
  );
  float grain_noise = hash21(floor(gl_FragCoord.xy) + 211.0);
  float stable_noise =
    clump_noise * 0.62 + grain_noise * 0.28 + detach.material * 0.1;
  float intact_alpha = step(stable_noise, coverage);

  vec4 intact_sample = sample_source(v_uv);
  vec3 intact_color = intact_sample.rgb;
  float rendered_alpha = intact_alpha * intact_sample.a;
  vec3 screened_color = mix(intact_color, u_scrim.rgb, u_scrim.a);
  out_color = vec4(screened_color * rendered_alpha, rendered_alpha);
}
`;

/**
 * 每個 gl_VertexID 對應舊圖固定來源格點；位置只會由來源向右前進。
 * 這是向前粒子搬運，不會再產生反向取樣的 texture folding 或垂直色柱。
 */
export const PARTICLE_VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform ivec2 u_particle_grid;
uniform float u_progress;
uniform float u_seed;
uniform int u_haze_pass;

out vec2 v_source_uv;
out float v_particle_alpha;
out float v_angle;
out float v_particle_kind;
out float v_color_gain;

${SAND_FIELD_GLSL}

// 低頻風團只調整砂塵密度、揚升與亂流，不改變侵蝕啟動時間或風向。
float wind_gust_strength(vec2 uv) {
  float slow_gust = value_noise(vec2(
    uv.y * 2.15 - u_progress * 1.45,
    uv.x * 1.2 + u_seed * 0.002
  ));
  float secondary_gust = value_noise(vec2(
    uv.y * 3.7 - u_progress * 2.25 + 31.0,
    uv.x * 1.85 + u_seed * 0.003 + 47.0
  ));
  return mix(
    ${SAND_PARTICLE_PROFILE.minimumGustStrength},
    ${SAND_PARTICLE_PROFILE.maximumGustStrength},
    slow_gust * 0.72 + secondary_gust * 0.28
  );
}

void main() {
  const int trail_samples = 4;
  int source_index = u_haze_pass == 1
    ? gl_VertexID
    : gl_VertexID / trail_samples;
  int trail_index = u_haze_pass == 1
    ? 0
    : gl_VertexID - source_index * trail_samples;
  int column = source_index % u_particle_grid.x;
  int row = source_index / u_particle_grid.x;
  float vertex_index = float(source_index);
  vec2 cell = vec2(float(column), float(row));
  vec2 jitter = vec2(
    hash21(vec2(vertex_index, 17.0)),
    hash21(vec2(vertex_index, 53.0))
  ) - 0.5;
  vec2 source_uv = (cell + 0.5 + jitter * 0.94) /
    vec2(u_particle_grid);
  float random = hash21(vec2(vertex_index, 97.0));
  float particle_type = hash21(vec2(vertex_index, 211.0));
  // 75% 細砂、20% 中砂、5% 小碎片；同一級距同時控制尺寸與運動。
  float grain_fineness = particle_type < 0.75
    ? mix(1.0, 0.62, particle_type / 0.75)
    : (
      particle_type < 0.95
        ? mix(0.55, 0.25, (particle_type - 0.75) / 0.2)
        : mix(0.18, 0.0, (particle_type - 0.95) / 0.05)
    );
  float grain_mobility = smoother01(grain_fineness);
  float airborne = smoother01((grain_mobility - 0.28) / 0.52);
  float source_core = gaussian(
    source_uv.x,
    core_center(source_uv.y),
    0.045
  );
  float source_shoulder = gaussian(
    source_uv.x,
    core_center(source_uv.y) + 0.075,
    0.14
  );
  float density_random = hash21(vec2(vertex_index, 149.0));
  DetachProfile detach = detach_profile(source_uv);
  float born_at = detach.center;
  float life = mix(
    0.2 + random * 0.065,
    0.34 + random * 0.1,
    grain_mobility
  );
  if (u_haze_pass == 1) {
    life = 0.14 + random * 0.07;
  }
  float flight_time = u_progress - born_at;
  float trail_random = hash21(vec2(
    vertex_index,
    401.0 + float(trail_index) * 37.0
  ));
  float trail_delay = float(trail_index) * (
    0.003 + random * ${SAND_PARTICLE_PROFILE.maximumTrailDelay - 0.003}
  ) * mix(0.82, 1.18, trail_random) * mix(
    ${SAND_PARTICLE_PROFILE.coarseTrailScale},
    ${SAND_PARTICLE_PROFILE.fineTrailScale},
    grain_mobility
  );
  float trail_time = flight_time - trail_delay;
  float trail_age = trail_time / life;
  float gust_strength = wind_gust_strength(source_uv);

  float horizontal_speed = mix(
    ${SAND_PARTICLE_PROFILE.coarseHorizontalSpeed} + random * 0.42,
    ${SAND_PARTICLE_PROFILE.fineHorizontalSpeed} + random * 0.58,
    grain_mobility
  );
  horizontal_speed *= u_haze_pass == 1 ? 0.92 : 1.0;
  float horizontal_travel = max(0.0, trail_time) * horizontal_speed;
  float preliminary_x = source_uv.x + horizontal_travel;
  float destination_core = gaussian(
    preliminary_x,
    core_center(source_uv.y),
    0.06
  );
  float wind_height_center = clamp(
    ${SAND_PARTICLE_PROFILE.windHeightOffset} +
      u_progress * ${SAND_PARTICLE_PROFILE.windHeightSpeed},
    ${SAND_PARTICLE_PROFILE.minimumWindHeight},
    ${SAND_PARTICLE_PROFILE.maximumWindHeight}
  );
  float height_core = gaussian(
    source_uv.y,
    wind_height_center,
    0.075
  );
  float height_shoulder = gaussian(
    source_uv.y,
    wind_height_center,
    0.125
  );
  float plume_core = destination_core * height_core;
  float tail_distance = max(
    0.0,
    preliminary_x - core_center(source_uv.y)
  );
  float tail_stream =
    smoother01(tail_distance / 0.035) *
    exp(-tail_distance / 0.23) *
    height_shoulder;
  float wake_turbulence = value_noise(vec2(
    preliminary_x * 7.5 - trail_age * 3.2,
    source_uv.y * 9.0 + u_seed * 0.004
  )) - 0.5;
  float ridge_density = gaussian(
    preliminary_x,
    core_center(source_uv.y) + 0.035,
    0.06
  ) * gaussian(source_uv.y, wind_height_center, 0.082);
  float downwind_tail = tail_stream;
  float updraft = (ridge_density + tail_stream * 0.58) *
    mix(0.7, 1.0, grain_mobility) * gust_strength;
  float main_density = saturate(
    (ridge_density * 0.98 + tail_stream * 0.72) * gust_strength
  );
  float flow_density = saturate(
    (ridge_density * 0.99 +
      tail_stream * ${SAND_PARTICLE_PROFILE.tailDensity} +
      source_core * height_core * 0.06) * gust_strength
  );
  float haze_density = saturate(
    ridge_density * 0.94 + tail_stream * 0.14
  );
  bool hidden_haze = u_haze_pass == 1 && (
    trail_index != 0 || density_random > haze_density
  );
  // 主粒同樣受密度閘門控制，避免來源格點重新拼成一張移動中的照片。
  bool hidden_grain = u_haze_pass == 0 &&
    density_random > (trail_index == 0 ? main_density : flow_density);

  if (
    trail_age <= 0.0 ||
    trail_age >= 1.0 ||
    hidden_haze ||
    hidden_grain
  ) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    v_source_uv = source_uv;
    v_particle_alpha = 0.0;
    v_angle = 0.0;
    v_particle_kind = 0.0;
    v_color_gain = 1.0;
    return;
  }

  float travel = trail_age * (2.0 - trail_age);
  float arc = 4.0 * trail_age * (1.0 - trail_age);
  float shared_wind = value_noise(
    source_uv * vec2(2.2, 11.0) +
      vec2(
        -trail_age * 2.8,
        trail_age * 0.35 + u_seed * 0.003
      )
  ) - 0.5;
  float micro_flutter =
    sin(trail_age * 18.0 + random * 6.28318530718) * 0.62 +
    sin(trail_age * 31.0 + particle_type * 6.28318530718) * 0.38;
  float scatter_x = hash21(vec2(vertex_index, 331.0)) - 0.5;
  float scatter_y = hash21(vec2(vertex_index, 379.0)) - 0.5;
  float band_convergence = (
    wind_height_center - source_uv.y
  ) * mix(0.16, 0.36, grain_mobility) * smoother01(trail_age / 0.2);
  float top_headroom = 1.0 - smoother01(
    (source_uv.y - 0.64) / 0.24
  );
  float late_visibility = smoother01((u_progress - 0.68) / 0.18);
  vec2 displacement = vec2(
    horizontal_travel +
      shared_wind * 0.014 * sin(3.14159265 * trail_age) +
      micro_flutter * 0.0035 * arc +
      scatter_x * mix(0.022, 0.042, grain_mobility) * arc * gust_strength,
    (
      band_convergence +
      updraft * mix(
        ${SAND_PARTICLE_PROFILE.coarseLiftStrength},
        ${SAND_PARTICLE_PROFILE.fineLiftStrength},
        grain_mobility
      ) * arc +
      shared_wind * 0.014 * sin(3.14159265 * trail_age) +
      wake_turbulence * mix(0.023, 0.048, grain_mobility) *
        arc * gust_strength +
      micro_flutter * 0.006 * arc +
      scatter_y * mix(0.01, 0.022, grain_mobility) * arc +
      (trail_random - 0.5) * 0.012 * smoother01(trail_age / 0.16) -
      tail_stream * grain_mobility * 0.014 * smoother01(trail_age)
    ) * top_headroom
  );
  vec2 destination_uv = source_uv + displacement;
  float edge = right_edge_fade(destination_uv.x, random - 0.5);
  float particle_fade_end = mix(
    0.985,
    1.0,
    hash21(vec2(vertex_index, 521.0))
  );
  float particle_fade_start = particle_fade_end - 0.045;
  float final_fade = 1.0 - smoother01(
    (u_progress - particle_fade_start) /
      (particle_fade_end - particle_fade_start)
  );
  float entrance_fade = smoother01(trail_age / 0.1);
  float life_fade_start = mix(
    0.76,
    0.88,
    hash21(vec2(vertex_index, 557.0)) * 0.55 + grain_mobility * 0.45
  );
  float life_fade = 1.0 - smoother01(
    (trail_age - life_fade_start) / (1.0 - life_fade_start)
  );
  float trail_weight = trail_index == 0
    ? 1.0
    : (
      trail_index == 1
        ? 0.78
        : (trail_index == 2 ? 0.55 : (trail_index == 3 ? 0.35 : 0.2))
    );
  float source_alpha = mix(
    0.12 + ridge_density * 0.68 + tail_stream * 0.38,
    0.1 + ridge_density * 0.56 + tail_stream * 0.44,
    airborne
  );
  float main_alpha =
    0.16 + random * 0.1 + ridge_density * 0.78 + tail_stream * 0.48;
  float trail_alpha = source_alpha * trail_weight;
  float grain_alpha = entrance_fade * edge * final_fade * life_fade *
    (trail_index == 0 ? main_alpha : trail_alpha) *
    (0.78 + random * 0.22);
  float obvious_plume_alpha =
    entrance_fade * edge * final_fade * life_fade *
    (0.03 +
      ridge_density * ${SAND_PARTICLE_PROFILE.coreOpacity - 0.03} +
      tail_stream * 0.3);
  v_particle_alpha = saturate(
    (u_haze_pass == 1 ? obvious_plume_alpha : grain_alpha) *
      (1.0 + late_visibility *
        ${SAND_PARTICLE_PROFILE.lateProgressOpacityBoost})
  );
  vec2 sample_scatter = vec2(
    hash21(vec2(vertex_index, 443.0 + float(trail_index) * 13.0)),
    hash21(vec2(vertex_index, 487.0 + float(trail_index) * 17.0))
  ) - 0.5;
  vec2 color_sample_uv = clamp(
    source_uv + sample_scatter * mix(0.035, 0.07, airborne) *
      smoother01(trail_age / 0.14),
    vec2(0.002),
    vec2(0.998)
  );
  v_source_uv = color_sample_uv;
  v_angle = (hash21(vec2(
    vertex_index,
    263.0 + float(trail_index) * 19.0
  )) - 0.5) * 0.42;
  v_particle_kind = u_haze_pass == 1
    ? 2.0
    : (trail_index == 0 ? 0.0 : 1.0);
  // 只調整亮度，不替換來源 RGB；砂塵仍是舊圖本身的像素顆粒。
  v_color_gain = ${SAND_PARTICLE_PROFILE.baseColorGain} +
    ridge_density * ${
  SAND_PARTICLE_PROFILE.coreColorGain - SAND_PARTICLE_PROFILE.baseColorGain
} + tail_stream * ${SAND_PARTICLE_PROFILE.tailColorGain} +
    late_visibility * ${SAND_PARTICLE_PROFILE.lateProgressColorGain};
  gl_Position = vec4(destination_uv * 2.0 - 1.0, 0.0, 1.0);
  float main_size = mix(
    2.05 + random * 0.75,
    1.1 + random * 0.55,
    grain_mobility
  ) + ridge_density * 0.32;
  float trail_size = mix(
    2.75 + random * 0.85,
    1.5 + random * 0.72,
    grain_mobility
  ) + ridge_density * 0.42;
  float grain_size = trail_index == 0 ? main_size : trail_size;
  float haze_size = 2.3 + random * 1.05 + ridge_density * 0.4;
  gl_PointSize = min(
    ${SAND_PARTICLE_PROFILE.maximumPointSize.toFixed(1)},
    mix(grain_size, haze_size, float(u_haze_pass))
  );
}
`;

export const PARTICLE_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_outgoing_image;
uniform vec4 u_crop;
uniform vec4 u_scrim;

in vec2 v_source_uv;
in float v_particle_alpha;
in float v_angle;
in float v_particle_kind;
in float v_color_gain;
out vec4 out_color;

void main() {
  vec2 point = gl_PointCoord - 0.5;
  float cosine = cos(v_angle);
  float sine = sin(v_angle);
  point = mat2(cosine, -sine, sine, cosine) * point;
  float angle = atan(point.y, point.x);
  float irregular_edge = 0.9 +
    sin(angle * 5.0 + v_angle * 7.0) * 0.07 +
    sin(angle * 9.0 - v_angle * 11.0) * 0.03;
  float main_distance =
    length(point * vec2(0.82, 1.25)) * 2.0 / irregular_edge;
  float main_shape = 1.0 - smoothstep(0.7, 1.0, main_distance);
  float trail_distance =
    length(point * vec2(0.58, 1.5)) * 2.0 / irregular_edge;
  float trail_shape = 1.0 - smoothstep(0.65, 1.0, trail_distance);
  float haze_distance =
    length(point * vec2(0.52, 1.4)) * 2.0 / irregular_edge;
  float haze_shape = 1.0 - smoothstep(0.58, 1.0, haze_distance);
  float shape = v_particle_kind < 0.5
    ? main_shape
    : (v_particle_kind < 1.5 ? trail_shape : haze_shape);
  float alpha = v_particle_alpha * shape;
  if (alpha < 0.001) {
    discard;
  }
  vec2 texture_uv = u_crop.xy + v_source_uv * u_crop.zw;
  vec4 source_sample = texture(u_outgoing_image, texture_uv);
  alpha *= source_sample.a;
  if (alpha < 0.001) {
    discard;
  }
  vec3 source_texel = source_sample.rgb;
  float light_scrim = step(
    0.5,
    dot(u_scrim.rgb, vec3(0.299, 0.587, 0.114))
  );
  // 黑遮罩向亮處拉、白遮罩向暗處拉；兩者都只從來源像素衍生。
  vec3 lifted_texel = pow(max(source_texel, vec3(0.004)), vec3(0.72));
  vec3 darkened_texel = pow(max(source_texel, vec3(0.004)), vec3(1.28));
  vec3 dark_scrim_color =
    mix(
      source_texel,
      lifted_texel,
      ${SAND_PARTICLE_PROFILE.gammaLiftMix}
    ) * v_color_gain;
  float light_scrim_gain = min(0.95, 1.0 / max(0.01, v_color_gain));
  vec3 light_scrim_color =
    mix(source_texel, darkened_texel, 0.34) * light_scrim_gain;
  vec3 source_color = clamp(
    mix(dark_scrim_color, light_scrim_color, light_scrim),
    0.0,
    1.0
  );
  out_color = vec4(source_color * alpha, alpha);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('無法建立風吹砂 WebGL shader。');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || '未知 shader 編譯錯誤';
    gl.deleteShader(shader);
    throw new Error(`風吹砂 WebGL shader 編譯失敗：${message}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error('無法建立風吹砂 WebGL program。');
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || '未知 program 連結錯誤';
    gl.deleteProgram(program);
    throw new Error(`風吹砂 WebGL program 連結失敗：${message}`);
  }
  return program;
}

export function calculateSandRenderSize(width, height) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new RangeError('風吹砂 WebGL 畫面寬高必須是正數。');
  }
  const scale = Math.min(
    1,
    Math.sqrt(MAXIMUM_RENDER_PIXEL_COUNT / (width * height)),
    MAXIMUM_RENDER_EDGE / width,
    MAXIMUM_RENDER_EDGE / height,
  );
  return Object.freeze({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  });
}

export function calculateBottomLeftTextureCrop(image, crop) {
  if (
    !image ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0 ||
    !crop
  ) {
    throw new RangeError('風吹砂 WebGL 缺少有效圖片裁切資料。');
  }
  return Object.freeze({
    x: crop.sourceX / image.naturalWidth,
    y: 1 - (
      crop.sourceY + crop.sourceHeight
    ) / image.naturalHeight,
    width: crop.sourceWidth / image.naturalWidth,
    height: crop.sourceHeight / image.naturalHeight,
  });
}

/** 建立 GPU 圖片粒化 Renderer；不支援 WebGL2 時回傳 null 讓呼叫端降級。 */
export function createSandWebglRenderer({ canvas, random = Math.random } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('風吹砂 WebGL Renderer 缺少 Canvas。');
  }
  if (typeof random !== 'function') {
    throw new TypeError('風吹砂 WebGL Renderer 的亂數來源必須是函式。');
  }

  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    return null;
  }

  let anchoredProgram;
  let particleProgram;
  let buffer;
  let texture;
  let anchoredVertexArray;
  let particleVertexArray;

  try {
    anchoredProgram = createProgram(
      gl,
      FULLSCREEN_VERTEX_SHADER_SOURCE,
      SAND_FRAGMENT_SHADER_SOURCE,
    );
    particleProgram = createProgram(
      gl,
      PARTICLE_VERTEX_SHADER_SOURCE,
      PARTICLE_FRAGMENT_SHADER_SOURCE,
    );
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    anchoredVertexArray = gl.createVertexArray();
    particleVertexArray = gl.createVertexArray();
    if (
      !buffer ||
      !texture ||
      !anchoredVertexArray ||
      !particleVertexArray
    ) {
      throw new Error('無法配置風吹砂 WebGL buffer、texture 或 VAO。');
    }
  } catch {
    if (buffer) {
      gl.deleteBuffer(buffer);
    }
    if (texture) {
      gl.deleteTexture(texture);
    }
    if (anchoredVertexArray) {
      gl.deleteVertexArray(anchoredVertexArray);
    }
    if (particleVertexArray) {
      gl.deleteVertexArray(particleVertexArray);
    }
    if (anchoredProgram) {
      gl.deleteProgram(anchoredProgram);
    }
    if (particleProgram) {
      gl.deleteProgram(particleProgram);
    }
    return null;
  }

  const anchoredLocations = Object.freeze({
    position: gl.getAttribLocation(anchoredProgram, 'a_position'),
    outgoingImage: gl.getUniformLocation(
      anchoredProgram,
      'u_outgoing_image',
    ),
    resolution: gl.getUniformLocation(anchoredProgram, 'u_resolution'),
    crop: gl.getUniformLocation(anchoredProgram, 'u_crop'),
    scrim: gl.getUniformLocation(anchoredProgram, 'u_scrim'),
    progress: gl.getUniformLocation(anchoredProgram, 'u_progress'),
    seed: gl.getUniformLocation(anchoredProgram, 'u_seed'),
  });
  const particleLocations = Object.freeze({
    outgoingImage: gl.getUniformLocation(
      particleProgram,
      'u_outgoing_image',
    ),
    resolution: gl.getUniformLocation(particleProgram, 'u_resolution'),
    particleGrid: gl.getUniformLocation(particleProgram, 'u_particle_grid'),
    hazePass: gl.getUniformLocation(particleProgram, 'u_haze_pass'),
    crop: gl.getUniformLocation(particleProgram, 'u_crop'),
    scrim: gl.getUniformLocation(particleProgram, 'u_scrim'),
    progress: gl.getUniformLocation(particleProgram, 'u_progress'),
    seed: gl.getUniformLocation(particleProgram, 'u_seed'),
  });
  if (
    anchoredLocations.position < 0 ||
    !anchoredLocations.outgoingImage ||
    !anchoredLocations.resolution ||
    !anchoredLocations.crop ||
    !anchoredLocations.scrim ||
    !anchoredLocations.progress ||
    !anchoredLocations.seed ||
    !particleLocations.outgoingImage ||
    !particleLocations.resolution ||
    !particleLocations.particleGrid ||
    !particleLocations.hazePass ||
    !particleLocations.crop ||
    !particleLocations.scrim ||
    !particleLocations.progress ||
    !particleLocations.seed
  ) {
    gl.deleteBuffer(buffer);
    gl.deleteTexture(texture);
    gl.deleteVertexArray(anchoredVertexArray);
    gl.deleteVertexArray(particleVertexArray);
    gl.deleteProgram(anchoredProgram);
    gl.deleteProgram(particleProgram);
    return null;
  }

  gl.bindVertexArray(anchoredVertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      -1, 1,
      1, -1,
      1, 1,
    ]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(anchoredLocations.position);
  gl.vertexAttribPointer(
    anchoredLocations.position,
    2,
    gl.FLOAT,
    false,
    0,
    0,
  );
  gl.bindVertexArray(particleVertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindVertexArray(null);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.clearColor(0, 0, 0, 0);

  let disposed = false;
  let ready = false;
  let cropUniform = null;
  let scrimUniform = Object.freeze({
    red: 0,
    green: 0,
    blue: 0,
    alpha: 0.48,
  });
  let seed = 1;
  let particleColumns = 1;
  let particleRows = 1;
  let particleSourceCount = 1;
  let particleCount = 1;

  function setSharedUniforms(locations, progress) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(locations.outgoingImage, 0);
    gl.uniform2f(locations.resolution, canvas.width, canvas.height);
    gl.uniform4f(
      locations.crop,
      cropUniform.x,
      cropUniform.y,
      cropUniform.width,
      cropUniform.height,
    );
    gl.uniform1f(locations.progress, progress);
    gl.uniform1f(locations.seed, seed);
  }

  return Object.freeze({
    prepare({ image, crop, width, height, scrim = scrimUniform }) {
      if (disposed) {
        return false;
      }
      const scrimChannels = [
        scrim?.red,
        scrim?.green,
        scrim?.blue,
        scrim?.alpha,
      ];
      if (
        scrimChannels.some(
          (channel) => !Number.isFinite(channel) || channel < 0 || channel > 1,
        )
      ) {
        return false;
      }
      const renderSize = calculateSandRenderSize(width, height);
      cropUniform = calculateBottomLeftTextureCrop(image, crop);
      scrimUniform = Object.freeze({
        red: scrim.red,
        green: scrim.green,
        blue: scrim.blue,
        alpha: scrim.alpha,
      });
      canvas.width = renderSize.width;
      canvas.height = renderSize.height;
      // 約每 3.6 個渲染像素配置一個來源粒子；1080p 約 16 萬粒，
      // 能保留原圖顆粒，又不讓 4K HDMI 因粒子數翻四倍。
      particleColumns = Math.max(1, Math.round(canvas.width / 3.3));
      particleRows = Math.max(1, Math.round(canvas.height / 3.3));
      particleSourceCount = particleColumns * particleRows;
      particleCount = particleSourceCount * 4;
      seed = 1 + Math.min(0.999999, Math.max(0, random())) * 9_973;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      ready = gl.getError() === gl.NO_ERROR;
      return ready;
    },

    draw(progress) {
      if (disposed || !ready || !cropUniform) {
        return false;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const normalizedProgress = Math.min(1, Math.max(0, progress));

      // 第一個 pass：只畫尚未脫落的原位舊圖。
      gl.disable(gl.BLEND);
      gl.useProgram(anchoredProgram);
      gl.bindVertexArray(anchoredVertexArray);
      setSharedUniforms(anchoredLocations, normalizedProgress);
      gl.uniform4f(
        anchoredLocations.scrim,
        scrimUniform.red,
        scrimUniform.green,
        scrimUniform.blue,
        scrimUniform.alpha,
      );
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 第二個 pass：從同一來源格點向右繪製真實圖片砂粒。
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(particleProgram);
      gl.bindVertexArray(particleVertexArray);
      setSharedUniforms(particleLocations, normalizedProgress);
      gl.uniform4f(
        particleLocations.scrim,
        scrimUniform.red,
        scrimUniform.green,
        scrimUniform.blue,
        scrimUniform.alpha,
      );
      gl.uniform2i(
        particleLocations.particleGrid,
        particleColumns,
        particleRows,
      );
      // 先鋪極淡的中右懸浮砂霧，再畫細小圖片砂粒與兩段尾流。
      gl.uniform1i(particleLocations.hazePass, 1);
      gl.drawArrays(gl.POINTS, 0, particleSourceCount);
      gl.uniform1i(particleLocations.hazePass, 0);
      gl.drawArrays(gl.POINTS, 0, particleCount);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
      return gl.getError() === gl.NO_ERROR;
    },

    clear() {
      if (disposed) {
        return;
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
    },

    dispose() {
      if (disposed) {
        return;
      }
      gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      gl.deleteVertexArray(anchoredVertexArray);
      gl.deleteVertexArray(particleVertexArray);
      gl.deleteProgram(anchoredProgram);
      gl.deleteProgram(particleProgram);
      ready = false;
      disposed = true;
    },
  });
}
