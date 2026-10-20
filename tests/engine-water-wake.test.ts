import { describe, expect, it } from 'vitest';
import { HULL_WAKE, hullWakeFlux } from '../src/engine/passes/fluids/hull-wake';
import { WATER_MAX_HULLS, WATER_SIM, WATER_TILE, WATER_TILE_LINKS } from '../src/engine/passes/fluids/liquid-params';
import { GAS_MAX_HULLS } from '../src/engine/passes/fluids/gas.wgsl';
import { PlanetWater, waterTiles, type WaterHost } from '../src/engine/passes/fluids/water';
import { cellDir, cubeGrid, cubeGridMetric } from '../src/world/cube-grid';

describe('moving hull water momentum', () => {
  it('drives shallow contact along travel, without creating a wake at rest or across a closed face', () => {
    const flux = (speed: number, open = 1, contact = 1) => hullWakeFlux(0, speed, .012, .1, open, contact, 1 / 60, 2);
    expect(flux(1)).toBeGreaterThan(0);
    expect(flux(-1)).toBe(0);
    expect(flux(0)).toBe(0);
    expect(flux(1, 1, 0)).toBe(0);
    expect(flux(1000, 0)).toBe(0);
    expect(hullWakeFlux(5, 1000, .012, .1, 0, 1, .1, 2)).toBe(0);
    expect(flux(1, .2)).toBeCloseTo(flux(1) * .2, 12);
  });

  it('caps teleport speed and remains bounded for a long frame', () => {
    for (const depth of [.0041, .012, .1, 1.5]) for (const dt of [1 / 240, 1 / 60, .1]) {
      const regular = hullWakeFlux(0, HULL_WAKE.maximumSpeed, depth, .11, .6, 1, dt, 2);
      expect(hullWakeFlux(0, 10000, depth, .11, .6, 1, dt, 2)).toBe(regular);
      expect(regular).toBeLessThanOrEqual(2 * depth * .11 * .6);
      expect(regular).toBeGreaterThanOrEqual(0);
    }
    const once = hullWakeFlux(0, 1, .03, .11, 1, 1, 1 / 30, 100);
    const half = hullWakeFlux(0, 1, .03, .11, 1, 1, 1 / 60, 100);
    expect(hullWakeFlux(half, 1, .03, .11, 1, 1, 1 / 60, 100)).toBeCloseTo(once, 12);
  });

  it('exchanges wake volume across cube seams deterministically without draining cells below zero', () => {
    // A closed planet, unequal cell areas, thin water, and deliberately aggressive travel. This isolates momentum
    // from gravity/reservoirs, then applies the production finite-volume outflow limiter and reverse-slot exchange.
    const grid = cubeGrid(4), metric = cubeGridMetric(4), dt = 1 / 30;
    const area = (c: number) => metric[(c % 16) * 12];
    const run = () => {
      let depth = Float64Array.from({ length: grid.cells }, (_, c) => .005 + (c % 7) * .002);
      let flow = new Float64Array(grid.cells * 4), seamVolume = 0;
      const volume = () => depth.reduce((sum, d, c) => sum + d * area(c), 0);
      const initial = volume();
      for (let step = 0; step < 240; step++) {
        const nextFlow = new Float64Array(flow.length);
        for (let c = 0; c < grid.cells; c++) {
          const d = cellDir(4, c), velocity = [d[2] * 30, 0, -d[0] * 30];
          let out = 0;
          for (let k = 0; k < 4; k++) {
            const at = c * 4 + k, n = grid.neighbours[at], other = cellDir(4, n);
            const edge = other.map((v, i) => v - d[i]), length = Math.hypot(...edge);
            const along = edge.reduce((s, v, i) => s + v * velocity[i], 0) / length;
            nextFlow[at] = hullWakeFlux(flow[at], along, depth[c], metric[(c % 16) * 12 + 4 + k], 1, 1, dt, 100);
            out += nextFlow[at];
          }
          const limit = Math.min(1, depth[c] * area(c) / Math.max(out * dt, 1e-20));
          for (let k = 0; k < 4; k++) nextFlow[c * 4 + k] *= limit;
        }
        const nextDepth = new Float64Array(depth.length);
        for (let c = 0; c < grid.cells; c++) {
          let exchange = 0;
          for (let k = 0; k < 4; k++) {
            const at = c * 4 + k, n = grid.neighbours[at];
            exchange += nextFlow[n * 4 + grid.reverse[at]] - nextFlow[at];
            if (Math.floor(c / 16) !== Math.floor(n / 16)) seamVolume += nextFlow[at] * dt;
          }
          nextDepth[c] = depth[c] + exchange * dt / area(c);
          expect(nextDepth[c]).toBeGreaterThanOrEqual(-1e-16);
        }
        depth = nextDepth; flow = nextFlow;
        expect(volume()).toBeCloseTo(initial, 12);
      }
      expect(seamVolume).toBeGreaterThan(.01);
      return depth;
    };
    expect(run()).toEqual(run());
  });
});

