/// <reference types="@webgpu/types" />
/** PageHook plumbing (plan §5.1): hooks encode into the transaction's encoder, their status words ride on the single
 * readback (layout: every page's status block followed by its hooks' words), finish() receives exactly their words,
 * and attachments show/hide inside the commit block and are disposed with their page. The GPU part runs the real
 * ResidentGpuPages batch against a recording fake device (copies and clears execute; compute passes do not). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { StructuralPhysics } from '../src/game/structural-physics';
import type { PageAttachment, PageHook, PageHookContext } from '../src/gpu/terrain/page-hooks';
import type { GpuPage, ResidentPageBackend, ResidentPageBatch } from '../src/gpu/terrain/page-batch';
import type { PageBuffers, PageDrawHandle, PageDrawInfo, TerrainRenderHost } from '../src/gpu/terrain/render-host';
import type { SliceMetrics } from '../src/gpu/terrain/contracts';
import { emptyMetrics } from '../src/gpu/terrain/service';
import { FakeTerrainHost } from './helpers/geometry-gate';

const USAGE = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
class FakeBuffer {
  data: ArrayBuffer; destroyed = false; mapped = false;
  constructor(readonly device: FakeDevice, readonly size: number, readonly usage: number, readonly label: string) { this.data = new ArrayBuffer(size); }
  async mapAsync() { this.device.maps++; this.mapped = true; }
  getMappedRange() { return this.data; }
  unmap() { this.mapped = false; }
  destroy() { this.destroyed = true; }
}
type Op = () => void;
class FakeDevice {
  submits = 0; maps = 0; created: FakeBuffer[] = []; corruptTotals = 0;
  readonly limits = { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65535 };
  readonly features = new Set<string>();
  readonly queue = {
    writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBufferView) => { new Uint8Array(buffer.data, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); },
    submit: (commands: { ops: Op[] }[]) => { this.submits++; for (const command of commands) for (const op of command.ops) op(); },
  };
  createBuffer(desc: { size: number; usage: number; label?: string; mappedAtCreation?: boolean }) {
    const buffer = new FakeBuffer(this, desc.size, desc.usage, desc.label ?? ''); this.created.push(buffer); return buffer;
  }
  createShaderModule() { return { getCompilationInfo: async () => ({ messages: [] }) }; }
  createBindGroupLayout() { return {}; }
  createPipelineLayout() { return {}; }
  async createComputePipelineAsync() { return { getBindGroupLayout: () => ({}) }; }
  createBindGroup(desc: GPUBindGroupDescriptor) {
    // Only a scan level binds five entries. A one-level scan's total is its block sum: emulate a correct scan (3 indices
    // per triangle) where the level binds its sums.
    const entries = [...desc.entries];
    if (entries.length === 5) {
      const input = entries[0].resource as GPUBufferBinding, sums = entries[2].resource as GPUBufferBinding;
      new Uint32Array((sums.buffer as unknown as FakeBuffer).data, sums.offset, 1)[0] = input.size! / 4 * 3 + (this.corruptTotals > 0 ? (this.corruptTotals--, 1) : 0);
    }
    return {};
  }
  createCommandEncoder() {
    const ops: Op[] = [];
    return {
      ops,
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      clearBuffer: (buffer: FakeBuffer, offset = 0, size?: number) => ops.push(() => new Uint8Array(buffer.data, offset, size ?? buffer.size - offset).fill(0)),
      copyBufferToBuffer: (source: FakeBuffer, sourceOffset: number, target: FakeBuffer, targetOffset: number, size: number) =>
        ops.push(() => new Uint8Array(target.data, targetOffset, size).set(new Uint8Array(source.data, sourceOffset, size))),
      resolveQuerySet() {},
      finish: () => ({ ops }),
    };
  }
}
interface Recorded { contexts: PageHookContext[]; finished: Uint32Array[]; shown: number; hidden: number; disposed: number; order: string[] }
/** Writes [tag, page index] into its status words from a GPU copy encoded into the page's encoder. */
function recordingHook(device: GPUDevice, record: Recorded, tag = 0xabc): PageHook {
  return {
    name: 'test-hook', statusWords: 2,
    encode: ctx => {
      const index = record.contexts.length; record.contexts.push(ctx);
      const source = device.createBuffer({ size: 8, usage: USAGE.COPY_SRC | USAGE.COPY_DST, label: 'hook source' });
      device.queue.writeBuffer(source, 0, new Uint32Array([tag, index]));
      ctx.encoder.copyBufferToBuffer(source, 0, ctx.status.buffer, ctx.status.offset, ctx.status.words * 4);
      return { finish: status => { record.finished.push(status.slice()); const attachment: PageAttachment = {
        onShow: () => { record.shown++; record.order.push(`show ${index}`); }, onHide: () => { record.hidden++; record.order.push(`hide ${index}`); }, dispose: () => { record.disposed++; } };
        return attachment; } };
    },
  };
}

