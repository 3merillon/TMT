// Ported from Pinionfall src/gpu/webgpu-context.ts (MIT, same owner)
/**
 * GpuContext: device, canvas, capabilities, device loss and deferred destruction.
 *
 * Adapted per plan §13: a class passed around (no module globals), `Math.min(adapter, want)` limit negotiation (Pinionfall
 * documents two `Math.max` bugs that asked for more than the adapter offers and failed requestDevice), no cross-frame
 * pipelining (COPY_DST swapchain dropped), no screen targets (the frame graph owns them), `alphaMode: 'opaque'`.
 *
 * Deferred destruction: destroying a resource still referenced by a not-yet-submitted or in-flight command buffer drops
 * the frame ("Destroyed texture used in a submit"). `deferDestroy` queues it and `tick()` (once per frame, after submit)
 * frees it DESTROY_SLACK_TICKS frames later.
 */
import type { GpuCaps, GpuContext, SharedLayouts } from '../contracts';
import { ALL_STAGES, ShaderStage } from './flags';
import { PipelineCache } from './pipeline-cache';
import { UniformRing } from './uniform-ring';
import { VramLedger } from './vram';

export const DESTROY_SLACK_TICKS = 3;

type Destroyable = { destroy(): void };

/** The deferred-destroy clock and queue (pure; unit-tested with fakes). */
export class DeferredDestroyQueue {
  private pending: { res: Destroyable; tick: number }[] = [];
  private clock = 0;
  constructor(private readonly slack = DESTROY_SLACK_TICKS, private readonly onDestroy?: (r: Destroyable) => void) {}

  get tickIndex(): number { return this.clock; }
  get size(): number { return this.pending.length; }

  push(res: Destroyable | null | undefined): void {
    if (!res) return;
    for (const p of this.pending) if (p.res === res) return; // already queued: idempotent
    this.pending.push({ res, tick: this.clock });
  }

  /** Advance the clock and destroy everything queued at least `slack` ticks ago. */
  tick(): void {
    this.clock++;
    const cutoff = this.clock - this.slack;
    let w = 0;
    for (let r = 0; r < this.pending.length; r++) {
      const e = this.pending[r];
      if (e.tick <= cutoff) this.destroyNow(e.res);
      else this.pending[w++] = e;
    }
    this.pending.length = w;
  }

  /** Destroy everything now (teardown / device lost). */
  flush(): void {
    for (const e of this.pending) this.destroyNow(e.res);
    this.pending.length = 0;
  }

  private destroyNow(res: Destroyable): void {
    try { this.onDestroy?.(res); } catch { /* ledger only */ }
    try { res.destroy(); } catch { /* already gone / device lost */ }
  }
}

/** Features requested when the adapter has them. */
export const OPTIONAL_FEATURES: readonly GPUFeatureName[] = [
  'timestamp-query', 'indirect-first-instance', 'float32-filterable', 'rg11b10ufloat-renderable', 'shader-f16', 'subgroups',
  'depth32float-stencil8',
  // r16float / r8unorm storage (the planet SDF, visibility volume and masks); tier2 adds read-write access.
  'texture-formats-tier1', 'texture-formats-tier2',
];

/** What the engine would like. Every request is clamped to the adapter with Math.min — never Math.max. */
export const WANTED_LIMITS: Readonly<Record<string, number>> = {
  maxBufferSize: 1 << 30,
  maxStorageBufferBindingSize: 1 << 30,
  maxStorageBuffersPerShaderStage: 16,
  maxSampledTexturesPerShaderStage: 48,
  maxSamplersPerShaderStage: 16,
  maxStorageTexturesPerShaderStage: 8,
  maxUniformBuffersPerShaderStage: 12,
  maxColorAttachmentBytesPerSample: 64,
  maxComputeWorkgroupStorageSize: 32768,
  maxComputeInvocationsPerWorkgroup: 256,
  maxTextureDimension2D: 8192,
};

/** Clamp every wanted limit to the adapter's (Math.min). Unknown keys (older browsers) are skipped. */
export function negotiateLimits(adapterLimits: Record<string, number>, want: Readonly<Record<string, number>> = WANTED_LIMITS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(want)) {
    const max = adapterLimits[key];
    if (typeof max !== 'number') continue;
    out[key] = Math.min(max, value);
  }
  return out;
}

export interface ContextCreateOptions { powerPreference?: GPUPowerPreference; dev?: boolean }

export class WebGpuContext implements GpuContext {
  readonly queue: GPUQueue;
  readonly caps: GpuCaps;
  readonly layouts: SharedLayouts;
  readonly vram: VramLedger;
  readonly pipelines: PipelineCache;
  readonly uniforms: UniformRing;
  /** Uncaptured WebGPU errors seen so far (validation + OOM). */
  errorCount = 0;
  private readonly destroys: DeferredDestroyQueue;
  private readonly lostCallbacks = new Set<(info: { reason: string; message: string }) => void>();
  private lostInfo: { reason: string; message: string } | null = null;
  private destroying = false;

