/**
 * Pending (announced, not yet committed) terrain cuts, presentation side (plan §4.7). The engine core packs and uploads
 * `FrameInput.pendingCuts` into the reserved binding `pendingCuts` (frame/pending-cuts.ts); this set decides WHICH cuts
 * are pending: added on impact, removed when their commit (or any full terrain replacement) lands, capped at 8 (the
 * oldest is dropped first — the cosmetic crater is never gameplay, I4), and expired after `maxAge` seconds so a lost
 * commit event can never leave a phantom crater.
 */
import { MAX_PENDING_CUTS } from '../frame/pending-cuts';

export type Vec3 = [number, number, number];
/** Seconds a pending crater takes to open: its radius eases out from nothing, so the bowl (and everything carved from
 *  it: the SDF's AO and shadows, the water's bed) grows with the blast instead of appearing whole in the impact frame. */
export const PENDING_CUT_GROW = 0.22;
/** The share of a pending cut's radius `age` seconds after its announcement (ease-out cubic). */
export function pendingCutGrowth(age: number): number {
  const t = Math.min(Math.max(age / PENDING_CUT_GROW, 0), 1);
  return Math.max(0.01, 1 - (1 - t) ** 3);
}
export interface PendingShell { readonly materials: number; readonly center: Vec3; readonly radius: number }
export interface PendingCutEntry { readonly id: string; readonly center: Vec3; readonly radius: number; readonly t0: number; readonly shells?: readonly PendingShell[] }

export class PendingCutSet {
  private cuts: PendingCutEntry[] = [];
  constructor(private readonly maxAge = 8) {}

  /** Add (or replace by id) a pending cut announced at time t0 (seconds, the frame clock); `shells` are a material
   *  crater's spheres (rust-engine-v22), bounded by `center`/`radius`. */
  add(id: string, center: readonly number[], radius: number, t0: number, shells?: readonly { materials: number; center: readonly number[]; radius: number }[]): void {
    if (center.length !== 3 || ![...center, radius, t0].every(Number.isFinite) || !(radius > 0)) return;
    if (shells && (!shells.length || shells.length > MAX_PENDING_CUTS || !shells.every(s => s.center.length === 3 && [...s.center, s.radius].every(Number.isFinite) && s.radius > 0))) return;
    this.cuts = this.cuts.filter(c => c.id !== id);
    this.cuts.push({ id, center: [center[0], center[1], center[2]], radius, t0, ...(shells ? { shells: shells.map(s => ({ materials: s.materials >>> 0, center: [s.center[0], s.center[1], s.center[2]] as Vec3, radius: s.radius })) } : {}) });
    while (this.cuts.length > MAX_PENDING_CUTS) this.cuts.shift();
  }
  /** Remove the cuts a commit published (all of them when `ids` is omitted). */
  commit(ids?: readonly string[]): PendingCutEntry[] {
    const removed = ids ? this.cuts.filter(c => ids.includes(c.id)) : this.cuts;
    this.cuts = ids ? this.cuts.filter(c => !ids.includes(c.id)) : [];
    return removed;
  }
  clear(): void { this.cuts = []; }
  /** Drop expired cuts; returns the live list (≤ 8, oldest first). */
  live(now: number): readonly PendingCutEntry[] {
    if (this.cuts.some(c => now - c.t0 > this.maxAge)) this.cuts = this.cuts.filter(c => now - c.t0 <= this.maxAge);
    return this.cuts;
  }
  get size(): number { return this.cuts.length; }
  /** FrameInput.pendingCuts shape, each radius grown by its age (pendingCutGrowth). */
  frameInput(now: number): { center: Vec3; radius: number; t0: number; shells?: PendingShell[] }[] {
    return this.live(now).map(c => { const g = pendingCutGrowth(now - c.t0); return { center: [...c.center] as Vec3, radius: c.radius * g, t0: c.t0,
      ...(c.shells ? { shells: c.shells.map(s => ({ materials: s.materials, center: [...s.center] as Vec3, radius: s.radius * g })) } : {}) }; });
  }
}
