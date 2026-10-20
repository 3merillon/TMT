/**
 * Sky light (plan §4.9–4.10, atmo-post §4.3): what ambient and metals see.
 *
 * - **L1-SH irradiance LUT** (32×32: altitude × cos_sun). Each texel integrates the atmosphere's sky radiance over the
 *   upper hemisphere of a local observer (Y up, sun in the YZ plane; 128 Fibonacci directions × `atmo_integrate`) and
 *   adds the lower hemisphere as planet-ground radiance, albedo/π × (sun + sky irradiance on the ground), analytically.
 *   Shading: E(n) = π·Y0·c0 + (2π/3)·Y1·(c1·n) after rotating c1 from (side, up, sun_h) to world. Correct on the day side,
 *   the night side and across the terminator in one frame. Rebuilt when the atmosphere LUTs change.
 * - **Prefiltered sky cube** (64², 5 GGX mips; 32² on Low) for an observer at the follow focus: sky above the focus
 *   horizon, planet-ground radiance (kind albedo × irradiance at the ground hit, with aerial perspective) below it. The
 *   lighting rotates each reflection vector by the rotation taking the pixel's up to the focus up, so every pixel's
 *   horizon lines up, and scales it by the pixel/focus sky-irradiance ratio (dark metals on the night side). Rebuilt when
 *   the sun or the focus moves more than 2°, or the atmosphere changes.
 * - **DFG LUT** (32²: N·V × roughness; Karis split sum with Smith height-correlated visibility), baked once.
 *
 * Contract fit: the reserved binding `skyLight` is { cube, dfg, sh }. `dfg` is an rgba16float ATLAS 128×32: x ∈ [0, 32)
 * holds DFG (r = A, g = B), x ∈ [32, 64) / [64, 96) / [96, 128) hold the SH LUT for R / G / B as (c0, c1.x, c1.y, c1.z).
 * `sh` is the SkyLightParams uniform below (layout, cube observer, shaped-ambient factors, validity).
 */
import type { EngineServices, QualityTier, RenderModule, Vec3 } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { brdfWgsl } from '../../wgsl/common/brdf.wgsl';
import { mathWgsl } from '../../wgsl/common/constants.wgsl';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { atmosphereBindingsWgsl, atmosphereFnWgsl } from '../atmosphere/integrate.wgsl';
import { chordSq } from '../shadows/sun-hold';

export const SKY_ATLAS = { dfg: 32, block: 32, width: 128, height: 32 } as const;
export const SKY_CUBE = { size: 64, lowSize: 32, mips: 5 } as const;
/** Rebuild the cube when the sun or the focus direction moves more than this. */
export const SKY_CUBE_REBUILD_RAD = 2 * Math.PI / 180;
export const SH_Y0 = 0.28209479177387814;
export const SH_Y1 = 0.4886025119029199;

/** Pinionfall's shipped shaped-ambient factors (deferred-lighting-shader.ts ~722–894). */
export const SHAPED_AMBIENT_V1 = {
  ambShadowKeep: 0.725, nightAmbScale: 0.75, dayLo: -0.12, dayHi: 0.10,
  backFillNight: 0.06, terminatorGain: 1.4, hemiGround: 0.70,
} as const;

export const SKY_LIGHT_PARAMS = wgslStruct('SkyLightParams', [
  ['observer', 'vec4f'],   // xyz cube observer position (on the surface under the focus), w cube base size
  ['focus_up', 'vec4f'],   // xyz unit up at the observer, w cube mip count
  ['atlas', 'vec4f'],      // x DFG width, y SH block width, z atlas width, w atlas height
  ['shaping', 'vec4f'],    // amb_shadow_keep, night_amb_scale, day_lo, day_hi
  ['shaping2', 'vec4f'],   // back_fill_night, terminator_gain, hemi_ground, specular scale
  ['misc', 'vec4f'],       // x valid, y sun·focus_up at the bake, z solid planet radius, w unused
  ['ambient', 'vec4f'],    // x ambient sky gain (SH bake), y ambient saturation
]);
export const SKY_LIGHT_PARAMS_BYTES = 256;