describe('page hook plumbing', () => {
  beforeEach(() => {
    vi.stubGlobal('GPUBufferUsage', USAGE); vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 }); vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('lays status out as page blocks followed by their hooks, 4-byte aligned', async () => {
    const { statusLayout, PAGE_STATUS_WORDS } = await import('../src/gpu/terrain/gpu-pages');
    const layout = statusLayout(10, true, [{ statusWords: 2 }, { statusWords: 0 }, { statusWords: 3 }], 2);
    expect(layout.timestamps).toBe(160);
    expect(layout.pages[0]).toEqual({ status: 176, hooks: [176 + PAGE_STATUS_WORDS * 4, 176 + 24 + 8, 176 + 24 + 8] });
    expect(layout.pages[1].status).toBe(176 + 24 + 20);
    expect(layout.bytes).toBe(176 + 2 * (24 + 20));
    expect(() => statusLayout(0, false, [{ statusWords: -1 }], 1)).toThrow(/hook status/);
  });

  it('accepts a page whose zero-area f32 fan triangles were omitted by the scan', async () => {
    const { pageAccepted } = await import('../src/gpu/terrain/gpu-pages');
    const words = new Uint32Array(6);
    words[5] = 6;
    expect(pageAccepted(words, 0, 9)).toBe(true);
    words[5] = 10;
    expect(pageAccepted(words, 0, 9)).toBe(false);
    words[5] = 4;
    expect(pageAccepted(words, 0, 9)).toBe(false);
    words[5] = 6;
    words[4] = 1;
    expect(pageAccepted(words, 0, 9)).toBe(false);
  });

  it('encodes construction, pages and hooks into one submit with one readback, then finishes the hooks', async () => {
    const { ResidentGpuPages } = await import('../src/gpu/terrain/gpu-pages');
    const device = new FakeDevice(), gpuDevice = device as unknown as GPUDevice, record: Recorded = { contexts: [], finished: [], shown: 0, hidden: 0, disposed: 0, order: [] };
    const created: { buffers: PageBuffers; info: PageDrawInfo }[] = [];
    const host: TerrainRenderHost = { device: gpuDevice, pageHooks: [recordingHook(gpuDevice, record)],
      createPage: (buffers, info) => { created.push({ buffers, info }); return { id: created.length, setPose() {}, dispose() {} }; }, commit() {} };
    const fixture = structuralFixture(), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
    const pages = [...arrangement.lattice.bricks.keys()].map(brick => arrangement.rebuild(brick, 1)).filter(page => page.regions.length).slice(0, 3);
    const gpu = await ResidentGpuPages.create(gpuDevice, 4096), metrics: SliceMetrics = emptyMetrics();
    const batch = gpu.batch(host, metrics);
    batch.construct(arrangement, []);
    for (const page of pages) batch.page(page.brick, page.regions.slice(0, 2).flatMap(region => region.faces.map(face => ({ region, face }))), { brick: page.brick, origin: [0, 0, 0] }, arrangement);
    expect(device.submits).toBe(0);
    const result = await batch.submit();
    expect(device.submits).toBe(1); expect(device.maps).toBe(1); expect(metrics.readbacks).toBe(1); expect(metrics.submissions).toBe(1);
    expect(record.contexts).toHaveLength(pages.length);
    expect(new Set(record.contexts.map(c => c.encoder)).size).toBe(1);
    record.contexts.forEach(ctx => { expect(ctx.isBody).toBe(false); expect(ctx.triangleCount).toBeGreaterThan(0); expect(ctx.status.words).toBe(2); expect(ctx.info.brick).toBeDefined(); });
    expect(record.finished.map(words => [...words])).toEqual(pages.map((_, i) => [0xabc, i]));
    expect(created).toHaveLength(pages.length);
    expect([...result.keys()]).toEqual(pages.map(page => page.brick));
    for (const page of result.values()) expect(page.attachments).toHaveLength(1);
    // Every temporary is released; only the pages' output buffers (now the host's) stay alive.
    const outputs = new Set(created.flatMap(({ buffers }) => [buffers.position, buffers.normal, buffers.surface, buffers.index, buffers.indirect]));
    expect(device.created.filter(b => !b.destroyed && !outputs.has(b as unknown as GPUBuffer) && !/canonical|recipes/.test(b.label) && b.label !== 'hook source')).toEqual([]);
    for (const page of result.values()) page.dispose();
    expect(record.disposed).toBe(pages.length);
  });

  it('refuses the whole transaction when one page fails, disposing every hook attachment and creating no page', async () => {
    const { ResidentGpuPages } = await import('../src/gpu/terrain/gpu-pages');
    const device = new FakeDevice(), gpuDevice = device as unknown as GPUDevice, record: Recorded = { contexts: [], finished: [], shown: 0, hidden: 0, disposed: 0, order: [] };
    let created = 0;
    const host: TerrainRenderHost = { device: gpuDevice, pageHooks: [recordingHook(gpuDevice, record)], createPage: () => { created++; return { id: created, setPose() {}, dispose() {} }; }, commit() {} };
    const fixture = structuralFixture(), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
    const pages = [...arrangement.lattice.bricks.keys()].map(brick => arrangement.rebuild(brick, 1)).filter(page => page.regions.length).slice(0, 2);
    const gpu = await ResidentGpuPages.create(gpuDevice, 4096), batch = gpu.batch(host, emptyMetrics());
    for (const [i, page] of pages.entries()) { if (i === 1) device.corruptTotals = 1; batch.page(page.brick, page.regions[0].faces.map(face => ({ region: page.regions[0], face })), { brick: page.brick, origin: [0, 0, 0] }, arrangement); }
    await expect(batch.submit()).rejects.toMatchObject({ code: 'validation' });
    expect(created).toBe(0); expect(record.finished).toHaveLength(2); expect(record.disposed).toBe(2); expect(device.maps).toBe(1);
  });

  it('shows and hides attachments inside the commit block and disposes them with their pages', async () => {
    const record: Recorded = { contexts: [], finished: [], shown: 0, hidden: 0, disposed: 0, order: [] };
    const hookDevice = new FakeDevice() as unknown as GPUDevice;
    class HookHost extends FakeTerrainHost { override readonly pageHooks: readonly PageHook[] = [recordingHook(hookDevice, record)]; }
    const host = new HookHost(), fixture = structuralFixture();
    // A headless batch backend that runs host hooks like ResidentGpuPages does (no device work).
    const backend: ResidentPageBackend = {
      constructRegions: async () => {}, page: async () => undefined, invalidateUpload() {}, dispose() {},
      batch: (target: TerrainRenderHost): ResidentPageBatch => {
        const queued: [string, Parameters<ResidentPageBatch['page']>[1], Parameters<ResidentPageBatch['page']>[2]][] = [];
        return { construct() {}, page: (key, boundary, where) => { queued.push([key, boundary, where]); }, cancel() {},
          submit: async () => {
            const out = new Map<string, GpuPage>();
            for (const [key, boundary, where] of queued) {
              if (!boundary.length) continue;
              const buffer = {} as GPUBuffer, buffers: PageBuffers = { position: buffer, normal: buffer, surface: buffer, index: buffer, indirect: buffer, vertexCount: 3, indexCount: 3 };
              const info: PageDrawInfo = { ...where, bounds: { min: [...where.origin], max: [...where.origin] } };
              const attachments = target.pageHooks.map(hook => hook.encode({ encoder: { copyBufferToBuffer() {} } as unknown as GPUCommandEncoder, buffers, info, triangleCount: boundary.length, isBody: where.bodyId !== undefined,
                status: { buffer, offset: 0, words: hook.statusWords } })!.finish(new Uint32Array(hook.statusWords))!);
              const handle: PageDrawHandle = target.createPage(buffers, info);
              out.set(key, { handle, bytes: 1, attachments, dispose: () => { attachments.forEach(a => a.dispose()); handle.dispose(); } });
            }
            return out;
          } };
      },
    };
    const physics = await StructuralPhysics.create(fixture.planetCenter), terrain = new ResidentTerrain(fixture, backend, physics, host);
    try {
      await terrain.initialize();
      expect(record.shown).toBe(host.visible.length); expect(record.hidden).toBe(0);
      const shownBefore = record.shown, visibleBefore = host.visible.length;
      await terrain.cut(fixture.cuts[0]);
      const change = host.commits.at(-1)!;
      expect(record.hidden).toBe(change.hide.length);
      expect(record.shown - shownBefore).toBe(change.show.length);
      expect(record.disposed).toBe(change.hide.length);
      expect(host.visible.length).toBe(visibleBefore - change.hide.length + change.show.length);
    } finally { terrain.dispose(); }
    expect(record.hidden).toBe(record.shown);
    expect(record.disposed).toBe(record.contexts.length);
  }, 60000);
});
