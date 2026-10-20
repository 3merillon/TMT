/** Original authored UV textures for interior props; separate from terrain and gameplay materials. */
import type { EngineServices } from '../contracts';
import { ShaderStage, TextureUsage } from '../gpu/flags';
import { mipLevelCount } from '../gpu/mip-gen';
import { link, makeModule } from '../wgsl/module';

/** orm preserves glTF metallicRoughness bytes: G roughness, B metallic, R unused (no source occlusion map). */
export interface WorkshopTextureSpec { baseColor: string; normal: string; orm: string; normalEncoding?: 'xy-gray' }
/** Compact seamless maps: clay, concrete, limestone, fixture paint, fixture brass. */
export const WORKSHOP_SURFACE_TEXTURES = ['architecture-brick.webp', 'architecture-concrete.webp', 'architecture-vault.webp', 'fixture-paint.webp', 'fixture-brass.webp'] as const;
export interface WorkshopTextures {
  albedoView: GPUTextureView; normalView: GPUTextureView; ormView: GPUTextureView; gaugeView?: GPUTextureView; surfaceView?: GPUTextureView; sampler: GPUSampler;
  readonly layers: number; readonly width: number; readonly height: number; readonly bytes: number;
  dispose(): void;
}
declare module '../contracts' { interface SceneFacets { workshopTextures: WorkshopTextures } }

