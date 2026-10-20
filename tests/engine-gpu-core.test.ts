/**
 * GPU core with a fake device: deferred-destroy slack, limit negotiation (Math.min), uniform-ring alignment, slice arena,
 * reserved-binding placeholders and the bind-group cache key, pipeline-cache de-duplication and error mapping, texture
 * pool, VRAM ledger, readback ring bounds and timestamp ring drops.
 */
import { describe, expect, it, vi } from 'vitest';
import { RESERVED_BINDING_LAYOUT, RESERVED_BINDING_NAMES } from '../src/engine/contracts';
import { BindGroupResourceCache, pushBindingKey } from '../src/engine/gpu/bind-group-cache';
import { DeferredDestroyQueue, DESTROY_SLACK_TICKS, negotiateLimits, WebGpuContext, WANTED_LIMITS } from '../src/engine/gpu/context';
import { PipelineCache } from '../src/engine/gpu/pipeline-cache';
import { ReadbackRing } from '../src/engine/gpu/readback';
import { TransientTexturePool } from '../src/engine/gpu/resources';
import { GpuSliceArena } from '../src/engine/gpu/slice-arena';
import { GpuTimings } from '../src/engine/gpu/timings';
import { UNIFORM_ALIGN, UNIFORM_RING_SEGMENT_BYTES, UniformRing } from '../src/engine/gpu/uniform-ring';
import { textureBytes, VramLedger } from '../src/engine/gpu/vram';
import { ReservedBindingRegistry, reservedBindGroupEntries, reservedBindingSlots, reservedLayoutEntries } from '../src/engine/reserved-bindings';
import { link, makeModule } from '../src/engine/wgsl/module';

/** Minimal fake GPUDevice: records what the code under test asks for. */
function fakeDevice(features: string[] = []) {
  let id = 0;
  const log = { buffers: [] as { label?: string; size: number; destroyed: boolean }[], writes: [] as { offset: number; size: number }[], textures: 0, pipelines: 0 };
  const mk = <T extends object>(o: T) => Object.assign(o, { id: id++ });
  const device = {
    features: new Set(features),
    createBuffer(d: GPUBufferDescriptor) {
      const b = mk({ label: d.label, size: d.size, destroyed: false, destroy() { b.destroyed = true; }, mapAsync: () => new Promise<void>(() => undefined) });
      log.buffers.push(b);
      return b as unknown as GPUBuffer;
    },
    createTexture(d: GPUTextureDescriptor) {
      log.textures++;
      const t = mk({ label: d.label, format: d.format, destroyed: false, destroy() { t.destroyed = true; }, createView: () => mk({ view: true }) });
      return t as unknown as GPUTexture;
    },
    createSampler: () => mk({ sampler: true }) as unknown as GPUSampler,
    createQuerySet: (d: GPUQuerySetDescriptor) => mk({ count: d.count, destroy() { /* */ } }) as unknown as GPUQuerySet,
    createShaderModule: (d: GPUShaderModuleDescriptor) => mk({ code: d.code, getCompilationInfo: async () => ({ messages: [] as GPUCompilationMessage[] }) }) as unknown as GPUShaderModule,
    createRenderPipelineAsync: async () => { log.pipelines++; return mk({ pipeline: true }) as unknown as GPURenderPipeline; },
    createComputePipelineAsync: async () => { log.pipelines++; return mk({ pipeline: true }) as unknown as GPUComputePipeline; },
    queue: {
      writeBuffer(_b: GPUBuffer, offset: number, _data: unknown, _o?: number, size?: number) { log.writes.push({ offset, size: size ?? -1 }); },
      writeTexture() { /* */ },
    },
  };
  return { device, log };
}

