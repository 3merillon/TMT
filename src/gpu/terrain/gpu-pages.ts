/// <reference types="@webgpu/types" />
import geometryShader from './geometry.wgsl?raw';
import pageShader from './pages.wgsl?raw';
import volumeShader from './volumes.wgsl?raw';
import indexShader from './indices.wgsl?raw';
import gatherShader from './gather.wgsl?raw';
import { GpuExclusiveScan, type BufferSlice, type ScanSlices } from './scan';
import type { ResidentArrangement } from './arrangement';
import type { OccupiedRegion, SliceMetrics } from './contracts';
import { BRICK_SIDE, ResidentFailure } from './contracts';
import type { ResidentLattice } from './lattice';
import type { PageBuffers, PageDrawHandle, PageDrawInfo, TerrainRenderHost } from './render-host';
import type { PageAttachment, PageHook } from './page-hooks';
import type { BoundaryFace } from '../../game/terrain-connectivity';
import type { Bounds, Vec3 } from '../../core/types';

export { pageBatch, type GpuPage, type PageTarget, type ResidentPageBackend, type ResidentPageBatch } from './page-batch';
import type { GpuPage, PageTarget, ResidentPageBackend, ResidentPageBatch, PackedResidentPageBatch, PackedResidentConstruction } from './page-batch';
const BOUNDS_SLACK = 1e-3;
/** A static page's draw bounds: its brick's cells (clamped to the lattice), never the whole lattice. */
export function brickBounds(lattice: ResidentLattice, brick: string): Bounds {
  const key = brick.split(',').map(Number);
  if (key.length !== 3 || !key.every(Number.isInteger) || !lattice.bricks.has(brick)) throw new ResidentFailure('validation', `Unknown resident brick ${brick}`);
  const axis = (a: number, side: 0 | 1) => side ? Math.min((key[a] + 1) * BRICK_SIDE, lattice.bounds.max[a]) + BOUNDS_SLACK : Math.max(key[a] * BRICK_SIDE, lattice.bounds.min[a]) - BOUNDS_SLACK;
  return { min: [axis(0, 0), axis(1, 0), axis(2, 0)], max: [axis(0, 1), axis(1, 1), axis(2, 1)] };
}
/** A body page's draw bounds: the AABB of its vertices relative to the page origin (body-local). */
export function localBounds(points: Iterable<Vec3>, origin: Vec3): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a] - origin[a]); max[a] = Math.max(max[a], p[a] - origin[a]); }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new ResidentFailure('validation', 'Resident page bounds are empty or not finite');
  return { min: min.map(v => v - BOUNDS_SLACK) as Vec3, max: max.map(v => v + BOUNDS_SLACK) as Vec3 };
}
/** Words of one page's status block in the transaction readback: page acceptance (4), scan status, scan total. */
export const PAGE_STATUS_WORDS = 6;
/** Byte layout of the combined readback: [volume descriptors (16 B/region)][timestamps 16 B][per page: status
 * block, then its hooks' words in host.pageHooks order]. Every offset is 4-byte aligned. */
export function statusLayout(regions: number, timestamps: boolean, hooks: readonly Pick<PageHook, 'statusWords'>[], pages: number): { descriptors: number; timestamps: number; pages: { status: number; hooks: number[] }[]; bytes: number } {
  let cursor = regions * 16; const timestampOffset = cursor; if (timestamps) cursor += 16;
  const out: { status: number; hooks: number[] }[] = [];
  for (let p = 0; p < pages; p++) {
    const status = cursor; cursor += PAGE_STATUS_WORDS * 4;
    const offsets = hooks.map(hook => { if (!Number.isInteger(hook.statusWords) || hook.statusWords < 0) throw new ResidentFailure('validation', 'Invalid page hook status size'); const at = cursor; cursor += hook.statusWords * 4; return at; });
    out.push({ status, hooks: offsets });
  }
  return { descriptors: 0, timestamps: timestampOffset, pages: out, bytes: Math.max(4, cursor) };
}
/** Page acceptance: no scan overflow; every nondegenerate triangle emitted. */
export function pageAccepted(words: Uint32Array, offset: number, capacity: number): boolean {
  const emitted = words[offset + 5];
  return !words[offset] && !words[offset + 4] && emitted <= capacity && emitted % 3 === 0;
}
/** Read lazily: the module stays importable where WebGPU globals do not exist (Node tests use its pure helpers). */
const storageUsage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
/** Bump allocation over chunk buffers that live for one transaction: a page's small inputs, counts, status words and
 * configs become slices of a few buffers instead of a dozen buffers per page (each a GPU-process allocation and a
 * deferred destroy), and the transaction's uploads reach the GPU as one write per chunk. A chunk holds one kind of
 * binding only, so no dispatch binds one buffer both read-only and writable. Slices start at the binding alignment.
 * (Not the engine's GpuSliceArena: nothing here is freed or reused across frames; the chunks die with the transaction.) */
