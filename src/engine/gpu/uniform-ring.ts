/**
 * Per-frame uniform ring: SEGMENTS (3) buffers of SEGMENT_BYTES (1 MiB), allocations aligned to 256 B (the WebGPU
 * minUniformBufferOffsetAlignment ceiling), so any allocation binds as `{ buffer, offset, size }` or through a dynamic
 * offset. Frame N writes segment N % 3, which is not touched again until frame N + 3.
 *
 * Writes go to a CPU staging copy and reach the GPU in ONE queue.writeBuffer per frame (`flush`, called by the engine
 * right before submit), which is ordered before the frame's command buffer.
 */
import { BufferUsage } from './flags';

export const UNIFORM_RING_SEGMENTS = 3;
export const UNIFORM_RING_SEGMENT_BYTES = 1 << 20;
export const UNIFORM_ALIGN = 256;

export interface UniformAllocation {
  readonly buffer: GPUBuffer;
  readonly offset: number;
  readonly size: number;
  /** Float32 view over the allocation's staging bytes (write here, then flush). */
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
}

type RingDevice = Pick<GPUDevice, 'createBuffer'> & { queue: Pick<GPUQueue, 'writeBuffer'> };

export class UniformRing {
  readonly buffers: GPUBuffer[] = [];
  private readonly staging: ArrayBuffer[] = [];
  private segment = 0;
  private cursor = 0;
  private high = 0;
  /** Largest bytes used in any frame so far (telemetry). */
  peakBytes = 0;
  private readonly device: RingDevice;

  constructor(device: RingDevice, private readonly segmentBytes = UNIFORM_RING_SEGMENT_BYTES, segments = UNIFORM_RING_SEGMENTS, private readonly align = UNIFORM_ALIGN) {
    if (segmentBytes % align !== 0) throw new Error('UniformRing: segment size must be a multiple of the alignment');
    this.device = device;
    for (let i = 0; i < segments; i++) {
      this.buffers.push(device.createBuffer({ label: `uniform-ring:${i}`, size: segmentBytes, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }));
      this.staging.push(new ArrayBuffer(segmentBytes));
    }
  }

  get segmentIndex(): number { return this.segment; }
  get usedBytes(): number { return this.cursor; }

  /** Rotate to the next segment (start of a frame). */
  beginFrame(): void {
    this.segment = (this.segment + 1) % this.buffers.length;
    this.cursor = 0;
    this.high = 0;
  }

  /** Reserve `size` bytes in this frame's segment. Throws when the segment is full (never silently wraps). */
  alloc(size: number): UniformAllocation {
    if (!(size > 0)) throw new Error('UniformRing: size must be positive');
    const offset = this.cursor;
    const reserved = Math.ceil(size / this.align) * this.align;
    if (offset + reserved > this.segmentBytes) throw new Error(`UniformRing: frame segment full (${offset + reserved} > ${this.segmentBytes})`);
    this.cursor += reserved;
    this.high = Math.max(this.high, offset + size);
    if (this.cursor > this.peakBytes) this.peakBytes = this.cursor;
    const words = Math.ceil(size / 4);
    const stage = this.staging[this.segment];
    return { buffer: this.buffers[this.segment], offset, size, f32: new Float32Array(stage, offset, words), u32: new Uint32Array(stage, offset, words) };
  }

  /** alloc + copy. */
  write(data: ArrayBufferView): UniformAllocation {
    const a = this.alloc(data.byteLength);
    new Uint8Array(a.f32.buffer, a.offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return a;
  }

  /** Upload this frame's used range (one writeBuffer). */
  flush(): void {
    if (this.high === 0) return;
    const bytes = Math.ceil(this.high / 4) * 4;
    this.device.queue.writeBuffer(this.buffers[this.segment], 0, this.staging[this.segment], 0, bytes);
    this.high = 0;
  }

  destroy(deferDestroy: (b: GPUBuffer) => void): void {
    for (const b of this.buffers) deferDestroy(b);
    this.buffers.length = 0;
  }
}
