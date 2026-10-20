// Ported from Pinionfall src/effects/fluid-fire/fluid-fire-system.ts and fluid-fire-config.ts (MIT, same owner)
/**
 * Gas: fire, smoke, dust and steam, host side. The WGSL and the model are in
 * gas.wgsl.ts.
 *
 * - **Pool:** every live domain is one slot of one 3D atlas (tier: 4 × 24³ … 16 × 40³), allocated at install so the
 *   first explosion does not hitch. A blast that finds the pool full evicts the lowest-ranked slot (lower priority,
 *   then farther, then older).
 * - **Presets:** a fireball for a blast on land (it bursts out of the surface it hit, rolls dust along it, burns off in
 *   under a second and drifts away as smoke); a water burst for a blast under water (a white plume of spray and steam,
 *   no flame); a lava burst for a blast in lava (fire, then heavy dark lingering smoke with embers).
 * - **Clock:** a fixed 30 Hz step, at most one per frame. Each step rebuilds every stepping slot's obstacles (the SDF with
 *   pending craters, the water, the hulls), then curl, advect, divergence, Jacobi pressure and projection, each one
 *   dispatch over all slots ('fluids.gas'); the second half of the Jacobi iterations and the projection run at the start
 *   of the next frame (nothing drawn reads them). The advection also bounds each slot's occupied cells.
 * - **Drawing:** one instanced raymarch of the visible domains, far to near, into 'hdr' after the water's depth is in the
 *   scene depth ('fluids.gasDraw', 'transparent' before the forward drawers); each ray samples only its stretch through
 *   the occupied cells.
 * Presentation only (N5).
 */
import { windVelocity } from '../../scene/wind';
import { validVehicleFire, type VehicleFireSource } from './vehicle-fire';
import type { EngineServices, PassContext, QualityTier, WgslModule } from '../../contracts';
import { GBUFFER } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { link } from '../../wgsl/module';
import { HDR_FORMAT } from '../lighting/lighting';
import {
  GAS_MAX_HULLS, GAS_SLOT_FLOATS, buildGasNoise, gasAdvectWgsl, gasClearRWgsl, gasClearRgbaWgsl, gasCurlWgsl, gasDivergenceWgsl,
  gasObsBandWgsl, gasObsDensityWgsl, gasPressureWgsl, gasProjectWgsl, gasRaymarchWgsl,
} from './gas.wgsl';
import type { WaterHull } from './water';
import { MUZZLE_GAS_TIERS, MUZZLE_SMOKE, MUZZLE_WEAPON, muzzleUnit, validMuzzleEmission, type MuzzleEmission } from './muzzle';
import { GasEmissionLights, type GasEmissionDomain } from './gas-emission';
import { GasIllumination } from './gas-illumination';
import { GAS_FLOW_MAX, GAS_FLOW_PARAMS, gasFlowAdvectWgsl, gasFlowClearWgsl } from './gas-flow.wgsl';

export interface GasCloudFlowFacet { readonly displacementView: GPUTextureView; readonly paramsBuffer: GPUBuffer; readonly maxDisplacement: number;
  /** The solver's projected velocity atlas (domain uv/s, one slot per fire) and its edge, for the clouds' persistent field. */
  readonly velocityView: GPUTextureView; readonly resolution: number; readonly slots: number;
  /** World bounding spheres (centre, radius) of the domains whose flow reaches the clouds this frame. */
  readonly domains: readonly (readonly [number, number, number, number])[] }
declare module '../../contracts' { interface SceneFacets { gasCloudFlow: GasCloudFlowFacet } }

/** Cells per domain edge, Jacobi iterations and slots by tier. */
/** Smoke under the match wind: the push (1/s, on the air speed in domain units) and the air speed's gain aloft. */
export const GAS_WIND = { push: 0.3, aloft: 1.3 } as const;
export const GAS_TIERS: Readonly<Record<QualityTier, { n: number; iterations: number; slots: number }>> = {
  low: { n: 24, iterations: 8, slots: 4 },
  medium: { n: 32, iterations: 12, slots: 8 },
  high: { n: 48, iterations: 18, slots: 8 },
  ultra: { n: 48, iterations: 20, slots: 12 },
};

export type GasPreset = 'fireball' | 'waterburst' | 'lavaburst' | 'nuclear' | 'incendiary';
interface GasSim {
  buoy: number; burn: number; heatGain: number; smokeGain: number; dissSmoke: number; dissHeat: number; dissFuel: number; roll: number;
  impulseRadial: number; impulseUp: number; perturb: number; emitS: number; addSmoke: number; addHeat: number; addFuel: number; shellGrow: number;
  dust: number; expand: number; expandBurst: number;
}
interface GasPresetDef { kind: number; lifetime: number; priority: number; sourceRadiusUv: number; fadeS: number; albedo: number; steam: number; sim: GasSim }
/** Solver constants per preset (velocities in domain widths per second), and the look. */
export const GAS_PRESETS: Readonly<Record<GasPreset, GasPresetDef>> = {
  // Restored from archive/pre-overhaul's nuclear study: slow residual fuel,
  // rising toroidal crown, persistent stem, and room for eighteen seconds of growth.
  nuclear: { kind: 3, lifetime: 14, priority: 5, sourceRadiusUv: 0.10, fadeS: 3, albedo: 0.25, steam: 0, sim: {
    buoy: 0.0093, burn: 0.30, heatGain: 2.8, smokeGain: 0.4, dissSmoke: 0.10, dissHeat: 0.16, dissFuel: 0.09,
    roll: 0.4, impulseRadial: 0.53, impulseUp: 0.23, perturb: 0.67, emitS: 0.9,
    addSmoke: 1.2, addHeat: 30, addFuel: 18, shellGrow: 1.1, dust: 0.45, expand: 0, expandBurst: 0,
  } },
  incendiary: { kind: 4, lifetime: 13, priority: 4, sourceRadiusUv: 0.24, fadeS: 3, albedo: 0.12, steam: 0, sim: {
    buoy: 0.025, burn: 0.85, heatGain: 2.8, smokeGain: 0.8, dissSmoke: 0.3, dissHeat: 1.6, dissFuel: 0.65,
    roll: 0.18, impulseRadial: 0.12, impulseUp: 0.03, perturb: 0.18, emitS: -7,
    addSmoke: 2, addHeat: 10, addFuel: 7, shellGrow: 0.5, dust: 0.5, expand: 0.3, expandBurst: 0,
  } },
  fireball: { kind: 0, lifetime: 6, priority: 3, sourceRadiusUv: 0.14, fadeS: 2, albedo: 0.2, steam: 0, sim: {
    buoy: 0.08, burn: 2.0, heatGain: 2.4, smokeGain: 2.5, dissSmoke: 0.4, dissHeat: 1.5, dissFuel: 0.5,
    roll: 0.35, impulseRadial: 0.7, impulseUp: 0.2, perturb: 0.7, emitS: 0.38,
    addSmoke: 1.5, addHeat: 14, addFuel: 16, shellGrow: 1.1, dust: 1.5, expand: 1.2, expandBurst: 4,
  } },
  // In lava: fire and a heavy, dark, lingering smoke.
  lavaburst: { kind: 2, lifetime: 6, priority: 3, sourceRadiusUv: 0.15, fadeS: 2.0, albedo: 0.07, steam: 0, sim: {
    buoy: 0.22, burn: 1.6, heatGain: 2.2, smokeGain: 3.6, dissSmoke: 0.28, dissHeat: 1.2, dissFuel: 0.5,
    roll: 0.3, impulseRadial: 1.8, impulseUp: 0.8, perturb: 3.5, emitS: 0.25,
    addSmoke: 2.5, addHeat: 12, addFuel: 12, shellGrow: 1.0, dust: 2.5, expand: 2.5, expandBurst: 8,
  } },
  // Under water: a white plume of spray and steam that rises and thins, no flame.
  waterburst: { kind: 1, lifetime: 4, priority: 3, sourceRadiusUv: 0.13, fadeS: 1.5, albedo: 0.85, steam: 1, sim: {
    buoy: 0.3, burn: 0, heatGain: 0, smokeGain: 0, dissSmoke: 0.55, dissHeat: 2.0, dissFuel: 1.0,
    roll: 0.3, impulseRadial: 1.4, impulseUp: 1.6, perturb: 3.0, emitS: 0.22,
    addSmoke: 5.0, addHeat: 3.0, addFuel: 0, shellGrow: 0.9, dust: 0.8, expand: 0, expandBurst: 7,
  } },
};
/** A blast's domain edge per u of blast radius; its fireball stands this many radii off the surface; the domain centre
 *  sits a little higher, room to drift. */
