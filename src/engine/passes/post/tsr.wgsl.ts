// Ported from Planets src/gpu/tsr-shaders.ts (MIT, same owner), a port of @pmndrs/upscaler v0.5.0 — adapted
/**
 * Temporal super resolution (TSR): the four compute passes that resolve a frame rendered BELOW display resolution. Every
 * frame's samples land on a different sub-pixel position (the camera jitter), and the accumulation integrates them at
 * display resolution, which the TAA's upscale branch (one bilinear stretch per frame) cannot do.
 *
 * The passes derive from @pmndrs/upscaler (src/shaders/reconstruct.ts, accumulate.ts, rcas.ts, common.ts), an FSR 2/3
 * style temporal pipeline with the FSR 1 RCAS sharpener. Its licence and AMD's notice, verbatim (the shipped copy is
 * public/THIRD-PARTY-NOTICES.txt: the build strips WGSL comments, so no notice inside the shader text would survive):
 *
 *   MIT License
 *
 *   Copyright (c) 2026 Dennis Smolek
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 *   ---
 *
 *   The WGSL EASU and RCAS shaders in src/shaders/ are derived from AMD's
 *   FidelityFX Super Resolution (ffx_fsr1.h), and the temporal pipeline follows
 *   the architecture of FidelityFX Super Resolution 2/3:
 *
 *   Copyright (c) 2021-2023 Advanced Micro Devices, Inc. All rights reserved.
 *   Released under the MIT License:
 *   https://github.com/GPUOpen-Effects/FidelityFX-FSR
 *   https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK
 *
 * TMT's conventions, where they differ from the port's source:
 * - Depth is reversed-Z infinite: the NEAREST sample has the LARGEST depth and the sky is 0, so the dilation takes the
 *   maximum, the scatter keeps the maximum of the raw depth bits (an empty slot is 0, which a cleared buffer already is)
 *   and view depth is near / depth with the sky held at a finite far.
 * - The velocity target is uv_prev − uv_current through UNJITTERED matrices on every raster pixel, so motion is its
 *   negation with no jitter term; sky pixels reproject their view direction, as the TAA does.
 * - The camera jitter moves the raster by (+jx, −jy) px (frame/camera.ts), so texel (i, j) samples the unjittered image
 *   at (i + 0.5 − jx, j + 0.5 + jy): `tsr_jitter()`, both signs opposite to the port's source.
 * - Freshly committed terrain (GB3 NEW_GEOMETRY, a whole page for three frames) only loses its history where last
 *   frame's depth disagrees with the depth this surface would have had; the rest keeps it under the unrelaxed clip.
 * - Additions the port's source left out: a reactive mask generated from the frame before and after the passes that
 *   blend without depth or velocity (FSR 2's generated mask), remembered in the lock buffer so the pixels a plume just
 *   left stay reactive, and a shading-change test on the neighbourhood's mean luminance. Reactive pixels resolve by the
 *   TAA's own rule (its clip, blend floor and clip-distance boost) and are neither locked nor sharpened; a shading change
 *   cancels the still-scene and lock relaxations, which would otherwise let a flash trail for the whole accumulation.
 * - The clouds' veil, generated the same way round the clouds' composite: the clouds filter themselves over time and
 *   drift and parallax where the surface vectors say nothing, so a veiled pixel keeps its history only as the TAA would
 *   (its clip and blend floor), never the full accumulation, while keeping its kernel and sharpening.
 */
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { link, makeModule, wgslStruct } from '../../wgsl/module';

export const TSR_PARAMS = wgslStruct('TsrParams', [
  ['control', 'vec4f'],   // x reset (1 = no history this frame), y RCAS sharpness 0..1 (0 = off), z accumulation ceiling (frames), w debug view
  ['tune', 'vec4f'],      // x reactive gain, y blend floor of a fully reactive or changed pixel, z lock strength 0..1, w young-pixel softening 0..1
  ['look', 'vec4f'],      // x clip centre 0 (this frame's sharp upsample) .. 1 (its soft one), y box widening of a still converged pixel (σ), zw reserved
]);

