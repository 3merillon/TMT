/**
 * The planet signed distance field as seen by consumers (docs/visibility-architecture.md): one r16float volume over the
 * ±`half` cube, negative inside rock, plus the pending crater spheres cut analytically into every lookup.
 *
 * Consumers bind the reserved `sdf` binding ({ volume, params }) and a linear clamp sampler with `sdfBindingsWgsl`, then
 * link `sdfWgsl`. Every function here is the single implementation used by fog of war, shadows, AO and GI (the AO cones
 * live in ao/sdf-ao.ts, where they also see the tank bricks).
 *
 * Soft visibility follows Quilez's cone estimator with Aaltonen's triangulation against step banding, and marches into
 * negative distances so the 50% contour sits on the geometric boundary. The penumbra is specified as a WORLD width
 * behind an occluder at distance t from the receiver: `width(t) = clamp(w.x + w.y·t, w.x, w.z)`.
 */
import { makeModule, wgslStruct } from '../../wgsl/module';

/** Widest a directional (sun, moon) penumbra grows (u), however far its occluder: see sdf_vis_dir_occ. */
export const SDF_PENUMBRA_MAX = 0.4;
/** How far the terrain's facets stray from the smooth surface they are shaded as (u): sun and moon traces tolerate it. */
export const SDF_FACET_TOLERANCE = 0.1;
export const SDF_MAX_CUTS = 8;

export const SDF_PARAMS = wgslStruct('SdfParams', [
  ['grid', 'vec4f'],   // x N (voxels per axis), y voxel size (u), z domain half extent (u), w valid (1 once built)
  ['info', 'vec4f'],   // x 1 / (2·half), y band (u), z build serial, w active cut count
  ['cuts', { array: 'vec4f', count: SDF_MAX_CUTS }], // pending and held crater spheres: centre xyz, radius
]);

/** Declares `sdf_volume`, `sdf_params` and `sdf_sampler` at the given bindings. */
export function sdfBindingsWgsl(group: number, b: { volume: number; params: number; sampler: number }, samplerGroup = group) {
  return makeModule(`sdf-bindings:${group}:${b.volume},${b.params}:${samplerGroup}:${b.sampler}`, [
    `@group(${group}) @binding(${b.volume}) var sdf_volume: texture_3d<f32>;`,
    `@group(${group}) @binding(${b.params}) var<uniform> sdf_params: SdfParams;`,
    `@group(${samplerGroup}) @binding(${b.sampler}) var sdf_sampler: sampler;`,
  ].join('\n'), [SDF_PARAMS.module]);
}

