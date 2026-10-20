// Ported from Planets src/gpu/tsr-pipeline.ts (MIT, same owner), a port of @pmndrs/upscaler v0.5.0 — adapted
/**
 * Temporal super resolution, the resolver of the 'taa' slot while the frame is rendered BELOW display resolution
 * (shaders, their origin and the licence notice: tsr.wgsl.ts). At native resolution nothing here is loaded, built, run or
 * allocated: taa.ts imports this module the first time a frame is rendered below display size, the passes are registered
 * with the frame graph only while that holds and the five pipelines exist, and until then the TAA's own upscale branch
 * keeps resolving. The output is the TAA's texture, so 'taa.present', shockwaves, optics, bloom and the composite never
 * see which resolver ran.
 *
 * Per frame, in slot order:
 *   'tsr.backdrop'    (clouds, −10) copies hdr after the haze and before the clouds. The haze is left out: it has no
 *                     history of its own (the TAA's is its only denoiser) and is a smooth function of the view ray and
 *                     the surface depth, which the surface's vectors reproject.
 *   'tsr.veil'        (clouds, 10) internal: how much the clouds' composite changed each pixel.
 *   'tsr.opaque'      (transparent, −7) copies hdr after the water (which writes depth and velocity like a surface) and
 *                     before the gas, fire and spray, none of which have either: the reactive mask is the difference
 *                     between that copy and the final hdr.
 *   'tsr.reconstruct' (taa, 0) internal: dilated depth and motion, depth scattered to the previous positions.
 *   'tsr.mask'        (taa, 1) internal: disocclusion, no-history, reactive, plain clip.
 *   'tsr.accumulate'  (taa, 2) display: jitter-aware upsample, rectified history, locks.
 *   'tsr.sharpen'     (taa, 3) display: RCAS, back to linear HDR in the TAA's texture.
 * Memory while it runs, at display D and internal R pixels: two histories and two lock buffers (40 B × D), two dilated
 * depths, motion, masks, veil, the scatter buffer and the opaque copy (36 B × R).
 */
import type { EngineServices, PassContext } from '../../contracts';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { HDR_FORMAT } from '../lighting/lighting';
import type { TsrControls } from './taa';
import { TSR_DEBUG_VIEWS, TSR_PARAMS, tsrShaders } from './tsr.wgsl';

export const TSR_TEXTURES = { depth: 'tsrDepth', motion: 'tsrMotion', mask: 'tsrMask', history: 'tsrHistory', locks: 'tsrLocks', opaque: 'tsrOpaque', veil: 'tsrVeil' } as const;
export const TSR_STAGES = ['veil', 'reconstruct', 'mask', 'accumulate', 'sharpen'] as const;
type Stage = typeof TSR_STAGES[number];

/** Bind group layout entries per stage, after the params block at binding 0 (tests check them against the WGSL). */
export function tsrLayoutEntries(): Record<Stage, GPUBindGroupLayoutEntry[]> {
  const C = ShaderStage.COMPUTE;
  const uniform: GPUBindGroupLayoutEntry = { binding: 0, visibility: C, buffer: { type: 'uniform' } };
  const tex = (binding: number, sampleType: GPUTextureSampleType = 'unfilterable-float'): GPUBindGroupLayoutEntry => ({ binding, visibility: C, texture: { sampleType } });
  const store = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({ binding, visibility: C, storageTexture: { access: 'write-only', format } });
  return {
    veil: [uniform, tex(1), tex(2), store(3, 'rgba8unorm')],
    reconstruct: [uniform, tex(1, 'depth'), tex(2), tex(3, 'uint'), store(4, 'r32float'), store(5, 'rgba16float'), { binding: 6, visibility: C, buffer: { type: 'storage' } }],
    mask: [uniform, tex(1), tex(2), { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } }, store(4, 'rgba8unorm'), tex(5), tex(6), tex(7), tex(8)],
    accumulate: [uniform, tex(1), tex(2), tex(3), tex(4, 'float'), { binding: 5, visibility: C, sampler: { type: 'filtering' } }, store(6, HDR_FORMAT), tex(7, 'float'), store(8, 'rgba8unorm')],
    sharpen: [uniform, tex(1), store(2, HDR_FORMAT), tex(3), tex(4), tex(5)],
  };
}

export interface TsrHost {
  /** The resolve target shared with the TAA (display size, linear HDR). */
  output: string;
  /** The `taa` facet's switch: false resolves every frame from the current frame alone. */
  enabled(): boolean;
  /** Is the frame rendered below display size (the last 'resize')? */
  wanted(): boolean;
}

