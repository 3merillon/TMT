/**
 * Fog of war from the planet SDF (docs/visibility-architecture.md). Replaces the z-fail stencil volumes (archived at
 * the tag `archive/stencil-visibility`).
 *
 * Passes (slot 'ao', after the G-buffer; the SDF is rebuilt earlier in 'compute.commit'):
 * - 'fog.volume': the world-space hidden-fraction volume (over ±FOG_VOLUME_HALF u) for the team's sensors;
 * - 'fog.surface': the half-res jittered surface trace plus the full-res depth-aware resolve into `hiddenView`
 *   (0 seen … 1 hidden) that lighting reads for the veil.
 * Lighting marches camera rays through `volumeView` for the volumetric war fog.
 *
 * Sensors: every living tank of the observer's team (view.ts), capped by tier (Low 2, otherwise 4) and ordered nearest
 * the camera focus first (traces stop once a point is fully seen). Tanks are receivers only, as in the simulation.
 * `probe(points)` evaluates the same visibility at world points and reads it back (gates and debugging).
 */
import type { EngineServices, QualityTier, RenderModule, Vec3 } from '../../contracts';
import { BufferUsage, MapMode, ShaderStage, TextureUsage } from '../../gpu/flags';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { link } from '../../wgsl/module';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import {
  FOG_MAX_SENSORS, FOG_PARAMS, fogProbeWgsl, fogSurfaceHalfWgsl, fogSurfaceResolveWgsl, fogVisibilityWgsl, fogVolumeWgsl,
} from './fog.wgsl';

/** The volume covers the atmosphere's soft top (24.5 + 3·1.2 = 28.1 u) so sky rays integrate to the exit. */
export const FOG_VOLUME_HALF = 28.5;
export const FOG_ATMOSPHERE_TOP = 28.1;
/** Penumbra width behind an occluder at distance t: clamp(min + growth·t, min, max) world units. */
export const FOG_PENUMBRA = { min: 0.5, growth: 0.12, max: 2.0 } as const;

interface FogTier { sensors: number; volume: number; halfRate: boolean; samples: number; surfaceSteps: number; volumeSteps: number; fullRes: boolean }
export const FOG_TIERS: Readonly<Record<QualityTier, FogTier>> = {
  low: { sensors: 2, volume: 64, halfRate: true, samples: 8, surfaceSteps: 48, volumeSteps: 40, fullRes: false },
  medium: { sensors: 4, volume: 96, halfRate: true, samples: 12, surfaceSteps: 64, volumeSteps: 48, fullRes: false },
  high: { sensors: 4, volume: 112, halfRate: false, samples: 16, surfaceSteps: 80, volumeSteps: 56, fullRes: false },
  ultra: { sensors: 4, volume: 128, halfRate: false, samples: 24, surfaceSteps: 96, volumeSteps: 64, fullRes: true },
};
const TIER_INDEX: Record<QualityTier, number> = { low: 0, medium: 1, high: 2, ultra: 3 };

export interface FogOfWarFacet {
  /** Sensors are set and the SDF holds terrain. */
  readonly active: boolean;
  readonly paramsBuffer: GPUBuffer;
  /** Full-resolution surface veil: 0 seen … 1 hidden (sky 0). */
  readonly hiddenView: GPUTextureView;
  /** World-space hidden fraction over ±FOG_VOLUME_HALF (sample with a linear clamp sampler). */
  readonly volumeView: GPUTextureView;
  /** The team's sensor origins, in world units (the engine keeps the first N by tier, nearest the camera focus). */
  set(origins: readonly (readonly number[])[], world?: unknown): void;
  clear(): void;
  /** Soft visibility (1 seen … 0 hidden) at world points; no normal means a point in the air. Resolves after a frame. */
  probe(points: readonly { position: readonly number[]; normal?: readonly number[] }[]): Promise<number[]>;
}

declare module '../../contracts' {
  interface SceneFacets { fogOfWar: FogOfWarFacet }
}