export const GAS_DOMAIN_PER_RADIUS = 8;
const GAS_CENTRE_OFF = 0.5;
const GAS_DOMAIN_LIFT = 0.25;
const GAS_STEP_S = 1 / 30;

export const GAS_LOOK = {
  samplesPerCell: 1.0, maxSamples: 112, emission: 7.0,
  detailFreq: 6.0, erosion: 0.6, flameOpacity: 16.0, smokeOpacity: 30.0, warp: 0.12, fineOctave: 0.4, smokeGlow: 0.35,
};

interface Frame3 { center: number[]; edge: number; right: number[]; up: number[]; fwd: number[] }
interface GasFire {
  vehicle?: { key: string; fedUntil: number; strength: number };
  id: number; def: GasPresetDef; frame: Frame3; serial: number; age: number; simAge: number; slot: number; ready: boolean;
  src: number[]; nrm: number[]; blastUv: number; seed: number; distance: number;
}

export interface GasHost {
  s: EngineServices;
  sdfLayout: GPUBindGroupLayout;
  sdfGroup(): GPUBindGroup;
  /** The water's atlas A and grid N (null while there is no water). */
  water(): { atlas: GPUTextureView; n: number } | null;
  /** The hulls in the water this frame (every tank). */
  hulls(): readonly WaterHull[];
  computePass(c: PassContext, name: string): GPUComputePassEncoder;
  /** The frame uniforms' bind group (@group(0) of the raymarch). */
  frameGroup: GPUBindGroup;
}

