/**
 * Skiff hull: light, short and low. One utility mount, ring S–M, a clipped narrow scout bow, a flush engine
 * grille and two rear-plate exhausts: bent tubes with flanges and bores inside |x| ≤ lowerHalfWidth − r − 0.02,
 * far inboard of the idler sweep. +15% fuel.
 */
import { EDGE, bolts, box, louvres, loft, tr, type Shape } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, HullSpec, KitContext, PartModule } from '../types';
import { DECK_Y, exhaustPipe, fenders, gearMounts, glacisSlope, glacisY, headlightMounts, headlights, hullBody, towHooks } from './common';

export const SKIFF_SPEC: HullSpec = {
  id: 'skiff', name: 'Skiff hull',
  deckFront: 0.22, nose: [0.76, -0.152], bellyFront: 0.65, rear: -0.7, rearLow: -0.18, bellyRear: -0.57, upperRear: -0.72,
  overhang: 0.015, utilityMounts: 1, exhaustKind: 'rear', fuelMul: 1.15,
  stats: { cost: 2, mass: 3.0, hp: 90, tempo: 0.92, mitigation: 0 },
  massBoxes: [
    { center: [0, -0.1, 0.02], half: [0.38, 0.18, 0.72], fraction: 0.65 },
    { center: [0, 0.155, -0.1], half: [0.68, 0.03, 0.68], fraction: 0.2 },
    { center: [0, -0.04, -0.56], half: [0.28, 0.12, 0.16], fraction: 0.15 },
  ],
};

export const SKIFF_EXHAUST = Object.freeze({ x: 0.2, y: 0.02, radius: 0.026 });

export function skiffExhaustPath(ctx: KitContext, side: number): Vec3[] {
  const r = ctx.hull.rear, { x, y } = SKIFF_EXHAUST;
  return [[side * x, y, r + 0.02], [side * x, y, r - 0.07], [side * (x + 0.02), y - 0.09, r - 0.1]];
}

function build(ctx: KitContext, out: GroupShapes): void {
  const s: Shape = out.get('hull'), h = ctx.hull;
  const { zg } = hullBody(s, ctx);
  fenders(s, ctx, zg, { lip: 0.035 });
  gearMounts(s, ctx);
  // Wedge nose plate (a raised chevron on the glacis).
  s.tag = 'nose-plate';
  s.material(MAT_ID.paint);
  const z0 = h.deckFront + 0.2, z1 = h.nose[0] - 0.04, y0 = glacisY(h, z0), y1 = glacisY(h, z1);
  loft(s, null, [
    [[-0.22, y0 + 0.002, z0], [0.22, y0 + 0.002, z0], [0.22, y1 + 0.002, z1], [-0.22, y1 + 0.002, z1]],
    [[-0.2, y0 + 0.018, z0 + 0.01], [0.2, y0 + 0.018, z0 + 0.01], [0.16, y1 + 0.018, z1 - 0.01], [-0.16, y1 + 0.018, z1 - 0.01]],
  ], { edges: [EDGE.chamfer], capEdge: EDGE.none });
  // Headlights on the glacis corners, out of the gun's depression path.
  headlights(s, headlightMounts(ctx));
  towHooks(s, ctx, h.nose[0] - 0.02, h.nose[1] + 0.005);
  // Flush engine grille on the narrow rear crew tub.
  s.material(MAT_ID.paint);
  louvres(s, tr(0, DECK_Y + 0.0015, -0.6), [0.4, 0.2], 6, { height: 0.01, frame: 0.014, mat: MAT_ID.darkSteel, slatMat: MAT_ID.darkSteel });
  // Rear exhausts.
  for (const side of [-1, 1]) exhaustPipe(s, skiffExhaustPath(ctx, side), SKIFF_EXHAUST.radius);
  if (s.fine) {
    s.tag = 'rear-plate';
    s.material(MAT_ID.paint);
    bolts(s, null, [-0.3, -0.1, 0.1, 0.3].map(x => [x, 0.1, h.rear - 0.001] as Vec3), [0, 0, -1]);
    s.material(MAT_ID.signal);
    for (const side of [-1, 1]) box(s, tr(side * 0.3, 0.09, h.rear - 0.01), [0.035, 0.02, 0.02], 0.004);
  }
}

export const SKIFF: PartModule<HullSpec> = { spec: SKIFF_SPEC, build };
