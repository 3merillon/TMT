/**
 * Mass properties from part mass boxes (W1-KIT; the analytic-box form of structural-mass.ts's
 * convexMassProperties idea). Each part spreads its catalogue mass over solid boxes in its own frame; the
 * boxes are placed at the rest pose and summed: mass = Σ part masses, COM, and the principal inertia about the
 * COM (diagonal terms in the tank frame; the kit is left–right symmetric, so X is principal and the small
 * y–z product is dropped).
 *
 * Arcade keel (plan §3 / brief: COM y ≤ −0.20 for a tank whose turret and gun sit high): ARCADE_KEEL of every
 * above-belt part's mass is carried as ballast in a flat keel inside the lower hull, trimmed fore–aft so the
 * COM lands at z = COM_TARGET_Z. Running gear keeps its own low boxes.
 *
 * The reported inertia is at least mass × INERTIA_FLOOR_PER_MASS (handling.ts, the R6 fallback): the keel makes the
 * part-box inertia (`boxInertia`) about half of kit v1's, on which the vehicle model is tuned.
 */
import type { V3 } from '../contracts';
import { applyPoint, rotY, translate, mul, type Mat4 } from './geometry/math';
import type { KitContext, MassBox } from './parts/types';
import { INERTIA_FLOOR_PER_MASS } from './handling';
import { BELLY_Y, RING_FRAME } from './sockets';
import { hasReactiveArmor, REACTIVE_ARMOR } from './armor';

export const ARCADE_KEEL = 0.88;
export const COM_TARGET_Z = -0.02;
/** Keel box: from the belly up KEEL_HEIGHT, inset from the lower hull sides, centred on its trim z. */
export const KEEL = Object.freeze({ height: 0.05, inset: 0.03, halfLength: 0.55 });

interface WeightedBox { m: number; c: V3; h: V3 }

function place(frame: Mat4, boxes: readonly MassBox[], mass: number, out: WeightedBox[]): void {
  for (const b of boxes) out.push({ m: mass * b.fraction, c: applyPoint(frame, b.center[0], b.center[1], b.center[2]) as V3, h: [...b.half] as V3 });
}

export interface MassProps { mass: number; com: V3; inertia: V3; boxInertia: V3; keel: { mass: number; center: V3; half: V3 } }

export function massProperties(ctx: KitContext): MassProps {
  const t = ctx.turret, u = t.utility;
  const turretFrame = translate(RING_FRAME[0], RING_FRAME[1], RING_FRAME[2]);
  const cradleFrame = mul(turretFrame, translate(t.trunnion[0], t.trunnion[1], t.trunnion[2]));
  const utilityFrame = mul(turretFrame, translate(u[0], u[1], u[2]));
  void rotY;
  const upper: WeightedBox[] = [], low: WeightedBox[] = [];
  const I = translate(0, 0, 0);
  place(I, ctx.hull.massBoxes, ctx.hull.stats.mass, upper);
  place(turretFrame, ctx.turret.massBoxes, ctx.turret.stats.mass, upper);
  place(cradleFrame, ctx.weapon.massBoxes, ctx.weapon.stats.mass, upper);
  place(utilityFrame, ctx.utility.massBoxes, ctx.utility.stats.mass, upper);
  place(I, ctx.gear.massBoxes, ctx.gear.stats.mass, low);
  if (hasReactiveArmor(ctx.loadout)) {
    // The add-on is distributed at its mounting surfaces and follows the same arcade ballast rule as hull armor.
    const halfWidth = ctx.upperHalfWidth;
    place(I, [
      { center: [0, .08, ctx.hull.deckFront + .1], half: [ctx.lowerHalfWidth * .8, .055, .15], fraction: .3 },
      { center: [halfWidth, .04, -.05], half: [.045, .09, .5], fraction: .25 },
      { center: [-halfWidth, .04, -.05], half: [.045, .09, .5], fraction: .25 },
      { center: [0, .04, ctx.hull.upperRear], half: [ctx.lowerHalfWidth * .6, .08, .045], fraction: .2 },
    ], REACTIVE_ARMOR.mass, upper);
  }
  // Arcade keel: move ARCADE_KEEL of the above-belt mass into the keel.
  const boxes: WeightedBox[] = [...low];
  let keelMass = 0;
  for (const b of upper) { boxes.push({ ...b, m: b.m * (1 - ARCADE_KEEL) }); keelMass += b.m * ARCADE_KEEL; }
  const mass = boxes.reduce((s, b) => s + b.m, 0) + keelMass;
  // Trim the keel along z so the COM sits at COM_TARGET_Z (clamped inside the hull).
  const momentZ = boxes.reduce((s, b) => s + b.m * b.c[2], 0);
  const keelZ = Math.max(-0.3, Math.min(0.3, (COM_TARGET_Z * mass - momentZ) / keelMass));
  const keel = { mass: keelMass, center: [0, BELLY_Y + KEEL.height / 2, keelZ] as V3, half: [ctx.lowerHalfWidth - KEEL.inset, KEEL.height / 2, KEEL.halfLength] as V3 };
  boxes.push({ m: keelMass, c: keel.center, h: keel.half });
  const com: V3 = [0, 0, 0];
  for (const b of boxes) for (let k = 0; k < 3; k++) com[k] += b.m * b.c[k] / mass;
  com[0] = 0; // symmetric by construction; avoid float noise
  const inertia: V3 = [0, 0, 0];
  for (const b of boxes) {
    const [hx, hy, hz] = b.h, dx = b.c[0] - com[0], dy = b.c[1] - com[1], dz = b.c[2] - com[2];
    // Solid box about its centre: m (a² + b²) / 3 with half extents; plus the parallel axis term.
    inertia[0] += b.m * ((hy * hy + hz * hz) / 3 + dy * dy + dz * dz);
    inertia[1] += b.m * ((hx * hx + hz * hz) / 3 + dx * dx + dz * dz);
    inertia[2] += b.m * ((hx * hx + hy * hy) / 3 + dx * dx + dy * dy);
  }
  const floored = inertia.map((v, k) => Math.max(v, mass * INERTIA_FLOOR_PER_MASS[k])) as V3;
  return { mass, com, inertia: floored, boxInertia: inertia, keel };
}
