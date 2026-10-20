/** Cheap swarm chassis: compact final drives, continuous tread envelope and an articulated sensor/gun cupola. */
import { prism, louvres } from '../kit/geometry/shapes';
import { mul, rotZ, translate, type Vec3 } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { shape, finish, plate, shaft, collar, fasteners, hose } from './campaign-machining';
import { CAMPAIGN_COAX } from '../realtime/fixtures';
const cache = new Map<number, PartMesh[]>();
export function rustlingModel(lod: 0 | 1 | 2): PartMesh[] {
  const old = cache.get(lod); if (old) return old;
  const s = shape(lod), gun = shape(lod);
  const drives: PartMesh[] = [];
  s.material(0);
  prism(s, null, 'x', [[-.35, -.44], [-.11, -.44], [.10, -.25], [.10, .22], [-.04, .44], [-.35, .44]], -.28, .28, .035);
  plate(s, [0, -.27, 0], [.60, .09, .80], 1, .025);
  plate(s, [0, -.48, 0], [.20, .04, .40], 1, .008);
  // Two continuous rubber/steel belts: tread faces form a closed perimeter around the road wheels.
  for (const side of [-1, 1]) {
    const s = shape(lod);
    const x = side * .36, profile: [number, number][] = [];
    for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + i * Math.PI / 6; profile.push([-.31 + Math.sin(a) * .18, .27 + Math.cos(a) * .18]); }
    for (let i = 0; i <= 6; i++) { const a = Math.PI / 2 + i * Math.PI / 6; profile.push([-.31 + Math.sin(a) * .18, -.27 + Math.cos(a) * .18]); }
    s.material(2); prism(s, null, 'x', profile, x - .10, x + .10);
    for (const z of [-.27, 0, .27]) {
      shaft(s, [x - side * .11, -.31, z], [x + side * .112, -.31, z], .135, 1, 24);
      collar(s, [x + side * .113, -.31, z], [x + side * .127, -.31, z], .112, .075, 3, 24);
      shaft(s, [x + side * .11, -.31, z], [x + side * .14, -.31, z], .059, 4, 16);
      fasteners(s, Array.from({ length: 4 }, (_, i) => [x + side * .145, -.31 + Math.cos(i * Math.PI / 2) * .086, z + Math.sin(i * Math.PI / 2) * .086] as Vec3), [side, 0, 0], .009);
    }
    if (!s.coarse) for (let i = 0; i < profile.length; i++) {
      const a = profile[i], b = profile[(i + 1) % profile.length], count = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / .085));
      for (let k = 0; k < count; k++) {
        const f = k / count, y = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
        shaft(s, [x - .104, y, z], [x + .104, y, z], .012, 3, 8);
      }
    }
    plate(s, [x, -.102, 0], [.23, .045, .84], 0, .012);
    plate(s, [side * .288, -.10, -.12], [.018, .17, .33], 1, .008);
    s.material(3); louvres(s, mul(translate(side * .299, -.10, -.12), rotZ(-side * Math.PI / 2)), [.11, .28], 4);
    hose(s, [[side * .20, .08, -.26], [side * .25, .13, -.29], [side * .29, .02, -.36]], .013, 4);
    fasteners(s, [[side * .24, .108, -.18], [side * .24, .108, .12]], [0, 1, 0], .013);
    drives.push(finish(s, `rustling-drive-${side}`, 'hull', lod));
  }
  plate(s, [0, .105, -.22], [.31, .035, .22], 1, .015);
  s.material(3); louvres(s, translate(0, .128, -.23), [.24, .16], 4);
  shaft(s, [0, .07, -.08], [0, .20, -.08], .18, 1, 32);
  collar(s, [0, .15, -.08], [0, .20, -.08], .19, .15, 4, 32);
  // Turret-local Y=.35 places this barrel exactly at the shared coax source Y=.55.
  shaft(gun, [0, 0, 0], [0, .12, 0], .11, 3, 24);
  collar(gun, [0, .01, 0], [0, .035, 0], .148, .11, 1, 24);
  plate(gun, [0, .20, .08], [.29, .25, .32], 0, .04);
  plate(gun, [0, .27, .19], [.25, .11, .04], 1, .012);
  for (const x of [-.075, .075]) {
    shaft(gun, [x, .28, .211], [x, .28, .236], .035, 3, 16);
    shaft(gun, [x, .28, .237], [x, .28, .243], .024, 5, 16);
  }
  shaft(gun, [0, .35, .10], [0, .35, .29], .044, 3, 24);
  collar(gun, [0, .35, .29], [0, CAMPAIGN_COAX.rustling.height, CAMPAIGN_COAX.rustling.forward], .045, .019, 1, 24);
  fasteners(gun, [[-.10, .333, .05], [.10, .333, .05]], [0, 1, 0], .01);
  const result = [finish(s, 'campaign-rustling', 'hull', lod), finish(gun, 'rustling-cupola', 'turret', lod), ...drives];
  cache.set(lod, result); return result;
}