/** `control.w`: what the sharpen pass paints instead of the picture. */
export const TSR_DEBUG_VIEWS = ['off', 'motion', 'disocclusion', 'locks', 'age', 'reactive'] as const;
export type TsrDebugView = typeof TSR_DEBUG_VIEWS[number];

const common = makeModule('tsr-common', /* wgsl */ `
@group(1) @binding(0) var<uniform> tsr: TsrParams;

const TSR_FAR: f32 = 1000.0;
// Bilinear taps lighter than this neither scatter nor vote, so the two footprints agree.
const TSR_TAP_FLOOR: f32 = 6.1e-4;

/** View depth of a reversed-Z sample; the sky (0) is held at a finite far so differences stay finite. */
fn tsr_z(d: f32) -> f32 { return min(frame_near() / max(d, 1e-9), TSR_FAR); }
/** Render texel (i, j) samples the unjittered image at (i, j) + 0.5 + this (render px, y down). */
fn tsr_jitter() -> vec2f { return frame.jitter * frame_internal_size() * vec2f(-0.5, 0.5); }
/** AMD's separation tolerance (ffx_fsr2_depth_clip.h), widened by the neighbourhood's own relief on slopes. */
fn tsr_tolerance(z: f32, relief: f32) -> f32 { return max(1.37e-5 * 0.5 * length(frame_internal_size()) * z, relief); }

fn tsr_ycocg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn tsr_rgb(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
/** NaN first (WGSL min/max do not promise to drop a NaN operand), then the range. */
fn tsr_scrub(c: vec3f) -> vec3f {
  let finite = select(c, vec3f(0.0), c != c);
  return min(max(finite, vec3f(0.0)), vec3f(65504.0));
}
/** Exposed, invertibly tonemapped: one HDR firefly cannot own the running average, and the history keeps half-float precision. */
fn tsr_encode(c: vec3f) -> vec3f {
  let e = tsr_scrub(c) * max(frame.exposure, 1e-4);
  return e / (1.0 + max(e.r, max(e.g, e.b)));
}
fn tsr_untonemap(c: vec3f) -> vec3f { return c / (1.0 - min(max(c.r, max(c.g, max(c.b, 0.0))), 0.999)); }
/** How much a pass without depth or velocity changed this pixel: the tonemapped difference, scaled by the reactive gain. */
fn tsr_change(after: vec3f, before: vec3f) -> f32 {
  let d = abs(tsr_encode(after) - tsr_encode(before));
  return clamp(max(d.r, max(d.g, d.b)) * tsr.tune.x, 0.0, 1.0);
}
`, [frameWgsl, TSR_PARAMS.module]);

/** Pass 0, render resolution, right after the clouds' composite: how much the clouds changed each pixel. */
export const tsrVeilWgsl = makeModule('tsr-veil', /* wgsl */ `
@group(1) @binding(1) var scene_color: texture_2d<f32>;
@group(1) @binding(2) var backdrop: texture_2d<f32>;
@group(1) @binding(3) var veil_out: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let at = vec2i(gid.xy);
  if (any(at >= vec2i(frame_internal_size()))) { return; }
  textureStore(veil_out, at, vec4f(tsr_change(textureLoad(scene_color, at, 0).rgb, textureLoad(backdrop, at, 0).rgb), 0.0, 0.0, 0.0));
}
`, [common]);

/**
 * Pass 1, render resolution: dilate and scatter. Per pixel: the nearest depth of the 3×3 and THAT texel's motion (a thin
 * foreground silhouette then carries its own motion instead of smearing the background's history), and this frame's depth
 * written into the bilinear footprint of where the pixel was last frame, keeping the nearest.
 */
