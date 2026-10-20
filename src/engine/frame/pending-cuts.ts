/**
 * Pending cuts (FrameInput.pendingCuts, ≤ 8) uploaded every frame into the reserved binding 'pendingCuts', so the
 * terrain VS (W1-ENG-SCENE) and grass (W2-VEG) can read them without owning the upload. A material crater
 * (rust-engine-v22) contributes one sphere per shell; a plain cut one sphere with mask 0 (every material).
 *   struct PendingCuts { count: vec4u, spheres: array<vec4f, 8> (centre xyz, radius), t0: array<vec4f, 2> (8 start times),
 *                        masks: array<vec4u, 2> (8 material masks, bit 1<<id; 0 = every material) }
 */
import type { FrameInput } from '../contracts';
import { makeModule, wgslStruct } from '../wgsl/module';

export const MAX_PENDING_CUTS = 8;

export const PENDING_CUTS = wgslStruct('PendingCuts', [
  ['count', 'vec4u'],
  ['spheres', { array: 'vec4f', count: MAX_PENDING_CUTS }],
  ['t0', { array: 'vec4f', count: MAX_PENDING_CUTS / 4 }],
  ['masks', { array: 'vec4u', count: MAX_PENDING_CUTS / 4 }],
]);

export const pendingCutsWgsl = makeModule('pending-cuts', /* wgsl */ `
fn pending_cut_t0(cuts: PendingCuts, i: u32) -> f32 { return cuts.t0[i / 4u][i % 4u]; }
// Whether pending sphere i carves the terrain material id (mask 0: every material).
fn pending_cut_carves(cuts: PendingCuts, i: u32, material: u32) -> bool {
  let mask = cuts.masks[i / 4u][i % 4u];
  return mask == 0u || (material < 32u && ((mask >> material) & 1u) == 1u);
}
`, [PENDING_CUTS.module]);

/** Pack up to MAX_PENDING_CUTS spheres, oldest cut first. A cut whose spheres no longer fit is dropped whole, the newest
 *  cuts kept first (the pending crater is cosmetic, I4). */
export function packPendingCuts(cuts: FrameInput['pendingCuts'], out: ArrayBuffer = new ArrayBuffer(PENDING_CUTS.size)): ArrayBuffer {
  const kept: FrameInput['pendingCuts'][number][] = []; let used = 0;
  for (let i = cuts.length - 1; i >= 0; i--) { const size = cuts[i].shells?.length ?? 1; if (used + size > MAX_PENDING_CUTS) continue; used += size; kept.unshift(cuts[i]); }
  const spheres: number[] = []; const t0: number[] = []; const masks: number[] = [];
  for (const cut of kept) for (const s of cut.shells ?? [{ materials: 0, center: cut.center, radius: cut.radius }]) { spheres.push(...s.center, s.radius); t0.push(cut.t0); masks.push(s.materials >>> 0); }
  new Uint8Array(out).fill(0);
  return PENDING_CUTS.pack({ count: [used, 0, 0, 0], spheres, t0, masks }, out);
}
