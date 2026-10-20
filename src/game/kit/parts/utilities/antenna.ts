/**
 * Whip antenna (W1-KIT): a mount block with a spring coil (rigid, on the turret) and a whip on a 2-DOF spring
 * joint driven by hull motion (pose.ts). The thin whip is cosmetic for proxy containment (a flexible mast has
 * no collider) but it is still checked for interference at its deflection extremes.
 */
import { cylinder, lathe, mm, spring, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, insulator, mastCable, serviceBase, socketFrame } from './common';

export const ANTENNA_SPEC: UtilitySpec = {
  id: 'antenna', name: 'Whip antenna', head: 'spring2', headOrigin: [0, 0.07, 0], sight: 3,
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};
/** Whip height above the head origin and maximum spring deflection (radians). */
export const WHIP = Object.freeze({ height: 0.5, maxTilt: 0.26 });
export const WHIP_SHORT_SPEC: UtilitySpec = {
  ...ANTENNA_SPEC, id: 'whip_short', name: 'Stub aerial',
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx);
  s.tag = 'antenna-mount';
  serviceBase(s, m);
  insulator(s, m, .025, .049, .019);
  s.material(MAT_ID.brass);
  cylinder(s, m, [0, .045, 0], [0, .070, 0], .007, 8);
  if (s.fine) s.with({ cosmetic: true, noHull: true }, () => spring(s, mm(m, tr(0, .047, 0)), .014, .0025, .023, 2));
  mastCable(s, m, .042);
  if (s.detail <= 0.3) return;
  const h = out.get('head');
  const height = ctx.utility.id === 'whip_short' ? 0.23 : WHIP.height;
  h.tag = 'whip';
  h.cosmetic = true;
  h.material(MAT_ID.darkSteel);
  lathe(h, null, [[0.009, 0], [0.006, height * 0.25], [0.004, height * 0.7], [0.0025, height]], 8, {});
  if (h.fine) {
    // Threaded compression ferrules secure the telescoping rod sections.
    h.material(MAT_ID.brass);
    for (const y of [0, height * .28, height * .68]) lathe(h, tr(0, y, 0), [[.005, 0], [.0075, .005], [.005, .010]], 6, { caps: [false, false], hullProfile: null });
    if (ctx.utility.id === 'whip_short') insulator(h, tr(0, height * .20, 0), 0, height * .23, .010);
  }
  h.material(MAT_ID.signal);
  lathe(h, tr(0, height, 0), [[0, -0.008], [0.008, -0.003], [0.008, 0.003], [0, 0.008]], 8, {});
}

export const ANTENNA: PartModule<UtilitySpec> = { spec: ANTENNA_SPEC, build };
export const WHIP_SHORT: PartModule<UtilitySpec> = { spec: WHIP_SHORT_SPEC, build };