describe('deferred destroy', () => {
  it('keeps intentional teardown quiet but reports unexpected device loss', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const intentional of [true, false]) {
        let lose!: (info: { reason: string; message: string }) => void;
        const lost = new Promise<{ reason: string; message: string }>(resolve => { lose = resolve; }), notify = vi.fn();
        const ctx = Object.assign(Object.create(WebGpuContext.prototype), {
          device: { lost, addEventListener() {}, destroy: () => lose({ reason: 'destroyed', message: 'Device was destroyed.' }) },
          lostCallbacks: new Set([notify]), lostInfo: null, destroying: false,
          uniforms: { destroy() {} }, destroys: { flush() {} }, canvasContext: { unconfigure() {} }, vram: { report: () => 'VRAM report' },
        });
        ctx.watch();
        if (intentional) ctx.destroy(); else lose({ reason: 'unknown', message: 'Driver reset' });
        await lost; await Promise.resolve();
        expect(notify).toHaveBeenCalledOnce(); expect(warning).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledTimes(intentional ? 0 : 1);
      }
    } finally { warning.mockRestore(); error.mockRestore(); }
  });
  it('destroys only after DESTROY_SLACK_TICKS ticks, idempotently, and reports to the ledger hook', () => {
    const seen: unknown[] = [];
    const q = new DeferredDestroyQueue(DESTROY_SLACK_TICKS, r => seen.push(r));
    let destroyed = 0;
    const res = { destroy: () => { destroyed++; } };
    q.push(res); q.push(res); q.push(null);
    expect(q.size).toBe(1);
    for (let i = 0; i < DESTROY_SLACK_TICKS - 1; i++) { q.tick(); expect(destroyed).toBe(0); }
    q.tick();
    expect(destroyed).toBe(1);
    expect(seen).toEqual([res]);
    expect(q.tickIndex).toBe(DESTROY_SLACK_TICKS);
    const late = { destroy: () => { destroyed++; } };
    q.push(late);
    q.flush();
    expect(destroyed).toBe(2);
  });
});

describe('limit negotiation', () => {
  it('clamps every wanted limit to the adapter with Math.min and skips unknown keys', () => {
    const adapter = { maxBufferSize: 256 << 20, maxStorageBuffersPerShaderStage: 8, maxSampledTexturesPerShaderStage: 48, maxColorAttachmentBytesPerSample: 128 };
    const got = negotiateLimits(adapter);
    expect(got.maxBufferSize).toBe(256 << 20);                           // adapter is smaller than want
    expect(got.maxStorageBuffersPerShaderStage).toBe(8);
    expect(got.maxColorAttachmentBytesPerSample).toBe(64);               // want is smaller than adapter
    expect(got.maxSampledTexturesPerShaderStage).toBe(Math.min(48, WANTED_LIMITS.maxSampledTexturesPerShaderStage));
    expect('maxComputeWorkgroupStorageSize' in got).toBe(false);
    for (const [k, v] of Object.entries(got)) expect(v).toBeLessThanOrEqual((adapter as Record<string, number>)[k]);
  });
});

describe('uniform ring', () => {
  it('releases and untracks every uniform segment before the context destroys its device', () => {
    const { device, log } = fakeDevice();
    const ledger = new VramLedger();
    ledger.install(device as never);
    const ring = new UniformRing(device as never);
    const queue = new DeferredDestroyQueue(DESTROY_SLACK_TICKS, resource => ledger.untrack(resource));
    let deviceDestroyed = false;
    expect(ledger.total).toBe(3 * UNIFORM_RING_SEGMENT_BYTES);
    WebGpuContext.prototype.destroy.call({
      uniforms: ring, destroys: queue, deferDestroy: (buffer: GPUBuffer) => queue.push(buffer),
      canvasContext: { unconfigure() { /* no canvas attached */ } },
      device: { destroy() { expect(log.buffers.every(buffer => buffer.destroyed)).toBe(true); deviceDestroyed = true; } },
    } as never);
    expect(deviceDestroyed).toBe(true);
    expect(ledger.total).toBe(0);
    expect(ring.buffers).toHaveLength(0);
  });

  it('allocates 256 B aligned ranges, rotates three 1 MiB segments and flushes once per frame', () => {
    const { device, log } = fakeDevice();
    const ring = new UniformRing(device as never);
    expect(ring.buffers.length).toBe(3);
    expect(log.buffers.every(b => b.size === UNIFORM_RING_SEGMENT_BYTES)).toBe(true);
    const a = ring.alloc(4), b = ring.alloc(300), c = ring.write(new Float32Array([1, 2, 3]));
    expect([a.offset, b.offset, c.offset]).toEqual([0, 256, 768]);
    expect([a.offset, b.offset, c.offset].every(o => o % UNIFORM_ALIGN === 0)).toBe(true);
    expect(Array.from(c.f32)).toEqual([1, 2, 3]);
    ring.flush();
    expect(log.writes.length).toBe(1);
    expect(log.writes[0].size).toBe(780);
    const first = ring.segmentIndex;
    const buffers = new Set<GPUBuffer>();
    for (let f = 0; f < 3; f++) { ring.beginFrame(); buffers.add(ring.alloc(16).buffer); }
    expect(buffers.size).toBe(3);
    expect(ring.segmentIndex).toBe(first);
    ring.beginFrame();
    expect(ring.alloc(16).offset).toBe(0);
    expect(() => ring.alloc(UNIFORM_RING_SEGMENT_BYTES)).toThrow(/full/);
  });
});

