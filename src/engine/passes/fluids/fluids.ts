/**
 * Planet-wide liquids: one simulated water layer over the whole planet, with
 * lava under it, drawn with one look everywhere.
 *
 * - **Level map:** the bed of a cube-sphere grid (N² per face by tier) is marched from the planet SDF (pending craters
 *   included) whenever the SDF changes, and every frame while a crater is pending.
 * - **Initial fill:** a 6×128² copy of the bed is read back and solved in a worker (`basin-job.ts`) from the planet
 *   kind's recipe (`src/world/basins.ts`): seas, lakes and lava lakes. The water fills from it once; from then on the
 *   simulation is the truth, and craters flood by flow.
 * - **Water** (water.ts): the shallow-water step, flow and foam, the drawn surface, the atlas and the visible-quad cull
 *   ('compute.sim'); the surface's depth ('transparent').
 * - **Spray** (spray.ts): droplets and mist from blasts, tank bows and torrents ('compute.sim' after the water), drawn by
 *   a transparent drawer.
 * - **Gas** (gas.ts): pooled stable-fluid domains for blasts (a fireball on land, a white water burst under water), with
 *   the SDF, the water and the hulls as obstacles ('compute.sim'), raymarched after the water's depth ('transparent').
 * - **Lighting cache:** each cell with a surface traces the SDF sun and moon, a small AO and the fog-of-war hidden
 *   fraction from it, half the cells per frame ('ao' slot, after the fog passes).
 * - **Composite** ('transparent', before the forward drawers): a second entry point linked after the lighting module
 *   (`fluid_main`, fluids.wgsl.ts), dispatched with the lighting pass's own bind groups plus @group(3). It reads a
 *   snapshot of 'hdr' for refraction and writes 'hdr' and the liquid depth; a raster pass then writes that depth and
 *   camera-motion velocity into the G-buffer's, so DOF and TAA see the surface.
 * Timings: fluids.step (the substeps), fluids.water (flow, surface, atlas, cull), fluids.spray, fluids.gas, fluids.bed,
 * fluids.cache, fluids.surface, fluids.composite, fluids.depth, fluids.gasDraw.
 */
import type { EngineServices, QualityTier, RenderModule, Vec3 } from '../../contracts';
import { GBUFFER } from '../../contracts';
import { BindGroupResourceCache } from '../../gpu/bind-group-cache';
import { BufferUsage, MapMode, ShaderStage, TextureUsage } from '../../gpu/flags';
import { link, makeModule } from '../../wgsl/module';
import { createFrameBindGroup, GBUFFER_NAMES } from '../gbuffer/gbuffer';
import { HDR_FORMAT } from '../lighting/lighting';
import { SDF_MAX_CUTS } from '../sdf/sdf.wgsl';
import { buildLightingShader, lightingVariantKey, SDF_MOON_TAN, SDF_SUN_TAN } from '../lighting/lighting.wgsl';
import { pickVents, type Basin, type BasinSolution, type PlanetKindName } from '../../../world/basins';
import { cellDir, cellOfDir, cubeGrid } from '../../../world/cube-grid';
import { runBasinJob, type BasinJob, type BasinJobResult } from './basin-job';
import {
  LIQUID_MAX_BASINS, LIQUID_PARAMS, LIQUID_TOGGLE, LIQUID_VIEW, liquidBedWgsl, liquidCacheWgsl, liquidCompositeWgsl, liquidDepthWgsl,
  type LiquidDebugView,
} from './fluids.wgsl';
import { PlanetGas } from './gas';
import type { VehicleFireSource } from './vehicle-fire';
import type { MuzzleEmission } from './muzzle';
import { quatAxisAngle, quatIdentity, quatMul, quatNormalize, type Quat } from '../../scene/wind';
import { PlanetSpray } from './spray';
import { PlanetWater, WATER_TUNING, type WaterHull } from './water';

export type { WaterHull };
export type { MuzzleEmission };

/** Level-map cells per face edge by tier (0.22 u on Low and Medium, 0.11 u on High and Ultra). */
export const LIQUID_TIER_N: Readonly<Record<QualityTier, number>> = { low: 128, medium: 128, high: 256, ultra: 256 };
/** The basin solve runs on this grid (98k cells, tens of ms in the worker). */
export const LIQUID_LABEL_N = 128;
/** Points that must stay dry (tank spawns) keep the sea this far below them (u). */
export const DRY_MARGIN = 0.35;
/** Water thinner than this is drawn as a film fading into the wet ground under it (u). */
export const THIN_FILM = 0.03;
/**
 * Lava vents of a volcanic planet: how many, their reach (u) and output (u/s of lava at the
 * centre), and their schedule: each erupts for `eruptS` seconds every `period` seconds (its own, from its cell), lit by a
 * point light and throwing a fountain of glowing blobs. Presentation only.
 */
export const LAVA_VENTS = { count: 2, radius: 0.45, rate: 0.35, eruptS: 12, period: [45, 80], light: [1.0, 0.36, 0.08] as Vec3, intensity: 7, range: 4.5 } as const;

