/** Articulated steam-powered sight demonstrator. Cosmetic preview, no interception. */
import { bolts, box, cylinder, lathe, mm, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, mastCable, serviceBase, socketFrame } from './common';
export const STEAM_SENTINEL_SPEC: UtilitySpec = {
  id: 'steam_sentinel', name: 'Steam sentinel', head: 'pitch', headOrigin: [0, .17, 0], sight: 0,
  stats: COSMETIC_UTILITY_STATS, massBoxes: COSMETIC_UTILITY_MASS,
};
function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx); s.tag = 'periscope-housing'; serviceBase(s, m, .041);
  s.material(MAT_ID.darkSteel); cylinder(s, m, [0, .022, 0], [0, .12, 0], .022, 12);
  s.material(MAT_ID.brass); lathe(s, m, [[.03, .043], [.03, .051], [.025, .055], [.025, .087], [.03, .091], [.03, .10]], 12, {});
  s.material(MAT_ID.paint);
  for (const side of [-1, 1]) { box(s, mm(m, tr(side * .043, .132, 0)), [.014, .081, .042], .004); s.material(MAT_ID.brass); cylinder(s, m, [side * .035, .17, 0], [side * .055, .17, 0], .013, 10); s.material(MAT_ID.paint); }
  mastCable(s, m, .112, -1);
  if (s.coarse) return;
  const h = out.get('head'); h.tag = 'steam-sentinel-head'; h.material(MAT_ID.paint); box(h, tr(0, .009, .019), [.063, .059, .096], .008);
  h.material(MAT_ID.darkSteel); cylinder(h, null, [-.034, 0, 0], [.034, 0, 0], .018, 10);
  h.material(MAT_ID.brass);
  for (const side of [-1, 1]) { cylinder(h, null, [side * .019, .011, .057], [side * .019, .011, .135], .011, 10); h.material(MAT_ID.darkSteel); cylinder(h, null, [side * .019, .011, .12], [side * .019, .011, .145], .014, 10); h.material(MAT_ID.brass); }
  h.material(MAT_ID.darkSteel); box(h, tr(0, .048, .002), [.048, .020, .046], .003);
  h.material(MAT_ID.glass); box(h, tr(0, .048, .027), [.032, .011, .004], 0);
  if (h.fine) { h.material(MAT_ID.chrome); bolts(h, null, [[-.023, .04, -.015], [.023, .04, -.015]], [0, 1, 0], .004, .003); }
}
export const STEAM_SENTINEL: PartModule<UtilitySpec> = { spec: STEAM_SENTINEL_SPEC, build };