declare module '../../contracts' {
  interface SceneFacets {
    /** W1-ENG-LOOK: sky-light rebuild state. */
    skyLight: SkyLightFacet;
  }
}
export interface SkyLightFacet {
  readonly shBuilds: number; readonly cubeBuilds: number; rebuild(): void;
  /** Debug: the atlas (128×32 rgba, row-major) as floats. */
  readAtlas(): Promise<Float32Array>;
}

/** IEEE half → float (atlas readback). */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

// ───────────────────────────── TS mirror (tests) ─────────────────────────────
export type Sh1 = { c0: number; c1: [number, number, number] };
/** Project radiance samples (unit directions, uniform solid-angle weights) onto L1 SH. */
export function projectL1(samples: readonly { dir: readonly number[]; radiance: number }[], solidAngle = 4 * Math.PI): Sh1 {
  const w = solidAngle / samples.length;
  const out: Sh1 = { c0: 0, c1: [0, 0, 0] };
  for (const s of samples) {
    out.c0 += s.radiance * SH_Y0 * w;
    for (let k = 0; k < 3; k++) out.c1[k] += s.radiance * SH_Y1 * s.dir[k] * w;
  }
  return out;
}
/** Mirror of sky_sh_eval: irradiance for normal n (clamped at 0). */
export function shIrradiance(sh: Sh1, n: readonly number[]): number {
  return Math.max(0, Math.PI * SH_Y0 * sh.c0 + (2 * Math.PI / 3) * SH_Y1 * (sh.c1[0] * n[0] + sh.c1[1] * n[1] + sh.c1[2] * n[2]));
}
/** Analytic L1 of a constant radiance over the lower hemisphere (y < 0), as the bake adds the ground. */
export function groundHemisphereL1(radiance: number): Sh1 {
  return { c0: radiance * SH_Y0 * 2 * Math.PI, c1: [0, -radiance * SH_Y1 * Math.PI, 0] };
}
/** Fibonacci sphere direction i of n (as the bake). */
export function fibonacciDir(i: number, n: number): [number, number, number] {
  const golden = (1 + Math.sqrt(5)) / 2;
  const theta = Math.acos(1 - 2 * (i + 0.5) / n);
  const phi = 2 * Math.PI * i / golden;
  return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
}

// ───────────────────────────── WGSL: consumer functions ─────────────────────────────
/**
 * Globals referenced: sky_light (SkyLightParams), sky_light_atlas, sky_light_cube and the atmosphere's atmo_lut_sampler
 * (linear, clamp, linear mips — one sampler serves both); needs atmosphereFnWgsl.
 */