class SliceArena {
  private chunk?: GPUBuffer; private used = 0; private readonly chunks: GPUBuffer[] = [];
  private readonly writes: { slice: BufferSlice; data: ArrayBufferView<ArrayBuffer> }[] = [];
  get bytes(): number { return this.chunks.reduce((sum, chunk) => sum + chunk.size, 0); }
  constructor(private readonly create: (size: number) => GPUBuffer, private readonly align: number, private readonly chunkSize: number) {}
  take(bytes: number): BufferSlice {
    const size = Math.max(4, Math.ceil(bytes / 4) * 4);
    let offset = Math.ceil(this.used / this.align) * this.align;
    if (!this.chunk || offset + size > this.chunk.size) { this.chunk = this.create(Math.max(this.chunkSize, size)); this.chunks.push(this.chunk); offset = 0; }
    this.used = offset + size;
    return { buffer: this.chunk, offset, size };
  }
  /** A slice that holds `data` from flush() on; `data` must not change before then. */
  write(data: ArrayBufferView<ArrayBuffer>): BufferSlice { const slice = this.take(data.byteLength); if (data.byteLength) this.writes.push({ slice, data }); return slice; }
  /** One writeBuffer per chunk over the span of its writes (the gaps are alignment padding that no slice binds). An arena
   * that is written must have every slice written: a bare take() inside the span would read the padding's zeros. */
  flush(queue: GPUQueue): void {
    const writes = this.writes;
    for (let i = 0, j = 0; i < writes.length; i = j) {
      const buffer = writes[i].slice.buffer, begin = writes[i].slice.offset;
      while (j < writes.length && writes[j].slice.buffer === buffer) j++;
      const bytes = new Uint8Array(writes[j - 1].slice.offset + writes[j - 1].slice.size - begin);
      for (let k = i; k < j; k++) { const { slice, data } = writes[k]; bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), slice.offset - begin); }
      queue.writeBuffer(buffer, begin, bytes);
    }
    writes.length = 0;
  }
  destroy(): void { for (const chunk of this.chunks) chunk.destroy(); this.chunks.length = 0; this.chunk = undefined; this.writes.length = 0; }
}
const binding = (slice: BufferSlice): GPUBufferBinding => ({ buffer: slice.buffer, offset: slice.offset, size: slice.size });
/** Production renderer device only; resident positions and output pages survive edits.
 * CPU topology is a deliberate first-slice hybrid. Construction, volume acceptance,
 * count/scan and all triangle emission execute on the renderer GPUDevice. */
