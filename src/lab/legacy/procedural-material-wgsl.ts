/*!
 * Periodic modular Worley/domain-warp ideas adapted from looptile.
 * MIT License — Copyright (c) 2026 3merillon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export const PROCEDURAL_TERRAIN_BAKE_WGSL = /* wgsl */`
fn tmt_bake_materials(
  albedo_out: texture_storage_2d_array<rgba8unorm, write>,
  relief_out: texture_storage_2d_array<rgba16float, write>, index: u32
) -> void {
  let size = 512u;
  let layer = index / (size * size);
  if (layer >= 6u) { return; }
  let pixel = vec2<u32>(index % size, (index / size) % size);
  let uv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / f32(size);
  let seed = 137u + layer * 971u;
  let warp = vec2<f32>(tmt_fbm(uv, 4, seed), tmt_fbm(uv, 4, seed + 51u)) - vec2<f32>(0.5);
  let p = uv + warp * 0.13;
  let broad = tmt_fbm(p, 4, seed + 20u);
  let fine = tmt_fbm(p, 16, seed + 70u);
  let grit = tmt_noise(uv, 192, seed + 300u);
  var color = vec3<f32>(0.3);
  var rough = 0.85;
  var height = 0.5;

  if (layer == 0u) {
    // Sparse, interrupted fractures over broad eroded rock: no regular paving pattern.
    let cell = tmt_worley(p, 9, seed);
    let plate_edge = cell.y - cell.x;
    let fracture_gate = smoothstep(0.30, 0.56, tmt_noise(p, 5, seed + 9u));
    let fracture = (1.0 - smoothstep(0.023, 0.105, plate_edge)) * fracture_gate;
    let crease = (1.0 - smoothstep(0.035, 0.24, plate_edge)) * fracture_gate;
    let weathered_plate = smoothstep(0.04, 0.35, plate_edge);
    let ridge = 1.0 - abs(2.0 * tmt_noise(p, 11, seed + 201u) - 1.0);
    let facets = smoothstep(0.24, 0.76, tmt_noise(p, 24, seed + 80u));
    let chips = 1.0 - abs(2.0 * tmt_noise(p, 47, seed + 181u) - 1.0);
    let chip_mask = smoothstep(0.40, 0.69, fine);
    // Moisture controls which existing depressions retain moss. It cannot paint isolated
    // high-frequency spots across raised plates independently of the relief anymore.
    let moisture = smoothstep(0.33, 0.68, tmt_fbm(p, 3, seed + 42u));
    let depression = crease * 0.75 + (1.0 - ridge) * 0.16 + (1.0 - broad) * 0.15;
    let moss = smoothstep(0.25, 0.65, depression) * moisture;
    // 0.34 of the 42mm relief range gives the deepest interrupted fractures ~14mm depth.
    height = 0.25 + broad * 0.26 + ridge * 0.18 + facets * 0.16
      + (chips - 0.5) * chip_mask * 0.12 + (fine - 0.5) * 0.11
      + (grit - 0.5) * 0.038 - fracture * 0.34 + moss * 0.020;
    // Shared broad weathering, exposed plate interiors and ridges control pigmentation.
    // Sharpened small facets/chips remain in relief only, avoiding the camouflage pattern.
    let mineral = clamp(broad * 0.66 + weathered_plate * 0.18 + ridge * 0.16, 0.0, 1.0);
    color = mix(vec3<f32>(0.150, 0.161, 0.143), vec3<f32>(0.290, 0.300, 0.269), mineral);
    color = mix(color, vec3<f32>(0.120, 0.145, 0.076), moss * 0.56);
    // Thin mineral deposits follow the very same fracture center as the height field.
    // This is retained sediment, not a directional light or ambient-occlusion term.
    let deposit = (1.0 - smoothstep(0.012, 0.061, plate_edge)) * fracture_gate
      * (0.50 + broad * 0.50);
    color = mix(color, vec3<f32>(0.108, 0.118, 0.096), deposit * 0.43);
    color += vec3<f32>((grit - 0.5) * 0.012);
    rough = clamp(0.82 + (1.0 - ridge) * 0.06 + moss * 0.09 + (grit - 0.5) * 0.015, 0.80, 0.98);
  } else if (layer == 1u) {
    // Integer shear preserves the tile period while bending narrow mineral strata.
    let strata_uv = vec2<f32>(p.x + p.y, p.y);
    let strata = tmt_noise(strata_uv * vec2<f32>(1.0, 4.0), 8, seed + 88u);
    let mineral = 1.0 - abs(tmt_noise(p, 7, seed + 91u) * 2.0 - 1.0);
    let vein = smoothstep(0.83, 0.96, mineral) * smoothstep(0.33, 0.58, broad);
    let cell = tmt_worley(p, 7, seed + 102u);
    let fracture = (1.0 - smoothstep(0.008, 0.05, cell.y - cell.x))
      * smoothstep(0.31, 0.62, strata);
    height = 0.28 + broad * 0.32 + strata * 0.20 + (fine - 0.5) * 0.12
      + (grit - 0.5) * 0.025 + vein * 0.05 - fracture * 0.16;
    color = mix(vec3<f32>(0.245, 0.186, 0.125), vec3<f32>(0.400, 0.313, 0.210),
      broad * 0.55 + strata * 0.30 + fine * 0.15);
    color = mix(color, vec3<f32>(0.420, 0.335, 0.218), vein * 0.45);
    color += vec3<f32>((grit - 0.5) * 0.026);
    rough = 0.77 + fine * 0.15 - vein * 0.065;
  } else if (layer == 3u) {
    let ripples = sin((uv.y * 18.0 + tmt_noise(uv, 4, seed) * 0.5) * 6.2831853);
    height = 0.45 + ripples * 0.13 + (fine - 0.5) * 0.12 + (grit - 0.5) * 0.05;
    color = mix(vec3<f32>(0.30, 0.18, 0.075), vec3<f32>(0.52, 0.37, 0.19), broad);
    color += vec3<f32>((grit - 0.5) * 0.04);
    rough = 0.94;
  } else if (layer == 4u) {
    let crystals = tmt_worley(uv, 32, seed + 91u);
    height = 0.50 + (broad - 0.5) * 0.22 + (fine - 0.5) * 0.14 - crystals.x * 0.12;
    color = mix(vec3<f32>(0.37, 0.48, 0.54), vec3<f32>(0.64, 0.68, 0.70), broad);
    rough = mix(0.46, 0.86, fine);
  } else if (layer == 5u) {
    let plates = tmt_worley(uv, 9, seed + 45u);
    let fissure = 1.0 - smoothstep(0.015, 0.09, plates.y - plates.x);
    height = 0.35 + broad * 0.30 + fine * 0.14 - fissure * 0.27;
    color = mix(vec3<f32>(0.045, 0.049, 0.052), vec3<f32>(0.15, 0.13, 0.11), broad);
    color = mix(color, vec3<f32>(0.08, 0.041, 0.022), fissure * 0.4);
    rough = 0.82 + fine * 0.14;
  } else {
    let aggregate = tmt_worley(uv, 76, seed + 73u);
    let pit = (1.0 - smoothstep(0.035, 0.15, aggregate.x))
      * smoothstep(0.30, 0.64, tmt_noise(uv, 55, seed + 65u));
    let stone = smoothstep(0.27, 0.41, aggregate.x) * smoothstep(0.49, 0.68, fine);
    let board = fract(uv.y * 5.0 + tmt_noise(uv, 8, seed + 61u) * 0.006);
    let seam_distance = min(board, 1.0 - board);
    let joint = 1.0 - smoothstep(0.0025, 0.010, seam_distance);
    let grain = tmt_noise(uv * vec2<f32>(1.0, 8.0), 16, seed + 81u);
    height = 0.47 + (broad - 0.5) * 0.10 + (fine - 0.5) * 0.16
      + (grit - 0.5) * 0.055 + (grain - 0.5) * 0.025 + stone * 0.05
      - pit * 0.22 - joint * 0.12;
    color = mix(vec3<f32>(0.245, 0.261, 0.253), vec3<f32>(0.360, 0.374, 0.363),
      smoothstep(0.30, 0.70, broad * 0.45 + fine * 0.55));
    // Aggregate composition and retained formwork dust give concrete a readable grain.
    color = mix(color, vec3<f32>(0.170, 0.187, 0.179), stone * 0.44);
    color = mix(color, vec3<f32>(0.153, 0.168, 0.160), pit * 0.48);
    color = mix(color, vec3<f32>(0.186, 0.201, 0.191), joint * 0.30);
    color += vec3<f32>((grit - 0.5) * 0.035);
    rough = clamp(0.79 + fine * 0.12 + pit * 0.04, 0.77, 0.97);
  }
  textureStore(albedo_out, vec2<i32>(pixel), i32(layer), vec4<f32>(clamp(color, vec3<f32>(0.03), vec3<f32>(0.7)), 1.0));
  // Half float relief avoids quantization stair-steps in the finite-difference normals.
  textureStore(relief_out, vec2<i32>(pixel), i32(layer), vec4<f32>(0.0, 0.0, rough, clamp(height, 0.0, 1.0)));
}

fn tmt_hash(cell: vec2<i32>, period: i32, seed: u32) -> f32 {
  let wrapped = ((cell % vec2<i32>(period)) + vec2<i32>(period)) % vec2<i32>(period);
  var h = u32(wrapped.x) * 374761393u + u32(wrapped.y) * 668265263u + seed * 1442695041u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h & 16777215u) / 16777216.0;
}

fn tmt_noise(uv: vec2<f32>, period: i32, seed: u32) -> f32 {
  let p = uv * f32(period);
  let cell = vec2<i32>(floor(p));
  let f = fract(p);
  let s = f * f * f * (f * (f * 6.0 - vec2<f32>(15.0)) + vec2<f32>(10.0));
  return mix(mix(tmt_hash(cell, period, seed), tmt_hash(cell + vec2<i32>(1, 0), period, seed), s.x),
    mix(tmt_hash(cell + vec2<i32>(0, 1), period, seed), tmt_hash(cell + vec2<i32>(1, 1), period, seed), s.x), s.y);
}

fn tmt_fbm(uv: vec2<f32>, base: i32, seed: u32) -> f32 {
  return (tmt_noise(uv, base, seed) * 0.5 + tmt_noise(uv, base * 2, seed + 13u) * 0.25
    + tmt_noise(uv, base * 4, seed + 29u) * 0.125 + tmt_noise(uv, base * 8, seed + 53u) * 0.0625) / 0.9375;
}

fn tmt_worley(uv: vec2<f32>, period: i32, seed: u32) -> vec2<f32> {
  let p = uv * f32(period);
  let cell = vec2<i32>(floor(p));
  let f = fract(p);
  var nearest = 8.0;
  var second = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2<i32>(x, y);
      // Keeping points in the middle 60% makes the 3x3 neighbourhood sufficient.
      let point = vec2<f32>(0.2) + vec2<f32>(tmt_hash(cell + offset, period, seed),
        tmt_hash(cell + offset, period, seed + 47u)) * 0.6;
      let delta = vec2<f32>(offset) + point - f;
      let distance = dot(delta, delta);
      if (distance < nearest) { second = nearest; nearest = distance; }
      else { second = min(second, distance); }
    }
  }
  return sqrt(vec2<f32>(nearest, second));
}
`;

