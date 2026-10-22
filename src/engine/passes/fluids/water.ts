import { previousWaterHulls, stableWaterHulls } from './hull-motion';
/**
 * Planet water, host side: the shallow-water layer's buffers, pipelines and
 * per-frame step. The WGSL and the model are described in water.wgsl.ts.
 *
 * - **Grid:** the level map's cube sphere (N² per face by tier). The neighbour table (with reverse slots), the flux
 *   metric and the dual mesh come from `src/world/cube-grid.ts`, built once per N.
 * - **Initial fill:** from the recipe solve (the basin labels and levels in the liquid params), then about a second of
 *   warm-up substeps so cells the coarse labels missed fill by flow before anyone looks.
 * - **Substeps:** as many as the frame needs under the CFL limit for the capped flux depth (3 at 60 fps on High), at
 *   most 4; a longer frame runs slower rather than unstable.
 * - **Per frame:** the tiles that can change (the others are skipped), the hulls' occupancy and push, then the substeps
 *   ('fluids.step'); flow and foam, the level rings, the drawn surface, the atlas pack and the visible-quad cull
 *   ('fluids.water'); the surface depth in 'transparent' ('fluids.surface').
 * - **Hulls and blasts:** `setHulls` every frame (every tank, hidden ones too: their wakes are real, and show only where
 *   the water is seen); `impulse` for a blast, a short outward acceleration; `testHull` drives a dev hull along a line.
 * - **Volume:** a reduction read back about twice a second (`volume`), for the dev panel and the drift gates.
 * Presentation only (N5): nothing here reaches the simulation.
 */
import type { EngineServices, PassContext } from '../../contracts';
import { BindGroupResourceCache } from '../../gpu/bind-group-cache';
import { BufferUsage, MapMode, ShaderStage, TextureUsage } from '../../gpu/flags';
import { link } from '../../wgsl/module';
import { cellDir, cellIndex, cellOfDir, cubeGrid, cubeGridDualQuads, cubeGridMetric } from '../../../world/cube-grid';
import { cubeDir } from '../../../world/cube-sphere';
import {
  WATER_BAND_RINGS, WATER_MAX_HULLS, WATER_MAX_IMPULSES, WATER_MAX_VENTS, WATER_SIM, WATER_SIM_FLAG, WATER_TILE, WATER_TILE_LINKS, WATER_TILE_WORDS,
} from './liquid-params';
import { waterProbeWgsl, waterStepWgsl, waterSurfaceWgsl, waterTilesWgsl } from './water.wgsl';

/** The water's constants (tuned in the browser). Lengths in u, times in s. */
export const WATER_TUNING = {
  gravity: 9.81,
  /** The depth the flux sees at most: waves over deeper water travel at √(g·cap), inside the CFL limit. */
  depthCap: 1.5,
  /**
   * Courant number of a substep for that wave speed. Measured on the deep sea with the step pinned at this limit (a slow
   * frame that hits maxSubsteps): 0.45 grew a cell-scale checkerboard from rounding noise in ~20 s, starting at a face
   * seam, and never settled; 0.40 and 0.35 stayed flat. Keep the margin: the limit is the step a slow GPU runs every frame.
   */
  cfl: 0.35,
  maxSubsteps: 4,
  /** Bottom friction (u/s; the damping rate is this over the depth) and the waves' own damping (1/s). */
  friction: 0.02,
  damping: 0.05,
  /** Thinner water counts as dry. */
  wetDepth: 0.004,
  /** Lava: viscosity (u²/s), yield height (u), and how much the water's weight presses on it. */
  lavaViscosity: 0.24,
  lavaYield: 0.002,
  waterOnLava: 0.4,
  /** Lava cooling (1/s at full heat, ×4 in thin sheets), how steeply it stiffens as it cools (viscosity × e^(k·(1 − T))),
   *  a lake's temperature, and the water it boils off per s at full heat (u/s). */
  lavaCooling: 0.02,
  lavaStiffening: 4.5,
  lakeHeat: 0.92,
  quenchRate: 0.08,
  /** The open sea (deeper than openDepth) relaxes toward its recipe level at this rate (1/s). */
  seaRate: 1 / 20,
  openDepth: 0.6,
  /** Radius the unit-sphere metric is scaled to (about the water's). */
  radius: 17.5,
  /** A front running downhill is drawn this far under the bed. */
  frontDip: 0.05,
  /** Foam: fading rate (1/s); growth per u/s of speed above foamSpeed, and per unit of surface slope above foamSlope. */
  foamDecay: 0.35,
  foamFromSpeed: 0.5,
  foamSpeed: 1.5,
  foamFromSlope: 2.5,
  foamSlope: 0.35,
  /** Turbulent drag: a damping rate of this × speed / depth. */
  turbulence: 0.04,
  /** Warm-up after a fill (s of simulated time). */
  warmup: 1.0,
  /** A blast pushes the water outward at this speed per u of blast radius at its centre, over blastTime (s). */
  blastSpeed: 0.8,
  blastTime: 0.15,
  /** Grid-scale filter per frame (a single-cell spike loses about 64× this; waves of 20 cells lose ~0.01%). */
  gridFilter: 0.006,
  /** Hull draft tapers over this width across the box's sides (u). */
  hullTaper: 0.22,
  /** Foam a blast adds per second at its centre. */
  blastFoam: 10,
  /** A blast reaches this many blast radii. */
  blastReach: 1.4,
} as const;

/** A moving solid in the water: a tank or structural envelope at its rendered pose. */
export interface WaterHull {
  /** Stable presentation identity; never infer motion between unrelated bodies. */
  id?: string;
  centre: readonly number[];
  /** Unit axes (x, y, z) of the box in world space. */
  axes: readonly (readonly number[])[];
  /** Half extents along those axes (u). */
  half: readonly number[];
}

