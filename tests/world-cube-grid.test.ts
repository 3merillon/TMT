import { describe, expect, it } from 'vitest';
import { cellDir, cellIndex, cellOfDir, cubeGrid, cubeGridDualQuads, cubeGridMetric } from '../src/world/cube-grid';

describe('cube-sphere cell grid', () => {
  for (const n of [4, 8, 32]) {
    it(`links every cell symmetrically across all 12 seams and 8 corners (n ${n})`, () => {
      const g = cubeGrid(n);
      let seamLinks = 0;
      for (let c = 0; c < g.cells; c++) for (let k = 0; k < 4; k++) {
        const nb = g.neighbours[c * 4 + k];
        expect(nb).not.toBe(c);
        expect(g.neighbours[nb * 4 + g.reverse[c * 4 + k]]).toBe(c);
        if (Math.floor(nb / (n * n)) !== Math.floor(c / (n * n))) seamLinks++;
      }
      // Each face edge has n cells, each linking once across its seam: 6 faces × 4 edges × n.
      expect(seamLinks).toBe(24 * n);
    });
  }

  it('gives each cell four distinct neighbours, including the corner cells', () => {
    const n = 8, g = cubeGrid(n);
    for (const c of [cellIndex(n, 0, 0, 0), cellIndex(n, 2, n - 1, n - 1), cellIndex(n, 5, 0, n - 1)]) {
      expect(new Set(g.neighbours.subarray(c * 4, c * 4 + 4)).size).toBe(4);
    }
  });

  it('covers the unit sphere (areas sum to 4π) and round-trips cell centres', () => {
    const n = 32, g = cubeGrid(n);
    const total = g.area.reduce((a, b) => a + b, 0) * 6;
    expect(Math.abs(total - 4 * Math.PI) / (4 * Math.PI)).toBeLessThan(1e-3);
    for (let c = 0; c < g.cells; c += 97) expect(cellOfDir(n, cellDir(n, c))).toBe(c);
  });

  for (const n of [4, 9, 32]) {
    it(`builds a watertight, outward-wound dual mesh over the cell centres (n ${n})`, () => {
      const q = cubeGridDualQuads(n);
      const quads = q.length / 4;
      // One face per grid corner: 6n² + 2 of them, the eight cube corners as triangles.
      expect(quads).toBe(6 * n * n + 2);
      const uses = new Uint32Array(6 * n * n);
      const directed = new Map<string, number>();
      let triangles = 0;
      for (let k = 0; k < quads; k++) {
        const v = [q[k * 4], q[k * 4 + 1], q[k * 4 + 2], q[k * 4 + 3]];
        for (const c of new Set(v)) uses[c]++;
        const tris = v[2] === v[3] ? [[v[0], v[1], v[2]]] : [[v[0], v[1], v[2]], [v[0], v[2], v[3]]];
        if (v[2] === v[3]) triangles++;
        for (const [a, b, c] of tris) {
          const pa = cellDir(n, a), pb = cellDir(n, b), pc = cellDir(n, c);
          const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
          const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          expect(nrm[0] * pa[0] + nrm[1] * pa[1] + nrm[2] * pa[2]).toBeGreaterThan(0);
          for (const [x, y] of [[a, b], [b, c], [c, a]]) directed.set(`${x}>${y}`, (directed.get(`${x}>${y}`) ?? 0) + 1);
        }
      }
      expect(triangles).toBe(8);
      // Every cell is a vertex of exactly four faces.
      expect(Math.min(...uses)).toBe(4);
      expect(Math.max(...uses)).toBe(4);
      // Watertight and consistently wound: each directed edge once, and its reverse once.
      for (const [key, count] of directed) {
        expect(count).toBe(1);
        const [x, y] = key.split('>');
        expect(directed.get(`${y}>${x}`)).toBe(1);
      }
    });
  }

  it('gives a flux metric whose areas sum to the sphere and whose edges stay near one cell', () => {
    const n = 32, m = cubeGridMetric(n);
    let area = 0;
    for (let k = 0; k < n * n; k++) area += m[k * 12];
    expect(Math.abs(area * 6 - 4 * Math.PI) / (4 * Math.PI)).toBeLessThan(1e-3);
    const cell = Math.PI / 2 / n;
    for (let k = 0; k < n * n; k++) for (let e = 0; e < 8; e++) {
      const v = m[k * 12 + 4 + e];
      expect(v).toBeGreaterThan(cell * 0.6);
      expect(v).toBeLessThan(cell * 1.5);
    }
    // Mid-face, a seam's centre distance matches the one a cell in (the equi-angular grid is nearly uniform there).
    const row = n / 2, seam = m[(row * n + n - 1) * 12 + 8], inner = m[(row * n + n - 2) * 12 + 8];
    expect(Math.abs(seam - inner) / inner).toBeLessThan(0.02);
  });
});