export const PROCEDURAL_TERRAIN_NORMAL_WGSL = /* wgsl */`
fn tmt_bake_normals(relief: texture_2d_array<f32>,
  surface_out: texture_storage_2d_array<rgba8unorm, write>, index: u32
) -> void {
  let size = 512u;
  let layer = i32(index / (size * size));
  if (layer >= 6) { return; }
  let p = vec2<i32>(i32(index % size), i32((index / size) % size));
  let tile_widths = array<f32, 6>(2.5, 2.0, 2.5, 3.0, 3.0, 2.5);
  let amplitudes = array<f32, 6>(0.042, 0.032, 0.012, 0.025, 0.018, 0.048);
  let xm = vec2<i32>((p.x + 511) % 512, p.y);
  let xp = vec2<i32>((p.x + 1) % 512, p.y);
  let ym = vec2<i32>(p.x, (p.y + 511) % 512);
  let yp = vec2<i32>(p.x, (p.y + 1) % 512);
  let dx = textureLoad(relief, xp, layer, 0).a - textureLoad(relief, xm, layer, 0).a;
  let dy = textureLoad(relief, yp, layer, 0).a - textureLoad(relief, ym, layer, 0).a;
  let slope_scale = amplitudes[layer] * f32(size) / (2.0 * tile_widths[layer]);
  let normal = normalize(vec3<f32>(-dx * slope_scale, -dy * slope_scale, 1.0));
  let source = textureLoad(relief, p, layer, 0);
  textureStore(surface_out, p, layer, vec4<f32>(normal.xy * 0.5 + vec2<f32>(0.5), source.b, source.a));
}
`;
