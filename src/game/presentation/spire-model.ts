/** Rust recycler: braced column, ceramic-insulated induction stack, armoured control cabinet and grounded feet. */
import { lathe, louvres } from '../kit/geometry/shapes';
import { translate, mul, rotZ } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { shape, finish, plate, shaft, collar, fasteners, hose } from './campaign-machining';
import { CAMPAIGN_COAX } from '../realtime/fixtures';
const cache = new Map<number, PartMesh[]>();
export function spireModel(lod: 0 | 1 | 2): PartMesh[] {
  const old = cache.get(lod); if (old) return old;
  const s = shape(lod), gun = shape(lod);
  plate(s, [0, -.36, 0], [1.2, .23, 1.2], 1, .045);
  plate(s, [0, -.20, 0], [.95, .12, .95], 0, .03);
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    plate(s, [x * .57, -.46, z * .57], [.34, .08, .34], 3, .018);
    fasteners(s, [[x * .64, -.412, z * .64]], [0, 1, 0], .026);
    shaft(s, [x * .53, -.40, z * .53], [x * .28, .65, z * .28], .054, 1, 20);
    shaft(s, [x * .28, -.12, z * .28], [x * .28, 1.64, z * .28], .043, 3, 20);
    collar(s, [x * .28, 1.43, z * .28], [x * .28, 1.54, z * .28], .065, .043, 4, 24);
    plate(s, [x * .28, 1.68, z * .28], [.17, .12, .17], 0, .02);
    fasteners(s, [[x * .28, 1.745, z * .28]], [0, 1, 0], .018);
    hose(s, [[x * .23, -.15, z * .23], [x * .38, .05, z * .26], [x * .37, .42, z * .27], [x * .26, .62, z * .26]], .024, 2);
  }
  // Octagonal lower pressure case, service hatches and plated heat exchanger.
  shaft(s, [0, -.15, 0], [0, .62, 0], .29, 0, 8);
  for (const side of [-1, 1]) {
    plate(s, [side * .298, .20, 0], [.025, .51, .35], 1, .012);
    s.material(3); louvres(s, mul(translate(side * .315, .20, 0), rotZ(-side * Math.PI / 2)), [.42, .29], 7);
    plate(s, [side * .12, .29, .288], [.18, .36, .025], 0, .012);
    fasteners(s, [[side * .12, .13, .307], [side * .12, .45, .307]], [0, 0, 1], .012);
  }
  // The exposed insulator spine supports a stack of hollow copper induction coils.
  s.material(6); lathe(s, translate(0, .55, 0), [[.16, 0], [.19, .06], [.14, .14], [.19, .22], [.14, .30], [.19, .38], [.14, .46], [.19, .54], [.14, .62], [.19, .70], [.16, .78]], 32);
  for (let i = 0; i < 4; i++) {
    const y = .64 + i * .24;
    collar(s, [0, y, 0], [0, y + .075, 0], .36, .22, 4, 40);
    collar(s, [0, y + .025, 0], [0, y + .05, 0], .365, .35, 1, 40);
    for (const side of [-1, 1]) shaft(s, [side * .28, y - .015, .28], [side * .18, y + .03, .17], .018, 3, 12);
  }
  shaft(s, [0, 1.35, 0], [0, 1.75, 0], .12, 3, 24);
  collar(s, [0, 1.62, 0], [0, 1.74, 0], .24, .13, 1, 32);
  shaft(s, [0, 1.74, 0], [0, 1.91, 0], .10, 5, 24);
  for (const side of [-1, 1]) {
    shaft(s, [side * .23, 1.66, 0], [side * .16, 2.03, 0], .026, 4, 16);
    shaft(s, [0, 1.66, side * .23], [0, 2.03, side * .16], .026, 4, 16);
  }
  plate(s, [0, .45, .32], [.17, .07, .03], 4, .008);
  // Small automated defence head; orientation follows the turret/coax aim.
  plate(gun, [0, .30, .32], [.20, .16, .22], 1, .025);
  shaft(gun, [0, .35, .32], [0, .35, .52], .037, 3, 24);
  collar(gun, [0, .35, .52], [0, CAMPAIGN_COAX.spire.height, CAMPAIGN_COAX.spire.forward], .043, .018, 1, 24);
  const result = [finish(s, 'campaign-spire', 'hull', lod), finish(gun, 'spire-defence', 'turret', lod)]; cache.set(lod, result); return result;
}
