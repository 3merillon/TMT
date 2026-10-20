/**
 * Spotter periscope (W1-KIT): an armoured housing (rigid) with a head that pitches to follow the gun
 * (pitch joint about +X, clamped to its own range) and a glass window.
 */
import { EDGE, alongZ, bolts, box, cylinder, lathe, loft, mm, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { DEG } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, mastCable, serviceBase, socketFrame } from './common';

export const PERISCOPE_SPEC: UtilitySpec = {
  id: 'periscope', name: 'Spotter periscope', head: 'pitch', headOrigin: [0, 0.075, 0], sight: 6,
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};
/** Head pitch range (follows the gun inside it). */
export const PERISCOPE_RANGE = Object.freeze([-10 * DEG, 30 * DEG] as const);

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx);
  s.tag = 'periscope-housing';
  serviceBase(s, m, .041);
  s.material(MAT_ID.paint);
  box(s, mm(m, tr(0, .039, 0)), [.068, .032, .070], .008);
  s.material(MAT_ID.darkSteel);
  cylinder(s, m, [0, 0.06, 0], [0, 0.072, 0], 0.03, 12);
  for (const side of [-1, 1]) {
    s.material(MAT_ID.paint); box(s, mm(m, tr(side * .039, .065, 0)), [.010, .039, .030], .003);
    s.material(MAT_ID.brass); cylinder(s, m, [side * .035, .075, 0], [side * .049, .075, 0], .009, 8);
  }
  mastCable(s, m, .055, -1);
  if (s.detail <= 0.3) return;
  const h = out.get('head');
  h.tag = 'periscope-head';
  h.material(MAT_ID.paint);
  // Wedge-shaped head, window facing +z.
  const a: Vec3[] = [[-0.035, 0.0, -0.03], [0.035, 0.0, -0.03], [0.035, 0.0, 0.03], [-0.035, 0.0, 0.03]];
  const b: Vec3[] = [[-0.032, 0.06, -0.026], [0.032, 0.06, -0.026], [0.032, 0.05, 0.036], [-0.032, 0.05, 0.036]];
  loft(h, null, [a, b], { edges: [EDGE.soft], capEdge: EDGE.chamfer });
  h.material(MAT_ID.glass);
  h.with({ cosmetic: true, noHull: true }, () => box(h, tr(0, 0.028, 0.034), [0.05, 0.03, 0.004], 0));
  if (h.fine) {
    h.material(MAT_ID.darkSteel);
    box(h, tr(0, .053, .032), [.066, .007, .031], .002);
    lathe(h, alongZ(0, .028, .036), [[.016, 0], [.016, .009], [.011, .010], [.011, 0], [.016, 0]], 12, { caps: [false, false], hullProfile: null });
    h.material(MAT_ID.chrome); bolts(h, null, [[-.025, .049, -.010], [.025, .049, -.010]], [0, 1, 0], .003, .002);
  }
}

export const PERISCOPE: PartModule<UtilitySpec> = { spec: PERISCOPE_SPEC, build };
