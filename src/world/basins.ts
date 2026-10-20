/**
 * Resting liquid basins: which parts of the planet hold standing water or lava, and at what
 * level, from a bed map on the cube-sphere grid (`cube-grid.ts`).
 *
 * - A priority-flood (Barnes, Lehman & Mulla 2014) from the lowest cell gives every cell its fill level: the lowest
 *   surface height at which it connects to that cell. Sorting by it gives the sea's coverage as a function of level, so
 *   the sea level for a target coverage is one walk down the flood order.
 * - Closed depressions (fill level above the bed) that the sea does not reach are lake candidates. The deepest ones are
 *   filled to a fraction of their spill depth: lakes, oases, hot springs.
 * - Recipes per planet kind (D6): temperate sea and lakes, glacial cold sea, dune oases, volcanic lava lakes with a few
 *   hot springs.
 * Pure and deterministic: ties break by cell index and nothing reads a clock or Math.random, so the gameplay water grid
 * (plan phase 6) can reuse it on the collision bed. The renderer calls it on a read-back bed.
 */
import { cellDir, cubeGrid } from './cube-grid';

export type LiquidMaterial = 'water' | 'lava';
export type BasinKind = 'sea' | 'lake';
export type PlanetKindName = 'temperate' | 'glacial' | 'dune' | 'volcanic';

export interface Basin {
  /** Label in `BasinSolution.labels` (1-based; 0 = dry). */
  readonly id: number;
  readonly kind: BasinKind;
  readonly material: LiquidMaterial;
  /** Surface radius (u). */
  readonly level: number;
  /** Lowest bed radius under it (u). */
  readonly floor: number;
  /** Radius at which it would overflow (u); the sea's is its own level. */
  readonly spill: number;
  readonly cells: number;
  /** Surface area (u²) and liquid volume (u³) at `level`, from the grid cells. */
  readonly area: number;
  readonly volume: number;
}
export interface BasinSolution {
  readonly n: number;
  readonly labels: Uint8Array;
  readonly basins: readonly Basin[];
  /** The sea (or lava sea) level, if the recipe has one. */
  readonly seaLevel: number | null;
}
export interface LakeRule {
  readonly material: LiquidMaterial;
  /** How many of the deepest free depressions to fill. */
  readonly count: number;
  /** Level = floor + fill · (spill − floor). */
  readonly fill: number;
  /** Ignore depressions shallower than this (u). */
  readonly minDepth: number;
}
export interface BasinRecipe {
  readonly sea?: { readonly material: LiquidMaterial; readonly coverage: number };
  readonly lakes?: readonly LakeRule[];
}

/** The standing liquid of each planet kind (D6). */
export const BASIN_RECIPES: Readonly<Record<PlanetKindName, BasinRecipe>> = {
  temperate: { sea: { material: 'water', coverage: 0.22 }, lakes: [{ material: 'water', count: 2, fill: 0.7, minDepth: 0.35 }] },
  glacial: { sea: { material: 'water', coverage: 0.3 } },
  dune: { lakes: [{ material: 'water', count: 3, fill: 0.6, minDepth: 0.35 }] },
  volcanic: { sea: { material: 'lava', coverage: 0.12 }, lakes: [{ material: 'water', count: 2, fill: 0.55, minDepth: 0.3 }] },
};

/** Sea levels stay below the landing plain (r ≈ 18.15 around +Y, planet-field.ts) with margin. */
export const MAX_SEA_LEVEL = 17.8;
/** Basins the renderer can carry (the GPU table size). */
export const MAX_BASINS = 16;

/** A binary min-heap of (key, index) pairs; ties break by index, so the order is deterministic. */
class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  size = 0;
  constructor(capacity: number) { this.keys = new Float64Array(capacity); this.ids = new Int32Array(capacity); }
  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.ids[a] < this.ids[b]);
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = k;
    const i = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = i;
  }
  push(key: number, id: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2), ids = new Int32Array(this.size * 2);
      keys.set(this.keys); ids.set(this.ids); this.keys = keys; this.ids = ids;
    }
    let i = this.size++;
    this.keys[i] = key; this.ids[i] = id;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  /** Pops the minimum; returns its index, and its key in `lastKey`. */
  lastKey = 0;
  pop(): number {
    const top = this.ids[0];
    this.lastKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]; this.ids[0] = this.ids[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}

/**
 * Fill levels from the lowest cell: `fill[c]` is the minimax bed height of a path from the lowest cell to c. `order` lists
 * cells as the flood reached them (non-decreasing fill).
 */