export interface WaterHost {
  s: EngineServices;
  /** The liquid params (the fill reads the basin table). */
  params: GPUBuffer;
  /** The coarse basin labels of the recipe solve. */
  labels: GPUBuffer;
  /** The level map's bed (6·N² radii), or null before it exists. */
  bed(): GPUBuffer | null;
  computePass(c: PassContext, name: string): GPUComputePassEncoder;
}

export interface WaterFrame {
  /** The sea level the open sea relaxes toward (0 = no sea). */
  seaLevel: number;
  lava: boolean;
  simulate: boolean;
  /** Ambient swell amplitude scale (0 = none). */
  swell: number;
  /** Lava vents erupting this frame: centre (world), radius (u), lava added at the centre (u/s). */
  vents: readonly { centre: readonly number[]; radius: number; rate: number }[];
}

const ENTRIES = ['init', 'lava_faces', 'couple_occupy', 'couple_share', 'couple_push', 'flux_step', 'depth_step', 'smooth_lap', 'smooth_apply', 'flow', 'ext_first', 'ext_next', 'surface', 'pack', 'cull', 'volume'] as const;
type Entry = typeof ENTRIES[number];
const TILE_ENTRIES = ['tiles_mark', 'tiles_spread'] as const;
type TileEntry = typeof TILE_ENTRIES[number];
/** Points per probe (one gather dispatch). */
const PROBE_POINTS = 64;
// Coupling and flux reuse one group across dispatches. Flux's moving-water drag samples the live terrain SDF.
const COUPLING_BINDINGS = [15, 17, 19, 20, 21, 22, 23] as const;
/** Group-1 bindings each entry point uses (the WGSL declares them all; each pipeline's layout holds its own). */
const GROUP1: Readonly<Record<Entry, readonly number[]>> = {
  init: [0, 1, 17], lava_faces: [19, 20, 21, 22],
  couple_occupy: COUPLING_BINDINGS, couple_share: COUPLING_BINDINGS, couple_push: COUPLING_BINDINGS, flux_step: COUPLING_BINDINGS, depth_step: [],
  smooth_lap: [16], smooth_apply: [16], flow: [4, 9, 10, 15, 17, 18],
  ext_first: [3], ext_next: [2, 3], surface: [2, 4],
  pack: [2, 4, 11, 12, 13, 14, 17], cull: [4, 5, 6, 7], volume: [8],
};

/** The dev hull's half extents (a tank hull with its fenders). */
const TEST_HULL_HALF = [0.635, 0.29, 0.905];

const tilesCache = new Map<number, { count: number; data: Uint32Array<ArrayBuffer> }>();
/**
 * The activity tiles of an N grid (memoised): per tile its centre direction and angular radius (to its corner cells, the
 * farthest: tile edges are great circles), then the tiles within one of it, across seams and corners (padded with itself).
 */
export function waterTiles(n: number): { count: number; data: Uint32Array<ArrayBuffer> } {
  const hit = tilesCache.get(n);
  if (hit) return hit;
  const side = n / WATER_TILE, count = 6 * side * side, g = cubeGrid(n), stride = 4 + WATER_TILE_LINKS;
  if (!Number.isInteger(side)) throw new Error(`Water grid ${n} is not a whole number of tiles.`);
  const tileOf = (c: number) => {
    const face = Math.floor(c / (n * n)), r = c - face * n * n;
    return (face * side + Math.floor(Math.floor(r / n) / WATER_TILE)) * side + Math.floor((r % n) / WATER_TILE);
  };
  // A tile's corner cells reach every tile beside it: tiles line up across seams (WATER_TILE divides N).
  const near = Array.from({ length: count }, () => new Set<number>()), last = WATER_TILE - 1;
  for (let t = 0; t < count; t++) {
    const face = Math.floor(t / (side * side)), i0 = (t % side) * WATER_TILE, j0 = Math.floor((t % (side * side)) / side) * WATER_TILE;
    for (const [i, j] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      const c = cellIndex(n, face, i0 + i, j0 + j);
      for (let k = 0; k < 4; k++) { const u = tileOf(g.neighbours[c * 4 + k]); if (u !== t) near[t].add(u); }
    }
  }
  const data = new Uint32Array(count * stride), f = new Float32Array(data.buffer);
  for (let t = 0; t < count; t++) {
    const links = new Set<number>();
    for (const a of near[t]) { links.add(a); for (const b of near[a]) links.add(b); }
    links.delete(t);
    if (links.size > WATER_TILE_LINKS) throw new Error(`Water tile ${t} has ${links.size} neighbours.`);
    const face = Math.floor(t / (side * side)), ti = t % side, tj = Math.floor((t % (side * side)) / side);
    const centre = cubeDir(face, [((ti + 0.5) * WATER_TILE * 2) / n - 1, ((tj + 0.5) * WATER_TILE * 2) / n - 1]);
    let radius = 0;
    for (const [i, j] of [[0, 0], [WATER_TILE - 1, 0], [0, WATER_TILE - 1], [WATER_TILE - 1, WATER_TILE - 1]]) {
      const d = cellDir(n, cellIndex(n, face, ti * WATER_TILE + i, tj * WATER_TILE + j));
      radius = Math.max(radius, Math.acos(Math.min(1, centre[0] * d[0] + centre[1] * d[1] + centre[2] * d[2])));
    }
    f.set([centre[0], centre[1], centre[2], radius], t * stride);
    data.set([...links, ...new Array<number>(WATER_TILE_LINKS - links.size).fill(t)], t * stride + 4);
  }
  const out = { count, data };
  tilesCache.set(n, out);
  return out;
}