export const workshopMipWgsl = makeModule('workshop-texture-mip', /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;
struct MipVertex { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs_mip(@builtin(vertex_index) index: u32) -> MipVertex {
  let uv = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: MipVertex; out.uv = uv; out.position = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0); return out;
}
@fragment fn fs_mip(in: MipVertex) -> @location(0) vec4f {
  return textureSampleLevel(source, linear_sampler, in.uv, 0.0);
}
// Grayscale strips avoid lossy WebP chroma subsampling of tangent X/Y. Alpha retains Z's sign.
@fragment fn fs_normal_unpack(in: MipVertex) -> @location(0) vec4f {
  let px = vec2i(in.position.xy);
  let width = i32(textureDimensions(source).x / 2u);
  let left = textureLoad(source, px, 0);
  let right = textureLoad(source, px + vec2i(width, 0), 0);
  let xy = vec2f(left.r, right.r) * 2.0 - 1.0;
  let sign_z = select(1.0, -1.0, left.a < 254.5 / 255.0);
  let normal = normalize(vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))) * sign_z));
  return vec4f(normal * 0.5 + 0.5, 1.0);
}
`);

/** Fetches one packaged file; the default reads it from `baseUrl`. Callers may serve already-downloaded files. */
export type WorkshopAssetFetch = (file: string, signal?: AbortSignal) => Promise<Blob>;
export const fetchWorkshopFile = (baseUrl = '/workshop/'): WorkshopAssetFetch => async (file, signal) => {
  if (!/^[a-z0-9._-]+\.(png|jpe?g|webp|json|wmesh|bin)$/i.test(file)) throw new Error('Invalid workshop asset path.');
  const response = await fetch(baseUrl + file, { signal });
  if (!response.ok) throw new Error(`Workshop asset ${file} failed (${response.status}).`);
  return response.blob();
};
export interface WorkshopTextureImages { layers: ImageBitmap[][]; gauge?: ImageBitmap; surfaces: ImageBitmap[]; close(): void }

/** Downloads and decodes every map without a GPU device, so it can overlap engine start-up. */
export async function decodeWorkshopTextureImages(specs: readonly WorkshopTextureSpec[],
  options: { signal?: AbortSignal; fetch?: WorkshopAssetFetch; gaugeFace?: string; surfaces?: readonly string[] } = {}): Promise<WorkshopTextureImages> {
  if (!specs.length || specs.length > 32) throw new Error('Workshop textures require 1–32 authored material layers.');
  const load = options.fetch ?? fetchWorkshopFile();
  const result: WorkshopTextureImages = { layers: [], surfaces: [], close() {
    for (const layer of this.layers) for (const image of layer) image?.close(); this.gauge?.close(); for (const image of this.surfaces) image?.close();
  } };
  const decode = async (file: string) => {
    if (!/^[a-z0-9._-]+\.(png|jpe?g|webp)$/i.test(file)) throw new Error('Invalid workshop texture path.');
    return createImageBitmap(await load(file, options.signal), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  };
  // Six bounded decode workers overlap transfer/decoding without opening every source at once.
  // All workers settle before failure cleanup; late decodes can never publish into a disposed scene.
  const jobs: { file: string; save(image: ImageBitmap): void }[] = [];
  for (const spec of specs) {
    const layer: ImageBitmap[] = []; result.layers.push(layer);
    [spec.baseColor, spec.normal, spec.orm].forEach((file, channel) => jobs.push({ file, save: image => { layer[channel] = image; } }));
  }
  if (options.gaugeFace) jobs.push({ file: options.gaugeFace, save: image => { result.gauge = image; } });
  if (options.surfaces) {
    if (options.surfaces.length !== 5) throw new Error('Workshop surfaces require five ordered material maps.');
    options.surfaces.forEach((file, index) => jobs.push({ file, save: image => { result.surfaces[index] = image; } }));
  }
  let nextJob = 0, decodeFailed = false;
  const worker = async () => {
    while (nextJob < jobs.length && !decodeFailed) {
      const job = jobs[nextJob++];
      try { job.save(await decode(job.file)); options.signal?.throwIfAborted(); }
      catch (error) { decodeFailed = true; throw error; }
    }
  };
  const decoded = await Promise.allSettled(Array.from({ length: Math.min(6, jobs.length) }, worker));
  const failure = decoded.find(entry => entry.status === 'rejected');
  if (failure) { result.close(); throw failure.reason; }
  return result;
}

/** Uploads authored maps with correct sRGB albedo and linear normal/ORM mip filtering. Decoded images are always released. */
export async function loadWorkshopTextures(services: EngineServices, specs: readonly WorkshopTextureSpec[],
  options: { signal?: AbortSignal; fetch?: WorkshopAssetFetch; gaugeFace?: string; surfaces?: readonly string[]; images?: WorkshopTextureImages } = {}): Promise<WorkshopTextures> {
  if (!specs.length || specs.length > 32) throw new Error('Workshop textures require 1–32 authored material layers.');
  const textures: GPUTexture[] = [], temporary: GPUTexture[] = [], { ctx, scene } = services, { device, queue } = ctx;
  let decodedImages = options.images;
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; for (const texture of textures) ctx.deferDestroy(texture); };
  try {
    decodedImages ??= await decodeWorkshopTextureImages(specs, options);
    const { layers: images, gauge, surfaces } = decodedImages;
    if (images.length !== specs.length) throw new Error('Decoded workshop textures do not match their material layers.');
    const { width, height } = images[0][0];
    const mapWidth = (layer: number, channel: number) => images[layer][channel].width / (channel === 1 && specs[layer].normalEncoding === 'xy-gray' ? 2 : 1);
    const dimensions = images[0].map((image, channel) => ({ width: mapWidth(0, channel), height: image.height, levels: mipLevelCount(mapWidth(0, channel), image.height) }));
    // MetallicRoughness ships at a smaller resolution than colour/normal.
    // Each channel owns its own array and retains its packaged dimensions without runtime resampling.
    if (dimensions.some(({ width: w, height: h }, channel) => w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D
      || !Number.isInteger(w) || images.some((layer, index) => mapWidth(index, channel) !== w || layer[channel].height !== h))) throw new Error('Workshop texture layers in each channel must have identical supported dimensions.');
    if (gauge && (gauge.width > device.limits.maxTextureDimension2D || gauge.height > device.limits.maxTextureDimension2D)) throw new Error('Gauge texture dimensions exceed device limits.');
    if (surfaces.length && surfaces.some(image => image.width !== surfaces[0].width || image.height !== surfaces[0].height
      || image.width > device.limits.maxTextureDimension2D || image.height > device.limits.maxTextureDimension2D)) throw new Error('Workshop surface maps require identical supported dimensions.');
    options.signal?.throwIfAborted();
    const sampler = device.createSampler({ label: 'workshop:authored-textures', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, addressModeU: 'repeat', addressModeV: 'repeat' });
    const layout = device.createBindGroupLayout({ label: 'workshop:mip-layout', entries: [
      { binding: 0, visibility: ShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
      { binding: 1, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const pipelineFor = async (format: GPUTextureFormat, entryPoint = 'fs_mip') => ctx.pipelines.render(`workshop:mip:${format}:${entryPoint}`, () => {
      const module = ctx.pipelines.shaderModule(link(workshopMipWgsl), 'workshop:mip');
      return { label: `workshop:mip:${format}`, layout: pipelineLayout, vertex: { module, entryPoint: 'vs_mip' },
        fragment: { module, entryPoint, targets: [{ format }] }, primitive: { topology: 'triangle-list' } };
    });
    const channels = dimensions.map((d, channel) => ({ ...d, format: (channel === 0 ? 'rgba8unorm-srgb' : 'rgba8unorm') as GPUTextureFormat, maps: images.map(layer => layer[channel]) }));
    if (gauge) channels.push({ width: gauge.width, height: gauge.height, levels: mipLevelCount(gauge.width, gauge.height), format: 'rgba8unorm-srgb', maps: [gauge] });
    const surfaceChannel = channels.length;
    if (surfaces.length) channels.push({ width: surfaces[0].width, height: surfaces[0].height, levels: mipLevelCount(surfaces[0].width, surfaces[0].height), format: 'rgba8unorm-srgb', maps: surfaces });
    for (const [channel, d] of channels.entries()) {
      options.signal?.throwIfAborted();
      const { width: channelWidth, height: channelHeight, levels, format, maps } = d;
      const texture = device.createTexture({ label: `workshop:authored-${channel}`, size: [channelWidth, channelHeight, maps.length], format, mipLevelCount: levels,
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.RENDER_ATTACHMENT });
      textures.push(texture);
      const packedNormal = channel === 1 && specs.some(spec => spec.normalEncoding === 'xy-gray');
      const unpackPipeline = packedNormal ? await pipelineFor(format, 'fs_normal_unpack') : undefined;
      options.signal?.throwIfAborted();
      let unpackSource: GPUTexture | undefined;
      if (packedNormal) {
        if (channelWidth * 2 > device.limits.maxTextureDimension2D) throw new Error('Packed workshop normals exceed device upload limits.');
        unpackSource = device.createTexture({ label: 'workshop:normal-packed-upload', size: [channelWidth * 2, channelHeight], format: 'rgba8unorm',
          usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST | TextureUsage.RENDER_ATTACHMENT });
        temporary.push(unpackSource);
      }
      for (let layer = 0; layer < maps.length; layer++) {
        if (packedNormal && specs[layer].normalEncoding === 'xy-gray') {
          queue.copyExternalImageToTexture({ source: maps[layer], flipY: false }, { texture: unpackSource!, premultipliedAlpha: false }, [channelWidth * 2, channelHeight]);
          const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: unpackSource!.createView() }, { binding: 1, resource: sampler }] });
          const encoder = device.createCommandEncoder({ label: 'workshop:normal-unpack' });
          const destination = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: 0, mipLevelCount: 1 });
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: destination, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
          pass.setPipeline(unpackPipeline!); pass.setBindGroup(0, group); pass.draw(3); pass.end(); queue.submit([encoder.finish()]);
        } else queue.copyExternalImageToTexture({ source: maps[layer], flipY: false }, { texture, origin: [0, 0, layer], premultipliedAlpha: false }, [channelWidth, channelHeight]);
        maps[layer].close();
      }
      const pipeline = await pipelineFor(format), encoder = device.createCommandEncoder({ label: `workshop:authored-mips-${channel}` });
      options.signal?.throwIfAborted();
      for (let layer = 0; layer < maps.length; layer++) for (let level = 1; level < levels; level++) {
        const source = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level - 1, mipLevelCount: 1 });
        const destination = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
        const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: source }, { binding: 1, resource: sampler }] });
        const pass = encoder.beginRenderPass({ label: `workshop:mip-${channel}-${layer}-${level}`, colorAttachments: [{ view: destination, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3); pass.end();
      }
      queue.submit([encoder.finish()]);
    }
    options.signal?.throwIfAborted();
    const result: WorkshopTextures = { albedoView: textures[0].createView({ dimension: '2d-array' }), normalView: textures[1].createView({ dimension: '2d-array' }),
      ormView: textures[2].createView({ dimension: '2d-array' }), gaugeView: gauge ? textures[3].createView({ dimension: '2d' }) : undefined,
      surfaceView: surfaces.length ? textures[surfaceChannel].createView({ dimension: '2d-array' }) : undefined, sampler, layers: specs.length, width, height,
      bytes: channels.reduce((total, d) => total + d.maps.length * 4 * Array.from({ length: d.levels }, (_, level) => Math.max(1, d.width >> level) * Math.max(1, d.height >> level)).reduce((sum, n) => sum + n, 0), 0), dispose };
    scene.provide('workshopTextures', result); return result;
  } catch (error) { dispose(); throw error; }
  finally { for (const texture of temporary) ctx.deferDestroy(texture); decodedImages?.close(); }
}
