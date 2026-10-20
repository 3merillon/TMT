/**
 * Radar mast (W1-KIT): a mast with a gearbox (rigid) and a spinning array head (spin joint about +Y).
 * The array's swept circle stays behind the mantlet and above the roof.
 */
import { bolts, box, cylinder, lathe, mm, rx, sweep, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, socketFrame } from './common';

export const RADAR_SPEC: UtilitySpec = {
  id: 'radar', name: 'Dish radar', head: 'spin', headOrigin: [0, 0.2, 0], sight: 0,
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};
export const RADAR_ARRAY = Object.freeze({ halfWidth: 0.12, height: 0.07, depth: 0.03 });

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx);
  s.tag = 'radar-mast';
  s.material(MAT_ID.darkSteel);
  box(s, mm(m, tr(0, 0.015, 0)), [0.07, 0.03, 0.07], 0.008);
  s.material(MAT_ID.gunmetal);
  cylinder(s, m, [0, 0.03, 0], [0, 0.19, 0], 0.016, 10);
  s.material(MAT_ID.darkSteel);
  cylinder(s, m, [0, 0.17, 0], [0, 0.198, 0], 0.028, 12);
  if (s.fine) {
    bolts(s, m, [[-0.023, 0.031, -0.023], [0.023, 0.031, -0.023], [-0.023, 0.031, 0.023], [0.023, 0.031, 0.023]], [0, 1, 0], 0.005, 0.003);
    // Drive motor and protected cable to the rotary gearbox.
    box(s, mm(m, tr(0.024, 0.14, 0)), [0.024, 0.042, 0.032], 0.003);
    s.material(MAT_ID.rubber);
    sweep(s, m, [[0.023, 0.035, -0.019], [0.027, 0.12, -0.019], [0.018, 0.176, -0.012]], 0.004, 6);
  }
  if (s.detail <= 0.3) return;
  const h = out.get('head');
  h.tag = 'radar-head';
  h.material(MAT_ID.gunmetal);
  cylinder(h, null, [0, 0.0, 0], [0, 0.09, 0.015], 0.014, 8);
  cylinder(h, null, [-0.032, 0.1, 0.015], [0.032, 0.1, 0.015], 0.017, 8);
  // The service gearbox cover is an accessible flat pickup surface. Its two
  // backframe brackets carry it into the elevation hinge, clear of the aperture.
  h.material(MAT_ID.paint);
  box(h, tr(0, 0.23, -0.018), [0.1, 0.012, 0.07], 0.003);
  for (const side of [-1, 1]) cylinder(h, null, [side * 0.03, 0.1, 0.015], [side * 0.039, 0.225, -0.018], 0.006, 6, { smooth: false });
  // The aperture faces the horizon (+z), on an upright bowl carried by the rear
  // hinge. Only the head rotates around the pedestal's vertical yaw spindle.
  const face = mm(tr(0, 0.1, 0), rx(Math.PI / 2));
  const w = RADAR_ARRAY.halfWidth;
  h.material(MAT_ID.paint);
  lathe(h, face, [[0, 0.018], [w * 0.55, 0.025], [w, 0.043], [w, 0.053], [w * 0.6, 0.042], [0, 0.037]], 24, { caps: [false, false], hullProfile: [[w, 0.018], [w, 0.053]] });
  h.material(MAT_ID.darkSteel);
  if (h.fine) {
    // Four radial rear ribs carry the thin dish skin into the elevation hinge.
    for (let i = 0; i < 4; i++) {
      const a = (i + 0.5) * Math.PI / 2;
      const p: Vec3 = [Math.cos(a) * w * 0.94, 0.037, Math.sin(a) * w * 0.94];
      cylinder(h, face, [0, 0.012, 0], p, 0.005, 6, { smooth: false });
    }
    cylinder(h, null, [0.025, 0.025, -0.006], [0.033, 0.087, 0.002], 0.008, 6);
    h.material(MAT_ID.chrome);
    cylinder(h, null, [0.033, 0.087, 0.002], [0.035, 0.113, 0.018], 0.004, 6);
    h.material(MAT_ID.darkSteel);
  }
  cylinder(h, face, [0, 0.035, 0], [0, 0.087, 0], 0.007, 8);
  box(h, mm(face, tr(0, 0.087, 0.019)), [0.022, 0.016, 0.05], 0.003);
  h.material(MAT_ID.signal);
  h.with({ cosmetic: true, noHull: true }, () => box(h, mm(face, tr(0, 0.087, 0.045)), [0.013, 0.009, 0.004], 0));
}

export const RADAR: PartModule<UtilitySpec> = { spec: RADAR_SPEC, build };