export function fogOfWarModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'fog-of-war',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const C = ShaderStage.COMPUTE;
      const tier1 = device.features.has('texture-formats-tier1');
      const maskFormat: GPUTextureFormat = tier1 ? 'r8unorm' : 'rgba8unorm';
      const paramsBuffer = device.createBuffer({ label: 'fog:params', size: FOG_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const frameGroup = createFrameBindGroup(s, 'fog');
      const sampler = device.createSampler({ label: 'fog:linear', magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });

      // @group(2): the SDF (reserved binding) and its sampler.
      const sdfLayout = device.createBindGroupLayout({ label: 'layout:fog-sdf', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
      ] });
      const sdfDeps = [frameWgsl, depthWgsl, gbufferWgsl, sdfBindingsWgsl(2, { volume: 0, params: 1, sampler: 2 }), sdfWgsl, fogVisibilityWgsl];
      let sdfGroup: GPUBindGroup | null = null, sdfGroupKey: unknown = null;
      const currentSdfGroup = () => {
        const r = s.bindings.get('sdf');
        if (sdfGroupKey !== r.volume) {
          sdfGroupKey = r.volume;
          sdfGroup = device.createBindGroup({ label: 'fog:sdf', layout: sdfLayout, entries: [
            { binding: 0, resource: r.volume }, { binding: 1, resource: r.params }, { binding: 2, resource: sampler }] });
        }
        return sdfGroup!;
      };

      const surfaceLayout = (extra: GPUBindGroupLayoutEntry[]) => device.createBindGroupLayout({ label: 'layout:fog-surface', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: C, buffer: { type: 'uniform' } },
        ...extra,
      ] });
      const halfLayout = surfaceLayout([{ binding: 4, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } }]);
      const resolveLayout = surfaceLayout([
        { binding: 4, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: maskFormat } },
      ]);
      const volumeLayout = device.createBindGroupLayout({ label: 'layout:fog-volume', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: maskFormat, viewDimension: '3d' } },
      ] });
      const probeLayout = device.createBindGroupLayout({ label: 'layout:fog-probe', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
      ] });
      const keys = { half: 'fog:surface-half', resolve: `fog:surface-resolve:${maskFormat}`, volume: `fog:volume:${maskFormat}`, probe: 'fog:probe' };
      const reg = (key: string, layout: GPUBindGroupLayout, code: ReturnType<typeof link>, entryPoint: string) => cache.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout, sdfLayout] }),
        compute: { module: cache.shaderModule(code, key), entryPoint },
      }));
      reg(keys.half, halfLayout, link(fogSurfaceHalfWgsl(sdfDeps)), 'trace_half');
      reg(keys.resolve, resolveLayout, link(fogSurfaceResolveWgsl(maskFormat, sdfDeps)), 'resolve_full');
      reg(keys.volume, volumeLayout, link(fogVolumeWgsl(maskFormat, sdfDeps)), 'fill');
      reg(keys.probe, probeLayout, link(fogProbeWgsl(sdfDeps)), 'probe');
      for (const key of Object.values(keys)) void cache.compile(key).catch(() => undefined);

      // ── Resources ──
      let width = 0, height = 0;
      let half: GPUTexture | null = null, hidden: GPUTexture | null = null;
      let halfView!: GPUTextureView, hiddenView!: GPUTextureView;
      const allocateScreen = (w: number, h: number) => {
        if (w === width && h === height && hidden) return;
        s.ctx.deferDestroy(half); s.ctx.deferDestroy(hidden);
        width = w; height = h;
        half = device.createTexture({ label: 'fog:surface-half', size: [Math.ceil(w / 2), Math.ceil(h / 2)], format: 'rgba16float',
          usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        hidden = device.createTexture({ label: 'fog:surface-hidden', size: [w, h], format: maskFormat, usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        halfView = half.createView(); hiddenView = hidden.createView();
      };
      allocateScreen(1, 1);
      let volumeSize = 0, volume: GPUTexture | null = null, volumeView!: GPUTextureView;
      const allocateVolume = (m: number) => {
        if (m === volumeSize && volume) return;
        s.ctx.deferDestroy(volume);
        volumeSize = m;
        volume = device.createTexture({ label: 'fog:volume', size: [m, m, m], dimension: '3d', format: maskFormat,
          usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        volumeView = volume.createView({ dimension: '3d' });
      };
      // Interiors have no sensor fog. Keep only the valid 1³ binding consumed by the shared lighting layout.
      allocateVolume(s.scene.get('interior') ? 1 : FOG_TIERS[s.settings.tier].volume);

      let origins: Vec3[] = [];
      const paramsStaging = new ArrayBuffer(FOG_PARAMS.size);
      const sdfValid = () => !!s.scene.get('sdf')?.valid;
      const active = () => origins.length > 0 && sdfValid();
      const pack = (index: number, tier: QualityTier, focus: readonly number[]) => {
        const t = FOG_TIERS[tier];
        const dist = (a: Vec3) => Math.hypot(a[0] - focus[0], a[1] - focus[1], a[2] - focus[2]);
        const sorted = [...origins].sort((a, b) => dist(a) - dist(b)).slice(0, Math.min(t.sensors, FOG_MAX_SENSORS));
        const sensors: number[] = [];
        for (let i = 0; i < FOG_MAX_SENSORS; i++) sensors.push(...(sorted[i] ?? [0, 0, 0]), sorted[i] ? 1 : 0);
        FOG_PARAMS.pack({
          settings: [active() ? 1 : 0, sorted.length, TIER_INDEX[tier], index],
          sensors,
          penumbra: [FOG_PENUMBRA.min, FOG_PENUMBRA.growth, FOG_PENUMBRA.max, t.halfRate ? index & 1 : -1],
          volume: [volumeSize, FOG_VOLUME_HALF, (2 * FOG_VOLUME_HALF) / volumeSize, FOG_ATMOSPHERE_TOP],
          march: [t.samples, t.surfaceSteps, t.volumeSteps, t.fullRes ? 1 : 0],
        }, paramsStaging);
        queue.writeBuffer(paramsBuffer, 0, paramsStaging);
      };
      // Packed every frame: lighting reads `enabled` even when the passes are skipped.
      disposers.push(s.graph.addPass({
        name: 'fog.params', slot: 'upload', order: 41, reads: [], writes: [],
        run(c) { allocateVolume(s.scene.get('interior') ? 1 : FOG_TIERS[c.frame.tier].volume); pack(c.frame.index, c.frame.tier, c.frame.focus.world); },
      }));

      disposers.push(s.graph.addPass({
        name: 'fog.volume', slot: 'ao', order: -20, reads: [], writes: [],
        enabled: () => active(),
        run(c) {
          const pipe = cache.get<GPUComputePipeline>(keys.volume);
          if (!pipe) return;
          const ts = c.timestampWrites('fog.volume') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'fog.volume', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipe);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, device.createBindGroup({ layout: volumeLayout, entries: [
            { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: volumeView }] }));
          pass.setBindGroup(2, currentSdfGroup());
          const g = Math.ceil(volumeSize / 4);
          pass.dispatchWorkgroups(g, g, g);
          pass.end();
        },
      }));

      disposers.push(s.graph.addPass({
        name: 'fog.surface', slot: 'ao', order: -10, reads: ['frameUniforms', 'depth', 'normals', 'ids'], writes: [],
        enabled: () => active(),
        run(c) {
          const halfPipe = cache.get<GPUComputePipeline>(keys.half), resolvePipe = cache.get<GPUComputePipeline>(keys.resolve);
          if (!halfPipe || !resolvePipe) return;
          const [w, h] = c.frame.internal;
          allocateScreen(w, h);
          const r = c.resources;
          const inputs = [r.view('depth'), r.view('normals'), r.view('ids')];
          const group = (layout: GPUBindGroupLayout, extra: GPUBindGroupEntry[]) => device.createBindGroup({ layout, entries: [
            ...inputs.map((view, binding) => ({ binding, resource: view })), { binding: 3, resource: { buffer: paramsBuffer } }, ...extra] });
          const ts = c.timestampWrites('fog.surface') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'fog.surface', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(2, currentSdfGroup());
          if (!FOG_TIERS[c.frame.tier].fullRes) {
            pass.setPipeline(halfPipe);
            pass.setBindGroup(1, group(halfLayout, [{ binding: 4, resource: halfView }]));
            pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
          }
          // Separate dispatches in one pass are ordered: the resolve sees the half-res trace.
          pass.setPipeline(resolvePipe);
          pass.setBindGroup(1, group(resolveLayout, [{ binding: 4, resource: halfView }, { binding: 5, resource: hiddenView }]));
          pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          pass.end();
        },
      }));

      // ── Probes ──
      type ProbeJob = { points: Float32Array; count: number; resolve: (v: number[]) => void; reject: (e: unknown) => void };
      const probes: ProbeJob[] = [];
      disposers.push(s.graph.addPass({
        name: 'fog.probe', slot: 'debug', order: 5, reads: [], writes: [],
        enabled: () => probes.length > 0 && active() && !!cache.get(keys.probe),
        run(c) {
          const job = probes.shift()!;
          const input = device.createBuffer({ label: 'fog:probe-in', size: Math.max(32, job.points.byteLength), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
          const output = device.createBuffer({ label: 'fog:probe-out', size: Math.max(4, job.count * 4), usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC });
          const readback = device.createBuffer({ label: 'fog:probe-readback', size: Math.max(4, job.count * 4), usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
          queue.writeBuffer(input, 0, job.points.buffer, job.points.byteOffset, job.points.byteLength);
          const pass = c.encoder.beginComputePass({ label: 'fog.probe' });
          pass.setPipeline(cache.get<GPUComputePipeline>(keys.probe)!);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, device.createBindGroup({ layout: probeLayout, entries: [
            { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: { buffer: input } }, { binding: 2, resource: { buffer: output } }] }));
          pass.setBindGroup(2, currentSdfGroup());
          pass.dispatchWorkgroups(Math.ceil(job.count / 64));
          pass.end();
          c.encoder.copyBufferToBuffer(output, 0, readback, 0, job.count * 4);
          setTimeout(() => {
            void queue.onSubmittedWorkDone().then(() => readback.mapAsync(MapMode.READ)).then(() => {
              job.resolve([...new Float32Array(readback.getMappedRange().slice(0))].slice(0, job.count));
              readback.unmap();
            }).catch(job.reject).finally(() => { for (const b of [input, output, readback]) s.ctx.deferDestroy(b); });
          }, 0);
        },
      }));

      const facet: FogOfWarFacet = {
        get active() { return active(); },
        paramsBuffer,
        get hiddenView() { return hiddenView; },
        get volumeView() { return volumeView; },
        set(next) { origins = next.map(o => [o[0], o[1], o[2]] as Vec3); },
        clear() { origins = []; },
        probe(points) {
          return new Promise((resolve, reject) => {
            const data = new Float32Array(Math.max(1, points.length) * 8);
            points.forEach((p, i) => {
              data.set([p.position[0], p.position[1], p.position[2], 0], i * 8);
              if (p.normal) data.set([p.normal[0], p.normal[1], p.normal[2], 0], i * 8 + 4);
            });
            probes.push({ points: data, count: points.length, resolve, reject });
          });
        },
      };
      s.scene.provide('fogOfWar', facet);
      disposers.push(() => { for (const r of [paramsBuffer, half, hidden, volume]) s.ctx.deferDestroy(r); });
    },
    dispose() { for (const d of disposers.splice(0).reverse()) d(); },
  };
}