export function priorityFlood(bed: ArrayLike<number>, n: number): { fill: Float64Array; order: Int32Array } {
  const g = cubeGrid(n);
  const fill = new Float64Array(g.cells).fill(Infinity);
  const order = new Int32Array(g.cells);
  let seed = 0;
  for (let c = 1; c < g.cells; c++) if (bed[c] < bed[seed]) seed = c;
  const heap = new MinHeap(1024);
  fill[seed] = bed[seed];
  heap.push(fill[seed], seed);
  const done = new Uint8Array(g.cells);
  let k = 0;
  while (heap.size > 0) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    order[k++] = c;
    const level = fill[c];
    for (let q = 0; q < 4; q++) {
      const nb = g.neighbours[c * 4 + q];
      if (done[nb]) continue;
      const f = Math.max(bed[nb], level);
      if (f < fill[nb]) { fill[nb] = f; heap.push(f, nb); }
    }
  }
  return { fill, order };
}

/** A point that must stay dry (a tank spawn): the cell it stands on and the highest level allowed there (u). */
export interface DryPoint { readonly cell: number; readonly maxLevel: number }

/**
 * Basins for a bed map (radii, 6·n·n cells, `cube-grid.ts` order). `maxLevel` caps the sea (spawn safety: the caller
 * passes the lowest point that must stay dry, minus a margin); `dry` caps any lake whose depression holds one of the
 * points, and drops the lake when the cap leaves it no depth.
 */
export function solveBasins(bed: ArrayLike<number>, n: number, recipe: BasinRecipe,
  opts: { maxLevel?: number; dry?: readonly DryPoint[] } = {}): BasinSolution {
  const g = cubeGrid(n);
  const labels = new Uint8Array(g.cells);
  const basins: Basin[] = [];
  const { fill, order } = priorityFlood(bed, n);
  const nn = n * n;
  const cellArea = (c: number) => g.area[c % nn];
  const cap = Math.min(MAX_SEA_LEVEL, opts.maxLevel ?? Infinity);
  const addBasin = (kind: BasinKind, material: LiquidMaterial, level: number, spill: number, cellsOf: number[]) => {
    if (!cellsOf.length || basins.length >= MAX_BASINS) return;
    const id = basins.length + 1;
    let floor = Infinity, area = 0, volume = 0;
    for (const c of cellsOf) {
      labels[c] = id;
      const a = cellArea(c) * level * level;
      floor = Math.min(floor, bed[c]); area += a; volume += a * (level - bed[c]);
    }
    basins.push({ id, kind, material, level, floor, spill, cells: cellsOf.length, area, volume });
  };

  let seaLevel: number | null = null;
  if (recipe.sea && recipe.sea.coverage > 0) {
    const target = recipe.sea.coverage * 4 * Math.PI;
    let acc = 0, level = fill[order[0]];
    for (let k = 0; k < order.length; k++) {
      acc += cellArea(order[k]);
      level = fill[order[k]];
      if (acc >= target) break;
    }
    level = Math.min(level, cap);
    seaLevel = level;
    const sea: number[] = [];
    // Everything the flood reached at or below the level is connected to the lowest cell under it.
    for (let k = 0; k < order.length; k++) { const c = order[k]; if (fill[c] > level) break; if (bed[c] < level) sea.push(c); }
    addBasin('sea', recipe.sea.material, level, level, sea);
  }

  for (const rule of recipe.lakes ?? []) {
    // Depressions the sea does not reach: connected cells whose fill level is above their bed, grouped by component.
    const component = new Int32Array(g.cells).fill(-1);
    const found: { cells: number[]; spill: number; floor: number; floorCell: number }[] = [];
    for (let c0 = 0; c0 < g.cells; c0++) {
      if (component[c0] >= 0 || labels[c0] || fill[c0] - bed[c0] <= 1e-4) continue;
      const cells: number[] = [];
      const stack = [c0];
      component[c0] = found.length;
      let floor = Infinity, floorCell = c0, spill = -Infinity;
      while (stack.length) {
        const c = stack.pop()!;
        cells.push(c);
        spill = Math.max(spill, fill[c]);
        if (bed[c] < floor || (bed[c] === floor && c < floorCell)) { floor = bed[c]; floorCell = c; }
        for (let q = 0; q < 4; q++) {
          const nb = g.neighbours[c * 4 + q];
          if (component[nb] >= 0 || labels[nb] || fill[nb] - bed[nb] <= 1e-4) continue;
          component[nb] = found.length;
          stack.push(nb);
        }
      }
      found.push({ cells, spill, floor, floorCell });
    }
    const candidates = found.filter(f => f.spill - f.floor >= rule.minDepth)
      .sort((a, b) => (b.spill - b.floor) - (a.spill - a.floor) || a.floorCell - b.floorCell);
    for (const d of candidates.slice(0, rule.count)) {
      const inside = new Set(d.cells);
      let level = d.floor + rule.fill * (d.spill - d.floor);
      for (const p of opts.dry ?? []) if (inside.has(p.cell)) level = Math.min(level, p.maxLevel);
      if (level - d.floor < 0.05) continue;
      if (seaLevel !== null && level <= seaLevel) continue;
      // The lake: cells of the depression below the level, connected to its lowest cell.
      const lake: number[] = [];
      const seen = new Set<number>([d.floorCell]);
      const stack = [d.floorCell];
      while (stack.length) {
        const c = stack.pop()!;
        lake.push(c);
        for (let q = 0; q < 4; q++) {
          const nb = g.neighbours[c * 4 + q];
          if (seen.has(nb) || !inside.has(nb) || bed[nb] >= level || labels[nb]) continue;
          seen.add(nb);
          stack.push(nb);
        }
      }
      lake.sort((a, b) => a - b);
      addBasin('lake', rule.material, level, d.spill, lake);
    }
  }
  return { n, labels, basins, seaLevel };
}