export const skyLightFnWgsl = makeModule('sky-light', /* wgsl */ `
fn sky_light_valid() -> bool { return sky_light.misc.x > 0.5; }

fn sky_atlas_uv(block: f32, u: f32, v: f32) -> vec2f {
  let bw = sky_light.atlas.y;
  let x = block * bw + clamp(u * bw, 0.5, bw - 0.5);
  return vec2f(x / sky_light.atlas.z, clamp(v * sky_light.atlas.w, 0.5, sky_light.atlas.w - 0.5) / sky_light.atlas.w);
}

/** Split-sum DFG (A, B) at (N·V, roughness). */
fn sky_dfg(ndv: f32, roughness: f32) -> vec2f {
  let dw = sky_light.atlas.x;
  let x = clamp(ndv * dw, 0.5, dw - 0.5) / sky_light.atlas.z;
  let y = clamp(roughness * sky_light.atlas.w, 0.5, sky_light.atlas.w - 0.5) / sky_light.atlas.w;
  return textureSampleLevel(sky_light_atlas, atmo_lut_sampler, vec2f(x, y), 0.0).rg;
}

fn sky_sh_coords(p: vec3f, sun: vec3f) -> vec2f {
  let r = length(p);
  let h_range = atmo_top_radius() - atmo_ground_radius();
  let u = sqrt(clamp((r - atmo_ground_radius()) / h_range, 0.0, 1.0));
  let v = clamp((dot(p / max(r, 1e-4), sun) + 1.0) * 0.5, 0.0, 1.0);
  return vec2f(u, v);
}

/** L1-SH irradiance at a surface point for normal n (world), up = radial up at p. */
fn sky_irradiance(p: vec3f, n: vec3f, up: vec3f, sun: vec3f) -> vec3f {
  let uv = sky_sh_coords(p, sun);
  let sun_h = atmo_sun_horizontal(up, sun);
  let side = cross(up, sun_h);
  let nl = vec3f(dot(n, side), dot(n, up), dot(n, sun_h));
  let r = textureSampleLevel(sky_light_atlas, atmo_lut_sampler, sky_atlas_uv(1.0, uv.x, uv.y), 0.0);
  let g = textureSampleLevel(sky_light_atlas, atmo_lut_sampler, sky_atlas_uv(2.0, uv.x, uv.y), 0.0);
  let b = textureSampleLevel(sky_light_atlas, atmo_lut_sampler, sky_atlas_uv(3.0, uv.x, uv.y), 0.0);
  let c0 = vec3f(r.x, g.x, b.x);
  let c1n = vec3f(dot(r.yzw, nl), dot(g.yzw, nl), dot(b.yzw, nl));
  return max(PI * ${SH_Y0} * c0 + (2.0 * PI / 3.0) * ${SH_Y1} * c1n, vec3f(0.0));
}

/** Green-channel horizontal irradiance at a point (for the cube's per-pixel brightness ratio). */
fn sky_irradiance_up_g(p: vec3f, sun: vec3f) -> f32 {
  let uv = sky_sh_coords(p, sun);
  let g = textureSampleLevel(sky_light_atlas, atmo_lut_sampler, sky_atlas_uv(2.0, uv.x, uv.y), 0.0);
  return max(PI * ${SH_Y0} * g.x + (2.0 * PI / 3.0) * ${SH_Y1} * g.z, 0.0);
}

/** v rotated by the minimal rotation taking unit a to unit b. */
fn sky_rotate_between(a: vec3f, b: vec3f, v: vec3f) -> vec3f {
  let c = dot(a, b);
  if (c < -0.9999) { return -v; }
  let w = cross(a, b);
  return v * c + cross(w, v) + w * (dot(w, v) / (1.0 + c));
}

/** Prefiltered sky radiance for a reflection vector at a point with radial up "up". */
fn sky_specular(p: vec3f, r: vec3f, up: vec3f, roughness: f32, sun: vec3f) -> vec3f {
  let fu = sky_light.focus_up.xyz;
  let rr = sky_rotate_between(up, fu, r);
  let lod = clamp(roughness, 0.0, 1.0) * (sky_light.focus_up.w - 1.0);
  let c = textureSampleLevel(sky_light_cube, atmo_lut_sampler, rr, lod).rgb;
  let e_here = sky_irradiance_up_g(p, sun);
  let e_focus = sky_irradiance_up_g(sky_light.observer.xyz, sun);
  return c * clamp(e_here / max(e_focus, 1e-4), 0.0, 1.5) * sky_light.shaping2.w;
}
`, [SKY_LIGHT_PARAMS.module, mathWgsl, atmosphereFnWgsl]);

/** Declarations of the sky-light globals (the sampler is the atmosphere's `atmo_lut_sampler`, declared with it). */
export function skyLightBindingsWgsl(group: number, b: { params: number; atlas: number; cube: number }) {
  return makeModule(`sky-light-bindings:${group}:${b.params},${b.atlas},${b.cube}`, [
    `@group(${group}) @binding(${b.params}) var<uniform> sky_light: SkyLightParams;`,
    `@group(${group}) @binding(${b.atlas}) var sky_light_atlas: texture_2d<f32>;`,
    `@group(${group}) @binding(${b.cube}) var sky_light_cube: texture_cube<f32>;`,
  ].join('\n'), [SKY_LIGHT_PARAMS.module]);
}

