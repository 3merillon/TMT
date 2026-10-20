/** Seraphine's Aether survey skimmer. The working Aether crown and arc cannon sit on four ducted lift nacelles. */
import { assembleKit, buildKitMesh, validateKitLoadout } from '../kit';
import { lathe, axisFrame, louvres } from '../kit/geometry/shapes';
import { translate, type Vec3 } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { SERAPHINE_KIT } from '../campaign/vehicle-kits';
import { shape, finish, plate, shaft, collar, fasteners, hose } from './campaign-machining';
const cache = new Map<number, PartMesh[]>();
export function skimmerModel(lod: 0 | 1 | 2): PartMesh[] {
  const old = cache.get(lod); if (old) return old;
  const a = assembleKit(validateKitLoadout(SERAPHINE_KIT)), parts = buildKitMesh(a, lod).parts.filter(p => !p.instances);
  const s = shape(lod);
  // Lift units replace the belt assemblies; bolted outriggers reuse the hull's side mounting envelope.
  for (const side of [-1, 1]) for (const z of [-.47, .45]) {
    const s = shape(lod);
    const x = side * .66;
    plate(s, [side * .47, -.14, z], [.34, .15, .20], 1, .025);
    plate(s, [side * .47, -.054, z], [.26, .028, .15], 0, .008);
    shaft(s, [side * .36, -.19, z], [x, -.25, z], .055, 3);
    s.material(0);
    lathe(s, translate(x, -.42, z), [[.23, 0], [.275, .035], [.28, .18], [.255, .25], [.21, .27], [.195, .23], [.215, .08], [.20, .025], [.23, 0]], 40,
      { caps: [false, false], hullProfile: null });
    collar(s, [x, -.39, z], [x, -.365, z], .279, .218, 3, 40);
    collar(s, [x, -.185, z], [x, -.165, z], .258, .205, 4, 40);
    // Hub, load-bearing stators and a recessed energized annulus; the downward exhaust remains open.
    shaft(s, [x, -.36, z], [x, -.15, z], .058, 3, 24);
    collar(s, [x, -.31, z], [x, -.29, z], .211, .186, 5, 32);
    for (let k = 0; k < 4; k++) {
      const angle = k * Math.PI / 2;
      shaft(s, [x, -.23, z], [x + Math.cos(angle) * .22, -.22, z + Math.sin(angle) * .22], .019, 1, 12);
    }
    fasteners(s, Array.from({ length: 6 }, (_, i) => [x + Math.cos(i * Math.PI / 3) * .236, -.157, z + Math.sin(i * Math.PI / 3) * .236] as Vec3), [0, 1, 0], .009);
    hose(s, [[side * .37, .03, z - .07], [side * .51, .03, z - .07], [x, -.04, z], [x, -.15, z]], .015, 2);
    // Landing shoe below each duct carries the vehicle when power is off.
    for (const offset of [-.16, .16]) shaft(s, [x + offset, -.30, z], [x + offset, -.48, z], .018, 3, 12);
    plate(s, [x, -.48, z], [.39, .04, .09], 1, .01);
    parts.push(finish(s, `lift-${side}-${z}`, 'hull', lod));
  }
  // Belly power distributor and protected longitudinal coolant manifold.
  plate(s, [0, -.23, -.04], [.55, .14, 1.05], 1, .035);
  for (const side of [-1, 1]) {
    hose(s, [[side * .2, -.25, -.5], [side * .3, -.3, -.35], [side * .3, -.3, .32], [side * .2, -.25, .5]], .021, 4);
  }
  s.material(1); louvres(s, axisFrame([0, -.31, -.30], [0, -.4, -.3]).m, [.35, .35], 6);
  const result = [...parts, finish(s, 'aether-lift-cradle', 'hull', lod)]; cache.set(lod, result); return result;
}
