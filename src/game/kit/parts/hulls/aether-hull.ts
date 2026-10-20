/** Split-shoulder electrical scout: a narrow keel between two seated capacitor nacelles. */
import { bolts, cylinder, lathe, louvres, mm, rx, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { HullSpec, PartModule } from '../types';
import { DECK_Y, exhaustPipe, fenders, gearMounts, glacisSlope, glacisY, headlightMounts, headlights, hullBody, towHooks } from './common';
import { SKIFF_SPEC, SKIFF_EXHAUST, skiffExhaustPath } from './skiff';

export const AETHER_HULL: PartModule<HullSpec> = {
  spec: { ...SKIFF_SPEC, id: 'aether_hull', name: 'Aether regent hull', archetype: 'skiff',
    deckFront: .24, nose: [.83, -.19], bellyFront: .73, rear: -.80, bellyRear: -.65, upperRear: -.82,
    frontProfile: [[.24, DECK_Y], [.47, .075], [.69, -.065], [.83, -.19]],
    fuelMul: 1.25, stats: { cost: 6, mass: 3.6, hp: 145, tempo: .86, mitigation: .12 } },
  build(ctx, out) {
    const s = out.get('hull'), h = ctx.hull, { zg } = hullBody(s, ctx);
    fenders(s, ctx, zg, { lip: .025 }); gearMounts(s, ctx);
    // Longitudinal pressure vessels are mounted on the running boards, outside the turret sweep.
    const x = ctx.beltOuter - .065;
    for (const side of [-1, 1]) {
      s.tag = 'capacitor-nacelle'; s.material(MAT_ID.paint);
      const m = mm(tr(side * x, .19, -.64), rx(Math.PI / 2));
      const profile: [number, number][] = s.coarse ? [[.055, 0], [.055, .77]] : s.fine ? [[.027, 0], [.050, .035], [.063, .1], [.063, .64], [.049, .73], [.024, .77]] : [[.027, 0], [.063, .1], [.063, .64], [.024, .77]];
      lathe(s, m, profile, s.fine ? 16 : 10);
      if (!s.coarse) {
        s.material(MAT_ID.brass);
        // Only the outward strap surface is visible; the solid vessel supplies its buried faces.
        for (const z of (s.fine ? [.12, .40, .68] : [.12, .68])) lathe(s, m, [[.065, z - .007], [.065, z + .012]], s.fine ? 16 : 8, { caps: [false, false], hullProfile: null });
        s.material(MAT_ID.glass);
        if (s.fine) for (const a of [-.9, .9]) cylinder(s, null, [side * x + Math.sin(a) * .050, .19 + Math.cos(a) * .050, -.46], [side * x + Math.sin(a) * .050, .19 + Math.cos(a) * .050, -.07], .006, 6, { caps: [false, false] });
        s.material(MAT_ID.darkSteel);
        for (const z of [-.47, -.08]) cylinder(s, null, [side * x, .145, z], [side * x, .19, z], .021, 8, { caps: [false, false] });
      }
      exhaustPipe(s, skiffExhaustPath(ctx, side), SKIFF_EXHAUST.radius);
    }
    s.tag = 'aether-keel'; s.material(MAT_ID.brass);
    if (s.fine) for (const side of [-1, 1]) {
      const points = h.frontProfile!.map(([z, y]) => [side * .15, y + .004, z] as [number, number, number]);
      for (let i = 1; i < points.length; i++) cylinder(s, null, points[i - 1], points[i], .0045, 6);
      if (s.fine) bolts(s, null, points, [0, .8, .6], .005, .004);
    }
    s.material(MAT_ID.paint); louvres(s, tr(0, DECK_Y + .002, -.68), [.36, .23], 6, { height: .011, mat: MAT_ID.darkSteel, slatMat: MAT_ID.darkSteel });
    headlights(s, headlightMounts(ctx)); towHooks(s, ctx, h.nose[0] - .02, h.nose[1] + .005);
  },
};
