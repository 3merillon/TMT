// Ported from Pinionfall src/gpu/shared-terrain-wgsl.ts (MIT, same owner) — sample_cascade_safe (~585–750), extracted.
/**
 * Sun-shadow sampling (plan §4.8). The params block is the reserved binding `sunShadows.params` (256 B).
 *
 * `shadow_pcf` is Pinionfall's `sample_cascade_safe` without the atlas: a normal offset along the GEOMETRIC normal
 * (GB1.zw) scaled by (1 + tanθ, clamped to 4), a depth bias, border-safe bounds (a receiver outside the map reports
 * "not inside" so the caller falls back), then a grid×grid rotated-grid PCF of bilinear compare taps two texels apart,
 * rotated per pixel (and per frame, for TAA) by interleaved gradient noise. Grid 2/3/4/4 by tier.
 *
 * `sun_shadow` combines the three fixed-basis maps: PlanetStatic and PlanetDynamic share the (held) planet projection and
 * combine as min(static, dynamic); the Hero map blends over them across its outer 15% (`hero.z` = 0.85).
 * Maps are reversed-Z (SHADOW_DEPTH): the compare sampler is 'greater', a larger reference = closer to the sun, and the
 * receiver bias is ADDED to the reference.
 *
 * Globals referenced (declared by the consumer with `sunShadowBindingsWgsl`): `sun_shadow_params`, `sun_shadow_static`,
 * `sun_shadow_dynamic`, `sun_shadow_hero`, `sun_shadow_compare`.
 */
import { makeModule, wgslStruct } from '../../wgsl/module';
import { mathWgsl } from '../../wgsl/common/constants.wgsl';

export const SUN_SHADOW_PARAMS = wgslStruct('SunShadowParams', [
  ['planet_view_proj', 'mat4x4f'],  // held basis: PlanetStatic + PlanetDynamic
  ['hero_view_proj', 'mat4x4f'],
  ['planet', 'vec4f'],   // x static texel (uv), y dynamic texel (uv), z static texel (world), w dynamic texel (world)
  ['hero', 'vec4f'],     // x texel (uv), y texel (world), z blend start (0.85), w enabled
  ['bias', 'vec4f'],     // x normal offset (texels), y static depth bias, z dynamic depth bias, w hero depth bias (ndc)
  ['flags', 'vec4f'],    // x valid, y dynamic map present, z pcf grid, w contact shadows on
  ['contact', 'vec4f'],  // x length (u), y steps, z thickness (u), w strength
  ['light', 'vec4f'],    // xyz sun (toward) used by the planet maps (held), w frame noise index
]);

export const SUN_SHADOW_PARAMS_BYTES = 256;

