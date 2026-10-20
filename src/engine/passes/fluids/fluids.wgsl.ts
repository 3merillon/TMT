/**
 * Planet-wide liquids: the WGSL of the level map and the liquid composite.
 * The water itself (the shallow-water step, the drawn surface and the atlas) is in water.wgsl.ts.
 *
 * - The level map is a cube-sphere grid of N² cells per face (fluids.ts sizes it by tier). `bed` marches the planet SDF
 *   (pending craters included) inward along each cell's direction, refining to the submerged floor beneath roofs.
 * - The atlas (water.wgsl.ts `pack`) holds the six faces as a 3 × 2 grid of (N + 2)² tiles, each with a one-cell gutter
 *   copied from the neighbouring faces, so bilinear lookups never see a seam.
 * - `cache` lights each cell with a surface once from that surface, half the texels per frame: SDF sun and moon
 *   visibility, a 5-tap SDF AO and the fog-of-war hidden fraction (the per-cell veil, D7).
 * - The composite is a second entry point, `fluid_main`, linked after the lighting module, so the water uses the lighting
 *   pass's own functions and bind groups (SDF shadows, tank casters, GI, sky light, atmosphere, the war-fog colour and
 *   mist). Per pixel: the liquid surface's depth (drawn by water.ts in front of the scene), then resin water or lava from
 *   the atlas at that point; dry terrain near a liquid level gets the wet band.
 * - `depth` writes the liquid surface's depth and camera-motion velocity, so DOF, TAA and later passes see the surface.
 */