const unit = (v: readonly number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

function domainFrame(center: readonly number[], up: readonly number[], edge: number): Frame3 {
  const u = unit(up);
  const ax = Math.abs(u[0]) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
  const r = unit([u[1] * 0 - u[2] * ay, u[2] * ax - u[0] * 0, u[0] * ay - u[1] * ax]);
  const f = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
  return { center: [...center], edge, right: r, up: u, fwd: f };
}
const toDomainUv = (f: Frame3, p: readonly number[]) => {
  const d = [p[0] - f.center[0], p[1] - f.center[1], p[2] - f.center[2]];
  return [0, 1, 2].map(k => {
    const a = k === 0 ? f.right : k === 1 ? f.up : f.fwd;
    return (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / f.edge + 0.5;
  });
};
const dirToDomain = (f: Frame3, v: readonly number[]) => [f.right, f.up, f.fwd].map(a => v[0] * a[0] + v[1] * a[1] + v[2] * a[2]);

const STEP_ENTRIES = ['curl', 'advect', 'divergence', 'pressure', 'project', 'clear_rgba', 'clear_r', 'obs_density', 'obs_band', 'flow', 'clear_flow'] as const;
type StepEntry = typeof STEP_ENTRIES[number];
const ENTRY_POINT: Readonly<Record<StepEntry, string>> = {
  curl: 'cs_curl', advect: 'cs_advect', divergence: 'cs_divergence', pressure: 'cs_pressure', project: 'cs_project',
  clear_rgba: 'cs_clear_rgba', clear_r: 'cs_clear_r', obs_density: 'cs_obs_density', obs_band: 'cs_obs_band',
  flow: 'cs_flow', clear_flow: 'cs_clear_flow',
};
const MODULES: Readonly<Record<StepEntry, WgslModule>> = {
  curl: gasCurlWgsl, advect: gasAdvectWgsl, divergence: gasDivergenceWgsl, pressure: gasPressureWgsl, project: gasProjectWgsl,
  clear_rgba: gasClearRgbaWgsl, clear_r: gasClearRWgsl, obs_density: gasObsDensityWgsl, obs_band: gasObsBandWgsl,
  flow: gasFlowAdvectWgsl, clear_flow: gasFlowClearWgsl,
};
type TexName = 'vel0' | 'vel1' | 'fld0' | 'fld1' | 'curl' | 'prs0' | 'prs1' | 'div' | 'obs' | 'flow0' | 'flow1';
const INST_FLOATS = 20;
/** Per slot, the occupied cells' bounds the advection writes for the raymarch (8 u32), after the instance records. */
const OCCUPIED_BYTES = 32;
/** The two stepping slot lists in activeBuf, one storage-offset alignment apart. */
const SLOT_LIST_STRIDE = 256;

export class PlanetGas {
  n = 0;
  slotCount = 0;
  iterations = 0;
  enabled = true;
  readonly stats = { live: 0, stepped: 0, drawn: 0, steps: 0, emitted: 0, evicted: 0, atlasBytes: 0 };
  private fires = new Map<number, GasFire>();
  private slotOwner: (GasFire | null)[] = [];
  private nextId = 1;
  private serial = 0;
  private clock = 0;
  private parity = 0;
  private pendingClear = new Set<number>();
  private tex = new Map<TexName, GPUTexture>();
  private views = new Map<TexName, GPUTextureView>();
  private readonly device: GPUDevice;
  private readonly layout0: GPUBindGroupLayout;
  private readonly layouts = new Map<StepEntry, GPUBindGroupLayout>();
  private readonly renderLayout: GPUBindGroupLayout;
  private readonly illumination: GasIllumination;
  private readonly keys: Record<StepEntry | 'draw', string>;
  private readonly lin: GPUSampler;
  private readonly rep: GPUSampler;
  private readonly noise: GPUTexture;
  private readonly emissionNoiseView: GPUTextureView;
  /** Bound in place of the water's atlas when there is no water. */
  private readonly noWater: GPUTexture;
  private readonly noWaterView: GPUTextureView;
  private readonly globalsBuf: GPUBuffer;
  private readonly obsParamsBuf: GPUBuffer;
  private readonly renderBuf: GPUBuffer;
  private slotBuf: GPUBuffer | null = null;
  private activeBuf: GPUBuffer | null = null;
  private clearBuf: GPUBuffer | null = null;
  private geomBuf: GPUBuffer | null = null;
  private instBuf: GPUBuffer | null = null;
  /** Where the occupied bounds start in instBuf (storage-offset aligned), and the zeros that reset them each step. */
  private occupiedAt = 0;
  private occupiedZeros = new Uint32Array(0);
  /** Upload staging reused by every step and draw (sized by allocate). */
  private readonly staged = (() => {
    const globals = new ArrayBuffer(16), obs = new ArrayBuffer(16 + GAS_MAX_HULLS * 64);
    return { slots: new Float32Array(0), geom: new Float32Array(0), list: new Uint32Array(0), inst: new Float32Array(0), render: new Float32Array(16),
      globals, globalsU32: new Uint32Array(globals, 0, 2), globalsF32: new Float32Array(globals, 8, 2),
      obs, obsU32: new Uint32Array(obs, 0, 4), obsF32: new Float32Array(obs, 16) };
  })();
  private groups: Partial<Record<string, GPUBindGroup>> = {};
  private renderGroups: [GPUBindGroup | null, GPUBindGroup | null] = [null, null];
  private renderKey: unknown[] = [];
  private obsGroupKey: unknown = null;
  /** Every atlas has had its first write and the step's bind groups exist (see warm). */
  private warmed = false;
  /**
   * The last step's second half, run at the start of the next frame (see finish): how many slots it stepped, where its
   * slot list sits in activeBuf (two lists alternate, so a step in the same frame cannot overwrite it), and the Jacobi
   * iterations left (fixed at the step, so a tier change in between cannot split one solve two ways).
   */
  private finishing: { count: number; list: number; from: number; to: number } | null = null;
  private listAt = 0;
  private readonly emission: GasEmissionLights | null;
  private readonly flowParams: GPUBuffer | null;

  constructor(private readonly host: GasHost, private readonly pool: 'blast' | 'muzzle' = 'blast') {
    const { device } = host.s.ctx;
    this.device = device;
    const C = ShaderStage.COMPUTE;
    this.layout0 = device.createBindGroupLayout({ label: 'layout:gas-g0', entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } }] });
    const tex = (binding: number, sampleType: GPUTextureSampleType): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType, viewDimension: '3d' } });
    const sto = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format, viewDimension: '3d' } });
    const L = (e: StepEntry, entries: GPUBindGroupLayoutEntry[]) => this.layouts.set(e, device.createBindGroupLayout({ label: `layout:gas-${e}`, entries }));
    L('curl', [tex(0, 'float'), sto(1, 'rgba16float')]);
    L('advect', [tex(0, 'float'), tex(1, 'float'), tex(2, 'float'), tex(3, 'float'), { binding: 4, visibility: C, sampler: { type: 'filtering' } },
      sto(5, 'rgba16float'), sto(6, 'rgba16float'), { binding: 7, visibility: C, buffer: { type: 'storage' } }]);
    L('divergence', [tex(0, 'float'), sto(1, 'r32float'), tex(2, 'float')]);
    L('pressure', [tex(0, 'unfilterable-float'), tex(1, 'unfilterable-float'), tex(2, 'float'), sto(3, 'r32float')]);
    L('project', [tex(0, 'float'), tex(1, 'unfilterable-float'), tex(2, 'float'), sto(3, 'rgba16float')]);
    L('clear_rgba', [sto(0, 'rgba16float'), sto(1, 'rgba16float'), sto(2, 'rgba16float'), sto(3, 'rgba16float')]);
    L('clear_r', [sto(0, 'r32float'), sto(1, 'r32float')]);
    L('obs_density', [{ binding: 0, visibility: C, buffer: { type: 'read-only-storage' } }, sto(1, 'r32float'),
      { binding: 2, visibility: C, buffer: { type: 'uniform' } }, { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } }]);
    L('obs_band', [tex(0, 'unfilterable-float'), { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } }, sto(2, 'rgba8snorm')]);
    L('flow', [tex(0, 'float'), tex(1, 'float'), tex(2, 'float'), { binding: 3, visibility: C, sampler: { type: 'filtering' } }, sto(4, 'rgba16float'),
      { binding: 5, visibility: C, buffer: { type: 'read-only-storage' } }]);
    L('clear_flow', [sto(0, 'rgba16float'), sto(1, 'rgba16float')]);
    const cache = host.s.ctx.pipelines;
    const prefix = pool === 'muzzle' ? 'fluids:muzzleGas' : 'fluids:gas';
    this.keys = { ...Object.fromEntries(STEP_ENTRIES.map(e => [e, `${prefix}:${e}`])), draw: `${prefix}:draw` } as Record<StepEntry | 'draw', string>;
    for (const e of STEP_ENTRIES) {
      const layouts = e === 'obs_density' ? [this.layout0, this.layouts.get(e)!, host.sdfLayout] : [this.layout0, this.layouts.get(e)!];
      cache.register(this.keys[e], 'compute', () => ({
        label: this.keys[e], layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        compute: { module: cache.shaderModule(link(MODULES[e]), this.keys[e]), entryPoint: ENTRY_POINT[e] },
      }));
      void cache.compile(this.keys[e]).catch(() => undefined);
    }
    const F = ShaderStage.FRAGMENT, V = ShaderStage.VERTEX;
    this.renderLayout = device.createBindGroupLayout({ label: 'layout:gas-render', entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 3, visibility: F, sampler: { type: 'filtering' } },
      { binding: 4, visibility: F, texture: { sampleType: 'depth' } },
      { binding: 5, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 6, visibility: F, sampler: { type: 'filtering' } },
      { binding: 7, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 8, visibility: F, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 9, visibility: F, buffer: { type: 'uniform' } },
      { binding: 10, visibility: F, buffer: { type: 'read-only-storage' } }] });
    this.illumination = new GasIllumination(host.s);
    cache.register(this.keys.draw, 'render', () => {
      const module = cache.shaderModule(link(gasRaymarchWgsl), this.keys.draw);
      const blend: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
      return {
        label: this.keys.draw, layout: device.createPipelineLayout({ bindGroupLayouts: [host.s.ctx.layouts.frame, this.renderLayout, this.illumination.layout] }),
        vertex: { module, entryPoint: 'vs_gas' },
        fragment: { module, entryPoint: 'fs_gas', targets: [{ format: HDR_FORMAT, blend }] },
        primitive: { topology: 'triangle-list', cullMode: 'front' },
        depthStencil: { format: GBUFFER.depth, depthWriteEnabled: false, depthCompare: 'always' },
      };
    });
    void cache.compile(this.keys.draw).catch(() => undefined);
    this.lin = device.createSampler({ label: 'fluids:gas-lin', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    this.rep = device.createSampler({ label: 'fluids:gas-rep', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    this.noise = device.createTexture({ label: 'fluids:gas-noise', size: [32, 32, 32], dimension: '3d', format: 'rgba8unorm',
      usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    this.emissionNoiseView = this.noise.createView({ dimension: '3d' });
    device.queue.writeTexture({ texture: this.noise }, buildGasNoise(32), { bytesPerRow: 32 * 4, rowsPerImage: 32 }, [32, 32, 32]);
    this.noWater = device.createTexture({ label: 'fluids:gas-no-water', size: [1, 1], format: 'rgba32float', usage: TextureUsage.TEXTURE_BINDING });
    this.noWaterView = this.noWater.createView();
    this.globalsBuf = device.createBuffer({ label: 'fluids:gas-globals', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.obsParamsBuf = device.createBuffer({ label: 'fluids:gas-obs', size: 16 + GAS_MAX_HULLS * 64, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.renderBuf = device.createBuffer({ label: 'fluids:gas-render', size: 64, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.emission = pool === 'blast' ? new GasEmissionLights(host.s, () => this.emissionDomains()) : null;
    this.flowParams = pool === 'blast' ? device.createBuffer({ label: 'fluids:gas-cloud-flow-params', size: GAS_FLOW_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }) : null;
    if (this.flowParams) {
      const gas = this;
      host.s.scene.provide('gasCloudFlow', { get displacementView() { return gas.v(gas.parity ? 'flow1' : 'flow0'); }, paramsBuffer: this.flowParams,
        get velocityView() { return gas.v('vel0'); }, get resolution() { return gas.n; }, get slots() { return gas.slotCount; },
        get domains() { return gas.enabled ? [...gas.fires.values()].filter(f => f.ready).slice(0, GAS_FLOW_MAX).map(f => [f.frame.center[0], f.frame.center[1], f.frame.center[2], f.frame.edge * 0.87] as const) : []; },
        get maxDisplacement() { return gas.enabled ? 3 * Math.max(0, ...[...gas.fires.values()].filter(f => f.ready)
          .map(f => Math.min(1, f.age / .08) * Math.max(0, Math.min(1, (f.def.lifetime - f.age) / f.def.fadeS)))) : 0; } });
    }
  }

  private emissionDomains(): GasEmissionDomain[] {
    if (!this.enabled) return [];
    return [...this.fires.values()].map(f => ({ id: f.id, slot: f.slot, ...f.frame, age: f.simAge, steam: f.def.steam, ready: f.ready,
      fade: Math.min(1, f.age / .08) * Math.max(0, Math.min(1, (f.def.lifetime - f.age) / f.def.fadeS)) }));
  }
  private emitLight(c: PassContext): void {
    if (this.slotBuf) this.emission?.run(c, this.v(this.parity ? 'fld1' : 'fld0'), this.v('obs'), this.emissionNoiseView, this.lin, this.rep, this.n, this.slotCount, GAS_LOOK.emission);
    if (this.flowParams) {
      const live = this.enabled ? [...this.fires.values()].filter(f => f.ready).slice(0, GAS_FLOW_MAX) : [];
      const domains = new Float32Array(GAS_FLOW_MAX * 16);
      live.forEach((f, i) => { const frame = f.frame, fade = Math.min(1, f.age / .08) * Math.max(0, Math.min(1, (f.def.lifetime - f.age) / f.def.fadeS));
        domains.set([...frame.center, frame.edge, ...frame.right, f.slot, ...frame.up, fade, ...frame.fwd, 0], i * 16); });
      this.host.s.ctx.queue.writeBuffer(this.flowParams, 0, GAS_FLOW_PARAMS.pack({ header: [this.n, this.slotCount, live.length, this.enabled ? 1 : 0], domains }));
      this.host.s.telemetry.gauge('gasCloudFlowBytes', this.n ** 3 * this.slotCount * 16 + GAS_FLOW_PARAMS.size);
      this.host.s.telemetry.gauge('gasCloudFlowResolution', this.n);
      this.host.s.telemetry.gauge('gasCloudFlowSlots', this.slotCount);
    }
  }

  /** (Re)allocate the atlas for a tier; drops every fire. */
  allocate(tier: QualityTier): void {
    const t = this.pool === 'muzzle' ? MUZZLE_GAS_TIERS[tier] : GAS_TIERS[tier];
    if (t.n === this.n && t.slots === this.slotCount && this.slotBuf) { this.iterations = t.iterations; return; }
    this.clear();
    this.release();
    this.n = t.n; this.slotCount = t.slots; this.iterations = t.iterations;
    this.stats.atlasBytes = t.n ** 3 * t.slots * (this.pool === 'blast' ? 72 : 56);
    const size: GPUExtent3D = [t.n, t.n, t.n * t.slots];
    const mk = (name: TexName, format: GPUTextureFormat) => {
      const tx = this.device.createTexture({ label: `fluids:gas-${name}`, size, dimension: '3d', format,
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.STORAGE_BINDING });
      this.tex.set(name, tx);
      this.views.set(name, tx.createView({ dimension: '3d' }));
    };
    for (const name of ['vel0', 'vel1', 'fld0', 'fld1', 'curl'] as TexName[]) mk(name, 'rgba16float');
    if (this.pool === 'blast') for (const name of ['flow0', 'flow1'] as TexName[]) mk(name, 'rgba16float');
    for (const name of ['prs0', 'prs1', 'div'] as TexName[]) mk(name, 'r32float');
    mk('obs', 'rgba8snorm');
    const S = BufferUsage.STORAGE | BufferUsage.COPY_DST;
    const buf = (label: string, bytes: number) => this.device.createBuffer({ label: `fluids:gas-${label}`, size: Math.max(16, bytes), usage: S });
    this.slotBuf = buf('slots', t.slots * GAS_SLOT_FLOATS * 4);
    this.activeBuf = buf('active', SLOT_LIST_STRIDE + t.slots * 4);
    this.clearBuf = buf('clear', t.slots * 4);
    this.geomBuf = buf('geom', t.slots * 64);
    this.occupiedAt = Math.ceil(t.slots * INST_FLOATS * 4 / 256) * 256;
    this.occupiedZeros = new Uint32Array(t.slots * OCCUPIED_BYTES / 4);
    Object.assign(this.staged, { slots: new Float32Array(t.slots * GAS_SLOT_FLOATS), geom: new Float32Array(t.slots * 16), list: new Uint32Array(t.slots),
      inst: new Float32Array(t.slots * INST_FLOATS) });
    this.instBuf = buf('inst', this.occupiedAt + t.slots * OCCUPIED_BYTES);
    this.slotOwner = new Array(t.slots).fill(null);
    this.fires.clear();
    this.groups = {};
    this.renderGroups = [null, null];
    this.obsGroupKey = null;
    this.warmed = false;
    this.finishing = null;
  }

  private release(): void {
    for (const t of this.tex.values()) this.host.s.ctx.deferDestroy(t);
    this.tex.clear(); this.views.clear();
    for (const b of [this.slotBuf, this.activeBuf, this.clearBuf, this.geomBuf, this.instBuf]) this.host.s.ctx.deferDestroy(b);
    this.slotBuf = this.activeBuf = this.clearBuf = this.geomBuf = this.instBuf = null;
  }

  dispose(): void {
    this.clear();
    this.emission?.dispose();
    if (this.flowParams) this.host.s.ctx.deferDestroy(this.flowParams);
    this.release();
    this.stats.atlasBytes = 0;
    for (const b of [this.globalsBuf, this.obsParamsBuf, this.renderBuf]) this.host.s.ctx.deferDestroy(b);
    this.host.s.ctx.deferDestroy(this.noise);
    this.host.s.ctx.deferDestroy(this.noWater);
  }

  clear(): void {
    this.emission?.clear();
    if (this.flowParams) this.host.s.ctx.queue.writeBuffer(this.flowParams, 0, new Uint8Array(GAS_FLOW_PARAMS.size));
    this.fires.clear();
    this.slotOwner.fill(null);
    this.pendingClear.clear();
    this.clock = 0; this.parity = 0; this.finishing = null;
    this.stats.live = this.stats.stepped = this.stats.drawn = 0;
  }

  /**
   * A blast at `point` (world), `normal` the surface it hit, `radius` its reach: a domain turned to the radial up, the
   * fireball standing off the surface along the normal.
   */
  spawnBlast(point: readonly number[], normal: readonly number[], radius: number, preset: GasPreset, eye: readonly number[]): void {
    if (this.pool !== 'blast' || !this.enabled || ![point[0], point[1], point[2], radius].every(Number.isFinite) || !(radius > 0) || !this.slotBuf) return;
    const def = GAS_PRESETS[preset];
    const nuclear = preset === 'nuclear';
    const edge = nuclear ? Math.min(34, radius * 5.8) : Math.min(40, radius * (preset === 'incendiary' ? 4.6 : GAS_DOMAIN_PER_RADIUS));
    const up = unit(point), nl = unit(normal);
    const off = nuclear ? 0 : preset === 'incendiary' ? radius * 0.05 : Math.min(radius, edge / GAS_DOMAIN_PER_RADIUS) * GAS_CENTRE_OFF;
    const src = [point[0] + nl[0] * off, point[1] + nl[1] * off, point[2] + nl[2] * off];
    const lift = nuclear ? edge * 0.34 : (edge / GAS_DOMAIN_PER_RADIUS) * GAS_DOMAIN_LIFT;
    const frame = domainFrame([src[0] + up[0] * lift, src[1] + up[1] * lift, src[2] + up[2] * lift], up, edge);
    const fire: GasFire = {
      id: this.nextId++, def, frame, serial: ++this.serial, age: 0, simAge: 0, slot: -1, ready: false,
      src: toDomainUv(frame, src), nrm: dirToDomain(frame, nl), blastUv: radius / edge,
      seed: (this.serial * 2654435761) >>> 0, distance: Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]),
    };
    this.insert(fire);
  }

  /** A compact directional source in a preallocated, independently bounded smoke atlas. */
  spawnMuzzle(emission: MuzzleEmission, eye: readonly number[]): void {
    if (this.pool !== 'muzzle' || !this.enabled || !this.slotBuf || !validMuzzleEmission(emission)) return;
    const ammo = MUZZLE_SMOKE[emission.munition], weapon = MUZZLE_WEAPON[emission.weapon];
    const direction = muzzleUnit(emission.direction), up = muzzleUnit(emission.up ?? emission.position);
    const edge = ammo.edge * weapon.edge;
    // Leave room in front of the muzzle for its momentum, and overhead for its later buoyant roll.
    const center = emission.position.map((p, i) => p + direction[i] * edge * .12 + up[i] * edge * .10);
    const frame = domainFrame(center, up, edge);
    const def: GasPresetDef = { kind: 5, lifetime: ammo.lifetime, priority: 1, sourceRadiusUv: ammo.radius * weapon.radius,
      fadeS: .85, albedo: ammo.albedo, steam: .95, sim: {
        buoy: .13, burn: 0, heatGain: 0, smokeGain: 0, dissSmoke: .65, dissHeat: 1.6, dissFuel: 3, roll: 0,
        impulseRadial: ammo.spread * weapon.spread, impulseUp: ammo.momentum * weapon.momentum,
        perturb: .65, emitS: weapon.duration, addSmoke: ammo.smoke * weapon.smoke, addHeat: ammo.heat,
        addFuel: 0, shellGrow: 0, dust: 0, expand: 0, expandBurst: 2.5,
      } };
    this.insert({ id: this.nextId++, def, frame, serial: ++this.serial, age: 0, simAge: 0, slot: -1, ready: false,
      src: toDomainUv(frame, emission.position), nrm: dirToDomain(frame, direction), blastUv: ammo.radius,
      seed: emission.seed ?? ((this.serial * 2654435761) >>> 0),
      distance: Math.hypot(emission.position[0] - eye[0], emission.position[1] - eye[1], emission.position[2] - eye[2]) });
  }

  private insert(fire: GasFire): void {
    // Muzzle and blast instances own different atlases. Saturated muzzle slots recycle the oldest puff.
    let slot = this.slotOwner.findIndex(o => !o);
    if (slot < 0) {
      let worst = -1;
      const below = (a: GasFire, b: GasFire) => this.pool === 'muzzle' ? a.serial < b.serial : a.def.priority !== b.def.priority ? a.def.priority < b.def.priority
        : a.distance !== b.distance ? a.distance > b.distance : a.serial < b.serial;
      this.slotOwner.forEach((o, i) => { if (o && (worst < 0 || below(o, this.slotOwner[worst]!))) worst = i; });
      if (worst < 0 || !below(this.slotOwner[worst]!, fire)) return;
      this.fires.delete(this.slotOwner[worst]!.id);
      this.stats.evicted++;
      slot = worst;
    }
    fire.slot = slot;
    this.slotOwner[slot] = fire;
    this.fires.set(fire.id, fire);
    this.pendingClear.add(slot);
    this.stats.emitted++;
    this.stats.live = this.fires.size;
  }

  /** Keep density in world space as a vehicle moves through it. A source leaving its domain starts a new plume;
   * the previous smoke dissipates in place. At least half the atlas remains available for impacts. */
  setVehicleFires(sources: readonly VehicleFireSource[], eye: readonly number[]): void {
    if (this.pool !== 'blast' || !this.enabled || !this.slotBuf) return;
    const ranked = sources.filter(validVehicleFire).slice().sort((a, b) =>
      Math.hypot(...a.position.map((x, i) => x - eye[i])) - Math.hypot(...b.position.map((x, i) => x - eye[i])))
      .slice(0, Math.max(1, Math.floor(this.slotCount / 2)));
    for (const source of ranked) {
      let fire = [...this.fires.values()].find(f => f.vehicle?.key === source.key);
      if (fire) {
        const uv = toDomainUv(fire.frame, source.position);
        if (uv.some(v => v < .15 || v > .8)) { fire.vehicle!.key = ''; fire = undefined; }
        else fire.src = uv;
      }
      if (!fire) {
        const edge = 4.8, up = unit(source.position);
        const frame = domainFrame(source.position.map((v, i) => v + up[i] * edge * .23), up, edge);
        const def: GasPresetDef = { kind: 6, lifetime: 5, priority: 2, sourceRadiusUv: .075, fadeS: 2,
          albedo: .16, steam: 0, sim: { buoy: .11, burn: 1.7, heatGain: 2.4, smokeGain: 1.4,
            dissSmoke: .34, dissHeat: 2.1, dissFuel: 1.4, roll: 0, impulseRadial: .035,
            impulseUp: .11, perturb: .3, emitS: 0, addSmoke: 2, addHeat: 8, addFuel: 5,
            shellGrow: 0, dust: 0, expand: .2, expandBurst: 0 } };
        fire = { id: this.nextId++, def, frame, serial: ++this.serial, age: 0, simAge: 0, slot: -1, ready: false,
          src: toDomainUv(frame, source.position), nrm: [0, 1, 0], blastUv: .075,
          seed: (this.serial * 2654435761) >>> 0, distance: 0,
          vehicle: { key: source.key, fedUntil: .2, strength: source.intensity } };
        fire.distance = Math.hypot(...source.position.map((v, i) => v - eye[i]));
        this.insert(fire);
      }
      fire.vehicle!.fedUntil = fire.age + .2;
      fire.vehicle!.strength = source.intensity;
      fire.def.lifetime = fire.age + 5;
      fire.def.sim.addHeat = source.burning ? 9 : .9;
      fire.def.sim.addFuel = source.burning ? 5.5 : 0;
      fire.def.sim.addSmoke = source.burning ? 2.3 : 1.7;
    }
  }

  private bind(key: string, e: StepEntry, resources: GPUBindingResource[]): GPUBindGroup {
    const hit = this.groups[key];
    if (hit) return hit;
    const g = this.device.createBindGroup({ label: `fluids:gas-${key}`, layout: this.layouts.get(e)!,
      entries: resources.map((resource, binding) => ({ binding, resource })) });
    this.groups[key] = g;
    return g;
  }
  private v(name: TexName): GPUTextureView { return this.views.get(name)!; }
  private occupied(): GPUBufferBinding { return { buffer: this.instBuf!, offset: this.occupiedAt, size: this.slotCount * OCCUPIED_BYTES }; }
  private group0(list: GPUBuffer, key: string, offset = 0): GPUBindGroup {
    const hit = this.groups[key];
    if (hit) return hit;
    const g = this.device.createBindGroup({ label: `fluids:gas-${key}`, layout: this.layout0, entries: [
      { binding: 0, resource: { buffer: this.globalsBuf } }, { binding: 1, resource: { buffer: this.slotBuf! } }, { binding: 2, resource: { buffer: list, offset } }] });
    this.groups[key] = g;
    return g;
  }

  ready(): boolean {
    const cache = this.host.s.ctx.pipelines;
    return !!this.slotBuf && Object.values(this.keys).every(k => cache.get(k));
  }

  /** Age and retire fires, run the clock, and step every slot when it ticks ('compute.sim'). */
  run(c: PassContext): void {
    const dt = Math.min(Math.max(c.frame.dt, 0), 0.1);
    for (const f of this.fires.values()) {
      f.age += dt;
      if (f.age >= f.def.lifetime) { this.fires.delete(f.id); if (this.slotOwner[f.slot] === f) this.slotOwner[f.slot] = null; }
    }
    this.stats.live = this.fires.size;
    // Draw passes are disabled when the last domain expires, so reset here instead of leaving stale telemetry.
    this.stats.drawn = 0;
    this.clock = Math.min(this.clock + dt, GAS_STEP_S * 2);
    const step = this.clock >= GAS_STEP_S;
    if (step) this.clock -= GAS_STEP_S;
    // Keep clears queued until pipelines are ready; dropping one can reveal the previous occupant's field.
    if (!this.ready()) { this.emitLight(c); return; }
    if (!this.warmed && !this.fires.size && !this.pendingClear.size) this.warm(c);
    const clears = [...this.pendingClear];
    this.pendingClear.clear();
    const stepping = step ? this.slotOwner.filter((o): o is GasFire => !!o) : [];
    this.stats.stepped = 0;
    const finishing = this.finishing;
    if (!this.ready() || (!clears.length && !stepping.length && !finishing)) { this.emitLight(c); return; }
    const { queue } = this.host.s.ctx;
    const cache = this.host.s.ctx.pipelines;
    const n = this.n, wg = n / 4;
    for (const f of stepping) f.simAge += GAS_STEP_S * (f.def.kind === 3 ? 1.35 : 1);
    if (clears.length || stepping.length) {
      // Slots.
      const slotData = this.staged.slots.fill(0);
      const wind = this.host.s.scene.get('wind');
      this.slotOwner.forEach((f, i) => {
        if (!f) return;
        const o = i * GAS_SLOT_FLOATS, p = f.def.sim;
        // The match wind pushes the smoke downwind (domain uv/s², along the domain's horizontal axes); a little stronger
        // than at the ground, since smoke rises into faster air.
        const air = wind ? windVelocity(wind, wind.speed * GAS_WIND.aloft, f.frame.center) : [0, 0, 0];
        const push = (axis: readonly number[]) => GAS_WIND.push * (air[0] * axis[0] + air[1] * axis[1] + air[2] * axis[2]) / Math.max(f.frame.edge, 1e-3);
        const strength = f.vehicle ? (f.age <= f.vehicle.fedUntil ? f.vehicle.strength : 0) : 1;
        slotData.set([f.src[0], f.src[1], f.src[2], f.def.sourceRadiusUv, f.simAge, f.def.kind, strength, f.seed % 1000,
          f.nrm[0], f.nrm[1], f.nrm[2], f.blastUv, push(f.frame.right), push(f.frame.fwd), 1, p.dust,
          p.buoy, p.burn, p.heatGain, p.smokeGain, p.dissSmoke, p.dissHeat, p.dissFuel, p.roll,
          p.impulseRadial, p.impulseUp, p.perturb, p.emitS, p.addSmoke, p.addHeat, p.addFuel, p.shellGrow,
          p.expand, p.expandBurst, 0, 0], o);
      });
      queue.writeBuffer(this.slotBuf!, 0, slotData);
      const { globals, globalsU32, globalsF32 } = this.staged;
      globalsU32[0] = n; globalsU32[1] = this.slotCount; globalsF32[0] = GAS_STEP_S; globalsF32[1] = c.frame.time;
      queue.writeBuffer(this.globalsBuf, 0, globals);
    }

    const pass = this.host.computePass(c, this.pool === 'muzzle' ? 'fluids.muzzleGas' : 'fluids.gas');
    // The last step's second half comes first: its velocity is projected before any slot is cleared or stepped again.
    if (finishing) { this.finish(pass, finishing); this.finishing = null; }
    if (clears.length) {
      const list = this.staged.list;
      clears.forEach((slot, i) => { list[i] = slot; });
      queue.writeBuffer(this.clearBuf!, 0, list, 0, clears.length);
      pass.setBindGroup(0, this.group0(this.clearBuf!, 'g0-clear'));
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.clear_rgba)!);
      pass.setBindGroup(1, this.bind('clear-rgba', 'clear_rgba', [this.v('vel0'), this.v('vel1'), this.v('fld0'), this.v('fld1')]));
      pass.dispatchWorkgroups(wg, wg, wg * clears.length);
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.clear_r)!);
      pass.setBindGroup(1, this.bind('clear-r', 'clear_r', [this.v('prs0'), this.v('prs1')]));
      pass.dispatchWorkgroups(wg, wg, wg * clears.length);
      if (this.pool === 'blast') {
        pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.clear_flow)!);
        pass.setBindGroup(1, this.bind('clear-flow', 'clear_flow', [this.v('flow0'), this.v('flow1')]));
        pass.dispatchWorkgroups(wg, wg, wg * clears.length);
      }
    }
    if (stepping.length) {
      // Obstacles, rebuilt every step: the SDF (pending craters), the water, every hull.
      const geom = this.staged.geom.fill(0);
      for (const f of stepping) {
        const fr = f.frame, o = f.slot * 16;
        geom.set([...fr.center, fr.edge, ...fr.right, 0, ...fr.up, 0, ...fr.fwd, 0], o);
      }
      queue.writeBuffer(this.geomBuf!, 0, geom);
      const water = this.host.water();
      const hulls = this.host.hulls().slice(0, GAS_MAX_HULLS);
      const { obs, obsU32, obsF32: hf } = this.staged;
      obsU32[0] = hulls.length; obsU32[1] = water?.n ?? 0; obsU32[2] = water ? 1 : 0;
      obsU32[3] = Math.round((this.host.s.scene.get('planet')?.radius ?? 18) * 1000);
      hf.fill(0);
      hulls.forEach((h, k) => hf.set([h.centre[0], h.centre[1], h.centre[2], Math.hypot(h.half[0], h.half[1], h.half[2]),
        ...h.axes[0].slice(0, 3), h.half[0], ...h.axes[1].slice(0, 3), h.half[1], ...h.axes[2].slice(0, 3), h.half[2]], k * 16));
      queue.writeBuffer(this.obsParamsBuf, 0, obs);
      const list = this.staged.list, at = this.listAt;
      stepping.forEach((f, i) => { list[i] = f.slot; });
      queue.writeBuffer(this.activeBuf!, at, list, 0, stepping.length);
      queue.writeBuffer(this.instBuf!, this.occupiedAt, this.occupiedZeros);
      const z = wg * stepping.length;
      pass.setBindGroup(0, this.group0(this.activeBuf!, `g0-sim-${at}`, at));
      const atlas = water?.atlas ?? this.noWaterView;
      if (this.obsGroupKey !== atlas) { this.obsGroupKey = atlas; delete this.groups['obs-density']; }
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.obs_density)!);
      pass.setBindGroup(1, this.bind('obs-density', 'obs_density', [{ buffer: this.geomBuf! }, this.v('div'), { buffer: this.obsParamsBuf }, atlas]));
      pass.setBindGroup(2, this.host.sdfGroup());
      pass.dispatchWorkgroups(wg, wg, z);
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.obs_band)!);
      pass.setBindGroup(1, this.bind('obs-band', 'obs_band', [this.v('div'), { buffer: this.geomBuf! }, this.v('obs')]));
      pass.dispatchWorkgroups(wg, wg, z);
      const par = this.parity;
      if (this.pool === 'blast') {
        pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.flow)!);
        pass.setBindGroup(1, this.bind(`flow-${par}`, 'flow', [this.v('vel0'), this.v(par ? 'flow1' : 'flow0'), this.v('obs'), this.lin,
          this.v(par ? 'flow0' : 'flow1'), { buffer: this.geomBuf! }]));
        pass.dispatchWorkgroups(wg, wg, z);
      }
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.curl)!);
      pass.setBindGroup(1, this.bind('curl', 'curl', [this.v('vel0'), this.v('curl')]));
      pass.dispatchWorkgroups(wg, wg, z);
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.advect)!);
      pass.setBindGroup(1, this.bind(`advect-${par}`, 'advect', [this.v('vel0'), this.v(par ? 'fld1' : 'fld0'), this.v('curl'), this.v('obs'), this.lin,
        this.v('vel1'), this.v(par ? 'fld0' : 'fld1'), this.occupied()]));
      pass.dispatchWorkgroups(wg, wg, z);
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.divergence)!);
      pass.setBindGroup(1, this.bind(`div-${par}`, 'divergence', [this.v('vel1'), this.v('div'), this.v(par ? 'fld0' : 'fld1')]));
      pass.dispatchWorkgroups(wg, wg, z);
      const half = Math.ceil(this.iterations / 2);
      this.relax(pass, z, 0, half);
      this.finishing = { count: stepping.length, list: at, from: half, to: this.iterations };
      this.listAt = SLOT_LIST_STRIDE - at;
      for (const f of stepping) f.ready = true;
      this.parity ^= 1;
      this.stats.stepped = stepping.length;
      this.stats.steps++;
    }
    pass.end();
    this.emitLight(c);
  }

  /** Jacobi iterations [from, to) of the pressure (ping-pong prs0/prs1; an even total ends in prs0). */
  private relax(pass: GPUComputePassEncoder, z: number, from: number, to: number): void {
    const wg = this.n / 4;
    pass.setPipeline(this.host.s.ctx.pipelines.get<GPUComputePipeline>(this.keys.pressure)!);
    for (let k = from; k < to; k++) {
      pass.setBindGroup(1, k & 1
        ? this.bind('prs-1', 'pressure', [this.v('prs1'), this.v('div'), this.v('vel1'), this.v('prs0')])
        : this.bind('prs-0', 'pressure', [this.v('prs0'), this.v('div'), this.v('vel1'), this.v('prs1')]));
      pass.dispatchWorkgroups(wg, wg, z);
    }
  }

  /**
   * A step's second half, at the start of the next frame: the rest of the Jacobi iterations and the projection. Only the
   * next step reads the pressure and the projected velocity; the draw, the emission light and the clouds' departure map
   * read the field, the obstacles and the map the first half wrote, so every frame shows the same state. At 30 Hz and
   * below a frame runs both halves, as before; above, the step's cost is shared by the two frames between ticks.
   */
  private finish(pass: GPUComputePassEncoder, f: { count: number; list: number; from: number; to: number }): void {
    const wg = this.n / 4, z = wg * f.count;
    pass.setBindGroup(0, this.group0(this.activeBuf!, `g0-sim-${f.list}`, f.list));
    this.relax(pass, z, f.from, f.to);
    pass.setPipeline(this.host.s.ctx.pipelines.get<GPUComputePipeline>(this.keys.project)!);
    pass.setBindGroup(1, this.bind('project', 'project', [this.v('vel1'), this.v('prs0'), this.v('obs'), this.v('vel0')]));
    pass.dispatchWorkgroups(wg, wg, z);
  }

  /**
   * The first write of every atlas and the step's bind groups, on the first ready frame without fires (loading), so the
   * first explosion costs what later ones do. The clears zero every slot; curl, divergence and the obstacle band then
   * compute zeros from those zeros. Each spawn clears its slot again and each step rebuilds what it reads.
   */
  private warm(c: PassContext): void {
    const { queue } = this.host.s.ctx, cache = this.host.s.ctx.pipelines, wg = this.n / 4, z = wg * this.slotCount, all = this.staged.list;
    for (let i = 0; i < this.slotCount; i++) all[i] = i;
    queue.writeBuffer(this.clearBuf!, 0, all, 0, this.slotCount);
    const { globals, globalsU32, globalsF32 } = this.staged;
    globalsU32[0] = this.n; globalsU32[1] = this.slotCount; globalsF32[0] = GAS_STEP_S; globalsF32[1] = c.frame.time;
    queue.writeBuffer(this.globalsBuf, 0, globals);
    const pass = this.host.computePass(c, this.pool === 'muzzle' ? 'fluids.muzzleGas' : 'fluids.gas');
    pass.setBindGroup(0, this.group0(this.clearBuf!, 'g0-clear'));
    const run = (entry: StepEntry, group: GPUBindGroup) => {
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys[entry])!);
      pass.setBindGroup(1, group);
      pass.dispatchWorkgroups(wg, wg, z);
    };
    run('clear_rgba', this.bind('clear-rgba', 'clear_rgba', [this.v('vel0'), this.v('vel1'), this.v('fld0'), this.v('fld1')]));
    run('clear_r', this.bind('clear-r', 'clear_r', [this.v('prs0'), this.v('prs1')]));
    if (this.pool === 'blast') run('clear_flow', this.bind('clear-flow', 'clear_flow', [this.v('flow0'), this.v('flow1')]));
    run('curl', this.bind('curl', 'curl', [this.v('vel0'), this.v('curl')]));
    run('divergence', this.bind('div-0', 'divergence', [this.v('vel1'), this.v('div'), this.v('fld1')]));
    run('obs_band', this.bind('obs-band', 'obs_band', [this.v('div'), { buffer: this.geomBuf! }, this.v('obs')]));
    pass.end();
    for (const at of [0, SLOT_LIST_STRIDE]) this.group0(this.activeBuf!, `g0-sim-${at}`, at);
    const atlas = this.host.water()?.atlas ?? this.noWaterView;
    this.obsGroupKey = atlas;
    delete this.groups['obs-density'];
    this.bind('obs-density', 'obs_density', [{ buffer: this.geomBuf! }, this.v('div'), { buffer: this.obsParamsBuf }, atlas]);
    for (const par of [0, 1]) {
      this.bind(`advect-${par}`, 'advect', [this.v('vel0'), this.v(par ? 'fld1' : 'fld0'), this.v('curl'), this.v('obs'), this.lin,
        this.v('vel1'), this.v(par ? 'fld0' : 'fld1'), this.occupied()]);
      this.bind(`div-${par}`, 'divergence', [this.v('vel1'), this.v('div'), this.v(par ? 'fld0' : 'fld1')]);
      this.bind(`prs-${par}`, 'pressure', par ? [this.v('prs1'), this.v('div'), this.v('vel1'), this.v('prs0')] : [this.v('prs0'), this.v('div'), this.v('vel1'), this.v('prs1')]);
    }
    this.bind('project', 'project', [this.v('vel1'), this.v('prs0'), this.v('obs'), this.v('vel0')]);
    this.warmed = true;
  }

  /** The raymarch of every visible ready domain, far to near, into 'hdr' (the scene depth read-only). */
  draw(c: PassContext, veil: boolean): void {
    this.stats.drawn = 0;
    const pipe = this.host.s.ctx.pipelines.get<GPURenderPipeline>(this.keys.draw);
    const fog = this.host.s.scene.get('fogOfWar');
    if (!pipe || !this.instBuf || !fog || !this.enabled) return;
    const eye = c.frame.eye;
    const vis = this.slotOwner.filter((f): f is GasFire => !!f && f.ready && f.simAge > 0)
      .map(f => ({ f, d: Math.hypot(f.frame.center[0] - eye[0], f.frame.center[1] - eye[1], f.frame.center[2] - eye[2]) }))
      .sort((a, b) => b.d - a.d);
    if (!vis.length) return;
    const inst = this.staged.inst;
    vis.forEach(({ f }, i) => {
      const fr = f.frame;
      const fade = Math.min(Math.min(1, f.age / 0.08), Math.max(0, Math.min(1, (f.def.lifetime - f.age) / f.def.fadeS)));
      inst.set([...fr.center, fr.edge, ...fr.right, f.slot, ...fr.up, fade, ...fr.fwd, f.simAge, f.def.albedo, f.def.steam, 0, 0], i * INST_FLOATS);
    });
    const { queue } = this.host.s.ctx;
    queue.writeBuffer(this.instBuf, 0, inst, 0, vis.length * INST_FLOATS);
    const L = GAS_LOOK;
    const muzzle = this.pool === 'muzzle';
    this.staged.render.set([this.n, this.slotCount, L.samplesPerCell, muzzle ? 64 : L.maxSamples,
      L.detailFreq, muzzle ? .35 : L.erosion, L.flameOpacity, L.smokeOpacity, muzzle ? .035 : L.warp,
      L.fineOctave, L.smokeGlow, muzzle ? 1 : L.emission, c.frame.time, veil ? 1 : 0, 0, 0]);
    queue.writeBuffer(this.renderBuf, 0, this.staged.render);
    const depth = c.resources.view('depth');
    const parity = this.parity;
    const key = [depth, fog.volumeView];
    if (key.some((k, i) => k !== this.renderKey[i])) { this.renderKey = key; this.renderGroups = [null, null]; }
    let group = this.renderGroups[parity];
    if (!group) {
      group = this.device.createBindGroup({ label: `fluids:gas-render-${parity}`, layout: this.renderLayout, entries: [
        { binding: 0, resource: { buffer: this.renderBuf } }, { binding: 1, resource: { buffer: this.instBuf } },
        // The field the last step wrote.
        { binding: 2, resource: this.v(parity ? 'fld1' : 'fld0') }, { binding: 3, resource: this.lin },
        { binding: 4, resource: depth }, { binding: 5, resource: this.noise.createView({ dimension: '3d' }) }, { binding: 6, resource: this.rep },
        { binding: 7, resource: this.v('obs') }, { binding: 8, resource: fog.volumeView }, { binding: 9, resource: { buffer: fog.paramsBuffer } },
        { binding: 10, resource: this.occupied() }] });
      this.renderGroups[parity] = group;
    }
    const drawName = this.pool === 'muzzle' ? 'fluids.muzzleGasDraw' : 'fluids.gasDraw';
    const ts = c.timestampWrites(drawName) as GPURenderPassTimestampWrites | undefined;
    const pass = c.encoder.beginRenderPass({
      label: drawName,
      colorAttachments: [{ view: c.resources.view('hdr'), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthReadOnly: true },
      ...(ts ? { timestampWrites: ts } : {}),
    });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, this.host.frameGroup);
    pass.setBindGroup(1, group);
    pass.setBindGroup(2, this.illumination.group());
    pass.draw(36, vis.length);
    pass.end();
    this.stats.drawn = vis.length;
  }
}