describe('slice arena (engine clock)', () => {
  it('serves 256 B aligned slices and defers reuse on the engine tick', () => {
    const { device } = fakeDevice();
    let tick = 0;
    const destroyed: GPUBuffer[] = [];
    const arena = new GpuSliceArena(device as never, { label: 'mesh:vertex', usage: 0, chunkBytes: 1 << 16, tick: () => tick, destroyBuffer: b => destroyed.push(b), zeroOnAlloc: false });
    const s = arena.alloc(1000)!;
    expect(s.offset % 256).toBe(0);
    arena.free(s);
    expect(arena.alloc(1000)!.offset).not.toBe(s.offset);
    tick += 3;
    arena.reclaim();
    expect(arena.stats().pendingFrees).toBe(0);
  });
});

describe('reserved bindings', () => {
  it('returns 1×1 placeholders until provided, and the bind-group cache key includes placeholders', () => {
    const { device } = fakeDevice();
    const reg = new ReservedBindingRegistry(device as never);
    for (const name of RESERVED_BINDING_NAMES) {
      const r = reg.get(name);
      expect(Object.keys(r).sort()).toEqual(RESERVED_BINDING_LAYOUT[name].map(s => s.key).sort());
    }
    const cache = new BindGroupResourceCache<{ n: number }>();
    let built = 0;
    const group = () => {
      const k = cache.begin();
      for (const name of RESERVED_BINDING_NAMES) for (const res of Object.values(reg.get(name))) pushBindingKey(k, res);
      return cache.get(() => ({ n: ++built }));
    };
    const g1 = group(); const g2 = group();
    expect(g1).toBe(g2);
    expect(built).toBe(1);
    // placeholder → real swap must miss (a stale placeholder binding was a Pinionfall bug)
    const realAo = { real: 'ao-view' } as unknown as GPUTextureView;
    reg.provide('ao', { ao: realAo });
    const g3 = group();
    expect(g3).not.toBe(g1);
    expect(built).toBe(2);
    expect(reg.get('ao').ao).toBe(realAo);
    expect(reg.isProvided('ao')).toBe(true);
  });

  it('never lets a placeholder overwrite a real resource and validates the key set', () => {
    const { device } = fakeDevice();
    const reg = new ReservedBindingRegistry(device as never);
    const placeholder = reg.placeholder('ao');
    reg.provide('ao', placeholder); // placeholder over placeholder: no-op
    expect(reg.isProvided('ao')).toBe(false);
    reg.provide('ao', { ao: { real: 1 } as unknown as GPUTextureView });
    expect(() => reg.provide('ao', placeholder)).toThrow(/placeholder would overwrite/);
    expect(() => reg.provide('sunShadows', { static: {} as GPUTextureView })).toThrow(/expected keys/);
    // real → real replacement is allowed (e.g. resize re-creation)
    const newer = { real: 2 } as unknown as GPUTextureView;
    reg.provide('ao', { ao: newer });
    expect(reg.get('ao').ao).toBe(newer);
  });

  it('lays out every slot with consecutive bindings and matching bind-group entries', () => {
    const { device } = fakeDevice();
    const reg = new ReservedBindingRegistry(device as never);
    const slots = reservedBindingSlots();
    const layout = reservedLayoutEntries(4);
    const entries = reservedBindGroupEntries(reg);
    expect(layout.map(e => e.binding)).toEqual(slots.map((_, i) => i));
    expect(entries.map(e => e.binding)).toEqual(layout.map(e => e.binding));
    const lights = slots.find(s => s.name === 'lights')!;
    expect(layout[lights.binding].buffer?.type).toBe('read-only-storage');
    const shadows = slots.find(s => s.name === 'sunShadows' && s.slot.key === 'static')!;
    expect(layout[shadows.binding].texture?.sampleType).toBe('depth');
  });
});

