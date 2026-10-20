/**
 * Compute mip generation for rgba8unorm and rgba16float textures, 2D and 2D arrays (write-only storage of both formats is
 * core WebGPU). Box filter over the 2×2 source footprint (clamped at odd edges), one dispatch per level, all encoded into
 * the caller's encoder. The texture needs TEXTURE_BINDING | STORAGE_BINDING usage.
 */
import { link, makeModule } from '../wgsl/module';
import { ShaderStage } from './flags';
import type { LinkedWgsl, PipelineCacheApi } from '../contracts';

export type MipFormat = 'rgba8unorm' | 'rgba16float';
export type MipDimension = '2d' | '2d-array';

export function mipGenShader(format: MipFormat, dimension: MipDimension): LinkedWgsl {
  const array = dimension === '2d-array';
  const src = array ? 'texture_2d_array<f32>' : 'texture_2d<f32>';
  const dst = array ? `texture_storage_2d_array<${format}, write>` : `texture_storage_2d<${format}, write>`;
  const load = array ? 'textureLoad(src, p, i32(gid.z), 0)' : 'textureLoad(src, p, 0)';
  const store = array ? 'textureStore(dst, vec2i(gid.xy), i32(gid.z), c * 0.25)' : 'textureStore(dst, vec2i(gid.xy), c * 0.25)';
  return link(makeModule(`mip-gen:${format}:${dimension}`, /* wgsl */ `
@group(0) @binding(0) var src: ${src};
@group(0) @binding(1) var dst: ${dst};

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dst_size = textureDimensions(dst).xy;
  if (gid.x >= dst_size.x || gid.y >= dst_size.y) { return; }
  let limit = vec2i(textureDimensions(src).xy) - vec2i(1);
  let base = vec2i(gid.xy) * 2;
  var c = vec4f(0.0);
  for (var dy = 0; dy < 2; dy++) {
    for (var dx = 0; dx < 2; dx++) {
      let p = min(base + vec2i(dx, dy), limit);
      c += ${load};
    }
  }
  ${store};
}
`));
}

type MipDevice = Pick<GPUDevice, 'createBindGroupLayout' | 'createPipelineLayout' | 'createBindGroup'>;

const PER_DEVICE = new WeakMap<object, MipGenerator>();

export class MipGenerator {
  private readonly layouts = new Map<string, GPUBindGroupLayout>();

  /** The device's generator (pipelines are registered once per device, so share one instance). */
  static for(ctx: { device: MipDevice; pipelines: PipelineCacheApi }): MipGenerator {
    let g = PER_DEVICE.get(ctx.device);
    if (!g) { g = new MipGenerator(ctx.device, ctx.pipelines); PER_DEVICE.set(ctx.device, g); }
    return g;
  }

  private constructor(private readonly device: MipDevice, private readonly cache: PipelineCacheApi) {
    for (const format of ['rgba8unorm', 'rgba16float'] as const) {
      for (const dimension of ['2d', '2d-array'] as const) {
        const key = this.key(format, dimension);
        const layout = device.createBindGroupLayout({
          label: `layout:${key}`,
          entries: [
            { binding: 0, visibility: ShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: dimension } },
            { binding: 1, visibility: ShaderStage.COMPUTE, storageTexture: { access: 'write-only', format, viewDimension: dimension } },
          ],
        });
        this.layouts.set(key, layout);
        cache.register(key, 'compute', () => ({
          label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          compute: { module: cache.shaderModule(mipGenShader(format, dimension), key), entryPoint: 'main' },
        }));
      }
    }
  }

  private key(format: MipFormat, dimension: MipDimension): string { return `mip-gen:${format}:${dimension}`; }

  /** Compile the four variants. */
  async ready(): Promise<void> {
    await Promise.all(['rgba8unorm', 'rgba16float'].flatMap(f => ['2d', '2d-array'].map(d => {
      const key = this.key(f as MipFormat, d as MipDimension);
      return this.cache.compile(key);
    })));
  }

  /** Encode every level from 1 to mipLevelCount − 1. Returns false (encodes nothing) while the pipeline compiles. */
  generate(encoder: GPUCommandEncoder, texture: GPUTexture, options: { dimension?: MipDimension; timestampWrites?: GPUComputePassTimestampWrites } = {}): boolean {
    const format = texture.format as MipFormat;
    if (format !== 'rgba8unorm' && format !== 'rgba16float') throw new Error(`mip-gen: unsupported format ${texture.format}`);
    const dimension = options.dimension ?? (texture.depthOrArrayLayers > 1 ? '2d-array' : '2d');
    const key = this.key(format, dimension);
    const pipeline = this.cache.get<GPUComputePipeline>(key);
    if (!pipeline) { void this.cache.compile(key).catch(() => undefined); return false; }
    const layout = this.layouts.get(key)!;
    const pass = encoder.beginComputePass({ label: key, ...(options.timestampWrites ? { timestampWrites: options.timestampWrites } : {}) });
    pass.setPipeline(pipeline);
    const layers = dimension === '2d-array' ? texture.depthOrArrayLayers : 1;
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const w = Math.max(1, texture.width >> level), h = Math.max(1, texture.height >> level);
      const group = this.device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: texture.createView({ dimension, baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: texture.createView({ dimension, baseMipLevel: level, mipLevelCount: 1 }) },
        ],
      });
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8), layers);
    }
    pass.end();
    return true;
  }
}

export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}
