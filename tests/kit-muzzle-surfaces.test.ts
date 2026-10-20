import { describe, expect, it } from 'vitest';
import { kitContext, kitGeometry } from '../src/game/kit/build';
import { KIT_PART_IDS } from '../src/game/kit/catalog';
import type { MeshBuilder } from '../src/game/kit/geometry/mesh';

type P = [number, number, number];
type Triangle = [P, P, P];
const subtract = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P, b: P): P => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Positive intersection area, rather than matching vertices or overlapping bounds:
 * differently triangulated annuli and partial rectangular caps must also be caught. */
function coplanarOverlap(a: Triangle, b: Triangle): number {
  const raw = cross(subtract(a[1], a[0]), subtract(a[2], a[0])), length = Math.hypot(...raw);
  if (length < 1e-12) return 0;
  const n = raw.map(x => x / length) as P;
  if (b.some(p => Math.abs(dot(n, subtract(p, a[0]))) > 2e-7)) return 0;
  const axis = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
  const u = (axis + 1) % 3, v = (axis + 2) % 3;
  let polygon = a.map(p => [p[u], p[v]]);
  const clip = b.map(p => [p[u], p[v]]);
  const side = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const orientation = Math.sign(side(clip[0], clip[1], clip[2]));
  if (!orientation) return 0;
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const p = clip[edge], q = clip[(edge + 1) % 3], out: number[][] = [];
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i], end = polygon[(i + 1) % polygon.length];
      const ds = orientation * side(p, q, start), de = orientation * side(p, q, end);
      if (ds >= 0) out.push(start);
      if ((ds >= 0) !== (de >= 0)) {
        const t = ds / (ds - de);
        out.push([start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])]);
      }
    }
    polygon = out;
  }
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    twiceArea += p[0] * q[1] - p[1] * q[0];
  }
  return Math.abs(twiceArea) / (2 * Math.abs(n[axis]));
}

function tipTriangles(mesh: MeshBuilder, start: number): Triangle[] {
  const positions = new Float32Array(mesh.p), triangles: Triangle[] = [];
  for (let i = 0; i < mesh.idx.length; i += 3) {
    const tri = mesh.idx.slice(i, i + 3).map(index => Array.from(positions.slice(index * 3, index * 3 + 3)) as P) as Triangle;
    if (tri.some(p => p[2] > start)) triangles.push(tri);
  }
  return triangles;
}

describe('rendered muzzle surface ownership', () => {
  it('detects partial coplanar overlays, but allows adjacent triangles and recessed caps', () => {
    const a: Triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    expect(coplanarOverlap(a, [[.2, .2, 0], [.4, .2, 0], [.2, .4, 0]])).toBeCloseTo(.02, 8);
    expect(coplanarOverlap(a, [[1, 0, 0], [1, 1, 0], [0, 1, 0]])).toBe(0);
    expect(coplanarOverlap(a, a.map(p => [p[0], p[1], .004]) as Triangle)).toBe(0);
  });

  it('has one skin per muzzle plane for every weapon and LOD', () => {
    for (const weapon of KIT_PART_IDS.weapon) for (const lod of [0, 1, 2] as const) {
      const ctx = kitContext({ hull: 'warden', runningGear: 'grip', turret: 'dome', weapon, utility: 'antenna' });
      const triangles = kitGeometry(ctx, lod).groups.get('barrel')!.flatMap(s => tipTriangles(s.mb, ctx.weapon.barrelLength - .15));
      const overlaps: string[] = [];
      for (let a = 0; a < triangles.length; a++) for (let b = a + 1; b < triangles.length; b++) {
        const area = coplanarOverlap(triangles[a], triangles[b]);
        if (area > 1e-9) overlaps.push(`${a}/${b}: ${area.toExponential(3)} m²`);
      }
      expect(overlaps, `${weapon} LOD${lod} overlapping rendered muzzle triangles`).toEqual([]);
    }
  });
});
