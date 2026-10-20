/**
 * Engine facade (plan §5.4): raw WebGPU, deferred. `three` is used for maths only; the engine never imports src/game.
 *
 * Frame: FrameInput → camera (reversed-Z infinite, optional jitter) → FrameState → frame graph (one encoder, one submit)
 * → timestamp resolve + uniform-ring flush before submit → timestamp/readback maps + deferred-destroy tick after submit.
 * Core modules (always installed, in order): gbuffer, part-mesh, lights, lighting v0, composite v0 (+ present), debug
 * G-buffer views, image stats. Then `EngineOptions.modules` (e.g. RENDER_MODULES + a scene).
 */
import { windFacet } from './scene/wind';
import type {
  EngineOptions, EngineServices, EngineTelemetry, FrameInput, FrameState, GraphicsSettings, PlanetDesc, QualityTier, RenderModule, Vec3,
} from './contracts';
import { imageStatsModule, type ImageStats, type ImageStatsModule, type StatsRect } from './debug/image-stats';
import { gbufferViewModule } from './debug/gbuffer-views';
import { shaderCheck, type ShaderCheckResult } from './debug/shader-check';
import { EventBus } from './events';
import { Camera } from './frame/camera';
import { FrameGraph } from './frame/frame-graph';
import { packFrameUniforms } from './frame/frame-uniforms';
import { packPendingCuts, PENDING_CUTS } from './frame/pending-cuts';
import { WebGpuContext } from './gpu/context';
import { BufferUsage } from './gpu/flags';
import { FrameCaptureController } from './gpu/frame-capture';
import { MipGenerator } from './gpu/mip-gen';
import { ReadbackRing } from './gpu/readback';
import { GpuTimings } from './gpu/timings';
import { gbufferModule } from './passes/gbuffer/gbuffer';
import { partMeshModule, type PartMeshSystem } from './passes/gbuffer/mesh.pass';
import { forwardModule } from './passes/forward/forward';
import { lightingModule } from './passes/lighting/lighting';
import { fogOfWarModule } from './passes/fog-of-war/fog-of-war';
import { sdfModule } from './passes/sdf/sdf-volume';
import { sdfAoModule } from './passes/ao/sdf-ao';
import { giProbesModule } from './passes/gi/gi-probes';
import { compositeModule } from './passes/post/composite';
import { ReservedBindingRegistry } from './reserved-bindings';
import { lightsModule } from './scene/lights';
import { sdfCastersModule } from './passes/sdf/sdf-casters';
import { fluidsModule } from './passes/fluids/fluids';
import { shockwavesModule } from './passes/shockwaves/shockwaves';
import { Scene } from './scene/scene-registry';
import { Telemetry } from './telemetry';
import { FRAME_UNIFORMS_SIZE } from './wgsl/common/frame.wgsl';
import { WgslRegistry } from './wgsl/library';
import { COMMON_WGSL } from './wgsl/common';
import { createInterior } from './scene/interior';

export const DEFAULT_EXPOSURE = 0.2;
export const DEFAULT_SUN_ILLUMINANCE = 20;
export const DEFAULT_SUN_DIR: Vec3 = normalize3([0.45, 0.8, 0.4]);
/** Full-moon illuminance (the sun is 20): readable night terrain after exposure, still clearly night. */
export const DEFAULT_MOON_ILLUMINANCE = 2;
export const DEFAULT_PLANET: PlanetDesc = { seed: 1, kind: 'temperate', radius: 18 };
/** Frames between draw counts nobody asked for, and how many frames after a telemetry read are all counted. */
const DRAW_COUNT_PERIOD = 8, DRAW_COUNT_FOLLOW = 120;