// ───────────────────────────── WGSL: bake kernels ─────────────────────────────
const dfgKernel = makeModule('sky-light-dfg', /* wgsl */ `
@group(0) @binding(0) var dfg_out: texture_storage_2d<rgba16float, write>;
const DFG_SAMPLES: u32 = 256u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n_px = ${SKY_ATLAS.dfg}u;
  if (id.x >= n_px || id.y >= ${SKY_ATLAS.height}u) { return; }
  let ndv = (f32(id.x) + 0.5) / f32(n_px);
  let rough = (f32(id.y) + 0.5) / f32(${SKY_ATLAS.height}u);
  let v = vec3f(sqrt(max(1.0 - ndv * ndv, 0.0)), 0.0, ndv);
  let n = vec3f(0.0, 0.0, 1.0);
  let alpha = brdf_alpha(rough);
  let a2 = alpha * alpha;
  var a = 0.0;
  var b = 0.0;
  for (var i = 0u; i < DFG_SAMPLES; i++) {
    let h = brdf_importance_ggx(brdf_hammersley(i, DFG_SAMPLES), n, rough);
    let vdh = dot(v, h);
    let l = 2.0 * vdh * h - v;
    let ndl = l.z;
    if (ndl > 0.0 && vdh > 0.0) {
      let g_vis = 4.0 * brdf_v_smith_hc(ndv, ndl, a2) * ndl * vdh / max(h.z, 1e-4);
      let fc = pow(1.0 - vdh, 5.0);
      a += (1.0 - fc) * g_vis;
      b += fc * g_vis;
    }
  }
  textureStore(dfg_out, id.xy, vec4f(a / f32(DFG_SAMPLES), b / f32(DFG_SAMPLES), 0.0, 1.0));
}
`, [brdfWgsl]);

const bakeAtmo = atmosphereBindingsWgsl(0, { params: 0, transmittance: 1, multiscatter: 2, sampler: 3 });
const bakeSky = makeModule('sky-light-bake-bindings', /* wgsl */ `
@group(0) @binding(4) var<uniform> sky_light: SkyLightParams;
`, [SKY_LIGHT_PARAMS.module]);

const shKernel = makeModule('sky-light-sh', /* wgsl */ `
@group(0) @binding(5) var sh_out: texture_storage_2d<rgba16float, write>;
const SH_DIRS: u32 = 128u;
const SH_STEPS: u32 = 12u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n_px = ${SKY_ATLAS.block}u;
  if (id.x >= n_px || id.y >= n_px) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(n_px);
  let h_range = atmo_top_radius() - atmo_ground_radius();
  let h = max(uv.x * uv.x * h_range, 0.01);
  let cos_s = 2.0 * uv.y - 1.0;
  let sun = vec3f(0.0, cos_s, sqrt(max(1.0 - cos_s * cos_s, 0.0)));
  let ro = vec3f(0.0, atmo_ground_radius() + h, 0.0);
  let dw = 4.0 * PI / f32(SH_DIRS);
  let gain = sky_light.ambient.x;
  let sat = sky_light.ambient.y;
  var c0 = vec3f(0.0);
  var cx = vec3f(0.0);
  var cy = vec3f(0.0);
  var cz = vec3f(0.0);
  var e_down = vec3f(0.0);
  let golden = (1.0 + sqrt(5.0)) * 0.5;
  for (var i = 0u; i < SH_DIRS; i++) {
    let fi = f32(i);
    let theta = acos(1.0 - 2.0 * (fi + 0.5) / f32(SH_DIRS));
    let phi = TAU * fi / golden;
    let d = vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
    if (d.y < 0.0) { continue; }
    let lr = atmo_integrate_sun(ro, d, sun, 1e9, SH_STEPS, 0.5).L * gain;
    let l = mix(vec3f(dot(lr, vec3f(0.2126, 0.7152, 0.0722))), lr, sat);
    c0 += l * (${SH_Y0} * dw);
    cx += l * (${SH_Y1} * d.x * dw);
    cy += l * (${SH_Y1} * d.y * dw);
    cz += l * (${SH_Y1} * d.z * dw);
    e_down += l * (d.y * dw);
  }
  // Lower hemisphere: the planet ground under the observer, a constant radiance albedo/π · (sun + sky) — added exactly.
  let lit = smoothstep(-0.03, 0.03, cos_s);
  let e_sun = atmo_transmittance(h, cos_s) * sunset_grade(cos_s) * atmo_sun_illuminance() * max(cos_s, 0.0) * lit;
  let lg = atmo.ground.rgb / PI * (e_sun + e_down);
  c0 += lg * (${SH_Y0} * 2.0 * PI);
  cy -= lg * (${SH_Y1} * PI);
  textureStore(sh_out, vec2u(n_px + id.x, id.y), vec4f(c0.r, cx.r, cy.r, cz.r));
  textureStore(sh_out, vec2u(2u * n_px + id.x, id.y), vec4f(c0.g, cx.g, cy.g, cz.g));
  textureStore(sh_out, vec2u(3u * n_px + id.x, id.y), vec4f(c0.b, cx.b, cy.b, cz.b));
}
`, [atmosphereFnWgsl, bakeAtmo, bakeSky, mathWgsl]);

