import { describe, expect, it } from 'vitest';
import { BASIN_RECIPES, MAX_SEA_LEVEL, pickVents, priorityFlood, resolveBasins, solveBasins } from '../src/world/basins';
import { cellDir, cubeGrid } from '../src/world/cube-grid';

/** A test bed: a planet tilted toward −Y (the sea side), with a deep pit on the +Y side and a shallow dimple beside it. */
function testBed(n: number): Float64Array {
  const g = cubeGrid(n);
  const bed = new Float64Array(g.cells);
  const pit = [0, 1, 0], dimple = [0.5, 0.86, 0];
  for (let c = 0; c < g.cells; c++) {
    const d = cellDir(n, c);
    const near = (a: number[], w: number) => Math.exp(-(1 - (d[0] * a[0] + d[1] * a[1] + d[2] * a[2])) / w);
    bed[c] = 18 + 1.6 * d[1] - 1.5 * near(pit, 0.004) - 0.2 * near(dimple, 0.002);
  }
  return bed;
}

describe('resting liquid basins', () => {
  const n = 48;
  const bed = testBed(n);
  const g = cubeGrid(n);

  it('floods in non-decreasing fill order, never below the bed', () => {
    const { fill, order } = priorityFlood(bed, n);
    for (let k = 1; k < order.length; k++) expect(fill[order[k]]).toBeGreaterThanOrEqual(fill[order[k - 1]]);
    for (let c = 0; c < g.cells; c++) expect(fill[c]).toBeGreaterThanOrEqual(bed[c]);
  });

  it('sets the sea level for the target coverage and labels only cells below it', () => {
    const s = solveBasins(bed, n, { sea: { material: 'water', coverage: 0.22 } });
    expect(s.seaLevel).not.toBeNull();
    const sea = s.basins[0];
    expect(sea.kind).toBe('sea');
    let covered = 0;
    for (let c = 0; c < g.cells; c++) if (s.labels[c] === sea.id) { expect(bed[c]).toBeLessThan(sea.level); covered += g.area[c % (n * n)]; }
    expect(covered / (4 * Math.PI)).toBeGreaterThan(0.2);
    expect(covered / (4 * Math.PI)).toBeLessThan(0.24);
  });

  it('caps the sea below the landing plain and below the points that must stay dry', () => {
    const wet = solveBasins(bed, n, { sea: { material: 'water', coverage: 0.9 } });
    expect(wet.seaLevel).toBeLessThanOrEqual(MAX_SEA_LEVEL);
    const dry = solveBasins(bed, n, { sea: { material: 'water', coverage: 0.9 } }, { maxLevel: 17.0 });
    expect(dry.seaLevel).toBeCloseTo(17.0, 9);
  });

  it('fills the deepest free depression as a lake between its floor and its spill level', () => {
    const s = solveBasins(bed, n, BASIN_RECIPES.dune);
    expect(s.seaLevel).toBeNull();
    const lake = s.basins[0];
    expect(lake.kind).toBe('lake');
    expect(lake.level).toBeGreaterThan(lake.floor);
    expect(lake.level).toBeLessThan(lake.spill);
    // The pit at +Y is the deepest depression.
    let lowest = -1;
    for (let c = 0; c < g.cells; c++) if (s.labels[c] === lake.id && (lowest < 0 || bed[c] < bed[lowest])) lowest = c;
    expect(cellDir(n, lowest)[1]).toBeGreaterThan(0.95);
    expect(lake.volume).toBeGreaterThan(0);
  });

  it('keeps a dry point dry: a lake around it is capped below it, or dropped', () => {
    const free = solveBasins(bed, n, BASIN_RECIPES.dune);
    const lake = free.basins[0];
    let pit = -1;
    for (let c = 0; c < g.cells; c++) if (free.labels[c] === lake.id && (pit < 0 || bed[c] < bed[pit])) pit = c;
    const capped = solveBasins(bed, n, BASIN_RECIPES.dune, { dry: [{ cell: pit, maxLevel: lake.floor + 0.2 }] });
    expect(capped.basins[0].level).toBeCloseTo(lake.floor + 0.2, 9);
    const dropped = solveBasins(bed, n, BASIN_RECIPES.dune, { dry: [{ cell: pit, maxLevel: lake.floor + 0.01 }] });
    expect(dropped.basins.every(b => b.floor !== lake.floor)).toBe(true);
  });

  it('keeps a lake apart from the sea and the lava sea of a volcanic planet', () => {
    const s = solveBasins(bed, n, BASIN_RECIPES.volcanic);
    expect(s.basins[0].material).toBe('lava');
    for (const b of s.basins.slice(1)) {
      expect(b.material).toBe('water');
      expect(b.level).toBeGreaterThan(s.seaLevel!);
    }
  });

  it('keeps every basin where it was when the bed has not changed', () => {
    const s = solveBasins(bed, n, BASIN_RECIPES.temperate);
    const r = resolveBasins(bed, n, s);
    expect(r.basins.length).toBe(s.basins.length);
    for (const [i, b] of s.basins.entries()) {
      expect(r.basins[i].id).toBe(b.id);
      expect(r.basins[i].level).toBeCloseTo(b.level, 3);
      expect(r.basins[i].volume / b.volume).toBeCloseTo(1, 3);
    }
    expect(r.seaLevel).toBeCloseTo(s.seaLevel!, 3);
  });

  it('floods a crater opened below the sea level and lowers the sea by what it took', () => {
    const s = solveBasins(bed, n, { sea: { material: 'water', coverage: 0.22 } });
    const sea = s.basins[0];
    // A crater on the shore: dry cells just above the level, next to the sea, cut 1 u below it.
    const cut = Float64Array.from(bed);
    const shore: number[] = [];
    for (let c = 0; c < g.cells; c++) {
      if (s.labels[c] || bed[c] > sea.level + 0.3) continue;
      if ([0, 1, 2, 3].some(q => s.labels[g.neighbours[c * 4 + q]] === sea.id)) shore.push(c);
    }
    const ring = new Set<number>(shore.slice(0, 1));
    for (let k = 0; k < 2; k++) for (const c of [...ring]) for (let q = 0; q < 4; q++) ring.add(g.neighbours[c * 4 + q]);
    for (const c of ring) cut[c] = Math.min(cut[c], sea.level - 1);
    const r = resolveBasins(cut, n, s);
    for (const c of ring) expect(r.labels[c]).toBe(sea.id);
    expect(r.basins[0].level).toBeLessThan(sea.level);
    expect(r.basins[0].volume / sea.volume).toBeCloseTo(1, 3);
  });

  it('drains a breached lake into the basin below and conserves the water', () => {
    const s = solveBasins(bed, n, BASIN_RECIPES.temperate);
    const lake = s.basins.find(b => b.kind === 'lake');
    expect(lake).toBeDefined();
    // Cut a channel from the lake's lowest cell down to the sea: every cell on a path toward −Y drops below the sea level.
    let c = -1;
    for (let k = 0; k < g.cells; k++) if (s.labels[k] === lake!.id && (c < 0 || bed[k] < bed[c])) c = k;
    const cut = Float64Array.from(bed);
    const seaLevel = s.seaLevel!;
    for (let step = 0; step < 4 * n && s.labels[c] !== s.basins[0].id; step++) {
      cut[c] = Math.min(cut[c], seaLevel - 0.5);
      let next = g.neighbours[c * 4];
      for (let q = 1; q < 4; q++) { const nb = g.neighbours[c * 4 + q]; if (cellDir(n, nb)[1] < cellDir(n, next)[1]) next = nb; }
      c = next;
    }
    const r = resolveBasins(cut, n, s);
    const total = (x: typeof s) => x.basins.reduce((acc, b) => acc + b.volume, 0);
    expect(r.basins[lake!.id - 1].volume).toBeLessThan(lake!.volume * 0.5);
    expect(total(r) / total(s)).toBeCloseTo(1, 2);
  });

  it('never rises above its cap when room is taken away', () => {
    const s = solveBasins(bed, n, { sea: { material: 'water', coverage: 0.22 } });
    const sea = s.basins[0];
    // Twice the water on the same bed would rise; capped at the recipe level, it stays there.
    const r = resolveBasins(bed, n, s, [sea.volume * 2], [sea.level]);
    expect(r.basins[0].level).toBeCloseTo(sea.level, 9);
    expect(r.basins[0].volume / sea.volume).toBeCloseTo(1, 3);
  });

  it('is deterministic', () => {
    const a = solveBasins(bed, n, BASIN_RECIPES.temperate), b = solveBasins(bed, n, BASIN_RECIPES.temperate);
    expect(Array.from(a.labels)).toEqual(Array.from(b.labels));
    expect(a.basins).toEqual(b.basins);
  });

  it('picks vents on high peaks above the lava, clear of dry points and of each other', () => {
    const s = solveBasins(bed, n, BASIN_RECIPES.volcanic);
    const lava = s.basins.find(b => b.material === 'lava')!;
    const g = cubeGrid(n);
    let high = 0;
    for (let c = 1; c < g.cells; c++) if (bed[c] > bed[high]) high = c;
    // A dry point right on the highest peak keeps a vent off it.
    const dry = [cellDir(n, high)];
    const vents = pickVents(bed, n, lava.level, dry, 3, { apart: 0.4 });
    expect(vents.length).toBeGreaterThan(0);
    expect(vents).not.toContain(high);
    const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    for (const v of vents) {
      expect(bed[v]).toBeGreaterThan(lava.level + 0.6);
      expect(angle(cellDir(n, v), dry[0])).toBeGreaterThan(0.3);
      for (const w of vents) if (w !== v) expect(angle(cellDir(n, v), cellDir(n, w))).toBeGreaterThan(0.4);
    }
    expect(pickVents(bed, n, lava.level, dry, 3, { apart: 0.4 })).toEqual(vents);
  });
});
