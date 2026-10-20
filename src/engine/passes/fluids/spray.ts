/**
 * Spray, host side: the particle ring, its emitters and its drawer. WGSL and the
 * model are in spray.wgsl.ts.
 *
 * - **Bursts** come from blasts in water (`burst`, called with every impulse); their particle counts scale with the
 *   blast radius and the tier.
 * - **Grid emission** reads the water's state, flow and hull push every frame: a moving hull's waterline edge (tank
 *   bows and sides), torrents.
 * - **Light**: each particle is lit once per frame in the update (sun, moon, sky, night floor, punctual lights, with
 *   terrain, tank and cloud shadows), from the same resources the deferred lighting reads.
 * - **Frame:** bursts, grid emission and the update in one compute pass ('fluids.spray', after the water's pack); the
 *   particles are drawn by a transparent drawer (the 'transparent' pass), depth-tested against the scene and the water.
 * Presentation only (N5).
 */
import type { EngineServices, PassContext, QualityTier } from '../../contracts';
import { BufferUsage, ShaderStage } from '../../gpu/flags';
import { link } from '../../wgsl/module';
import { FORWARD_BLEND_OVER, FORWARD_DEPTH_STENCIL } from '../forward/forward';
import { HDR_FORMAT } from '../lighting/lighting';
import { LIGHTING_V1_DEFAULTS } from '../lighting/lighting';
import { SDF_MOON_TAN, SDF_SUN_TAN, SHAPED_AMBIENT } from '../lighting/lighting.wgsl';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { SPRAY_MAX_BURSTS, SPRAY_SIM, SPRAY_STRIDE, sprayDrawWgsl, sprayStepWgsl } from './spray.wgsl';

/** Particles in the ring by tier. */
export const SPRAY_TIER: Readonly<Record<QualityTier, number>> = { low: 8192, medium: 16384, high: 65536, ultra: 131072 };

export const SPRAY_TUNING = {
  gravity: 9.81,
  drag: 0.35,
  /** Particles a blast throws per u of blast radius at High (scaled by the tier's ring). */
  burstPerRadius: 900,
  /** Droplets per u of hull push into a column (a bow), and per u of hull travel along a waterline edge; torrent spray
   *  rate per s per u/s above torrentSpeed. */
  hullSpray: 25,
  edgeSpray: 30,
  torrentRate: 0.35,
  torrentSpeed: 2.2,
  dropletSize: 0.02,
  mistSize: 0.22,
  brightness: 1,
} as const;

export interface SprayHost {
  s: EngineServices;
  /** The water's atlas A (surface radius, ground, depth, lava). */
  atlas(): GPUTextureView | null;
  /** The water's cell buffers and grid, or null before the water exists. */
  water(): { state: GPUBuffer; vel: GPUBuffer; hull: GPUBuffer; heat: GPUBuffer; n: number; cells: number; wetDepth: number; radius: number; advancing: boolean } | null;
  sdfLayout: GPUBindGroupLayout;
  sdfGroup(): GPUBindGroup;
  computePass(c: PassContext, name: string): GPUComputePassEncoder;
}

const ENTRIES = ['emit_bursts', 'emit_grid', 'update'] as const;

export class PlanetSpray {
  capacity = 0;
  /** Particles emitted since the start (the ring's head, read back rarely), for stats. */
  emitted = 0;
  enabled = true;
  private parts: GPUBuffer | null = null;
  private head: GPUBuffer | null = null;
  private readonly sim: GPUBuffer;
  private readonly staging = new ArrayBuffer(SPRAY_SIM.size);
  private readonly words = new Float32Array(SPRAY_MAX_BURSTS * 8);
  private readonly layout: GPUBindGroupLayout;
  private readonly drawLayout: GPUBindGroupLayout;
  private readonly lightLayout: GPUBindGroupLayout;
  private readonly lightGroups = new BindGroupResourceCache(2);
  private readonly keys: Record<(typeof ENTRIES)[number] | 'draw', string>;
  private readonly sampler: GPUSampler;
  private group: GPUBindGroup | null = null;
  private groupKey: unknown[] = [];
  private drawGroup: GPUBindGroup | null = null;
  private bursts: { centre: readonly number[]; radius: number; count: number; seed: number; strength: number; lava: boolean }[] = [];
  private clearWanted = false;
  private drawDepth: GPUTextureView | null = null;
  private seed = 1;

