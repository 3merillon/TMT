// Ported from Pinionfall src/gpu/fullscreen-quad.ts (MIT, same owner)
/**
 * Shared fullscreen triangle for post-process render passes: one oversized triangle (3 vertices, no buffers) covering
 * the screen; UVs derive from the vertex position (y flipped for texture sampling, origin top-left).
 */
import { makeModule } from '../wgsl/module';

export const fullscreenWgsl = makeModule('fullscreen', /* wgsl */ `
struct FullscreenOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FullscreenOut {
  // Oversized triangle: (-1,-1), (3,-1), (-1,3)
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  var out: FullscreenOut;
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
  return out;
}
`);

/** Draw the fullscreen triangle (between beginRenderPass / end). */
export function drawFullscreenTriangle(pass: GPURenderPassEncoder): void {
  pass.draw(3, 1, 0, 0);
}
