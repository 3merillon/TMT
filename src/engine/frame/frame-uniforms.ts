/** Packs FrameState + engine extras into the 512 B FrameUniforms block (layout: wgsl/common/frame.wgsl.ts). */
import type { FrameState, QualityTier } from '../contracts';
import { FRAME_UNIFORMS, FRAME_UNIFORMS_SIZE } from '../wgsl/common/frame.wgsl';

export const TIER_INDEX: Record<QualityTier, number> = { low: 0, medium: 1, high: 2, ultra: 3 };

export interface FrameUniformExtras {
  sunRadiance: [number, number, number];
  exposure: number;
  prevJitter: [number, number];
  planet: { center: [number, number, number]; radius: number; seaRadius: number };
  renderScale: number;
}

export function packFrameUniforms(f: FrameState, x: FrameUniformExtras, out: ArrayBuffer = new ArrayBuffer(FRAME_UNIFORMS_SIZE)): ArrayBuffer {
  return FRAME_UNIFORMS.pack({
    view: f.view, proj: f.proj, view_proj: f.viewProj, inv_view_proj: f.invViewProj,
    prev_view_proj: f.prevViewProj, view_proj_nojitter: f.viewProjNoJitter,
    eye_pos: f.eye, time: f.time,
    sun_dir: f.sunDir, dt: f.dt,
    sun_radiance: x.sunRadiance, exposure: x.exposure,
    jitter: f.jitter, prev_jitter: x.prevJitter,
    viewport: [f.internal[0], f.internal[1], f.display[0], f.display[1]],
    planet: [...x.planet.center, x.planet.radius],
    focus: [...f.focus.world, f.focus.distance],
    misc: [f.index, x.renderScale, TIER_INDEX[f.tier], x.planet.seaRadius],
  }, out);
}
