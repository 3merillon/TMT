/**
 * Fog-of-war visibility from the planet SDF (docs/visibility-architecture.md).
 *
 * - `fog_hidden_at`: soft hidden fraction of a surface point for the team's sensors, 1 − Π(1 − v_s), each v_s a cone
 *   trace toward the sensor through the SDF times a soft sensor-facing term (back faces hide smoothly).
 * - Surface: a half-resolution trace at one jittered pixel per 2×2 block (rgba16f: hidden, linear depth, valid), then a
 *   full-resolution resolve that blends the depth-compatible half-res neighbours and re-traces where none match, so a
 *   hidden building's silhouette never borrows the value from across its edge. Ultra traces every pixel.
 * - Volume: a world-space hidden-fraction volume over ±`volume.y` (past the atmosphere's soft top), refilled from the
 *   SDF every frame (half the voxels per frame on Low/Medium). Lighting marches camera rays through it.
 * Everything is a function of world position and the sensor positions: orbiting the camera only moves the samples.
 */
import type { WgslModule } from '../../contracts';
import { makeModule, wgslStruct } from '../../wgsl/module';

export const FOG_MAX_SENSORS = 4;

export const FOG_PARAMS = wgslStruct('FogOfWarParams', [
  ['settings', 'vec4f'],  // x enabled, y sensor count, z tier (0 low … 3 ultra), w frame index
  ['sensors', { array: 'vec4f', count: FOG_MAX_SENSORS }], // xyz, w 1
  ['penumbra', 'vec4f'],  // x w_min, y growth per unit of occluder distance, z w_max (u), w volume checkerboard phase (−1 = all)
  ['volume', 'vec4f'],    // x voxels per axis, y half extent (u), z voxel (u), w atmosphere soft radius (u)
  ['march', 'vec4f'],     // x fog march samples, y surface max steps, z volume max steps, w full-res surface trace (1)
]);

/** Host shaders bind `fog_params` themselves (the lighting pass). */
export function fogParamsBindingWgsl(group: number, binding: number) {
  return makeModule(`fog-params-binding:${group}:${binding}`, `@group(${group}) @binding(${binding}) var<uniform> fog_params: FogOfWarParams;`, [FOG_PARAMS.module]);
}

/** Needs `fog_params` and the sdf library. */
export const fogVisibilityWgsl = makeModule('fog-visibility', /* wgsl */ `
fn fog_enabled() -> bool { return fog_params.settings.x > 0.5 && sdf_valid(); }

/** Hidden fraction (0 seen … 1 hidden) of a surface point with a SMOOTH normal nrm (see fog_surface_normal). */
fn fog_hidden_at(p: vec3f, nrm: vec3f, xi: f32, max_steps: u32) -> f32 {
  let voxel = sdf_voxel();
  let q = p + nrm * (voxel * 0.75);
  var hidden = 1.0;
  let n = min(u32(fog_params.settings.y), FOG_MAX_SENSORS);
  for (var i = 0u; i < n; i++) {
    let s = fog_params.sensors[i].xyz;
    let facing = smoothstep(-0.25, 0.15, dot(nrm, normalize(s - p)));
    if (facing <= 0.0) { continue; }
    let v = sdf_vis_point(q, s, fog_params.penumbra.xyz, voxel * (0.5 + xi), max_steps) * facing;
    hidden *= 1.0 - v;
    if (hidden < 0.002) { break; }
  }
  return hidden;
}

/**
 * The normal the fog of war faces toward the sensors: the coarse terrain (and the grass on it) takes the smooth SDF
 * gradient, continuous across its facets; buildings and rocks keep their own flat faces (at their scale the gradient
 * bends toward roofs, corners and the ground, and hid the upper walls a tank could plainly see); anything else (tanks,
 * props) keeps its shading normal.
 */
fn fog_surface_normal(p: vec3f, ng: vec3f, ns: vec3f, class_id: u32) -> vec3f {
  if (class_id == CLASS_TERRAIN || class_id == CLASS_GRASS) {
    return sdf_normal_smooth(p, 0.5, ng);
  }
  return ns;
}

/** Hidden fraction of a point in the air (no facing term). */
fn fog_hidden_air(q: vec3f, xi: f32, max_steps: u32) -> f32 {
  var hidden = 1.0;
  let n = min(u32(fog_params.settings.y), FOG_MAX_SENSORS);
  for (var i = 0u; i < n; i++) {
    let v = sdf_vis_point(q, fog_params.sensors[i].xyz, fog_params.penumbra.xyz, sdf_voxel() * (0.25 + 0.5 * xi), max_steps);
    hidden *= 1.0 - v;
    if (hidden < 0.002) { break; }
  }
  return hidden;
}
`, [makeModule('fog-constants', `const FOG_MAX_SENSORS: u32 = ${FOG_MAX_SENSORS}u;`)]);

