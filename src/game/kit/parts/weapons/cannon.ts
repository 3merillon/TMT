/**
 * Field cannon (W1-KIT): a long tapered tube with a bore evacuator and a vented muzzle brake. Class M,
 * recoil 0.105. Launch speeds are kit v1's.
 */
import { alongZ, box, lathe, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, WeaponSpec } from '../types';
import { sleeve, tube, tubeStart } from './common';

export const CANNON_SPEC: WeaponSpec = {
  id: 'cannon', name: 'Field cannon',
  barrelLength: 1.08, recoilTravel: 0.105, tubeRadius: 0.05, boreRadius: 0.03,
  sleeveRadius: 0.075, sleeveEnd: 0.33,
  stats: { cost: 3, mass: 2.4, tempo: 0.95, minSpeed: 2.2, maxSpeed: 16, blastRadius: 2.25, damage: 70, recoil: 2.5 },
  massBoxes: [{ center: [0, 0, 0.45], half: [0.06, 0.06, 0.55], fraction: 1 }],
};

function build(ctx: KitContext, out: GroupShapes): void {
  const w = ctx.weapon, z0 = tubeStart(w), L = w.barrelLength;
  sleeve(out.get('cradle'), ctx);
  const s = out.get('barrel');
  if (s.coarse) {
    tube(s, w, [[0.05, z0], [0.058, 0.64], [0.046, L - 0.12], [0.06, L]], 12);
    return;
  }
  const brakeStart = L - 0.12;
  // The tube and rear baffle share one bore wall boundary and no internal cap.
  const tubeEnd = brakeStart;
  tube(s, { ...w, barrelLength: tubeEnd }, [
    [0.036, z0], [0.05, z0 + 0.012], [0.048, 0.56], [0.058, 0.6], [0.062, 0.64], [0.062, 0.7], [0.056, 0.74], [0.044, 0.76],
    [0.042, tubeEnd],
  ], 20, [{ from: 0.6, to: 0.64, mat: MAT_ID.darkSteel }, { from: 0.64, to: 0.7, mat: MAT_ID.brass }, { from: 0.7, to: 0.76, mat: MAT_ID.darkSteel }], { muzzleFace: false });
  // Open baffle brake: two hollow rings joined by four ribs, leaving actual gas ports.
  s.tag = 'muzzle-brake';
  s.material(MAT_ID.gunmetal);
  for (const [a, b] of [[brakeStart, brakeStart + 0.018], [L - 0.024, L]]) {
    s.material(a === brakeStart ? MAT_ID.darkSteel : MAT_ID.brass);
    const rear = a === brakeStart;
    lathe(s, alongZ(0, 0, 0), [[0.06, a], [0.06, b], [w.boreRadius, b], [w.boreRadius, a], ...(rear ? [] : [[0.06, a]] as [number, number][])], 20, { caps: [false, false], hullProfile: [[0.06, a], [0.06, b]] });
    if (rear) lathe(s, alongZ(0, 0, 0), [[0.042, a], [0.06, a]], 20, { caps: [false, false], hullProfile: null });
  }
  for (const side of [-1, 1]) {
    s.material(MAT_ID.gunmetal);
    // Rib ends are embedded halfway into each baffle rather than exposed on
    // the flat muzzle face. The brass annulus is one uninterrupted surface.
    const ribStart = brakeStart + 0.009, ribEnd = L - 0.012;
    box(s, tr(side * 0.051, 0, (ribStart + ribEnd) / 2), [0.017, 0.019, ribEnd - ribStart], 0);
    box(s, tr(0, side * 0.051, (ribStart + ribEnd) / 2), [0.019, 0.017, ribEnd - ribStart], 0);
  }
}

export const CANNON: PartModule<WeaponSpec> = { spec: CANNON_SPEC, build };
