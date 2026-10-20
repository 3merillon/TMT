/**
 * Labelled resource factory + desc-keyed transient texture pool.
 *
 * Labels are `<category>:<name>` so the VRAM ledger groups by area. Every destroy goes through ctx.deferDestroy (N6).
 */
import type { GpuContext } from '../contracts';
import { BufferUsage } from './flags';

export interface TextureRequest {
  format: GPUTextureFormat; width: number; height: number;
  usage: GPUTextureUsageFlags; mipLevelCount?: number; depthOrArrayLayers?: number; dimension?: GPUTextureDimension;
}

export function textureKey(r: TextureRequest): string {
  return `${r.format}|${r.width}x${r.height}x${r.depthOrArrayLayers ?? 1}|${r.usage}|${r.mipLevelCount ?? 1}|${r.dimension ?? '2d'}`;
}

type FactoryContext = Pick<GpuContext, 'device' | 'queue' | 'deferDestroy'> & { readonly tickIndex: number };

export class ResourceFactory {
  private readonly samplers = new Map<string, GPUSampler>();
  constructor(private readonly ctx: FactoryContext, private readonly category: string) {}

  buffer(name: string, size: number, usage: GPUBufferUsageFlags, data?: ArrayBufferView): GPUBuffer {
    const padded = Math.max(16, Math.ceil(size / 4) * 4);
    const buffer = this.ctx.device.createBuffer({ label: `${this.category}:${name}`, size: padded, usage: usage | (data ? BufferUsage.COPY_DST : 0) });
    if (data) this.ctx.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    return buffer;
  }

  texture(name: string, r: TextureRequest): GPUTexture {
    return this.ctx.device.createTexture({
      label: `${this.category}:${name}`, format: r.format, usage: r.usage, dimension: r.dimension ?? '2d',
      size: { width: r.width, height: r.height, depthOrArrayLayers: r.depthOrArrayLayers ?? 1 }, mipLevelCount: r.mipLevelCount ?? 1,
    });
  }

  /** Cached samplers by descriptor. */
  sampler(desc: GPUSamplerDescriptor = {}): GPUSampler {
    const key = JSON.stringify(desc);
    let s = this.samplers.get(key);
    if (!s) { s = this.ctx.device.createSampler({ label: `${this.category}:sampler`, ...desc }); this.samplers.set(key, s); }
    return s;
  }

  destroy(r: GPUBuffer | GPUTexture | null | undefined): void { this.ctx.deferDestroy(r); }
}

/**
 * Textures keyed by their full descriptor. `acquire` reuses a released texture of the same key; `trim` destroys
 * textures that stayed unused for `maxIdleTicks` ticks (e.g. every size class after a resize).
 */
export class TransientTexturePool {
  private readonly free = new Map<string, { texture: GPUTexture; releasedAt: number }[]>();
  private readonly live = new Map<GPUTexture, string>();
  created = 0;

  constructor(private readonly ctx: FactoryContext, private readonly label = 'transient', private readonly maxIdleTicks = 30) {}

  acquire(r: TextureRequest, name = 'tex'): GPUTexture {
    const key = textureKey(r);
    const list = this.free.get(key);
    const hit = list?.pop();
    if (hit) { this.live.set(hit.texture, key); return hit.texture; }
    const texture = this.ctx.device.createTexture({
      label: `${this.label}:${name}`, format: r.format, usage: r.usage, dimension: r.dimension ?? '2d',
      size: { width: r.width, height: r.height, depthOrArrayLayers: r.depthOrArrayLayers ?? 1 }, mipLevelCount: r.mipLevelCount ?? 1,
    });
    this.created++;
    this.live.set(texture, key);
    return texture;
  }

  release(texture: GPUTexture): void {
    const key = this.live.get(texture);
    if (key === undefined) return;
    this.live.delete(texture);
    const list = this.free.get(key) ?? [];
    list.push({ texture, releasedAt: this.ctx.tickIndex });
    this.free.set(key, list);
  }

  trim(force = false): void {
    const now = this.ctx.tickIndex;
    for (const [key, list] of this.free) {
      const keep = list.filter(e => {
        const expired = force || now - e.releasedAt > this.maxIdleTicks;
        if (expired) this.ctx.deferDestroy(e.texture);
        return !expired;
      });
      if (keep.length) this.free.set(key, keep); else this.free.delete(key);
    }
  }

  get freeCount(): number { let n = 0; for (const l of this.free.values()) n += l.length; return n; }
  get liveCount(): number { return this.live.size; }

  destroyAll(): void {
    this.trim(true);
    for (const t of this.live.keys()) this.ctx.deferDestroy(t);
    this.live.clear();
  }
}
