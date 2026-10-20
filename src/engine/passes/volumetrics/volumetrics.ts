import type { EngineServices, QualityTier, RenderModule } from '../../contracts';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { drawFullscreenTriangle } from '../../gpu/fullscreen';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { VOLUME_PARAMS, VOLUME_SUN_CLASS_BINDING, volumeShaders } from './volumetrics.wgsl';

export const VOLUME_TIERS: Readonly<Record<QualityTier, { steps: number; lights: number; shadowSteps: number }>> = {
  low: { steps: 12, lights: 2, shadowSteps: 24 }, medium: { steps: 16, lights: 4, shadowSteps: 32 },
  high: { steps: 20, lights: 6, shadowSteps: 40 }, ultra: { steps: 28, lights: 8, shadowSteps: 48 },
};
export const VOLUME_TEXTURE = 'volumetricHaze';
export const VOLUME_DISTANCE = 'volumetricDistance';
export interface VolumetricsFacet { enabled: boolean; sun: boolean; local: boolean; density: number }
declare module '../../contracts' { interface SceneFacets { volumetrics: VolumetricsFacet } }

/** No private temporal history: scene transitions, camera jumps, light switches and graph resizing
 * immediately affect this frame. TAA receives the current, depth-aware result in the ordinary HDR path. */