describe('pipeline cache', () => {
  it('de-duplicates in-flight and finished requests, records compile ms, and maps compiler errors to module:line', async () => {
    const { device, log } = fakeDevice();
    const cache = new PipelineCache(device as never);
    const build = () => ({ layout: 'auto' as const, compute: { module: {} as GPUShaderModule, entryPoint: 'main' } });
    const p1 = cache.compute('a', build), p2 = cache.compute('a', build);
    expect(p1).toBe(p2);
    await p1;
    await cache.compute('a', build);
    expect(log.pipelines).toBe(1);
    expect(cache.get('a')).toBeDefined();
    expect(cache.stats().pipelines).toBe(1);
    expect(cache.stats().totalMs).toBeGreaterThanOrEqual(0);

    // A failing pipeline: the module's error on output line N maps back to (module, local line).
    const linked = link(makeModule('dep', 'const A: u32 = 1u;\nconst B: u32 = 2u;'), makeModule('main-mod', 'fn f() {\n  broken\n}', [makeModule('dep', 'const A: u32 = 1u;\nconst B: u32 = 2u;')]));
    const errorLine = linked.lineMap.find(e => e.module === 'main-mod')!.start + 1;
    const failing = {
      ...device,
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [{ type: 'error', lineNum: errorLine, linePos: 3, message: 'unresolved identifier' }] }) }),
      createComputePipelineAsync: async () => { throw new Error('GPUPipelineError'); },
    };
    const logged: string[] = [];
    const bad = new PipelineCache(failing as never, { log: m => logged.push(m) });
    const module = bad.shaderModule(linked, 'test');
    await expect(bad.compute('bad', () => ({ layout: 'auto', compute: { module, entryPoint: 'main' } }))).rejects.toThrow();
    expect(bad.errors).toEqual([{ key: 'bad', module: 'test/main-mod', line: 2, column: 3, message: 'unresolved identifier' }]);
    expect(logged[0]).toContain('test/main-mod:2');
  });

  it('keeps registered pipelines in the warm-up list until compiled', async () => {
    const { device, log } = fakeDevice();
    const cache = new PipelineCache(device as never);
    cache.register('x', 'render', () => ({ layout: 'auto', vertex: { module: {} as GPUShaderModule } }));
    cache.register('y', 'compute', () => ({ layout: 'auto', compute: { module: {} as GPUShaderModule } }));
    expect(log.pipelines).toBe(0);
    await cache.warmup();
    expect(log.pipelines).toBe(2);
    expect(cache.keys()).toEqual(['x', 'y']);
    await expect(cache.compile('nope')).rejects.toThrow(/not registered/);
  });
});

