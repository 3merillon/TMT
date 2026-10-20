/**
 * Arc mortar (W1-KIT): a short fat tube with a reinforced muzzle ring and a band. Class S, recoil 0.06.
 * Launch speeds are kit v1's (ballistics are GAME's).
 */
import { box, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, WeaponSpec } from '../types';
import { sleeve, tube, tubeStart } from './common';

export const MORTAR_SPEC: WeaponSpec = {
  id: 'mortar', name: 'Arc mortar',
  barrelLength: 0.72, recoilTravel: 0.06, tubeRadius: 0.07, boreRadius: 0.052,
  sleeveRadius: 0.085, sleeveEnd: 0.27,
  stats: { cost: 2, mass: 1.8, tempo: 1.0, minSpeed: 1.8, maxSpeed: 12.6, blastRadius: 2.6, damage: 61, recoil: 1.7 },
  massBoxes: [{ center: [0, 0, 0.3], half: [0.07, 0.07, 0.36], fraction: 1 }],
};

function build(ctx: KitContext, out: GroupShapes): void {
  const w = ctx.weapon, z0 = tubeStart(w), L = w.barrelLength;
  sleeve(out.get('cradle'), ctx);
  const s = out.get('barrel');
  tube(s, w, [[0.06, z0], [0.066, z0 + 0.015], [0.066, 0.42], [0.07, 0.43], [0.07, 0.46], [0.066, 0.47], [0.066, L - 0.05], [0.075, L - 0.04], [0.075, L]], 20,
    [{ from: 0.43, to: 0.46, mat: MAT_ID.brass }, { from: L - 0.04, to: L, mat: MAT_ID.chrome }]);
  if (s.detail >= 0.5) {
    s.material(MAT_ID.brass);
    s.with({ tag: 'sight', cosmetic: true }, () => box(s, tr(0.07, 0.02, 0.36), [0.012, 0.02, 0.05], 0.003));
  }
}

export const MORTAR: PartModule<WeaponSpec> = { spec: MORTAR_SPEC, build };