interface LiquidLook { absorption: Vec3; refraction: number; shallow: Vec3; deep: Vec3; foam: number; waveSlope: number; swell: number; lavaEmission: number; lavaCrust: number }
/** Resin looks per planet kind (linear colours; absorption per u of view path). Tuned in the browser. */
export const LIQUID_LOOKS: Readonly<Record<PlanetKindName, LiquidLook>> = {
  temperate: { absorption: [0.55, 0.16, 0.1], refraction: 0.03, shallow: [0.42, 0.88, 0.8], deep: [0.02, 0.17, 0.36], foam: 0.8, waveSlope: 0.07, swell: 1, lavaEmission: 1.5, lavaCrust: 1 },
  glacial: { absorption: [0.42, 0.14, 0.1], refraction: 0.03, shallow: [0.6, 0.88, 0.95], deep: [0.07, 0.22, 0.4], foam: 0.9, waveSlope: 0.05, swell: 0.5, lavaEmission: 1.5, lavaCrust: 1 },
  dune: { absorption: [0.6, 0.15, 0.12], refraction: 0.03, shallow: [0.38, 0.93, 0.78], deep: [0.02, 0.28, 0.34], foam: 0.7, waveSlope: 0.06, swell: 0.6, lavaEmission: 1.5, lavaCrust: 1 },
  volcanic: { absorption: [0.5, 0.18, 0.14], refraction: 0.03, shallow: [0.52, 0.86, 0.72], deep: [0.08, 0.26, 0.28], foam: 0.6, waveSlope: 0.05, swell: 0.8, lavaEmission: 1.6, lavaCrust: 1 },
};

export interface FluidToggles { liquids: boolean; veil: boolean; caustics: boolean; wetBand: boolean; refraction: boolean; foam: boolean; waves: boolean; sim: boolean; swell: boolean; spray: boolean; gas: boolean }
export interface FluidStats {
  n: number; basins: number; seaLevel: number | null; solves: number; solveMs: number; ready: boolean;
  /** Fills of the water from the basins, substeps last frame, the last volumes read back (u³), the open sea's mean level. */
  fills: number; substeps: number; water: number; lava: number; openSea: number;
  /** Spray particles emitted since the start, and the ring's size. */
  sprayEmitted: number; sprayCapacity: number;
  /** Gas domains alive, stepped and drawn last frame, and the pool's size. */
  gasLive: number; gasDrawn: number; gasSlots: number;
  /** Independently reserved muzzle smoke domains and fixed texture allocation, never shared with explosions. */
  muzzleLive: number; muzzleDrawn: number; muzzleSlots: number; muzzleEmitted: number; muzzleEvicted: number; muzzleAtlasBytes: number;
}
export interface FluidsFacet {
  /** Composite debug view (the ?dev panel's Fluids group). */
  view: LiquidDebugView;
  readonly toggles: FluidToggles;
  /** Basins of the initial fill (empty until the first solve). */
  readonly basins: readonly Basin[];
  readonly seaLevel: number | null;
  /**
   * Points that must stay dry (tank spawns): the sea stays DRY_MARGIN below the lowest, and a lake around one stays
   * DRY_MARGIN below it (or is dropped). Solves again and refills when they change.
   */
  configure(o: { dryPoints?: readonly (readonly number[])[]; basins?: BasinSolution }): void;
  /** Solve the basins again from the current bed and refill the water (debug). */
  resolve(): void;
  /** Refill the water from the last solve (debug). */
  refill(): void;
  /**
   * Every tank's hull this frame, at its rendered pose (hidden tanks too: their wakes are real, and give them away only
   * where the water is seen). Presentation only: nothing reaches the simulation.
   */
  setHulls(hulls: readonly WaterHull[]): void;
  /**
   * A blast of `radius` at a world point (an impact; `normal` the surface it hit): the water within reach is pushed
   * outward and whitened, spray flies, and a gas domain starts (a fireball, or a water burst under water).
   */
  impulse(point: readonly number[], radius: number, normal?: readonly number[], effect?: 'explosive' | 'heavy' | 'incendiary' | 'nuclear'): void;
  /** One shot's launch jet, using an immutable muzzle pose; this cannot consume an explosion domain. */
  muzzle(emission: MuzzleEmission): void;
  vehicleFires(sources: readonly VehicleFireSource[]): void;
  clearEffects(): void;
  /** A solid fragment entering water: a small ripple, foam and spray, no gas. */
  splash(point: readonly number[], radius: number, speed: number): void;
  /** Lava vents (volcanic planets): where, and whether each erupts now. */
  vents(): { centre: Vec3; erupting: boolean; nextIn: number }[];
  /** Dev: a tank-sized hull (not drawn) driven from `from` to `to` at `speed` u/s; null removes it. */
  testHull(from: readonly number[] | null, to?: readonly number[], speed?: number): void;
  /** The water at world points (dev and gates): depths, the ground and the surface radius (0 = dry). */
  probe(points: readonly (readonly number[])[]): Promise<{ water: number; lava: number; ground: number; surface: number; foam: number; temperature: number; velocity: [number, number, number] }[]>;
  /** Up to `count` points on the initial shorelines (a wet cell beside a dry one), spread over the list: capture setups. */
  shorePoints(count?: number, material?: 'water' | 'lava'): Vec3[];
  stats(): FluidStats;
}
declare module '../../contracts' {
  interface SceneFacets { fluids: FluidsFacet }
}

const compositeModule = (key: string, options: Parameters<typeof buildLightingShader>[0]) =>
  makeModule(`fluid-composite:${key}`, '', [buildLightingShader(options), liquidCompositeWgsl]);