describe('fluid hull capacity and pipelines', () => {
  it('packs current and previous poses for all eight three-box tanks plus the dev hull', () => {
    expect(WATER_MAX_HULLS).toBeGreaterThanOrEqual(8 * 3 + 1);
    expect(GAS_MAX_HULLS).toBe(WATER_MAX_HULLS);
    const words = Array.from({ length: WATER_MAX_HULLS * 32 }, (_, k) => k + 1);
    const packed = new Float32Array(WATER_SIM.pack({ hulls: words, impulses: [9001], vents: [9002] }));
    const offset = WATER_SIM.offsets.hulls / 4;
    expect(Array.from(packed.subarray(offset, offset + words.length))).toEqual(words);
    expect(packed[WATER_SIM.offsets.impulses / 4]).toBe(9001);
    expect(packed[WATER_SIM.offsets.vents / 4]).toBe(9002);
    expect(WATER_SIM.size).toBeLessThan(16 * 1024);
  });

  it('supplies the live SDF bindings to flux and every coupling layout that shares its group', () => {
    const layouts: { label: string; entries: { binding: number }[] }[] = [];
    const host = { s: { ctx: { device: {
      createBindGroupLayout: (d: typeof layouts[number]) => { layouts.push(d); return d; },
      createBuffer: () => ({}), createSampler: () => ({}),
    }, pipelines: { register: () => {}, compile: () => Promise.resolve() } } } } as unknown as WaterHost;
    new PlanetWater(host);
    const bindings = (entry: string) => layouts.find(d => d.label === `layout:water-${entry}`)!.entries.map(e => e.binding);
    expect(bindings('flux_step')).toEqual(expect.arrayContaining([15, 17, 19, 20, 21, 22, 23]));
    for (const entry of ['couple_occupy', 'couple_share', 'couple_push']) expect(bindings(entry)).toEqual(bindings('flux_step'));
  });
});

// Every grid the tiers use (LIQUID_TIER_N).
describe.each([128, 256])('water activity tiles (N %i)', n => {
  const side = n / WATER_TILE, stride = 4 + WATER_TILE_LINKS;
  const tileOf = (c: number) => { const face = Math.floor(c / (n * n)), r = c % (n * n); return (face * side + Math.floor(r / n / WATER_TILE)) * side + Math.floor((r % n) / WATER_TILE); };

  it('link each tile to every tile a tile width of cell steps can reach, across seams and cube corners', () => {
    const { count, data } = waterTiles(n), g = cubeGrid(n), tile = Int32Array.from({ length: g.cells }, (_, c) => tileOf(c));
    const members: number[][] = Array.from({ length: count }, () => []);
    for (let c = 0; c < g.cells; c++) members[tile[c]].push(c);
    const stamp = new Int32Array(g.cells).fill(-1);
    let missing = 0;
    for (let t = 0; t < count; t++) {
      const linked = new Set([t, ...data.subarray(t * stride + 4, (t + 1) * stride)]);
      let front = members[t];
      for (const c of front) stamp[c] = t;
      for (let step = 0; step < WATER_TILE; step++) {
        const next: number[] = [];
        for (const c of front) for (let k = 0; k < 4; k++) {
          const m = g.neighbours[c * 4 + k];
          if (stamp[m] === t) continue;
          stamp[m] = t; next.push(m);
          if (!linked.has(tile[m])) missing++;
        }
        front = next;
      }
    }
    expect(missing).toBe(0);
  });

  it('bound every cell direction of a tile by its centre and angular radius', () => {
    const { data } = waterTiles(n), f = new Float32Array(data.buffer);
    let worst = -Infinity;
    for (let c = 0; c < 6 * n * n; c++) {
      const t = tileOf(c), d = cellDir(n, c), o = t * stride;
      worst = Math.max(worst, Math.acos(Math.min(1, f[o] * d[0] + f[o + 1] * d[1] + f[o + 2] * d[2])) - f[o + 3]);
    }
    expect(worst).toBeLessThanOrEqual(1e-6);
  });
});
