/** Articulated twin-gun demonstrator. Cosmetic preview until interceptable targets exist. */
import { alongZ, box, cylinder, lathe, mm, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, socketFrame } from './common';

export const POINT_DEFENSE_SPEC: UtilitySpec = {
  id: 'point_defense', name: 'Point-defense preview', head: 'pitch', headOrigin: [0, 0.15, 0], sight: 0,
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};
function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx);
  s.tag = 'periscope-housing';
  s.material(MAT_ID.paint);
  box(s, mm(m, tr(0, 0.018, 0)), [0.085, 0.036, 0.085], 0.007);
  cylinder(s, m, [0, 0.036, 0], [0, 0.13, 0], 0.024, 12);
  if (s.coarse) return; // A subpixel module retains its pedestal silhouette only.
  for (const side of [-1, 1]) box(s, mm(m, tr(side * 0.047, 0.126, 0)), [0.012, 0.062, 0.045], 0.004);
  const h = out.get('head');
  h.tag = 'defense-head';
  h.material(MAT_ID.gunmetal);
  // Inset the central housing 2 mm beneath the receiver covers, keeping the
  // outer envelope clear of the fixed support cheeks throughout elevation.
  box(h, tr(0, 0, -0.004), [0.076, 0.042, 0.055], 0.005);
  for (const side of [-1, 1]) {
    cylinder(h, null, [side * 0.037, 0, 0], [side * 0.052, 0, 0], 0.017, 10);
    const m = alongZ(side * 0.025, 0, 0);
    lathe(h, m, [[0.013, 0.022], [0.01, 0.115], [0.006, 0.115], [0.006, 0.022], [0.013, 0.022]], 12, { caps: [false, false], hullProfile: [[0.013, 0.022], [0.01, 0.115]] });
    if (h.fine) {
      // Separate receiver/feed housings and open cooling jackets make these read
      // as mechanically mounted guns instead of two featureless metal rods.
      h.material(MAT_ID.paint);
      box(h, tr(side * 0.026, 0, -0.026), [0.028, 0.041, 0.048], 0.004);
      h.material(MAT_ID.darkSteel);
      box(h, tr(side * 0.025, 0.025, -0.018), [0.023, 0.007, 0.04], 0);
      lathe(h, m, [[0.01, 0.068], [0.015, 0.068], [0.015, 0.078], [0.01, 0.078], [0.01, 0.068]], 8, { caps: [false, false], hullProfile: null });
      h.material(MAT_ID.gunmetal);
    }
  }
  h.material(MAT_ID.darkSteel);
  box(h, tr(0, 0.031, 0), [0.034, 0.027, 0.034], 0.004);
  h.material(MAT_ID.glass);
  cylinder(h, null, [0, 0.032, 0.017], [0, 0.032, 0.02], 0.009, 10);
  if (h.fine) {
    h.material(MAT_ID.darkSteel);
    box(h, tr(0, -0.024, -0.009), [0.046, 0.012, 0.033], 0.002);
  }
}
export const POINT_DEFENSE: PartModule<UtilitySpec> = { spec: POINT_DEFENSE_SPEC, build };
