/** Rotating clockwork field-vane demonstrator. Cosmetic; it has no combat power. */
import { box, cylinder, lathe, tr } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS, insulator, mastCable, serviceBase, socketFrame } from './common';
export const AETHER_VANE_SPEC: UtilitySpec = {
  id: 'aether_vane', name: 'Aether vane', head: 'spin', headOrigin: [0, .18, 0], sight: 0,
  stats: COSMETIC_UTILITY_STATS, massBoxes: COSMETIC_UTILITY_MASS,
};
function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), m = socketFrame(ctx); s.tag = 'radar-mast'; serviceBase(s, m);
  s.material(MAT_ID.darkSteel); cylinder(s, m, [0, .023, 0], [0, .176, 0], .012, 10);
  if (s.fine) insulator(s, m, .035, .12, .025); else { s.material(MAT_ID.paint); cylinder(s, m, [0, .035, 0], [0, .12, 0], .023, 6); } mastCable(s, m, .145);
  s.material(MAT_ID.brass); lathe(s, m, [[.027, .137], [.027, .154], [.021, .167], [.021, .18]], 12, {});
  if (s.coarse) return;
  const h = out.get('head'); h.tag = 'aether-vane-head'; h.material(MAT_ID.brass);
  cylinder(h, null, [0, 0, 0], [0, .18, 0], .010, 10);
  if (!h.fine) {
    // Preserve the three-lobed moving silhouette; coils and collars resolve only close up.
    for (let i = 0; i < 3; i++) { const a = i * Math.PI * 2 / 3, x = Math.cos(a) * .062, z = Math.sin(a) * .062;
      h.material(MAT_ID.darkSteel); cylinder(h, null, [0, .022, 0], [x, .06, z], .006, 6, { caps: [false, false] }); cylinder(h, null, [x, .12, z], [0, .15, 0], .006, 6, { caps: [false, false] });
      h.material(MAT_ID.glass); cylinder(h, null, [x, .06, z], [x, .12, z], .012, 6);
    }
    h.material(MAT_ID.paint); box(h, tr(0, .182, 0), [.086, .014, .064], 0); return;
  }
  lathe(h, null, [[.022, .008], [.047, .016], [.047, .027], [.022, .036]], 12, {});
  lathe(h, null, [[.018, .134], [.042, .143], [.042, .156], [.018, .165]], 12, {});
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3, x = Math.cos(a) * .062, z = Math.sin(a) * .062;
    h.material(MAT_ID.darkSteel); cylinder(h, null, [0, .022, 0], [x, .044, z], .004, 6); cylinder(h, null, [x, .044, z], [x, .134, z], .006, 8); cylinder(h, null, [x, .134, z], [0, .150, 0], .004, 6);
    h.material(MAT_ID.paint); box(h, tr(x, .09, z), [.020, .073, .020], .004);
    h.material(MAT_ID.glass); cylinder(h, null, [x, .06, z], [x, .12, z], .012, 8);
  }
  // Flat gearbox cap is physically supported by the central spindle and permits service pickup.
  h.material(MAT_ID.paint); box(h, tr(0, .182, 0), [.086, .014, .064], .003);
}
export const AETHER_VANE: PartModule<UtilitySpec> = { spec: AETHER_VANE_SPEC, build };