  private constructor(
    readonly device: GPUDevice,
    readonly canvas: HTMLCanvasElement,
    readonly canvasContext: GPUCanvasContext,
    readonly format: GPUTextureFormat,
    adapter: GPUAdapter,
    readonly dev: boolean,
    vram = new VramLedger(),
  ) {
    this.vram = vram;
    this.queue = device.queue;
    this.pipelines = new PipelineCache(device, { dev });
    this.uniforms = new UniformRing(device);
    this.destroys = new DeferredDestroyQueue(DESTROY_SLACK_TICKS, r => this.vram.untrack(r));
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    this.caps = {
      timestamps: device.features.has('timestamp-query'),
      indirectFirstInstance: device.features.has('indirect-first-instance'),
      float32Filterable: device.features.has('float32-filterable'),
      rg11b10Renderable: device.features.has('rg11b10ufloat-renderable'),
      shaderF16: device.features.has('shader-f16'),
      subgroups: device.features.has('subgroups'),
      textureFormatsTier1: device.features.has('texture-formats-tier1'),
      // The engine asks for at most 1 GiB, so "low memory" means the adapter could not even give that (iOS-class caps).
      lowMemory: device.limits.maxBufferSize < (1 << 30),
      fallbackAdapter: !!((adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter ?? (info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter),
      vendor: info?.vendor ?? '', architecture: info?.architecture ?? '',
    };
    this.layouts = {
      frame: device.createBindGroupLayout({
        label: 'layout:frame',
        entries: [{ binding: 0, visibility: ALL_STAGES, buffer: { type: 'uniform', minBindingSize: 512 } }],
      }),
      shadowView: device.createBindGroupLayout({
        label: 'layout:shadow-view',
        entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 96 } }],
      }),
    };
  }

  static async create(canvas: HTMLCanvasElement, options: ContextCreateOptions = {}): Promise<WebGpuContext> {
    if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('WebGPU is not supported in this browser.');
    // Chromium on Windows ignores this hint and emits a warning on every context creation.
    // Leave GPU selection to the OS there; retain the preference on platforms that support it.
    const chromiumWindows = /Windows/.test(navigator.userAgent) && /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
    const adapter = await navigator.gpu.requestAdapter(chromiumWindows ? {} : { powerPreference: options.powerPreference ?? 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const requiredFeatures = OPTIONAL_FEATURES.filter(f => adapter.features.has(f));
    const adapterLimits: Record<string, number> = {};
    for (const key in adapter.limits) {
      const v = (adapter.limits as unknown as Record<string, unknown>)[key];
      if (typeof v === 'number') adapterLimits[key] = v;
    }
    const device = await adapter.requestDevice({ label: 'tmt-engine', requiredFeatures, requiredLimits: negotiateLimits(adapterLimits) });
    const canvasContext = canvas.getContext('webgpu');
    if (!canvasContext) throw new Error('canvas.getContext("webgpu") returned null');
    const format = navigator.gpu.getPreferredCanvasFormat();
    canvasContext.configure({ device, format, alphaMode: 'opaque', usage: 0x10 /* RENDER_ATTACHMENT */ });
    // Install the ledger before anything is allocated (layouts, uniform ring, placeholders).
    const vram = new VramLedger();
    vram.install(device);
    const ctx = new WebGpuContext(device, canvas, canvasContext, format, adapter, !!options.dev, vram);
    ctx.watch();
    return ctx;
  }

  private watch(): void {
    this.device.addEventListener('uncapturederror', (event: Event) => {
      if (this.lostInfo) return; // after loss, stay quiet
      this.errorCount++;
      const message = (event as GPUUncapturedErrorEvent).error?.message ?? String(event);
      if (this.errorCount <= 20 || this.errorCount % 100 === 0) console.error(`[engine] WebGPU error #${this.errorCount}: ${message}`);
    });
    void this.device.lost.then(info => {
      if (this.lostInfo) return;
      this.lostInfo = { reason: info.reason ?? 'unknown', message: info.message ?? '' };
      // Only our own teardown is expected. Unexpected destruction still reports a real failure.
      if (!(this.destroying && this.lostInfo.reason === 'destroyed')) console.error(`[engine] device lost (${this.lostInfo.reason}): ${this.lostInfo.message}\n${this.vram.report('@device-lost')}`);
      const callbacks = [...this.lostCallbacks];
      this.lostCallbacks.clear();
      for (const cb of callbacks) { try { cb(this.lostInfo); } catch (error) { console.warn('[engine] onLost callback threw', error); } }
    });
  }

  get lost(): boolean { return this.lostInfo !== null; }
  get tickIndex(): number { return this.destroys.tickIndex; }

  deferDestroy(r: GPUBuffer | GPUTexture | GPUQuerySet | null | undefined): void {
    if (!r) return;
    if (this.lostInfo) { this.vram.untrack(r); try { r.destroy(); } catch { /* lost */ } return; }
    this.destroys.push(r);
  }

  tick(): void { this.destroys.tick(); }

  onLost(cb: (info: { reason: string; message: string }) => void): () => void {
    if (this.lostInfo) { const info = this.lostInfo; queueMicrotask(() => cb(info)); return () => undefined; }
    this.lostCallbacks.add(cb);
    return () => this.lostCallbacks.delete(cb);
  }

  /** Teardown: free everything queued and destroy the device. */
  destroy(): void {
    if (this.destroying) return;
    this.destroying = true;
    this.uniforms.destroy(buffer => this.deferDestroy(buffer));
    this.destroys.flush();
    try { this.canvasContext.unconfigure(); } catch { /* ignore */ }
    this.device.destroy();
  }
}