export function fluidsModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'fluids',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const lighting = s.scene.get('lighting');
      const fog = s.scene.get('fogOfWar');
      if (!lighting?.shared || !fog) throw new Error('Lighting and the fog of war must be installed before fluids.');
      const C = ShaderStage.COMPUTE, F = ShaderStage.FRAGMENT;

      // ── Layouts and pipelines ──
      const uni = (binding: number, visibility = C) => ({ binding, visibility, buffer: { type: 'uniform' as const } });
      const tex = (binding: number, sampleType: GPUTextureSampleType = 'unfilterable-float') => ({ binding, visibility: C, texture: { sampleType } });
      const sdfLayout = device.createBindGroupLayout({ label: 'layout:fluids-sdf', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } }, uni(1),
        { binding: 2, visibility: C, sampler: { type: 'filtering' } }, uni(3)] });
      const bedLayout = device.createBindGroupLayout({ label: 'layout:fluids-bed', entries: [uni(0), { binding: 1, visibility: C, buffer: { type: 'storage' } }, uni(2),
        { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } }, { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, buffer: { type: 'storage' } }] });
      const cacheLayout = device.createBindGroupLayout({ label: 'layout:fluids-cache', entries: [uni(0), tex(1),
        { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba8unorm' } }] });
      const compositeLayout = device.createBindGroupLayout({ label: 'layout:fluids-composite', entries: [uni(0), tex(1), tex(2), tex(3),
        { binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'r32float' } }, tex(5), tex(6), tex(7), tex(8, 'depth'), uni(9)] });
      const depthLayout = device.createBindGroupLayout({ label: 'layout:fluids-depth', entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } }] });
      const options = lighting.shared.options;
      const keys = { bed: 'fluids:bed', bedRemember: 'fluids:bed-remember', cache: 'fluids:cache', composite: `fluids:composite:${lightingVariantKey(options)}`, depth: 'fluids:depth' };
      const computePipe = (key: string, layouts: GPUBindGroupLayout[], code: ReturnType<typeof link>, entryPoint: string) => cache.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: cache.shaderModule(code, key), entryPoint },
      }));
      computePipe(keys.bed, [bedLayout, sdfLayout], link(liquidBedWgsl), 'bed');
      computePipe(keys.bedRemember, [bedLayout, sdfLayout], link(liquidBedWgsl), 'bed_remember');
      computePipe(keys.cache, [cacheLayout, sdfLayout], link(liquidCacheWgsl), 'cache');
      computePipe(keys.composite, [s.ctx.layouts.frame, lighting.shared.layouts[0], lighting.shared.layouts[1], compositeLayout],
        link(compositeModule(keys.composite, options)), 'fluid_main');
      cache.register(keys.depth, 'render', () => {
        const module = cache.shaderModule(link(liquidDepthWgsl), keys.depth);
        return {
          label: keys.depth, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, depthLayout] }),
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: GBUFFER.velocity }] },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: GBUFFER.depth, depthWriteEnabled: true, depthCompare: 'greater' },
        };
      });
      for (const key of Object.values(keys)) void cache.compile(key).catch(() => undefined);
      const linear = device.createSampler({ label: 'fluids:linear', magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
      const frameGroup = createFrameBindGroup(s, 'fluids');

      // ── Resources ──
      const paramsBuffer = device.createBuffer({ label: 'fluids:params', size: LIQUID_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const jobFine = device.createBuffer({ label: 'fluids:job-fine', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const jobCuts = device.createBuffer({ label: 'fluids:job-cuts', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const bedCuts = device.createBuffer({ label: 'fluids:bed-cuts', size: (SDF_MAX_CUTS + 1) * 16, usage: BufferUsage.STORAGE });
      const jobLabel = device.createBuffer({ label: 'fluids:job-label', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const labelCells = 6 * LIQUID_LABEL_N * LIQUID_LABEL_N;
      const bedLabel = device.createBuffer({ label: 'fluids:bed-label', size: labelCells * 4, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC });
      const bedReadback = device.createBuffer({ label: 'fluids:bed-readback', size: labelCells * 4, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
      const labels = device.createBuffer({ label: 'fluids:labels', size: labelCells * 4, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      queue.writeBuffer(jobLabel, 0, new Uint32Array([LIQUID_LABEL_N, 0, 0, 0]));
      let n = 0, bedFine: GPUBuffer | null = null;
      let cacheTex: GPUTexture | null = null, cacheView: GPUTextureView | null = null;
      /** The bed of the current allocation has been marched (the water can fill). */
      let bedReady = false;

      // ── Water ──
      const computePass = (c: { encoder: GPUCommandEncoder; timestampWrites(name: string): unknown }, name: string) => {
        const ts = c.timestampWrites(name) as GPUComputePassTimestampWrites | undefined;
        return c.encoder.beginComputePass({ label: name, ...(ts ? { timestampWrites: ts } : {}) });
      };
      const water = new PlanetWater({ s, params: paramsBuffer, labels, bed: () => (bedReady ? bedFine : null), computePass });
      disposers.push(() => water.dispose());
      const spray = new PlanetSpray({ s, atlas: () => water.views?.a ?? null, water: () => water.cellBuffers(), sdfLayout,
        sdfGroup: () => sdfBindGroup(), computePass });
      spray.allocate(s.settings.tier);
      disposers.push(() => spray.dispose());
      disposers.push(s.scene.addTransparentDrawer({ name: 'fluids.spray', order: 10, draw: pass => { if (live()) spray.draw(pass); } }));
      disposers.push(s.graph.addPass({ name: 'fluids.sprayDepth', slot: 'transparent', order: -1, reads: ['depth'], writes: [],
        run(c) { spray.prepareDepth(c.resources.view('depth')); } }));
      const gas = new PlanetGas({ s, sdfLayout, sdfGroup: () => sdfBindGroup(), computePass, frameGroup,
        water: () => (water.live && water.views ? { atlas: water.views.a, n: water.n } : null), hulls: () => water.lastHulls });
      gas.allocate(s.settings.tier);
      disposers.push(() => gas.dispose());
      const muzzleGas = new PlanetGas({ s, sdfLayout, sdfGroup: () => sdfBindGroup(), computePass, frameGroup,
        water: () => (water.live && water.views ? { atlas: water.views.a, n: water.n } : null), hulls: () => water.lastHulls }, 'muzzle');
      muzzleGas.allocate(s.settings.tier);
      disposers.push(() => muzzleGas.dispose());
      let eye: readonly number[] = [0, 0, 0];
      /** Vents: where, when, and their light while they erupt. */
      let vents: { centre: Vec3; period: number; phase: number; light: ReturnType<NonNullable<typeof s.scene.lights>['add']> | null }[] = [];
      let ventClock = 0;
      const clearVents = () => {
        for (const v of vents) if (v.light) s.scene.lights.remove(v.light);
        vents = [];
      };
      disposers.push(clearVents);
      const placeVents = (bed: Float32Array) => {
        clearVents();
        const lava = basins.find(b => b.material === 'lava');
        if (kind !== 'volcanic' || !lava) return;
        const cells = pickVents(bed, LIQUID_LABEL_N, lava.level, dryPoints, LAVA_VENTS.count);
        vents = cells.map((c, i) => {
          const d = cellDir(LIQUID_LABEL_N, c);
          const r = bed[c];
          const h = ((c * 2654435761) >>> 0) / 4294967296;
          return { centre: [d[0] * r, d[1] * r, d[2] * r] as Vec3, period: LAVA_VENTS.period[0] + (LAVA_VENTS.period[1] - LAVA_VENTS.period[0]) * h,
            phase: (i * 17 + h * 30) % 40, light: null };
        });
      };
      /** Vents erupting now (with their eruption's age), for the water, the spray and the lights. */
      const eruptions = () => vents.map(v => ({ v, age: (ventClock + v.phase) % v.period })).filter(e => e.age < LAVA_VENTS.eruptS);
      /** Whether a point lies under the water of the initial fill (the coarse labels; floods since are not known here). */
      const underLiquid = (p: readonly number[]): 'water' | 'lava' | null => {
        if (!solution) return null;
        const label = solution.labels[cellOfDir(LIQUID_LABEL_N, p)];
        const b = label ? basins[label - 1] : undefined;
        return b && b.level > Math.hypot(p[0], p[1], p[2]) + 0.05 ? b.material : null;
      };

      const allocate = (tier: QualityTier) => {
        const next = LIQUID_TIER_N[tier];
        if (next === n && bedFine) return;
        for (const r of [bedFine, cacheTex]) s.ctx.deferDestroy(r);
        n = next;
        bedFine = device.createBuffer({ label: 'fluids:bed', size: 6 * n * n * 4, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC });
        bedReady = false;
        const size: [number, number] = [3 * (n + 2), 2 * (n + 2)];
        cacheTex = device.createTexture({ label: 'fluids:cache', size, format: 'rgba8unorm', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        cacheView = cacheTex.createView();
        queue.writeBuffer(jobFine, 0, new Uint32Array([n, 1, 0, 0]));
        queue.writeBuffer(jobCuts, 0, new Uint32Array([n, 1, 1, 0]));
        water.allocate(n);
        bedDirty = bedWhole = true;
        s.bindings.provide('waterSurface', { surface: water.views!.a, params: { buffer: paramsBuffer } });
      };
      s.graph.declareTexture('liquidHdr', { format: HDR_FORMAT, size: 'internal', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
      s.graph.declareTexture('liquidDepth', { format: 'r32float', size: 'internal', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
      s.graph.declareTexture('liquidZ', { format: 'depth32float', size: 'internal', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING });

      // ── State ──
      let basins: Basin[] = [];
      let solution: BasinSolution | null = null;
      /** The bed must be marched (whole: everywhere; otherwise only where a pending cut reaches). */
      let bedDirty = true, bedWhole = true, solveWanted = true, solving = false, solves = 0, solveMs = 0;
      let sdfSerial = -1, pendingFrames = 0, maxLevel = Infinity;
      let epoch = 0, jobId = 0;
      let dryPoints: readonly (readonly number[])[] = [];
      let gameplayBasins: BasinSolution | undefined;
      let kind: PlanetKindName = 'temperate';
      const toggles: FluidToggles = { liquids: true, veil: true, caustics: true, wetBand: true, refraction: true, foam: true, waves: true, sim: true, swell: true, spray: true, gas: true };
      allocate(s.settings.tier);
      const planet = s.scene.get('planet');
      if (planet) kind = planet.kind;

      /** A recipe solve: new basins and labels, and the water fills from them. */
      const applySolve = (r: BasinJobResult) => {
        solution = { n: LIQUID_LABEL_N, labels: r.labels, basins: r.basins, seaLevel: r.seaLevel };
        basins = [...r.basins];
        queue.writeBuffer(labels, 0, Uint32Array.from(r.labels));
        bedDirty = bedWhole = true;
        bedReady = false; // Refine beneath roofs before the initial fill reads the bed.
        water.refill();
        placeVents(r.bed);
        solveMs = r.ms;
        solves++;
        s.telemetry.gauge('fluidBasins', basins.length);
        s.telemetry.gauge('fluidSolveMs', solveMs);
        if (r.seaLevel !== null) s.telemetry.gauge('fluidSeaLevel', r.seaLevel);
      };

      // The solve runs in a worker (inline where workers are unavailable); results from an older planet are dropped.
      let worker: Worker | null = null;
      const workerEpoch = new Map<number, number>();
      try {
        worker = new Worker(new URL('./basin-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<BasinJobResult>) => {
          const at = workerEpoch.get(e.data.id);
          workerEpoch.delete(e.data.id);
          solving = false;
          if (at === epoch) applySolve(e.data);
        };
        worker.onerror = () => { worker?.terminate(); worker = null; solving = false; solveWanted = true; };
      } catch { worker = null; }
      disposers.push(() => { worker?.terminate(); worker = null; });
      const startSolve = (bed: Float32Array) => {
        if (gameplayBasins) {
          solving = false;
          applySolve({ id: ++jobId, mode: 'recipe', bed, labels: gameplayBasins.labels, basins: [...gameplayBasins.basins], seaLevel: gameplayBasins.seaLevel, ms: 0 });
          return;
        }
        const job: BasinJob = {
          id: ++jobId, mode: 'recipe', bed, n: LIQUID_LABEL_N, kind, maxLevel,
          dry: dryPoints.map(p => ({ cell: cellOfDir(LIQUID_LABEL_N, p), maxLevel: Math.hypot(p[0], p[1], p[2]) - DRY_MARGIN })),
          prev: null, volumes: null, caps: null,
        };
        if (worker) {
          workerEpoch.set(job.id, epoch);
          worker.postMessage(job, { transfer: [bed.buffer] });
        } else {
          solving = false;
          applySolve(runBasinJob(job));
        }
      };

      const sdfGroupFor = (r: ReturnType<typeof s.bindings.get>) => device.createBindGroup({ label: 'fluids:sdf', layout: sdfLayout, entries: [
        { binding: 0, resource: r.volume }, { binding: 1, resource: r.params }, { binding: 2, resource: linear }, { binding: 3, resource: { buffer: fog.paramsBuffer } }] });
      let sdfGroup: GPUBindGroup | null = null, sdfKey: unknown = null;
      const sdfBindGroup = () => {
        const r = s.bindings.get('sdf');
        if (sdfKey !== r.volume) { sdfKey = r.volume; sdfGroup = sdfGroupFor(r); }
        return sdfGroup!;
      };
      const ready = () => [keys.bed, keys.bedRemember, keys.cache].every(k => cache.get(k));
      // Bind groups over resources that change only on reallocation or a resize: reused while every resource is the same.
      const groups = { bed: new BindGroupResourceCache(3), cache: new BindGroupResourceCache(2), composite: new BindGroupResourceCache(4), depth: new BindGroupResourceCache(4) };
      const bedGroup = (job: GPUBuffer, out: GPUBuffer) => {
        const changes = water.bedChanges()!, key = groups.bed.begin(); key.push(job, out, changes);
        return groups.bed.get(() => device.createBindGroup({ layout: bedLayout, entries: [{ binding: 0, resource: { buffer: job } }, { binding: 1, resource: { buffer: out } },
          { binding: 2, resource: { buffer: paramsBuffer } }, { binding: 3, resource: { buffer: labels } }, { binding: 4, resource: { buffer: changes } },
          { binding: 5, resource: { buffer: bedCuts } }] }));
      };
      const live = () => toggles.liquids && water.live && !!s.scene.get('sdf')?.valid;
      const seaIndex = () => basins.findIndex(b => b.kind === 'sea' && b.material === 'water' && b.cells > 0);

      disposers.push(s.events.on('tierChanged', e => { allocate(e.tier); spray.allocate(e.tier); gas.allocate(e.tier); muzzleGas.allocate(e.tier); }));
      disposers.push(s.events.on('planetChanged', e => {
        kind = e.planet.kind;
        basins = []; solution = null;
        maxLevel = Infinity; dryPoints = []; gameplayBasins = undefined; epoch++;
        bedDirty = bedWhole = true; solveWanted = true;
        water.live = false;
        spray.clear();
        gas.clear();
        muzzleGas.clear();
        clearVents();
      }));

      // ── Params, every frame ──
      const staging = new ArrayBuffer(LIQUID_PARAMS.size);
      let rippleDrift: Quat = quatIdentity();
      const table = new Float32Array(LIQUID_MAX_BASINS * 4);
      disposers.push(s.graph.addPass({
        name: 'fluids.params', slot: 'upload', order: 45, reads: [], writes: [],
        run(c) {
          const look = LIQUID_LOOKS[kind] ?? LIQUID_LOOKS.temperate;
          const moon = s.scene.get('moon'), wind = s.scene.get('wind');
          // The ripples drift with the ground wind: accumulate the turn so a gust changes their speed, never their place.
          if (wind) rippleDrift = quatNormalize(quatMul(quatAxisAngle(wind.axis, wind.speed * 0.55 / WATER_TUNING.radius * Math.min(Math.max(c.frame.dt, 0), 0.1)), rippleDrift));
          const bits = (toggles.liquids ? LIQUID_TOGGLE.liquids : 0) | (toggles.veil ? LIQUID_TOGGLE.veil : 0) | (toggles.caustics ? LIQUID_TOGGLE.caustics : 0)
            | (toggles.wetBand ? LIQUID_TOGGLE.wetBand : 0) | (toggles.refraction ? LIQUID_TOGGLE.refraction : 0) | (toggles.foam ? LIQUID_TOGGLE.foam : 0)
            | (toggles.waves ? LIQUID_TOGGLE.waves : 0) | (toggles.sim ? LIQUID_TOGGLE.sim : 0) | (toggles.swell ? LIQUID_TOGGLE.swell : 0);
          table.fill(0);
          for (let i = 0; i < Math.min(basins.length, LIQUID_MAX_BASINS); i++) {
            const b = basins[i], lava = b.material === 'lava' ? 1 : 0;
            table[i * 4] = b.level; table[i * 4 + 1] = lava; table[i * 4 + 2] = lava; table[i * 4 + 3] = b.kind === 'sea' ? 0 : 1;
          }
          const sea = seaIndex();
          LIQUID_PARAMS.pack({
            grid: [n, 3 * (n + 2), 2 * (n + 2), water.live && !!s.scene.get('sdf')?.valid ? 1 : 0],
            info: [Math.min(basins.length, LIQUID_MAX_BASINS), c.frame.time, LIQUID_VIEW[facet.view] ?? 0, bits],
            coarse: [LIQUID_LABEL_N, c.frame.index, sea >= 0 ? basins[sea].level : 0, WATER_TUNING.radius],
            sun: [...c.frame.sunDir, SDF_SUN_TAN],
            moon: [...(moon?.dirToward ?? [-c.frame.sunDir[0], -c.frame.sunDir[1], -c.frame.sunDir[2]]), SDF_MOON_TAN],
            water: [...look.absorption, look.refraction], shallow: [...look.shallow, look.foam], deep: [...look.deep, look.waveSlope],
            lava: [look.lavaEmission, look.lavaCrust, WATER_TUNING.wetDepth, THIN_FILM],
            swell: [toggles.swell ? look.swell : 0, Math.min(1, (wind?.speed ?? 0) / 1.1), 0, 0],
            wind: rippleDrift,
            basins: table,
          }, staging);
          queue.writeBuffer(paramsBuffer, 0, staging);
        },
      }));

      // ── Water ('compute.sim') ──
      disposers.push(s.graph.addPass({
        name: 'fluids.water', slot: 'compute.sim', order: 20, reads: [], writes: [],
        enabled: () => !!s.scene.get('sdf')?.valid && basins.length > 0,
        run(c) {
          const sea = seaIndex();
          const look = LIQUID_LOOKS[kind] ?? LIQUID_LOOKS.temperate;
          ventClock += toggles.sim ? Math.min(Math.max(c.frame.dt, 0), 0.1) : 0;
          const active = toggles.sim ? eruptions() : [];
          for (const v of vents) {
            const e = active.find(x => x.v === v);
            // Fade the light in and out over a second at each end of an eruption.
            const level = e ? Math.min(1, e.age, LAVA_VENTS.eruptS - e.age) : 0;
            const lift = v.centre.map(x => x / Math.hypot(...v.centre) * 0.5);
            const position = [v.centre[0] + lift[0], v.centre[1] + lift[1], v.centre[2] + lift[2]] as Vec3;
            if (level > 0 && !v.light) {
              try { v.light = s.scene.lights.add({ type: 'point', position, color: LAVA_VENTS.light, intensity: LAVA_VENTS.intensity * level, range: LAVA_VENTS.range, castShadow: true }); } catch { v.light = null; }
            } else if (v.light && level > 0) s.scene.lights.update(v.light, { intensity: LAVA_VENTS.intensity * level });
            else if (v.light) { s.scene.lights.remove(v.light); v.light = null; }
            if (e && toggles.spray) spray.burst(v.centre, LAVA_VENTS.radius * 0.8, true, 6, 1.1);
          }
          water.run(c, { seaLevel: sea >= 0 ? basins[sea].level : 0, lava: basins.some(b => b.material === 'lava'), simulate: toggles.sim,
            swell: toggles.swell ? look.swell : 0,
            vents: active.map(e => ({ centre: e.v.centre, radius: LAVA_VENTS.radius, rate: LAVA_VENTS.rate })) });
        },
      }));

      disposers.push(s.graph.addPass({
        name: 'fluids.spray', slot: 'compute.sim', order: 22, reads: [], writes: [],
        enabled: () => water.live && !!s.scene.get('sdf')?.valid,
        run(c) {
          spray.enabled = toggles.spray && toggles.liquids;
          spray.run(c, c.frame.sunDir, toggles.veil);
        },
      }));
      disposers.push(s.graph.addPass({
        name: 'fluids.muzzleGas', slot: 'compute.sim', order: 25, reads: [], writes: [],
        enabled: () => !!s.scene.get('sdf')?.valid,
        run(c) { muzzleGas.enabled = toggles.gas; muzzleGas.run(c); },
      }));
      disposers.push(s.graph.addPass({
        name: 'fluids.gas', slot: 'compute.sim', order: 24, reads: [], writes: [],
        enabled: () => !!s.scene.get('sdf')?.valid || gas.stats.live > 0,
        run(c) {
          eye = c.frame.eye;
          gas.enabled = toggles.gas;
          gas.run(c);
        },
      }));

      // ── Bed march and the recipe solve ('compute.commit', after the SDF build) ──
      disposers.push(s.graph.addPass({
        name: 'fluids.bed', slot: 'compute.commit', order: 10, reads: [], writes: [],
        enabled: () => !!s.scene.get('sdf')?.valid && ready(),
        run(c) {
          const sdf = s.scene.get('sdf')!;
          if (sdf.serial !== sdfSerial) { sdfSerial = sdf.serial; bedDirty = bedWhole = true; }
          // While a crater is pending, its cut is carved into sdf_sample: march every frame so the water's bed follows it
          // (only the cells a cut reaches, now or at the last march, unless the whole bed is due).
          const cuts = s.scene.get('pendingCutList') ?? [];
          if (cuts.length > 0) pendingFrames = 2;
          if (pendingFrames > 0) { pendingFrames--; bedDirty = true; }
          const solveNow = solveWanted && !solving;
          if (!bedDirty && !solveNow) return;
          const pass = computePass(c, 'fluids.bed');
          pass.setPipeline(cache.get<GPUComputePipeline>(keys.bed)!);
          pass.setBindGroup(1, sdfBindGroup());
          if (bedDirty) {
            pass.setBindGroup(0, bedGroup(bedWhole ? jobFine : jobCuts, bedFine!));
            pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), 6);
            pass.setPipeline(cache.get<GPUComputePipeline>(keys.bedRemember)!);
            pass.dispatchWorkgroups(1);
            pass.setPipeline(cache.get<GPUComputePipeline>(keys.bed)!);
          }
          if (solveNow) {
            pass.setBindGroup(0, bedGroup(jobLabel, bedLabel));
            pass.dispatchWorkgroups(LIQUID_LABEL_N / 8, LIQUID_LABEL_N / 8, 6);
          }
          pass.end();
          if (bedDirty) bedReady = true;
          bedDirty = bedWhole = false;
          if (solveNow) {
            solveWanted = false;
            solving = true;
            const at = epoch;
            c.encoder.copyBufferToBuffer(bedLabel, 0, bedReadback, 0, labelCells * 4);
            setTimeout(() => {
              void queue.onSubmittedWorkDone().then(() => bedReadback.mapAsync(MapMode.READ)).then(() => {
                const bed = new Float32Array(bedReadback.getMappedRange().slice(0));
                bedReadback.unmap();
                if (at !== epoch) { solving = false; return; }
                startSolve(bed);
              }).catch(() => { solving = false; });
            }, 0);
          }
        },
      }));

      // ── Lighting cache of the cells with a surface ('ao', after the fog passes) ──
      disposers.push(s.graph.addPass({
        name: 'fluids.cache', slot: 'ao', order: 20, reads: [], writes: [],
        enabled: () => live() && ready(),
        run(c) {
          const pass = computePass(c, 'fluids.cache');
          pass.setPipeline(cache.get<GPUComputePipeline>(keys.cache)!);
          const atlas = water.views!.a, key = groups.cache.begin(); key.push(atlas, cacheView);
          pass.setBindGroup(0, groups.cache.get(() => device.createBindGroup({ layout: cacheLayout, entries: [{ binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: atlas }, { binding: 2, resource: cacheView! }] })));
          pass.setBindGroup(1, sdfBindGroup());
          pass.dispatchWorkgroups(Math.ceil(3 * (n + 2) / 8), Math.ceil(2 * (n + 2) / 8));
          pass.end();
        },
      }));

      // ── Surface depth, composite and depth write ('transparent', before the forward drawers) ──
      const compositeLive = () => live() && !!cache.get(keys.composite) && !!lighting.shared.groups && !!water.views;
      disposers.push(s.graph.addPass({
        name: 'fluids.copy', slot: 'transparent', order: -30, reads: ['hdr'], writes: ['liquidHdr'],
        enabled: compositeLive,
        run(c) {
          const [w, h] = c.frame.internal;
          c.encoder.copyTextureToTexture({ texture: c.resources.texture('hdr') }, { texture: c.resources.texture('liquidHdr') }, [w, h]);
        },
      }));
      disposers.push(s.graph.addPass({
        // Before the clouds: their rays end at the liquid surface. Every frame, so a frame without liquids clears it.
        name: 'fluids.surface', slot: 'clouds', order: -1, reads: ['frameUniforms', 'depth'], writes: ['liquidZ'],
        run(c) { water.drawSurface(c, frameGroup, compositeLive()); },
      }));
      disposers.push(s.graph.addPass({
        name: 'fluids.composite', slot: 'transparent', order: -20,
        // The lighting pass's bind groups hold the G-buffer: reading them here keeps them alive (unaliased) until now.
        reads: ['frameUniforms', 'hdr', 'liquidHdr', 'liquidZ', ...GBUFFER_NAMES.filter(x => x !== 'velocity')], writes: ['hdr', 'liquidDepth'],
        enabled: compositeLive,
        run(c) {
          const [w, h] = c.frame.internal;
          const [g1, g2] = lighting.shared.groups!;
          const v = water.views!;
          const pass = computePass(c, 'fluids.composite');
          pass.setPipeline(cache.get<GPUComputePipeline>(keys.composite)!);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, g1);
          pass.setBindGroup(2, g2);
          const hdr = c.resources.view('liquidHdr'), depth = c.resources.view('liquidDepth'), z = c.resources.view('liquidZ');
          const tiles = water.tilesOn()!, key = groups.composite.begin(); key.push(v.a, cacheView, hdr, depth, v.n, v.f, v.l, z, tiles.buffer);
          pass.setBindGroup(3, groups.composite.get(() => device.createBindGroup({ layout: compositeLayout, entries: [{ binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: v.a }, { binding: 2, resource: cacheView! }, { binding: 3, resource: hdr },
            { binding: 4, resource: depth }, { binding: 5, resource: v.n }, { binding: 6, resource: v.f },
            { binding: 7, resource: v.l }, { binding: 8, resource: z }, { binding: 9, resource: tiles }] })));
          pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          pass.end();
        },
      }));
      disposers.push(s.graph.addPass({
        name: 'fluids.muzzleGasDraw', slot: 'transparent', order: -4, reads: ['frameUniforms', 'hdr', 'depth'], writes: ['hdr'],
        enabled: () => muzzleGas.stats.live > 0 && toggles.gas,
        run(c) { muzzleGas.draw(c, toggles.veil); },
      }));
      disposers.push(s.graph.addPass({
        name: 'fluids.gasDraw', slot: 'transparent', order: -5, reads: ['frameUniforms', 'hdr', 'depth'], writes: ['hdr'],
        enabled: () => gas.stats.live > 0 && toggles.gas,
        run(c) { gas.draw(c, toggles.veil); },
      }));
      disposers.push(s.graph.addPass({
        name: 'fluids.depth', slot: 'transparent', order: -10, reads: ['frameUniforms', 'liquidDepth', 'depth', 'velocity'], writes: ['depth', 'velocity'],
        enabled: () => compositeLive() && !!cache.get(keys.depth),
        run(c) {
          const ts = c.timestampWrites('fluids.depth') as GPURenderPassTimestampWrites | undefined;
          const pass = c.encoder.beginRenderPass({
            label: 'fluids.depth',
            colorAttachments: [{ view: c.resources.view('velocity'), loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: c.resources.view('depth'), depthLoadOp: 'load', depthStoreOp: 'store' },
            ...(ts ? { timestampWrites: ts } : {}),
          });
          pass.setPipeline(cache.get<GPURenderPipeline>(keys.depth)!);
          pass.setBindGroup(0, frameGroup);
          const depth = c.resources.view('liquidDepth'), key = groups.depth.begin(); key.push(depth);
          pass.setBindGroup(1, groups.depth.get(() => device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: depth }] })));
          pass.draw(3);
          pass.end();
        },
      }));

      const facet: FluidsFacet = {
        view: 'none',
        toggles,
        get basins() { return basins; },
        get seaLevel() { const i = seaIndex(); return i >= 0 ? basins[i].level : null; },
        configure(o) {
          if (o.basins && o.basins !== gameplayBasins) {
            if (o.basins.n !== LIQUID_LABEL_N) throw new Error('Gameplay liquid grid mismatch');
            gameplayBasins = o.basins; epoch++; solveWanted = true;
          }
          if (!o.dryPoints?.length) return;
          const lowest = Math.min(...o.dryPoints.map(p => Math.hypot(p[0], p[1], p[2])));
          const next = lowest - DRY_MARGIN;
          if (Math.abs(next - maxLevel) < 1e-4 && dryPoints.length === o.dryPoints.length) return;
          maxLevel = next;
          dryPoints = o.dryPoints.map(p => [p[0], p[1], p[2]]);
          solveWanted = true;
        },
        resolve() { solveWanted = true; },
        refill() { water.refill(); },
        clearEffects() { gas.clear(); muzzleGas.clear(); spray.clear(); },
        muzzle: emission => { if (toggles.gas) muzzleGas.spawnMuzzle(emission, eye); },
        vehicleFires: sources => { if (toggles.gas) gas.setVehicleFires(sources, eye); },
        splash(point, radius, speed) {
          if (!point.every(Number.isFinite) || !Number.isFinite(radius) || !Number.isFinite(speed) || radius <= 0 || speed < 0.7) return;
          const energy = Math.min(1, radius * radius * speed * 0.4);
          const reach = Math.min(1.2, 0.3 + radius * 1.2);
          if (water.disturb(point, reach, energy)) spray.burst(point, reach, false, Math.round(12 + energy * 60), 0.12 + 0.45 * Math.sqrt(energy));
        },
        probe: points => water.probe(points),
        setHulls: hulls => water.setHulls(hulls),
        vents: () => vents.map(v => {
          const age = (ventClock + v.phase) % v.period;
          return { centre: v.centre, erupting: age < LAVA_VENTS.eruptS, nextIn: age < LAVA_VENTS.eruptS ? 0 : v.period - age };
        }),
        impulse: (point, radius, normal, effect) => {
          const under = underLiquid(point);
          water.impulse(point, radius);
          spray.burst(point, radius, under === 'lava');
          gas.spawnBlast(point, normal ?? point, radius, effect === 'nuclear' ? 'nuclear' : effect === 'incendiary' ? 'incendiary'
            : under === 'water' ? 'waterburst' : under === 'lava' ? 'lavaburst' : 'fireball', eye);
        },
        testHull: (from, to, speed) => water.testHull(from, to, speed),
        shorePoints(count = 16, material) {
          if (!solution) return [];
          const g = cubeGrid(solution.n);
          const found: Vec3[] = [];
          for (let c = 0; c < g.cells; c++) {
            const label = solution.labels[c];
            if (!label) continue;
            const b = solution.basins[label - 1];
            if (material && b.material !== material) continue;
            let shore = false;
            for (let k = 0; k < 4; k++) if (!solution.labels[g.neighbours[c * 4 + k]]) shore = true;
            if (!shore) continue;
            const d = cellDir(solution.n, c);
            found.push([d[0] * b.level, d[1] * b.level, d[2] * b.level]);
          }
          const step = Math.max(1, Math.floor(found.length / Math.max(1, count)));
          return found.filter((_, i) => i % step === 0).slice(0, count);
        },
        stats: () => {
          const i = seaIndex();
          return { n, basins: basins.length, seaLevel: i >= 0 ? basins[i].level : null, solves, solveMs, ready: water.live,
            fills: water.fills, substeps: water.substeps, water: water.volume.water, lava: water.volume.lava, openSea: water.volume.seaLevel,
            sprayEmitted: spray.emitted, sprayCapacity: spray.capacity, gasLive: gas.stats.live, gasDrawn: gas.stats.drawn, gasSlots: gas.slotCount,
            muzzleLive: muzzleGas.stats.live, muzzleDrawn: muzzleGas.stats.drawn, muzzleSlots: muzzleGas.slotCount,
            muzzleEmitted: muzzleGas.stats.emitted, muzzleEvicted: muzzleGas.stats.evicted, muzzleAtlasBytes: muzzleGas.stats.atlasBytes };
        },
      };
      s.scene.provide('fluids', facet);
      disposers.push(() => {
        for (const r of [bedFine, cacheTex, paramsBuffer, jobFine, jobCuts, bedCuts, jobLabel, bedLabel, bedReadback, labels]) s.ctx.deferDestroy(r);
      });
    },
    dispose() { for (const d of disposers.splice(0).reverse()) d(); },
  };
}