export class ResidentGpuPages implements ResidentPageBackend {
  private uploaded = 0;
  private positions: GPUBuffer;
  private recipes: GPUBuffer;
  private bytes = 0;
  private constructor(readonly device: GPUDevice, private readonly construct: GPUComputePipeline,
    private readonly count: GPUComputePipeline, private readonly emit: GPUComputePipeline, private readonly volumes: GPUComputePipeline, private readonly indices: GPUComputePipeline,
    private readonly gatherPipeline: GPUComputePipeline, private readonly scan: GpuExclusiveScan, public capacity: number) {
    this.positions = this.buffer(capacity * 16, storageUsage(), 'canonical resident f32 positions');
    this.recipes = this.buffer(capacity * 64, storageUsage(), 'immutable source intersection recipes');
  }
  /** `device` is the terrain host's device: pages are emitted where the host draws them. */
  static async create(device: GPUDevice, capacity = 131072): Promise<ResidentGpuPages> {
    async function module(code: string) { const module = device.createShaderModule({ code }); const info = await module.getCompilationInfo();
      if (info.messages.some(m => m.type === 'error')) throw new ResidentFailure('device', info.messages.map(m => `${m.lineNum}: ${m.message}`).join('\n')); return module; }
    const [geometry, page, volume, index, gather] = await Promise.all([module(geometryShader), module(pageShader), module(volumeShader), module(indexShader), module(gatherShader)]);
    const entries: GPUBindGroupLayoutEntry[] = Array.from({ length: 9 }, (_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 8 ? 'uniform' : [0, 1, 3].includes(binding) ? 'read-only-storage' : 'storage' } }));
    const layout = device.createPipelineLayout({ bindGroupLayouts: [device.createBindGroupLayout({ entries })] });
    const [construct, count, emit, volumes, indices, gatherPipeline, scan] = await Promise.all([
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: geometry, entryPoint: 'construct' } }),
      device.createComputePipelineAsync({ layout, compute: { module: page, entryPoint: 'count' } }),
      device.createComputePipelineAsync({ layout, compute: { module: page, entryPoint: 'emit' } }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: volume, entryPoint: 'volumes' } }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: index, entryPoint: 'emitIndices' } }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: gather, entryPoint: 'gather' } }), GpuExclusiveScan.create(device)]);
    return new ResidentGpuPages(device, construct, count, emit, volumes, indices, gatherPipeline, scan, capacity);
  }
  private buffer(size: number, usage: number, label: string): GPUBuffer {
    size = Math.max(4, Math.ceil(size / 4) * 4);
    if (size > this.device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && size > this.device.limits.maxStorageBufferBindingSize)) throw new ResidentFailure('capacity', `${label} exceeds device limits`);
    return this.device.createBuffer({ size, usage, label });
  }
  private upload(data: ArrayBufferView<ArrayBuffer>, label: string, usage = storageUsage()): GPUBuffer {
    const buffer = this.buffer(data.byteLength, usage, label); if (data.byteLength) this.device.queue.writeBuffer(buffer, 0, data); return buffer;
  }
  /** Grow the canonical buffers before anything of this transaction is encoded (they are rebound by every pass). */
  private reserve(n: number): void {
    if (n <= this.capacity) return;
    const limit = Math.floor(Math.min(this.device.limits.maxBufferSize, this.device.limits.maxStorageBufferBindingSize) / 64);
    const capacity = Math.min(limit, Math.max(n, this.capacity * 2));
    if (capacity < n) throw new ResidentFailure('capacity', `Live geometry needs ${n * 64} recipe bytes; device supports ${limit * 64}`);
    const positions = this.buffer(capacity * 16, storageUsage(), 'canonical resident f32 positions'); let recipes: GPUBuffer;
    try { recipes = this.buffer(capacity * 64, storageUsage(), 'immutable source intersection recipes'); } catch (error) { positions.destroy(); throw error; }
    // Destroy waits for already submitted work; every recipe is re-uploaded and re-executed below.
    this.positions.destroy(); this.recipes.destroy(); this.positions = positions; this.recipes = recipes; this.capacity = capacity; this.uploaded = 0;
  }
  batch(host: TerrainRenderHost, metrics: SliceMetrics): ResidentPageBatch { return new GpuBatch(this, host, metrics); }
  packedBatch(host: TerrainRenderHost, metrics: SliceMetrics): PackedResidentPageBatch { return new GpuBatch(this, host, metrics); }
  private timestamps?: { query: GPUQuerySet; resolve: GPUBuffer };
  /** One timestamp query set and resolve buffer for every transaction: each resolves and copies its two timestamps
   * inside its own command buffer, so queue order keeps consecutive transactions apart. */
  private timer(): { query: GPUQuerySet; resolve: GPUBuffer } {
    return this.timestamps ??= { query: this.device.createQuerySet({ type: 'timestamp', count: 2 }), resolve: this.buffer(256, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC, 'resident timestamp') };
  }
  /** @internal GpuBatch access. */
  get internals() {
    return { device: this.device, construct: this.construct, count: this.count, emit: this.emit, volumes: this.volumes, indices: this.indices, scan: this.scan,
      positions: this.positions, recipes: this.recipes, uploaded: this.uploaded, capacity: this.capacity, bytes: this.bytes,
      buffer: (size: number, usage: number, label: string) => this.buffer(size, usage, label), upload: (data: ArrayBufferView<ArrayBuffer>, label: string, usage?: number) => this.upload(data, label, usage),
      reserve: (n: number) => this.reserve(n), setUploaded: (n: number) => { this.uploaded = n; }, addBytes: (n: number) => { this.bytes += n; }, timer: () => this.timer() };
  }
  /** Enqueue DAG levels and one bounded readback that accepts region volume descriptors (single-call API). */
  async constructRegions(arrangement: ResidentArrangement, regions: readonly OccupiedRegion[], metrics: SliceMetrics): Promise<void> {
    const batch = new GpuBatch(this, undefined, metrics); batch.construct(arrangement, regions); await batch.submit();
  }
  invalidateUpload(vertexCount: number): void { this.uploaded = Math.min(this.uploaded, vertexCount); }
  /** Emits one page and hands its buffers to `host.createPage`; the page stays invisible until the caller's host.commit. */
  async page(boundary: readonly BoundaryFace[], target: PageTarget, arrangement: ResidentArrangement, metrics: SliceMetrics, host: TerrainRenderHost): Promise<GpuPage | undefined> {
    const batch = new GpuBatch(this, host, metrics); batch.page('page', boundary, target, arrangement); return (await batch.submit()).get('page');
  }
  gather(oldIds: Int32Array): void {
    const n = oldIds.length;
    // A survivor that was never constructed (impossible for committed geometry): reconstruct everything instead.
    if ((n && oldIds[n - 1] >= this.uploaded) || Math.ceil(n / 64) > this.device.limits.maxComputeWorkgroupsPerDimension) { this.uploaded = 0; return; }
    const target = this.buffer(this.capacity * 16, storageUsage(), 'canonical resident f32 positions'), ids = this.upload(Uint32Array.from(oldIds), 'compaction survivors');
    const encoder = this.device.createCommandEncoder({ label: 'resident compaction gather' }), pass = encoder.beginComputePass({ label: 'resident compaction gather' });
    pass.setPipeline(this.gatherPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: this.gatherPipeline.getBindGroupLayout(0), entries: [this.positions, ids, target].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    if (n) pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end(); this.device.queue.submit([encoder.finish()]);
    this.positions.destroy(); ids.destroy(); this.positions = target; this.uploaded = n;
  }
  dispose(): void { this.positions.destroy(); this.recipes.destroy(); this.timestamps?.query.destroy(); this.timestamps?.resolve.destroy(); }
}