const cubeCommon = makeModule('sky-cube-common', /* wgsl */ `
/** WebGPU / Vulkan cube face convention (+X, −X, +Y, −Y, +Z, −Z); uv ∈ [0,1]², v down. */
fn cube_dir(face: u32, uv: vec2f) -> vec3f {
  let sc = uv.x * 2.0 - 1.0;
  let tc = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3f(1.0, -tc, -sc)); }
    case 1u: { return normalize(vec3f(-1.0, -tc, sc)); }
    case 2u: { return normalize(vec3f(sc, 1.0, tc)); }
    case 3u: { return normalize(vec3f(sc, -1.0, -tc)); }
    case 4u: { return normalize(vec3f(sc, -tc, 1.0)); }
    default: { return normalize(vec3f(-sc, -tc, -1.0)); }
  }
}
`);

const cubeAtlas = makeModule('sky-cube-atlas-binding', /* wgsl */ `
@group(0) @binding(5) var sky_light_atlas: texture_2d<f32>;
`);

const cubeBaseKernel = makeModule('sky-light-cube', /* wgsl */ `
@group(0) @binding(6) var cube_out: texture_storage_2d_array<rgba16float, write>;

fn sh_ground_irradiance(p: vec3f, sun: vec3f) -> vec3f {
  let r = length(p);
  let h_range = atmo_top_radius() - atmo_ground_radius();
  let u = sqrt(clamp((r - atmo_ground_radius()) / h_range, 0.0, 1.0));
  let v = clamp((dot(p / r, sun) + 1.0) * 0.5, 0.0, 1.0);
  let bw = sky_light.atlas.y;
  let x = clamp(u * bw, 0.5, bw - 0.5);
  let y = clamp(v * sky_light.atlas.w, 0.5, sky_light.atlas.w - 0.5) / sky_light.atlas.w;
  var e = vec3f(0.0);
  for (var k = 1u; k <= 3u; k++) {
    let c = textureSampleLevel(sky_light_atlas, atmo_lut_sampler, vec2f((f32(k) * bw + x) / sky_light.atlas.z, y), 0.0);
    e[k - 1u] = max(PI * ${SH_Y0} * c.x + (2.0 * PI / 3.0) * ${SH_Y1} * c.z, 0.0);
  }
  return e;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(sky_light.observer.w);
  if (id.x >= size || id.y >= size) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(size);
  let d = cube_dir(id.z, uv);
  let ro = sky_light.observer.xyz;
  let up = sky_light.focus_up.xyz;
  let sun = atmo_sun_dir();
  var l: vec3f;
  if (dot(d, up) >= 0.0) {
    l = atmo_integrate(ro, d, 1e9, 16u, 0.5).L * atmo.diorama.y;
  } else {
    // Ground below the focus horizon: hit the observer's sphere, shade albedo/π · (sun + SH sky), fog the chord.
    let t = -2.0 * dot(ro, d);
    let ph = ro + d * t;
    let nh = normalize(ph);
    let cs = dot(nh, sun);
    let lit = smoothstep(-0.03, 0.03, cs);
    let e_sun = atmo_transmittance(length(ph) - atmo_ground_radius(), cs) * sunset_grade(cs) * atmo_sun_illuminance() * max(cs, 0.0) * lit;
    let lg = atmo.ground.rgb / PI * (e_sun + sh_ground_irradiance(ph, sun));
    let seg = atmo_integrate(ro, d, t, 8u, 0.5);
    l = lg * seg.T + seg.L;
  }
  textureStore(cube_out, id.xy, id.z, vec4f(min(l, vec3f(500.0)), 1.0));
}
`, [atmosphereFnWgsl, bakeAtmo, bakeSky, cubeAtlas, cubeCommon, mathWgsl]);

