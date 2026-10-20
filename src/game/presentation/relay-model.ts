/** Field relay: skid-mounted generator, telescoping antenna and a braced parabolic receiver. */
import { lathe, axisFrame, louvres } from '../kit/geometry/shapes';
import { translate, rotZ, mul } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { shape, finish, plate, shaft, collar, fasteners, hose } from './campaign-machining';
const cache = new Map<number, PartMesh[]>();
export function relayModel(lod: 0 | 1 | 2): PartMesh[] {
  const old = cache.get(lod); if (old) return old;
  let s = shape(lod);
  for (const side of [-1, 1]) {
    plate(s, [side * .49, -.43, 0], [.19, .14, 1.45], 1, .04);
    for (const z of [-.47, .47]) {
      plate(s, [side * .49, -.23, z], [.12, .28, .13], 3);
      shaft(s, [side * .49, -.16, z], [side * .49, -.09, z], .075, 2);
    }
  }
  plate(s, [0, .17, 0], [1.08, .57, 1.18], 0, .055);
  plate(s, [0, .16, .596], [.90, .40, .02], 2);
  plate(s, [0, .16, .614], [.85, .36, .025], 0, .014);
  for (const x of [-.34, .34]) {
    shaft(s, [x, .07, .642], [x, .25, .642], .016, 3, 12);
    fasteners(s, [[x, .02, .632], [x, .30, .632]], [0, 0, 1], .012);
  }
  plate(s, [0, .3, .636], [.22, .045, .012], 4, .003);
  for (const side of [-1, 1]) {
    // Service grille on either side and a grab handle bolted above it.
    s.material(1); louvres(s, mul(translate(side * .549, .18, -.04), rotZ(-side * Math.PI / 2)), [.30, .66], 8);
    hose(s, [[side * .50, .43, .26], [side * .50, .52, .26], [side * .50, .52, -.02], [side * .50, .43, -.02]], .022, 3);
    for (const z of [-.35, .32]) fasteners(s, [[side * .45, .466, z]], [0, 1, 0], .014);
    shaft(s, [side * .38, .44, -.39], [side * .08, 1.12, -.32], .033, 3);
  }
  // Exhaust with heat guard, insulated feeder and bolted mast saddle.
  const base = s; s = shape(lod);
  shaft(s, [.39, .12, -.48], [.39, .75, -.48], .055, 1);
  collar(s, [.39, .60, -.48], [.39, .74, -.48], .072, .056, 3, 24);
  plate(s, [0, .49, -.32], [.38, .09, .35], 1);
  shaft(s, [0, .50, -.32], [0, 1.08, -.32], .082, 3);
  collar(s, [0, 1.02, -.32], [0, 1.10, -.32], .102, .081, 4);
  shaft(s, [0, 1.06, -.32], [0, 1.20, -.52], .048, 3);
  shaft(s, [0, 1.20, -.52], [0, 1.36, -.52], .048, 3);
  shaft(s, [0, 1.36, -.55], [0, 1.36, -.36], .052, 3);
  collar(s, [0, 1.36, -.42], [0, 1.36, -.38], .085, .052, 4);
  // A hollow paraboloid, facing forward: actual dish rim, back skin and a supported feed horn.
  const dish = axisFrame([0, 1.36, -.38], [0, 1.36, .1]).m;
  s.material(0); lathe(s, dish, [[.055, 0], [.13, .02], [.26, .09], [.40, .23], [.43, .27], [.43, .29], [.40, .25], [.26, .11], [.13, .045], [.055, .025]], 48, { caps: [false, false], hullProfile: null });
  collar(s, [0, 1.36, -.12], [0, 1.36, -.085], .438, .405, 4, 48);
  for (const angle of [0, 2 * Math.PI / 3, 4 * Math.PI / 3]) {
    const x = Math.cos(angle), y = Math.sin(angle);
    shaft(s, [x * .39, 1.36 + y * .39, -.115], [x * .05, 1.36 + y * .05, .12], .012, 1, 12);
  }
  shaft(s, [0, 1.36, .08], [0, 1.36, .19], .047, 3, 24);
  collar(s, [0, 1.36, .18], [0, 1.36, .205], .057, .032, 4, 24);
  hose(s, [[0, 1.36, .12], [.10, 1.22, -.15], [.12, .95, -.32], [.20, .56, -.33]], .013);
  shaft(s, [-.36, .44, -.38], [-.36, 1.85, -.38], .016, 3, 12);
  for (const y of [1.15, 1.46, 1.77]) shaft(s, [-.56, y, -.38], [-.16, y, -.38], .012, 3, 12);
  // Two protected service/status lamps, not unmounted glowing blocks.
  for (const x of [-.34, .34]) { shaft(s, [x, .38, .58], [x, .38, .66], .045, 1); shaft(s, [x, .38, .661], [x, .38, .669], .028, 5); }
  const result = [finish(base, 'campaign-relay', 'hull', lod), finish(s, 'relay-mast', 'hull', lod)]; cache.set(lod, result); return result;
}