export const shadowSampleWgsl = makeModule('sun-shadow', /* wgsl */ `
fn shadow_ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }

fn shadow_valid() -> bool { return sun_shadow_params.flags.x > 0.5; }

/**
 * One map: returns (visibility, inside). texel_uv = 1/size; texel_world = world size of one texel (normal offset unit).
 */
fn shadow_pcf(map: texture_depth_2d, vp: mat4x4f, p: vec3f, ng: vec3f, l: vec3f, texel_uv: f32, texel_world: f32,
              depth_bias: f32, grid: u32, angle: f32) -> vec2f {
  return shadow_pcf_step(map, vp, p, ng, l, texel_uv, texel_world, depth_bias, grid, angle, 3.0 * texel_uv);
}

/** shadow_pcf with an explicit spacing of the rotated grid taps (uv): a wider footprint is a wider penumbra. */
fn shadow_pcf_step(map: texture_depth_2d, vp: mat4x4f, p: vec3f, ng: vec3f, l: vec3f, texel_uv: f32, texel_world: f32,
                   depth_bias: f32, grid: u32, angle: f32, step: f32) -> vec2f {
  let cos_t = clamp(dot(ng, l), 0.0, 1.0);
  let slope = clamp(sqrt(max(1.0 - cos_t * cos_t, 0.0)) / max(cos_t, 0.01), 0.0, 4.0);
  let offset = ng * (texel_world * sun_shadow_params.bias.x * (1.0 + slope));
  let clip = vp * vec4f(p + offset, 1.0);
  let ndc = clip.xyz / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let reference = ndc.z + depth_bias;
  let bm = texel_uv;
  if (uv.x < bm || uv.y < bm || uv.x > 1.0 - bm || uv.y > 1.0 - bm || ndc.z < 0.0 || ndc.z > 1.0) { return vec2f(1.0, 0.0); }
  if (grid <= 1u) {
    return vec2f(textureSampleCompareLevel(map, sun_shadow_compare, uv, reference), 1.0);
  }
  // A wider PCF footprint softens silhouette steps on crater lips without changing the held map projection.
  let ca = cos(angle);
  let sa = sin(angle);
  let half_grid = f32(grid - 1u) * 0.5;
  let lo = vec2f(0.5 * bm);
  let hi = vec2f(1.0 - 0.5 * bm);
  var total = 0.0;
  for (var y = 0u; y < grid; y++) {
    for (var x = 0u; x < grid; x++) {
      let d = (vec2f(f32(x), f32(y)) - half_grid) * step;
      let r = vec2f(d.x * ca - d.y * sa, d.x * sa + d.y * ca);
      total += textureSampleCompareLevel(map, sun_shadow_compare, clamp(uv + r, lo, hi), reference);
    }
  }
  return vec2f(total / f32(grid * grid), 1.0);
}

/** Hero coverage weight at p: 1 inside the inner blend_start of the square, fading to 0 at its edge. */
fn shadow_hero_weight(p: vec3f) -> f32 {
  if (sun_shadow_params.hero.w < 0.5) { return 0.0; }
  let c = sun_shadow_params.hero_view_proj * vec4f(p, 1.0);
  let d = max(abs(c.x), abs(c.y));
  if (c.z < 0.0 || c.z > 1.0) { return 0.0; }
  return 1.0 - smoothstep(sun_shadow_params.hero.z, 1.0, d);
}

/**
 * Sun visibility at a world point with an explicit PCF rotation. ng: geometric normal; l: current sun (toward).
 * Hero where it covers, min(static, dynamic) elsewhere, blended over the hero's outer 15%.
 */
fn sun_shadow_rot(p: vec3f, ng: vec3f, l: vec3f, angle: f32) -> f32 {
  if (!shadow_valid()) { return 1.0; }
  let grid = u32(sun_shadow_params.flags.z);
  let hero_w = shadow_hero_weight(p);
  var hero_vis = 1.0;
  if (hero_w > 0.0) {
    hero_vis = shadow_pcf(sun_shadow_hero, sun_shadow_params.hero_view_proj, p, ng, l, sun_shadow_params.hero.x,
                          sun_shadow_params.hero.y, sun_shadow_params.bias.w, grid, angle).x;
  }
  var planet_vis = 1.0;
  if (hero_w < 1.0) {
    let lh = sun_shadow_params.light.xyz;
    planet_vis = shadow_pcf(sun_shadow_static, sun_shadow_params.planet_view_proj, p, ng, lh, sun_shadow_params.planet.x,
                            sun_shadow_params.planet.z, sun_shadow_params.bias.y, grid, angle).x;
    if (sun_shadow_params.flags.y > 0.5) {
      planet_vis = min(planet_vis, shadow_pcf(sun_shadow_dynamic, sun_shadow_params.planet_view_proj, p, ng, lh,
                  sun_shadow_params.planet.y, sun_shadow_params.planet.w, sun_shadow_params.bias.z, grid, angle).x);
    }
  }
  return mix(planet_vis, hero_vis, hero_w);
}

/** Sun visibility with the per-pixel, per-frame IGN rotation (converged by TAA). px: pixel coordinate. */
fn sun_shadow(p: vec3f, ng: vec3f, l: vec3f, px: vec2f) -> f32 {
  return sun_shadow_rot(p, ng, l, shadow_ign(px + 5.588238 * sun_shadow_params.light.w) * PI);
}
`, [SUN_SHADOW_PARAMS.module, mathWgsl]);

export function sunShadowBindingsWgsl(group: number, b: { static: number; dynamic: number; hero: number; compare: number; params: number }) {
  return makeModule(`sun-shadow-bindings:${group}:${b.static},${b.dynamic},${b.hero},${b.compare},${b.params}`, [
    `@group(${group}) @binding(${b.static}) var sun_shadow_static: texture_depth_2d;`,
    `@group(${group}) @binding(${b.dynamic}) var sun_shadow_dynamic: texture_depth_2d;`,
    `@group(${group}) @binding(${b.hero}) var sun_shadow_hero: texture_depth_2d;`,
    `@group(${group}) @binding(${b.compare}) var sun_shadow_compare: sampler_comparison;`,
    `@group(${group}) @binding(${b.params}) var<uniform> sun_shadow_params: SunShadowParams;`,
  ].join('\n'), [SUN_SHADOW_PARAMS.module]);
}
