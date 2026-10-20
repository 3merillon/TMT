/** Planetary cloud volume, world shadow cube and depth-aware temporal reconstruction.
 * The deck turns with the presentation wind aloft (scene facet `wind`: the match wind), accumulated as a rotation, and
 * remembers what blasts did to it in a persistent field (field.ts) that drifts with it and heals over minutes.
 * Planets reference: cloud-density, cloud-shell-march, cloud-shadow-{shader,sample}, cloud-pipeline.
 * TMT adaptation uses absolute miniature radii, reversed-Z unprojection and graph-owned histories.
 */
import type { EngineServices, PassContext, RenderModule } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { link } from '../../wgsl/module';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { CLOUD_PARAMS_BYTES, CLOUD_PRESETS, CLOUD_TIERS, packCloudParams, type CloudControls, type CloudImpactKind } from './params';
import { CloudField, quatAxisAngle, quatIdentity, quatMul, quatNormalize, type Quat } from './field';
import { cloudNoiseWgsl } from './density.wgsl';
import { cloudShadowBakeWgsl } from './shadow.wgsl';
import { cloudCompositeWgsl, cloudRaymarchWgsl, cloudTemporalWgsl } from './raymarch.wgsl';

export const CLOUD_COLOR = 'cloudColor';
export const CLOUD_META = 'cloudMeta';
const RAW = 'cloudRaw';
const NOISE_SIZE = 64;
export interface CloudsFacet extends CloudControls { shockwaves: boolean; localLights: boolean; readonly shockCount: number; reset(): void; invalidate(): void; impact(position: readonly number[], radius: number, time?: number, kind?: CloudImpactKind): void }
declare module '../../contracts' { interface SceneFacets { clouds: CloudsFacet } }
export function cloudShaders() {
  return { noise: link(cloudNoiseWgsl), shadow: link(cloudShadowBakeWgsl), raymarch: link(cloudRaymarchWgsl), temporal: link(cloudTemporalWgsl), composite: link(cloudCompositeWgsl) };
}

