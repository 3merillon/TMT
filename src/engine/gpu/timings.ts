// Ported from Pinionfall src/gpu/gpu-timings.ts (MIT, same owner)
/**
 * GPU timestamp instrumentation: one query pair per pass name, resolved every frame into a MAP_READ ring (3 slots by
 * default), read back asynchronously — never a stall. A frame whose ring is full is DROPPED (counted in `dropped`), so
 * `dropped > 0` means the averages sample the uncongested frames only (Pinionfall's warning about ring starvation).
 *
 * Adapted per plan §13: no device global, no debug-flags / profiler / frame-capture imports (an optional FrameCapture is
 * passed in), pass names register lazily (the frame graph does not know them up front), and zero deltas are kept
 * (Chrome quantises timestamps, so short passes legitimately read 0 on some frames; dropping them biases averages up).
 *
 * If 'timestamp-query' is unavailable everything is a no-op: getWrites() returns undefined and the pass descriptor
 * spreads to nothing.
 *
 * ⚠ A pass whose descriptor does NOT spread its timestampWrites is silently untimed.
 */
import type { FrameCapture } from './frame-capture';
import { BufferUsage, MapMode } from './flags';

export type TimingsWrites = { querySet: GPUQuerySet; beginningOfPassWriteIndex: number; endOfPassWriteIndex: number };

const ROLLING_FRAMES = 60;
/** A pass without a sample for this many resolved frames reports 0 (it stopped running). Must exceed readback latency. */
const STALE_FRAMES = 40;

interface PassEntry { name: string; beginIdx: number; endIdx: number; rolling: Float64Array; head: number; count: number; lastFrame: number }
interface Slot { buffer: GPUBuffer; state: 'free' | 'pending-submit' | 'pending-map'; written: string[]; frame: number; captureFrame: number }

type TimingsDevice = Pick<GPUDevice, 'createQuerySet' | 'createBuffer' | 'features'>;

export interface GpuTimingsOptions { capacity?: number; ringSize?: number; enabled?: boolean; capture?: () => FrameCapture | null; label?: string }

export class GpuTimings {
  readonly enabled: boolean;
  /** Frames whose samples were dropped because every readback slot was in flight. */
  dropped = 0;
  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuf: GPUBuffer | null = null;
  private readonly slots: Slot[] = [];
  private readonly passes = new Map<string, PassEntry>();
  private readonly order: PassEntry[] = [];
  private readonly capacity: number;
  private nextSlot = 0;
  private pendingSubmit = -1;
  private frameCounter = 0;
  private readonly written = new Set<string>();
  private destroyed = false;

  constructor(device: TimingsDevice, private readonly options: GpuTimingsOptions = {}) {
    this.capacity = options.capacity ?? 64;
    this.enabled = (options.enabled ?? true) && device.features.has('timestamp-query');
    if (!this.enabled) return;
    const label = options.label ?? 'timings';
    this.querySet = device.createQuerySet({ label: `${label}:queries`, type: 'timestamp', count: this.capacity * 2 });
    this.resolveBuf = device.createBuffer({ label: `${label}:resolve`, size: this.capacity * 16, usage: BufferUsage.QUERY_RESOLVE | BufferUsage.COPY_SRC });
    for (let i = 0; i < (options.ringSize ?? 3); i++) {
      this.slots.push({
        buffer: device.createBuffer({ label: `${label}:readback-${i}`, size: this.capacity * 16, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST }),
        state: 'free', written: [], frame: 0, captureFrame: -1,
      });
    }
  }

  private entry(name: string): PassEntry | undefined {
    let e = this.passes.get(name);
    if (e) return e;
    if (this.order.length >= this.capacity) return undefined;
    const i = this.order.length;
    e = { name, beginIdx: i * 2, endIdx: i * 2 + 1, rolling: new Float64Array(ROLLING_FRAMES), head: 0, count: 0, lastFrame: -STALE_FRAMES * 2 };
    this.passes.set(name, e);
    this.order.push(e);
    return e;
  }