function normalize3(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function resolveTier(t: QualityTier | 'auto' | undefined): QualityTier {
  return !t || t === 'auto' ? 'high' : t;
}

export class Engine {
  readonly services: EngineServices;
  readonly camera = new Camera();
  readonly capture = new FrameCaptureController();
  readonly mipGen: MipGenerator;
  /** Part-mesh internals (instance table, tints) for tools and tests. */
  partMeshes: PartMeshSystem | null = null;
  private readonly modules: RenderModule[] = [];
  private readonly graph: FrameGraph;
  private readonly timings: GpuTimings;
  private readonly readback: ReadbackRing;
  private readonly telemetrySink: Telemetry;
  private readonly frameStaging = new ArrayBuffer(FRAME_UNIFORMS_SIZE);
  private readonly cutsStaging = new ArrayBuffer(PENDING_CUTS.size);
  private readonly cutsBuffer: GPUBuffer;
  private readonly stats: ImageStatsModule;
  private frameIndex = -1;
  private cssSize: [number, number] = [1, 1];
  private dpr = 1;
  private display: [number, number] = [1, 1];
  private internal: [number, number] = [1, 1];
  private appliedScale = 1;
  private planet: PlanetDesc = DEFAULT_PLANET;
  private encodeMs = 0;
  private frameMs = 0;
  private lastFrameAt = 0;
  private disposed = false;
  private frameErrorLogged = false;
  private lastState: FrameState | null = null;

  private constructor(readonly ctx: WebGpuContext, options: EngineOptions) {
    const { device } = ctx;
    const settings: GraphicsSettings = {
      tier: resolveTier(options.tier), renderScale: 1, exposure: DEFAULT_EXPOSURE, jitter: false, gbufferView: 'none', dev: !!options.dev,
      ...options.settings,
    };
    this.timings = new GpuTimings(device, { capture: () => this.capture.current, label: 'timings' });
    this.graph = new FrameGraph(ctx, this.timings, { dev: settings.dev });
    const frameUniforms = device.createBuffer({ label: 'frame:uniforms', size: FRAME_UNIFORMS_SIZE, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    this.graph.importBuffer('frameUniforms', frameUniforms);
    this.cutsBuffer = device.createBuffer({ label: 'frame:pending-cuts', size: PENDING_CUTS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
    const bindings = new ReservedBindingRegistry(device);
    bindings.provide('pendingCuts', { cuts: { buffer: this.cutsBuffer } });
    this.telemetrySink = new Telemetry();
    this.readback = new ReadbackRing(device, { slots: 4, label: 'readback', deferDestroy: b => ctx.deferDestroy(b) });
    this.services = {
      ctx, graph: this.graph, frameUniforms, wgsl: new WgslRegistry(COMMON_WGSL), bindings,
      scene: new Scene(), events: new EventBus(), telemetry: this.telemetrySink, settings,
    };
    if (options.environment === 'interior') this.services.scene.provide('interior', createInterior());
    this.stats = imageStatsModule(this.readback);
    this.mipGen = MipGenerator.for(ctx);
    this.display = [Math.max(1, ctx.canvas.width), Math.max(1, ctx.canvas.height)];
    this.cssSize = [...this.display];
    this.internal = [...this.display];
    this.graph.setSize(this.display, this.internal);
  }

  static async create(o: EngineOptions): Promise<Engine> {
    const ctx = await WebGpuContext.create(o.canvas, { dev: o.dev });
    const engine = new Engine(ctx, o);
    try { await engine.installAll(o.modules ?? []); }
    catch (error) { engine.dispose(); throw error; }
    return engine;
  }

  private async installAll(extra: readonly (() => RenderModule)[]): Promise<void> {
    const s = this.services;
    // Frame + pending-cut uploads.
    this.graph.addPass({
      name: 'upload.frame', slot: 'upload', order: 0, reads: [], writes: ['frameUniforms'],
      run: c => {
        const sun = s.scene.get('sun');
        const radiance = (sun?.illuminance ?? DEFAULT_SUN_ILLUMINANCE);
        packFrameUniforms(c.frame, {
          sunRadiance: [radiance, radiance, radiance], exposure: s.settings.exposure, prevJitter: this.camera.prevJitter,
          planet: { center: [0, 0, 0], radius: this.planet.radius, seaRadius: this.planet.seaRadius ?? 0 },
          renderScale: this.appliedScale,
        }, this.frameStaging);
        s.ctx.queue.writeBuffer(s.frameUniforms, 0, this.frameStaging);
      },
    });
    const interior = !!s.scene.get('interior');
    const core: RenderModule[] = [
      gbufferModule(), ...(!interior ? [sdfModule()] : []), fogOfWarModule(), sdfCastersModule(), ...(!interior ? [sdfAoModule(), giProbesModule()] : []), partMeshModule(sys => { this.partMeshes = sys; }), lightsModule(), lightingModule(), ...(!interior ? [fluidsModule()] : []), forwardModule(),
      compositeModule(), ...(!interior ? [shockwavesModule()] : []), gbufferViewModule(), this.stats,
    ];
    for (const m of core) await this.install(m);
    for (const f of extra) await this.install(f());
    this.services.scene.provide('planet', this.planet);
    await this.ctx.pipelines.whenIdle();
  }

  /** Install one more module (after create). */
  async install(m: RenderModule): Promise<void> {
    await m.install(this.services);
    this.modules.push(m);
  }

  async setPlanet(p: PlanetDesc): Promise<void> {
    this.planet = { ...p };
    this.services.scene.provide('planet', this.planet);
    this.services.events.emit('planetChanged', { planet: this.planet });
    await this.ctx.pipelines.whenIdle();
  }

  /** Switch the quality tier (plan §4.17: applied at match load; render scale alone changes live). Modules that size
   * resources by tier listen to 'tierChanged' (sun shadows reallocate); per-frame consumers read FrameState.tier. */
  setTier(tier: QualityTier | 'auto'): void {
    const next = resolveTier(tier);
    if (next === this.services.settings.tier) return;
    this.services.settings.tier = next;
    this.services.events.emit('tierChanged', { tier: next });
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const max = this.ctx.device.limits.maxTextureDimension2D;
    const w = Math.min(max, Math.max(1, Math.round(cssW * dpr)));
    const h = Math.min(max, Math.max(1, Math.round(cssH * dpr)));
    this.cssSize = [Math.max(1, cssW), Math.max(1, cssH)];
    this.dpr = dpr;
    if (w === this.display[0] && h === this.display[1] && this.appliedScale === this.services.settings.renderScale) return;
    this.display = [w, h];
    this.ctx.canvas.width = w;
    this.ctx.canvas.height = h;
    this.applySize();
  }

  private applySize(): void {
    const scale = Math.min(1.25, Math.max(0.25, this.services.settings.renderScale || 1));
    this.appliedScale = scale;
    this.internal = [Math.max(1, Math.round(this.display[0] * scale)), Math.max(1, Math.round(this.display[1] * scale))];
    this.graph.setSize(this.display, this.internal);
    this.services.events.emit('resize', { display: [...this.display], internal: [...this.internal], dpr: this.dpr });
  }

  frame(input: FrameInput): void {
    if (this.disposed || this.ctx.lost) return;
    const t0 = performance.now();
    if (this.lastFrameAt) this.frameMs = this.frameMs ? this.frameMs * 0.9 + (t0 - this.lastFrameAt) * 0.1 : t0 - this.lastFrameAt;
    this.lastFrameAt = t0;
    const s = this.services;
    if (s.settings.renderScale !== this.appliedScale) this.applySize();
    this.frameIndex++;
    this.camera.update(input.camera, this.cssSize, this.internal, s.settings.jitter, this.frameIndex, this.display);
    const sunDir = normalize3(input.sun?.dirToward ?? s.scene.get('sun')?.dirToward ?? DEFAULT_SUN_DIR);
    s.scene.provide('sun', { dirToward: sunDir, illuminance: input.sun?.illuminance ?? DEFAULT_SUN_ILLUMINANCE });
    const moonDir = normalize3(input.moon?.dirToward ?? [-sunDir[0], -sunDir[1], -sunDir[2]]);
    s.scene.provide('moon', { dirToward: moonDir, illuminance: input.moon?.illuminance ?? DEFAULT_MOON_ILLUMINANCE,
      phase: (1 - (sunDir[0] * moonDir[0] + sunDir[1] * moonDir[1] + sunDir[2] * moonDir[2])) / 2 });
    const planetSeed = s.scene.get('planet')?.seed ?? 0;
    s.scene.provide('wind', windFacet(input.wind ? normalize3(input.wind.axis) : null, input.wind?.bars ?? null, planetSeed, input.time));
    const cam = this.camera;
    const state: FrameState = {
      index: this.frameIndex, time: input.time, dt: input.dt, tier: s.settings.tier,
      internal: [...this.internal], display: [...this.display],
      view: cam.view, proj: cam.proj, viewProj: cam.viewProj, invViewProj: cam.invViewProj, prevViewProj: cam.prevViewProj,
      viewProjNoJitter: cam.viewProjNoJitter, eye: [...cam.eye], jitter: [...cam.jitter], sunDir,
      focus: { world: [...input.focus.world], tilt: input.focus.tilt, distance: input.focus.distance }, snap: cam.snap,
    };
    this.ctx.queue.writeBuffer(this.cutsBuffer, 0, packPendingCuts(input.pendingCuts, this.cutsStaging));
    s.scene.provide('pendingCutList', input.pendingCuts);
    this.ctx.uniforms.beginFrame();
    // Counting wraps every render pass and draw. It runs for dev, for a capture, on every frame up to DRAW_COUNT_FOLLOW
    // frames after a telemetry read (a reader at least that frequent, like the HUD or the render bench, reads last
    // frame's counts as before) and every DRAW_COUNT_PERIOD frames, so a first read is never older than that.
    const counted = s.settings.dev || !!this.capture.current || this.frameIndex - this.telemetryReadAt <= DRAW_COUNT_FOLLOW
      || this.frameIndex % DRAW_COUNT_PERIOD === 0;
    try {
      this.graph.execute(state, {
        instrument: counted ? this.instrument : undefined,
        beforeSubmit: enc => { this.timings.resolve(enc); this.ctx.uniforms.flush(); },
        afterSubmit: () => { this.timings.kickReadback(); this.readback.afterSubmit(); this.ctx.tick(); },
      });
    } catch (error) {
      this.readback.cancelUnsubmitted();
      if (s.settings.dev) throw error;
      if (!this.frameErrorLogged) { this.frameErrorLogged = true; console.error('[engine] frame failed', error); }
      return;
    } finally {
      this.telemetrySink.endFrame(counted);
    }
    const ms = performance.now() - t0;
    this.encodeMs = this.encodeMs ? this.encodeMs * 0.9 + ms * 0.1 : ms;
    if (this.capture.current) this.capture.cpuFrame(new Map([['encode', ms]]), new Map([['draws', this.telemetrySink.lastDraws]]), new Map());
    this.lastState = state;
    s.events.emit('frameEnd', { frame: state });
  }
  private telemetryReadAt = -Infinity;
  private readonly instrument = (encoder: GPUCommandEncoder) => this.telemetrySink.instrument(encoder);

  /** `telemetry().gpu.total` and `.timestamps` alone, without assembling the rest. */
  gpuTotal(): { timestamps: boolean; total: number } {
    const round = (v: number) => Math.round(v * 1000) / 1000;
    let total = 0;
    for (const p of this.timings.getAll()) total += round(p.ms);
    return { timestamps: this.timings.enabled, total: round(total) };
  }

  /** CSS px of a world point (unjittered view-projection of the last frame). */
  project(p: [number, number, number]): { x: number; y: number; visible: boolean } {
    return this.camera.project(p);
  }

  /** Image statistics of the final LDR image over a CSS-pixel rect (default: the whole view). Resolves after the next frame. */
  imageStats(rect?: StatsRect): Promise<ImageStats> {
    const sx = this.display[0] / this.cssSize[0], sy = this.display[1] / this.cssSize[1];
    return this.stats.request(rect ? { x: rect.x * sx, y: rect.y * sy, w: rect.w * sx, h: rect.h * sy } : null);
  }

  shaderCheck(): Promise<ShaderCheckResult> { return shaderCheck(this.ctx.pipelines); }

  /** Pass names executed last frame, in order. */
  get executedPasses(): readonly string[] { return this.graph.lastExecuted; }
  get lastFrame(): FrameState | null { return this.lastState; }
  get frameGraph(): FrameGraph { return this.graph; }

  /** Pipeline compile counts, without telemetry()'s side effect (it keeps draw counting on for a while). */
  compileStats(): EngineTelemetry['compile'] { return this.ctx.pipelines.stats(); }

  telemetry(): EngineTelemetry {
    this.telemetryReadAt = this.frameIndex;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const passes = this.timings.getAll().map(p => ({ name: p.name, ms: round(p.ms) }));
    return {
      frame: this.frameIndex, lost: this.ctx.lost, tier: this.services.settings.tier,
      display: [...this.display], internal: [...this.internal],
      gpu: { total: round(passes.reduce((a, p) => a + p.ms, 0)), passes, timestamps: this.timings.enabled, dropped: this.timings.dropped },
      cpu: { encodeMs: round(this.encodeMs), frameMs: round(this.frameMs) },
      draws: this.telemetrySink.lastDraws, triangles: this.telemetrySink.lastTriangles,
      vram: { total: this.ctx.vram.total, peak: this.ctx.vram.peak, byCategory: this.ctx.vram.byCategory() },
      compile: this.ctx.pipelines.stats(),
      validationErrors: this.ctx.errorCount,
      custom: this.telemetrySink.custom(),
    };
  }

  onLost(cb: () => void): void { this.ctx.onLost(() => cb()); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of [...this.modules].reverse()) { try { m.dispose?.(); } catch (error) { console.warn(`[engine] dispose ${m.name} threw`, error); } }
    this.modules.length = 0;
    this.graph.destroy();
    this.timings.destroy(r => this.ctx.deferDestroy(r));
    this.readback.destroy(b => this.ctx.deferDestroy(b));
    (this.services.bindings as ReservedBindingRegistry).destroy(r => this.ctx.deferDestroy(r));
    (this.services.events as EventBus).clear();
    this.ctx.deferDestroy(this.services.frameUniforms);
    this.ctx.deferDestroy(this.cutsBuffer);
    this.ctx.destroy();
  }
}