interface QueuedPage { key: string; target: PageTarget; count: number; capacity: number; vertexCount: number; bounds: Bounds;
  outputs: GPUBuffer[]; buffers: PageBuffers; statusCopies: [GPUBuffer, number, number][]; hooks: { hook: PageHook; pending: { finish(status: Uint32Array): PageAttachment | undefined }; words: number }[]; hookBuffer?: GPUBuffer }
class GpuBatch implements ResidentPageBatch, PackedResidentPageBatch {
  private readonly encoder: GPUCommandEncoder;
  private readonly owned: GPUBuffer[] = [];
  private readonly destroyers: (() => void)[] = [];
  private readonly pages: QueuedPage[] = [];
  private regions: readonly OccupiedRegion[] = [];
  private packedVolumes?: Float64Array<ArrayBuffer>;
  private descriptors?: GPUBuffer;
  private query?: GPUQuerySet; private resolve?: GPUBuffer;
  private uploadedAfter?: number;
  private surfaces?: Map<string, import('./contracts').SampleField['surface']>;
  private done = false;
  /** This transaction's slice arenas: read-only inputs, uniform configs, triangle counts, page and scan status words, and
   * the scans' offsets and block sums of even and of odd levels. */
  private readonly inputs: SliceArena; private readonly uniforms: SliceArena; private readonly counts: SliceArena;
  private readonly statuses: SliceArena; private readonly scanStatuses: SliceArena; private readonly scanLevels: readonly [SliceArena, SliceArena];
  private readonly arenas: readonly SliceArena[];
  private readonly scanSlices: ScanSlices;
  /** Fresh on every access: construct() may reallocate the canonical buffers. */
  private get gpu(): ResidentGpuPages['internals'] { return this.owner.internals; }
  constructor(private readonly owner: ResidentGpuPages, private readonly host: TerrainRenderHost | undefined, private readonly metrics: SliceMetrics) {
    if (host && host.device !== this.gpu.device) throw new ResidentFailure('device', 'Terrain host device differs from the resident page device');
    this.encoder = this.gpu.device.createCommandEncoder({ label: 'resident terrain transaction' });
    const limits = this.gpu.device.limits as Partial<GPUSupportedLimits>, storage = limits.minStorageBufferOffsetAlignment ?? 256, uniform = limits.minUniformBufferOffsetAlignment ?? 256;
    const arena = (label: string, usage: number, align: number, chunk: number) => new SliceArena(size => this.gpu.buffer(size, usage, label), align, chunk);
    this.inputs = arena('terrain:page-inputs', storageUsage(), storage, 1 << 20);
    this.uniforms = arena('terrain:page-configs', GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, uniform, 1 << 16);
    this.counts = arena('terrain:triangle-counts', storageUsage(), storage, 1 << 18);
    this.statuses = arena('terrain:page-status', storageUsage(), storage, 1 << 16);
    this.scanStatuses = arena('terrain:scan-status', storageUsage(), storage, 1 << 16);
    this.scanLevels = [arena('terrain:scan-levels-even', storageUsage(), storage, 1 << 18), arena('terrain:scan-levels-odd', storageUsage(), storage, 1 << 16)];
    this.arenas = [this.inputs, this.uniforms, this.counts, this.statuses, this.scanStatuses, ...this.scanLevels];
    this.scanSlices = { status: () => this.scanStatuses.take(4), uniform: data => this.uniforms.write(data), level: (level, bytes) => this.scanLevels[level % 2].take(bytes) };
  }
  construct(arrangement: ResidentArrangement, regions: readonly OccupiedRegion[]): void {
    if (this.pages.length || this.uploadedAfter !== undefined) throw new ResidentFailure('validation', 'Resident construction must be encoded first, once');
    const n = arrangement.vertices.length; this.gpu.reserve(n);
    const g = this.owner.internals, device = g.device, from = g.uploaded, metrics = this.metrics;
    const words = new ArrayBuffer((n - from) * 64), u = new Uint32Array(words), f = new Float32Array(words);
    let maxLevel = 0;
    for (let i = from; i < n; i++) {
      const v = arrangement.vertices[i], k = (i - from) * 16;
      u[k] = v.edge?.[0] ?? 0; u[k + 1] = v.edge?.[1] ?? 0; u[k + 2] = v.level; u[k + 3] = v.basis ? 2 : v.edge ? 1 : 0;
      if (v.basis) { for (let j = 0; j < 4; j++) u[k + 4 + j] = v.basis[j] ?? v.basis[0]; f.set(v.barycentric!, k + 12); }
      if (v.base) { f[k + 8] = v.base[0]; f[k + 9] = v.base[1]; f[k + 10] = v.base[2]; f[k + 11] = 0; }
      else { f[k + 8] = v.values![0]; f[k + 9] = v.values![1]; f[k + 10] = 0; f[k + 11] = 0; }
      if (v.level > maxLevel) maxLevel = v.level;
    }
    if (words.byteLength) { device.queue.writeBuffer(g.recipes, from * 64, words); metrics.uploadBytes += words.byteLength; }
    if (device.features.has('timestamp-query')) ({ query: this.query, resolve: this.resolve } = g.timer());
    for (let level = 0; level <= maxLevel && from < n; level++) {
      const config = this.uniforms.write(new Uint32Array([level, n, from, 0]));
      const group = device.createBindGroup({ layout: g.construct.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: g.recipes } }, { binding: 1, resource: { buffer: g.positions } }, { binding: 2, resource: binding(config) }] });
      const pass = this.encoder.beginComputePass({ label: `canonical edge constructions ${level}`, ...(this.query && level === 0 ? { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: 0 } } : {}) });
      pass.setPipeline(g.construct); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil((n - from) / 64)); pass.end();
    }
    this.uploadedAfter = n; this.regions = regions;
    if (!regions.length) return;
    const tris: number[] = [], desc: number[] = [];
    for (const region of regions) {
      const start = tris.length / 4;
      for (const face of region.faces) for (let i = 1; i + 1 < face.vertices.length; i++) tris.push(face.vertices[0], face.vertices[i], face.vertices[i + 1], 0);
      desc.push(start, tris.length / 4 - start, 0, 0);
    }
    // Slices bind at their exact size: volumes.wgsl counts regions with arrayLength.
    const triangles = this.inputs.write(new Uint32Array(tris)), descriptors = this.inputs.write(new Uint32Array(desc)), output = g.buffer(regions.length * 16, storageUsage(), 'occupied region descriptors');
    this.owned.push(output); metrics.uploadBytes += tris.length * 4 + desc.length * 4;
    const group = device.createBindGroup({ layout: g.volumes.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: g.positions } }, { binding: 1, resource: binding(triangles) },
      { binding: 2, resource: binding(descriptors) }, { binding: 3, resource: { buffer: output } }] });
    const pass = this.encoder.beginComputePass({ label: 'occupied volume acceptance', ...(this.query ? { timestampWrites: { querySet: this.query, endOfPassWriteIndex: 1, ...(from === n ? { beginningOfPassWriteIndex: 0 } : {}) } } : {}) });
    pass.setPipeline(g.volumes); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(regions.length / 64)); pass.end();
    this.descriptors = output;
  }
  /** Canonical Rust recipes depend only on original lattice vertices, so construction takes two levels. */
  constructPacked(input: PackedResidentConstruction): void {
    if (this.pages.length || this.uploadedAfter !== undefined) throw new ResidentFailure('validation', 'Resident construction must be encoded first, once');
    const n = input.vertexCount; this.gpu.reserve(n);
    const g = this.gpu, device = g.device, from = g.uploaded, metrics = this.metrics, words = input.recipes(from);
    if (words.length !== (n - from) * 16) throw new ResidentFailure('validation', 'Invalid resident recipe span');
    // writeBuffer captures the view synchronously, before the coordinator reuses its output arena.
    if (words.byteLength) { device.queue.writeBuffer(g.recipes, from * 64, words); metrics.uploadBytes += words.byteLength; }
    if (device.features.has('timestamp-query')) ({ query: this.query, resolve: this.resolve } = g.timer());
    for (let level = 0; level <= 1 && from < n; level++) {
      const config = this.uniforms.write(new Uint32Array([level, n, from, 0]));
      const group = device.createBindGroup({ layout: g.construct.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: g.recipes } }, { binding: 1, resource: { buffer: g.positions } }, { binding: 2, resource: binding(config) }] });
      const pass = this.encoder.beginComputePass({ label: `canonical basis constructions ${level}`, ...(this.query && level === 0 ? { timestampWrites: { querySet: this.query, beginningOfPassWriteIndex: 0 } } : {}) });
      pass.setPipeline(g.construct); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil((n - from) / 64)); pass.end();
    }
    this.uploadedAfter = n;
    const packed = input.volumes(), count = packed.volumes.length;
    if (packed.descriptors.length !== count * 4 || packed.triangles.length % 4) throw new ResidentFailure('validation', 'Invalid resident volume spans');
    this.packedVolumes = packed.volumes.slice(); if (!count) return;
    // Transaction arenas own flat copies until submit; no region/face/recipe objects are reconstructed.
    const triangles = this.inputs.write(packed.triangles.slice()), descriptors = this.inputs.write(packed.descriptors.slice()), output = g.buffer(count * 16, storageUsage(), 'occupied region descriptors');
    this.owned.push(output); metrics.uploadBytes += packed.triangles.byteLength + packed.descriptors.byteLength;
    const group = device.createBindGroup({ layout: g.volumes.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: g.positions } }, { binding: 1, resource: binding(triangles) }, { binding: 2, resource: binding(descriptors) }, { binding: 3, resource: { buffer: output } }] });
    const pass = this.encoder.beginComputePass({ label: 'occupied volume acceptance', ...(this.query ? { timestampWrites: { querySet: this.query, endOfPassWriteIndex: 1, ...(from === n ? { beginningOfPassWriteIndex: 0 } : {}) } } : {}) });
    pass.setPipeline(g.volumes); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end(); this.descriptors = output;
  }
  page(key: string, boundary: readonly BoundaryFace[], target: PageTarget, arrangement: ResidentArrangement): void {
    const origin = target.origin, triangles: number[] = [], vertexRefs: number[] = [];
    const surfaces = this.surfaces ??= new Map(arrangement.fields.map(field => [field.id, field.surface]));
    const scratch = new Float32Array(3), bits = new Uint32Array(scratch.buffer);
    for (const { region, face } of boundary) {
      const start = vertexRefs.length / 8;
      const source = surfaces.get(face.source), kind = source?.kind === 'planet' ? 1 : source?.kind === 'sphere' ? 2 : 0;
      if (source?.kind === 'sphere') scratch.set(source.center); else scratch.fill(0);
      for (const id of face.vertices) vertexRefs.push(id, face.vertices[0], face.vertices[1], face.vertices[2], region.material | (kind << 16), bits[0], bits[1], bits[2]);
      for (let i = 1; i + 1 < face.vertices.length; i++) triangles.push(face.vertices[0], face.vertices[i], face.vertices[i + 1], region.material, start, start + i, start + i + 1, 0);
    }
    const count = triangles.length / 8; if (!count) return;
    const bounds = target.bodyId === undefined ? brickBounds(arrangement.lattice, target.brick ?? '') : localBounds(vertexRefs.filter((_, i) => i % 8 === 0).map(id => arrangement.vertices[id].position), origin);
    this.emitPage(key, new Uint32Array(triangles), new Uint32Array(vertexRefs), target, bounds);
  }
  pagePacked(key: string, input: { triangles: Uint32Array<ArrayBuffer>; references: Uint32Array<ArrayBuffer> }, target: PageTarget, bounds: Bounds): void {
    if (input.triangles.length % 8 || input.references.length % 8) throw new ResidentFailure('validation', 'Invalid resident surface spans');
    if (!input.triangles.length) return;
    this.emitPage(key, input.triangles.slice(), input.references.slice(), target, bounds);
  }
  private emitPage(key: string, triangles: Uint32Array<ArrayBuffer>, vertexRefs: Uint32Array<ArrayBuffer>, target: PageTarget, bounds: Bounds): void {
    const host = this.host; if (!host) throw new ResidentFailure('device', 'Resident page batch has no terrain host');
    const g = this.gpu, device = g.device, metrics = this.metrics, origin = target.origin, count = triangles.length / 8;
    const capacity = count * 3, vertexCount = vertexRefs.length / 8, outputs: GPUBuffer[] = [];
    if (Math.ceil(Math.max(count, vertexCount) / 64) > device.limits.maxComputeWorkgroupsPerDimension) throw new ResidentFailure('capacity', 'Resident page exceeds dispatch capacity');
    try {
      // Inputs, counts, status, config and the scan's levels are slices of this transaction's arenas; indices.wgsl reads
      // refs and the index buffer with arrayLength, so every slice binds at its exact size.
      const refs = this.inputs.write(triangles), vrefs = this.inputs.write(vertexRefs);
      const counts = this.counts.take(count * 4), status = this.statuses.take(16);
      metrics.uploadBytes += (triangles.length + vertexRefs.length) * 4;
      const scan = g.scan.prepare(counts, count, this.scanSlices); this.destroyers.push(() => scan.destroy());
      const attrs = [3, 3, 8].map((size, i) => g.buffer(vertexCount * size * 4, storageUsage() | GPUBufferUsage.VERTEX, `resident surface attribute ${i}`)); outputs.push(...attrs);
      const index = g.buffer(capacity * 4, storageUsage() | GPUBufferUsage.INDEX, 'resident surface indices'); outputs.push(index);
      const indirect = g.upload(new Uint32Array([capacity, 1, 0, 0, 0]), 'resident indexed draw', storageUsage() | GPUBufferUsage.INDIRECT); outputs.push(indirect);
      const configData = new ArrayBuffer(32); new Uint32Array(configData).set([count, capacity, vertexCount, 0]); new Float32Array(configData).set([...origin, 0], 4);
      const config = this.uniforms.write(new Uint8Array(configData));
      const group = (references: BufferSlice) => device.createBindGroup({ layout: g.count.getBindGroupLayout(0), entries: [
        { buffer: g.positions }, binding(references), binding(counts), binding(scan.offsets), { buffer: attrs[0] }, { buffer: attrs[1] }, { buffer: attrs[2] }, binding(status), binding(config),
      ].map((resource, slot) => ({ binding: slot, resource })) });
      const encoder = this.encoder;
      encoder.clearBuffer(status.buffer, status.offset, 16);
      for (const pipeline of [g.count, g.emit]) {
        if (pipeline === g.emit) scan.encode(encoder);
        const pass = encoder.beginComputePass({ label: pipeline === g.count ? 'resident surface count' : 'resident surface emit' });
        pass.setPipeline(pipeline); pass.setBindGroup(0, group(pipeline === g.count ? refs : vrefs)); pass.dispatchWorkgroups(Math.ceil((pipeline === g.count ? count : vertexCount) / 64)); pass.end();
      }
      const indexGroup = device.createBindGroup({ layout: g.indices.getBindGroupLayout(0), entries: [binding(refs), binding(scan.offsets), { buffer: index }, binding(counts)].map((resource, slot) => ({ binding: slot, resource })) });
      const indexPass = encoder.beginComputePass({ label: 'resident indexed topology' }); indexPass.setPipeline(g.indices); indexPass.setBindGroup(0, indexGroup); indexPass.dispatchWorkgroups(Math.ceil(count / 64)); indexPass.end();
      encoder.copyBufferToBuffer(scan.total.buffer, scan.total.offset, indirect, 0, 4);
      const buffers: PageBuffers = { position: attrs[0], normal: attrs[1], surface: attrs[2], index, indirect, vertexCount, indexCount: capacity };
      const info: PageDrawInfo = { ...target, bounds };
      const queued: QueuedPage = { key, target, count, capacity, vertexCount, bounds, outputs, buffers,
        statusCopies: [[status.buffer, status.offset, 16], [scan.status.buffer, scan.status.offset, 4], [scan.total.buffer, scan.total.offset, 4]], hooks: [] };
      // Page hooks encode into this transaction's encoder; their status words ride on the single readback.
      const hookWords = host.pageHooks.reduce((sum, hook) => sum + hook.statusWords, 0);
      if (host.pageHooks.length) {
        const hookBuffer = g.buffer(hookWords * 4, storageUsage(), 'page hook status'); this.owned.push(hookBuffer); encoder.clearBuffer(hookBuffer);
        if (hookWords) queued.hookBuffer = hookBuffer;
        let offset = 0;
        for (const hook of host.pageHooks) {
          const pending = hook.encode({ encoder, buffers, info, triangleCount: count, isBody: target.bodyId !== undefined, status: { buffer: hookBuffer, offset, words: hook.statusWords } });
          if (pending) queued.hooks.push({ hook, pending, words: hook.statusWords });
          offset += hook.statusWords * 4;
        }
      }
      this.pages.push(queued);
    } catch (error) { outputs.forEach(b => b.destroy()); throw error; }
  }
  async submit(): Promise<Map<string, GpuPage>> {
    if (this.done) throw new ResidentFailure('stale', 'Resident page batch already submitted');
    this.done = true;
    const g = this.gpu, device = g.device, metrics = this.metrics, hooks = this.host?.pageHooks ?? [];
    const regionCount = this.packedVolumes?.length ?? this.regions.length;
    const layout = statusLayout(this.descriptors ? regionCount : 0, !!(this.query && this.resolve && this.descriptors), hooks, this.pages.length);
    const adopted = new Map<string, GpuPage>();
    let staging: GPUBuffer | undefined, mapped = false;
    try {
      staging = g.buffer(layout.bytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, 'resident transaction status readback'); this.owned.push(staging);
      if (this.descriptors) this.encoder.copyBufferToBuffer(this.descriptors, 0, staging, layout.descriptors, regionCount * 16);
      if (this.query && this.resolve && this.descriptors) { this.encoder.resolveQuerySet(this.query, 0, 2, this.resolve, 0); this.encoder.copyBufferToBuffer(this.resolve, 0, staging, layout.timestamps, 16); }
      this.pages.forEach((page, p) => {
        let at = layout.pages[p].status;
        for (const [buffer, offset, size] of page.statusCopies) { this.encoder.copyBufferToBuffer(buffer, offset, staging!, at, size); at += size; }
        const hookBytes = hooks.reduce((sum, hook) => sum + hook.statusWords * 4, 0);
        if (page.hookBuffer && hookBytes) this.encoder.copyBufferToBuffer(page.hookBuffer, 0, staging!, layout.pages[p].hooks[0] ?? at, hookBytes);
      });
      this.inputs.flush(device.queue); this.uniforms.flush(device.queue);
      device.queue.submit([this.encoder.finish()]); metrics.submissions++; metrics.descriptorReadbackBytes += layout.bytes;
      if (!this.pages.length && !this.descriptors) { if (this.uploadedAfter !== undefined) g.setUploaded(this.uploadedAfter); return adopted; }
      await staging.mapAsync(GPUMapMode.READ); mapped = true; metrics.readbacks = (metrics.readbacks ?? 0) + 1;
      // WebGPU forbids overlapping getMappedRange calls while mapped: every view shares this single range.
      const range = staging.getMappedRange(), floats = new Float32Array(range), words = new Uint32Array(range);
      for (let i = 0; this.descriptors && i < regionCount; i++) {
        const volume = this.packedVolumes?.[i] ?? this.regions[i].volume;
        if (floats[i * 4 + 2] || !Number.isFinite(floats[i * 4]) || Math.abs(floats[i * 4] - volume) > Math.max(1e-5, volume * 1e-4))
          throw new ResidentFailure('validation', `GPU region ${this.regions[i]?.id ?? i} volume ${floats[i * 4]} disagrees with source reconstruction ${volume}`);
      }
      if (this.query && this.resolve && this.descriptors) { const times = new BigUint64Array(range, layout.timestamps, 2); metrics.gpuMs = Number(times[1] - times[0]) / 1e6; }
      const rejected = this.pages.findIndex((page, p) => !pageAccepted(words, layout.pages[p].status / 4, page.capacity));
      const attachments = this.pages.map((page, p) => page.hooks.map((entry, h) => {
        const offset = layout.pages[p].hooks[hooks.indexOf(entry.hook)] ?? layout.pages[p].hooks[h];
        return entry.pending.finish(words.slice(offset / 4, offset / 4 + entry.words));
      }).filter((a): a is PageAttachment => !!a));
      staging.unmap(); mapped = false;
      if (rejected >= 0) { attachments.flat().forEach(a => a.dispose()); throw new ResidentFailure('validation', 'Resident count/scan/emit refused page'); }
      if (this.uploadedAfter !== undefined) g.setUploaded(this.uploadedAfter);
      this.pages.forEach((page, p) => {
        const handle = this.host!.createPage(page.buffers, { ...page.target, bounds: page.bounds });
        const bytes = page.outputs.reduce((s, b) => s + b.size, 0); g.addBytes(bytes); page.outputs.length = 0;
        let disposed = false, list = attachments[p];
        adopted.set(page.key, { handle, bytes, attachments: list, dispose: () => { if (disposed) return; disposed = true; try { for (const a of list) a.dispose(); } finally { list = []; handle.dispose(); g.addBytes(-bytes); } } });
      });
      metrics.peakGpuBytes = Math.max(metrics.peakGpuBytes, g.capacity * 80 + this.owner.internals.bytes + this.owned.reduce((s, b) => s + b.size, 0)
        + this.arenas.reduce((s, arena) => s + arena.bytes, 0));
      return adopted;
    } catch (error) {
      adopted.forEach(page => page.dispose());
      throw error;
    } finally {
      if (mapped) staging?.unmap();
      this.release();
    }
  }
  private release(): void {
    for (const page of this.pages) page.outputs.forEach(b => b.destroy());
    this.owned.forEach(b => b.destroy()); this.destroyers.forEach(d => d());
    for (const arena of this.arenas) arena.destroy();
  }
  cancel(): void { if (this.done) return; this.done = true; this.release(); }
}