export function installTsr(s: EngineServices, host: TsrHost, controls: TsrControls): { active(): boolean; invalidate(): void; dispose(): void } {
  const { device, queue } = s.ctx;
  const T = TSR_TEXTURES;
  const work = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING;
  const entries = tsrLayoutEntries(), shaders = tsrShaders();
  const key = (stage: Stage) => `post:tsr-${stage}`;
  const layouts = {} as Record<Stage, GPUBindGroupLayout>, groups = {} as Record<Stage, BindGroupResourceCache>;
  for (const stage of TSR_STAGES) {
    layouts[stage] = device.createBindGroupLayout({ label: `layout:tsr-${stage}`, entries: entries[stage] });
    groups[stage] = new BindGroupResourceCache(4);
    s.ctx.pipelines.register(key(stage), 'compute', () => ({
      label: key(stage), layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layouts[stage]] }),
      compute: { module: s.ctx.pipelines.shaderModule(shaders[stage], key(stage)), entryPoint: 'main' },
    }));
  }
  let preparing = false;
  const prepare = () => { if (!preparing) { preparing = true; for (const stage of TSR_STAGES) void s.ctx.pipelines.compile(key(stage)).catch(() => undefined); } };
  const ready = () => TSR_STAGES.every(stage => !!s.ctx.pipelines.get(key(stage)));

  const sampler = device.createSampler({ label: 'tsr:linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const params = device.createBuffer({ label: 'tsr:params', size: TSR_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  const staging = new ArrayBuffer(TSR_PARAMS.size);
  const frameGroup = createFrameBindGroup(s, 'tsr');
  let scatter: GPUBuffer | null = null, scatterTexels = 0;
  let passes: (() => void)[] | null = null;
  let invalidated = true, lastFrame = -2, lastExposure = NaN;

  const run = (c: PassContext, stage: Stage, resources: GPUBindingResource[], size: readonly [number, number]) => {
    const cache = groups[stage], k = cache.begin();
    for (const r of resources) pushBindingKey(k, r);
    const group = cache.get(() => device.createBindGroup({ label: key(stage), layout: layouts[stage], entries: [
      { binding: 0, resource: { buffer: params } }, ...resources.map((resource, i) => ({ binding: i + 1, resource }))] }));
    const ts = c.timestampWrites(`tsr.${stage}`) as GPUComputePassTimestampWrites | undefined;
    const pass = c.encoder.beginComputePass({ label: `tsr.${stage}`, ...(ts ? { timestampWrites: ts } : {}) });
    pass.setPipeline(s.ctx.pipelines.get<GPUComputePipeline>(key(stage))!);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, group);
    pass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
    pass.end();
  };

  const register = () => {
    invalidated = true;
    // Declared with the passes, so the graph reallocates once; it allocates only what a registered pass uses.
    s.graph.declareTexture(T.depth, { format: 'r32float', size: 'internal', usage: work, history: true });
    s.graph.declareTexture(T.motion, { format: 'rgba16float', size: 'internal', usage: work });
    s.graph.declareTexture(T.mask, { format: 'rgba8unorm', size: 'internal', usage: work });
    s.graph.declareTexture(T.history, { format: HDR_FORMAT, size: 'display', usage: work, history: true });
    s.graph.declareTexture(T.locks, { format: 'rgba8unorm', size: 'display', usage: work, history: true });
    s.graph.declareTexture(T.opaque, { format: HDR_FORMAT, size: 'internal', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
    s.graph.declareTexture(T.veil, { format: 'rgba8unorm', size: 'internal', usage: work });
    const copy = (c: PassContext) => {
      const [w, h] = c.resources.size(T.opaque);
      c.encoder.copyTextureToTexture({ texture: c.resources.texture('hdr') }, { texture: c.resources.texture(T.opaque) }, [w, h, 1]);
    };
    passes = [
      s.graph.addPass({ name: 'tsr.backdrop', slot: 'clouds', order: -10, reads: ['hdr'], writes: [T.opaque], run: copy }),
      s.graph.addPass({
        name: 'tsr.veil', slot: 'clouds', order: 10, reads: ['frameUniforms', 'hdr', T.opaque], writes: [T.veil],
        run(c) { run(c, 'veil', [c.resources.view('hdr'), c.resources.view(T.opaque), c.resources.view(T.veil)], c.frame.internal); },
      }),
      s.graph.addPass({ name: 'tsr.opaque', slot: 'transparent', order: -7, reads: ['hdr'], writes: [T.opaque], run: copy }),
      s.graph.addPass({
        name: 'tsr.reconstruct', slot: 'taa', order: 0, reads: ['frameUniforms', 'depth', 'velocity', 'ids'], writes: [T.depth, T.motion],
        run(c) {
          const f = c.frame, r = c.resources, texels = f.internal[0] * f.internal[1];
          if (!scatter || scatterTexels !== texels) {
            s.ctx.deferDestroy(scatter);
            scatter = device.createBuffer({ label: 'tsr:scatter', size: texels * 4, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
            scatterTexels = texels;
          }
          // The history is last frame's only if this resolver drew last frame under this exposure (it is stored exposed).
          // Sizes, tiers and scenes reset through `invalidated`.
          const reset = !!f.snap || invalidated || f.index !== lastFrame + 1 || s.settings.exposure !== lastExposure || !host.enabled();
          lastFrame = f.index; lastExposure = s.settings.exposure; invalidated = false;
          const unit = (v: number) => Math.min(1, Math.max(0, v));
          TSR_PARAMS.pack({
            control: [reset ? 1 : 0, unit(controls.sharpness), Math.max(1, controls.maxAccumulation), Math.max(0, TSR_DEBUG_VIEWS.indexOf(controls.debugView))],
            tune: [Math.max(0, controls.reactiveGain), unit(controls.reactiveBlend), unit(controls.locks), unit(controls.youngSoft)],
            look: [unit(controls.clipCentre), Math.max(0, controls.stillWiden), 0, 0],
          }, staging);
          // Queue writes land before the frame's one submit, so the veil pass encoded earlier reads this block too.
          queue.writeBuffer(params, 0, staging);
          // An empty slot is depth 0: nothing nearer landed there.
          c.encoder.clearBuffer(scatter);
          run(c, 'reconstruct', [r.view('depth'), r.view('velocity'), r.view('ids'), r.view(T.depth), r.view(T.motion), { buffer: scatter }], f.internal);
        },
      }),
      s.graph.addPass({
        name: 'tsr.mask', slot: 'taa', order: 1, reads: ['frameUniforms', T.depth, T.motion, `history:${T.depth}`, 'hdr', T.opaque, T.veil], writes: [T.mask],
        run(c) {
          const r = c.resources;
          run(c, 'mask', [r.view(T.depth), r.view(T.motion), { buffer: scatter! }, r.view(T.mask), r.history(T.depth), r.view('hdr'), r.view(T.opaque), r.view(T.veil)], c.frame.internal);
        },
      }),
      s.graph.addPass({
        name: 'tsr.accumulate', slot: 'taa', order: 2,
        reads: ['frameUniforms', 'hdr', T.motion, T.mask, `history:${T.history}`, `history:${T.locks}`], writes: [T.history, T.locks],
        run(c) {
          const r = c.resources;
          run(c, 'accumulate', [r.view('hdr'), r.view(T.motion), r.view(T.mask), r.history(T.history), sampler, r.view(T.history), r.history(T.locks), r.view(T.locks)], c.frame.display);
        },
      }),
      s.graph.addPass({
        name: 'tsr.sharpen', slot: 'taa', order: 3, reads: ['frameUniforms', T.history, T.motion, T.mask, T.locks], writes: [host.output],
        run(c) {
          const r = c.resources;
          run(c, 'sharpen', [r.view(T.history), r.view(host.output), r.view(T.motion), r.view(T.mask), r.view(T.locks)], c.frame.display);
        },
      }),
    ];
  };
  const unregister = () => {
    for (const remove of passes ?? []) remove();
    passes = null;
    for (const stage of TSR_STAGES) groups[stage].clear();
    s.ctx.deferDestroy(scatter);
    scatter = null; scatterTexels = 0;
  };
  // The graph may only change between frames: 'resize' fires before a frame is encoded and 'frameEnd' after it.
  const sync = () => {
    const wanted = host.wanted();
    if (wanted) prepare();
    const on = wanted && ready();
    if (on && !passes) register(); else if (!on && passes) unregister();
  };
  const disposers = [
    s.events.on('resize', () => { invalidated = true; sync(); }),
    s.events.on('frameEnd', sync),
    s.events.on('tierChanged', () => { invalidated = true; }),
    s.events.on('planetChanged', () => { invalidated = true; }),
  ];
  // Loaded below native, or for a profile saved below native: start building now.
  if (host.wanted() || (s.settings.renderScale || 1) < 1) prepare();
  return {
    active: () => !!passes,
    invalidate: () => { invalidated = true; },
    dispose() {
      for (const off of disposers.splice(0)) off();
      unregister();
      s.ctx.deferDestroy(params);
    },
  };
}
