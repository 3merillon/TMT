/**
 * Bounded staging ring for GPU → CPU readbacks inside the frame encoder (one encoder, one submit).
 *
 *   const p = ring.copy(encoder, src, offset, size);   // null when every slot is busy (never blocks, never grows)
 *   ... submit ...
 *   ring.afterSubmit();                                // maps what this frame copied
 *   const bytes = await p;
 */
import { BufferUsage, MapMode } from './flags';

interface Slot { buffer: GPUBuffer; size: number; state: 'free' | 'copied' | 'mapping'; resolve?: (b: ArrayBuffer) => void; reject?: (e: unknown) => void; bytes: number }

type ReadbackDevice = Pick<GPUDevice, 'createBuffer'>;

export class ReadbackRing {
  private readonly slots: Slot[] = [];
  /** Requests refused because every slot was busy. */
  refused = 0;

  constructor(private readonly device: ReadbackDevice, private readonly options: { slots?: number; slotBytes?: number; label?: string; deferDestroy?: (b: GPUBuffer) => void } = {}) {}

  private slot(bytes: number): Slot | null {
    const max = this.options.slots ?? 4;
    const free = this.slots.find(s => s.state === 'free' && s.size >= bytes);
    if (free) return free;
    if (this.slots.length < max) {
      const size = Math.max(bytes, this.options.slotBytes ?? 256);
      const s: Slot = { buffer: this.device.createBuffer({ label: `${this.options.label ?? 'readback'}:${this.slots.length}`, size, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST }), size, state: 'free', bytes: 0 };
      this.slots.push(s);
      return s;
    }
    // Grow a free-but-too-small slot in place (bounded count, not bounded size).
    const small = this.slots.find(s => s.state === 'free');
    if (!small) return null;
    this.options.deferDestroy?.(small.buffer);
    small.buffer = this.device.createBuffer({ label: `${this.options.label ?? 'readback'}:grown`, size: bytes, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
    small.size = bytes;
    return small;
  }

  /** Encode a copy of `size` bytes (multiple of 4) into a free slot; resolves after afterSubmit() + map. */
  copy(encoder: GPUCommandEncoder, src: GPUBuffer, offset: number, size: number): Promise<ArrayBuffer> | null {
    const bytes = Math.ceil(size / 4) * 4;
    const s = this.slot(bytes);
    if (!s) { this.refused++; return null; }
    encoder.copyBufferToBuffer(src, offset, s.buffer, 0, bytes);
    s.state = 'copied';
    s.bytes = bytes;
    return new Promise<ArrayBuffer>((resolve, reject) => { s.resolve = resolve; s.reject = reject; });
  }

  /** Call right after the submit that carried the copies. */
  afterSubmit(): void {
    for (const s of this.slots) {
      if (s.state !== 'copied') continue;
      s.state = 'mapping';
      s.buffer.mapAsync(MapMode.READ, 0, s.bytes).then(() => {
        const data = s.buffer.getMappedRange(0, s.bytes).slice(0);
        s.buffer.unmap();
        s.state = 'free';
        s.resolve?.(data);
      }, error => {
        s.state = 'free';
        s.reject?.(error);
      });
    }
  }

  /** A copy encoded but never submitted (the frame was abandoned): fail its promise and free the slot. */
  cancelUnsubmitted(reason = 'frame abandoned'): void {
    for (const s of this.slots) if (s.state === 'copied') { s.state = 'free'; s.reject?.(new Error(reason)); }
  }

  get busy(): number { return this.slots.filter(s => s.state !== 'free').length; }

  destroy(deferDestroy: (b: GPUBuffer) => void): void {
    for (const s of this.slots) { s.reject?.(new Error('readback ring destroyed')); deferDestroy(s.buffer); }
    this.slots.length = 0;
  }
}
