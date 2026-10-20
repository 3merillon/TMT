/** Opt-in, fixed-step qualification of the actual game. Loaded only by ?renderbench. */
import type { CameraRig, GBufferView, EngineTelemetry } from '../../engine/contracts';
import type { GameView } from '../view';
import type { GameSession } from './session';
import { currentSettings, dispatchSettings, updateSettings, type GraphicsSettings } from '../meta/settings';
import type { LightingDebugView } from '../../engine/passes/lighting/lighting';
import type { TsrControls } from '../../engine/passes/post/taa';
import type { FrameGraph } from '../../engine/frame/frame-graph';
import type { MunitionId } from '../munitions';
import { BufferUsage, MapMode } from '../../engine/gpu/flags';

export interface RenderBenchLoop {
  readonly stepSeconds: number;
  readonly simulationScale: number;
  beforeFrame(): boolean;
  beforeRender(): void;
  afterFrame(wallMilliseconds: number): void;
}
interface Configuration {
  camera?: CameraRig; epoch?: number; skyTime?: number; simulationScale?: number;
  graphics?: Partial<GraphicsSettings>; lightingView?: LightingDebugView; gbufferView?: GBufferView;
  off?: string[];
  clouds?: { coverage?: number; density?: number };
  /** Temporal upscaler levers and debug view (engine/passes/post/tsr.ts). */
  tsr?: Partial<Omit<TsrControls, 'active'>>;
}
type Sample = { engine: EngineTelemetry; wallMilliseconds: number; presentationMilliseconds: number; tick: number; time: number; cameraInsideTerrain: boolean; lightCount: number };
interface Impact { radius: number; munition?: MunitionId; camera?: CameraRig }

