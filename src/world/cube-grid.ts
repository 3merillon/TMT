/**
 * Cube-sphere cell grids: N×N cells per face on the equi-angular convention of
 * `cube-sphere.ts`, indexed `c = (face · N + j) · N + i` (i along u, j along v). Pure and deterministic, so the level-map
 * basin solver (presentation) and the gameplay water grid (plan phase 6) share one topology.
 *
 * - `neighbours`: 4 per cell in the order +i, −i, +j, −j. Across a seam the neighbour is the cell of the adjacent face
 *   that owns the direction one cell past the edge; `reverse[c·4 + k]` is the slot of that neighbour that points back
 *   (seams rotate the index order). Every link is symmetric: tests/world-cube-grid.test.ts checks all 12 seams and 8
 *   corners.
 * - `area`: cell areas on the unit sphere, per (i, j) — identical on every face (the mapping is symmetric).
 */
import { cubeDir, cubeFaceOf, cubeUv } from './cube-sphere';

export interface CubeGrid {
  readonly n: number;
  /** 6·n·n */
  readonly cells: number;
  /** cells·4 neighbour indices (+i, −i, +j, −j). */
  readonly neighbours: Int32Array;
  /** cells·4: which of the neighbour's four slots points back at this cell. */
  readonly reverse: Uint8Array;
  /** n·n unit-sphere cell areas, the same for every face; sum × 6 = 4π. */
  readonly area: Float64Array;
}

const OFFSETS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const cache = new Map<number, CubeGrid>();

export const cellIndex = (n: number, face: number, i: number, j: number): number => (face * n + j) * n + i;
/** Face coordinate of a cell centre along one axis: (2·(i + 0.5)) / n − 1. */
export const cellUv = (n: number, i: number): number => (2 * (i + 0.5)) / n - 1;

/** The cell that owns a direction (or any non-zero point). */
export function cellOfDir(n: number, d: readonly number[]): number {
  const face = cubeFaceOf(d);
  const [u, v] = cubeUv(d, face);
  const i = Math.min(n - 1, Math.max(0, Math.floor((u + 1) * 0.5 * n)));
  const j = Math.min(n - 1, Math.max(0, Math.floor((v + 1) * 0.5 * n)));
  return cellIndex(n, face, i, j);
}

/** Unit direction of a cell centre. */
export function cellDir(n: number, c: number): [number, number, number] {
  const i = c % n, j = Math.floor(c / n) % n, face = Math.floor(c / (n * n));
  return cubeDir(face, [cellUv(n, i), cellUv(n, j)]);
}

/** The grid for n cells per face edge (memoised). */
export function cubeGrid(n: number): CubeGrid {
  const hit = cache.get(n);
  if (hit) return hit;
  const cells = 6 * n * n;
  const neighbours = new Int32Array(cells * 4);
  for (let face = 0; face < 6; face++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const c = cellIndex(n, face, i, j);
    for (let k = 0; k < 4; k++) {
      const ii = i + OFFSETS[k][0], jj = j + OFFSETS[k][1];
      neighbours[c * 4 + k] = ii >= 0 && ii < n && jj >= 0 && jj < n
        ? cellIndex(n, face, ii, jj)
        : cellOfDir(n, cubeDir(face, [cellUv(n, ii), cellUv(n, jj)]));
    }
  }
  const reverse = new Uint8Array(cells * 4);
  for (let c = 0; c < cells; c++) for (let k = 0; k < 4; k++) {
    const nb = neighbours[c * 4 + k];
    let r = 0;
    for (let q = 0; q < 4; q++) if (neighbours[nb * 4 + q] === c) { r = q; break; }
    reverse[c * 4 + k] = r;
  }
  // Areas of the spherical cell quads, split into two triangles (Girard's excess is overkill at these sizes: the flat
  // triangles on the unit sphere under-measure by < 0.1% at n ≥ 32, and the ratio is what the solvers use).
  const area = new Float64Array(n * n);
  const P = (u: number, v: number) => cubeDir(4, [u, v]);
  const tri = (a: number[], b: number[], c: number[]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return 0.5 * Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u0 = (2 * i) / n - 1, u1 = (2 * (i + 1)) / n - 1, v0 = (2 * j) / n - 1, v1 = (2 * (j + 1)) / n - 1;
    const a = P(u0, v0), b = P(u1, v0), c = P(u1, v1), d = P(u0, v1);
    area[j * n + i] = tri(a, b, c) + tri(a, c, d);
  }
  const grid: CubeGrid = { n, cells, neighbours, reverse, area };
  cache.set(n, grid);
  return grid;
}