/**
 * Lava vents for a volcanic planet: the highest local peaks of the bed (above every neighbour two
 * cells out) that stand at least `above` over the lava's level, at least `clear` radians from every point that must stay
 * dry and `apart` radians from each other. A summit must be smooth (no neighbour more than `maxStep` below it): the bed
 * holds buildings too, and a roof is no volcano. Cell indices, highest first. Pure and deterministic (ties by index).
 */
export function pickVents(bed: ArrayLike<number>, n: number, lavaLevel: number, dry: readonly (readonly number[])[], count: number,
  opts: { above?: number; clear?: number; apart?: number; maxStep?: number } = {}): number[] {
  const g = cubeGrid(n);
  const above = opts.above ?? 0.6, clear = opts.clear ?? 0.3, apart = opts.apart ?? 0.45, maxStep = opts.maxStep ?? 0.35;
  const dir = (c: number) => cellDir(n, c);
  const angle = (a: readonly number[], b: readonly number[]) => {
    const la = Math.hypot(a[0], a[1], a[2]) || 1, lb = Math.hypot(b[0], b[1], b[2]) || 1;
    return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb))));
  };
  const peaks: number[] = [];
  for (let c = 0; c < g.cells; c++) {
    if (bed[c] < lavaLevel + above) continue;
    let steep = false;
    for (let q = 0; q < 4; q++) if (bed[c] - bed[g.neighbours[c * 4 + q]] > maxStep) steep = true;
    if (steep) continue;
    // Above every cell within two steps.
    let top = true;
    const ring = [c];
    for (let step = 0; step < 2 && top; step++) {
      for (const x of [...ring]) for (let q = 0; q < 4; q++) {
        const nb = g.neighbours[x * 4 + q];
        if (nb === c || ring.includes(nb)) continue;
        if (bed[nb] > bed[c] || (bed[nb] === bed[c] && nb < c)) { top = false; break; }
        ring.push(nb);
      }
    }
    if (top) peaks.push(c);
  }
  peaks.sort((a, b) => bed[b] - bed[a] || a - b);
  const chosen: number[] = [];
  for (const c of peaks) {
    if (chosen.length >= count) break;
    const d = dir(c);
    if (dry.some(p => angle(d, p) < clear)) continue;
    if (chosen.some(o => angle(d, dir(o)) < apart)) continue;
    chosen.push(c);
  }
  return chosen;
}

/**
 * Basins after the bed changed (craters), each holding its ledger volume: every previous
 * basin floods again from its lowest remaining cell until it holds its volume, so a crater that opens into a sea or a
 * lake below its level fills from it, and the level drops by what the crater took. Higher basins resolve first.
 *
 * - **Spill:** where a flood crosses a saddle (it reaches a cell below its current fill level) the water runs downhill
 *   from there. If that path reaches a lower basin's water, the flood stops at the saddle and the rest of its volume
 *   joins that basin, which resolves later. A path ending in a dry hollow pools with the basin (one level per basin: a
 *   depression hierarchy would keep the two apart; rare with craters, which open into the basin they breach).
 * - **Merge:** a flood that reaches a basin resolved before it (a higher lake now joined to it below both levels) takes
 *   that basin's water and cells in.
 * - **Cap:** no basin rises above `caps[i]` (its level from the planet's recipe): craters only add room, so a level can
 *   only rise when room is taken away again (a pending crater that never lands, or merged water); that water drains.
 * Ids stay stable; a basin left without cells keeps its id with none.
 */
