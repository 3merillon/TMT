/** Warden-surplus arc searchlight: triangulated mast, motorized pan bearing and trunnion-mounted optical drum. */
import { lathe, louvres, axisFrame, prism } from '../kit/geometry/shapes';
import { translate, rotX, mul, type Vec3 } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { shape, finish, plate, shaft, collar, fasteners, hose } from './campaign-machining';

const cache = new Map<number, PartMesh[]>();
export function watchtowerModel(lod: 0 | 1 | 2): PartMesh[] {
  const old = cache.get(lod); if (old) return old;
  const base = shape(lod), yoke = shape(lod), lamp = shape(lod);
  // Four anchored shoes, joined by cross-members. Feet carry the load instead of bare tubes balancing on a box.
  plate(base, [0, -.45, 0], [1.35, .10, 1.35], 1, .018);
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    plate(base, [x * .52, -.30, z * .52], [.20, .30, .20], 1, .018);
    fasteners(base, [[x * .52, -.393, z * .52]], [0, 1, 0], .026);
  }
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    const foot: Vec3 = [x * .52, -.12, z * .52], crown: Vec3 = [x * .16, 1.48, z * .16];
    plate(base, foot, [.25, .065, .25], 3);
    shaft(base, [foot[0], foot[1] + .03, foot[2]], crown, .045, 1);
    collar(base, [foot[0], -.08, foot[2]], [foot[0], .04, foot[2]], .059, .044, 3, 16);
    fasteners(base, [[foot[0] - .085, -.082, foot[2]], [foot[0] + .085, -.082, foot[2]]], [0, 1, 0], .018);
    shaft(base, [x * .39, .45, z * .39], [-x * .39, .45, z * .39], .019, 3, 12);
    shaft(base, [x * .39, .45, z * .39], [-x * .19, 1.35, z * .19], .017, 3, 12);
  }
  for (const side of [-1, 1]) plate(base, [side * .26, -.275, -.02], [.08, .27, .56], 1, .012);
  plate(base, [0, .10, -.02], [.72, .49, .66], 0, .045);
  plate(base, [0, .12, .321], [.59, .34, .022], 2, .008);
  plate(base, [0, .12, .337], [.55, .31, .018], 0, .012);
  plate(base, [.19, .12, .353], [.025, .10, .025], 4, .006);
  for (const y of [.02, .23]) shaft(base, [-.25, y - .035, .36], [-.25, y + .035, .36], .019, 3, 12);
  base.material(1); louvres(base, translate(0, .353, -.05), [.5, .4], lod === 0 ? 9 : 5, { height: .012, mat: 1, slatMat: 3 });
  plate(base, [0, .29, .354], [.17, .035, .009], 4, .003);
  hose(base, [[.27, .3, -.22], [.33, .40, -.27], [.23, 1.14, -.23], [.12, 1.52, -.12]], .019);
  plate(base, [0, 1.49, 0], [.46, .08, .46], 1, .018);
  shaft(base, [0, 1.51, 0], [0, 1.58, 0], .18, 3, 32);
  collar(base, [0, 1.58, 0], [0, 1.62, 0], .20, .12, 4, 32);
  fasteners(base, [[-.15, 1.536, -.15], [.15, 1.536, -.15], [-.15, 1.536, .15], [.15, 1.536, .15]], [0, 1, 0]);
  // The yoke pans about the mast; only the drum pitches on the side bearings.
  plate(yoke, [0, -.15, -.02], [.82, .09, .26], 1);
  for (const side of [-1, 1]) {
    yoke.material(0);
    prism(yoke, null, 'x', [[-.19, -.17], [-.19, .10], [.035, .12], [.07, -.12]], side < 0 ? -.42 : .36, side < 0 ? -.36 : .42, .01);
    shaft(yoke, [side * .30, 0, 0], [side * .44, 0, 0], .085, 3, 24);
    shaft(yoke, [side * .44, 0, 0], [side * .458, 0, 0], .055, 4, 24);
    fasteners(yoke, [[side * .462, .037, 0], [side * .462, -.037, 0]], [side, 0, 0], .009);
  }
  const axis = axisFrame([0, 0, -.31], [0, 0, .4]).m;
  lamp.material(0);
  lathe(lamp, axis, [[.20, 0], [.255, .035], [.29, .10], [.30, .56], [.32, .59], [.32, .66], [.285, .66], [.277, .56], [.22, .12]], 48, { caps: [false, false], hullProfile: null });
  shaft(lamp, [0, 0, -.315], [0, 0, -.29], .20, 1, 40);
  collar(lamp, [0, 0, .345], [0, 0, .38], .324, .278, 3, 48);
  collar(lamp, [0, 0, .38], [0, 0, .395], .315, .279, 4, 48);
  lamp.material(7);
  lathe(lamp, axis, [[.065, .16], [.12, .25], [.20, .40], [.276, .56]], 40, { caps: [false, false], hullProfile: null });
  shaft(lamp, [0, 0, .285], [0, 0, .302], .268, 6, 48);
  shaft(lamp, [0, 0, .303], [0, 0, .308], .215, 5, 48);
  fasteners(lamp, Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4) * .297, Math.sin(i * Math.PI / 4) * .297, .398] as Vec3), [0, 0, 1], .011);
  if (lod < 2) {
    for (const z of [-.23, -.17, -.11]) collar(lamp, [0, 0, z], [0, 0, z + .014], .305, .284, 1, 40);
    hose(lamp, [[-.16, .25, -.16], [-.16, .34, -.16], [.16, .34, -.16], [.16, .25, -.16]], .016, 3);
    hose(yoke, [[-.4, -.1, -.1], [-.47, .04, -.16], [-.33, .12, -.28], [-.19, .1, -.31]], .013);
    lamp.material(1); louvres(lamp, mul(translate(0, 0, -.327), rotX(Math.PI / 2)), [.23, .23], 6, { height: .01 });
  }
  const result = [finish(base, 'campaign-watchtower', 'hull', lod), finish(yoke, 'searchlight-yoke', 'searchlight-yoke', lod), finish(lamp, 'searchlight-head', 'searchlight-head', lod)];
  cache.set(lod, result); return result;
}