export const tsrReconstructWgsl = makeModule('tsr-reconstruct', /* wgsl */ `
@group(1) @binding(1) var scene_depth: texture_depth_2d;
@group(1) @binding(2) var scene_velocity: texture_2d<f32>;
@group(1) @binding(3) var scene_ids: texture_2d<u32>;
@group(1) @binding(4) var depth_out: texture_storage_2d<r32float, write>;
@group(1) @binding(5) var motion_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(6) var<storage, read_write> scatter: array<atomic<u32>>;

/** Previous-frame uv of a sky pixel: its direction as a point at infinity (the TAA's reproject_sky). */
fn tsr_sky_prev(uv: vec2f) -> vec2f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let vr = vec3f((ndc.x + frame.proj[2][0] + frame.jitter.x) / frame.proj[0][0],
                 (ndc.y + frame.proj[2][1] + frame.jitter.y) / frame.proj[1][1], -1.0);
  let c = frame.prev_view_proj * vec4f(transpose(mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz)) * vr, 0.0);
  if (c.w <= 1e-6) { return vec2f(-1.0); }
  return vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(frame_internal_size());
  let center = vec2i(gid.xy);
  if (any(center >= size)) { return; }
  let hi = size - 1;
  var near = textureLoad(scene_depth, center, 0);
  var far = near;
  var at = center;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let p = clamp(center + vec2i(x, y), vec2i(0), hi);
      let d = textureLoad(scene_depth, p, 0);
      if (d > near) { near = d; at = p; }
      far = min(far, d);
    }
  }
  let z = tsr_z(near);
  let uv = (vec2f(center) + 0.5) / vec2f(size);
  var motion: vec2f;
  if (near > 0.0) { motion = -textureLoad(scene_velocity, at, 0).rg; }
  else { motion = uv - tsr_sky_prev(uv); }
  let fresh = gbuffer_flags(textureLoad(scene_ids, center, 0).r) & GB_FLAG_NEW_GEOMETRY;
  textureStore(depth_out, center, vec4f(z, 0.0, 0.0, 0.0));
  textureStore(motion_out, center, vec4f(motion, tsr_z(far) - z, f32(fresh)));
  // The sky occludes nothing: only surfaces scatter.
  if (near <= 0.0) { return; }
  let q = (uv - motion) * vec2f(size) - 0.5;
  let base = vec2i(floor(q));
  let f = fract(q);
  let weights = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  for (var i = 0; i < 4; i++) {
    let p = base + vec2i(i & 1, i >> 1);
    if (weights[i] <= TSR_TAP_FLOOR || any(p < vec2i(0)) || any(p > hi)) { continue; }
    atomicMax(&scatter[u32(p.y * size.x + p.x)], bitcast<u32>(near));
  }
}
`, [common, gbufferWgsl]);

/**
 * Pass 2, render resolution: the masks. r disocclusion (each bilinear tap at the pixel's previous position votes how sure
 * it is that nothing nearer landed there; both depths are this frame's, so the camera's own motion cancels), g no history
 * at all, b reactive (how much the passes without depth or velocity changed this pixel), a history kept under the plain
 * clip (a re-committed page that kept it, or the clouds' veil).
 */