export function resolveBasins(bed: ArrayLike<number>, n: number, prev: BasinSolution, volumes?: readonly number[],
  caps?: readonly number[]): BasinSolution {
  const g = cubeGrid(n);
  const nn = n * n;
  const labels = new Uint8Array(g.cells);
  const count = prev.basins.length;
  const vol = prev.basins.map((b, i) => Math.max(0, volumes?.[i] ?? b.volume));
  const out: Basin[] = prev.basins.map(b => ({ ...b, cells: 0, area: 0, volume: 0 }));
  const order = prev.basins.map((_, i) => i).sort((a, b) => prev.basins[b].level - prev.basins[a].level || a - b);
  const seenBy = new Int32Array(g.cells).fill(-1);
  const fillOf = new Float64Array(g.cells);
  const popped = new Int32Array(g.cells).fill(-1);
  const resolved = new Set<number>();
  for (const bi of order) {
    const p = prev.basins[bi];
    let seed = -1;
    for (let c = 0; c < g.cells; c++) if (prev.labels[c] === p.id && !labels[c] && (seed < 0 || bed[c] < bed[seed] || (bed[c] === bed[seed] && c < seed))) seed = c;
    if (seed < 0 || vol[bi] <= 0) { resolved.add(p.id); continue; }
    let target = vol[bi];
    const r2 = p.level * p.level;
    /** The basin a lower, unresolved basin's water belongs to at c, or 0. */
    const lowerAt = (c: number) => { const o = prev.labels[c]; return o && o !== p.id && !resolved.has(o) && !labels[c] ? o : 0; };
    /** Where water runs from c: steepest descent until another basin's water (its id) or a dry hollow (0). */
    const runsTo = (start: number) => {
      let c = start;
      for (let k = 0; k < g.cells; k++) {
        const o = lowerAt(c);
        if (o) return o;
        let next = c;
        for (let q = 0; q < 4; q++) { const nb = g.neighbours[c * 4 + q]; if (bed[nb] < bed[next]) next = nb; }
        if (next === c) return 0;
        c = next;
      }
      return 0;
    };
    const heap = new MinHeap(1024);
    const taken: number[] = [];
    let sA = 0, sAb = 0, level = bed[seed], spillTo = 0, filled = false;
    seenBy[seed] = bi; fillOf[seed] = bed[seed];
    heap.push(bed[seed], seed);
    while (heap.size > 0) {
      const c = heap.pop();
      const f = heap.lastKey;
      if (popped[c] === bi || f > fillOf[c]) continue;
      // Full before this cell's fill level: the level lies between the last one and f.
      if (sA > 0 && r2 * (sA * f - sAb) >= target) { level = (target / r2 + sAb) / sA; filled = true; break; }
      // A basin resolved before this one, now joined below both levels: take its water in.
      const merged = labels[c];
      if (merged && merged !== p.id) {
        const k = merged - 1;
        target += out[k].volume;
        out[k] = { ...out[k], cells: 0, area: 0, volume: 0 };
        for (let x = 0; x < g.cells; x++) if (labels[x] === merged) labels[x] = 0;
      }
      // A lower basin's water, here or downhill across a saddle: spill into it.
      const other = lowerAt(c) || (bed[c] < f - 1e-6 ? runsTo(c) : 0);
      if (other) { level = f; spillTo = other; break; }
      popped[c] = bi;
      taken.push(c);
      const a = g.area[c % nn];
      sA += a; sAb += a * bed[c];
      level = f;
      for (let q = 0; q < 4; q++) {
        const nb = g.neighbours[c * 4 + q];
        if (popped[nb] === bi) continue;
        const fl = Math.max(bed[nb], f);
        if (seenBy[nb] !== bi || fl < fillOf[nb]) { seenBy[nb] = bi; fillOf[nb] = fl; heap.push(fl, nb); }
      }
    }
    if (!filled && !spillTo && sA > 0) level = Math.max(level, (target / r2 + sAb) / sA);
    level = Math.min(level, caps?.[bi] ?? Infinity);
    let floor = Infinity, area = 0, volume = 0, cells = 0;
    for (const c of taken) {
      if (bed[c] >= level) continue;
      labels[c] = p.id;
      const a = g.area[c % nn] * level * level;
      floor = Math.min(floor, bed[c]); area += a; volume += a * (level - bed[c]); cells++;
    }
    if (spillTo) {
      const k = spillTo - 1;
      if (k >= 0 && k < count && target > volume) vol[k] += target - volume;
    }
    out[bi] = { ...p, level, floor: cells ? floor : p.floor, spill: spillTo ? level : Math.max(p.spill, level), cells, area, volume };
    resolved.add(p.id);
  }
  const sea = out.find(b => b.kind === 'sea' && b.cells > 0);
  return { n, labels, basins: out, seaLevel: sea ? sea.level : null };
}