export function cloudsModule(): RenderModule {
  const dispose: (() => void)[] = [];
  return {
    name: 'clouds',
    install(s: EngineServices) {
      if (s.scene.get('interior')) return;
      const { device, queue } = s.ctx;
      const fog = s.scene.get('fogOfWar'), casters = s.scene.get('sdfCasters'), flow = s.scene.get('gasCloudFlow');
      if (!fog || !casters || !flow) throw new Error('Clouds require fog visibility, SDF casters and gas flow.');
      const usage = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING;
      // Cloud rays, metadata and history match geometry pixels at every render tier.
      for (const name of [RAW, CLOUD_META, CLOUD_COLOR]) s.graph.declareTexture(name, {
        format: 'rgba16float', size: 'internal', usage, history: name !== RAW,
      });
      const noise = device.createTexture({ label: 'cloud:noise', size: [NOISE_SIZE, NOISE_SIZE, NOISE_SIZE], dimension: '3d', format: 'rgba8unorm', usage });
      const noiseView = noise.createView();
      const params = device.createBuffer({ label: 'cloud:params', size: CLOUD_PARAMS_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const repeat = device.createSampler({ label: 'cloud:noise-repeat', minFilter: 'linear', magFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
      const linear = device.createSampler({ label: 'cloud:linear', minFilter: 'linear', magFilter: 'linear' });
      const uniform: GPUBufferBinding = { buffer: params };
      const C = ShaderStage.COMPUTE, F = ShaderStage.FRAGMENT;
      const entry = (binding: number, item: Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>, visibility: number = C): GPUBindGroupLayoutEntry => ({ binding, visibility, ...item });
      const u = { buffer: { type: 'uniform' as const } };
      const tex = { texture: { sampleType: 'float' as const } };
      const dep = { texture: { sampleType: 'depth' as const } };
      const samp = { sampler: { type: 'filtering' as const } };
      const tex3 = { texture: { sampleType: 'float' as const, viewDimension: '3d' as const } };
      const storage = { storageTexture: { access: 'write-only' as const, format: 'rgba16float' as const } };
      const layouts = {
        noise: device.createBindGroupLayout({ label: 'layout:cloud-noise', entries: [entry(0, { storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '3d' } })] }),
        shadow: device.createBindGroupLayout({ label: 'layout:cloud-shadow', entries: [entry(0, u), entry(1, tex3), entry(2, samp), entry(3, { storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } }), entry(4, tex3)] }),
        raymarch: device.createBindGroupLayout({ label: 'layout:cloud-raymarch', entries: [entry(0, u), entry(1, tex3), entry(2, samp), entry(3, dep), entry(4, storage), entry(5, storage), entry(6, u), entry(7, tex), entry(8, tex), entry(9, samp), entry(10, tex3), entry(11, u), entry(12, samp), entry(13, { buffer: { type: 'read-only-storage' } }), entry(14, tex3), entry(15, u), entry(16, tex3), entry(17, u), entry(18, tex3), entry(19, dep)] }),
        temporal: device.createBindGroupLayout({ label: 'layout:cloud-temporal', entries: [entry(0, u), entry(1, tex), entry(2, tex), entry(3, tex), entry(4, tex), entry(5, storage)] }),
        composite: device.createBindGroupLayout({ label: 'layout:cloud-composite', entries: [entry(0, tex, F)] }),
      };
      const shaders = cloudShaders();
      const frameGroup = createFrameBindGroup(s, 'clouds');
      const keys = { noise: 'clouds:noise', shadow: 'clouds:shadow', raymarch: 'clouds:raymarch', raymarchCalm: 'clouds:raymarchCalm', temporal: 'clouds:temporal', composite: 'clouds:composite' };
      const standalone = (name: string) => name === 'noise' || name === 'shadow';
      for (const name of ['noise', 'shadow', 'raymarch', 'raymarchCalm', 'temporal'] as const) {
        const shader = name === 'raymarchCalm' ? 'raymarch' : name;
        s.ctx.pipelines.register(keys[name], 'compute', () => ({ label: keys[name],
          layout: device.createPipelineLayout({ bindGroupLayouts: standalone(name) ? [layouts[shader]] : [s.ctx.layouts.frame, layouts[shader]] }),
          compute: { module: s.ctx.pipelines.shaderModule(shaders[shader], keys[shader]), entryPoint: 'main', ...(name === 'raymarchCalm' ? { constants: { CLOUD_FLOW: 0 } } : {}) },
        }));
        void s.ctx.pipelines.compile(keys[name]).catch(() => undefined);
      }
      s.ctx.pipelines.register(keys.composite, 'render', () => ({ label: keys.composite,
        layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layouts.composite] }),
        vertex: { module: s.ctx.pipelines.shaderModule(shaders.composite, keys.composite), entryPoint: 'vs' },
        fragment: { module: s.ctx.pipelines.shaderModule(shaders.composite, keys.composite), entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }] }, primitive: { topology: 'triangle-list' },
      }));
      void s.ctx.pipelines.compile(keys.composite).catch(() => undefined);
      const noiseGroup = device.createBindGroup({ layout: layouts.noise, entries: [{ binding: 0, resource: noiseView }] });
      let cube: GPUTexture | undefined, cubeSize = 0, shadowWriteView: GPUTextureView;
      const setCube = (size: number) => {
        if (cubeSize === size) return;
        s.ctx.deferDestroy(cube); cubeSize = size;
        cube = device.createTexture({ label: 'cloud:shadow-cube', size: [size, size, 6], format: 'rgba16float', usage });
        s.bindings.provide('cloudShadow', { cube: cube.createView({ dimension: 'cube' }), params: uniform });
        shadowWriteView = cube.createView({ dimension: '2d-array' });
      };
      setCube(CLOUD_TIERS[s.settings.cloudTier ?? s.settings.tier].shadowSize);
      const caches = { shadow: new BindGroupResourceCache(), raymarch: new BindGroupResourceCache(), temporal: new BindGroupResourceCache(), composite: new BindGroupResourceCache() };
      const group = (name: keyof typeof caches, resources: GPUBindingResource[]) => {
        const cache = caches[name], key = cache.begin(); resources.forEach(r => pushBindingKey(key, r));
        return cache.get(() => device.createBindGroup({ label: `cloud:${name}`, layout: layouts[name], entries: resources.map((resource, binding) => ({ binding, resource })) }));
      };
      let invalidated = true, noiseReady = false, active = false, lastActive = false, lastState = '', lastRun = -1, lastResolved = -1, lastTime = NaN;
      let calm = false;
      const field = new CloudField(s);
      field.allocate(s.settings.tier);
      dispose.push(s.events.on('tierChanged', e => field.allocate(e.tier)));
      /** The deck's rotation by the wind so far, and last frame's. */
      let rotation: Quat = quatIdentity(), previous: Quat = quatIdentity();
      const controls: CloudsFacet = { enabled: true, shadows: true, coverage: 1, density: 1, shockwaves: true, localLights: true, get shockCount() { return field.impactCount; }, reset() { field.clear(); invalidated = true; lastResolved = -1; lastRun = -1; lastTime = NaN; s.scene.get('taa')?.invalidate(); }, invalidate: () => { invalidated = true; },
        impact(position, radius, time = lastTime, kind = 'blast') {
          if (!Number.isFinite(time) || !Number.isFinite(radius) || radius <= 0 || position.length !== 3 || !position.every(Number.isFinite)) return;
          field.impact(position, radius, time, kind); invalidated = true;
        },
      };
      s.scene.provide('clouds', controls);
      for (const event of ['resize', 'planetChanged', 'terrainCommitted'] as const) dispose.push(s.events.on(event, () => { invalidated = true; if (event === 'planetChanged') { field.clear(); rotation = quatIdentity(); previous = quatIdentity(); } }));
      const compute = (c: PassContext, name: 'noise' | 'shadow' | 'raymarch' | 'temporal', bg: GPUBindGroup, w: number, h: number, z = 1, key = keys[name]) => {
        const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(key); if (!pipeline) return false;
        const ts = c.timestampWrites(`clouds.${name}`) as GPUComputePassTimestampWrites | undefined;
        const pass = c.encoder.beginComputePass({ label: `clouds.${name}`, ...(ts ? { timestampWrites: ts } : {}) });
        pass.setPipeline(pipeline);
        if (standalone(name)) pass.setBindGroup(0, bg);
        else { pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, bg); }
        pass.dispatchWorkgroups(w, h, z); pass.end(); return true;
      };
      dispose.push(s.graph.addPass({ name: 'clouds.prepare', slot: 'compute.commit', order: 20, reads: ['frameUniforms'], writes: [], run(c) {
        const p = s.scene.get('planet'), f = c.frame;
        const quality = s.settings.cloudTier ?? f.tier;
        setCube(CLOUD_TIERS[quality].shadowSize);
        const diagnostic = s.settings.gbufferView !== 'none' || (s.scene.get('lighting')?.view ?? 'none') !== 'none';
        const state = `${f.internal.join('x')}:${quality}:${p?.seed}:${p?.kind}:${p?.radius}:${controls.coverage}:${controls.density}:${controls.shockwaves}:${controls.localLights}:${diagnostic}`;
        if (state !== lastState) { lastState = state; invalidated = true; }
        if (!noiseReady) noiseReady = compute(c, 'noise', noiseGroup, NOISE_SIZE / 4, NOISE_SIZE / 4, NOISE_SIZE / 4);
        const ready = noiseReady && ['shadow', 'raymarch', 'raymarchCalm', 'temporal', 'composite'].every(n => !!s.ctx.pipelines.get(keys[n as keyof typeof keys]));
        active = !!p && !s.scene.get('interior') && controls.enabled && ready && !diagnostic;
        if (active !== lastActive) { lastActive = active; invalidated = true; s.scene.get('taa')?.invalidate(); }
        if (active && (lastResolved !== f.index - 1 || Math.abs(f.time - lastTime) > Math.max(0.25, f.dt * 4))) invalidated = true;
        lastTime = f.time;
        const planet = p ?? { seed: 0, kind: 'temperate' as const, radius: 18 }, preset = CLOUD_PRESETS[planet.kind];
        const shell: [number, number] = [planet.radius + preset.base, planet.radius + preset.top];
        // The wind aloft turns the whole deck about the air field's axis (world = R · advected).
        const wind = s.scene.get('wind');
        previous = rotation;
        if (wind) rotation = quatNormalize(quatMul(quatAxisAngle(wind.axis, wind.aloft / ((shell[0] + shell[1]) / 2) * Math.min(Math.max(f.dt, 0), 0.1)), rotation));
        if (active) field.update(c, rotation, shell, flow, controls.shockwaves);
        const regions = controls.shockwaves ? field.regions(rotation) : [];
        calm = regions.length === 0;
        packCloudParams(planet, f, { ...controls, quality, enabled: active }, invalidated || !!f.snap || f.index === 0,
          s.scene.get('sun')?.illuminance ?? 20, staging,
          { rotation, previous, field: { half: field.half, gain: field.gain(f.time), regions, updating: field.updating } });
        queue.writeBuffer(params, 0, staging);
        const pixels = f.internal[0] * f.internal[1];
        s.telemetry.gauge('cloudsVramBytes', NOISE_SIZE ** 3 * 4 + cubeSize * cubeSize * 6 * 8 + pixels * 8 * 5 + CLOUD_PARAMS_BYTES);
        s.telemetry.gauge('cloudsSteps', active ? CLOUD_TIERS[quality].steps : 0);
        s.telemetry.gauge('cloudsShockwaves', controls.shockwaves ? field.impactCount : 0);
        s.telemetry.gauge('cloudsDamagedRegions', regions.length);
      } }));
      const staging = new ArrayBuffer(CLOUD_PARAMS_BYTES);
      dispose.push(s.graph.addPass({ name: 'clouds.shadow', slot: 'shadows', order: -10, reads: [], writes: [], run(c) {
        if (active && controls.shadows) compute(c, 'shadow', group('shadow', [uniform, noiseView, repeat, shadowWriteView, field.view!]), Math.ceil(cubeSize / 8), Math.ceil(cubeSize / 8), 6);
      } }));
      // Clouds composite after the liquids, so their rays end at the liquid surface (fluids.surface runs just before).
      const liquids = !!s.scene.get('fluids');
      dispose.push(s.graph.addPass({ name: 'clouds.raymarch', slot: 'clouds', order: 0, reads: ['frameUniforms', 'depth', ...(liquids ? ['liquidZ'] : [])], writes: [RAW, CLOUD_META], run(c) {
        if (!active) return; const r = c.resources, atmo = s.bindings.get('atmosphere'), sdf = s.bindings.get('sdf');
        const bg = group('raymarch', [uniform, noiseView, repeat, r.view('depth'), r.view(RAW), r.view(CLOUD_META), atmo.params, atmo.transmittance, atmo.multiscatter, linear, sdf.volume, sdf.params, linear, s.bindings.get('lights').list, casters.atlasView, { buffer: casters.listBuffer }, fog.volumeView, { buffer: fog.paramsBuffer }, field.view!, r.view(liquids ? 'liquidZ' : 'depth')]);
        const [w, h] = r.size(RAW);
        if (compute(c, 'raymarch', bg, Math.ceil(w / 8), Math.ceil(h / 8), 1, calm ? keys.raymarchCalm : keys.raymarch)) lastRun = c.frame.index;
      } }));
      dispose.push(s.graph.addPass({ name: 'clouds.temporal', slot: 'clouds', order: 1, reads: ['frameUniforms', RAW, CLOUD_META, `history:${CLOUD_COLOR}`, `history:${CLOUD_META}`], writes: [CLOUD_COLOR], run(c) {
        if (!active || lastRun !== c.frame.index) return; const r = c.resources;
        const bg = group('temporal', [uniform, r.view(RAW), r.view(CLOUD_META), r.history(CLOUD_COLOR), r.history(CLOUD_META), r.view(CLOUD_COLOR)]);
        const [w, h] = r.size(CLOUD_COLOR); if (compute(c, 'temporal', bg, Math.ceil(w / 8), Math.ceil(h / 8))) { invalidated = false; lastResolved = c.frame.index; }
      } }));
      dispose.push(s.graph.addPass({ name: 'clouds.composite', slot: 'transparent', order: -15, reads: [CLOUD_COLOR], writes: ['hdr'], run(c) {
        if (!active || lastResolved !== c.frame.index) return;
        const pipeline = s.ctx.pipelines.get<GPURenderPipeline>(keys.composite); if (!pipeline) return;
        const r = c.resources; const bg = group('composite', [r.view(CLOUD_COLOR)]);
        const ts = c.timestampWrites('clouds.composite') as GPURenderPassTimestampWrites | undefined;
        const pass = c.encoder.beginRenderPass({ label: 'clouds.composite', colorAttachments: [{ view: r.view('hdr'), loadOp: 'load', storeOp: 'store' }], ...(ts ? { timestampWrites: ts } : {}) });
        pass.setPipeline(pipeline); pass.setBindGroup(0, frameGroup); pass.setBindGroup(1, bg); pass.draw(3); pass.end();
      } }));
      dispose.push(() => { for (const cache of Object.values(caches)) cache.clear(); s.ctx.deferDestroy(noise); s.ctx.deferDestroy(params); s.ctx.deferDestroy(cube); field.dispose(); });
    },
    dispose() { for (const d of dispose.splice(0)) d(); },
  };
}
