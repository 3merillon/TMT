/**
 * Rail lance: paired machined rails around a recessed bore, clamped by seven
 * accelerator cassettes with copper feeds, insulated seats and exposed energy gaps.
 * The complete launch assembly recoils; its established muzzle and pulse stations stay fixed.
 */
import { EDGE, alongZ, box, lathe, loft, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, WeaponSpec } from '../types';
import { sleeve, tube, tubeStart } from './common';

export const RAIL_SPEC: WeaponSpec = {
  id: 'rail', name: 'Rail lance',
  barrelLength: 1.4, recoilTravel: 0.14, tubeRadius: 0.042, boreRadius: 0.026,
  sleeveRadius: 0.08, sleeveEnd: 0.3,
  stats: { cost: 5, mass: 3.6, tempo: 1.1, minSpeed: 2.8, maxSpeed: 23, blastRadius: 2.0, damage: 88, recoil: 4.2 },
  massBoxes: [{ center: [0, 0, 0.6], half: [0.06, 0.06, 0.7], fraction: 1 }],
};

export const RAIL_COILS = Object.freeze({ from: 0.44, to: 1.2, count: 7, radius: 0.068, width: 0.035 });

function build(ctx: KitContext, out: GroupShapes): void {
  const w = ctx.weapon, z0 = tubeStart(w), L = w.barrelLength;
  sleeve(out.get('cradle'), ctx);
  const s = out.get('barrel');
  tube(s, w, [[0.03, z0], [0.042, z0 + 0.01], [0.042, 0.3], [0.032, 0.34], [0.032, L - 0.07], [0.039, L]], 12,
    [{ from: 0.3, to: L - 0.07, mat: MAT_ID.darkSteel }, { from: L - 0.07, to: L, mat: MAT_ID.brass }]);
  const { from, to, count, width } = RAIL_COILS;
  if (s.coarse) {
    s.material(MAT_ID.gunmetal);
    for (const side of [-1, 1]) box(s, tr(side * 0.047, 0, 0.86), [0.022, 0.04, 1.02], 0);
    return;
  }
  // Long forged rail sections: bevelled shoulders, a thick breech root and a
  // clipped emitter end. Air gaps remain visible alongside the central bore.
  s.tag = 'rails';
  s.material(MAT_ID.gunmetal);
  for (const side of [-1, 1]) {
    const ring = (z: number, scale: number): Vec3[] => [[-0.012, -0.021], [0.006, -0.027], [0.014, -0.017], [0.014, 0.017], [0.006, 0.027], [-0.012, 0.021]].map(([x, y]) => [side * (0.045 + x * scale), y * scale, z]);
    loft(s, null, [ring(0.33, 0.78), ring(0.37, 1), ring(L - 0.06, 1), ring(L - 0.012, 0.64)], { edges: [EDGE.chamfer, EDGE.none, EDGE.chamfer] });
    s.material(MAT_ID.chrome);
    box(s, tr(side * 0.038, 0, 0.86), [0.007, 0.032, 0.99], 0);
    s.material(MAT_ID.gunmetal);
  }
  for (let i = 0; i < count; i++) {
    const z = from + (to - from) * i / (count - 1);
    s.tag = 'coil';
    for (const side of [-1, 1]) {
      // Insulated cross straps bridge the two rails above/below the bore; their
      // inset copper bus is distinct from the steel spine and emissive window.
      s.material(MAT_ID.paint);
      box(s, tr(0, side * 0.049, z), [0.082, 0.017, width], 0);
      if (s.fine) {
        s.material(MAT_ID.brass);
        box(s, tr(0, side * 0.059, z), [0.057, 0.006, width * 0.75], 0);
      }
      s.material(MAT_ID.signal);
      // Surface windows avoid hidden box faces on the ribbed heat spine.
      const y = side * (s.fine ? 0.0622 : 0.0578);
      s.mb.poly([[-0.016, y, z - width * 0.22], [0.016, y, z - width * 0.22], [0.016, y, z + width * 0.22], [-0.016, y, z + width * 0.22]], EDGE.rim, [0, side, 0]);
    }
  }
  s.tag = 'emitter';
  s.material(MAT_ID.darkSteel);
  lathe(s, alongZ(0, 0, 0), [[0.034, L - 0.065], [0.049, L - 0.065], [0.049, L - 0.039], [0.034, L - 0.039], [0.034, L - 0.065]], 12, { caps: [false, false], hullProfile: [[0.049, L - 0.065], [0.049, L - 0.039]] });
}

export const RAIL: PartModule<WeaponSpec> = { spec: RAIL_SPEC, build };
