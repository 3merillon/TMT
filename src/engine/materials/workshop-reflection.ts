/** A captured room reflection probe. Reuses the reserved cube binding, never samples a planetary sky. */
import type { EngineServices } from '../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../gpu/flags';
import { mipLevelCount } from '../gpu/mip-gen';
import { SKY_ATLAS, skyLightShaders } from '../passes/lighting/sky-light';
import { link, makeModule } from '../wgsl/module';
import { fetchWorkshopFile, type WorkshopAssetFetch } from './workshop-textures';

export const workshopReflectionDecodeWgsl = makeModule('workshop-reflection-decode', /* wgsl */ `
@group(0) @binding(0) var rgbm: texture_2d_array<f32>;
@group(0) @binding(1) var decoded: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(rgbm))) { return; }
  let value = textureLoad(rgbm, id.xy, id.z, 0);
  textureStore(decoded, id.xy, id.z, vec4f(value.rgb * (value.a * 32.0), 1.0));
}
`);

const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;

/** Downloads and decodes the six faces (+X, -X, +Y, -Y, +Z, -Z) in parallel, without a GPU device. */
export async function decodeWorkshopReflection(options: { signal?: AbortSignal; fetch?: WorkshopAssetFetch; faces?: readonly string[] } = {}): Promise<ImageBitmap[]> {
  const faces = options.faces ?? FACES.map(face => `reflection-${face}.webp`), load = options.fetch ?? fetchWorkshopFile();
  if (faces.length !== 6) throw new Error('Workshop reflection needs six faces.');
  const decoded = await Promise.allSettled(faces.map(async file => createImageBitmap(await load(file, options.signal), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })));
  const failure = decoded.find(entry => entry.status === 'rejected');
  if (failure) { for (const entry of decoded) if (entry.status === 'fulfilled') entry.value.close(); throw failure.reason; }
  return decoded.map(entry => (entry as PromiseFulfilledResult<ImageBitmap>).value);
}

/** RGBM range32 inputs retain linear radiance; all filtering happens after decode to half-float. Decoded faces are always released. */
export async function loadWorkshopReflection(services: EngineServices,
  options: { signal?: AbortSignal; fetch?: WorkshopAssetFetch; faces?: readonly string[]; images?: ImageBitmap[] } = {}): Promise<{ dispose(): void }> {
  const { ctx, bindings, scene } = services, { device, queue } = ctx;
  const interior = scene.get('interior');
  if (!interior) { for (const image of options.images ?? []) image.close(); throw new Error('Workshop reflection requires an interior scene.'); }
  const owned: (GPUTexture | GPUBuffer)[] = [], temporary: (GPUTexture | GPUBuffer)[] = [];
  let images: ImageBitmap[] = options.images ?? [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true; interior.reflection = undefined;
    for (const resource of owned.splice(0)) ctx.deferDestroy(resource);
  };
  try {
    if (!options.images) images = await decodeWorkshopReflection(options);
    const size = images[0].width, mips = mipLevelCount(size, size);
    if (size > device.limits.maxTextureDimension2D || images.some(image => image.width !== size || image.height !== size)) throw new Error('Workshop reflection needs six matching square faces.');
    options.signal?.throwIfAborted();
    const input = device.createTexture({ label: 'workshop:reflection-rgbm', size: [size, size, 6], format: 'rgba8unorm', usage: TextureUsage.COPY_DST | TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT }); temporary.push(input);
    const cube = device.createTexture({ label: 'workshop:reflection-hdr', size: [size, size, 6], format: 'rgba16float', mipLevelCount: mips, usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING }); owned.push(cube);
    const atlas = device.createTexture({ label: 'workshop:reflection-dfg', size: [SKY_ATLAS.width, SKY_ATLAS.height], format: 'rgba16float', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING }); owned.push(atlas);
    for (let face = 0; face < images.length; face++) queue.copyExternalImageToTexture({ source: images[face], flipY: false }, { texture: input, origin: [0, 0, face], premultipliedAlpha: false }, [size, size]);
    const C = ShaderStage.COMPUTE;
    const decodeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: C, texture: { viewDimension: '2d-array' } },
      { binding: 1, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
    ] });
    const prefilterLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: C, texture: { viewDimension: 'cube' } },
      { binding: 1, visibility: C, sampler: { type: 'filtering' } },
      { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
      { binding: 3, visibility: C, buffer: { type: 'uniform' } },
    ] });
    const dfgLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } }] });
    const sourceShaders = skyLightShaders();
    const compile = (key: string, layout: GPUBindGroupLayout, shader: ReturnType<typeof link>) => ctx.pipelines.compute(key, () => ({
      label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module: ctx.pipelines.shaderModule(shader, key), entryPoint: 'main' },
    }));
    const decodePipeline = await compile('workshop:reflection-decode', decodeLayout, link(workshopReflectionDecodeWgsl));
    const prefilterPipeline = await compile('workshop:reflection-prefilter', prefilterLayout, sourceShaders.prefilter);
    const dfgPipeline = await compile('workshop:reflection-dfg', dfgLayout, sourceShaders.dfg);
    options.signal?.throwIfAborted();
    const encoder = device.createCommandEncoder({ label: 'workshop:reflection-bake' });
    const run = (pipeline: GPUComputePipeline, group: GPUBindGroup, dimension: number, layers = 6) => {
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(dimension / 8), Math.ceil(dimension / 8), layers); pass.end();
    };
    const mipView = (level: number) => cube.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1 });
    run(decodePipeline, device.createBindGroup({ layout: decodeLayout, entries: [{ binding: 0, resource: input.createView({ dimension: '2d-array' }) }, { binding: 1, resource: mipView(0) }] }), size);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const source = cube.createView({ dimension: 'cube', baseMipLevel: 0, mipLevelCount: 1 });
    for (let mip = 1; mip < mips; mip++) {
      const dimension = Math.max(1, size >> mip);
      const params = device.createBuffer({ label: 'workshop:reflection-prefilter-params', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }); temporary.push(params);
      queue.writeBuffer(params, 0, new Float32Array([mip / (mips - 1), dimension, size, 0]));
      run(prefilterPipeline, device.createBindGroup({ layout: prefilterLayout, entries: [{ binding: 0, resource: source }, { binding: 1, resource: sampler }, { binding: 2, resource: mipView(mip) }, { binding: 3, resource: { buffer: params } }] }), dimension);
    }
    run(dfgPipeline, device.createBindGroup({ layout: dfgLayout, entries: [{ binding: 0, resource: atlas.createView() }] }), SKY_ATLAS.dfg, 1);
    queue.submit([encoder.finish()]);
    options.signal?.throwIfAborted();
    // The interior never calls planetary sky functions; keep their unused uniform placeholder zero.
    bindings.provide('skyLight', { ...bindings.get('skyLight'), cube: cube.createView({ dimension: 'cube' }), dfg: atlas.createView() });
    interior.reflection = { position: [0, 1.7, 0], min: [-7, -0.8, -8.9], max: [7, 7.5, 8.8], mips, intensity: 0.4 };
    return { dispose };
  } catch (error) { dispose(); throw error; }
  finally { for (const image of images) image.close(); for (const resource of temporary) ctx.deferDestroy(resource); }
}