export const sdfWgsl = makeModule('sdf', /* wgsl */ `
fn sdf_valid() -> bool { return sdf_params.grid.w > 0.5; }
fn sdf_voxel() -> f32 { return sdf_params.grid.y; }

/** Committed terrain distance. Outside the volume: the distance to the domain cube, a lower bound (all rock is inside). */
fn sdf_terrain(p: vec3f) -> f32 {
  let q = abs(p) - vec3f(sdf_params.grid.z);
  let outside = length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
  if (outside > 0.0) { return outside + 0.9; }
  return textureSampleLevel(sdf_volume, sdf_sampler, p * sdf_params.info.x + 0.5, 0.0).r;
}

/** Terrain distance with the pending (cosmetic) and recently committed crater spheres carved analytically. */
fn sdf_sample(p: vec3f) -> f32 {
  var d = sdf_terrain(p);
  let n = min(u32(sdf_params.info.w), ${SDF_MAX_CUTS}u);
  for (var i = 0u; i < n; i++) {
    let c = sdf_params.cuts[i];
    d = max(d, c.w - length(p - c.xyz));
  }
  return d;
}

/** Tetrahedral central-difference gradient; the radial direction where the field is flat. */
fn sdf_normal(p: vec3f) -> vec3f {
  let e = sdf_params.grid.y * 0.6;
  let k = vec2f(1.0, -1.0);
  let g = k.xyy * sdf_sample(p + k.xyy * e) + k.yyx * sdf_sample(p + k.yyx * e)
        + k.yxy * sdf_sample(p + k.yxy * e) + k.xxx * sdf_sample(p + k.xxx * e);
  let l = length(g);
  return select(p / max(length(p), 1e-4), g / l, l > 1e-6);
}

/**
 * A smooth surface normal from the SDF gradient at scale eps (u). Unlike the flat per-triangle normal of the coarse
 * terrain mesh it is continuous across facets, so anything evaluated with it (fog-of-war facing, trace offsets, the
 * sculpted veil) cannot form a triangle mosaic.
 *
 * The gradient spans about 1.7·eps, so near a wall, a roof edge or a building base it bends toward that other surface
 * (45–60° measured on building walls at eps 0.5). It is therefore blended in only while it stays within about 20° of
 * the facet's normal, as it does across the terrain's gentle creases, and fades to the given normal by 40°.
 */
fn sdf_normal_smooth(p: vec3f, eps: f32, fallback: vec3f) -> vec3f {
  let k = vec2f(1.0, -1.0);
  let g = k.xyy * sdf_sample(p + k.xyy * eps) + k.yyx * sdf_sample(p + k.yyx * eps)
        + k.yxy * sdf_sample(p + k.yxy * eps) + k.xxx * sdf_sample(p + k.xxx * eps);
  let l = length(g);
  if (l < 1e-6) { return fallback; }
  let n = g / l;
  let w = smoothstep(0.766, 0.94, dot(n, fallback));
  return normalize(mix(fallback, n, w));
}

fn sdf_penumbra(res: f32) -> f32 {
  let r = clamp(res, -1.0, 1.0);
  return 0.25 * (1.0 + r) * (1.0 + r) * (2.0 - r);
}

/**
 * Soft visibility from p toward the point s (0 hidden … 1 visible). p should already sit off the surface (normal
 * offset). width: (w_min, growth per unit of occluder distance, w_max) in world units. start: first t (jittered).
 *
 * Contact hardening: the width starts at 0.4·w_min and ramps to w_min over the first 3·w_min of the ray, so the
 * receiver's own surface, which a grazing ray skims, never reads as a half occluder (the start sits further off it than
 * half that width). At full width from the start, every coarse terrain facet tilted away from the target greyed out as
 * a whole triangle.
 */
fn sdf_vis_point(p: vec3f, s: vec3f, width: vec3f, start: f32, max_steps: u32) -> f32 {
  let dv = s - p;
  let L = length(dv);
  if (L < 1e-3) { return 1.0; }
  let rd = dv / L;
  var t = start;
  var res = 1.0;
  var ph = 1e10;
  for (var i = 0u; i < max_steps; i++) {
    if (t >= L) { break; }
    let h = sdf_sample(p + rd * t);
    let w = max(min(width.x * (0.4 + 0.6 * min(t / (3.0 * width.x), 1.0)) + width.y * t, width.z), 1e-3);
    if (h > 0.0) {
      let y = select(0.0, h * h / (2.0 * ph), ph < 1e9);
      let d = sqrt(max(h * h - y * y, 0.0));
      res = min(res, 2.0 * d * t / (w * max(t - y, 1e-4)));
    } else {
      res = min(res, 2.0 * h / w);
    }
    ph = max(h, 1e-4);
    if (res < -1.0) { break; }
    t += clamp(h, 0.02, 4.0);
  }
  return sdf_penumbra(res);
}

/** Soft visibility along a direction (sun, moon). tan_a: tangent of the source's angular radius. */
fn sdf_vis_dir(p: vec3f, l: vec3f, tan_a: f32, start: f32, max_steps: u32) -> f32 {
  return sdf_vis_dir_occ(p, l, tan_a, start, max_steps).x;
}

/**
 * sdf_vis_dir that also reports the distance to the occluder that shapes the penumbra (y: t of the tightest cone, 0
 * when nothing comes within the cone). Shadow-map consumers turn it into a filter width: tan_a · y.
 */
fn sdf_vis_dir_occ(p: vec3f, l: vec3f, tan_a: f32, start: f32, max_steps: u32) -> vec2f {
  return sdf_vis_dir_tolerant(p, l, tan_a, start, max_steps, 0.0);
}

/**
 * sdf_vis_dir_occ with a facet tolerance: the occluder distance the penumbra reads is h + tolerance, so a ray only
 * darkens once it passes nearer the field's surface than the tolerance (or through it). The terrain is a low-poly mesh
 * shaded with smooth normals; the field holds its true facets, and a sun ray leaving one facet skims its convex
 * neighbours by a few centimetres. Read as near misses, those skims printed striated, leaf-shaped partial shadows over
 * open ground (the shadow-terminator problem). Stepping still uses the raw distance.
 */
fn sdf_vis_dir_tolerant(p: vec3f, l: vec3f, tan_a: f32, start: f32, max_steps: u32, tolerance: f32) -> vec2f {
  // The miniature sun and moon are wide (2–2.6°): uncapped, a small occluder far along the ray (a tower top near the
  // skyline) casts no umbra at all, only a broad faint blob that slides across open ground as the light moves. Past
  // SDF_PENUMBRA_MAX the cone stops widening, so distant shadows keep their shape and near misses stay lit.
  let w_max = ${SDF_PENUMBRA_MAX};
  let r2 = sdf_params.grid.z * sdf_params.grid.z;
  var t = start;
  var res = 1.0;
  var occ = 0.0;
  var ph = 1e10;
  for (var i = 0u; i < max_steps; i++) {
    let q = p + l * t;
    if (dot(q, q) > r2 && dot(q, l) > 0.0) { break; }
    let raw = sdf_sample(q);
    let h = raw + tolerance;
    var r: f32;
    if (h > 0.0) {
      let y = select(0.0, h * h / (2.0 * ph), ph < 1e9);
      let d = sqrt(max(h * h - y * y, 0.0));
      r = d / min(tan_a * max(t - y, 1e-4), w_max);
    } else {
      r = h / min(tan_a * max(t, 1e-3), w_max);
    }
    if (r < res) { res = r; occ = t; }
    ph = max(h, 1e-4);
    if (res < -1.0) { break; }
    t += clamp(raw, 0.02, 4.0);
  }
  return vec2f(sdf_penumbra(res), occ);
}

`, [SDF_PARAMS.module]);