export const tsrMaskWgsl = makeModule('tsr-mask', /* wgsl */ `
@group(1) @binding(1) var dilated_depth: texture_2d<f32>;
@group(1) @binding(2) var dilated_motion: texture_2d<f32>;
@group(1) @binding(3) var<storage, read> scatter: array<u32>;
@group(1) @binding(4) var mask_out: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(5) var previous_depth: texture_2d<f32>;
@group(1) @binding(6) var scene_color: texture_2d<f32>;
@group(1) @binding(7) var opaque_color: texture_2d<f32>;
@group(1) @binding(8) var cloud_veil: texture_2d<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(frame_internal_size());
  let center = vec2i(gid.xy);
  if (any(center >= size)) { return; }
  let hi = size - 1;
  let z = textureLoad(dilated_depth, center, 0).r;
  let m = textureLoad(dilated_motion, center, 0);
  let reactive = tsr_change(textureLoad(scene_color, center, 0).rgb, textureLoad(opaque_color, center, 0).rgb);
  let veil = textureLoad(cloud_veil, center, 0).r;
  let uv = (vec2f(center) + 0.5) / vec2f(size);
  let prev_uv = uv - m.xy;
  if (!(all(prev_uv >= vec2f(0.0)) && all(prev_uv <= vec2f(1.0)))) {
    textureStore(mask_out, center, vec4f(1.0, 1.0, reactive, veil));
    return;
  }
  let q = prev_uv * vec2f(size) - 0.5;
  let base = vec2i(floor(q));
  let f = fract(q);
  let weights = vec4f((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  // A re-committed page keeps its history where the surface did not move; a crater floor or new rubble has none.
  let fresh = m.w > 0.5;
  // The depth this surface point had in last frame's view: static geometry exactly, a moving body to within its own step.
  var expected = 0.0;
  if (fresh) { expected = (frame.prev_view_proj * vec4f(view_to_world(view_ray_from_uv(uv) * z), 1.0)).w; }
  var confidence = 0.0;
  var known = false;
  for (var i = 0; i < 4; i++) {
    if (weights[i] <= TSR_TAP_FLOOR) { continue; }
    let p = clamp(base + vec2i(i & 1, i >> 1), vec2i(0), hi);
    // This pixel scattered into its own footprint, so a tap reads its own depth unless something nearer reprojects there.
    let tap = bitcast<f32>(scatter[u32(p.y * size.x + p.x)]);
    var c = 1.0;
    if (tap > 0.0) {
      let tz = tsr_z(tap);
      // A tap in front witnesses an occluder that moved off this point. MAX vote: a real disocclusion has every tap covered.
      if (z > tz) { c = clamp(tsr_tolerance(z, m.z) / (z - tz), 0.0, 1.0); }
    }
    confidence = max(confidence, c);
    if (fresh) {
      let before = textureLoad(previous_depth, p, 0).r;
      known = known || abs(before - expected) <= tsr_tolerance(max(before, expected), m.z);
    }
  }
  textureStore(mask_out, center, vec4f(1.0 - confidence, f32(fresh && !known), reactive, max(f32(known), veil)));
}
`, [common, depthWgsl]);

/**
 * Pass 3, display resolution: reproject and accumulate.
 * 1. Upsample this frame with a jitter-aware Lanczos2 kernel over the 3×3 render texels round the display pixel;
 *    integrated over the jitter's phases this is a supersample.
 * 2. Fetch last frame's result through the dilated motion with a Catmull-Rom filter.
 * 3. Clip that history to the YCoCg variance box of the current neighbourhood and cut its weight by the disocclusion mask;
 *    a "lock" on a thin stable feature, or a still converged pixel, widens its box.
 * 4. Blend, carrying the accumulated sample count in the history's alpha.
 * History: rgb exposed and tonemapped, a = sample count / ceiling. Locks: r lifetime, g the luma the lock tracks,
 * b the reactive mask remembered, a the neighbourhood's mean luma (the shading-change reference).
 */