const prefilterKernel = makeModule('sky-light-prefilter', /* wgsl */ `
struct PrefilterParams { roughness: f32, size: f32, src_size: f32, _pad: f32 }
@group(0) @binding(0) var src_cube: texture_cube<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> pf: PrefilterParams;
const PF_SAMPLES: u32 = 64u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(pf.size);
  if (id.x >= size || id.y >= size) { return; }
  let n = cube_dir(id.z, (vec2f(id.xy) + 0.5) / pf.size);
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0u; i < PF_SAMPLES; i++) {
    let h = brdf_importance_ggx(brdf_hammersley(i, PF_SAMPLES), n, pf.roughness);
    let l = 2.0 * dot(n, h) * h - n;
    let ndl = dot(n, l);
    if (ndl > 0.0) {
      acc += textureSampleLevel(src_cube, src_sampler, l, 0.0).rgb * ndl;
      wsum += ndl;
    }
  }
  textureStore(dst, id.xy, id.z, vec4f(acc / max(wsum, 1e-4), 1.0));
}
`, [brdfWgsl, cubeCommon]);

export function skyLightShaders() {
  return { dfg: link(dfgKernel), sh: link(shKernel), cube: link(cubeBaseKernel), prefilter: link(prefilterKernel) };
}

// ───────────────────────────── Module ─────────────────────────────
export interface SkyLightOptions { tier?: QualityTier }

