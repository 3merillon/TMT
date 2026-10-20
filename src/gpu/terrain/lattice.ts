import { buildAdaptiveGrid } from '../../core/octree';
import { leaf } from '../../core/fields';
import type { Bounds, Vec3 } from '../../core/types';
import { BRICK_SIDE, CELL_SIDE } from './contracts';
import type { RegionFace } from './contracts';

// Derive, rather than duplicate, octree.ts's face-center/cell-center 24-tet fan.
const template = buildAdaptiveGrid({ fields: [{ id: 'solid', name: 'solid', material: 1, sample: () => -1, range: () => [-1, -1] }],
  expression: leaf('solid'), materials: [] }, { bounds: { min: [0, 0, 0], max: [3, 3, 3] }, maxDepth: 0, minDepth: 0, tolerance: .001, adaptive: false });
if (template.tets.length !== 24) throw new Error('Canonical tetrahedral template changed; resident profile needs review.');

/** `index`: position in `ResidentLattice.tets`; `local`: position in its brick's tet list (page order). */
export interface LatticeTet { id: string; brick: string; vertices: number[]; faces?: RegionFace[]; readonly index: number; readonly local: number }
export interface ResidentLattice {
  positions: Vec3[]; keys: string[]; tets: LatticeTet[]; bricks: Map<string, LatticeTet[]>; bounds: Bounds;
  /** Every tet by id (region.tet), for tet-granular page assembly. */
  readonly tetById: ReadonlyMap<string, LatticeTet>;
  /** CSR adjacency: the tets using position p are tetIndex[tetStart[p] .. tetStart[p+1]). */
  readonly tetStart: Int32Array; readonly tetIndex: Int32Array;
  /** Half-cell sample grid (spacing CELL_SIDE/2): grid[(x*gy+y)*gz+z] = position id, or -1. */
  readonly grid: Int32Array; readonly gridSize: readonly [number, number, number];
  /** Bricks in lattice order, and each brick's order index. */
  readonly brickOrder: readonly string[]; readonly brickIndex: ReadonlyMap<string, number>;
  /** Each brick's cell AABB (clamped to the lattice), aligned with brickOrder. */
  readonly brickBoxes: readonly Bounds[];
}
const HALF = CELL_SIDE / 2;
export function residentLattice(bounds: Bounds): ResidentLattice {
  if ([...bounds.min, ...bounds.max].some(x => x % CELL_SIDE) || bounds.min.some((x, i) => x >= bounds.max[i])) throw new Error('Resident bounds must be ordered side-3 cell coordinates.');
  const positions: Vec3[] = [], keys: string[] = [], ids = new Map<string, number>(), tets: LatticeTet[] = [], bricks = new Map<string, LatticeTet[]>();
  for (let x = bounds.min[0]; x < bounds.max[0]; x += CELL_SIDE)
    for (let y = bounds.min[1]; y < bounds.max[1]; y += CELL_SIDE)
      for (let z = bounds.min[2]; z < bounds.max[2]; z += CELL_SIDE) {
        const origin = [x, y, z], brick = origin.map(v => Math.floor(v / BRICK_SIDE)).join(',');
        const local = template.vertices.map(p => {
          const q = p.map((v, a) => v + origin[a]) as Vec3, key = q.map(v => v * 2 / CELL_SIDE).join(',');
          let id = ids.get(key);
          if (id === undefined) { id = positions.length; positions.push(q); keys.push(key); ids.set(key, id); }
          return id;
        });
        template.tets.forEach((t, i) => {
          const vertices = t.map(v => local[v]);
          const page = bricks.get(brick) ?? [];
          const tet: LatticeTet = { id: `${origin.join(',')}/${i}`, brick, vertices, index: tets.length, local: page.length };
          tets.push(tet); page.push(tet); bricks.set(brick, page);
        });
      }
  const tetById = new Map(tets.map(t => [t.id, t]));
  const counts = new Int32Array(positions.length + 1);
  for (const tet of tets) for (const v of tet.vertices) counts[v + 1]++;
  for (let i = 0; i < positions.length; i++) counts[i + 1] += counts[i];
  const tetStart = counts.slice(), fill = counts.slice(0, positions.length), tetIndex = new Int32Array(tets.length * 4);
  for (const tet of tets) for (const v of tet.vertices) tetIndex[fill[v]++] = tet.index;
  const gridSize = [0, 1, 2].map(a => Math.round((bounds.max[a] - bounds.min[a]) / HALF) + 1) as [number, number, number];
  const grid = new Int32Array(gridSize[0] * gridSize[1] * gridSize[2]).fill(-1);
  positions.forEach((p, id) => { const g = p.map((v, a) => Math.round((v - bounds.min[a]) / HALF)); grid[(g[0] * gridSize[1] + g[1]) * gridSize[2] + g[2]] = id; });
  const brickOrder = [...bricks.keys()], brickIndex = new Map(brickOrder.map((b, i) => [b, i]));
  const brickBoxes = brickOrder.map(brick => cellBox(bounds, brick));
  return { positions, keys, tets, bricks, bounds, tetById, tetStart, tetIndex, grid, gridSize, brickOrder, brickIndex, brickBoxes };
}
/** Visit the position ids inside the closed box through the half-cell grid (no scan over the lattice). */
export function positionsInBox(lattice: ResidentLattice, box: Bounds, visit: (id: number) => void): void {
  const { bounds, grid, gridSize } = lattice, lo = [0, 0, 0], hi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    lo[a] = Math.max(0, Math.ceil((box.min[a] - bounds.min[a]) / HALF));
    hi[a] = Math.min(gridSize[a] - 1, Math.floor((box.max[a] - bounds.min[a]) / HALF));
    if (!(lo[a] <= hi[a])) return;
  }
  for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) {
    const row = (x * gridSize[1] + y) * gridSize[2];
    for (let z = lo[2]; z <= hi[2]; z++) { const id = grid[row + z]; if (id >= 0) visit(id); }
  }
}
/** Bricks whose cells overlap the closed box, in lattice brick order. */
export function bricksInBox(lattice: ResidentLattice, box: Bounds): string[] {
  const result: string[] = [];
  lattice.brickBoxes.forEach((b, i) => { if (b.min.every((v, a) => v <= box.max[a]) && b.max.every((v, a) => v >= box.min[a])) result.push(lattice.brickOrder[i]); });
  return result;
}
/** A brick's cell AABB, clamped to the lattice. */
export function brickBox(lattice: ResidentLattice, brick: string): Bounds {
  const index = lattice.brickIndex.get(brick);
  return index === undefined ? cellBox(lattice.bounds, brick) : lattice.brickBoxes[index];
}
function cellBox(bounds: Bounds, brick: string): Bounds {
  const key = brick.split(',').map(Number);
  return { min: key.map((k, a) => Math.max(k * BRICK_SIDE, bounds.min[a])) as Vec3, max: key.map((k, a) => Math.min((k + 1) * BRICK_SIDE, bounds.max[a])) as Vec3 };
}
