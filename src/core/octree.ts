/** Shared face patches and a global edge registry make octree transitions conforming. */
import { fieldRange, validateScene } from './fields';
import type { Bounds, GridOptions, GridStats, OctreeLeaf, Scene, Tet, TetMesh, Vec3 } from './types';

interface Node { origin: Vec3; size: number; depth: number; children?: Node[]; leaf?: number }
interface Patch { axis: number; coordinate: number; u: number; v: number; size: number; cells: Set<number> }
const axes = (axis: number): [number, number] => [(axis + 1) % 3, (axis + 2) % 3];
const key3 = (p: Vec3): string => p.join(',');

export function buildAdaptiveGrid(scene: Scene, options: GridOptions): TetMesh {
  const started = performance.now();
  validateScene(scene);
  const { bounds, maxDepth, tolerance } = options;
  const minDepth = options.minDepth ?? 1;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 7) throw new Error('maxDepth must be an integer between 0 and 7.');
  if (!Number.isInteger(minDepth) || minDepth < 0 || minDepth > maxDepth) throw new Error('Invalid minDepth.');
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) throw new Error('Tolerance must be finite and positive.');
  if (bounds.min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(bounds.max[i]) || bounds.max[i] <= v)) throw new Error('Invalid bounds.');
  const resolution = 2 ** maxDepth;
  const world = (p: Vec3): Vec3 => p.map((v, i) => bounds.min[i] + v / resolution * (bounds.max[i] - bounds.min[i])) as Vec3;
  const leaves: OctreeLeaf[] = [];
  const stats: GridStats = { leaves: 0, activeLeaves: 0, tetrahedra: 0, vertices: 0, depthHistogram: {}, unresolvedCells: 0, uncertifiedCells: 0, maxInterpolationError: 0, milliseconds: 0 };

  function grow(origin: Vec3, size: number, depth: number): Node {
    const node: Node = { origin, size, depth };
    const b: Bounds = { min: world(origin), max: world(origin.map(v => v + size) as Vec3) };
    const relevant = scene.fields.filter(f => { const [lo, hi] = fieldRange(f, b); return lo <= 0 && hi >= 0; });
    const active = relevant.length > 0;
    let maxError = 0, hidden = false, uncertified = false;
    for (const f of relevant) {
      const error = f.interpolationError?.(b) ?? Infinity;
      if (Number.isNaN(error) || error < 0) throw new Error(`Invalid error bound from ${f.id}`);
      maxError = Math.max(maxError, error);
      if (!f.range || !f.interpolationError) uncertified = true;
      // For affine planes all extrema are at corners; curved/custom fields can hide inside.
      if (error > 1e-12) {
        const signs = Array.from({ length: 8 }, (_, k) => {
          const p = b.min.map((v, i) => k & (1 << i) ? b.max[i] : v) as Vec3;
          const value = f.sample(p);
          if (!Number.isFinite(value)) throw new Error(`Non-finite sample from ${f.id}`);
          return Math.sign(value);
        });
        if (signs.every(s => s > 0) || signs.every(s => s < 0)) hidden = true;
      }
    }
    const wantsRefine = depth < minDepth || (options.adaptive === false) || (active && (maxError > tolerance || hidden)) || !!options.refine?.(b, depth);
    if (depth < maxDepth && wantsRefine) {
      const half = size / 2;
      node.children = Array.from({ length: 8 }, (_, k) => grow(origin.map((v, i) => v + ((k & (1 << i)) ? half : 0)) as Vec3, half, depth + 1));
    } else {
      node.leaf = leaves.length;
      leaves.push({ ...b, origin, size, depth, active });
      stats.depthHistogram[depth] = (stats.depthHistogram[depth] ?? 0) + 1;
      if (active) {
        stats.activeLeaves++;
        stats.maxInterpolationError = Math.max(stats.maxInterpolationError, maxError);
        if (maxError > tolerance || hidden) stats.unresolvedCells++;
        if (uncertified) stats.uncertifiedCells++;
      }
    }
    return node;
  }
  const root = grow([0, 0, 0], resolution, 0);
  if (options.requireResolved && (stats.unresolvedCells || stats.uncertifiedCells)) {
    throw new Error(`Unresolved field approximation: ${stats.unresolvedCells} depth-limited cells, ${stats.uncertifiedCells} uncertified cells. Increase maxDepth or supply conservative field bounds.`);
  }
  function find(p: Vec3): number | undefined {
    if (p.some(v => v < 0 || v >= resolution)) return undefined;
    let n = root;
    while (n.children) {
      let k = 0;
      for (let a = 0; a < 3; a++) if (p[a] >= n.origin[a] + n.size / 2) k |= 1 << a;
      n = n.children[k];
    }
    return n.leaf;
  }

  const patches = new Map<string, Patch>();
  function addPatch(cell: number, axis: number, coordinate: number, u: number, v: number, size: number, direction: number): void {
    const [ua, va] = axes(axis);
    const probe: Vec3 = [0, 0, 0]; probe[axis] = coordinate + direction * 0.25; probe[ua] = u + size / 2; probe[va] = v + size / 2;
    const neighbor = find(probe);
    if (neighbor !== undefined && leaves[neighbor].size < size) {
      const h = size / 2;
      for (let k = 0; k < 4; k++) addPatch(cell, axis, coordinate, u + (k & 1 ? h : 0), v + (k & 2 ? h : 0), h, direction);
      return;
    }
    const key = `${axis}/${coordinate}/${u}/${v}/${size}`;
    const p = patches.get(key) ?? { axis, coordinate, u, v, size, cells: new Set<number>() };
    p.cells.add(cell);
    if (neighbor !== undefined) p.cells.add(neighbor);
    patches.set(key, p);
  }
  for (let c = 0; c < leaves.length; c++) {
    const leaf = leaves[c];
    for (let axis = 0; axis < 3; axis++) {
      const [ua, va] = axes(axis);
      for (const side of [0, 1]) addPatch(c, axis, leaf.origin[axis] + side * leaf.size, leaf.origin[ua], leaf.origin[va], leaf.size, side ? 1 : -1);
    }
  }

  // An edge may meet a third, finer cell not visible to either face neighbor.
  // Register every patch endpoint on its global axis line before triangulating any face.
  const lines = new Map<string, Set<number>>();
  const lineKey = (a: Vec3, axis: number) => `${axis}:${a[(axis + 1) % 3]}:${a[(axis + 2) % 3]}`;
  function corners(p: Patch): Vec3[] {
    const [ua, va] = axes(p.axis);
    return [[p.u, p.v], [p.u + p.size, p.v], [p.u + p.size, p.v + p.size], [p.u, p.v + p.size]].map(([u, v]) => {
      const q: Vec3 = [0, 0, 0]; q[p.axis] = p.coordinate; q[ua] = u; q[va] = v; return q;
    });
  }
  for (const p of patches.values()) {
    const c = corners(p);
    for (let j = 0; j < 4; j++) {
      const a = c[j], b = c[(j + 1) % 4], axis = a.findIndex((v, i) => v !== b[i]);
      const key = lineKey(a, axis);
      const points = lines.get(key) ?? new Set<number>(); points.add(a[axis]); points.add(b[axis]); lines.set(key, points);
    }
  }
  const sortedLines = new Map([...lines].map(([k, values]) => [k, [...values].sort((a, b) => a - b)]));
  const vertices: Vec3[] = [], latticeVertices: Vec3[] = [], vertexIds = new Map<string, number>();
  function vertex(p: Vec3): number {
    const key = key3(p); let i = vertexIds.get(key);
    if (i === undefined) { i = vertices.length; vertexIds.set(key, i); vertices.push(world(p)); latticeVertices.push([...p]); }
    return i;
  }
  const cellCenters = leaves.map(l => vertex(l.origin.map(v => v + l.size / 2) as Vec3));
  const tets: Tet[] = [];
  for (const p of patches.values()) {
    if (p.cells.size > 2) throw new Error('Non-conforming face patch ownership.');
    const [ua, va] = axes(p.axis);
    const cp: Vec3 = [0, 0, 0]; cp[p.axis] = p.coordinate; cp[ua] = p.u + p.size / 2; cp[va] = p.v + p.size / 2;
    const center = vertex(cp), c = corners(p);
    const perimeter: number[] = [];
    for (let j = 0; j < 4; j++) {
      const a = c[j], b = c[(j + 1) % 4], axis = a.findIndex((v, i) => v !== b[i]);
      const points = sortedLines.get(lineKey(a, axis))!.filter(v => v >= Math.min(a[axis], b[axis]) && v <= Math.max(a[axis], b[axis]));
      if (b[axis] < a[axis]) points.reverse();
      for (const value of points.slice(0, -1)) { const q: Vec3 = [...a]; q[axis] = value; perimeter.push(vertex(q)); }
    }
    for (const cell of p.cells) {
      for (let j = 0; j < perimeter.length; j++) {
        const a = perimeter[j], b = perimeter[(j + 1) % perimeter.length];
        // In cyclic axes, face perimeter is positive along axis. Positive tet volume required.
        if (leaves[cell].origin[p.axis] < p.coordinate) tets.push([cellCenters[cell], center, a, b]);
        else tets.push([cellCenters[cell], center, b, a]);
      }
    }
  }
  stats.leaves = leaves.length; stats.tetrahedra = tets.length; stats.vertices = vertices.length; stats.milliseconds = performance.now() - started;
  return { vertices, tets, leaves, stats, lattice: { vertices: latticeVertices, bounds, resolution } };
}