/** Interleaved gradient noise with a per-frame rotation (TAA converges it). */
const noiseWgsl = makeModule('fog-noise', /* wgsl */ `
fn fog_noise(px: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * (px.x + 5.588238 * f32(u32(fog_params.settings.w) % 64u)) + 0.00583715 * px.y));
}
`);

/** The G-buffer inputs of the surface passes (@group(1)). */
const surfaceInputs = /* wgsl */ `
@group(1) @binding(0) var gb_depth: texture_depth_2d;
@group(1) @binding(1) var gb_normals: texture_2d<f32>;
@group(1) @binding(2) var gb_ids: texture_2d<u32>;
@group(1) @binding(3) var<uniform> fog_params: FogOfWarParams;

/** xyz world position and w linear depth; w = 0 for sky. */
fn surface_at(px: vec2u) -> vec4f {
  let d = textureLoad(gb_depth, px, 0);
  if (d <= 0.0 || gbuffer_class(textureLoad(gb_ids, px, 0).r) == CLASS_SKY) { return vec4f(0.0); }
  let uv = (vec2f(px) + 0.5) / frame_internal_size();
  return vec4f(world_pos_from_depth(uv, d), linear_depth(d));
}
fn surface_normal(px: vec2u, p: vec3f) -> vec3f {
  let e = textureLoad(gb_normals, px, 0);
  return fog_surface_normal(p, oct_decode(e.zw), oct_decode(e.xy), gbuffer_class(textureLoad(gb_ids, px, 0).r));
}
`;

export function fogSurfaceHalfWgsl(deps: readonly WgslModule[]) {
  return makeModule('fog-surface-half', /* wgsl */ `
${surfaceInputs}
@group(1) @binding(4) var half_out: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn trace_half(@builtin(global_invocation_id) gid: vec3u) {
  let hs = textureDimensions(half_out);
  if (gid.x >= hs.x || gid.y >= hs.y) { return; }
  let full = vec2u(frame_internal_size());
  let f = u32(fog_params.settings.w) % 4u;
  let jitter = vec2u(select(0u, 1u, f == 1u || f == 2u), select(0u, 1u, f == 1u || f == 3u));
  let px = min(gid.xy * 2u + jitter, full - vec2u(1u));
  let s = surface_at(px);
  if (s.w <= 0.0) { textureStore(half_out, gid.xy, vec4f(0.0)); return; }
  let hidden = fog_hidden_at(s.xyz, surface_normal(px, s.xyz), fog_noise(vec2f(px)), u32(fog_params.march.y));
  textureStore(half_out, gid.xy, vec4f(hidden, s.w, 1.0, 0.0));
}
`, [...deps, FOG_PARAMS.module, noiseWgsl]);
}