  constructor(private readonly host: SprayHost) {
    const { device } = host.s.ctx;
    const C = ShaderStage.COMPUTE;
    const ro = (binding: number) => ({ binding, visibility: C, buffer: { type: 'read-only-storage' as const } });
    this.layout = device.createBindGroupLayout({ label: 'layout:spray', entries: [
      { binding: 0, visibility: C, buffer: { type: 'uniform' } },
      { binding: 1, visibility: C, buffer: { type: 'storage' } },
      { binding: 2, visibility: C, buffer: { type: 'storage' } },
      { binding: 3, visibility: C, texture: { sampleType: 'unfilterable-float' } },
      { binding: 4, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 5, visibility: C, sampler: { type: 'filtering' } },
      ro(6), ro(7), ro(8), ro(9)] });
    const uni = (binding: number) => ({ binding, visibility: C, buffer: { type: 'uniform' as const } });
    const tex = (binding: number, viewDimension: GPUTextureViewDimension = '2d') => ({ binding, visibility: C, texture: { sampleType: 'float' as const, viewDimension } });
    this.lightLayout = device.createBindGroupLayout({ label: 'layout:spray-light', entries: [
      tex(0, '3d'), uni(1), uni(2), tex(3), tex(4), uni(5), tex(6), tex(7, 'cube'), tex(8, 'cube'), uni(9), ro(10),
      { binding: 11, visibility: C, sampler: { type: 'filtering' } }] });
    this.drawLayout = device.createBindGroupLayout({ label: 'layout:spray-draw', entries: [
      { binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } }] });
    const cache = host.s.ctx.pipelines;
    const code = link(sprayStepWgsl);
    this.keys = { ...Object.fromEntries(ENTRIES.map(e => [e, `fluids:spray:${e}`])), draw: 'fluids:spray:draw' } as Record<(typeof ENTRIES)[number] | 'draw', string>;
    for (const e of ENTRIES) {
      cache.register(this.keys[e], 'compute', () => ({
        label: this.keys[e], layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, host.sdfLayout, this.lightLayout] }),
        compute: { module: cache.shaderModule(code, 'fluids:spray'), entryPoint: e },
      }));
      void cache.compile(this.keys[e]).catch(() => undefined);
    }
    cache.register(this.keys.draw, 'render', () => {
      const module = cache.shaderModule(link(sprayDrawWgsl), this.keys.draw);
      return {
        label: this.keys.draw, layout: device.createPipelineLayout({ bindGroupLayouts: [host.s.ctx.layouts.frame, this.drawLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: FORWARD_BLEND_OVER }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { ...FORWARD_DEPTH_STENCIL, depthCompare: 'always' },
      };
    });
    void cache.compile(this.keys.draw).catch(() => undefined);
    this.sim = device.createBuffer({ label: 'fluids:spray-sim', size: SPRAY_SIM.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.sampler = device.createSampler({ label: 'fluids:spray-linear', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
  }

  allocate(tier: QualityTier): void {
    const next = SPRAY_TIER[tier];
    if (next === this.capacity && this.parts) return;
    const { device } = this.host.s.ctx;
    this.release();
    this.capacity = next;
    this.parts = device.createBuffer({ label: 'fluids:spray-particles', size: next * SPRAY_STRIDE * 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    this.head = device.createBuffer({ label: 'fluids:spray-head', size: 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    this.group = null;
    this.drawGroup = null;
  }

  private release(): void {
    for (const b of [this.parts, this.head]) this.host.s.ctx.deferDestroy(b);
    this.parts = this.head = null;
  }

  dispose(): void {
    this.release();
    this.host.s.ctx.deferDestroy(this.sim);
  }

  /**
   * A blast of `radius` at `centre`: a crown, a column and some mist from the water there, or glowing blobs from the lava
   * (`lava`, also a vent's fountain with a small `count`). Particles start only where that liquid is.
   */
  burst(centre: readonly number[], radius: number, lava = false, count?: number, strength?: number): void {
    const scale = this.capacity / SPRAY_TIER.high;
    const n = count ?? Math.round(SPRAY_TUNING.burstPerRadius * radius * scale * (lava ? 0.4 : 1));
    this.bursts.push({ centre: [...centre], radius: count ? radius : radius * 1.1, count: n, lava,
      seed: (this.seed = (this.seed * 1664525 + 1013904223) >>> 0), strength: strength ?? Math.sqrt(radius / 2.25) });
    if (this.bursts.length > SPRAY_MAX_BURSTS) this.bursts.shift();
  }

  /** Clear every particle (a new planet, a tier change). */
  clear(c?: PassContext): void {
    if (c && this.parts) c.encoder.clearBuffer(this.parts);
    else this.clearWanted = true;
    this.bursts = [];
  }

  private bindGroup(atlas: GPUTextureView, w: NonNullable<ReturnType<SprayHost['water']>>): GPUBindGroup {
    const fog = this.host.s.scene.get('fogOfWar');
    const key = [atlas, w.state, w.vel, w.hull, w.heat, this.parts, fog?.volumeView];
    if (this.group && key.every((k, i) => k === this.groupKey[i])) return this.group;
    this.groupKey = key;
    this.group = this.host.s.ctx.device.createBindGroup({ label: 'fluids:spray', layout: this.layout, entries: [
      { binding: 0, resource: { buffer: this.sim } }, { binding: 1, resource: { buffer: this.parts! } }, { binding: 2, resource: { buffer: this.head! } },
      { binding: 3, resource: atlas }, { binding: 4, resource: fog!.volumeView }, { binding: 5, resource: this.sampler },
      { binding: 6, resource: { buffer: w.state } }, { binding: 7, resource: { buffer: w.vel } }, { binding: 8, resource: { buffer: w.hull } },
      { binding: 9, resource: { buffer: w.heat } }] });
    return this.group;
  }

  /** The world's lighting resources (borrowed; the cache follows their replacement), or null before the casters exist. */
  private lightGroup(): GPUBindGroup | null {
    const s = this.host.s;
    const casters = s.scene.get('sdfCasters');
    if (!casters) return null;
    const atmo = s.bindings.get('atmosphere'), sky = s.bindings.get('skyLight'), cloud = s.bindings.get('cloudShadow');
    const resources: GPUBindingResource[] = [casters.atlasView, { buffer: casters.listBuffer }, atmo.params, atmo.transmittance,
      atmo.multiscatter, sky.sh, sky.dfg, sky.cube, cloud.cube, cloud.params, s.bindings.get('lights').list, this.sampler];
    const key = this.lightGroups.begin();
    for (const r of resources) pushBindingKey(key, r);
    return this.lightGroups.get(() => s.ctx.device.createBindGroup({ label: 'fluids:spray-light', layout: this.lightLayout,
      entries: resources.map((resource, binding) => ({ binding, resource })) }));
  }

  ready(): boolean {
    const cache = this.host.s.ctx.pipelines;
    return !!this.parts && Object.values(this.keys).every(k => cache.get(k));
  }

  /** The frame's spray ('compute.sim', after the water). */
  run(c: PassContext, sunDir: readonly number[], veil: boolean): void {
    if (this.clearWanted && this.parts) { c.encoder.clearBuffer(this.parts); this.clearWanted = false; }
    const atlas = this.host.atlas(), w = this.host.water();
    const lights = this.ready() ? this.lightGroup() : null;
    if (!lights || !atlas || !w || !this.host.s.scene.get('fogOfWar')) return;
    const T = SPRAY_TUNING, L = LIGHTING_V1_DEFAULTS;
    const radiance = this.host.s.scene.get('sun')?.illuminance ?? 20, wind = this.host.s.scene.get('wind');
    const moon = this.host.s.scene.get('moon') ?? { dirToward: [-sunDir[0], -sunDir[1], -sunDir[2]], illuminance: 0, phase: 1 };
    const dt = Math.min(Math.max(c.frame.dt, 0), 0.05);
    const bursts = this.enabled ? this.bursts.slice(0, SPRAY_MAX_BURSTS) : [];
    this.bursts = [];
    const words = this.words.fill(0);
    let total = 0, lavaBits = 0;
    bursts.forEach((b, k) => {
      if (b.lava) lavaBits |= 1 << k;
      words.set(b.centre.slice(0, 3), k * 8);
      words[k * 8 + 3] = b.radius; words[k * 8 + 4] = total; words[k * 8 + 5] = b.count; words[k * 8 + 6] = b.seed; words[k * 8 + 7] = b.strength;
      total += b.count;
    });
    this.emitted += total;
    SPRAY_SIM.pack({
      dims: [this.capacity, w.cells, w.n, c.frame.index >>> 0],
      step: [dt, T.gravity, T.drag, c.frame.time],
      emit: [this.enabled ? T.hullSpray : 0, this.enabled ? T.torrentRate : 0, T.torrentSpeed, w.wetDepth],
      look: [T.dropletSize, T.mistSize, T.brightness, w.radius],
      sun: [sunDir[0], sunDir[1], sunDir[2], SDF_SUN_TAN],
      sun_rgb: [radiance, radiance, radiance, this.enabled ? T.edgeSpray : 0],
      moon: [...L.moonTint.map(t => t * moon.illuminance * moon.phase), L.moonSkyFill],
      moon_dir: [...moon.dirToward, SDF_MOON_TAN],
      night: [L.nightGain, SHAPED_AMBIENT.nightAmbScale + SHAPED_AMBIENT.backFillNight, SHAPED_AMBIENT.dayLo, SHAPED_AMBIENT.dayHi],
      wind: [...(wind?.axis ?? [0, 1, 0]), wind?.speed ?? 0],
      counts: [bursts.length, total, veil ? 1 : 0, lavaBits],
      bursts: words,
    }, this.staging);
    this.host.s.ctx.queue.writeBuffer(this.sim, 0, this.staging);
    const cache = this.host.s.ctx.pipelines;
    const pass = this.host.computePass(c, 'fluids.spray');
    pass.setBindGroup(0, this.bindGroup(atlas, w));
    pass.setBindGroup(1, this.host.sdfGroup());
    pass.setBindGroup(2, lights);
    if (total > 0) {
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.emit_bursts)!);
      pass.dispatchWorkgroups(Math.ceil(total / 64));
    }
    // A paused water frame retains the last contact buffer; do not re-emit its previous motion every render frame.
    if (this.enabled && w.advancing) {
      pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.emit_grid)!);
      pass.dispatchWorkgroups(Math.ceil(w.cells / 256));
    }
    pass.setPipeline(cache.get<GPUComputePipeline>(this.keys.update)!);
    pass.dispatchWorkgroups(Math.ceil(this.capacity / 256));
    pass.end();
  }

  prepareDepth(depth: GPUTextureView): void {
    if (this.drawDepth !== depth) { this.drawDepth = depth; this.drawGroup = null; }
  }

  /** The transparent drawer's draw: every slot of the ring (dead particles fall outside the clip volume). */
  draw(pass: GPURenderPassEncoder): void {
    const pipe = this.host.s.ctx.pipelines.get<GPURenderPipeline>(this.keys.draw);
    if (!pipe || !this.parts || !this.enabled || !this.drawDepth) return;
    if (!this.drawGroup) {
      this.drawGroup = this.host.s.ctx.device.createBindGroup({ label: 'fluids:spray-draw', layout: this.drawLayout, entries: [
        { binding: 0, resource: { buffer: this.sim } }, { binding: 1, resource: { buffer: this.parts } },
        { binding: 2, resource: this.drawDepth }] });
    }
    pass.setPipeline(pipe);
    pass.setBindGroup(1, this.drawGroup);
    pass.draw(6, this.capacity);
  }
}