export const tsrAccumulateWgsl = makeModule('tsr-accumulate', /* wgsl */ `
@group(1) @binding(1) var scene_color: texture_2d<f32>;
@group(1) @binding(2) var dilated_motion: texture_2d<f32>;
@group(1) @binding(3) var masks: texture_2d<f32>;
@group(1) @binding(4) var history_in: texture_2d<f32>;
@group(1) @binding(5) var lin_sampler: sampler;
@group(1) @binding(6) var history_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(7) var locks_in: texture_2d<f32>;
@group(1) @binding(8) var locks_out: texture_storage_2d<rgba8unorm, write>;

// Lanczos2, the window FSR 2 uses for its upsample taps.
fn lanczos2(x: f32) -> f32 {
  let ax = abs(x);
  if (ax < 1e-4) { return 1.0; }
  if (ax >= 2.0) { return 0.0; }
  let px = 3.14159265 * ax;
  return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}

/** Catmull-Rom history fetch in 5 bilinear taps (Jimenez 2016): bicubic keeps reprojected history crisp. */
fn tsr_history(uv: vec2f) -> vec4f {
  let res = frame_display_size();
  let pos = uv * res;
  let p1 = floor(pos - 0.5) + 0.5;
  let f = pos - p1;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (p1 - 1.0) / res;
  let t3 = (p1 + 2.0) / res;
  let t12 = (p1 + w2 / w12) / res;
  let r = textureSampleLevel(history_in, lin_sampler, vec2f(t0.x, t12.y), 0.0) * (w0.x * w12.y)
    + textureSampleLevel(history_in, lin_sampler, vec2f(t12.x, t0.y), 0.0) * (w12.x * w0.y)
    + textureSampleLevel(history_in, lin_sampler, t12, 0.0) * (w12.x * w12.y)
    + textureSampleLevel(history_in, lin_sampler, vec2f(t3.x, t12.y), 0.0) * (w3.x * w12.y)
    + textureSampleLevel(history_in, lin_sampler, vec2f(t12.x, t3.y), 0.0) * (w12.x * w3.y);
  // The corner taps are dropped: renormalise by the weight actually used.
  let s = r / (w0.x * w12.y + w12.x * w0.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y);
  return vec4f(min(tsr_scrub(s.rgb), vec3f(1.0)), clamp(select(s.a, 0.0, s.a != s.a), 0.0, 1.0));
}

/** Clip toward the box centre (Playdead): no hue snap at the corners. The epsilon on the extents keeps a flat axis from constraining. */
fn tsr_clip(center: vec3f, extents: vec3f, color: vec3f) -> vec3f {
  let dir = color - center;
  let scale = (extents + 1e-6) / max(abs(dir), vec3f(1e-6));
  return center + dir * min(1.0, min(scale.x, min(scale.y, scale.z)));
}

// The encoded render texels round an 8×8 group of display pixels. Below native (the only scales this runs at) the group's
// taps span at most 9 + 2 texels per axis (rounding is half to even), so every pixel reads its 3×3 from here instead of
// loading and encoding it.
var<workgroup> tile: array<vec3f, 121>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let out_res = frame_display_size();
  let in_res = frame_internal_size();
  let hi = vec2i(in_res) - 1;
  let origin = vec2i(round((vec2f(wid.xy * 8u) + 0.5) / out_res * in_res - 0.5 - tsr_jitter())) - 1;
  // Every invocation reaches the barrier (uniform control flow); bounds are checked afterwards.
  for (var k = li; k < 121u; k += 64u) {
    tile[k] = tsr_encode(textureLoad(scene_color, clamp(origin + vec2i(i32(k % 11u), i32(k / 11u)), vec2i(0), hi), 0).rgb);
  }
  workgroupBarrier();
  if (f32(gid.x) >= out_res.x || f32(gid.y) >= out_res.y) { return; }
  let at = vec2i(gid.xy);
  let uv = (vec2f(gid.xy) + 0.5) / out_res;
  let rc = min(vec2i(uv * in_res), hi);
  let motion = textureLoad(dilated_motion, rc, 0).xy;
  let mask = textureLoad(masks, rc, 0);
  let disocclusion = mask.r;
  let limit = max(tsr.control.z, 1.0);

  // History first: how much of it there is shapes this frame's kernel.
  let prev_uv = uv - motion;
  let lost = tsr.control.x > 0.5 || mask.g > 0.5 || !(all(prev_uv >= vec2f(0.0)) && all(prev_uv <= vec2f(1.0)));
  var history = vec4f(0.0);
  var lock = vec4f(0.0);
  if (!lost) {
    history = tsr_history(prev_uv);
    lock = textureSampleLevel(locks_in, lin_sampler, prev_uv, 0.0);
  }
  // What is remembered as reactive fades over about ten frames; the mask itself is immediate.
  let reactive = max(mask.b, lock.b - 0.1);
  // A pixel with little history is one aliased frame, a different one each jitter phase: widen its kernel toward a
  // smooth 3×3 mean (the sharpen pass leaves it alone too) until the accumulation has something to show. A reactive
  // pixel keeps little history by design, and its ray-marched noise must not be resolved into grain.
  let soft = max(tsr.tune.w * (1.0 - smoothstep(0.0, 0.25, history.a * (1.0 - disocclusion))), reactive);
  let kernel = mix(1.0, 0.5, soft);

  // This frame, upsampled: distances are to where the jittered samples actually landed. The kernel is separable, so
  // three weights per axis serve the nine taps.
  let src = uv * in_res - 0.5 - tsr_jitter();
  let base = vec2i(round(src));
  var wx: array<f32, 3>;
  var wy: array<f32, 3>;
  var sx: array<f32, 3>;
  var sy: array<f32, 3>;
  for (var k = 0; k < 3; k++) {
    let d = src - vec2f(clamp(base + vec2i(k - 1), vec2i(0), hi));
    wx[k] = lanczos2(d.x * kernel);
    wy[k] = lanczos2(d.y * kernel);
    sx[k] = lanczos2(d.x * 0.5);
    sy[k] = lanczos2(d.y * 0.5);
  }
  var sum = vec3f(0.0);
  var weight = 0.0;
  var smooth_sum = vec3f(0.0);
  var smooth_weight = 0.0;
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var lo = vec3f(1e5);
  var top = vec3f(-1e5);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let p = clamp(base + vec2i(x, y), vec2i(0), hi) - origin;
      let w = wx[x + 1] * wy[y + 1];
      let c = tile[p.y * 11 + p.x];
      sum += c * w;
      weight += w;
      let ws = sx[x + 1] * sy[y + 1];
      smooth_sum += c * ws;
      smooth_weight += ws;
      let ycc = tsr_ycocg(c);
      m1 += ycc;
      m2 += ycc * ycc;
      lo = min(lo, ycc);
      top = max(top, ycc);
    }
  }
  // Lanczos lobes go negative: dering by clamping into the local box.
  let current = tsr_rgb(clamp(tsr_ycocg(sum / max(weight, 1e-4)), lo, top));
  let mean = m1 / 9.0;
  if (lost) {
    textureStore(history_out, at, vec4f(current, 1.0 / limit));
    textureStore(locks_out, at, vec4f(0.0, 0.0, reactive, mean.x));
    return;
  }

  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let luma = tsr_ycocg(current).x;
  let contrast = top.x - lo.x;
  // Shading change: the neighbourhood's mean luma against the one remembered where this pixel was. The mean of nine
  // samples moves little with the jitter phase, so a step over its own spread is the light changing, not the lattice.
  let shift = smoothstep(1.0, 2.5, abs(mean.x - lock.a) / max(sigma.x, 0.012));
  // Whose history the vectors describe: not the passes without vectors, nor a page that was just re-committed, nor the
  // clouds. And what must not be relaxed besides those: a light that changed.
  let calm = (1.0 - reactive) * (1.0 - mask.a);
  let quiet = calm * (1.0 - shift);

  // The lock: a thin feature is a luminance outlier against its neighbourhood with real local contrast. While it holds
  // the lock grows and shields it from the clip that would otherwise drag it toward its surroundings.
  let feature = smoothstep(0.6, 2.0, abs(luma - mean.x) / max(sigma.x, 1e-3)) * smoothstep(0.02, 0.12, contrast) * quiet;
  let tracked = select(lock.g, luma, lock.r < 0.05);
  // Broken by a disocclusion or by a change against the lock's OWN luma (the neighbourhood mean always disagrees).
  let broken = smoothstep(max(contrast, 1e-3), max(contrast, 1e-3) * 2.0, abs(luma - tracked));
  let life = clamp((lock.r + select(-0.08, 0.5 * feature, feature > 0.1)) * (1.0 - disocclusion) * (1.0 - broken) * quiet, 0.0, 1.0) * tsr.tune.z;

  // Rectification. The box comes from ONE jitter phase's taps, so on fine content the converged mean lies outside some
  // phases' boxes and a still picture would be re-clipped for ever: where the clip has nothing to catch (no motion,
  // converged, nothing occluded, quiet) the box widens; any of those signals gives the pixel its full clip back.
  // The box is centred on this frame's upsample, not on the 3×3 mean: the mean is one value for every display pixel that
  // shares a render texel, so in motion, where the clip binds, a history drawn toward it turns into blocks.
  var count = history.a * limit;
  let still = tsr.look.y * (1.0 - smoothstep(0.05, 0.5, length(motion * in_res))) * clamp(count / limit, 0.0, 1.0) * (1.0 - disocclusion) * quiet;
  let old = tsr_ycocg(history.rgb);
  let centre = mix(tsr_ycocg(current), clamp(tsr_ycocg(smooth_sum / max(smooth_weight, 1e-4)), lo, top), tsr.look.x);
  let loose = tsr_clip(centre, sigma * (1.0 + life * 12.0 + still), old);
  // Pixels the vectors do not describe take the TAA's own rule instead: the 1σ box cut by the neighbourhood's range, and a
  // history weight that falls with how far the clip moved it. A plume has no vectors, so without that its old edges stay
  // in the box as dark filaments that no single frame contains.
  let tight = clamp(old, max(lo, mean - sigma), min(top, mean + sigma));
  let rectified = tsr_rgb(mix(loose, tight, 1.0 - calm));

  // A disocclusion discards the history's weight outright. There is deliberately no ageing of quiet pixels by how hard the
  // clip pulled: at any contrasty edge the converged history sits outside some phases' boxes.
  count = min(count * (1.0 - disocclusion), mix(limit, 1.0 / max(tsr.tune.y, 1e-3), 1.0 - quiet));
  let next = min(count + 1.0, limit);
  // Confidence in this frame's sample: 1 when a jittered sample landed on this display pixel, less between samples.
  let confidence = clamp(1.0 - length(src - vec2f(base)), 0.25, 1.0);
  var alpha = max(clamp(confidence / next, 1.0 / limit, 1.0) * (1.0 - 0.7 * life), 0.5 / limit);
  // A disoccluded pixel takes the current frame alone, as in FSR 2: the clipped old colour would pass a translucent copy
  // of whatever just moved away over a busy background.
  alpha = max(max(alpha, disocclusion), max((1.0 - quiet) * tsr.tune.y, (1.0 - calm) * clamp(length(old - tight) * 8.0, 0.0, 1.0)));
  textureStore(history_out, at, vec4f(tsr_scrub(mix(rectified, current, alpha)), next / limit));
  textureStore(locks_out, at, vec4f(life, tracked, reactive, mean.x));
}
`, [common]);