export class PlanetWater {
  n = 0;
  cells = 0;
  quads = 0;
  /** Smallest centre distance at the metric radius (u): the CFL length. */
  dxMin = 0;
  atlasA: GPUTexture | null = null;
  atlasN: GPUTexture | null = null;
  atlasF: GPUTexture | null = null;
  atlasL: GPUTexture | null = null;
  views: { a: GPUTextureView; n: GPUTextureView; f: GPUTextureView; l: GPUTextureView } | null = null;
  /** Filled and stepping. */
  live = false;
  /** Substeps of the last frame, and the last volume read back (u³). */
  substeps = 0;
  /** The last volumes read back (u³), and the open sea's mean level (u; 0 = none). */
  readonly volume = { water: 0, lava: 0, seaLevel: 0, frame: -1 };
  fills = 0;
  private initWanted = false;
  private readonly sim: GPUBuffer;
  private readonly staging = new ArrayBuffer(WATER_SIM.size);
  /** Reused every frame: the hulls (this frame's, then last frame's), the impulses and the indirect draw's reset. */
  private readonly hullWords = new Float32Array(WATER_MAX_HULLS * 32);
  private readonly impulseWords = new Float32Array(WATER_MAX_IMPULSES * 8);
  private readonly drawReset = new Uint32Array([0, 1, 0, 0, 0]);
  private readonly core: GPUBindGroupLayout;
  private readonly group1 = new Map<Entry, GPUBindGroupLayout>();
  private readonly surfaceLayout: GPUBindGroupLayout;
  private readonly tilesLayout: GPUBindGroupLayout;
  private readonly probeLayout: GPUBindGroupLayout;
  /** The probe's cell list (count first) and gather output, and the readback buffers free for the next probe. */
  private readonly probeCells: GPUBuffer;
  private readonly probeOut: GPUBuffer;
  private readonly probeFree: GPUBuffer[] = [];
  private readonly probeGroups = new BindGroupResourceCache(2);
  private readonly keys: Record<Entry | 'surface_draw' | TileEntry, string>;
  private readonly probeKey = 'fluids:water:probe';
  private readonly sampler: GPUSampler;
  private buffers: Record<'nbr' | 'metric' | 'state' | 'flux' | 'lflux' | 'vel' | 'info' | 'hull' | 'lap' | 'heat' | 'barriers' | 'lvlA' | 'lvlB' | 'surf' | 'quads' | 'index' | 'args' | 'sums' | 'tiles' | 'tileInfo' | 'bedChanges', GPUBuffer> | null = null;
  private tileCount = 0;
  private tilesGroup: GPUBindGroup | null = null;
  private readonly surfaceGroups = new BindGroupResourceCache(4);
  private hulls: readonly WaterHull[] = [];
  /** The hulls of the last frame (the test hull included), for the gas's obstacles. */
  lastHulls: readonly WaterHull[] = [];
  private impulses: { centre: readonly number[]; radius: number; accel: number; foam: number; until: number }[] = [];
  private test: { from: readonly number[]; to: readonly number[]; speed: number; t0: number } | null = null;
  private time = 0;
  private readback: GPUBuffer | null = null;
  private reading = false;
  private coreGroup: GPUBindGroup | null = null;
  private coreKey: GPUBuffer | null = null;
  private groups: Partial<Record<Entry | 'ext_ab' | 'ext_ba', GPUBindGroup>> = {};
  private finalLevels: 'lvlA' | 'lvlB' = 'lvlA';
  private sdfKey: unknown = null;

