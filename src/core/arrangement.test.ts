import { describe, expect, it } from 'vitest';
import { meshArrangement, meshArrangementMany } from './arrangement';
import { fromNumber, toNumber, add, sub, mul, div, compare } from './exact';
import { evaluateSigns, intersection, union, validateScene, withMaterial } from './fields';
import type { Field, Scene, TetMesh, Vec3, Expr, SurfaceMesh } from './types';

const leaf = (id: string): Expr => ({ op: 'leaf', id });
function field(id: string, sample: (p: Vec3) => number, material = 1): Field { return { id, name: id, sample, material }; }
function scene(fields: Field[], expression: Expr): Scene { return { fields, expression, materials: [] }; }
function cube(): TetMesh {
  return {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]],
    tets: [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]], leaves: [],
    stats: { leaves: 1, activeLeaves: 1, tetrahedra: 6, vertices: 8, depthHistogram: { 0: 1 }, unresolvedCells: 0, uncertifiedCells: 0, maxInterpolationError: 0, milliseconds: 0 },
  };
}
function volume(mesh: SurfaceMesh): number {
  return mesh.triangles.reduce((v, [i, j, k]) => {
    const a = mesh.positions[i], b = mesh.positions[j], c = mesh.positions[k];
    return v + (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }, 0);
}
function closed(mesh: SurfaceMesh): void {
  const edges = new Map<string, number[]>();
  for (const t of mesh.triangles) for (let i = 0; i < 3; i++) {
    const a = t[i], b = t[(i + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
    const uses = edges.get(key) ?? []; uses.push(a < b ? 1 : -1); edges.set(key, uses);
  }
  for (const uses of edges.values()) { expect(uses.length).toBe(2); expect(uses[0] + uses[1]).toBe(0); }
}

describe('exact arithmetic', () => {
  it('preserves finite IEEE values including subnormals', () => {
    for (const x of [0, -0, 0.1, -Math.PI, Number.MIN_VALUE, 2 ** -1022, 1e200, Number.MAX_VALUE]) expect(toNumber(fromNumber(x))).toBe(x === 0 ? 0 : x);
  });
  it('keeps cancellation and distinct sub-epsilon geometry exact', () => {
    const a = fromNumber(0.1), b = fromNumber(0.2);
    expect(compare(sub(add(a, b), b), a)).toBe(0);
    expect(compare(div(mul(a, b), b), a)).toBe(0);
    expect(() => fromNumber(Infinity)).toThrow();
  });
});
describe('exact Boolean tetrahedral arrangement', () => {
  it('labels occupied regions and chooses either overlapping material without changing occupancy', () => {
    const fields = [field('a', () => -1, 1), field('b', () => -1, 2)];
    for (const operation of [union, intersection]) {
      expect(evaluateSigns(scene(fields, operation(leaf('a'), leaf('b'))), [-1, -1])).toBe(1);
      expect(evaluateSigns(scene(fields, operation(leaf('a'), leaf('b'), 'right')), [-1, -1])).toBe(2);
    }
    const labeled = scene(fields, withMaterial(intersection(leaf('a'), leaf('b')), 3));
    expect(evaluateSigns(labeled, [-1, -1])).toBe(3);
    expect(evaluateSigns(labeled, [-1, 1])).toBe(0);
    expect(() => validateScene(scene(fields, withMaterial(leaf('a'), 0)))).toThrow('positive integers');
    expect(() => validateScene(scene(fields, withMaterial(leaf('missing'), 3)))).toThrow('Unknown field');
  });
  it('retains labeled interface materials and occupied exterior materials independently of primitive appearance', () => {
    const fields = [field('a', ([x]) => x - 0.5, 1), field('b', ([x]) => 0.5 - x, 2)];
    const mesh = meshArrangement(cube(), scene(fields, union(withMaterial(leaf('a'), 3), withMaterial(leaf('b'), 4))));
    expect(new Set(mesh.faceMaterials)).toEqual(new Set([3, 4]));
    expect(mesh.faceSourceMaterials.length).toBe(mesh.triangles.length);
    expect(mesh.interfaces!.length).toBeGreaterThan(0);
    for (const face of mesh.interfaces!) expect(new Set(face.materials)).toEqual(new Set([3, 4]));
    expect(volume(mesh)).toBeCloseTo(1, 12); closed(mesh);
  });
  it('cancels all shared tetrahedron facets and orients a full cube', () => {
    const mesh = meshArrangement(cube(), scene([field('a', () => -1)], leaf('a')));
    expect(volume(mesh)).toBeCloseTo(1, 12); closed(mesh);
  });
  it('clips exact planes including a zero plane on grid vertices', () => {
    const mesh = meshArrangement(cube(), scene([field('a', ([x, y]) => x - y)], leaf('a')));
    expect(volume(mesh)).toBeCloseTo(0.5, 12); closed(mesh);
  });
  it('retains sharp intersections and difference cutter provenance', () => {
    const mesh = meshArrangement(cube(), scene([field('a', ([x]) => x - 0.75), field('b', ([, y]) => y - 0.25, 2)], { op: 'difference', left: leaf('a'), right: leaf('b') }));
    expect(volume(mesh)).toBeCloseTo(0.75 * 0.75, 12); closed(mesh);
    expect(mesh.faceSources).toContain('b');
    mesh.faceSources.forEach((source, i) => {
      if (source === 'b') {
        expect(mesh.faceMaterials[i]).toBe(1);
        expect(mesh.faceSourceMaterials[i]).toBe(2);
      }
    });
  });
  it('handles coincident operands without duplicate shells', () => {
    const fields = [field('a', ([x]) => x - 0.5), field('b', ([x]) => x - 0.5)];
    const union = meshArrangement(cube(), scene(fields, { op: 'union', left: leaf('a'), right: leaf('b') }));
    expect(volume(union)).toBeCloseTo(0.5, 12); closed(union);
    expect(meshArrangement(cube(), scene(fields, { op: 'difference', left: leaf('a'), right: leaf('b') })).triangles).toHaveLength(0);
  });
  it('regularizes face-only contact and treats zero plateaus consistently', () => {
    const fields = [field('a', ([x]) => x - 0.5), field('b', ([x]) => 0.5 - x)];
    expect(meshArrangement(cube(), scene(fields, { op: 'intersection', left: leaf('a'), right: leaf('b') })).triangles).toHaveLength(0);
    const union = meshArrangement(cube(), scene(fields, { op: 'union', left: leaf('a'), right: leaf('b') }));
    expect(volume(union)).toBeCloseTo(1, 12); closed(union);
    const plateau = meshArrangement(cube(), scene([field('z', () => 0)], leaf('z')));
    expect(volume(plateau)).toBeCloseTo(1, 12); closed(plateau);
  });
  it('retains a slab far thinner than conventional clipping epsilons', () => {
    const thickness = 2 ** -35;
    const fields = [field('a', ([x]) => x - (0.5 + thickness)), field('b', ([x]) => x - 0.5)];
    const mesh = meshArrangement(cube(), scene(fields, { op: 'difference', left: leaf('a'), right: leaf('b') }));
    expect(volume(mesh) / thickness).toBeCloseTo(1, 5); closed(mesh);
  });
  it('records an internal interface between different occupied materials', () => {
    const fields = [field('a', ([x]) => x - 0.5, 1), field('b', ([x]) => 0.5 - x, 2)];
    const mesh = meshArrangement(cube(), scene(fields, { op: 'union', left: leaf('a'), right: leaf('b') }));
    expect(mesh.interfaces!.length).toBeGreaterThan(0);
    expect(volume(mesh)).toBeCloseTo(1, 12); closed(mesh);
  });
  it('splits a sphere into complementary crater and debris meshes with matching opposite seams', () => {
    const grid = cube(), base = cube(), resolution = 4;
    grid.vertices = []; grid.tets = [];
    const vertexMap = new Map<string, number>();
    for (let x = 0; x < resolution; x++) for (let y = 0; y < resolution; y++) for (let z = 0; z < resolution; z++) {
      const local = base.vertices.map(p => {
        const point: Vec3 = [(p[0] + x) / resolution, (p[1] + y) / resolution, (p[2] + z) / resolution];
        const key = point.join(','); let id = vertexMap.get(key);
        if (id === undefined) { id = grid.vertices.length; grid.vertices.push(point); vertexMap.set(key, id); }
        return id;
      });
      grid.tets.push(...base.tets.map(t => t.map(i => local[i]) as [number, number, number, number]));
    }
    const fields = [field('planet', ([x, y, z]) => (x - 0.5) ** 2 + (y - 0.5) ** 2 + (z - 0.5) ** 2 - 0.45 ** 2),
      field('cutter', ([x, y, z]) => (x - 0.7) ** 2 + (y - 0.5) ** 2 + (z - 0.5) ** 2 - 0.3 ** 2, 2)];
    const [whole, remaining, removed] = meshArrangementMany(grid, [scene(fields, leaf('planet')),
      scene(fields, { op: 'difference', left: leaf('planet'), right: leaf('cutter') }),
      scene(fields, { op: 'intersection', left: leaf('planet'), right: leaf('cutter') })]);
    expect(volume(remaining) + volume(removed)).toBeCloseTo(volume(whole), 12);
    closed(whole); closed(remaining); closed(removed);
    const seam = (mesh: SurfaceMesh): Map<string, number> => {
      const result = new Map<string, number>();
      mesh.triangles.forEach((t, i) => {
        if (mesh.faceSources[i] !== 'cutter') return;
        const keys = t.map(v => mesh.positions[v].join(','));
        const sorted = [...keys].sort();
        const permutation = keys.map(k => sorted.indexOf(k));
        const inversions = Number(permutation[0] > permutation[1]) + Number(permutation[0] > permutation[2]) + Number(permutation[1] > permutation[2]);
        result.set(sorted.join('|'), inversions % 2 === 0 ? 1 : -1);
      });
      return result;
    };
    const a = seam(remaining), b = seam(removed);
    expect(a.size).toBeGreaterThan(0); expect(a.size).toBe(b.size);
    for (const [key, winding] of a) expect(b.get(key)).toBe(-winding);
  });
});
