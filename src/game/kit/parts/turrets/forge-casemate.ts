/** Heavy riveted pressure casing, rear radiator, and a deeply seated crew hatch. */
import { EDGE, bolts, box, cylinder, loft, tr } from '../../geometry/shapes';
import { DEG, type Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, TurretSpec } from '../types';
import { bearingRace, cupola, cutRoofOpening, drumMantlet, hatchLid, utilityPad } from './common';
const HALF = .18, TOP = .30, CAP = { x: .125, z: -.225, r: .089, y: .27, h: .074 };
export const FORGE_CASEMATE_SPEC: TurretSpec = {
  id: 'forge_casemate', name: 'Forge casemate', trunnion: [0, .25, .30], elevation: [-25 * DEG, 65 * DEG], mantlet: 'drum', drumHalfWidth: HALF,
  utility: [-.18, TOP + .012, -.225], hatch: { hinge: [CAP.x, CAP.y + CAP.h, CAP.z - CAP.r * .8], axis: [1, 0, 0], open: 100 * DEG },
  hpBonus: 70, stats: { cost: 7, mass: 3.4, hp: 70, tempo: 1.08 },
  massBoxes: [{ center: [0, .17, -.09], half: [.34, .16, .34], fraction: 1 }],
};
const ring = (y: number, pts: readonly [number, number][]): Vec3[] => pts.map(([x, z]) => [x, y, z]);
function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'); bearingRace(s, ctx); s.tag = 'forge-body'; s.material(MAT_ID.paint);
  loft(s, null, [
    ring(.028, [[-.27, -.27], [.27, -.27], [.30, -.02], [.19, .12], [-.19, .12], [-.30, -.02]]),
    ring(.075, [[-.34, -.40], [.34, -.40], [.34, -.02], [.19, .12], [-.19, .12], [-.34, -.02]]),
    ring(TOP - .025, [[-.30, -.36], [.30, -.36], [.30, -.025], [.18, .075], [-.18, .075], [-.30, -.025]]),
    ring(TOP, [[-.27, -.34], [.27, -.34], [.27, -.04], [.17, .063], [-.17, .063], [-.27, -.04]]),
  ], { edges: [EDGE.none, EDGE.chamfer] });
  cutRoofOpening(s, CAP.x, CAP.z, CAP.r * .66, CAP.y - .07);
  cupola(s, CAP.x, CAP.z, CAP.y, CAP.r, CAP.h); utilityPad(s, ctx, () => TOP);
  s.tag = 'forge-cheek';
  for (const side of [-1, 1]) {
    const b = ring(.028, [[HALF + .016, -.02], [.34, -.02], [.34, .21], [HALF + .016, .37]].map(([x, z]) => [side * x, z]));
    const t = ring(.295, [[HALF + .016, 0], [.30, 0], [.30, .23], [HALF + .016, .36]].map(([x, z]) => [side * x, z]));
    loft(s, null, side > 0 ? [b, t] : [b.reverse(), t.reverse()], { edges: [EDGE.soft], capEdge: EDGE.chamfer });
    s.material(MAT_ID.darkSteel); cylinder(s, null, [side * (HALF + .016), .25, .30], [side * (HALF + .003), .25, .30], .034, 10);
    s.material(MAT_ID.paint);
    if (!s.coarse) {
      s.tag = 'forge-pressure-jacket'; box(s, tr(side * .316, .16, -.21), [.040, .14, .22], .012);
      s.material(MAT_ID.brass);
      for (let i = 0; i < (s.fine ? 5 : 3); i++) {
        const z = -.29 + i * .16 / ((s.fine ? 5 : 3) - 1);
        cylinder(s, null, [side * .339, .105, z], [side * .339, .207, z], .009, 6);
      }
      s.material(MAT_ID.darkSteel); box(s, tr(side * .336, .1, -.21), [.030, .02, .205], .004); box(s, tr(side * .336, .211, -.21), [.030, .02, .205], .004);
      if (s.fine) { s.material(MAT_ID.chrome); bolts(s, null, [[side * .35, .10, -.29], [side * .35, .10, -.13], [side * .35, .21, -.29], [side * .35, .21, -.13]], [side, 0, 0], .005, .003); }
      s.material(MAT_ID.paint); s.tag = 'forge-cheek';
    }
  }
  drumMantlet(out.get('cradle'), ctx.mantletRadius, HALF);
  if (!s.coarse) hatchLid(out.get('hatch'), CAP.r * .8);
}
export const FORGE_CASEMATE: PartModule<TurretSpec> = { spec: FORGE_CASEMATE_SPEC, build };