import { makeModule } from '../../wgsl/module';
import { cubeSphereWgsl } from '../../wgsl/common/cube-sphere.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { materialClassWgsl } from '../../wgsl/common/constants.wgsl';
import { SDF_MAX_CUTS, sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { fogParamsBindingWgsl, fogVisibilityWgsl } from '../fog-of-war/fog.wgsl';
import { LIGHTING_TERM } from '../lighting/lighting.wgsl';
import { LIQUID_PARAMS, LIQUID_TOGGLE, LIQUID_VIEW, WATER_FRONT_MARK, WATER_TILE_WORDS } from './liquid-params';
import { levelMapAddressWgsl, waterSwellWgsl, waterTileWgsl } from './water.wgsl';
import { underwaterWgsl } from './underwater.wgsl';
import { lavaImmersionWgsl } from './lava-optics.wgsl';

export { LIQUID_MAX_BASINS, LIQUID_PARAMS, LIQUID_TOGGLE, LIQUID_TOGGLES_ALL, LIQUID_VIEW } from './liquid-params';
export type { LiquidDebugView } from './liquid-params';

// ───────────────────────────── Level map: bed, atlas pack, lighting cache ─────────────────────────────

/** Shared with the GPU regression fixture: requires sdf_sample. */
export const liquidFloorWgsl = makeModule('liquid-floor', /* wgsl */ `
fn liquid_floor(d: vec3f, start: f32) -> f32 {
  var r = start;
  for (var i = 0u; i < 192u; i++) {
    let s = sdf_sample(d * r);
    if (s < 0.004) { break; }
    r -= max(s * 0.8, 0.004);
    if (r < 4.0) { break; }
  }
  return r;
}
fn liquid_bed_below(d: vec3f, outer: f32, level: f32) -> f32 {
  // A roof above open water is not its bed. Only enter air at the liquid level;
  // solid walls remain barriers, and unconnected cavities are never auto-filled.
  if (level > 4.0 && outer > level && sdf_sample(d * level) > 0.004) {
    return liquid_floor(d, level);
  }
  return outer;
}
`);

export const liquidBedWgsl = makeModule('liquid-bed', /* wgsl */ `
@group(0) @binding(0) var<uniform> job: vec4u;   // x cells per face edge, y refine under roofs, z only cells a cut can reach
@group(0) @binding(1) var<storage, read_write> bed_out: array<f32>;
@group(0) @binding(2) var<uniform> P: LiquidParams;
@group(0) @binding(3) var<storage, read> bed_labels: array<u32>;
@group(0) @binding(4) var<storage, read_write> bed_changed: array<atomic<u32>>;   // the water's tiles whose bed changed
// The crater cuts of the last march, then their count (x).
@group(0) @binding(5) var<storage, read_write> bed_cuts: array<vec4f, ${SDF_MAX_CUTS + 1}>;

/**
 * Whether a cut sphere comes within reach of the radial line through d. Outside every cut sphere sdf_sample equals the
 * terrain wherever either is at least the march's 0.004 threshold, so a march that never enters one is unchanged.
 */
fn bed_reaches(cut: vec4f, d: vec3f) -> bool {
  let along = dot(cut.xyz, d);
  return length(cut.xyz) <= cut.w + 0.05 || (along > 0.0 && length(cut.xyz - d * along) <= cut.w + 0.05);
}
/** A cut-only march (job.z) keeps every cell no cut reaches now or reached at the last march (its bed is the terrain's). */
fn bed_cut_reach(d: vec3f) -> bool {
  for (var i = 0u; i < min(u32(sdf_params.info.w), ${SDF_MAX_CUTS}u); i++) { if (bed_reaches(sdf_params.cuts[i], d)) { return true; } }
  for (var i = 0u; i < u32(bed_cuts[${SDF_MAX_CUTS}u].x); i++) { if (bed_reaches(bed_cuts[i], d)) { return true; } }
  return false;
}

/** The outermost terrain radius along each cell's direction: march the SDF inward from r = 24. */
@compute @workgroup_size(8, 8, 1)
fn bed(@builtin(global_invocation_id) g: vec3u) {
  let n = job.x;
  if (g.x >= n || g.y >= n || g.z >= 6u) { return; }
  let d = cs_dir(g.z, (vec2f(g.xy) + 0.5) / f32(n) * 2.0 - 1.0);
  if (job.z != 0u && !bed_cut_reach(d)) { return; }
  var r = liquid_floor(d, 24.0);
  if (job.y != 0u) {
    var level = P.coarse.z;
    let nc = u32(P.coarse.x);
    let uv = cs_uv(d, g.z);
    // Lake shores use their own level, including fine cells beneath a lip whose
    // coarse label is dry. The sea's level also reaches broad coastal roofs.
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let label = bed_labels[lm_cell(cs_dir(g.z, uv + vec2f(f32(x), f32(y)) * (2.0 / f32(nc))), nc)];
        if (label > 0u && label <= u32(P.info.x)) { level = max(level, P.basins[label - 1u].x); }
      }
    }
    r = liquid_bed_below(d, r, level);
  }
  let c = (g.z * n + g.y) * n + g.x;
  // The water skips tiles where nothing happens; a tile whose bed moved has new ground to draw.
  if (job.y != 0u && bitcast<u32>(bed_out[c]) != bitcast<u32>(r)) {
    let t = w_tile(c, n);
    atomicOr(&bed_changed[t >> 5u], 1u << (t & 31u));
  }
  bed_out[c] = r;
}

/** After a fine march: remember its cuts, so the next cut-only march also restores the cells a withdrawn cut reached. */
@compute @workgroup_size(1)
fn bed_remember() {
  let count = min(u32(sdf_params.info.w), ${SDF_MAX_CUTS}u);
  for (var i = 0u; i < count; i++) { bed_cuts[i] = sdf_params.cuts[i]; }
  bed_cuts[${SDF_MAX_CUTS}u] = vec4f(f32(count), 0.0, 0.0, 0.0);
}
`, [cubeSphereWgsl, LIQUID_PARAMS.module, levelMapAddressWgsl, waterTileWgsl, sdfBindingsWgsl(1, { volume: 0, params: 1, sampler: 2 }), sdfWgsl, liquidFloorWgsl]);

export const liquidCacheWgsl = makeModule('liquid-cache', /* wgsl */ `
@group(0) @binding(0) var<uniform> P: LiquidParams;
@group(0) @binding(1) var atlas_in: texture_2d<f32>;
@group(0) @binding(2) var cache_out: texture_storage_2d<rgba8unorm, write>;

/** Per cell with a surface, from that surface: x sun visibility, y moon visibility, z AO, w fog-of-war hidden. */
@compute @workgroup_size(8, 8, 1)
fn cache(@builtin(global_invocation_id) g: vec3u) {
  let n = u32(P.grid.x);
  if (g.x >= 3u * (n + 2u) || g.y >= 2u * (n + 2u)) { return; }
  // Half the texels per frame (checkerboard); sensors and the sun move slowly.
  if (((g.x + g.y + u32(P.coarse.y)) & 1u) != 0u) { return; }
  let a = textureLoad(atlas_in, g.xy, 0);
  if (a.x <= 0.0) { textureStore(cache_out, g.xy, vec4f(1.0, 1.0, 1.0, 0.0)); return; }
  let up = lm_texel_dir(g.xy, n);
  let p = up * a.x;
  let vox = sdf_voxel();
  // At the shore the surface point can lie inside the rising terrain: traced from there, every shore cell read as
  // shadowed, occluded and hidden (a dark, cell-stepped band along the waterline). Step out of the field first, as the
  // terrain's own shadow origin does; the water there is thin and lit like the ground under it.
  let o = p + up * (max(-sdf_sample(p), 0.0) + vox * 0.75);
  var sun = 0.0;
  if (dot(up, P.sun.xyz) > -0.2) { sun = sdf_vis_dir(o, P.sun.xyz, P.sun.w, vox, 48u); }
  var moon = 0.0;
  if (dot(up, P.moon.xyz) > -0.2) { moon = sdf_vis_dir(o, P.moon.xyz, P.moon.w, vox, 32u); }
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 0; i < 5; i++) {
    let h = 0.12 + 0.45 * f32(i);
    occ += max(h - sdf_sample(o + up * h), 0.0) * sca;
    sca *= 0.72;
  }
  let ao = clamp(1.0 - 0.3 * occ, 0.0, 1.0);
  var hidden = 0.0;
  // Line of sight only: water is not an occluder, so a surface has no back face toward a sensor under it (a tank driving
  // through water must not fog the surface over it). The trace is the one used for points in the air.
  if (fog_enabled()) { hidden = fog_hidden_air(o, 0.5, u32(fog_params.march.y)); }
  textureStore(cache_out, g.xy, vec4f(sun, moon, ao, hidden));
}
`, [cubeSphereWgsl, LIQUID_PARAMS.module, levelMapAddressWgsl, materialClassWgsl, sdfBindingsWgsl(1, { volume: 0, params: 1, sampler: 2 }), sdfWgsl,
  fogParamsBindingWgsl(1, 3), fogVisibilityWgsl]);

// ───────────────────────────── Composite (a second entry point of the lighting module) ─────────────────────────────

/** Group 3 of the composite; everything else is the lighting pass's own groups 0–2. */
export const liquidCompositeWgsl = makeModule('liquid-composite', /* wgsl */ `
@group(3) @binding(0) var<uniform> liq: LiquidParams;
@group(3) @binding(1) var liq_atlas: texture_2d<f32>;    // surface radius (0 none), ground (bed + lava), water depth, lava depth
@group(3) @binding(2) var liq_cache: texture_2d<f32>;    // sun, moon, AO, hidden
@group(3) @binding(3) var liq_hdr: texture_2d<f32>;
@group(3) @binding(4) var liq_depth_out: texture_storage_2d<r32float, write>;
@group(3) @binding(5) var liq_normal: texture_2d<f32>;   // surface normal, foam
@group(3) @binding(6) var liq_flow: texture_2d<f32>;     // flow (world, u/s), wetness
@group(3) @binding(7) var liq_level: texture_2d<f32>;    // nearest liquid's level − the metric radius (−1000 none), its lava share, coverage, lava temperature
@group(3) @binding(8) var liq_z: texture_depth_2d;       // the liquid surface's depth (water.ts), 0 where none
@group(3) @binding(9) var<uniform> liq_tiles: array<vec4u, ${WATER_TILE_WORDS / 4}>;   // the water's tiles on this frame (water.ts)

fn liq_on(bit: u32) -> bool { return (u32(liq.info.w) & bit) != 0u; }

/** Continuous atlas pixel coordinate of a direction (texel centres at k + 0.5). */
fn liq_atlas_px(d: vec3f) -> vec2f { return lm_atlas_px(d, liq.grid.x); }
fn liq_bilerp(t: texture_2d<f32>, px: vec2f) -> vec4f {
  let q = px - 0.5;
  let i = vec2i(floor(q));
  let f = q - vec2f(i);
  let a = textureLoad(t, i, 0); let b = textureLoad(t, i + vec2i(1, 0), 0);
  let c = textureLoad(t, i + vec2i(0, 1), 0); let e = textureLoad(t, i + vec2i(1, 1), 0);
  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
}
/**
 * Whether the water's tile at direction d is on. An off tile has no cell within a tile of it holding anything, so the
 * atlas texels around d carry no lava, band level or wetness: a dry pixel there gets no film and no band.
 */
fn liq_tile_on(d: vec3f) -> bool {
  let t = w_tile(lm_cell(d, u32(liq.grid.x)), u32(liq.grid.x));
  return (liq_tiles[t >> 7u][(t >> 5u) & 3u] & (1u << (t & 31u))) != 0u;
}
/**
 * The level of the nearest liquid at px (x, radius; 0 when none is within reach) and its lava share (y): bilinear over
 * the taps that have one, so the band never blends toward the "none" sentinel.
 */
fn liq_band_level(px: vec2f) -> vec2f {
  let q = px - 0.5;
  let i = vec2i(floor(q));
  let f = q - vec2f(i);
  var sum = vec2f(0.0);
  var wsum = 0.0;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let t = textureLoad(liq_level, i + o, 0);
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1);
    if (t.x > -999.0) { sum += w * t.xy; wsum += w; }
  }
  if (wsum < 1e-4) { return vec2f(0.0); }
  return vec2f(sum.x / wsum + liq.coarse.w, sum.y / wsum);
}

fn liq_hash3(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

fn liq_vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let h = liq_hash3(i).x; let hx = liq_hash3(i + vec3f(1.0, 0.0, 0.0)).x;
  let hy = liq_hash3(i + vec3f(0.0, 1.0, 0.0)).x; let hxy = liq_hash3(i + vec3f(1.0, 1.0, 0.0)).x;
  let hz = liq_hash3(i + vec3f(0.0, 0.0, 1.0)).x; let hxz = liq_hash3(i + vec3f(1.0, 0.0, 1.0)).x;
  let hyz = liq_hash3(i + vec3f(0.0, 1.0, 1.0)).x; let hxyz = liq_hash3(i + vec3f(1.0, 1.0, 1.0)).x;
  return mix(mix(mix(h, hx, u.x), mix(hy, hxy, u.x), u.y), mix(mix(hz, hxz, u.x), mix(hyz, hxyz, u.x), u.y), u.z);
}

/** Resting chop: three octaves of drifting value noise (wavelengths about 0.45 … 0.08 u), each drifting its own way. */
fn liq_chop(p: vec3f, t: f32) -> f32 {
  return 0.55 * liq_vnoise(p * 2.2 + vec3f(0.31, 0.17, -0.23) * t)
       + 0.3 * liq_vnoise(p * 5.1 + vec3f(-0.42, 0.29, 0.35) * t + 11.0)
       + 0.15 * liq_vnoise(p * 11.7 + vec3f(0.55, -0.48, 0.21) * t + 23.0);
}

/**
 * Miniature chop: the noise height's gradient in the tangent plane at p tilts the normal. The slope fades in the
 * shallows so puddles and crater ponds stay glassy.
 */
fn liq_wave_normal(p: vec3f, up: vec3f, t: f32, slope: f32) -> vec3f {
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9);
  let tu = normalize(cross(a, up));
  let tv = cross(up, tu);
  let e = 0.03;
  let h0 = liq_chop(p, t);
  let g = (liq_chop(p + tu * e, t) - h0) / e * tu + (liq_chop(p + tv * e, t) - h0) / e * tv;
  return normalize(up - g * slope);
}

/** Rᵀ · v for the ripples' wind drift (a unit quaternion). */
fn liq_undrift(v: vec3f) -> vec3f { let q = vec4f(-liq.wind.xyz, liq.wind.w); let t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }

/**
 * Water chop under the wind (scene facet wind, the match wind): the ripple pattern drifts downwind with the air (an
 * accumulated rotation, so gusts never make it jump) and the wind roughens it: glassy in a calm, choppy in a gale.
 */
fn liq_wind_wave_normal(p: vec3f, up: vec3f, t: f32, slope: f32) -> vec3f {
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9);
  let tu = normalize(cross(a, up));
  let tv = cross(up, tu);
  let e = 0.03;
  let q = liq_undrift(p);
  let h0 = liq_chop(q, t);
  let g = (liq_chop(liq_undrift(p + tu * e), t) - h0) / e * tu + (liq_chop(liq_undrift(p + tv * e), t) - h0) / e * tv;
  return normalize(up - g * slope * (0.45 + 1.1 * liq.swell.y));
}

/** Animated caustic network: two scales of 3D Voronoi edges (F2 − F1), bright where cells meet. */
fn liq_voronoi_edge(p: vec3f, t: f32, width: f32) -> f32 {
  let cell = floor(p);
  var f1 = 8.0;
  var f2 = 8.0;
  for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let c = cell + vec3f(f32(x), f32(y), f32(z));
    let h = liq_hash3(c);
    let q = c + 0.5 + 0.4 * sin(t * (0.6 + h) + 6.2831 * h);
    let d = dot(q - p, q - p);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  } } }
  return 1.0 - smoothstep(0.0, width, sqrt(f2) - sqrt(f1));
}
fn liq_caustic(p: vec3f, t: f32) -> f32 {
  return 0.6 * liq_voronoi_edge(p * 2.2, t * 0.8, 0.18) + 0.4 * liq_voronoi_edge(p * 5.3 + 17.0, t * 1.3, 0.18);
}

fn liq_lava_color(temp: f32) -> vec3f {
  return mix(vec3f(1.2, 0.16, 0.02), vec3f(5.0, 1.9, 0.45), clamp(temp, 0.0, 1.0));
}

fn liq_glint(n: vec3f, v: vec3f, l: vec3f) -> f32 {
  let ndl = dot(n, l);
  if (ndl <= 0.0) { return 0.0; }
  let a2 = 0.0025;
  let h = normalize(v + l);
  let ndh = max(dot(n, h), 0.0);
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let f = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  return a2 / (PI * dd * dd) * f / (4.0 * max(dot(n, v), 0.08)) * ndl;
}

fn liq_debug_color(k: u32) -> vec3f {
  let h = liq_hash3(vec3f(f32(k) * 7.31, f32(k) * 1.73, 3.1));
  return 0.25 + 0.75 * h;
}

/** Aerial perspective and war-fog mist from the eye to t, applied to radiance that does not carry them yet. */
fn liq_air(own: vec3f, opacity: f32, dir: vec3f, t: f32, xi: f32) -> vec3f {
  let seg = atmo_integrate(frame.eye_pos, dir, t, aerial_steps(frame.eye_pos, dir, t), xi);
  var c = own * seg.T + seg.L * opacity;
  if (term_on(${LIGHTING_TERM.mist}u)) {
    let fog = war_fog_march(frame.eye_pos, dir, t, xi);
    c = c * fog.w + fog.rgb * opacity;
  }
  return c;
}

/** The fog-of-war veil of a liquid surface: the terrain's sculpted mist, lit by the cached sun, moon and AO. */
fn liq_veil(p: vec3f, up: vec3f, cache: vec4f) -> vec3f {
  let lm = params.moon_dir.xyz;
  let moon_up = smoothstep(-0.05, 0.25, dot(up, lm));
  let sun_term = max(dot(up, frame.sun_dir), 0.0) * cache.x;
  let moon_term = max(dot(up, lm), 0.0) * moon_up * params.moon_dir.w * cache.y;
  let dayness = war_fog_dayness(p);
  let sculpt = (0.46 + 0.54 * min(sun_term + 0.6 * moon_term, 1.0)) * mix(1.0, cache.z, 0.9);
  var veil = WAR_FOG_DAY * sculpt;
  if (dayness < 0.999) { veil = mix(war_fog_night(p, up) * mix(1.0, cache.z, 0.7), veil, dayness); }
  return veil;
}

/** The fog of war's hidden fraction in the air at p (the visibility volume the mist uses). */
fn liq_hidden_air(p: vec3f) -> f32 {
  if (!fog_enabled()) { return 0.0; }
  return textureSampleLevel(fog_volume, atmo_lut_sampler, p * (0.5 / fog_params.volume.y) + 0.5, 0.0).r;
}

/** Light reaching the liquid under a surface at p: sun, moon and sky on the radial up, with visibility and AO. */
fn liq_light_up(p: vec3f, up: vec3f, sun: f32, moon: f32, ao: f32) -> vec3f {
  let l = frame.sun_dir;
  let lm = params.moon_dir.xyz;
  let sun_rgb = frame.sun_radiance * atmo_sun_color(p);
  let moon_rgb = params.moon.rgb * params.moon_dir.w * smoothstep(-0.05, 0.25, dot(up, lm));
  var e_amb: vec3f;
  if (sky_light_valid()) {
    e_amb = sky_irradiance(p, up, up, l);
    let gi = gi_sample(p, up);
    e_amb = e_amb * mix(1.0, gi.sky, params.gi.x * gi.confidence) + gi.bounce * (params.gi.y * gi.confidence);
  } else {
    e_amb = vec3f(params.fallback_horizon.w * 0.5);
  }
  return sun_rgb * sun * max(dot(up, l), 0.0) + moon_rgb * moon * max(dot(up, lm), 0.0) + e_amb * ao;
}

/**
 * Contact foam: a lace wherever the surface meets the terrain, from the pixel's own water column (surface to the terrain
 * behind it, along the vertical), so it follows the true contour exactly as the terrain's depth cuts the surface. (The SDF's
 * voxels and the cells' coverage both drew the line on their grids.) Carved by smooth drifting noise, never a per-texel hash.
 */
fn liq_contact_foam(p: vec3f, column: f32, t_now: f32) -> f32 {
  let contact = 1.0 - smoothstep(0.01, 0.09, column);
  if (contact <= 0.0) { return 0.0; }
  let lace = liq_vnoise(p * 13.0 + vec3f(t_now * 0.5, 0.0, t_now * 0.35)) * 0.65
           + liq_vnoise(p * 29.0 - vec3f(0.0, t_now * 0.8, t_now * 0.45)) * 0.35;
  return liq.shallow.w * contact * smoothstep(0.42, 0.72, lace + contact * 0.2);
}

/**
 * The liquid column at a pixel: the depth along the view ray from the surface to the terrain behind it, times the view's
 * cosine to the vertical, floored at 0.15. It vanishes exactly at a contact line (the terrain cutting the surface), so an
 * edge fades where the terrain clips it. The floor keeps a grazing view (cosine near zero, or below on the curved planet)
 * from reading a deep surface as a contact and fading it away in front of a bump behind it.
 */
fn liq_column(thick: f32, dir: vec3f, up: vec3f, sky: bool) -> f32 {
  return select(thick * max(dot(-dir, up), 0.15), 1e3, sky);
}

/** What the water shading needs at a surface point: cached per level-map cell for resting water, traced for regions. */
struct LiqSurface {
  p: vec3f,
  n: vec3f,
  up: vec3f,
  t: f32,
  thick: f32,
  sun: f32,
  moon: f32,
  ao: f32,
  foam: f32,
}

/** Glassy toy resin: refraction, caustics on the bed, Beer–Lambert, the resin ramp, fresnel sky, glints and foam. */
fn liq_water(s: LiqSurface, px: vec2u, dir: vec3f, size: vec2f, sky: bool, p_back: vec3f, xi: f32) -> vec3f {
  let t_now = liq.info.y;
  let v = -dir;
  let n = s.n;
  let l = frame.sun_dir;
  let lm = params.moon_dir.xyz;
  let sun_rgb = frame.sun_radiance * atmo_sun_color(s.p);
  let moon_rgb = params.moon.rgb * params.moon_dir.w * smoothstep(-0.05, 0.25, dot(s.up, lm));
  let light_up = liq_light_up(s.p, s.up, s.sun, s.moon, s.ao);
  // Refraction: shift the lookup by the normal's tangential part; keep the straight pixel where the shifted one is in
  // front of the water.
  var rpx = vec2i(px);
  if (liq_on(${LIQUID_TOGGLE.refraction}u) && !sky) {
    let tn = n - s.up * dot(n, s.up);
    let sv = (frame.view * vec4f(tn, 0.0)).xy;
    // A screen-space shift: scaled down with distance so far water bends what lies behind it by as much ground as near
    // water does, not by a fixed share of the screen (which pulled the shore's land into distant water as teeth).
    let shift = vec2f(sv.x, -sv.y) * liq.water.w * clamp(s.thick * 3.0, 0.0, 1.0) * size.y * min(1.0, 8.0 / max(s.t, 1e-3));
    let cand = clamp(vec2i(px) + vec2i(shift), vec2i(0), vec2i(size) - 1);
    let rd = textureLoad(gb_depth, cand, 0);
    let ruv = (vec2f(cand) + 0.5) / size;
    if (rd > 0.0 && length(world_pos_from_depth(ruv, rd) - frame.eye_pos) > s.t) { rpx = cand; }
  }
  var behind = textureLoad(liq_hdr, rpx, 0).rgb;
  // Caustics on the bed under the surface: sunlight focused by the ripples, fading with depth.
  if (!sky && liq_on(${LIQUID_TOGGLE.caustics}u)) {
    let ids = textureLoad(gb_ids, px, 0).r;
    let g = gbuffer_unpack(textureLoad(gb_albedo_ao, px, 0), textureLoad(gb_normals, px, 0), textureLoad(gb_material, px, 0), ids);
    let bed_depth = max(length(s.p) - length(p_back), 0.0);
    let c = liq_caustic(p_back, t_now) * exp(-1.4 * bed_depth) * smoothstep(0.0, 0.08, bed_depth);
    behind += g.base_color * sun_rgb * s.sun * max(dot(g.n_shading, l), 0.0) * (c * 1.6 * INV_PI);
  }
  let T = exp(-liq.water.rgb * s.thick);
  let ramp = mix(liq.shallow.rgb, liq.deep.rgb, 1.0 - exp(-0.9 * s.thick));
  let scatter = ramp * light_up * INV_PI;
  let ndv = max(dot(n, v), 0.02);
  let fresnel = clamp((0.02 + 0.98 * pow(1.0 - ndv, 5.0)) * 1.5 + 0.03, 0.0, 0.92);
  let r = reflect(-v, n);
  var env: vec3f;
  if (sky_light_valid()) { env = sky_specular(s.p, r, s.up, 0.05, l); } else { env = sky_fallback(r); }
  env *= mix(1.0, s.ao, 0.6);
  // Sun and moon glints: GGX (alpha 0.05) with Schlick at the half vector; radiance = D F / (4 n·v) × E / (n·l).
  let spec = sun_rgb * s.sun * liq_glint(n, v, l) + moon_rgb * s.moon * liq_glint(n, v, lm);
  let foam_col = vec3f(0.9) * light_up * INV_PI;
  let behind_part = behind * T * (1.0 - fresnel) * (1.0 - s.foam);
  let own = ((scatter * (1.0 - T)) * (1.0 - fresnel) + env * fresnel + spec) * (1.0 - s.foam) + foam_col * s.foam;
  let opacity = 1.0 - (T.x + T.y + T.z) / 3.0 * (1.0 - fresnel) * (1.0 - s.foam);
  return behind_part + liq_air(own, opacity, dir, s.t, xi);
}

/**
 * Lava: opaque. By temperature (the simulation's, 0 cold … 1 molten): fresh lava glows whole; a lake's (about 0.9) is
 * drifting basalt plates with glowing cracks and slow molten patches; cooling lava darkens, its cracks fade, and cold
 * lava is a rough grey basalt skin.
 */
fn liq_lava_skin(p: vec3f, time: f32, temp: f32) -> vec2f {
  let warp = vec3f(liq_vnoise(p * 1.4), liq_vnoise(p * 1.4 + 17.0), liq_vnoise(p * 1.4 + 39.0)) - 0.5;
  let q = p * 2.2 + warp * 2.4;
  let folds = liq_vnoise(q * 3.7 + warp) * 0.65 + liq_vnoise(q * 11.0) * 0.35;
  // Turbulent ribbons and broken crust islands, rather than a clean polygon lattice.
  let field = liq_vnoise(q) * 0.6 + liq_vnoise(q * 2.3 + warp) * 0.28 + liq_vnoise(q * 6.1) * 0.12;
  let cracks = 1.0 - smoothstep(0.018, 0.065, abs(field - 0.5));
  let openings = smoothstep(0.58, 0.78, liq_vnoise(p * 0.9 + warp + time * vec3f(0.015, -0.025, 0.02)));
  let hot = smoothstep(0.35, 0.92, temp);
  let molten = clamp((cracks * smoothstep(0.2, 0.65, folds) + openings * 0.8) * hot, 0.0, 1.0);
  return vec2f(molten, folds);
}
fn liq_lava(p: vec3f, up: vec3f, normal: vec3f, flow: vec3f, temp: f32, broken: f32, cache: vec4f, vis: f32, dir: vec3f, t: f32, xi: f32) -> vec3f {
  let t_now = liq.info.y;
  // Two advected phases crossfade with hidden resets; changing flow never stretches the crust indefinitely.
  let phase = fract(t_now / 6.0);
  let drift = vec3f(t_now * 0.012, -t_now * 0.008, t_now * 0.009);
  let velocity = flow / max(1.0, length(flow) / 0.8);
  let skin_a = liq_lava_skin(p - velocity * phase * 6.0 + drift, t_now, temp);
  let skin_b = liq_lava_skin(p - velocity * fract(phase + 0.5) * 6.0 + drift, t_now, temp);
  let skin = mix(skin_a, skin_b, abs(phase * 2.0 - 1.0));
  // Contact and strong flow tear open the skin; the exposed material heals behind the hull.
  let molten = max(skin.x, broken * smoothstep(0.35, 0.85, temp) * (0.55 + skin.y * 0.45));
  let crust = (1.0 - molten) * liq.lava.y;
  let heat = mix(vec3f(0.9, 0.045, 0.003), vec3f(5.0, 1.65, 0.22), pow(molten, 2.0) * smoothstep(0.4, 0.9, temp));
  let emission = heat * liq.lava.x * (pow(molten, 1.5) * 1.3 + pow(temp, 12.0) * 0.001);
  let n = normalize(normal + liq_wave_normal(p * 2.0, up, t_now * 0.13, 0.18) - up);
  let fracture = broken * (1.0 - smoothstep(0.03, 0.09, abs(liq_vnoise(p * 13.0 - velocity * phase * 6.0) - 0.5)));
  let ash = 1.0 - smoothstep(0.35, 0.85, temp);
  let basalt = mix(vec3f(0.055, 0.061, 0.068), vec3f(0.19, 0.205, 0.22), smoothstep(0.25, 0.75, skin.y));
  let crust_albedo = mix(basalt, basalt * 1.55 + vec3f(0.035), ash) * (1.0 - fracture * 0.55);
  let light = liq_light_up(p, n, vis, cache.y, cache.z);
  let gleam = frame.sun_radiance * vis * liq_glint(n, -dir, frame.sun_dir) * mix(0.15, 0.7, molten);
  let own = emission + crust_albedo * light * INV_PI * crust + gleam;
  return liq_air(own, 1.0, dir, t, xi);
}

/**
 * Foam carried by the water (the simulation's foam, advected along the flow): white lace carved by drifting noise, so it
 * reads as streaks and patches, never as the cell grid. More foam, fuller lace.
 */
fn liq_sim_foam(p: vec3f, amount: f32, t_now: f32) -> f32 {
  let f = clamp(amount, 0.0, 1.0);
  if (f < 0.02) { return 0.0; }
  // Patches of bubbles: two octaves of drifting noise decide where foam gathers (more foam, wider patches); inside them,
  // the fine strands of a bubble network, with a solid core where the foam is thick.
  let q = p + vec3f(t_now * 0.07, 0.0, t_now * 0.05);
  let patch_n = liq_vnoise(q * 2.3) * 0.65 + liq_vnoise(q * 5.7 + 7.0) * 0.35;
  let patches = smoothstep(0.78 - 0.55 * f, 0.95 - 0.45 * f, patch_n);
  let strands = liq_voronoi_edge(q * 17.0, t_now * 0.6, 0.12 + 0.25 * f);
  let core = smoothstep(0.55, 0.9, f) * smoothstep(0.85 - 0.3 * f, 1.0 - 0.2 * f, patch_n);
  return clamp(patches * strands * (0.45 + 0.55 * f) + core, 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn fluid_main(@builtin(global_invocation_id) gid: vec3u) {
  let size = frame_internal_size();
  if (f32(gid.x) >= size.x || f32(gid.y) >= size.y) { return; }
  let px = gid.xy;
  textureStore(liq_depth_out, px, vec4f(0.0));
  if (liq.grid.w < 0.5 || !liq_on(${LIQUID_TOGGLE.liquids}u)) { return; }
  let uv = (vec2f(px) + 0.5) / size;
  let depth = textureLoad(gb_depth, px, 0);
  let ids = textureLoad(gb_ids, px, 0).r;
  let sky = gbuffer_class(ids) == CLASS_SKY || depth <= 0.0;
  let eye = frame.eye_pos;
  let dir = world_dir_from_uv(uv);
  var t_max = 1e9;
  var p_back = vec3f(0.0);
  if (!sky) { p_back = world_pos_from_depth(uv, depth); t_max = length(p_back - eye); }
  let view = u32(liq.info.z);
  let t_now = liq.info.y;
  let xi = pixel_noise(vec2f(px));
  let unit = 1.0 / max(frame.exposure, 1e-3);
  let wet_depth = liq.lava.z;
  // The liquid surface in front of the scene, drawn by water.ts (0 where there is none).
  var lz = textureLoad(liq_z, px, 0);
  let submerged = water_contains(eye);
  let in_lava = lava_contains(eye);
  let lava_hit = lava_near_hit(eye, dir, in_lava);
  if (in_lava && view == 0u) {
    // Per-ray path length gives a continuous transition when the interface clips the camera.
    // The interior is emissive and opaque, with no water-like window onto distant geometry.
    var path = min(t_max, 1.0);
    if (lava_hit > 0.0) { path = min(path, lava_hit); }
    let T = lava_transmittance(path);
    let temp = liq_bilerp(liq_level, liq_atlas_px(eye)).w;
    let heat = liq_lava_color(temp) * liq.lava.x * temp * temp;
    let grain = 0.92 + 0.08 * liq_vnoise(eye * 7.0 + dir * 0.2 + vec3f(t_now * 0.2));
    let behind = textureLoad(liq_hdr, px, 0).rgb;
    textureStore(hdr_out, px, vec4f(behind * T + heat * grain * (1.0 - T), 1.0));
    // Gas, spray and other later transparent effects must also stop at the opaque medium.
    textureStore(liq_depth_out, px, vec4f(1.0, 0.0, 0.0, 0.0));
    return;
  }
  if (lava_hit > 0.0 && lava_hit < t_max && lava_hit < frame_near() * length(view_ray_from_uv(uv)) * 1.5) {
    let clip = frame.view_proj * vec4f(eye + dir * lava_hit, 1.0);
    lz = max(lz, clip.z / max(clip.w, 1e-6));
  }
  // A wave can intersect a ray between the eye and the near plane. Rasterisation
  // clips that triangle, but the optical interface must remain continuous.
  let near_hit = water_near_hit(eye, dir, submerged);
  if (near_hit > 0.0 && near_hit < t_max && (submerged || near_hit < frame_near() * length(view_ray_from_uv(uv)) * 1.5)) {
    let clip = frame.view_proj * vec4f(eye + dir * near_hit, 1.0);
    lz = max(lz, clip.z / max(clip.w, 1e-6));
  }

  if (submerged && view == 0u) {
    var distance = min(t_max, 40.0);
    var radiance = vec3f(0.0);
    if (lz > 0.0 && (sky || lz > depth)) {
      let p = world_pos_from_depth(uv, lz);
      distance = length(p - eye);
      let up = normalize(p);
      let apx = liq_atlas_px(p);
      let a = liq_bilerp(liq_atlas, apx);
      let nf = liq_bilerp(liq_normal, apx);
      var n = normalize(nf.xyz);
      let swell = w_swell(p, t_now, liq.swell.x) * w_swell_share(max(a.z, 0.0), a.w);
      n = normalize(n - (swell.yzw - up * dot(swell.yzw, up)));
      if (liq_on(${LIQUID_TOGGLE.waves}u)) { n = normalize(n + liq_wind_wave_normal(p, up, t_now, liq.deep.w * 0.65) - up); }
      radiance = water_under_surface(p, n, dir, xi);
      if (liq_on(${LIQUID_TOGGLE.foam}u)) {
        let foam = liq_sim_foam(p, nf.w, t_now);
        let cache = liq_bilerp(liq_cache, apx);
        radiance = mix(radiance, liq_light_up(p, up, cache.x, cache.y, cache.z) * 0.22, foam);
      }
      textureStore(liq_depth_out, px, vec4f(clamp(lz, 0.0, 1.0), 0.0, 0.0, 0.0));
    } else if (!sky) {
      radiance = water_scene_radiance(textureLoad(liq_hdr, px, 0).rgb, p_back, xi);
      if (liq_on(${LIQUID_TOGGLE.caustics}u)) {
        let col = water_column(p_back);
        let cache = liq_bilerp(liq_cache, liq_atlas_px(p_back));
        let g = gbuffer_unpack(textureLoad(gb_albedo_ao, px, 0), textureLoad(gb_normals, px, 0), textureLoad(gb_material, px, 0), ids);
        let atten = exp(-liq.water.rgb * max(-col.w, 0.0) / max(dot(normalize(p_back), frame.sun_dir), 0.2));
        radiance += g.base_color * frame.sun_radiance * cache.x * max(dot(g.n_shading, frame.sun_dir), 0.0) * atten
          * liq_caustic(p_back, t_now) * 0.8 * INV_PI;
      }
    }
    textureStore(hdr_out, px, vec4f(water_volume(radiance, eye, dir, distance, xi), 1.0));
    return;
  }

  if (lz <= 0.0 || (!sky && lz <= depth)) {
    if (sky) { return; }
    let apx = liq_atlas_px(p_back);
    if (view == 0u && !liq_tile_on(normalize(p_back))) { return; }
    let base = textureLoad(liq_hdr, px, 0).rgb;
    // Thin lava follows the rendered rock. Its simulation bed is sampled from a
    // coarser SDF, so its independent triangles can lie just below a terrain LOD.
    // Resolve only a wet film on the matching terrain surface, never on tanks,
    // roofs, or walls separated from the actual bed.
    let film_a = liq_bilerp(liq_atlas, apx);
    let bed_gap = abs(length(p_back) - (film_a.y - film_a.w));
    let ground_normal = oct_decode(textureLoad(gb_normals, px, 0).zw);
    let ground_facing = smoothstep(0.25, 0.65, dot(ground_normal, normalize(p_back)));
    if (view == 0u && gbuffer_class(ids) == CLASS_TERRAIN && film_a.w > wet_depth && film_a.z <= wet_depth
      && film_a.w < 0.2 && ground_facing > 0.0 && bed_gap < max(0.025, sdf_voxel() * 0.6)) {
      let coverage = ground_facing * smoothstep(wet_depth, 0.022, film_a.w)
        * (1.0 - smoothstep(0.5, 1.0, bed_gap / max(0.025, sdf_voxel() * 0.6)));
      let nf = liq_bilerp(liq_normal, apx);
      let fw = liq_bilerp(liq_flow, apx);
      let cache = liq_bilerp(liq_cache, apx);
      let surf = gbuffer_unpack(textureLoad(gb_albedo_ao, px, 0), textureLoad(gb_normals, px, 0), textureLoad(gb_material, px, 0), ids);
      var film_vis = cache.x;
      if (film_vis > 0.001 && term_on(${LIGHTING_TERM.casters}u)) {
        film_vis *= casters_vis_dir(p_back + ground_normal * 0.04, frame.sun_dir, params.sdf_shadow.x);
      }
      var color = liq_lava(p_back, normalize(p_back), surf.n_shading, fw.xyz, liq_bilerp(liq_level, apx).w, nf.w,
        cache, film_vis, dir, t_max, xi);
      if (liq_on(${LIQUID_TOGGLE.veil}u) && cache.w > 0.001 && term_on(${LIGHTING_TERM.veil}u)) {
        var veil = liq_veil(p_back, normalize(p_back), cache);
        if (term_on(${LIGHTING_TERM.mist}u)) { let fog = war_fog_march(eye, dir, t_max, xi); veil = veil * fog.w + fog.rgb; }
        color = mix(color, veil, cache.w);
      }
      textureStore(hdr_out, px, vec4f(mix(base, color, coverage), 1.0));
      textureStore(liq_depth_out, px, vec4f(depth, 0.0, 0.0, 0.0));
      return;
    }
    if (view == ${LIQUID_VIEW.bed}u) {
      let a = liq_bilerp(liq_atlas, apx);
      let rel = a.y - select(18.0, liq.coarse.z, liq.coarse.z > 0.0);
      let c = select(vec3f(0.2, 0.45, 1.0) * clamp(-rel / 2.0, 0.0, 1.0), vec3f(0.9, 0.6, 0.2) * clamp(rel / 2.0, 0.0, 1.0), rel > 0.0);
      textureStore(hdr_out, px, vec4f(c * unit, 1.0));
      return;
    }
    if (view == ${LIQUID_VIEW.wetness}u) {
      textureStore(hdr_out, px, vec4f(mix(base * 0.25, vec3f(0.2, 0.5, 1.0) * unit, liq_bilerp(liq_flow, apx).w * 0.8), 1.0));
      return;
    }
    if (view != 0u) { textureStore(hdr_out, px, vec4f(base * 0.25, 1.0)); return; }
    // Wet band: dry ground just above a liquid level darkens slightly, fading with height, so it follows the terrain's
    // contour; ground the water left recently (a wave's run-up) stays dark while it dries. Lava shores glow. It fades
    // out with the blurred coverage (the shore field), never on the cell grid.
    if (!liq_on(${LIQUID_TOGGLE.wetBand}u)) { return; }
    let level = liq_band_level(apx);
    let shore = vec2f(liq_bilerp(liq_level, apx).z, level.y);
    let dried = liq_bilerp(liq_flow, apx).w;
    var near = 0.0;
    if (level.x > 0.0) {
      let dr = length(p_back) - level.x;
      if (dr >= 0.0 && dr < 0.22) { near = smoothstep(0.0, 0.3, shore.x) * (1.0 - smoothstep(0.0, 0.12, dr)); }
    }
    // Do not paint a constant orange contour onto cold banks and tank undersides.
    if (level.y > 0.5) { return; }
    let dark = max(near, 0.75 * dried * (1.0 - shore.y));
    if (dark > 0.001) { textureStore(hdr_out, px, vec4f(base * mix(1.0, 0.8, dark), 1.0)); }
    return;
  }

  let p = world_pos_from_depth(uv, lz);
  let t_hit = length(p - eye);
  let up = normalize(p);
  let apx = liq_atlas_px(p);
  let a = liq_bilerp(liq_atlas, apx);
  let nf = liq_bilerp(liq_normal, apx);
  let fw = liq_bilerp(liq_flow, apx);
  let cache = liq_bilerp(liq_cache, apx);
  let thick = select(min(t_max - t_hit, 40.0), 40.0, sky);
  let vdepth = max(length(p) - a.y, 0.0);
  var vis = cache.x;
  if (vis > 0.001 && term_on(${LIGHTING_TERM.casters}u)) { vis *= casters_vis_dir(p + up * 0.04, frame.sun_dir, params.sdf_shadow.x); }
  var result: vec3f;
  // Lava wherever the cells' blend carries any (not above the wet depth, an iso-line of the bilinear blend that stepped
  // along a rim and handed its last pixels to the water branch); its edge then fades on the pixel's own column.
  let lava_surface = (a.w > 1e-4 || liq_band_level(apx).y > 0.5) && a.z < max(wet_depth, a.w * 0.25);
  if (lava_surface) {
    // ── Lava ──
    // The lava column at this pixel (surface over the terrain behind it): the rim ends where the terrain cuts the
    // surface, as the water's does, instead of along the cells' bilinear depth.
    let column = liq_column(thick, dir, up, sky);
    let keep = smoothstep(0.0, 0.018, column) * smoothstep(0.0, 0.012, thick * max(dot(-dir, up), 0.15));
    if (keep <= 0.001) { return; }
    result = liq_lava(p, up, normalize(nf.xyz), fw.xyz, liq_bilerp(liq_level, apx).w, nf.w, cache, vis, dir, t_hit, xi);
    // Only the contact's subpixel coverage blends; the body of the lava remains opaque.
    if (!sky && keep < 1.0) { result = mix(textureLoad(liq_hdr, px, 0).rgb, result, keep); }
  } else {
    // ── Water: the simulated surface's normal, tilted by the swell, with the fine chop on top (calmer in the shallows) ──
    var n = normalize(nf.xyz);
    let swell = w_swell(p, t_now, liq.swell.x) * w_swell_share(max(a.z, 0.0), a.w);
    n = normalize(n - (swell.yzw - up * dot(swell.yzw, up)));
    if (liq_on(${LIQUID_TOGGLE.waves}u)) {
      let chop = liq_wind_wave_normal(p, up, t_now, liq.deep.w * smoothstep(0.0, 0.6, vdepth));
      n = normalize(n + (chop - up));
    }
    // The water column at this pixel: the surface's height over the terrain behind it, exact at the contact line (the
    // cells' bilinear depth ended the water and its foam on the grid, short of the true contour).
    let column = liq_column(thick, dir, up, sky);
    // The foam the water carries (thin sheets carry little: the terrain shows through them).
    var sim_foam = 0.0;
    if (liq_on(${LIQUID_TOGGLE.foam}u)) { sim_foam = liq.shallow.w * liq_sim_foam(p, nf.w * smoothstep(0.015, 0.06, column), t_now); }
    result = liq_water(LiqSurface(p, n, up, t_hit, thick, vis, cache.y, cache.z, sim_foam), px, dir, size, sky, p_back, xi);
    if (!sky) {
      // Thin films (a wave's run-up, a sheet down a crater wall) fade into the wet ground under them; so does the water
      // where it meets the terrain (the last few hundredths of a unit), which softens every contact line. Toward a front
      // running downhill (drawn cells that dip under the bed carry a negative depth) the water fades along the bilinear
      // depth, so the front's edge is smooth instead of following the triangles.
      let film = smoothstep(wet_depth, liq.lava.w, column);
      let front = smoothstep(${WATER_FRONT_MARK * 0.5}, 0.0, a.z);
      let soft = smoothstep(0.0, 0.03, min(column, thick * max(dot(-dir, up), 0.1)));
      let keep = min(min(film, front), soft);
      if (keep < 1.0) { result = mix(textureLoad(liq_hdr, px, 0).rgb, result, keep); }
      // Contact foam along the waterline (where the surface meets the terrain), laid over the soft edge.
      if (liq_on(${LIQUID_TOGGLE.foam}u)) {
        let contact = liq_contact_foam(p, column, t_now) * front * smoothstep(0.0, 0.01, thick);
        if (contact > 0.0) {
          let foam_rgb = vec3f(0.9) * liq_light_up(p, up, vis, cache.y, cache.z) * INV_PI;
          result = mix(result, liq_air(foam_rgb, 1.0, dir, t_hit, xi), contact);
        }
      }
    }
  }

  // ── Fog of war: a hidden surface takes the terrain's veil (D7) ──
  if (liq_on(${LIQUID_TOGGLE.veil}u) && cache.w > 0.001 && term_on(${LIGHTING_TERM.veil}u)) {
    var veil = liq_veil(p, up, cache);
    if (term_on(${LIGHTING_TERM.mist}u)) { let fog = war_fog_march(eye, dir, t_hit, xi); veil = veil * fog.w + fog.rgb; }
    result = mix(result, veil, cache.w);
  }

  if (view != 0u) {
    if (view == ${LIQUID_VIEW.depth}u) { result = mix(vec3f(0.6, 0.95, 1.0), vec3f(0.02, 0.1, 0.5), clamp(vdepth / 2.0, 0.0, 1.0)) * unit; }
    if (view == ${LIQUID_VIEW.flow}u) {
      let s = clamp(length(fw.xyz) / 4.0, 0.0, 1.0);
      result = mix(vec3f(0.05, 0.15, 0.6), select(vec3f(0.2, 0.9, 0.8), vec3f(1.0, 0.95, 0.85), s > 0.5), min(s * 2.0, 1.0)) * unit;
    }
    if (view == ${LIQUID_VIEW.foam}u) { result = mix(vec3f(0.03, 0.08, 0.2), vec3f(1.0), clamp(nf.w, 0.0, 1.0)) * unit; }
    if (view == ${LIQUID_VIEW.bed}u) { result = vec3f(clamp(vdepth / 2.0, 0.0, 1.0)) * unit; }
    if (view == ${LIQUID_VIEW.sun}u) { result = vec3f(cache.x) * unit; }
    if (view == ${LIQUID_VIEW.ao}u) { result = vec3f(cache.z) * unit; }
    if (view == ${LIQUID_VIEW.hidden}u) { result = vec3f(cache.w) * unit; }
    if (view == ${LIQUID_VIEW.thickness}u) { result = vec3f(clamp(thick / 4.0, 0.0, 1.0)) * unit; }
    if (view == ${LIQUID_VIEW.wetness}u) { result = mix(vec3f(0.02, 0.05, 0.12), vec3f(0.2, 0.5, 1.0), fw.w) * unit; }
    if (view == ${LIQUID_VIEW.temperature}u) { result = liq_lava_color(liq_bilerp(liq_level, apx).w) * 0.3 * unit; }
    // Shore: the scene behind, dimmed; the water's coverage (blue: how much of the surface is kept), the contact foam
    // (white) and the front fade (red: drawn cells dipped under their bed), each as the final image computes it.
    if (view == ${LIQUID_VIEW.shore}u) {
      let col = liq_column(thick, dir, up, sky);
      let fr = smoothstep(${WATER_FRONT_MARK * 0.5}, 0.0, a.z);
      let kept = min(min(smoothstep(wet_depth, liq.lava.w, col), fr), smoothstep(0.0, 0.03, min(col, thick * max(dot(-dir, up), 0.1))));
      let foam_mask = liq_contact_foam(p, col, t_now) * fr / max(liq.shallow.w, 1e-3);
      result = mix(textureLoad(liq_hdr, px, 0).rgb * 0.35, vec3f(0.1, 0.35, 1.0) * unit, kept * 0.75);
      result = mix(result, vec3f(1.0) * unit, clamp(foam_mask, 0.0, 1.0));
      result = mix(result, vec3f(1.0, 0.1, 0.05) * unit, (1.0 - fr) * 0.85);
    }
  }
  textureStore(hdr_out, px, vec4f(result, 1.0));
  let c = frame.view_proj * vec4f(p, 1.0);
  textureStore(liq_depth_out, px, vec4f(clamp(c.z / c.w, 0.0, 1.0), 0.0, 0.0, 0.0));
}
`, [cubeSphereWgsl, LIQUID_PARAMS.module, levelMapAddressWgsl, waterTileWgsl, waterSwellWgsl, underwaterWgsl, lavaImmersionWgsl]);

/** Writes the liquid depth into the main depth (reversed-Z, 'greater') and camera-motion velocity for TAA. */
export const liquidDepthWgsl = makeModule('liquid-depth', /* wgsl */ `
@group(1) @binding(0) var liq_depth: texture_2d<f32>;
struct LiqVsOut { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> LiqVsOut {
  let q = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return LiqVsOut(vec4f(q * 2.0 - 1.0, 0.0, 1.0));
}
struct LiqFsOut { @builtin(frag_depth) depth: f32, @location(0) velocity: vec4f }
@fragment fn fs(v: LiqVsOut) -> LiqFsOut {
  let d = textureLoad(liq_depth, vec2i(v.pos.xy), 0).r;
  if (d <= 0.0) { discard; }
  let uv = v.pos.xy / frame_internal_size();
  let p = world_pos_from_depth(uv, d);
  let cp = frame.prev_view_proj * vec4f(p, 1.0);
  let cc = frame.view_proj_nojitter * vec4f(p, 1.0);
  return LiqFsOut(d, vec4f(ndc_to_uv(cp.xy / cp.w) - ndc_to_uv(cc.xy / cc.w), 0.0, 0.0));
}
`, [frameWgsl, depthWgsl]);
