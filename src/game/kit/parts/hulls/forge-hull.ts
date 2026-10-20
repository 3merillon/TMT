/** Broad steam siege hull with a clipped prow and a rear cross-boiler, not a scaled scout tub. */
import { bolts, box, cylinder, louvres, loft, mm, prism, rx, sweep, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { HullSpec, PartModule } from '../types';
import { BASTION_SPEC, BASTION_EXHAUST, bastionExhaustPath } from './bastion';
import { DECK_Y, exhaustPipe, fenders, gearMounts, headlightMounts, headlights, hullBody, towHooks } from './common';

export const FORGE_HULL: PartModule<HullSpec> = {
  spec: { ...BASTION_SPEC, id: 'forge_hull', name: 'Furnace leviathan hull', archetype: 'bastion',
    deckFront: .65, nose: [.95, -.225], bellyFront: .87, upperRear: -.94, rear: -.92,
    frontProfile: [[.65, DECK_Y], [.82, .045], [.95, -.225]],
    stats: { cost: 8, mass: 8.3, hp: 205, tempo: 1.12, mitigation: .30 } },
  build(ctx, out) {
    const s = out.get('hull'), h = ctx.hull, { zg } = hullBody(s, ctx);
    fenders(s, ctx, zg); gearMounts(s, ctx);
    // Broad segmented side armor exposes the belt ends and the mechanical final drives.
    for (const side of [-1, 1]) {
      const x = ctx.beltOuter + .014;
      s.tag = 'forge-skirt'; s.material(MAT_ID.paint);
      for (let i = 0; i < (s.coarse ? 1 : 3); i++) {
        const n = s.coarse ? 1 : 3, a = -.83 + i * .47 * (3 / n), b = a + .47 * (3 / n) - .012;
        prism(s, null, 'x', [[-.18, a + .05], [.123, a], [.123, b], [-.15, b]], side > 0 ? x : -x - .029, side > 0 ? x + .029 : -x, 0);
      }
      if (s.fine) { s.material(MAT_ID.brass); bolts(s, null, [-.64, -.24, .19, .5].map(z => [side * (x + .029), .08, z]), [side, 0, 0], .008, .006); }
      // A cast manifold grows directly from the rear plate and seats the bent outlet flange.
      s.tag = 'forge-exhaust-manifold'; s.material(MAT_ID.paint);
      loft(s, null, [
        [[side * .22 - .075, -.065, h.rear + .004], [side * .22 + .075, -.065, h.rear + .004], [side * .22 + .075, .072, h.rear + .004], [side * .22 - .075, .072, h.rear + .004]],
        [[side * .22 - .047, -.042, h.rear - .052], [side * .22 + .047, -.042, h.rear - .052], [side * .22 + .047, .043, h.rear - .052], [side * .22 - .047, .043, h.rear - .052]],
      ]);
      exhaustPipe(s, bastionExhaustPath(ctx, side), BASTION_EXHAUST.radius);
    }
    s.tag = 'forge-engine-cowl'; s.material(MAT_ID.paint);
    // A wide cast stern compartment is part of the hull silhouette. Its folded cover sits over
    // recessed louvres and service seams; only the clipped return pipes remain exposed.
    const station = (z: number, y: number, w: number): [number, number, number][] => [
      [-w, DECK_Y - .004, z], [w, DECK_Y - .004, z], [w * .92, y - .018, z], [w * .78, y, z], [-w * .78, y, z], [-w * .92, y - .018, z],
    ];
    const sections = [station(-.935, .213, .27), station(-.89, .260, .32), station(-.64, .234, .32), station(-.605, .193, .27)];
    if (s.coarse) loft(s, null, sections);
    else {
      // End bridges and side cheeks leave two genuine openings; there is no painted roof under a grille.
      loft(s, null, sections.slice(0, 2)); loft(s, null, sections.slice(2));
      for (const side of [-1, 1]) {
        const cheek = (z: number, y: number): [number, number, number][] => [
          [side * .23, DECK_Y - .004, z], [side * .32, DECK_Y - .004, z], [side * .2944, y - .018, z], [side * .2496, y, z], [side * .23, y, z],
        ];
        const a = cheek(-.89, .260), b = cheek(-.64, .234);
        loft(s, null, side > 0 ? [a, b] : [a.reverse(), b.reverse()]);
      }
      loft(s, null, [
        [[-.02, DECK_Y, -.89], [.02, DECK_Y, -.89], [.02, .260, -.89], [-.02, .260, -.89]],
        [[-.02, DECK_Y, -.64], [.02, DECK_Y, -.64], [.02, .234, -.64], [-.02, .234, -.64]],
      ]);
    }
    if (!s.coarse) {
      for (const side of [-1, 1]) {
        const m = mm(tr(side * .125, .247, -.765), rx(Math.atan(.104)));
        s.material(MAT_ID.darkSteel);
        louvres(s, m, [.21, .25], s.fine ? 6 : 3, { height: .030, frame: .009, mat: MAT_ID.darkSteel, slatMat: MAT_ID.gunmetal });
        s.material(MAT_ID.brass);
        sweep(s, null, [[side * .283, .211, -.64], [side * .296, .224, -.68], [side * .296, .243, -.85], [side * .273, .203, -.90]], .007, 6, { bend: .012 });
        s.material(MAT_ID.darkSteel);
        if (s.fine) for (const z of [-.70, -.83]) box(s, tr(side * .294, .238, z), [.016, .012, .009], 0);
      }
      // Flush center spine, small latch and hinge barrels describe an engine cover that can open.
      s.material(MAT_ID.darkSteel);
      box(s, mm(tr(0, .249, -.765), rx(Math.atan(.104))), [.012, .004, .22], 0);
      cylinder(s, null, [-.10, .214, -.927], [.10, .214, -.927], .006, 8);
      s.material(MAT_ID.brass);
      box(s, tr(0, .237, -.655), [.028, .009, .033], 0);
      if (s.fine) bolts(s, null, [[-.23, .255, -.875], [.23, .255, -.875], [-.23, .239, -.655], [.23, .239, -.655]], [0, 1, 0], .005, .004);
    }
    headlights(s, headlightMounts(ctx)); towHooks(s, ctx, h.nose[0] - .02, h.nose[1] + .005);
  },
};
