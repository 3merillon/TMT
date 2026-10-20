// Ported from Pinionfall src/gpu/vram-tracker.ts (MIT, same owner)
/**
 * Live GPU-memory ledger. WebGPU exposes no memory budget, so this watermark is the only signal we have.
 *
 * Adaptation for TMT (plan §13): no module globals and no prototype patching. The ledger belongs to one GpuContext; it
 * wraps that device's createBuffer/createTexture (own properties, so the patch sticks per device) and is told about
 * destruction by `ctx.deferDestroy`, which every engine resource goes through (N6). Allocations are grouped by
 * category = the label up to the first ':' (e.g. 'gbuffer:albedoAo' → 'gbuffer'), so telemetry can report VRAM by area.
 */

/** Exact logical allocation sizes, including compressed block tails and 3D mip depth (Pinionfall texture-memory.ts). */
const FORMAT_BYTES: Record<string, number> = {
  r8unorm: 1, r8uint: 1, r8sint: 1, r8snorm: 1, stencil8: 1,
  rg8unorm: 2, rg8uint: 2, rg8sint: 2, rg8snorm: 2, r16uint: 2, r16sint: 2, r16float: 2, depth16unorm: 2,
  rgba8unorm: 4, 'rgba8unorm-srgb': 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
  rg16float: 4, rg16uint: 4, rg16sint: 4, r32float: 4, r32uint: 4, r32sint: 4, depth32float: 4, depth24plus: 4,
  'depth24plus-stencil8': 4, 'depth32float-stencil8': 5, rgb10a2unorm: 4, rg11b10ufloat: 4, rgb9e5ufloat: 4,
  rgba16float: 8, rgba16uint: 8, rgba16sint: 8, rg32float: 8, rg32uint: 8, rg32sint: 8, rgba32float: 16, rgba32uint: 16, rgba32sint: 16,
};

export function textureBytes(d: Pick<GPUTextureDescriptor, 'size' | 'format' | 'mipLevelCount' | 'sampleCount' | 'dimension'>): number {
  const s = d.size as number[] | { width: number; height?: number; depthOrArrayLayers?: number };
  let w = Array.isArray(s) ? s[0] : s.width;
  let h = Array.isArray(s) ? s[1] ?? 1 : s.height ?? 1;
  let depth = Array.isArray(s) ? s[2] ?? 1 : s.depthOrArrayLayers ?? 1;
  const compressed = d.format.startsWith('bc');
  const blockBytes = /^bc[14]-/.test(d.format) ? 8 : 16;
  let total = 0;
  for (let mip = 0; mip < (d.mipLevelCount ?? 1); mip++) {
    total += (compressed ? Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes : w * h * (FORMAT_BYTES[d.format] ?? 4)) * depth * (d.sampleCount ?? 1);
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    if (d.dimension === '3d') depth = Math.max(1, depth >> 1);
  }
  return total;
}

export function vramCategory(label: string | undefined): string {
  if (!label) return '(unlabelled)';
  const i = label.indexOf(':');
  return i > 0 ? label.slice(0, i) : label;
}

interface Tracked { category: string; bytes: number }

export class VramLedger {
  private readonly live = new WeakMap<object, Tracked>();
  private readonly categories = new Map<string, { count: number; bytes: number }>();
  private liveTotal = 0;
  private peakTotal = 0;

  record(obj: object, label: string | undefined, bytes: number): void {
    if (this.live.has(obj)) return;
    const category = vramCategory(label);
    this.live.set(obj, { category, bytes });
    this.liveTotal += bytes;
    if (this.liveTotal > this.peakTotal) this.peakTotal = this.liveTotal;
    const c = this.categories.get(category) ?? { count: 0, bytes: 0 };
    c.count++; c.bytes += bytes;
    this.categories.set(category, c);
  }

  untrack(obj: object): void {
    const e = this.live.get(obj);
    if (!e) return;
    this.live.delete(obj);
    this.liveTotal -= e.bytes;
    const c = this.categories.get(e.category);
    if (c) { c.count--; c.bytes -= e.bytes; if (c.count <= 0) this.categories.delete(e.category); }
  }

  get total(): number { return this.liveTotal; }
  get peak(): number { return this.peakTotal; }

  byCategory(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of [...this.categories.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) out[k] = v.bytes;
    return out;
  }

  /** Wrap `device.createBuffer/createTexture` so every allocation is recorded, and each resource's own `destroy` so a
   * direct destroy (outside `ctx.deferDestroy`, as the resident terrain does) leaves the ledger too. Idempotent per device. */
  install(device: GPUDevice): void {
    const tagged = device as GPUDevice & { __tmtVram?: VramLedger };
    if (tagged.__tmtVram) return;
    tagged.__tmtVram = this;
    const createBuffer = device.createBuffer.bind(device);
    const createTexture = device.createTexture.bind(device);
    const watch = (r: { destroy(): void }) => {
      const destroy = r.destroy.bind(r);
      Object.defineProperty(r, 'destroy', { configurable: true, writable: true, value: () => { this.untrack(r); destroy(); } });
    };
    Object.defineProperty(device, 'createBuffer', {
      configurable: true, writable: true,
      value: (desc: GPUBufferDescriptor): GPUBuffer => {
        const b = createBuffer(desc);
        try { this.record(b, desc.label, desc.size); watch(b); } catch { /* never break allocation */ }
        return b;
      },
    });
    Object.defineProperty(device, 'createTexture', {
      configurable: true, writable: true,
      value: (desc: GPUTextureDescriptor): GPUTexture => {
        const t = createTexture(desc);
        try { this.record(t, desc.label, textureBytes(desc)); watch(t); } catch { /* never break allocation */ }
        return t;
      },
    });
  }

  /** Console dump (largest categories first), e.g. on device loss. */
  report(tag = ''): string {
    const mb = (b: number) => (b / 1048576).toFixed(1) + 'MB';
    const rows = [...this.categories.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    return [`[vram] ${tag} live=${mb(this.liveTotal)} peak=${mb(this.peakTotal)}`,
      ...rows.slice(0, 40).map(([k, g]) => `[vram]   ${mb(g.bytes).padStart(9)} ×${String(g.count).padStart(4)}  ${k}`)].join('\n');
  }
}
