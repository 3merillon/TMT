/// <reference types="@webgpu/types" />
/** A transaction's page scratch (perf pass): page inputs, configs, counts, status words and the scans' offsets and block
 * sums are slices of a few chunk buffers, the inputs and configs reach the GPU as one write per chunk just before the
 * transaction's single submit and land at the slices the passes bind, every chunk dies with its transaction (a cancelled
 * one uploads nothing), and one timestamp query set serves every transaction. Runs the real ResidentGpuPages batch
 * against a recording fake device. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { emptyMetrics } from '../src/gpu/terrain/service';
import type { TerrainRenderHost } from '../src/gpu/terrain/render-host';

const USAGE = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
const ARENA = /^terrain:(page-inputs|page-configs|triangle-counts|page-status|scan-status|scan-levels-even|scan-levels-odd)$/, WRITTEN = /^terrain:(page-inputs|page-configs)$/;
/** The per-page and per-level scratch buffers a transaction used to create. */
const SCRATCH = /^(exclusive offsets|block sums|scan refusal flags|recipe level|page config|volume triangle references|region source references|polygon vertex references|surface references|triangle counts|page acceptance)$/;
type Op = () => void;
class FakeBuffer {
  data: ArrayBuffer; destroyed = false;
  constructor(readonly size: number, readonly usage: number, readonly label: string) { this.data = new ArrayBuffer(size); }
  async mapAsync() {}
  getMappedRange() { return this.data; }
  unmap() {}
  destroy() { this.destroyed = true; }
}
class FakeDevice {
  created: FakeBuffer[] = []; writes: FakeBuffer[] = []; groups: GPUBindGroupEntry[][] = []; submits = 0; querySets = 0; querySetsDestroyed = 0;
  readonly limits = { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65535, minStorageBufferOffsetAlignment: 256, minUniformBufferOffsetAlignment: 256 };
  readonly features = new Set(['timestamp-query']);
  readonly queue = {
    writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBufferView) => {
      this.writes.push(buffer); new Uint8Array(buffer.data, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    },
    submit: (commands: { ops: Op[] }[]) => { this.submits++; for (const command of commands) for (const op of command.ops) op(); },
  };
  createBuffer(desc: { size: number; usage: number; label?: string }) {
    const buffer = new FakeBuffer(desc.size, desc.usage, desc.label ?? ''); this.created.push(buffer); return buffer;
  }
  createQuerySet() { this.querySets++; return { destroy: () => { this.querySetsDestroyed++; } }; }
  createShaderModule() { return { getCompilationInfo: async () => ({ messages: [] }) }; }
  createBindGroupLayout() { return {}; }
  createPipelineLayout() { return {}; }
  async createComputePipelineAsync() { return { getBindGroupLayout: () => ({}) }; }
  createBindGroup(desc: GPUBindGroupDescriptor) {
    const entries = [...desc.entries]; this.groups.push(entries);
    // Only a scan level binds five entries. A one-level scan's total is its block sum: emulate a correct scan (3 indices
    // per triangle) at the slice that binds the sums.
    if (entries.length === 5) {
      const input = entries[0].resource as GPUBufferBinding, sums = entries[2].resource as GPUBufferBinding;
      new Uint32Array((sums.buffer as unknown as FakeBuffer).data, sums.offset, 1)[0] = input.size! / 4 * 3;
    }
    return {};
  }
  createCommandEncoder() {
    const ops: Op[] = [];
    return {
      ops, beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      clearBuffer: (buffer: FakeBuffer, offset = 0, size?: number) => ops.push(() => new Uint8Array(buffer.data, offset, size ?? buffer.size - offset).fill(0)),
      copyBufferToBuffer: (source: FakeBuffer, sourceOffset: number, target: FakeBuffer, targetOffset: number, size: number) =>
        ops.push(() => new Uint8Array(target.data, targetOffset, size).set(new Uint8Array(source.data, sourceOffset, size))),
      resolveQuerySet() {}, finish: () => ({ ops }),
    };
  }
}

beforeEach(() => { vi.stubGlobal('GPUBufferUsage', USAGE); vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 }); vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }); });
afterEach(() => { vi.unstubAllGlobals(); });

it('uploads page inputs and configs once per chunk at submit, where the passes bind them, and frees every chunk', async () => {
  const { ResidentGpuPages } = await import('../src/gpu/terrain/gpu-pages');
  const device = new FakeDevice(), gpuDevice = device as unknown as GPUDevice;
  const host: TerrainRenderHost = { device: gpuDevice, pageHooks: [], createPage: () => ({ id: 1, setPose() {}, dispose() {} }), commit() {} };
  const fixture = structuralFixture(), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
  const pages = [...arrangement.lattice.bricks.keys()].map(brick => arrangement.rebuild(brick, 1)).filter(page => page.regions.length).slice(0, 3);
  const gpu = await ResidentGpuPages.create(gpuDevice, 4096), arena = (buffer: FakeBuffer) => ARENA.test(buffer.label);
  const encode = () => {
    const batch = gpu.batch(host, emptyMetrics()), first = device.created.length;
    batch.construct(arrangement, []);
    for (const page of pages) batch.page(page.brick, page.regions.slice(0, 2).flatMap(region => region.faces.map(face => ({ region, face }))), { brick: page.brick, origin: [1, 2, 3] }, arrangement);
    return { batch, chunks: () => device.created.slice(first).filter(arena), others: () => device.created.slice(first).filter(b => !arena(b)) };
  };
  for (let transaction = 0; transaction < 2; transaction++) {
    device.writes.length = 0; device.groups.length = 0;
    const { batch, chunks, others } = encode();
    expect(device.writes.filter(arena)).toEqual([]);
    for (const page of (await batch.submit()).values()) page.dispose();
    expect(device.writes.filter(arena).map(b => b.label).sort()).toEqual(chunks().filter(b => WRITTEN.test(b.label)).map(b => b.label).sort());
    expect(chunks().length).toBeGreaterThan(0); expect(chunks().every(b => b.destroyed)).toBe(true);
    expect(others().filter(b => SCRATCH.test(b.label)).map(b => b.label)).toEqual([]);
    // The count and emit groups bind each page's config slice: [triangles, 3 x triangles, vertices, 0 | origin].
    const configs = device.groups.filter(entries => entries.length === 9).map(entries => entries[8].resource as GPUBufferBinding);
    expect(configs).toHaveLength(pages.length * 2);
    for (const { buffer, offset } of configs) {
      const data = (buffer as unknown as FakeBuffer).data, words = new Uint32Array(data, offset, 4);
      expect(words[0]).toBeGreaterThan(0); expect(words[1]).toBe(words[0] * 3); expect(words[2]).toBeGreaterThan(0);
      expect([...new Float32Array(data, offset! + 16, 3)]).toEqual([1, 2, 3]);
    }
  }
  expect(device.submits).toBe(2);
  device.writes.length = 0;
  const { batch, chunks } = encode();
  batch.cancel();
  expect(device.writes.filter(arena)).toEqual([]); expect(chunks().every(b => b.destroyed)).toBe(true);
  expect(device.querySets).toBe(1);
  gpu.dispose(); expect(device.querySetsDestroyed).toBe(1);
});
