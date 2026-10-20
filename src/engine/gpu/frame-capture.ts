// Ported from Pinionfall src/gpu/frame-capture.ts (MIT, same owner)
/**
 * Bounded, opt-in frame capture. GPU samples belong to the SUBMISSION frame, never to the frame on which mapAsync happens
 * to complete. Missing samples stay null (never zero).
 *
 * Adapted per plan §13: the "active capture" is owned by a FrameCaptureController instance (one per engine), not a
 * module global.
 */
export function sampleStats(values: readonly number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    samples: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1],
  };
}

export class FrameCapture {
  frame = 0;
  pendingGpu = 0;
  droppedGpu = 0;
  sealed = false;
  private readonly series = new Map<string, Float64Array>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20000) throw new Error('Capture needs 1..20000 frames');
  }

  write(name: string, frame: number, value: number, missing = NaN): void {
    if (frame < 0 || frame >= this.capacity || !Number.isFinite(value)) return;
    let values = this.series.get(name);
    if (!values) {
      values = new Float64Array(this.capacity).fill(missing);
      this.series.set(name, values);
    }
    values[frame] = value;
  }

  cpu(timings: ReadonlyMap<string, number>, counts: ReadonlyMap<string, number>, gauges: ReadonlyMap<string, number>): void {
    if (this.sealed || this.frame >= this.capacity) return;
    for (const [name, value] of timings) this.write(`cpu/${name}`, this.frame, value, 0);
    for (const [name, value] of counts) this.write(`count/${name}`, this.frame, value, 0);
    for (const [name, value] of gauges) this.write(`gauge/${name}`, this.frame, value);
    this.frame++;
  }

  dump() {
    const ends = this.series.get('gpuStamp/end_ms');
    if (ends) for (let i = 1; i < this.frame; i++) this.write('gpu/framePeriod', i, ends[i] - ends[i - 1]);
    const series: Record<string, (number | null)[]> = {};
    const stats: Record<string, ReturnType<typeof sampleStats>> = {};
    for (const [key, data] of this.series) {
      const samples = Array.from(data.subarray(0, this.frame));
      series[key] = samples.map(v => Number.isFinite(v) ? v : null);
      stats[key] = sampleStats(samples);
    }
    return { frames: this.frame, capacity: this.capacity, pendingGpu: this.pendingGpu, droppedGpu: this.droppedGpu, stats, series };
  }
}

export type CaptureTicket = { capture: FrameCapture; frame: number };

/** Owns at most one active capture. */
export class FrameCaptureController {
  private active: FrameCapture | null = null;

  get current(): FrameCapture | null { return this.active; }

  begin(frames: number): FrameCapture {
    if (this.active) throw new Error('A frame capture is already active');
    this.active = new FrameCapture(frames);
    return this.active;
  }

  seal(): FrameCapture | null {
    const capture = this.active;
    if (capture) capture.sealed = true;
    this.active = null;
    return capture;
  }

  cpuFrame(timings: ReadonlyMap<string, number>, counts: ReadonlyMap<string, number>, gauges: ReadonlyMap<string, number>): void {
    this.active?.cpu(timings, counts, gauges);
  }

  scheduleGpu(): CaptureTicket | null {
    const a = this.active;
    if (!a || a.frame >= a.capacity) return null;
    a.pendingGpu++;
    return { capture: a, frame: a.frame };
  }

  dropGpu(): void { if (this.active) this.active.droppedGpu++; }
}