describe('texture pool and VRAM ledger', () => {
  it('reuses textures by descriptor and trims idle ones through deferDestroy', () => {
    const { device, log } = fakeDevice();
    let tick = 0;
    const destroyed: unknown[] = [];
    const pool = new TransientTexturePool({ device: device as never, queue: device.queue as never, deferDestroy: r => destroyed.push(r), get tickIndex() { return tick; } }, 'graph', 2);
    const req = { format: 'rgba8unorm' as GPUTextureFormat, width: 64, height: 32, usage: 4 };
    const a = pool.acquire(req);
    pool.release(a);
    expect(pool.acquire(req)).toBe(a);
    expect(log.textures).toBe(1);
    pool.acquire({ ...req, width: 128 });
    expect(log.textures).toBe(2);
    pool.release(a);
    tick += 3;
    pool.trim();
    expect(destroyed).toEqual([a]);
  });

  it('tracks bytes by label category and untracks on destroy', () => {
    const ledger = new VramLedger();
    const t = {}, b = {};
    ledger.record(t, 'gbuffer:albedoAo', textureBytes({ size: [1920, 1080], format: 'rgba8unorm' }));
    ledger.record(b, 'mesh:vertex', 1024);
    expect(ledger.byCategory()).toEqual({ gbuffer: 1920 * 1080 * 4, mesh: 1024 });
    ledger.untrack(t);
    expect(ledger.total).toBe(1024);
    expect(ledger.peak).toBe(1920 * 1080 * 4 + 1024);
    expect(textureBytes({ size: [256, 256], format: 'rgba16float', mipLevelCount: 2 })).toBe(256 * 256 * 8 + 128 * 128 * 8);
  });

  it('untracks a resource destroyed directly, outside the deferred queue', () => {
    const { device, log } = fakeDevice();
    const ledger = new VramLedger();
    ledger.install(device as never);
    const a = (device as unknown as GPUDevice).createBuffer({ label: 'terrain:page', size: 256, usage: 0 });
    (device as unknown as GPUDevice).createBuffer({ label: 'terrain:page', size: 512, usage: 0 });
    expect(ledger.total).toBe(768);
    a.destroy();
    expect(ledger.total).toBe(512);
    expect(log.buffers[0].destroyed).toBe(true);
    a.destroy();
    expect(ledger.byCategory()).toEqual({ terrain: 512 });
  });
});

describe('readback ring and timestamps', () => {
  it('refuses copies when every slot is busy instead of growing', async () => {
    const { device } = fakeDevice();
    const ring = new ReadbackRing(device as never, { slots: 2 });
    const encoder = { copyBufferToBuffer() { /* */ } } as unknown as GPUCommandEncoder;
    const src = device.createBuffer({ size: 64, usage: 0 });
    const a = ring.copy(encoder, src, 0, 24), b = ring.copy(encoder, src, 0, 24);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(ring.copy(encoder, src, 0, 24)).toBeNull();
    expect(ring.refused).toBe(1);
    ring.cancelUnsubmitted();
    expect(ring.busy).toBe(0);
    await expect(a).rejects.toThrow(/abandoned/);
    await expect(b).rejects.toThrow(/abandoned/);
  });

  it('is a no-op without timestamp-query and drops a frame when the 3-slot ring is full', () => {
    const off = new GpuTimings(fakeDevice().device as never);
    expect(off.enabled).toBe(false);
    expect(off.getWrites('gbuffer')).toBeUndefined();
    const { device } = fakeDevice(['timestamp-query']);
    const t = new GpuTimings(device as never);
    expect(t.enabled).toBe(true);
    const w = t.getWrites('gbuffer')!;
    expect([w.beginningOfPassWriteIndex, w.endOfPassWriteIndex]).toEqual([0, 1]);
    expect(t.getWrites('lighting')!.beginningOfPassWriteIndex).toBe(2);
    expect(t.getWrites('gbuffer')).toBeUndefined(); // one sample per name per frame
    const encoder = { resolveQuerySet() { /* */ }, copyBufferToBuffer() { /* */ } } as unknown as GPUCommandEncoder;
    for (let f = 0; f < 4; f++) { t.getWrites('gbuffer'); t.resolve(encoder); t.kickReadback(); }
    expect(t.dropped).toBe(1); // the fake mapAsync never resolves: slots stay busy
    expect(t.getAll().map(p => p.name)).toEqual(['gbuffer', 'lighting']);
  });
});