  /** timestampWrites for a render or compute pass descriptor, or undefined when timing is off. */
  getWrites(name: string): TimingsWrites | undefined {
    if (!this.enabled || !this.querySet || this.destroyed) return undefined;
    const e = this.entry(name);
    if (!e) return undefined;
    if (this.written.has(name)) return undefined; // one sample per name per frame
    this.written.add(name);
    return { querySet: this.querySet, beginningOfPassWriteIndex: e.beginIdx, endOfPassWriteIndex: e.endIdx };
  }

  /** Encoder side: resolve the queries and copy them into a free slot. Call after all passes, before submit. */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.enabled || !this.querySet || !this.resolveBuf || this.destroyed) return;
    this.frameCounter++;
    if (this.written.size === 0) { this.pendingSubmit = -1; return; }
    let slot = -1;
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.nextSlot + i) % this.slots.length;
      if (this.slots[idx].state === 'free') { slot = idx; break; }
    }
    if (slot < 0) {
      this.dropped++;
      this.written.clear();
      this.pendingSubmit = -1;
      return;
    }
    this.nextSlot = (slot + 1) % this.slots.length;
    const used = this.order.length * 2;
    encoder.resolveQuerySet(this.querySet, 0, used, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, this.slots[slot].buffer, 0, used * 8);
    const s = this.slots[slot];
    s.state = 'pending-submit';
    s.written = [...this.written];
    s.frame = this.frameCounter;
    s.captureFrame = -1;
    const capture = this.options.capture?.();
    if (capture && capture.frame < capture.capacity) { s.captureFrame = capture.frame; capture.pendingGpu++; }
    this.written.clear();
    this.pendingSubmit = slot;
  }

  /** Post-submit: map the slot resolved this frame. mapAsync must follow the submit that wrote the buffer. */
  kickReadback(): void {
    if (!this.enabled) return;
    const slotIndex = this.pendingSubmit;
    this.pendingSubmit = -1;
    if (slotIndex < 0) return;
    const s = this.slots[slotIndex];
    s.state = 'pending-map';
    const capture = s.captureFrame >= 0 ? this.options.capture?.() ?? null : null;
    const captureFrame = s.captureFrame;
    s.buffer.mapAsync(MapMode.READ).then(() => {
      if (this.destroyed) return;
      const view = new BigUint64Array(s.buffer.getMappedRange().slice(0));
      s.buffer.unmap();
      s.state = 'free';
      for (const name of s.written) {
        const e = this.passes.get(name);
        if (!e) continue;
        const b = view[e.beginIdx], en = view[e.endIdx];
        if (en < b) continue;
        const ns = Number(en - b);
        if (ns > 1e9) continue; // garbage (queries from a different frame)
        capture?.write(`gpu/${name}`, captureFrame, ns / 1e6);
        e.rolling[e.head] = ns;
        e.head = (e.head + 1) % ROLLING_FRAMES;
        if (e.count < ROLLING_FRAMES) e.count++;
        e.lastFrame = s.frame;
      }
    }).catch(() => {
      s.state = 'free';
      if (capture) capture.droppedGpu++;
    }).finally(() => { if (capture) capture.pendingGpu--; });
  }

  /** Rolling average in ms; 0 with no samples or when stale. */
  getRollingMs(name: string): number {
    const e = this.passes.get(name);
    if (!e || e.count === 0) return 0;
    if (this.frameCounter - e.lastFrame > STALE_FRAMES) return 0;
    let sum = 0;
    for (let i = 0; i < e.count; i++) sum += e.rolling[i];
    return sum / e.count / 1e6;
  }

  /** All passes (registration order) with their rolling ms. */
  getAll(): { name: string; ms: number }[] {
    return this.order.map(e => ({ name: e.name, ms: this.getRollingMs(e.name) }));
  }

  /** Sum of every pass's rolling ms. */
  total(): number { return this.order.reduce((a, e) => a + this.getRollingMs(e.name), 0); }

  destroy(deferDestroy: (r: GPUBuffer | GPUQuerySet) => void): void {
    this.destroyed = true;
    if (this.querySet) deferDestroy(this.querySet);
    if (this.resolveBuf) deferDestroy(this.resolveBuf);
    for (const s of this.slots) deferDestroy(s.buffer);
    this.slots.length = 0;
  }
}