/**
 * Pass 4, display resolution: sharpen (FSR 1 RCAS with the FSR 3.1.5 limiter) and leave the tonemap space. The history is
 * sharpened in its bounded range (the range the limiter's math assumes) and the conditioning is undone once on the result,
 * capped at what the same lobe gives in linear space so a bright edge cannot invert into a firefly. Also the debug views.
 */
export const tsrSharpenWgsl = makeModule('tsr-sharpen', /* wgsl */ `
@group(1) @binding(1) var history: texture_2d<f32>;
@group(1) @binding(2) var color_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var dilated_motion: texture_2d<f32>;
@group(1) @binding(4) var masks: texture_2d<f32>;
@group(1) @binding(5) var locks: texture_2d<f32>;

fn tsr_tap(p: vec2i) -> vec3f {
  return textureLoad(history, clamp(p, vec2i(0), vec2i(frame_display_size()) - 1), 0).rgb;
}

fn tsr_debug(at: vec2i) -> vec3f {
  let rc = min(vec2i((vec2f(at) + 0.5) / frame_display_size() * frame_internal_size()), vec2i(frame_internal_size()) - 1);
  let view = u32(tsr.control.w);
  let k = textureLoad(masks, rc, 0);
  if (view == 1u) { return vec3f(0.5 - textureLoad(dilated_motion, rc, 0).xy * 60.0, 0.0); }
  if (view == 2u) { return vec3f(k.r, k.g, k.a); }
  if (view == 3u) { let l = textureLoad(locks, at, 0); return vec3f(l.r, l.r * 0.5, 0.05); }
  if (view == 4u) { let age = textureLoad(history, at, 0).a; return vec3f(1.0 - age, age, 0.0); }
  return vec3f(k.b, textureLoad(locks, at, 0).b, k.a);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let res = frame_display_size();
  if (f32(gid.x) >= res.x || f32(gid.y) >= res.y) { return; }
  let at = vec2i(gid.xy);
  let exposure = max(frame.exposure, 1e-4);
  if (tsr.control.w > 0.5) {
    textureStore(color_out, at, vec4f(tsr_debug(at) / exposure, 1.0));
    return;
  }
  let centre = textureLoad(history, at, 0);
  let e = centre.rgb;
  if (tsr.control.y <= 0.0) {
    textureStore(color_out, at, vec4f(tsr_scrub(tsr_untonemap(e) / exposure), 1.0));
    return;
  }
  //   b
  // d e f
  //   h
  let b = tsr_tap(at + vec2i(0, -1));
  let d = tsr_tap(at + vec2i(-1, 0));
  let f = tsr_tap(at + vec2i(1, 0));
  let h = tsr_tap(at + vec2i(0, 1));
  // FSR's inexpensive luma is scaled by two; the scale cancels in the ratio.
  let lw = vec3f(0.5, 1.0, 0.5);
  // The ring's min and max per channel bound how strong the negative lobe may be before the output would leave the
  // local contrast. The divisions are guarded: a black ring is 0 / 0 in the reference, and a NaN here is a NaN on screen.
  let mn = min(min(b, d), min(f, h));
  let mx = max(max(b, d), max(f, h));
  let lower = clamp(dot(e, lw) / max(min(min(dot(b, lw), dot(d, lw)), min(dot(f, lw), dot(h, lw))), 1e-6), 0.0, 1.0);
  let hit = max(-(mn / (4.0 * max(mx, vec3f(1e-6))) * lower), (vec3f(1.0) - mx) / min(4.0 * mn - 4.0, vec3f(-1e-4)));
  // sharpness 1 = no attenuation, 0 = two stops. A young pixel is one aliased frame: sharpening it sharpens the crawl,
  // and a reactive one is ray-marched noise the TAA would have left soft.
  let settled = mix(1.0, smoothstep(0.0, 0.5, centre.a), tsr.tune.w) * (1.0 - textureLoad(locks, at, 0).b);
  let lobe = max(-0.1875, min(max(hit.r, max(hit.g, hit.b)), 0.0)) * exp2(-2.0 * (1.0 - tsr.control.y)) * settled;
  let rcp = 1.0 / (4.0 * lobe + 1.0);
  let sharp = (lobe * (b + d + h + f) + e) * rcp;
  // Undo the conditioning once, capped at the same lobe applied in linear space against the darkest ring tap: the
  // conditioned range ends at linear infinity, so near 1 the limiter above bounds nothing in linear terms.
  let e_lin = tsr_untonemap(e);
  let ceiling = e_lin - 4.0 * lobe * rcp * max(e_lin - tsr_untonemap(max(mn, vec3f(0.0))), vec3f(0.0));
  textureStore(color_out, at, vec4f(tsr_scrub(min(tsr_untonemap(max(sharp, vec3f(0.0))), ceiling) / exposure), 1.0));
}
`, [common]);

export function tsrShaders() {
  return { veil: link(tsrVeilWgsl), reconstruct: link(tsrReconstructWgsl), mask: link(tsrMaskWgsl), accumulate: link(tsrAccumulateWgsl), sharpen: link(tsrSharpenWgsl) };
}
