/**
 * Reversed-Z infinite depth helpers (plan §4.4). depth d ∈ (0, 1]: d = near / viewDistance, d = 0 at infinity (sky).
 *
 * Position reconstruction goes through the (jittered) projection's scale/shift terms and the rigid inverse of `view`,
 * not through a 4×4 inverse: this is exact for the jittered raster (jitter-consistent — Pinionfall's receiver drift came
 * from reconstructing with an unjittered inverse) and keeps f32 precision at depth ≈ 1e-3.
 * uv: [0,1]² with the origin at the top-left pixel corner (WebGPU framebuffer convention).
 */
import { makeModule } from '../module';
import { frameWgsl } from './frame.wgsl';

export const depthWgsl = makeModule('depth', /* wgsl */ `
fn linear_depth(d: f32) -> f32 { return frame_near() / max(d, 1e-30); }

fn uv_to_ndc(uv: vec2f) -> vec2f { return vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0); }
fn ndc_to_uv(ndc: vec2f) -> vec2f { return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5); }

/** View-space direction (z = -1 plane) through a uv, honouring off-centre shift and jitter. */
fn view_ray_from_uv(uv: vec2f) -> vec3f {
  let ndc = uv_to_ndc(uv);
  return vec3f((ndc.x + frame.proj[2][0]) / frame.proj[0][0], (ndc.y + frame.proj[2][1]) / frame.proj[1][1], -1.0);
}

fn view_pos_from_depth(uv: vec2f, d: f32) -> vec3f {
  return view_ray_from_uv(uv) * linear_depth(d);
}

/** Rigid inverse of the view matrix: world = Rᵀ (v − t). */
fn view_to_world(v: vec3f) -> vec3f {
  let r = mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
  return transpose(r) * (v - frame.view[3].xyz);
}
fn view_dir_to_world(v: vec3f) -> vec3f {
  let r = mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
  return transpose(r) * v;
}

fn world_pos_from_depth(uv: vec2f, d: f32) -> vec3f {
  return view_to_world(view_pos_from_depth(uv, d));
}

/** Unit world direction of the pixel ray (sky, depth = 0). */
fn world_dir_from_uv(uv: vec2f) -> vec3f {
  return normalize(view_dir_to_world(view_ray_from_uv(uv)));
}
`, [frameWgsl]);
