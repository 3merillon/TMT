/** Aether focusing cannon: bowed copper induction arms and a suspended, open emitter core. */
import { alongZ, box, lathe, sweep, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, WeaponSpec } from '../types';
import { sleeve, tube, tubeStart } from './common';

export const ARC_CANNON_SPEC: WeaponSpec = {
  id: 'arc_cannon', name: 'Aether arc cannon', barrelLength: 1.16, recoilTravel: 0.09,
  tubeRadius: 0.054, boreRadius: 0.029, sleeveRadius: 0.077, sleeveEnd: 0.34,
  stats: { cost: 4, mass: 2.8, tempo: 0.9, minSpeed: 3, maxSpeed: 20, blastRadius: 2, damage: 75, recoil: 3 },
  massBoxes: [{ center: [0, 0, 0.48], half: [0.075, 0.075, 0.6], fraction: 1 }],
};

function build(ctx: KitContext, out: GroupShapes): void {
  const w = ctx.weapon, s = out.get('barrel'), z0 = tubeStart(w), L = w.barrelLength;
  sleeve(out.get('cradle'), ctx);
  const profile: [number, number][] = s.coarse ? [[0.054, z0], [0.037, 0.39], [0.046, L]] : [[0.04, z0], [0.054, z0 + 0.014], [0.054, 0.35], [0.037, 0.39], [0.037, L - 0.07], [0.052, L - 0.03], [0.046, L]];
  tube(s, w, profile, 16,
    [{ from: 0.39, to: L - 0.07, mat: MAT_ID.darkSteel }, { from: L - 0.07, to: L, mat: MAT_ID.brass }]);
  s.tag = 'induction-frame';
  s.material(MAT_ID.brass);
  if (s.coarse) {
    for (const side of [-1, 1]) box(s, tr(side * 0.065, 0, 0.73), [0.014, 0.025, 0.71], 0);
    return;
  }
  for (const side of [-1, 1]) {
    sweep(s, null, [[side * 0.042, 0, 0.33], [side * 0.075, 0, 0.49], [side * 0.075, 0, 0.92], [side * 0.042, 0, L - 0.04]], 0.01, 6, { bend: s.fine ? 0.025 : 0 });
    s.material(MAT_ID.paint);
    for (const z of [0.42, 1.02]) box(s, tr(side * 0.055, 0, z), [0.034, 0.055, 0.028], 0);
    s.material(MAT_ID.brass);
  }
  for (const z of [0.49, 0.92]) {
    s.material(MAT_ID.gunmetal);
    lathe(s, alongZ(0, 0, 0), [[0.039, z], [0.077, z], [0.077, z + 0.018], [0.039, z + 0.018], [0.039, z]], s.fine ? 16 : 12, { caps: [false, false], hullProfile: [[0.077, z], [0.077, z + 0.018]] });
  }
  s.tag = 'field-core';
  for (const z of [0.56, 0.69, 0.82]) {
    s.material(MAT_ID.signal);
    lathe(s, alongZ(0, 0, 0), [[0.038, z], [0.038, z + 0.03]], 12, { caps: [false, false], hullProfile: null });
  }
  if (s.fine) {
    s.material(MAT_ID.darkSteel);
    for (const side of [-1, 1]) box(s, tr(0, side * 0.052, 0.715), [0.031, 0.012, 0.42], 0);
    s.material(MAT_ID.glass);
    lathe(s, alongZ(0, 0.061, 0), [[0.008, 0.58], [0.014, 0.6], [0.014, 0.8], [0.008, 0.82]], 10, { hullProfile: null });
  }
}
export const ARC_CANNON: PartModule<WeaponSpec> = { spec: ARC_CANNON_SPEC, build };
