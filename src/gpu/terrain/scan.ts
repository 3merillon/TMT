/// <reference types="@webgpu/types" />
import shader from './scan.wgsl?raw';

/** A range of a buffer that something else owns (a transaction's slice arena). */
export interface BufferSlice { readonly buffer: GPUBuffer; readonly offset: number; readonly size: number }
/** Where a job takes its buffers instead of creating one for each: `uniform` returns a slice that holds `data` by the
 * caller's submit; `level` returns writable storage for one level's offsets or block sums, never in a buffer that holds
 * a level of the other parity (a pass reads one level and writes the next, and one buffer must not be bound both
 * read-only and writable). */
export interface ScanSlices { status(): BufferSlice; uniform(data: Uint32Array<ArrayBuffer>): BufferSlice; level(level: number, bytes: number): BufferSlice }
export interface ExclusiveScanJob {
  readonly count: number;
  /** u32 exclusive offsets. Results must be consumed only if status[0] == 0. */
  readonly offsets: BufferSlice;
  /** One u32 total; meaningful only on success. */
  readonly total: BufferSlice;
  /** One u32: 0 success, bit 0 arithmetic overflow. Device failures are separate. */
  readonly status: BufferSlice;
  /** Resets this job's status, then scans current resident input. Never maps any buffer. */
  encode(encoder: GPUCommandEncoder): void;
  destroy(): void;
}
interface Level { count: number; groups: number; offsets: BufferSlice; sums: BufferSlice; config: BufferSlice; scanGroup: GPUBindGroup; addGroup?: GPUBindGroup }

/** Deterministic multi-pass compaction offsets, including explicit overflow refusal. */
export class GpuExclusiveScan {
  private constructor(private readonly device: GPUDevice, private readonly scan: GPUComputePipeline, private readonly add: GPUComputePipeline) {}
  static async create(device: GPUDevice): Promise<GpuExclusiveScan> {
    const module = device.createShaderModule({ code: shader, label: 'exact exclusive integer scan' });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const [scan, add] = await Promise.all(['scanBlocks', 'addBlockOffsets'].map(entryPoint => device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })));
    return new GpuExclusiveScan(device, scan, add);
  }
  /** `input` is the counts buffer, or a slice of one; with `slices`, the status word, the level configs and the levels'
   * offsets and block sums come from the caller's arenas (the job creates no buffer). */
  prepare(input: GPUBuffer | BufferSlice, count: number, slices?: ScanSlices): ExclusiveScanJob {
    const device = this.device, inputSlice: BufferSlice = 'buffer' in input ? input : { buffer: input, offset: 0, size: input.size };
    if (!Number.isInteger(count) || count < 0 || count > 0xffffffff || inputSlice.size < Math.max(4, count * 4)) throw new Error('Invalid scan count/input capacity');
    if (!(inputSlice.buffer.usage & GPUBufferUsage.STORAGE)) throw new Error('Scan input requires STORAGE usage');
    if (count * 4 > Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize)) throw new Error('Scan storage capacity exceeded');
    // addBlockOffsets uses 128 lanes; all dispatches remain in one dimension.
    if (Math.ceil(count / 128) > device.limits.maxComputeWorkgroupsPerDimension) throw new Error('Scan dispatch capacity exceeded');
    const owned: GPUBuffer[] = [];
    const buffer = (size: number, label: string, extraUsage = 0): BufferSlice => {
      const b = device.createBuffer({ size: Math.max(4, size), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | extraUsage, label });
      owned.push(b); return { buffer: b, offset: 0, size: b.size };
    };
    const status = slices?.status() ?? buffer(4, 'scan refusal flags', GPUBufferUsage.COPY_DST);
    const config = (n: number): BufferSlice => {
      if (slices) return slices.uniform(new Uint32Array([n, 0, 0, 0]));
      const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true }); owned.push(b);
      new Uint32Array(b.getMappedRange()).set([n, 0, 0, 0]); b.unmap();
      return { buffer: b, offset: 0, size: 16 };
    };
    const storage = (level: number, size: number, label: string) => slices?.level(level, size) ?? buffer(size, label);
    const levels: Level[] = [];
    let source = inputSlice, n = count;
    while (n > 0) {
      const groups = Math.ceil(n / 256), offsets = storage(levels.length, n * 4, 'exclusive offsets'), sums = storage(levels.length, groups * 4, 'block sums'), levelConfig = config(n);
      const scanGroup = device.createBindGroup({ layout: this.scan.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: source.buffer, offset: source.offset, size: n * 4 } }, { binding: 1, resource: { ...offsets } },
        { binding: 2, resource: { ...sums } }, { binding: 3, resource: { ...levelConfig } }, { binding: 4, resource: { ...status } },
      ] });
      levels.push({ count: n, groups, offsets, sums, config: levelConfig, scanGroup });
      if (groups === 1) break;
      source = sums; n = groups;
    }
    for (let i = 0; i + 1 < levels.length; ++i) {
      const level = levels[i];
      level.addGroup = device.createBindGroup({ layout: this.add.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { ...levels[i + 1].offsets } }, { binding: 1, resource: { ...level.offsets } },
        { binding: 3, resource: { ...level.config } }, { binding: 4, resource: { ...status } },
      ] });
    }
    const offsets = levels[0]?.offsets ?? buffer(4, 'empty offsets');
    const total = levels.at(-1)?.sums ?? buffer(4, 'empty total', GPUBufferUsage.COPY_DST);
    let destroyed = false;
    return { count, offsets, total, status,
      encode: encoder => {
        if (destroyed) throw new Error('Scan job was destroyed');
        encoder.clearBuffer(status.buffer, status.offset, 4);
        if (!levels.length) { encoder.clearBuffer(total.buffer, total.offset, 4); return; }
        for (const level of levels) {
          const pass = encoder.beginComputePass({ label: 'exclusive scan blocks' });
          pass.setPipeline(this.scan); pass.setBindGroup(0, level.scanGroup); pass.dispatchWorkgroups(level.groups); pass.end();
        }
        for (let i = levels.length - 2; i >= 0; --i) {
          const level = levels[i], pass = encoder.beginComputePass({ label: 'propagate block offsets' });
          pass.setPipeline(this.add); pass.setBindGroup(0, level.addGroup!); pass.dispatchWorkgroups(Math.ceil(level.count / 128)); pass.end();
        }
      },
      destroy: () => { if (!destroyed) { owned.forEach(b => b.destroy()); destroyed = true; } },
    };
  }
}

/** Explicit qualification/export boundary; not part of the resident algorithm. */
export async function inspectScan(device: GPUDevice, job: ExclusiveScanJob): Promise<{ offsets: Uint32Array; total: number; status: number }> {
  const bytes = job.count * 4, staging = device.createBuffer({ size: bytes + 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    if (bytes) encoder.copyBufferToBuffer(job.offsets.buffer, job.offsets.offset, staging, 0, bytes);
    encoder.copyBufferToBuffer(job.total.buffer, job.total.offset, staging, bytes, 4); encoder.copyBufferToBuffer(job.status.buffer, job.status.offset, staging, bytes + 4, 4);
    device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange().slice(0)); staging.unmap();
    return { offsets: words.slice(0, job.count), total: words[job.count], status: words[job.count + 1] };
  } finally { staging.destroy(); }
}
