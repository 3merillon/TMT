/** Bolt-on drive cases, mortar-feed drums and a sliding furnace shutter on the physical Forge chassis. */
import type { TankComponent } from '../contracts';
import { Shape, box, cylinder, bolts } from '../kit/geometry/shapes';
import { translate, type Vec3 } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { finish } from './campaign-machining';
const cache = new Map<string, PartMesh[]>();
export function componentMeshes(components: readonly TankComponent[], lod: 0 | 1 | 2): PartMesh[] {
  const key = `${lod}:${components.map(c => `${c.id}/${c.offset}/${c.radius}`).join(';')}`;
  const old = cache.get(key); if (old) return old;
  const meshes: PartMesh[] = [];
  for (const component of components) {
    const s = new Shape(); s.noHull = true; s.detail = [1, .5, .25][lod];
    const [x, y, z] = component.offset, r = component.radius * .85, side = Math.sign(x) || 1;
    const block = (p: Vec3, size: Vec3, mat = 3) => { s.material(mat); box(s, translate(...p), size, .015); };
    const rod = (a: Vec3, b: Vec3, radius: number, mat = 4) => { s.material(mat); cylinder(s, null, a, b, radius, 16); };
    if (component.kind === 'drive') {
      block([x - side * .13, y, z], [.22, r * 1.8, r * 1.8]);
      rod([x - side * .06, y, z], [x + side * .07, y, z], r);
      rod([x + side * .071, y, z], [x + side * .085, y, z], r * .65, 1);
      if (lod === 0) {
        s.material(4); bolts(s, null, Array.from({ length: 6 }, (_, i) => [x + side * .09, y + Math.cos(i * Math.PI / 3) * r * .78, z + Math.sin(i * Math.PI / 3) * r * .78] as Vec3), [side, 0, 0], .018, .012);
      }
    } else if (component.kind === 'weapon') {
      block([x, y - r, z], [.28, .1, .38], 1);
      rod([x, y, z - .15], [x, y, z + .15], r, 4);
      rod([x, y, z + .151], [x, y, z + .17], r * .7, 3);
      rod([x - side * .25, y - .08, z], [x, y - .08, z], .055, 1);
    } else {
      rod([x, y, z - .15], [x, y, z + .08], r, 3);
      rod([x, y, z - .17], [x, y, z - .15], r * .7, 5);
      for (const sign of [-1, 1]) block([x + sign * .3, y + .23, z - .2], [.045, .95, .06], 1);
      const shutter = new Shape(); shutter.noHull = true; shutter.material(1);
      box(shutter, translate(x, y, z - .24), [.52, .55, .06], .02);
      meshes.push(finish(shutter, 'component:core-shutter', 'machinery-core-shutter', lod));
    }
    meshes.push(finish(s, `component:${component.id}`, 'hull', lod));
  }
  cache.set(key, meshes); return meshes;
}