  constructor(private readonly host: WaterHost) {
    const { device } = host.s.ctx;
    const C = ShaderStage.COMPUTE;
    const storage = (binding: number, readOnly = false) => ({ binding, visibility: C, buffer: { type: readOnly ? 'read-only-storage' as const : 'storage' as const } });
    this.core = device.createBindGroupLayout({ label: 'layout:water-core', entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } }, storage(1, true), storage(2, true), storage(3, true),
      storage(4), storage(5), storage(6), storage(7), storage(8), storage(9, true)] });
    this.tilesLayout = device.createBindGroupLayout({ label: 'layout:water-tiles', entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } }, storage(1, true), storage(2), storage(3, true), storage(4)] });
    this.probeLayout = device.createBindGroupLayout({ label: 'layout:water-probe', entries: [
      storage(0, true), storage(1, true), storage(2, true), storage(3, true), storage(4, true), storage(5)] });
    const entry1: Record<number, GPUBindGroupLayoutEntry> = {
      0: { binding: 0, visibility: C, buffer: { type: 'uniform' } }, 1: storage(1, true), 2: storage(2, true), 3: storage(3), 4: storage(4),
      5: storage(5, true), 6: storage(6), 7: storage(7), 8: storage(8),
      9: { binding: 9, visibility: C, texture: { sampleType: 'float' } }, 10: { binding: 10, visibility: C, sampler: { type: 'filtering' } },
      11: { binding: 11, visibility: C, storageTexture: { access: 'write-only', format: 'rgba32float' } },
      12: { binding: 12, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      13: { binding: 13, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      14: { binding: 14, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      15: storage(15), 16: storage(16), 17: storage(17), 18: { binding: 18, visibility: C, texture: { sampleType: 'float' } },
      19: storage(19), 20: { binding: 20, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
      21: { binding: 21, visibility: C, buffer: { type: 'uniform' } }, 22: { binding: 22, visibility: C, sampler: { type: 'filtering' } },
      23: storage(23),
    };
    const cache = host.s.ctx.pipelines;
    const code = link(waterStepWgsl);
    this.keys = { ...Object.fromEntries([...ENTRIES, ...TILE_ENTRIES].map(e => [e, `fluids:water:${e}`])), surface_draw: 'fluids:water:surface-draw' } as
      Record<Entry | 'surface_draw' | TileEntry, string>;
    cache.register(this.probeKey, 'compute', () => ({
      label: this.probeKey, layout: device.createPipelineLayout({ bindGroupLayouts: [this.probeLayout] }),
      compute: { module: cache.shaderModule(link(waterProbeWgsl), this.probeKey), entryPoint: 'probe' },
    }));
    void cache.compile(this.probeKey).catch(() => undefined);
    const tilesCode = link(waterTilesWgsl);
    for (const e of TILE_ENTRIES) {
      cache.register(this.keys[e], 'compute', () => ({
        label: this.keys[e], layout: device.createPipelineLayout({ bindGroupLayouts: [this.tilesLayout] }),
        compute: { module: cache.shaderModule(tilesCode, 'fluids:water-tiles'), entryPoint: e },
      }));
      void cache.compile(this.keys[e]).catch(() => undefined);
    }
    for (const e of ENTRIES) {
      const used = GROUP1[e];
      if (used.length) this.group1.set(e, device.createBindGroupLayout({ label: `layout:water-${e}`, entries: used.map(b => entry1[b]) }));
      const layouts = used.length ? [this.core, this.group1.get(e)!] : [this.core];
      cache.register(this.keys[e], 'compute', () => ({
        label: this.keys[e], layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        compute: { module: cache.shaderModule(code, 'fluids:water'), entryPoint: e },
      }));
      void cache.compile(this.keys[e]).catch(() => undefined);
    }
    this.surfaceLayout = device.createBindGroupLayout({ label: 'layout:water-surface', entries: [
      { binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 3, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
    cache.register(this.keys.surface_draw, 'render', () => {
      const module = cache.shaderModule(link(waterSurfaceWgsl), this.keys.surface_draw);
      return {
        label: this.keys.surface_draw, layout: device.createPipelineLayout({ bindGroupLayouts: [host.s.ctx.layouts.frame, this.surfaceLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      };
    });
    void cache.compile(this.keys.surface_draw).catch(() => undefined);
    this.sim = device.createBuffer({ label: 'fluids:water-sim', size: WATER_SIM.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.probeCells = device.createBuffer({ label: 'fluids:water-probe-cells', size: (PROBE_POINTS + 1) * 4, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    this.probeOut = device.createBuffer({ label: 'fluids:water-probe-out', size: PROBE_POINTS * 48, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC });
    this.sampler = device.createSampler({ label: 'fluids:water-linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  ready(): boolean {
    const cache = this.host.s.ctx.pipelines;
    return !!this.buffers && Object.values(this.keys).every(k => cache.get(k));
  }

  /** (Re)allocate for N cells per face edge; the water refills once the bed exists. */
  allocate(n: number): void {
    if (n === this.n && this.buffers) return;
    const { device, queue } = this.host.s.ctx;
    this.release();
    this.n = n;
    const g = cubeGrid(n);
    this.cells = g.cells;
    const nbr = new Uint32Array(g.cells * 4);
    for (let k = 0; k < nbr.length; k++) nbr[k] = (g.neighbours[k] | (g.reverse[k] << 30)) >>> 0;
    const metric = cubeGridMetric(n);
    let dx = Infinity;
    for (let k = 0; k < n * n; k++) for (let e = 0; e < 4; e++) dx = Math.min(dx, metric[k * 12 + 8 + e]);
    this.dxMin = dx * WATER_TUNING.radius;
    const quads = cubeGridDualQuads(n);
    this.quads = quads.length / 4;
    const make = (label: string, size: number, usage: number = BufferUsage.STORAGE) => device.createBuffer({ label: `fluids:water-${label}`, size, usage });
    const upload = (label: string, data: ArrayBufferView & { byteLength: number }) => {
      const b = make(label, data.byteLength, BufferUsage.STORAGE | BufferUsage.COPY_DST);
      queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      return b;
    };
    const cells = g.cells, tiles = waterTiles(n);
    this.buffers = {
      nbr: upload('nbr', nbr), metric: upload('metric', metric), quads: upload('quads', quads),
      state: make('state', cells * 16, BufferUsage.STORAGE | BufferUsage.COPY_SRC), flux: make('flux', cells * 16), lflux: make('lflux', cells * 16), vel: make('vel', cells * 16, BufferUsage.STORAGE | BufferUsage.COPY_SRC),
      info: make('info', cells * 4), hull: make('hull', cells * 16, BufferUsage.STORAGE | BufferUsage.COPY_DST), lap: make('lap', cells * 4), heat: make('heat', cells * 8, BufferUsage.STORAGE | BufferUsage.COPY_SRC), lvlA: make('lvl-a', cells * 16), lvlB: make('lvl-b', cells * 16), surf: make('surf', cells * 4),
      barriers: make('barriers', cells * 16),
      index: make('index', this.quads * 6 * 4, BufferUsage.STORAGE | BufferUsage.INDEX),
      args: make('args', 32, BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_DST),
      sums: make('sums', Math.ceil(cells / 256) * 16, BufferUsage.STORAGE | BufferUsage.COPY_SRC),
      tiles: make('tiles', WATER_TILE_WORDS * 8, BufferUsage.STORAGE | BufferUsage.UNIFORM | BufferUsage.COPY_DST), tileInfo: upload('tile-info', tiles.data),
      bedChanges: make('bed-changes', WATER_TILE_WORDS * 4),
    };
    this.tileCount = tiles.count;
    this.tilesGroup = null;
    this.readback = device.createBuffer({ label: 'fluids:water-sums-readback', size: Math.ceil(cells / 256) * 16, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    const size: [number, number] = [3 * (n + 2), 2 * (n + 2)];
    const tex = (label: string, format: GPUTextureFormat) => device.createTexture({ label: `fluids:water-${label}`, size, format,
      usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
    this.atlasA = tex('atlas-a', 'rgba32float');
    this.atlasN = tex('atlas-n', 'rgba16float');
    this.atlasF = tex('atlas-f', 'rgba16float');
    this.atlasL = tex('atlas-l', 'rgba16float');
    this.views = { a: this.atlasA.createView(), n: this.atlasN.createView(), f: this.atlasF.createView(), l: this.atlasL.createView() };
    this.finalLevels = WATER_BAND_RINGS % 2 === 1 ? 'lvlA' : 'lvlB';
    this.groups = {};
    this.coreGroup = null;
    this.coreKey = null;
    this.live = false;
    this.initWanted = true;
  }

  /** This frame's tile mask (one bit per tile: its cells can change), once the step has built it. */
  tilesOn(): GPUBufferBinding | null {
    return this.buffers ? { buffer: this.buffers.tiles, offset: WATER_TILE_WORDS * 4, size: WATER_TILE_WORDS * 4 } : null;
  }

  /** Tiles whose bed the bed march changed (one bit each, set by the march), taken by the next frame's tile mask. */
  bedChanges(): GPUBuffer | null { return this.buffers?.bedChanges ?? null; }

  /** The cell buffers other passes read (spray emission), or null before the water exists. */
  cellBuffers(): { state: GPUBuffer; vel: GPUBuffer; hull: GPUBuffer; heat: GPUBuffer; n: number; cells: number; wetDepth: number; radius: number; advancing: boolean } | null {
    const b = this.buffers;
    return b && this.live ? { state: b.state, vel: b.vel, hull: b.hull, heat: b.heat, n: this.n, cells: this.cells, wetDepth: WATER_TUNING.wetDepth,
      radius: WATER_TUNING.radius, advancing: this.substeps > 0 } : null;
  }

  /** Fill again from the basins in the params (a new recipe solve, a new planet, a dev reset). */
  refill(): void { this.initWanted = true; }

  /** Tank and structural envelopes this frame (the first WATER_MAX_HULLS). */
  setHulls(hulls: readonly WaterHull[]): void { this.hulls = hulls; }

  /** A blast of radius `radius` at `centre`: the water within reach is pushed outward for a moment and whitened. */
  impulse(centre: readonly number[], radius: number): void {
    const T = WATER_TUNING;
    this.impulses.push({ centre: [...centre], radius: radius * T.blastReach, accel: (T.blastSpeed * radius) / T.blastTime, foam: T.blastFoam, until: this.time + T.blastTime });
    if (this.impulses.length > WATER_MAX_IMPULSES) this.impulses.shift();
  }

  /** Small, bounded surface crossing. Does not evict an active explosion impulse. */
  disturb(centre: readonly number[], radius: number, energy: number): boolean {
    if (this.impulses.length >= WATER_MAX_IMPULSES) return false;
    this.impulses.push({ centre: [...centre], radius, accel: (0.16 + energy * 0.5) / 0.12,
      foam: 1 + energy * 5, until: this.time + 0.12 });
    return true;
  }

  /** Dev: a tank-sized hull (not drawn) moving from `from` to `to` at `speed` u/s, then resting there; null removes it. */
  testHull(from: readonly number[] | null, to?: readonly number[], speed = 2.5): void {
    this.test = from && to ? { from: [...from], to: [...to], speed, t0: this.time } : null;
  }

  /** Dev: the test hull's box as debug lines (it has no model), cleared once it is removed. */
  private drawTestHull(h: WaterHull | null): void {
    const lines = this.host.s.scene.get('debugLines');
    if (!lines) return;
    if (!h) { if (this.drewTest) { lines.clear(); this.drewTest = false; } return; }
    const corner = (sx: number, sy: number, sz: number) => [0, 1, 2].map(k => h.centre[k] + h.axes[0][k] * h.half[0] * sx + h.axes[1][k] * h.half[1] * sy + h.axes[2][k] * h.half[2] * sz);
    const seg: number[] = [];
    for (const [a, b] of [[[-1, -1, -1], [1, -1, -1]], [[-1, 1, -1], [1, 1, -1]], [[-1, -1, 1], [1, -1, 1]], [[-1, 1, 1], [1, 1, 1]],
      [[-1, -1, -1], [-1, 1, -1]], [[1, -1, -1], [1, 1, -1]], [[-1, -1, 1], [-1, 1, 1]], [[1, -1, 1], [1, 1, 1]],
      [[-1, -1, -1], [-1, -1, 1]], [[1, -1, -1], [1, -1, 1]], [[-1, 1, -1], [-1, 1, 1]], [[1, 1, -1], [1, 1, 1]]]) {
      seg.push(...corner(a[0], a[1], a[2]), ...corner(b[0], b[1], b[2]));
    }
    lines.set(new Float32Array(seg), [1, 0.55, 0.1]);
    this.drewTest = true;
  }
  private drewTest = false;

  private testHullNow(half: readonly number[]): WaterHull | null {
    const h = this.test;
    if (!h) return null;
    const d = [h.to[0] - h.from[0], h.to[1] - h.from[1], h.to[2] - h.from[2]];
    const length = Math.hypot(d[0], d[1], d[2]) || 1;
    const k = Math.min(1, Math.max(0, ((this.time - h.t0) * h.speed) / length));
    const p = [h.from[0] + d[0] * k, h.from[1] + d[1] * k, h.from[2] + d[2] * k];
    const r = Math.hypot(p[0], p[1], p[2]) || 1;
    const up = [p[0] / r, p[1] / r, p[2] / r];
    const along = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
    const f = [d[0] - up[0] * along, d[1] - up[1] * along, d[2] - up[2] * along];
    if (Math.hypot(...f) < 1e-6) {
      const ref = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      f.splice(0, 3, ref[1] * up[2] - ref[2] * up[1], ref[2] * up[0] - ref[0] * up[2], ref[0] * up[1] - ref[1] * up[0]);
    }
    const lf = Math.hypot(f[0], f[1], f[2]) || 1;
    const z = [f[0] / lf, f[1] / lf, f[2] / lf];
    const x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
    return { centre: p, axes: [x, up, z], half };
  }

  private release(): void {
    const b = this.buffers;
    if (b) for (const x of Object.values(b)) this.host.s.ctx.deferDestroy(x);
    for (const t of [this.atlasA, this.atlasN, this.atlasF, this.atlasL, this.readback]) this.host.s.ctx.deferDestroy(t);
    this.buffers = null;
    this.readback = null;
    this.atlasA = this.atlasN = this.atlasF = this.atlasL = null;
    this.views = null;
    this.live = false;
  }

  dispose(): void {
    this.release();
    for (const b of [this.sim, this.probeCells, this.probeOut, ...this.probeFree.splice(0)]) this.host.s.ctx.deferDestroy(b);
  }

  private bind(e: Entry | 'ext_ab' | 'ext_ba'): GPUBindGroup {
    const sdf = this.host.s.bindings.get('sdf');
    if (this.sdfKey !== sdf.volume) {
      this.sdfKey = sdf.volume;
      for (const key of ['lava_faces', 'flux_step', 'couple_occupy', 'couple_share', 'couple_push'] as const) delete this.groups[key];
    }
    const hit = this.groups[e];
    if (hit) return hit;
    const b = this.buffers!, v = this.views!;
    const buf = (buffer: GPUBuffer) => ({ buffer });
    const lvlIn = b[this.finalLevels];
    const resources: Record<number, GPUBindingResource> = {
      0: buf(this.host.params), 1: buf(this.host.labels), 4: buf(b.surf), 5: buf(b.quads), 6: buf(b.index), 7: buf(b.args), 8: buf(b.sums),
      9: v.n, 10: this.sampler, 11: v.a, 12: v.n, 13: v.f, 14: v.l, 15: buf(b.hull), 16: buf(b.lap), 17: buf(b.heat), 18: v.l,
      19: buf(b.barriers), 20: sdf.volume, 21: sdf.params, 22: this.sampler, 23: buf(b.lvlA),
    };
    let entry: Entry = e === 'ext_ab' || e === 'ext_ba' ? 'ext_next' : e;
    if (entry === 'couple_occupy' || entry === 'couple_share' || entry === 'couple_push') entry = 'flux_step';
    if (entry === 'smooth_apply') entry = 'smooth_lap';
    if (e === 'ext_first') resources[3] = buf(b.lvlA);
    else if (e === 'ext_ab') { resources[2] = buf(b.lvlA); resources[3] = buf(b.lvlB); }
    else if (e === 'ext_ba') { resources[2] = buf(b.lvlB); resources[3] = buf(b.lvlA); }
    else resources[2] = buf(lvlIn);
    if (e === 'ext_first') entry = 'ext_first';
    const group = this.host.s.ctx.device.createBindGroup({ label: `fluids:water-${e}`, layout: this.group1.get(entry)!,
      entries: GROUP1[entry].map(binding => ({ binding, resource: resources[binding] })) });
    this.groups[e] = group;
    return group;
  }

  private coreBindGroup(bed: GPUBuffer): GPUBindGroup {
    if (this.coreGroup && this.coreKey === bed) return this.coreGroup;
    const b = this.buffers!;
    this.coreKey = bed;
    this.coreGroup = this.host.s.ctx.device.createBindGroup({ label: 'fluids:water-core', layout: this.core, entries: [
      { binding: 0, resource: { buffer: this.sim } }, { binding: 1, resource: { buffer: b.nbr } }, { binding: 2, resource: { buffer: b.metric } },
      { binding: 3, resource: { buffer: bed } }, { binding: 4, resource: { buffer: b.state } }, { binding: 5, resource: { buffer: b.flux } },
      { binding: 6, resource: { buffer: b.lflux } }, { binding: 7, resource: { buffer: b.vel } }, { binding: 8, resource: { buffer: b.info } },
      { binding: 9, resource: this.tilesOn()! }] });
    return this.coreGroup;
  }

  private tilesBindGroup(): GPUBindGroup {
    const b = this.buffers!;
    this.tilesGroup ??= this.host.s.ctx.device.createBindGroup({ label: 'fluids:water-tiles', layout: this.tilesLayout, entries: [
      { binding: 0, resource: { buffer: this.sim } }, { binding: 1, resource: { buffer: b.state } }, { binding: 2, resource: { buffer: b.tiles } },
      { binding: 3, resource: { buffer: b.tileInfo } }, { binding: 4, resource: { buffer: b.bedChanges } }] });
    return this.tilesGroup;
  }

  /** The frame's water: fill if asked, substeps, flow, the drawn surface, the atlas and the cull ('compute.sim'). */
  run(c: PassContext, o: WaterFrame): void {
    this.substeps = 0;
    const bed = this.host.bed();
    if (!this.ready() || !bed) return;
    const { queue } = this.host.s.ctx;
    const T = WATER_TUNING;
    const cache = this.host.s.ctx.pipelines;
    const frameDt = Math.min(Math.max(c.frame.dt, 0), 0.1);
    this.time += frameDt;
    for (let k = this.impulses.length - 1; k >= 0; k--) if (!(this.impulses[k].until > this.time)) this.impulses.splice(k, 1);
    const test = this.testHullNow(TEST_HULL_HALF);
    this.drawTestHull(test);
    const current = (test ? [...this.hulls, { ...test, id: 'developer-hull' }] : this.hulls).slice(0, WATER_MAX_HULLS);
    const previousHulls = previousWaterHulls(current, this.lastHulls);
    const hulls = stableWaterHulls(current, previousHulls);
    const hullWords = this.hullWords.fill(0);
    const packHull = (h: WaterHull, k: number) => {
      const o = k * 16;
      hullWords[o] = h.centre[0]; hullWords[o + 1] = h.centre[1]; hullWords[o + 2] = h.centre[2];
      hullWords[o + 3] = Math.hypot(h.half[0], h.half[1], h.half[2]);
      for (let a = 0; a < 3; a++) {
        const at = o + 4 + a * 4, axis = h.axes[a];
        hullWords[at] = axis[0]; hullWords[at + 1] = axis[1]; hullWords[at + 2] = axis[2]; hullWords[at + 3] = h.half[a];
      }
    };
    for (let k = 0; k < hulls.length; k++) packHull(hulls[k], k);
    for (let k = 0; k < previousHulls.length; k++) packHull(previousHulls[k], WATER_MAX_HULLS + k);
    const impulseWords = this.impulseWords.fill(0);
    this.impulses.forEach((i, k) => {
      impulseWords[k * 8] = i.centre[0]; impulseWords[k * 8 + 1] = i.centre[1]; impulseWords[k * 8 + 2] = i.centre[2];
      impulseWords[k * 8 + 3] = i.radius; impulseWords[k * 8 + 4] = i.accel; impulseWords[k * 8 + 5] = i.foam;
    });
    const dtMax = T.cfl * this.dxMin / Math.sqrt(T.gravity * T.depthCap);
    const fill = this.initWanted;
    let substeps = 0, dt = dtMax;
    if (fill) substeps = Math.ceil(T.warmup / dtMax);
    else if (o.simulate && frameDt > 0) {
      substeps = Math.min(Math.max(Math.ceil(frameDt / dtMax), 1), T.maxSubsteps);
      dt = Math.min(frameDt / substeps, dtMax);
    }
    this.substeps = fill ? 0 : substeps;
    if (substeps > 0) this.lastHulls = hulls;
    WATER_SIM.pack({
      dims: [this.n, this.cells, this.quads, c.frame.index >>> 0],
      step: [dt, T.gravity, T.depthCap, 0.5 * this.dxMin / dt],
      fric: [T.friction, T.damping, T.wetDepth, T.lavaViscosity],
      sea: [o.seaLevel, T.seaRate, T.openDepth, T.radius],
      shape: [T.frontDip, T.lavaYield, T.waterOnLava, T.foamDecay],
      frame: [frameDt, c.frame.time, T.foamFromSpeed, T.foamSpeed],
      foam: [T.foamFromSlope, T.foamSlope, T.turbulence, 0],
      eye: [...c.frame.eye, (o.lava ? WATER_SIM_FLAG.lava : 0) | (o.simulate ? WATER_SIM_FLAG.simulate : 0)],
      view_proj: c.frame.viewProj,
      counts: [hulls.length, this.impulses.length, Math.min(o.vents.length, WATER_MAX_VENTS), previousHulls.length],
      heat: [T.lavaCooling, T.lavaStiffening, T.lakeHeat, T.quenchRate],
      vents: o.vents.slice(0, WATER_MAX_VENTS).flatMap(v => [v.centre[0], v.centre[1], v.centre[2], v.radius, v.rate, 0, 0, 0]),
      damp: [T.gridFilter, T.hullTaper, o.swell, fill ? 1 : 0],
      hulls: hullWords,
      impulses: impulseWords,
    }, this.staging);
    queue.writeBuffer(this.sim, 0, this.staging);
    queue.writeBuffer(this.buffers!.args, 0, this.drawReset);

    c.encoder.clearBuffer(this.buffers!.tiles);
    let pass = this.host.computePass(c, 'fluids.step');
    // The tiles this frame can change, from the state as it enters the frame; the passes below skip the others.
    pass.setBindGroup(0, this.tilesBindGroup());
    pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.tiles_mark)!);
    pass.dispatchWorkgroups(Math.ceil(this.cells / 256));
    pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.tiles_spread)!);
    pass.dispatchWorkgroups(Math.ceil(this.tileCount / 64));
    pass.setBindGroup(0, this.coreBindGroup(bed));
    const run = (e: Entry, groups: number, group1?: GPUBindGroup) => {
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys[e])!);
      if (group1) pass.setBindGroup(1, group1);
      pass.dispatchWorkgroups(groups);
    };
    const cellGroups = Math.ceil(this.cells / 256);
    if (fill) {
      pass.end();
      c.encoder.clearBuffer(this.buffers!.hull);
      pass = this.host.computePass(c, 'fluids.fill');
      pass.setBindGroup(0, this.coreBindGroup(bed));
      run('init', cellGroups, this.bind('init'));
      this.initWanted = false;
      this.live = true;
      this.fills++;
    }
    if (!this.live) { pass.end(); return; }
    const fluxGroup = this.bind('flux_step');
    // Without lava the faces' crests are never read (flux reads them under the lava flag, coupling only for lava cells).
    if (substeps > 0 && o.lava) run('lava_faces', cellGroups, this.bind('lava_faces'));
    if (substeps > 0 && !fill) {
      run('couple_occupy', cellGroups, fluxGroup);
      run('couple_share', cellGroups, fluxGroup);
      run('couple_push', cellGroups, fluxGroup);
    }
    for (let k = 0; k < substeps; k++) { run('flux_step', cellGroups, fluxGroup); run('depth_step', cellGroups); }
    if (substeps > 0 && !fill) {
      const smoothGroup = this.bind('smooth_lap');
      run('smooth_lap', cellGroups, smoothGroup);
      run('smooth_apply', cellGroups, smoothGroup);
    }
    pass.end();
    pass = this.host.computePass(c, 'fluids.water');
    pass.setBindGroup(0, this.coreBindGroup(bed));
    if (substeps > 0 && !fill) run('flow', cellGroups, this.bind('flow'));
    // Level rings: ext_first writes lvlA; each further ring swaps.
    run('ext_first', cellGroups, this.bind('ext_first'));
    let cur: 'lvlA' | 'lvlB' = 'lvlA';
    for (let ring = 2; ring <= WATER_BAND_RINGS; ring++) {
      run('ext_next', cellGroups, this.bind(cur === 'lvlA' ? 'ext_ab' : 'ext_ba'));
      cur = cur === 'lvlA' ? 'lvlB' : 'lvlA';
    }
    run('surface', cellGroups, this.bind('surface'));
    pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.pack)!);
    pass.setBindGroup(1, this.bind('pack'));
    pass.dispatchWorkgroups(Math.ceil(3 * (this.n + 2) / 8), Math.ceil(2 * (this.n + 2) / 8));
    run('cull', Math.ceil(this.quads / 256), this.bind('cull'));
    const sample = !this.reading && c.frame.index % 30 === 0;
    if (sample) run('volume', cellGroups, this.bind('volume'));
    pass.end();
    if (sample && this.readback) {
      this.reading = true;
      const readback = this.readback, frame = c.frame.index;
      c.encoder.copyBufferToBuffer(this.buffers!.sums, 0, readback, 0, readback.size);
      setTimeout(() => {
        void this.host.s.ctx.queue.onSubmittedWorkDone().then(() => readback.mapAsync(MapMode.READ)).then(() => {
          const sums = new Float32Array(readback.getMappedRange().slice(0));
          readback.unmap();
          let w = 0, l = 0, seaArea = 0, seaLevel = 0;
          for (let k = 0; k < sums.length; k += 4) { w += sums[k]; l += sums[k + 1]; seaArea += sums[k + 2]; seaLevel += sums[k + 3]; }
          this.volume.water = w;
          this.volume.lava = l;
          this.volume.seaLevel = seaArea > 0 ? seaLevel / seaArea : 0;
          this.volume.frame = frame;
        }).catch(() => undefined).finally(() => { this.reading = false; });
      }, 0);
    }
  }

  /**
   * Dev and gates: the water at up to 64 world points (the cells under them), read back from the GPU. Resolves with
   * water depth, lava depth, the ground (bed + lava) and the surface radius (0 where there is no liquid).
   */
  async probe(points: readonly (readonly number[])[]): Promise<{ water: number; lava: number; ground: number; surface: number; foam: number; temperature: number; velocity: [number, number, number] }[]> {
    const bed = this.host.bed();
    if (!this.buffers || !bed || !points.length) return [];
    const { device, queue } = this.host.s.ctx;
    const pipe = this.host.s.ctx.pipelines.get<GPUComputePipeline>(this.probeKey);
    if (!pipe) return [];
    const list = points.slice(0, PROBE_POINTS), b = this.buffers;
    // Submitted now, like the frame before it: the probe reads the state the last frame left.
    queue.writeBuffer(this.probeCells, 0, Uint32Array.from([list.length, ...list.map(p => cellOfDir(this.n, p))]));
    const key = this.probeGroups.begin(); key.push(b.state, bed, b.heat, b.vel);
    const group = this.probeGroups.get(() => device.createBindGroup({ label: 'fluids:water-probe', layout: this.probeLayout, entries: [
      { binding: 0, resource: { buffer: this.probeCells } }, { binding: 1, resource: { buffer: b.state } }, { binding: 2, resource: { buffer: bed } },
      { binding: 3, resource: { buffer: b.heat } }, { binding: 4, resource: { buffer: b.vel } }, { binding: 5, resource: { buffer: this.probeOut } }] }));
    const out = this.probeFree.pop() ?? device.createBuffer({ label: 'fluids:water-probe', size: PROBE_POINTS * 48, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder({ label: 'fluids:water-probe' });
    const pass = encoder.beginComputePass({ label: 'fluids:water-probe' });
    pass.setPipeline(pipe); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(this.probeOut, 0, out, 0, list.length * 48);
    queue.submit([encoder.finish()]);
    let f: Float32Array;
    try {
      await out.mapAsync(MapMode.READ, 0, list.length * 48);
      f = new Float32Array(out.getMappedRange(0, list.length * 48).slice(0));
      out.unmap();
      if (this.buffers) this.probeFree.push(out); else this.host.s.ctx.deferDestroy(out);
    } catch (error) { this.host.s.ctx.deferDestroy(out); throw error; }
    return list.map((_, k) => {
      const water = f[k * 12], lava = f[k * 12 + 1], ground = f[k * 12 + 4] + lava;
      const liquid = water > WATER_TUNING.wetDepth || lava > WATER_TUNING.wetDepth;
      return { water, lava, ground, surface: liquid ? ground + water : 0, foam: f[k * 12 + 2], temperature: f[k * 12 + 5], velocity: [f[k * 12 + 8], f[k * 12 + 9], f[k * 12 + 10]] };
    });
  }

  /** The surface's depth into 'liquidZ' (cleared), in front of the scene only ('transparent'). */
  drawSurface(c: PassContext, frameGroup: GPUBindGroup, draw = true): void {
    const ts = c.timestampWrites('fluids.surface') as GPURenderPassTimestampWrites | undefined;
    const pass = c.encoder.beginRenderPass({
      label: 'fluids.surface', colorAttachments: [],
      depthStencilAttachment: { view: c.resources.view('liquidZ'), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(ts ? { timestampWrites: ts } : {}),
    });
    const pipe = this.host.s.ctx.pipelines.get<GPURenderPipeline>(this.keys.surface_draw);
    if (draw && this.live && pipe && this.buffers) {
      const b = this.buffers, depth = c.resources.view('depth'), key = this.surfaceGroups.begin();
      key.push(b.surf, depth, b.state);
      pass.setPipeline(pipe);
      pass.setBindGroup(0, frameGroup);
      pass.setBindGroup(1, this.surfaceGroups.get(() => this.host.s.ctx.device.createBindGroup({ label: 'fluids:water-surface', layout: this.surfaceLayout, entries: [
        { binding: 0, resource: { buffer: this.sim } }, { binding: 1, resource: { buffer: b.surf } },
        { binding: 2, resource: depth }, { binding: 3, resource: { buffer: b.state } }] })));
      pass.setIndexBuffer(this.buffers.index, 'uint32');
      pass.drawIndexedIndirect(this.buffers.args, 0);
    }
    pass.end();
  }
}
