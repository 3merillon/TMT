/** Compact high velocity cannon: fast recovery, narrow blast and a light perforated shroud. */
import { alongZ, box, lathe, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, WeaponSpec } from '../types';
import { sleeve, tube, tubeStart } from './common';

export const AUTOCANNON_SPEC: WeaponSpec = {
  id: 'autocannon', name: 'Scout autocannon',
  barrelLength: 0.9, recoilTravel: 0.065, tubeRadius: 0.035, boreRadius: 0.02,
  sleeveRadius: 0.055, sleeveEnd: 0.28,
  stats: { cost: 3, mass: 1.5, tempo: 0.72, minSpeed: 2.2, maxSpeed: 19, blastRadius: 1.25, damage: 48, recoil: 1.5 },
  massBoxes: [{ center: [0, 0, 0.36], half: [0.045, 0.045, 0.45], fraction: 1 }],
};
function build(ctx: KitContext, out: GroupShapes): void {
  const w = ctx.weapon, z0 = tubeStart(w), s = out.get('barrel');
  sleeve(out.get('cradle'), ctx);
  tube(s, w, [[0.027, z0], [0.035, z0 + 0.018], [0.035, 0.3], [0.028, 0.34], [0.026, 0.8], [0.033, 0.82], [0.033, 0.9]], 18,
    [{ from: 0.34, to: 0.8, mat: MAT_ID.darkSteel }, { from: 0.82, to: 0.9, mat: MAT_ID.brass }]);
  if (s.coarse) return;
  s.material(MAT_ID.paint);
  s.tag = 'cooling-shroud';
  // Two rails and annular collars form a ventilated guard without closing the barrel.
  for (const side of [-1, 1]) box(s, tr(side * 0.041, 0, 0.47), [0.01, 0.024, 0.35], 0);
  for (const z of [0.31, 0.46, 0.62]) lathe(s, alongZ(0, 0, 0), [[0.044, z], [0.044, z + 0.017], [0.035, z + 0.017], [0.035, z], [0.044, z]], 12, { caps: [false, false], hullProfile: [[0.044, z], [0.044, z + 0.017]] });
}
export const AUTOCANNON: PartModule<WeaponSpec> = { spec: AUTOCANNON_SPEC, build };
