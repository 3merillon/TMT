/**
 * FrameUniforms — the one per-frame uniform block (plan §5.4), 512 B, always at @group(0) @binding(0).
 *
 * 6 matrices (384 B) + 8 vec4 (128 B). To fit the plan's field list into 512 B two members share storage:
 * - `viewport` holds both the internal (xy) and display (zw) sizes (the plan lists viewport and display separately);
 * - `near_proj` is folded into `proj`: near = proj[3][2] (reversed-Z infinite, proj[2][2] = 0), and the projection scale
 *   and off-centre/jitter shift are proj[0][0], proj[1][1], proj[2][0], proj[2][1]. Use the helpers below.
 * The struct, its size and the TS packer come from one field list (wgslStruct), and a test asserts size === 512.
 */
import { makeModule, wgslStruct } from '../module';

export const FRAME_UNIFORMS = wgslStruct('FrameUniforms', [
  ['view', 'mat4x4f'],
  ['proj', 'mat4x4f'],                 // jittered, reversed-Z infinite
  ['view_proj', 'mat4x4f'],            // jittered (raster)
  ['inv_view_proj', 'mat4x4f'],        // inverse of the jittered view_proj
  ['prev_view_proj', 'mat4x4f'],       // previous frame, unjittered
  ['view_proj_nojitter', 'mat4x4f'],
  ['eye_pos', 'vec3f'], ['time', 'f32'],
  ['sun_dir', 'vec3f'], ['dt', 'f32'],             // unit vector TOWARD the sun
  ['sun_radiance', 'vec3f'], ['exposure', 'f32'],  // rgb × illuminance (20 = reference sun)
  ['jitter', 'vec2f'], ['prev_jitter', 'vec2f'],   // NDC offsets
  ['viewport', 'vec4f'],               // internal w, h, display w, h (device px)
  ['planet', 'vec4f'],                 // centre xyz, radius
  ['focus', 'vec4f'],                  // xyz, distance
  ['misc', 'vec4f'],                   // frame index, render scale, tier (0 low .. 3 ultra), sea radius
]);

export const FRAME_UNIFORMS_SIZE = FRAME_UNIFORMS.size;

/** The struct alone (for shaders that bind the frame block elsewhere). */
export const frameStructWgsl = FRAME_UNIFORMS.module;

/** Struct + the binding at @group(0) @binding(0) + accessors. */
export const frameWgsl = makeModule('frame', /* wgsl */ `
@group(0) @binding(0) var<uniform> frame: FrameUniforms;

fn frame_near() -> f32 { return frame.proj[3][2]; }
fn frame_internal_size() -> vec2f { return frame.viewport.xy; }
fn frame_display_size() -> vec2f { return frame.viewport.zw; }
fn frame_index() -> u32 { return u32(frame.misc.x); }
fn frame_render_scale() -> f32 { return frame.misc.y; }
fn frame_tier() -> u32 { return u32(frame.misc.z); }
fn frame_sea_radius() -> f32 { return frame.misc.w; }
`, [frameStructWgsl]);
