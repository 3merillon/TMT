/** Envelopes: ADSR with exponential segments, exponential decay, breakpoint curves, LFOs. */
import { SR, TAU } from './core';

export class Adsr {
  private v = 0; private stage: 0 | 1 | 2 | 3 | 4 = 4; private t = 0;
  constructor(public attack = 0.005, public decay = 0.1, public sustain = 0.7, public release = 0.2, public sr = SR) {}
  on(): void { this.stage = 0; this.t = 0; }
  off(): void { if (this.stage < 3) { this.stage = 3; this.t = 0; } }
  get active(): boolean { return this.stage < 4; }
  run(): number {
    const sr = this.sr;
    switch (this.stage) {
      case 0: { const n = Math.max(1, this.attack * sr); this.v += (1.0 - this.v) * Math.min(1, 1 / n * 2.5); this.t++; if (this.t >= n) { this.stage = 1; this.v = 1; } break; }
      case 1: { const k = 1 - Math.exp(-1 / Math.max(1, this.decay * sr) * 3); this.v += (this.sustain - this.v) * k; if (Math.abs(this.v - this.sustain) < 1e-4) this.stage = 2; break; }
      case 2: this.v = this.sustain; break;
      case 3: { const k = 1 - Math.exp(-1 / Math.max(1, this.release * sr) * 4); this.v -= this.v * k; if (this.v < 1e-4) { this.v = 0; this.stage = 4; } break; }
      default: this.v = 0;
    }
    return this.v;
  }
}
/** value(t) for an exponential decay from 1 reaching -60 dB at `t60` seconds. */
export const expDecay = (t: number, t60: number) => Math.exp(-6.9078 * t / Math.max(1e-4, t60));
/** Piecewise-linear breakpoints [[t, v], ...] (t in seconds, sorted). */
export function breakpoint(points: readonly (readonly [number, number])[]): (t: number) => number {
  return t => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) if (t <= points[i][0]) { const [t0, v0] = points[i - 1], [t1, v1] = points[i]; return v0 + (v1 - v0) * (t - t0) / Math.max(1e-9, t1 - t0); }
    return points[points.length - 1][1];
  };
}
/** Exponential interpolation between breakpoints (for pitch / cutoff sweeps), values must be > 0. */
export function expBreakpoint(points: readonly (readonly [number, number])[]): (t: number) => number {
  return t => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) if (t <= points[i][0]) { const [t0, v0] = points[i - 1], [t1, v1] = points[i]; return v0 * Math.pow(v1 / v0, (t - t0) / Math.max(1e-9, t1 - t0)); }
    return points[points.length - 1][1];
  };
}
export class Lfo {
  phase: number;
  constructor(public rate: number, phase = 0, public sr = SR) { this.phase = phase; }
  sine(): number { this.phase += this.rate / this.sr; if (this.phase >= 1) this.phase -= 1; return Math.sin(TAU * this.phase); }
  tri(): number { this.phase += this.rate / this.sr; if (this.phase >= 1) this.phase -= 1; return 4 * Math.abs(this.phase - 0.5) - 1; }
}