export function installRenderBench(game: GameSession, view: GameView): void {
  const controls = view.benchmarkControls();
  const stepSeconds = 1 / 60;
  let remaining = 0, done: ((value: Sample[]) => void) | undefined;
  let submitted = 0;
  let samples: Sample[] = [], camera: CameraRig | undefined, epoch = 100, skyTime = 0, frame = 0, simulationScale = 0;
  const eventCounts: Record<string, number> = {};
  game.on('event', value => { const event = value as { type?: string }; if (event.type) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1; });
  const engine = () => { const e = controls.engine(); if (!e) throw new Error('Renderer is not ready'); return e; };
  const blast = (radius = 2.5, munition?: MunitionId, aimCamera?: CameraRig) => {
    const observer = view.cameraRig();
    if (aimCamera) controls.setCamera(aimCamera);
    try { return game.devBlast(radius, munition); }
    finally { if (aimCamera) controls.setCamera(observer); }
  };
  const state = () => ({ camera: view.cameraRig(), cameraDiagnostics: view.cameraTelemetry(), seed: game.setup?.seed, planet: engine().services.scene.get('planet'),
    sun: engine().services.scene.get('sun'), moon: engine().services.scene.get('moon'), skyTime, epoch: epoch + frame * stepSeconds,
    stepSeconds, simulationScale, queuePacing: { maxSubmittedFrames: 2, pending: submitted }, graphics: currentSettings().graphics, engine: engine().telemetry(), game: game.telemetry(),
    setup: game.setup, adapter: engine().ctx.caps, eventCounts: { ...eventCounts },
    renderTargets: Object.fromEntries(['cloudRaw', 'cloudMeta', 'cloudColor', 'volumetricHaze', 'volumetricDistance'].map(name => {
      try { const texture = (engine().services.graph as FrameGraph).resources.texture(name);
        return [name, { width: texture.width, height: texture.height, format: texture.format }]; }
      catch { return [name, null]; }
    })),
    lightCount: engine().services.scene.get('lightSystem')?.count ?? 0,
    shadowLights: structuredClone(engine().services.scene.get('lightSystem')?.shadowCasters() ?? []),
    features: { clouds: (() => { const c = engine().services.scene.get('clouds'); return c ? { enabled: c.enabled, shadows: c.shadows, coverage: c.coverage, density: c.density, shockwaves: c.shockwaves, localLights: c.localLights, shockCount: c.shockCount } : null; })(),
      volumetrics: { ...engine().services.scene.get('volumetrics') }, post: { ...engine().services.scene.get('post') } } });
  const api = {
    get ready() { return game.ready && !!controls.engine(); },
    stepSeconds,
    get simulationScale() { return simulationScale; },
    beforeFrame() { return remaining > 0 && submitted < 2; },
    beforeRender() {
      if (camera) controls.setCamera(camera);
      controls.setTime(epoch + frame * stepSeconds - stepSeconds, skyTime);
    },
    afterFrame(wallMilliseconds: number) {
      // The timestamp ring has three slots. Bound outstanding submissions without
      // weakening its drop gate; ordinary gameplay never installs this driver.
      submitted++;
      void engine().ctx.queue.onSubmittedWorkDone().then(() => { submitted--; }, () => { submitted--; });
      samples.push({ engine: engine().telemetry(), wallMilliseconds, presentationMilliseconds: view.telemetry().presentationMilliseconds,
        tick: game.snapshot?.tick ?? -1, time: epoch + frame * stepSeconds, cameraInsideTerrain: !!view.cameraTelemetry().insideTerrain,
        lightCount: engine().services.scene.get('lightSystem')?.count ?? 0 });
      frame++;
      if (--remaining === 0) { const resolve = done; done = undefined; resolve?.(samples); }
    },
    state,
    configure(config: Configuration) {
      if (remaining) throw new Error('Wait for the current frame batch');
      if (config.camera) {
        const values = [...config.camera.position, ...config.camera.target, ...config.camera.up, config.camera.fovY];
        if (!values.every(Number.isFinite) || config.camera.fovY <= 0 || config.camera.fovY >= Math.PI) throw new Error('Invalid numeric camera');
        camera = structuredClone(config.camera); controls.setCamera(camera);
      }
      if (config.epoch !== undefined) { if (!Number.isFinite(config.epoch)) throw new Error('Invalid epoch'); epoch = config.epoch; frame = 0; }
      if (config.skyTime !== undefined) { if (!Number.isFinite(config.skyTime)) throw new Error('Invalid sky time'); skyTime = config.skyTime; }
      if (config.simulationScale !== undefined) { if (![0, 1].includes(config.simulationScale)) throw new Error('Simulation scale is 0 or 1'); simulationScale = config.simulationScale; }
      if (config.graphics) {
        dispatchSettings(updateSettings(currentSettings(), { graphics: config.graphics }));
      }
      const scene = engine().services.scene;
      if (config.clouds) { const c = scene.get('clouds'); if (c) for (const key of ['coverage', 'density'] as const) { const v = config.clouds[key]; if (v !== undefined && Number.isFinite(v)) c[key] = Math.max(0, Math.min(3, v)); } }
      if (config.lightingView) scene.get('lighting')!.view = config.lightingView;
      if (config.tsr) Object.assign(scene.get('taa')!.tsr, config.tsr);
      if (config.gbufferView) engine().services.settings.gbufferView = config.gbufferView;
      if (config.off) {
        const off = new Set(config.off), light = scene.get('lighting')!, post = scene.get('post')!;
        for (const key of ['sunShadows', 'moonShadows', 'localShadows', 'casters', 'gi', 'veil', 'mist'] as const) light.toggles[key] = !off.has(key);
        light.ao = !off.has('ao'); light.ambient = off.has('ambient') ? 0 : 1;
        scene.get('sunShadows')!.contact = !off.has('contact'); scene.get('taa')!.enabled = !off.has('taa');
        post.bloom = !off.has('bloom'); post.autoExposure = !off.has('autoExposure');
        const graphics = currentSettings().graphics, clouds = scene.get('clouds'), volume = scene.get('volumetrics');
        if (clouds) { clouds.enabled = !off.has('clouds') && graphics.clouds; clouds.shadows = !off.has('cloudShadows'); clouds.shockwaves = !off.has('cloudShockwaves'); clouds.localLights = !off.has('cloudLocalLights'); clouds.invalidate(); }
        if (volume) { volume.enabled = !off.has('volumetrics') && graphics.volumetrics; volume.sun = !off.has('volumeSun'); volume.local = !off.has('volumeLocal'); }
        post.flare = !off.has('lensFlare') && graphics.lensFlare;
        post.godRays = !off.has('godRays') && graphics.godRays;
      }
      // Moving camera paths retain normal reprojection; engine camera snaps handle large jumps.
      if (config.epoch !== undefined || config.graphics) scene.get('taa')?.invalidate();
      return state();
    },
    step(count: number): Promise<Sample[]> {
      if (!Number.isInteger(count) || count < 1 || count > 20000) return Promise.reject(new Error('Use 1..20000 frames'));
      if (remaining) return Promise.reject(new Error('A frame batch is already running'));
      samples = []; remaining = count;
      return new Promise(resolve => { done = resolve; });
    },
    async measure(count = 600, impact?: Impact) {
      const e = engine(), start = state(), capture = e.capture.begin(count), dropped = e.telemetry().gpu.dropped;
      const action = impact ? { kind: 'actual-dev-blast', request: impact, terrainVersionBefore: Number(game.telemetry().terrainVersion),
        settled: false, error: null as string | null, tailFrames: 0, terrainVersionAfter: -1 } : undefined;
      const actionJob = impact ? blast(impact.radius, impact.munition, impact.camera).then(() => { action!.settled = true; }, error => {
        action!.error = String(error); action!.settled = true;
      }) : undefined;
      let measured: Sample[];
      try { measured = await api.step(count); } finally { e.capture.seal(); }
      const end = state();
      const deadline = performance.now() + 10000;
      while (capture.pendingGpu && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      const droppedDuringCapture = e.telemetry().gpu.dropped - dropped;
      while (action && !action.settled && action.tailFrames < 600) { await api.step(1); action.tailFrames++; }
      if (action?.settled) { await actionJob; action.terrainVersionAfter = Number(game.telemetry().terrainVersion); }
      return { start, end, samples: measured, capture: capture.dump(), droppedDuringCapture, action };
    },
    /** Untimed diagnostic only: inspect GPU-written gas emission as well as CPU lights. */
    async readLights() {
      if (remaining) throw new Error('Wait for the current frame batch');
      const e = engine(), source = e.services.scene.get('lightSystem')!.buffer;
      const copy = e.ctx.device.createBuffer({ label: 'benchmark:light-readback', size: source.size, usage: BufferUsage.COPY_DST | BufferUsage.MAP_READ });
      try {
        const encoder = e.ctx.device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, copy, 0, source.size); e.ctx.queue.submit([encoder.finish()]);
        await copy.mapAsync(MapMode.READ);
        const data = copy.getMappedRange(), u32 = new Uint32Array(data), f32 = new Float32Array(data);
        return Array.from({ length: Math.min(u32[0], (source.size - 16) / 64) }, (_, index) => {
          const offset = 4 + index * 16;
          return { index, position: Array.from(f32.slice(offset, offset + 3)), range: f32[offset + 3], rgb: Array.from(f32.slice(offset + 4, offset + 7)),
            direction: Array.from(f32.slice(offset + 8, offset + 11)), type: u32[offset + 12], flags: u32[offset + 13] };
        });
      } finally { copy.unmap(); copy.destroy(); }
    },
    shaders: () => engine().shaderCheck(),
    async disposeRenderer() {
      if (remaining) throw new Error('Wait for the current frame batch');
      const e = engine(), before = e.telemetry().vram;
      await e.ctx.queue.onSubmittedWorkDone();
      game.dispose(); view.dispose();
      return { before, after: { total: e.ctx.vram.total, byCategory: e.ctx.vram.byCategory() } };
    },
    blast,
    restart: () => game.restart(),
    endMatch: () => game.endMatch(),
    startMatch: (setup: Parameters<GameSession['startMatch']>[0]) => game.startMatch(setup),
  };
  Object.defineProperty(window, '__tmtRenderBench', { configurable: true, value: api });
}
