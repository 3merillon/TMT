/** Faceted field-generator turret. Every coil sits on a bolted cradle on the casting. */
import { bolts, box, cylinder, lathe, tr } from '../../geometry/shapes';
import { DEG } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, TurretSpec } from '../types';
import { ballTrunnionSeats, bearingRace, cupola, cutRoofOpening, hatchLid, slottedLathe, sphereMantlet, utilityPad } from './common';

// Eight broad armor panels form a low drum, a steep shoulder and a raised
// generator roof. This is a centered machined housing, not a second cast dome.
const PROFILE: readonly [number, number][] = [[.335, .028], [.335, .115], [.30, .19], [.265, .25], [.225, .25], [.19, .32], [0, .32]];
const CAP = { x: .105, z: -.155, r: .084, y: .282, h: .075 };
export const AETHER_CROWN_SPEC: TurretSpec = {
  id: 'aether_crown', name: 'Aether crown', trunnion: [0, .25, .25], elevation: [-20 * DEG, 75 * DEG], mantlet: 'sphere', drumHalfWidth: 0,
  utility: [-.15, .34, -.20], hatch: { hinge: [CAP.x, CAP.y + CAP.h, CAP.z - CAP.r * .8], axis: [1, 0, 0], open: 105 * DEG },
  hpBonus: 35, stats: { cost: 6, mass: 1.8, hp: 35, tempo: .88 },
  massBoxes: [{ center: [0, .16, 0], half: [.31, .16, .29], fraction: 1 }],
};
function height(x: number, z: number): number {
  const a = Math.atan2(x, z), step = Math.PI / 4, normal = (Math.floor(a / step) + .5) * step;
  const r = Math.hypot(x, z) * Math.cos(a - normal) / Math.cos(step / 2);
  for (let i = PROFILE.length - 1; i > 0; i--) {
    const [a, y] = PROFILE[i], [b, yy] = PROFILE[i - 1];
    if (r >= a && r <= b) return y + (yy - y) * (r - a) / (b - a);
  }
  return .028;
}
function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'); bearingRace(s, ctx);
  s.tag = 'aether-body'; s.material(MAT_ID.paint);
  slottedLathe(s, 0, PROFILE, 8, { halfWidth: ctx.mantletRadius + .009, back: ctx.turret.trunnion[2] - ctx.mantletRadius - .009 }, true);
  cutRoofOpening(s, CAP.x, CAP.z, CAP.r * .66, CAP.y - .07);
  cupola(s, CAP.x, CAP.z, CAP.y, CAP.r, CAP.h, height); utilityPad(s, ctx, height);
  ballTrunnionSeats(s, ctx, true);
  if (!s.coarse) {
    s.tag = 'field-capacitor';
    for (const side of [-1, 1]) {
      const x = side * .267, z = -.19;
      s.material(MAT_ID.darkSteel); box(s, tr(x, .143, z), [.075, .160, .102], 0);
      // The sleeve continues inside its mount; omit the buried bottom flange.
      s.material(MAT_ID.paint); lathe(s, tr(x, .207, z), s.fine ? [[.028, 0], [.028, .122], [.034, .129], [.034, .143], [.022, .153]] : [[.033, 0], [.033, .14], [.022, .153]], s.fine ? 10 : 6, { caps: [false, true] });
      s.material(MAT_ID.brass);
      if (s.fine) for (const y of [.25, .29, .33]) lathe(s, tr(x, y, z), [[.029, 0], [.029, .014]], 8, { caps: [false, false], hullProfile: null });
      s.material(MAT_ID.glass); box(s, tr(x + side * .029, .285, z), [.009, .065, .015], 0);
      if (s.fine) {
        s.material(MAT_ID.chrome); bolts(s, null, [[x - .024, .225, z - .036], [x + .024, .225, z - .036], [x - .024, .225, z + .036], [x + .024, .225, z + .036]], [0, 1, 0], .004, .003);
        s.material(MAT_ID.brass); cylinder(s, null, [x, .178, z - .048], [x * .83, .149, z - .088], .007, 6);
      }
    }
  }
  sphereMantlet(out.get('cradle'), ctx.mantletRadius);
  if (!s.coarse) hatchLid(out.get('hatch'), CAP.r * .8);
}
export const AETHER_CROWN: PartModule<TurretSpec> = { spec: AETHER_CROWN_SPEC, build };
