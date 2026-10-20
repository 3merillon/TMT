import { box, bolts, mm, rx, tr, Shape } from '../kit/geometry/shapes';
import { applyDir, applyPoint } from '../kit/geometry/math';
import { kitContextOf } from '../kit/assembly';
import { glacisSlope, glacisY } from '../kit/parts/hulls/common';
import { BASTION_ARMOR, BASTION_SKIRT } from '../kit/parts/hulls/bastion';
import type { KitAssembly, PartMesh } from '../kit/types';
import { MAT_ID } from '../kit/types';

/** Four serviceable cassettes, matching the simulation's consumed-section bits. No collision or health here. */
export function reactiveArmorMeshes(assembly: KitAssembly, lod: 0 | 1 | 2, spent = 0): { bit: number; mesh: PartMesh }[] {
  if (assembly.loadout.hull !== 'bastion' || assembly.loadout.armor !== 'reactive') return [];
  const ctx = kitContextOf(assembly);
  const frontStart = ctx.hull.deckFront + .03, frontEnd = ctx.hull.nose[0] - .03;
  const theta = Math.atan(-glacisSlope(ctx.hull, (frontStart + frontEnd) / 2));
  return [1, 2, 4, 8].map(bit => {
    const s = new Shape(); s.detail = [1, .5, .25][lod]; s.noHull = true;
    const block = (m: ReturnType<typeof tr>, size: [number, number, number]) => {
      if (lod === 2) {
        // Below 14 pixels only the exposed cassette face survives; its outline and spacing stay fixed.
        s.material(spent & bit ? MAT_ID.darkSteel : MAT_ID.paint);
        const y = size[1] * (spent & bit ? .19 : 1.1);
        s.mb.poly([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, z]) => applyPoint(m, x * size[0] / 2, y, z * size[2] / 2)), 0, applyDir(m, 0, 1, 0)); return;
      }
      if (lod === 1) { s.material(spent & bit ? MAT_ID.darkSteel : MAT_ID.paint); box(s, mm(m, tr(0, size[1] * .6, 0)), [size[0], size[1] * (spent & bit ? .3 : 1), size[2]], 0); return; }
      s.material(MAT_ID.darkSteel); box(s, m, [size[0] + .015, size[1] * .38, size[2] + .014], 0);
      if (spent & bit) { // Spent tray, blackened backplate and two broken retaining straps.
        for (const side of [-1, 1]) box(s, mm(m, tr(side * size[0] * .42, size[1] * .24, 0)), [.012, .012, size[2]], lod === 0 ? .002 : 0);
        return;
      }
      s.material(MAT_ID.paint); box(s, mm(m, tr(0, size[1] * .6, 0)), size, 0);
      if (lod === 0) { s.material(MAT_ID.gunmetal); bolts(s, m, [[-size[0] * .34, size[1] * 1.12, 0], [size[0] * .34, size[1] * 1.12, 0]], [0, 1, 0], .006, .004); }
    };
    if (bit === 1) for (const side of [-1, 1]) for (const fraction of [.25, .75]) {
      const z = frontStart + (frontEnd - frontStart) * fraction;
      const normal = [0, Math.cos(theta), Math.sin(theta)];
      // Backplate sinks 1 mm into the real applique slab. Both rows follow its current slope and extent.
      const offset = BASTION_ARMOR + .027 * .19 - .001;
      const rowLength = (frontEnd - frontStart) / Math.cos(theta) * .40;
      block(mm(tr(side * (ctx.lowerHalfWidth - .115), glacisY(ctx.hull, z) + normal[1] * offset, z + normal[2] * offset), rx(theta)), [.16, .027, rowLength]);
    }
    if (bit === 2 || bit === 4) {
      const side = bit === 2 ? 1 : -1, x = side * (ctx.beltOuter + BASTION_SKIRT.gap + BASTION_SKIRT.thickness + .028 * .19 - .001);
      // Rotate the cassettes' mounting normal outward; everything remains outside the swept belt width.
      const m = tr(x, .015, 0); m[0] = 0; m[1] = -side; m[4] = side; m[5] = 0;
      for (const z of [-.62, -.32, -.02, .28]) block(mm(m, tr(0, 0, z)), [.10, .028, .23]);
    }
    if (bit === 8) {
      const m = mm(tr(0, .04, ctx.hull.rear - .012), rx(-Math.PI / 2));
      // Central cassette leaves both rear exhaust outlets and tow connections accessible.
      block(m, [.22, .026, .105]);
    }
    const mb = s.mb, attrs = Uint32Array.from(mb.mat.map((mat, i) => ((mb.edge[i] & 255) | (230 << 8) | (mat << 16)) >>> 0));
    return { bit, mesh: { part: `reactive-${bit}`, joint: 'hull', lod, positions: Float32Array.from(mb.p), normals: Float32Array.from(mb.n), partLocal: Float32Array.from(mb.p), primAxis: new Uint32Array(mb.vertexCount), attrs, indices: Uint32Array.from(mb.idx) } };
  });
}
