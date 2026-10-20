import { bolts, box, cylinder, lathe, mm, sweep, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, insulator, mastCable, serviceBase, socketFrame } from './common';

export const YAGI_SPEC: UtilitySpec = {
  id: 'yagi', name: 'Directional array', head: 'spring2', headOrigin: [0, .19, 0], sight: 4,
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};
function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx);
  s.tag = 'antenna-mount';
  serviceBase(s, m); s.material(MAT_ID.gunmetal);
  cylinder(s, m, [0, .023, 0], [0, .174, 0], .011, 10);
  insulator(s, m, .125, .17, .018); mastCable(s, m, .175);
  s.material(MAT_ID.brass); lathe(s, m, [[.018, .171], [.018, .18], [.010, .189]], 10, {});
  if (s.coarse) return;
  const h = out.get('head'); h.tag = 'yagi-head'; h.material(MAT_ID.darkSteel);
  box(h, tr(0, .007, 0), [.043, .022, .041], .004);
  h.material(MAT_ID.gunmetal); cylinder(h, null, [0, .017, -.075], [0, .017, .085], .008, 8);
  for (let i = 0; i < 4; i++) {
    const z = -.065 + i * .047, half = .074 - i * .009;
    h.material(MAT_ID.paint); box(h, tr(0, .023, z), [.024, .016, .017], .002);
    h.material(MAT_ID.brass); cylinder(h, null, [-half, .030, z], [half, .030, z], .004, 8);
  }
  // A service lid closes the central feed gearbox. Its two mounting webs carry
  // lifting loads into the sprung carrier without loading the thin antenna rods.
  h.material(MAT_ID.darkSteel);
  for (const side of [-1, 1]) box(h, tr(side * .022, .033, 0), [.008, .035, .049], 0);
  h.material(MAT_ID.paint); box(h, tr(0, .055, 0), [.082, .008, .068], 0);
  if (h.fine) {
    h.material(MAT_ID.darkSteel); bolts(h, null, [[-.012, .019, 0], [.012, .019, 0]], [0, 1, 0], .004, .003);
    // The looped feed is on the sprung head, so no cable stretches through its pivot.
    h.material(MAT_ID.rubber); h.with({ cosmetic: true, noHull: true }, () => sweep(h, null, [[.008, .004, 0], [.018, .015, -.018], [.022, .035, -.03], [0, .032, -.018]], .002, 6, { bend: .005 }));
  }
}
export const YAGI: PartModule<UtilitySpec> = { spec: YAGI_SPEC, build };
