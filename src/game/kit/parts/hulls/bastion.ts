/**
 * Bastion hull: heavy. Ring M–L, a blunt 65° armored bow, broad siege deck, side skirts hanging
 * outside the belt (their inner face 12 mm beyond the belt edge), a big engine grille and armoured rear-plate
 * exhaust boxes with bent outlets inside |x| ≤ lowerHalfWidth − r − 0.02.
 */
import { EDGE, bolts, box, louvres, loft, prism, tr, type Shape } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, HullSpec, KitContext, PartModule } from '../types';
import { DECK_Y, SPONSON_UNDERSIDE, deckBox, exhaustPipe, fenders, gearMounts, glacisSlope, glacisY, headlightMounts, headlights, hullBody, towHooks } from './common';

export const BASTION_SPEC: HullSpec = {
  id: 'bastion', name: 'Bastion hull',
  deckFront: 0.75, nose: [0.94, -0.215], bellyFront: 0.86, rear: -0.9, rearLow: -0.15, bellyRear: -0.78, upperRear: -0.92,
  overhang: 0.034, utilityMounts: 2, exhaustKind: 'rear', fuelMul: 1,
  stats: { cost: 5, mass: 7.0, hp: 160, tempo: 1.1, mitigation: 0.25 },
  massBoxes: [
    { center: [0, -0.1, 0.02], half: [0.38, 0.18, 0.85], fraction: 0.55 },
    { center: [0, 0.155, -0.1], half: [0.74, 0.03, 0.8], fraction: 0.2 },
    { center: [0, 0.02, 0.62], half: [0.36, 0.1, 0.2], fraction: 0.1 },
    { center: [0, -0.02, -0.66], half: [0.3, 0.14, 0.2], fraction: 0.15 },
  ],
};

/** Glacis armour plate thickness. */
export const BASTION_ARMOR = 0.032;
export const BASTION_EXHAUST = Object.freeze({ x: 0.22, y: 0.0, radius: 0.028 });
/** Skirt: inner face gap outside the belt edge, thickness, bottom height. */
export const BASTION_SKIRT = Object.freeze({ gap: 0.012, thickness: 0.024, bottom: -0.15 });

export function bastionExhaustPath(ctx: KitContext, side: number): Vec3[] {
  const r = ctx.hull.rear, { x, y } = BASTION_EXHAUST;
  return [[side * x, y, r - 0.05], [side * x, y, r - 0.1], [side * x, y - 0.1, r - 0.12]];
}

function build(ctx: KitContext, out: GroupShapes): void {
  const s: Shape = out.get('hull'), h = ctx.hull;
  const { zg } = hullBody(s, ctx);
  fenders(s, ctx, zg);
  gearMounts(s, ctx);
  // Glacis armour plate (sloped slab with chamfered edges).
  s.tag = 'glacis-armor';
  s.material(MAT_ID.paint, 1);
  const z0 = h.deckFront + 0.03, z1 = h.nose[0] - 0.03, y0 = glacisY(h, z0), y1 = glacisY(h, z1), t = BASTION_ARMOR, w = ctx.lowerHalfWidth - 0.02;
  const pitch = Math.atan(-glacisSlope(h, (z0 + z1) / 2));
  const n: Vec3 = [0, Math.cos(pitch), Math.sin(pitch)];
  const off = (p: Vec3, d: number): Vec3 => [p[0], p[1] + n[1] * d, p[2] + n[2] * d];
  const base: Vec3[] = [[-w, y0, z0], [w, y0, z0], [w, y1, z1], [-w, y1, z1]];
  loft(s, null, [base.map(p => off(p, 0.001)), base.map((p, i) => off([p[0] * (1 - 0.03), p[1], p[2] + (i < 2 ? 0.01 : -0.01)], t))], { edges: [EDGE.chamfer] });
  s.material(MAT_ID.paint);
  if (s.fine) {
    const pts: Vec3[] = [];
    for (const f of [0.1, 0.9]) for (let i = 0; i < 6; i++) { const z = z0 + (z1 - z0) * f, x = -w * 0.8 + i * w * 0.32; pts.push(off([x, glacisY(h, z), z], t)); }
    bolts(s, null, pts, n);
  }
  headlights(s, headlightMounts(ctx));
  towHooks(s, ctx, h.nose[0] - 0.02, h.nose[1] + 0.005);
  // Side skirts outside the belt.
  s.tag = 'skirt';
  const { gap, thickness, bottom } = BASTION_SKIRT;
  for (const side of [-1, 1]) {
    const x0 = ctx.beltOuter + gap, x1 = x0 + thickness, cx = side * (x0 + x1) / 2;
    const zf = zg - 0.02, zr = h.upperRear + 0.04;
    const sections = s.coarse ? 1 : 4, pitch = (zf - zr) / sections;
    for (let i = 0; i < sections; i++) {
      const a = zr + i * pitch + (i ? 0.008 : 0), b = zr + (i + 1) * pitch - (i + 1 < sections ? 0.008 : 0);
      // Individual hanging armor slabs expose recessed seams and rise at the
      // sprocket/idler ends; the full belt width plus 12 mm stays clear inside.
      prism(s, null, 'x', [[bottom + (i === 0 ? 0.055 : 0), a], [SPONSON_UNDERSIDE, a], [SPONSON_UNDERSIDE, b], [bottom + (i === sections - 1 ? 0.065 : 0), b]], cx - thickness / 2, cx + thickness / 2, 0);
    }
    if (s.fine) bolts(s, null, [-0.6, -0.3, 0, 0.3].map(z => [side * x1, 0.09, z] as Vec3), [side, 0, 0]);
  }
  // Engine grille and commander stowage, clear of the rotating turret.
  s.material(MAT_ID.paint);
  louvres(s, tr(0, DECK_Y + 0.0015, -0.68), [0.5, 0.3], 8, { height: 0.012, mat: MAT_ID.darkSteel, slatMat: MAT_ID.darkSteel });
  deckBox(s, [0.5, DECK_Y + 0.03, -0.52], [0.16, 0.06, 0.3], 0.01);
  deckBox(s, [-0.5, DECK_Y + 0.03, -0.52], [0.16, 0.06, 0.3], 0.01);
  // Armoured exhaust boxes on the rear plate, each with a bent outlet turning down.
  for (const side of [-1, 1]) {
    s.tag = 'exhaust-box';
    s.material(MAT_ID.darkSteel);
    box(s, tr(side * BASTION_EXHAUST.x, 0.0, h.rear - 0.03), [0.12, 0.12, 0.06], 0.012);
    exhaustPipe(s, bastionExhaustPath(ctx, side), BASTION_EXHAUST.radius);
  }
  if (s.coarse) return; // LOD2: tail lights are below a pixel
  s.tag = 'tail-lights';
  s.material(MAT_ID.signal);
  for (const side of [-1, 1]) box(s, tr(side * 0.36, 0.09, h.rear - 0.01), [0.04, 0.025, 0.02], 0.004);
}

export const BASTION: PartModule<HullSpec> = { spec: BASTION_SPEC, build };