export function skyLightModule(options: SkyLightOptions = {}): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'sky-light',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const tier = options.tier ?? s.settings.tier;
      const cubeSize = tier === 'low' ? SKY_CUBE.lowSize : SKY_CUBE.size;
      const mips = SKY_CUBE.mips;
      const atlas = device.createTexture({ label: 'sky-light:atlas', size: [SKY_ATLAS.width, SKY_ATLAS.height], format: 'rgba16float', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC });
      const cube = device.createTexture({ label: 'sky-light:cube', size: [cubeSize, cubeSize, 6], format: 'rgba16float', mipLevelCount: mips, usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
      const params = device.createBuffer({ label: 'sky-light:params', size: SKY_LIGHT_PARAMS_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const sampler = device.createSampler({ label: 'sky-light:linear', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
      const atlasView = atlas.createView();
      const cubeView = cube.createView({ dimension: 'cube' });
      const cubeSrcView = cube.createView({ dimension: 'cube', baseMipLevel: 0, mipLevelCount: 1 });
      const mipViews = Array.from({ length: mips }, (_, m) => cube.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 }));
      const pfBuffers = Array.from({ length: mips }, (_, m) => {
        const b = device.createBuffer({ label: `sky-light:prefilter-${m}`, size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
        queue.writeBuffer(b, 0, new Float32Array([m / (mips - 1), Math.max(1, cubeSize >> m), cubeSize, 0]));
        return b;
      });
      disposers.push(() => { for (const r of [atlas, cube, params, ...pfBuffers]) s.ctx.deferDestroy(r); });

      const e = (binding: number, x: Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>): GPUBindGroupLayoutEntry => ({ binding, visibility: C, ...x });
      const uniform = { buffer: { type: 'uniform' as const } };
      const tex = { texture: { sampleType: 'float' as const } };
      const samp = { sampler: { type: 'filtering' as const } };
      const store2d = { storageTexture: { access: 'write-only' as const, format: 'rgba16float' as const } };
      const storeArr = { storageTexture: { access: 'write-only' as const, format: 'rgba16float' as const, viewDimension: '2d-array' as const } };
      const layouts = {
        dfg: device.createBindGroupLayout({ label: 'layout:sky-dfg', entries: [e(0, store2d)] }),
        sh: device.createBindGroupLayout({ label: 'layout:sky-sh', entries: [e(0, uniform), e(1, tex), e(2, tex), e(3, samp), e(4, uniform), e(5, store2d)] }),
        cube: device.createBindGroupLayout({ label: 'layout:sky-cube', entries: [e(0, uniform), e(1, tex), e(2, tex), e(3, samp), e(4, uniform), e(5, tex), e(6, storeArr)] }),
        pf: device.createBindGroupLayout({ label: 'layout:sky-prefilter', entries: [e(0, { texture: { sampleType: 'float', viewDimension: 'cube' } }), e(1, samp), e(2, storeArr), e(3, uniform)] }),
      };
      const shaders = skyLightShaders();
      const keys = { dfg: 'sky-light:dfg', sh: 'sky-light:sh', cube: 'sky-light:cube', pf: 'sky-light:prefilter' } as const;
      for (const k of ['dfg', 'sh', 'cube', 'pf'] as const) {
        const linked = k === 'dfg' ? shaders.dfg : k === 'sh' ? shaders.sh : k === 'cube' ? shaders.cube : shaders.prefilter;
        s.ctx.pipelines.register(keys[k], 'compute', () => ({
          label: keys[k], layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[k]] }),
          compute: { module: s.ctx.pipelines.shaderModule(linked, keys[k]), entryPoint: 'main' },
        }));
        void s.ctx.pipelines.compile(keys[k]).catch(() => undefined);
      }
      const dfgGroup = device.createBindGroup({ label: 'sky-dfg', layout: layouts.dfg, entries: [{ binding: 0, resource: atlasView }] });
      const pfGroups = mipViews.map((v, m) => m === 0 ? null : device.createBindGroup({ label: `sky-prefilter-${m}`, layout: layouts.pf, entries: [
        { binding: 0, resource: cubeSrcView }, { binding: 1, resource: sampler }, { binding: 2, resource: v }, { binding: 3, resource: { buffer: pfBuffers[m] } }] }));
      let atmoGroups: { key: unknown[]; sh: GPUBindGroup; cube: GPUBindGroup } | null = null;

      // ── State ──
      let dfgDone = false;
      let shVersion = -1;
      let shBuilds = 0;
      let cubeBuilds = 0;
      let cubeSun: Vec3 | null = null;
      let cubeUp: Vec3 | null = null;
      let cubeObserver: Vec3 | null = null;
      let force = false;
      const staging = new ArrayBuffer(SKY_LIGHT_PARAMS_BYTES);
      s.scene.provide('skyLight', {
        get shBuilds() { return shBuilds; },
        get cubeBuilds() { return cubeBuilds; },
        rebuild() { force = true; },
        async readAtlas() {
          const rowBytes = SKY_ATLAS.width * 8;
          const buf = device.createBuffer({ label: 'sky-light:atlas-readback', size: rowBytes * SKY_ATLAS.height, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
          const enc = device.createCommandEncoder({ label: 'sky-light:atlas-readback' });
          enc.copyTextureToBuffer({ texture: atlas }, { buffer: buf, bytesPerRow: rowBytes }, [SKY_ATLAS.width, SKY_ATLAS.height]);
          queue.submit([enc.finish()]);
          await buf.mapAsync(1);
          const halfs = new Uint16Array(buf.getMappedRange().slice(0));
          buf.unmap();
          s.ctx.deferDestroy(buf);
          return Float32Array.from(halfs, halfToFloat);
        },
      });
      s.bindings.provide('skyLight', { cube: cubeView, dfg: atlasView, sh: { buffer: params } });

      disposers.push(s.graph.addPass({
        name: 'sky-light', slot: 'compute.pre', order: 10, reads: [], writes: [],
        run(c) {
          const atmoFacet = s.scene.get('atmosphere');
          const res = s.bindings.get('atmosphere');
          const f = c.frame;
          const focus = f.focus.world;
          const fl = Math.hypot(focus[0], focus[1], focus[2]);
          const up: Vec3 = fl > 1e-3 ? [focus[0] / fl, focus[1] / fl, focus[2] / fl] : [0, 1, 0];
          const planetR = s.scene.get('planet')?.radius ?? 18;
          const groundR = atmoFacet?.preset.groundRadius ?? 17;
          const obsR = Math.max(Math.min(fl, planetR + 6), groundR + 0.05);
          const sun = f.sunDir as Vec3;
          const pd = s.ctx.pipelines.get<GPUComputePipeline>(keys.dfg);
          const ps = s.ctx.pipelines.get<GPUComputePipeline>(keys.sh);
          const pc = s.ctx.pipelines.get<GPUComputePipeline>(keys.cube);
          const pp = s.ctx.pipelines.get<GPUComputePipeline>(keys.pf);
          const needDfg = !dfgDone && !!pd;
          // Only once the atmosphere LUTs are baked (the facet version is the BAKED version, −1 before).
          const needSh = !!atmoFacet && atmoFacet.version >= 0 && !!ps && (shVersion !== atmoFacet.version || force);
          const moved = !cubeSun || !cubeUp || chordSq(cubeSun, sun) > SKY_CUBE_REBUILD_RAD ** 2 || chordSq(cubeUp, up) > SKY_CUBE_REBUILD_RAD ** 2;
          const needCube = !!atmoFacet && !!pc && !!pp && (needSh || moved || force) && (shVersion >= 0 || needSh);
          // The cube is baked for THIS frame's observer, so its params are written before the dispatches read them; the
          // lighting keeps using the bake's observer until the next rebuild.
          if (needCube) { cubeSun = [...sun] as Vec3; cubeUp = up; cubeObserver = [up[0] * obsR, up[1] * obsR, up[2] * obsR]; }
          const valid = dfgDone || needDfg ? (shVersion >= 0 || needSh) && !!cubeUp : false;
          SKY_LIGHT_PARAMS.pack({
            observer: [...(cubeObserver ?? [up[0] * obsR, up[1] * obsR, up[2] * obsR]), cubeSize],
            focus_up: [...(cubeUp ?? up), mips],
            atlas: [SKY_ATLAS.dfg, SKY_ATLAS.block, SKY_ATLAS.width, SKY_ATLAS.height],
            shaping: [SHAPED_AMBIENT_V1.ambShadowKeep, SHAPED_AMBIENT_V1.nightAmbScale, SHAPED_AMBIENT_V1.dayLo, SHAPED_AMBIENT_V1.dayHi],
            shaping2: [SHAPED_AMBIENT_V1.backFillNight, SHAPED_AMBIENT_V1.terminatorGain, SHAPED_AMBIENT_V1.hemiGround, 1],
            misc: [valid ? 1 : 0, sun[0] * up[0] + sun[1] * up[1] + sun[2] * up[2], planetR, 0],
            ambient: [atmoFacet?.preset.ambientGain ?? 1, atmoFacet?.preset.ambientSaturation ?? 1, 0, 0],
          }, staging);
          queue.writeBuffer(params, 0, staging);
          if (!needDfg && !needSh && !needCube) return;
          if ((needSh || needCube) && (!atmoGroups || atmoGroups.key[0] !== res.transmittance || atmoGroups.key[1] !== res.multiscatter || atmoGroups.key[2] !== (res.params as GPUBufferBinding).buffer)) {
            const atmoEntries: GPUBindGroupEntry[] = [
              { binding: 0, resource: res.params }, { binding: 1, resource: res.transmittance }, { binding: 2, resource: res.multiscatter },
              { binding: 3, resource: sampler }, { binding: 4, resource: { buffer: params } }];
            atmoGroups = {
              key: [res.transmittance, res.multiscatter, (res.params as GPUBufferBinding).buffer],
              sh: device.createBindGroup({ label: 'sky-sh', layout: layouts.sh, entries: [...atmoEntries, { binding: 5, resource: atlasView }] }),
              cube: device.createBindGroup({ label: 'sky-cube', layout: layouts.cube, entries: [...atmoEntries, { binding: 5, resource: atlasView }, { binding: 6, resource: mipViews[0] }] }),
            };
          }
          const ts = c.timestampWrites('sky-light') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'sky-light', ...(ts ? { timestampWrites: ts } : {}) });
          if (needDfg) {
            pass.setPipeline(pd!); pass.setBindGroup(0, dfgGroup);
            pass.dispatchWorkgroups(SKY_ATLAS.dfg / 8, SKY_ATLAS.height / 8);
            dfgDone = true;
          }
          if (needSh) {
            pass.setPipeline(ps!); pass.setBindGroup(0, atmoGroups!.sh);
            pass.dispatchWorkgroups(SKY_ATLAS.block / 8, SKY_ATLAS.block / 8);
            shVersion = atmoFacet!.version;
            shBuilds++;
            s.telemetry.count('skyLightShBuild');
          }
          if (needCube) {
            pass.setPipeline(pc!); pass.setBindGroup(0, atmoGroups!.cube);
            pass.dispatchWorkgroups(Math.ceil(cubeSize / 8), Math.ceil(cubeSize / 8), 6);
            pass.setPipeline(pp!);
            for (let m = 1; m < mips; m++) {
              pass.setBindGroup(0, pfGroups[m]!);
              const sz = Math.max(1, cubeSize >> m);
              pass.dispatchWorkgroups(Math.ceil(sz / 8), Math.ceil(sz / 8), 6);
            }
            cubeBuilds++;
            s.telemetry.count('skyLightCubeBuild');
          }
          force = false;
          pass.end();
        },
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
