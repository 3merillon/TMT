/** Furnace siege mortar: a deep bell muzzle, vented heat jacket and paired steam-return lines. */
import { alongZ, box, lathe, sweep, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, WeaponSpec } from '../types';
import { sleeve, tube, tubeStart } from './common';

export const FORGE_MORTAR_SPEC: WeaponSpec = {
  id: 'forge_mortar', name: 'Furnace siege mortar', barrelLength: 0.84, recoilTravel: 0.12,
  tubeRadius: 0.075, boreRadius: 0.058, sleeveRadius: 0.092, sleeveEnd: 0.32,
  stats: { cost: 5, mass: 4, tempo: 1.18, minSpeed: 1.8, maxSpeed: 14, blastRadius: 3, damage: 90, recoil: 4.5 },
  massBoxes: [{ center: [0, 0, 0.36], half: [0.092, 0.092, 0.43], fraction: 1 }],
};

function build(ctx: KitContext, out: GroupShapes): void {
  const w = ctx.weapon, s = out.get('barrel'), z0 = tubeStart(w), L = w.barrelLength;
  sleeve(out.get('cradle'), ctx);
  tube(s, w, [[0.064, z0], [0.075, z0 + 0.014], [0.075, 0.35], [0.069, 0.39], [0.069, 0.65], [0.095, L - 0.08], [0.095, L - 0.016], [0.084, L]], 20,
    [{ from: 0.39, to: 0.65, mat: MAT_ID.darkSteel }, { from: L - 0.08, to: L - 0.016, mat: MAT_ID.brass }, { from: L - 0.016, to: L, mat: MAT_ID.chrome }]);
  if (s.coarse) return;
  s.tag = 'heat-jacket';
  s.material(MAT_ID.darkSteel);
  for (const side of [-1, 1]) {
    box(s, tr(side * 0.082, 0, 0.52), [0.018, 0.044, 0.32], 0);
    box(s, tr(0, side * 0.082, 0.52), [0.044, 0.018, 0.32], 0);
  }
  for (const z of [0.39, 0.62]) {
    s.material(MAT_ID.brass);
    lathe(s, alongZ(0, 0, 0), [[0.07, z], [0.096, z], [0.096, z + 0.028], [0.07, z + 0.028], [0.07, z]], 16, { caps: [false, false], hullProfile: [[0.096, z], [0.096, z + 0.028]] });
  }
  s.material(MAT_ID.signal);
  lathe(s, alongZ(0, 0, 0), [[0.07, 0.47], [0.07, 0.58]], 16, { caps: [false, false], hullProfile: null });
  if (s.fine) for (const side of [-1, 1]) {
    s.material(MAT_ID.brass);
    sweep(s, null, [[side * 0.073, 0.024, 0.33], [side * 0.091, 0.024, 0.43], [side * 0.091, 0.024, 0.6], [side * 0.076, 0.024, 0.7]], 0.006, 6, { bend: 0.016 });
  }
}
export const FORGE_MORTAR: PartModule<WeaponSpec> = { spec: FORGE_MORTAR_SPEC, build };
