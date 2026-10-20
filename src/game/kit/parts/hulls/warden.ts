/**
 * Warden hull (W1-KIT): the medium all-rounder. Two utility mounts, a louvred engine deck and two upright
 * exhaust stacks inboard of the track channel (well inside |x| < belt inner edge, clear of the idler sweep),
 * a stepped driver face, low front shelf and lower bow with headlights and tow hooks.
 */
import { EDGE, bolts, box, cylinder, grabRail, louvres, loft, tr, type Shape } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, HullSpec, KitContext, PartModule } from '../types';
import { DECK_Y, deckBox, exhaustPipe, fenders, gearMounts, glacisY, headlightMounts, headlights, hullBody, towHooks } from './common';

export const WARDEN_SPEC: HullSpec = {
  id: 'warden', name: 'Warden hull',
  deckFront: 0.36, nose: [0.9, -0.176], bellyFront: 0.8, rear: -0.84, rearLow: -0.16, bellyRear: -0.72, upperRear: -0.86,
  overhang: 0.025, utilityMounts: 2, exhaustKind: 'stack', fuelMul: 1,
  stats: { cost: 3, mass: 4.5, hp: 120, tempo: 1.0, mitigation: 0.1 },
  massBoxes: [
    { center: [0, -0.1, 0.02], half: [0.38, 0.18, 0.8], fraction: 0.6 },
    { center: [0, 0.155, -0.1], half: [0.7, 0.03, 0.75], fraction: 0.25 },
    { center: [0, -0.02, -0.62], half: [0.3, 0.14, 0.18], fraction: 0.15 },
  ],
};

/** Upright exhaust stacks: base on the deck, riser, then a bend to a rearward outlet. */
export const WARDEN_STACKS = Object.freeze({ x: 0.33, z: -0.7, top: 0.4, radius: 0.03 });

export function stackPath(side: number): Vec3[] {
  const { x, z, top } = WARDEN_STACKS;
  return [[side * x, DECK_Y - 0.004, z], [side * x, top, z], [side * x, top + 0.03, z - 0.09]];
}

function build(ctx: KitContext, out: GroupShapes): void {
  const s: Shape = out.get('hull'), h = ctx.hull;
  const { zg } = hullBody(s, ctx);
  fenders(s, ctx, zg);
  gearMounts(s, ctx);
  // Engine deck: raised louvre box behind the turret sweep.
  s.tag = 'engine-deck';
  s.material(MAT_ID.paint);
  // Stepped welded engine compartment, with a real hollow framed air intake above
  // the deck rather than slots buried in a solid block.
  box(s, tr(0, DECK_Y + 0.026, -0.695), [0.52, 0.052, 0.29], 0.01);
  louvres(s, tr(0, DECK_Y + 0.073, -0.695), [0.46, 0.23], 7, { height: 0.021, mat: MAT_ID.darkSteel, slatMat: MAT_ID.darkSteel });
  // Stacks with heat shields.
  for (const side of [-1, 1]) {
    exhaustPipe(s, stackPath(side), WARDEN_STACKS.radius, { silhouette: true });
    if (s.detail >= 0.5) {
      s.tag = 'heat-shield';
      s.material(MAT_ID.darkSteel);
      const { x, z } = WARDEN_STACKS, r = WARDEN_STACKS.radius + 0.008;
      // Half shell on the outboard side (cosmetic slats).
      s.with({ cosmetic: true, noHull: true }, () => {
        for (let k = 0; k < 4; k++) box(s, tr(side * (x + r), DECK_Y + 0.04 + k * 0.04, z), [0.008, 0.028, r * 1.6], 0.002);
        for (const y of [DECK_Y + 0.04, DECK_Y + 0.16]) cylinder(s, null, [side * (x + 0.022), y, z], [side * (x + r), y, z], 0.007, 8);
      });
    }
  }
  // Low driver's vision block and stowage keep the turret's swept deck clear.
  s.material(MAT_ID.paint);
  deckBox(s, [-0.51, DECK_Y + 0.004, -0.3], [0.12, 0.06, 0.34], 0.01);
  if (s.fine) {
    s.material(MAT_ID.darkSteel);
    // Grab rails along the sponsons.
    for (const side of [-1, 1]) {
      const x = side * ctx.upperHalfWidth * 0.85, y = DECK_Y - 0.002;
      grabRail(s, [[x, y, -0.16], [x, y, 0.12]], [[[x, DECK_Y - 0.026, -0.14], [x, y, -0.14]], [[x, DECK_Y - 0.026, 0.1], [x, y, 0.1]]]);
    }
  }
  // Glacis details: headlights on the upper corners, tow hooks at the nose, a bolted seam.
  s.material(MAT_ID.paint);
  headlights(s, headlightMounts(ctx));
  towHooks(s, ctx, h.nose[0] - 0.02, h.nose[1] + 0.005);
  if (s.fine) {
    const pts: Vec3[] = [];
    for (let i = 0; i < 7; i++) { const x = -0.3 + i * 0.1; pts.push([x, glacisY(h, h.deckFront + 0.04) + 0.004, h.deckFront + 0.04]); }
    bolts(s, null, pts, [0, 0.85, 0.53]);
  }
  // Rear plate: a painted stowage bin held by two dark-steel straps, and tail lights.
  s.tag = 'rear-rack';
  s.material(MAT_ID.paint);
  loft(s, null, [
    [[-0.26, -0.1, h.rear - 0.004], [0.26, -0.1, h.rear - 0.004], [0.26, 0.06, h.rear - 0.004], [-0.26, 0.06, h.rear - 0.004]],
    [[-0.25, -0.09, h.rear - 0.03], [0.25, -0.09, h.rear - 0.03], [0.25, 0.05, h.rear - 0.03], [-0.25, 0.05, h.rear - 0.03]],
  ], { edges: [EDGE.chamfer] });
  if (s.coarse) return; // LOD2: straps and tail lights are below a pixel
  s.material(MAT_ID.darkSteel);
  for (const side of [-1, 1]) box(s, tr(side * 0.15, -0.02, h.rear - 0.034), [0.034, 0.172, 0.012], 0.003);
  s.tag = 'tail-lights';
  s.material(MAT_ID.signal, 0);
  for (const side of [-1, 1]) box(s, tr(side * 0.31, 0.08, h.rear - 0.012), [0.04, 0.025, 0.02], 0.004);
}

export const WARDEN: PartModule<HullSpec> = { spec: WARDEN_SPEC, build };