const chord = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The flux metric of every cell on the unit sphere, the same on every face (the mapping is symmetric): 12 floats per
 * (i, j) — area, 0, 0, 0; the length of the edge shared with each neighbour (+i, −i, +j, −j); the distance between the
 * two centres, in the same order (chords; the neighbour across a seam is the grid's own). Scale by r², r and r.
 */
export function cubeGridMetric(n: number): Float32Array {
  const g = cubeGrid(n);
  const out = new Float32Array(n * n * 12);
  const corner = (i: number, j: number) => cubeDir(4, [(2 * i) / n - 1, (2 * j) / n - 1]);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = (j * n + i) * 12, c = cellIndex(n, 4, i, j);
    const p00 = corner(i, j), p10 = corner(i + 1, j), p11 = corner(i + 1, j + 1), p01 = corner(i, j + 1);
    out[o] = g.area[j * n + i];
    out[o + 4] = chord(p10, p11); out[o + 5] = chord(p00, p01); out[o + 6] = chord(p01, p11); out[o + 7] = chord(p00, p10);
    const d = cellDir(n, c);
    for (let k = 0; k < 4; k++) out[o + 8 + k] = chord(d, cellDir(n, g.neighbours[c * 4 + k]));
  }
  return out;
}

/**
 * The dual mesh of the grid: one quad per grid corner, joining the centres of the cells that share it. 4 cell indices per
 * quad, counter-clockwise seen from outside; at the eight cube corners three cells meet and the quad repeats its last
 * cell. Corners on a seam are shared by two faces (three at a cube corner) and emitted once. Across a seam the cells come
 * from the neighbour table, so the mesh is watertight: every cell edge is shared by exactly two quads.
 */
export function cubeGridDualQuads(n: number): Uint32Array {
  const g = cubeGrid(n);
  const nb = (c: number, k: number) => g.neighbours[c * 4 + k];
  const out: number[] = [];
  const seen = new Set<string>();
  const on = (face: number, i: number, j: number) => cellIndex(n, face, i, j);
  /** Whether cells q[0], q[1], q[2] run clockwise seen from outside. */
  const clockwise = (q: readonly number[]) => {
    const p0 = cellDir(n, q[0]), p1 = cellDir(n, q[1]), p2 = cellDir(n, q[2]);
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    return (e1[1] * e2[2] - e1[2] * e2[1]) * p0[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * p0[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * p0[2] < 0;
  };
  for (let face = 0; face < 6; face++) {
    // Interior quads share their face's handedness; seam quads are checked one by one.
    const faceFlip = n > 1 && clockwise([on(face, 0, 0), on(face, 1, 0), on(face, 1, 1)]);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const edgeI = i === 0 || i === n, edgeJ = j === 0 || j === n;
      // Around corner (i, j), in the face's counter-clockwise order: (i−1, j−1), (i, j−1), (i, j), (i−1, j).
      let q: number[];
      if (!edgeI && !edgeJ) q = [on(face, i - 1, j - 1), on(face, i, j - 1), on(face, i, j), on(face, i - 1, j)];
      else if (edgeI && edgeJ) {
        // A cube corner: the face's corner cell and its two neighbours across the seams.
        const ci = i === 0 ? 0 : n - 1, cj = j === 0 ? 0 : n - 1;
        const c = on(face, ci, cj);
        const across = nb(c, i === 0 ? 1 : 0), acrossJ = nb(c, j === 0 ? 3 : 2);
        q = [c, across, acrossJ, acrossJ];
      } else if (i === 0) {
        const b = on(face, 0, j - 1), c = on(face, 0, j);
        q = [nb(b, 1), b, c, nb(c, 1)];
      } else if (i === n) {
        const a = on(face, n - 1, j - 1), d = on(face, n - 1, j);
        q = [a, nb(a, 0), nb(d, 0), d];
      } else if (j === 0) {
        const c = on(face, i, 0), d = on(face, i - 1, 0);
        q = [nb(d, 3), nb(c, 3), c, d];
      } else {
        const a = on(face, i - 1, n - 1), b = on(face, i, n - 1);
        q = [a, b, nb(b, 2), nb(a, 2)];
      }
      if (edgeI || edgeJ) {
        const key = [...new Set(q)].sort((x, y) => x - y).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
      }
      // Wind counter-clockwise seen from outside.
      if (edgeI || edgeJ ? clockwise(q) : faceFlip) q = q[2] === q[3] ? [q[0], q[2], q[1], q[1]] : [q[0], q[3], q[2], q[1]];
      out.push(q[0], q[1], q[2], q[3]);
    }
  }
  return Uint32Array.from(out);
}