export function volumetricsModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'volumetrics',
    install(s: EngineServices) {
      if (s.scene.get('interior')) return;
      const { device, queue } = s.ctx;
      const controls: VolumetricsFacet = { enabled: true, sun: true, local: true, density: 1 };
      const facet = {} as VolumetricsFacet;
      // A feature switch must not leave its previous scattering in the shared TAA history.
      for (const key of Object.keys(controls) as (keyof VolumetricsFacet)[]) {
        Object.defineProperty(facet, key, { enumerable: true, get: () => controls[key], set: (value: never) => {
          if (controls[key] === value) return;
          controls[key] = value; s.scene.get('taa')?.invalidate();
        } });
      }
      s.scene.provide('volumetrics', facet);
      const fog = s.scene.get('fogOfWar'), casters = s.scene.get('sdfCasters'), sunClass = s.scene.get('sunClass');
      if (!fog || !casters) throw new Error('Volumetrics requires fog visibility and SDF casters.');
      const usage = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING;
      s.graph.declareTexture(VOLUME_TEXTURE, { format: 'rgba16float', size: 'quarter', usage });
      s.graph.declareTexture(VOLUME_DISTANCE, { format: 'r32float', size: 'quarter', usage });
      const C = ShaderStage.COMPUTE, F = ShaderStage.FRAGMENT;
      const traceLayout = device.createBindGroupLayout({ label: 'volumetrics:trace', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 3, visibility: C, buffer: { type: 'uniform' } },
        { binding: 4, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 5, visibility: C, buffer: { type: 'uniform' } },
        { binding: 6, visibility: C, sampler: { type: 'filtering' } },
        { binding: 7, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 9, visibility: C, buffer: { type: 'uniform' } },
        { binding: 10, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 11, visibility: C, buffer: { type: 'uniform' } },
        { binding: 12, visibility: C, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 13, visibility: C, buffer: { type: 'uniform' } },
        ...(sunClass ? [{ binding: VOLUME_SUN_CLASS_BINDING, visibility: C, texture: { sampleType: 'uint' as const, viewDimension: '3d' as const } }] : []),
      ] });
      const compositeLayout = device.createBindGroupLayout({ label: 'volumetrics:composite', entries: [
        { binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
      ] });
      const traceKey = 'volumetrics:trace', compositeKey = 'volumetrics:composite';
      const shaders = volumeShaders();
      s.ctx.pipelines.register(traceKey, 'compute', () => ({ label: traceKey,
        layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, traceLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(sunClass ? shaders.traceClassified : shaders.trace, traceKey), entryPoint: 'main' },
      }));
      s.ctx.pipelines.register(compositeKey, 'render', () => {
        const module = s.ctx.pipelines.shaderModule(shaders.composite, compositeKey);
        return { label: compositeKey, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, compositeLayout] }),
          vertex: { module, entryPoint: 'vs_fullscreen' }, fragment: { module, entryPoint: 'fs_volume', targets: [
            { format: 'rgba16float', blend: { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' } } },
          ] }, primitive: { topology: 'triangle-list' } };
      });
      for (const key of [traceKey, compositeKey]) void s.ctx.pipelines.compile(key).catch(() => undefined);
      const params = device.createBuffer({ label: 'volumetrics:params', size: VOLUME_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const sampler = device.createSampler({ label: 'volumetrics:linear', minFilter: 'linear', magFilter: 'linear' });
      const frameGroup = createFrameBindGroup(s, 'volumetrics');
      const traceGroups = new BindGroupResourceCache(4), compositeGroups = new BindGroupResourceCache(4);
      const staging = new ArrayBuffer(VOLUME_PARAMS.size);
      let rendered = -1;
      const enabled = () => facet.enabled && (facet.sun || facet.local) && facet.density > 0 && s.settings.gbufferView === 'none' && s.scene.get('lighting')?.view === 'none';
      disposers.push(s.graph.addPass({ name: 'volumetrics', slot: 'clouds', order: -20,
        reads: ['frameUniforms', 'depth'], writes: [VOLUME_TEXTURE, VOLUME_DISTANCE], enabled,
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(traceKey);
          if (!pipeline) return;
          const tier = VOLUME_TIERS[s.settings.hazeTier ?? c.frame.tier];
          const kind = s.scene.get('planet')?.kind ?? 'temperate';
          const strength = kind === 'dune' ? 1.5 : kind === 'volcanic' ? 1.25 : kind === 'glacial' ? 0.65 : 1;
          const tint = kind === 'dune' ? [1, 0.78, 0.52] : kind === 'volcanic' ? [0.78, 0.77, 0.74] : [0.92, 0.96, 1];
          VOLUME_PARAMS.pack({ quality: [tier.steps, tier.lights, tier.shadowSteps, 1],
            medium: [0.012 * strength * Math.min(3, Math.max(0, facet.density)), 1.6, facet.sun ? 0.65 : 0, facet.local ? 18 : 0], tint: [...tint, 90] }, staging);
          queue.writeBuffer(params, 0, staging);
          const sdf = s.bindings.get('sdf'), lights = s.bindings.get('lights'), clouds = s.bindings.get('cloudShadow');
          const resources: GPUBindingResource[] = [c.resources.view('depth'), c.resources.view(VOLUME_TEXTURE), c.resources.view(VOLUME_DISTANCE), { buffer: params },
            sdf.volume, sdf.params, sampler, lights.list, casters.atlasView, { buffer: casters.listBuffer }, fog.volumeView, { buffer: fog.paramsBuffer }, clouds.cube, clouds.params,
            ...(sunClass ? [sunClass.view] : [])];
          const key = traceGroups.begin(); for (const resource of resources) pushBindingKey(key, resource);
          const group = traceGroups.get(() => device.createBindGroup({ label: traceKey, layout: traceLayout, entries: resources.map((resource, binding) => ({ binding, resource })) }));
          const ts = c.timestampWrites('volumetrics') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: traceKey, ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline); pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, group);
          const [w, h] = c.resources.size(VOLUME_TEXTURE); pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8)); pass.end(); rendered = c.frame.index;
          s.telemetry.gauge('volumetricsVramBytes', w * h * 12 + VOLUME_PARAMS.size);
          s.telemetry.gauge('volumetricsSamples', tier.steps);
          s.telemetry.gauge('volumetricsLocalSamplesPerLight', Math.max(8, Math.floor(tier.steps * 0.6)));
          s.telemetry.gauge('volumetricsLightsPerRay', tier.lights);
        },
      }));
      disposers.push(s.graph.addPass({ name: 'volumetrics.composite', slot: 'clouds', order: -19,
        reads: ['frameUniforms', 'depth', VOLUME_TEXTURE, VOLUME_DISTANCE], writes: ['hdr'], enabled,
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPURenderPipeline>(compositeKey);
          if (!pipeline || rendered !== c.frame.index) return;
          const resources = [c.resources.view(VOLUME_TEXTURE), c.resources.view(VOLUME_DISTANCE), c.resources.view('depth')];
          const key = compositeGroups.begin(); key.push(...resources);
          const group = compositeGroups.get(() => device.createBindGroup({ label: compositeKey, layout: compositeLayout, entries: resources.map((resource, binding) => ({ binding, resource })) }));
          const ts = c.timestampWrites('volumetrics.composite') as GPURenderPassTimestampWrites | undefined;
          const pass = c.encoder.beginRenderPass({ label: compositeKey, colorAttachments: [{ view: c.resources.view('hdr'), loadOp: 'load', storeOp: 'store' }], ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline); pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, group); drawFullscreenTriangle(pass); pass.end();
        },
      }));
      disposers.push(() => s.ctx.deferDestroy(params));
    },
    dispose() { for (const dispose of disposers.splice(0)) dispose(); },
  };
}