export function fogSurfaceResolveWgsl(outFormat: GPUTextureFormat, deps: readonly WgslModule[]) {
  return makeModule(`fog-surface-resolve:${outFormat}`, /* wgsl */ `
${surfaceInputs}
@group(1) @binding(4) var half_in: texture_2d<f32>;
@group(1) @binding(5) var hidden_out: texture_storage_2d<${outFormat}, write>;

@compute @workgroup_size(8, 8, 1)
fn resolve_full(@builtin(global_invocation_id) gid: vec3u) {
  let full = vec2u(frame_internal_size());
  if (gid.x >= full.x || gid.y >= full.y) { return; }
  let px = gid.xy;
  let s = surface_at(px);
  if (s.w <= 0.0) { textureStore(hidden_out, px, vec4f(0.0)); return; }
  var hidden = 0.0;
  var trace = fog_params.march.w > 0.5;
  if (!trace) {
    // The four half-res texels around this pixel, weighted bilinearly and by depth agreement.
    let hs = vec2i(textureDimensions(half_in));
    // Reconstruct from the actual jittered sample positions, not the centres of
    // their 2x2 blocks. Fixed weights made stationary edges swim every four frames.
    let phase = u32(fog_params.settings.w) % 4u;
    let jitter = vec2f(select(0.0, 1.0, phase == 1u || phase == 2u), select(0.0, 1.0, phase == 1u || phase == 3u));
    let grid = (vec2f(px) - jitter) * 0.5;
    let base = vec2i(floor(grid));
    let fraction = fract(grid);
    var sum = 0.0;
    var wsum = 0.0;
    for (var k = 0u; k < 4u; k++) {
      let offset = vec2i(i32(k & 1u), i32(k >> 1u));
      let t = clamp(base + offset, vec2i(0), hs - vec2i(1));
      let h = textureLoad(half_in, t, 0);
      if (h.z < 0.5) { continue; }
      let rel = abs(h.y - s.w) / max(s.w, 1e-3);
      if (rel > 0.02) { continue; }
      let weights = select(1.0 - fraction, fraction, offset == vec2i(1));
      let w = weights.x * weights.y * max(1.0 - rel * 40.0, 0.05);
      sum += h.x * w;
      wsum += w;
    }
    if (wsum > 0.12) { hidden = sum / wsum; } else { trace = true; }
  }
  if (trace) {
    hidden = fog_hidden_at(s.xyz, surface_normal(px, s.xyz), fog_noise(vec2f(px)), u32(fog_params.march.y));
  }
  textureStore(hidden_out, px, vec4f(hidden, 0.0, 0.0, 0.0));
}
`, [...deps, FOG_PARAMS.module, noiseWgsl]);
}

export function fogVolumeWgsl(outFormat: GPUTextureFormat, deps: readonly WgslModule[]) {
  return makeModule(`fog-volume-fill:${outFormat}`, /* wgsl */ `
@group(1) @binding(0) var<uniform> fog_params: FogOfWarParams;
@group(1) @binding(1) var volume_out: texture_storage_3d<${outFormat}, write>;

fn vol_noise(c: vec3u) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * f32(c.x + 7u * c.z) + 0.00583715 * f32(c.y + 13u * c.z) + 0.618034 * f32(u32(fog_params.settings.w) % 16u)));
}

@compute @workgroup_size(4, 4, 4)
fn fill(@builtin(global_invocation_id) id: vec3u) {
  let m = u32(fog_params.volume.x);
  if (any(id >= vec3u(m))) { return; }
  let phase = fog_params.penumbra.w;
  if (phase >= 0.0 && f32((id.x + id.y + id.z) & 1u) != phase) { return; }
  let v = fog_params.volume.z;
  let c = (vec3f(id) + 0.5) * v - fog_params.volume.y;
  let r = length(c);
  if (r > fog_params.volume.w + v) { textureStore(volume_out, id, vec4f(0.0)); return; }
  let d = sdf_sample(c);
  if (d < -v) { textureStore(volume_out, id, vec4f(1.0)); return; }
  // Lift near-surface samples out of the rock so the air just above visible ground reads as seen.
  let q = c + (c / max(r, 1e-3)) * max(0.0, 0.6 * v - d);
  textureStore(volume_out, id, vec4f(fog_hidden_air(q, vol_noise(id), u32(fog_params.march.z))));
}
`, [...deps, FOG_PARAMS.module]);
}

/** Debug and gate probes: soft visibility (1 − hidden) at world points with normals (zero normal = a point in the air). */
export function fogProbeWgsl(deps: readonly WgslModule[]) {
  return makeModule('fog-probe', /* wgsl */ `
@group(1) @binding(0) var<uniform> fog_params: FogOfWarParams;
@group(1) @binding(1) var<storage, read> probe_in: array<vec4f>;
@group(1) @binding(2) var<storage, read_write> probe_out: array<f32>;

@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&probe_out)) { return; }
  let p = probe_in[id.x * 2u].xyz;
  let ng = probe_in[id.x * 2u + 1u].xyz;
  var hidden: f32;
  if (dot(ng, ng) < 0.5) { hidden = fog_hidden_air(p, 0.5, 160u); }
  else { hidden = fog_hidden_at(p, ng, 0.5, 160u); }
  probe_out[id.x] = 1.0 - hidden;
}
`, [...deps, FOG_PARAMS.module]);
}
