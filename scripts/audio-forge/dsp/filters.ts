/** Filters for the forge: RBJ biquads, one-poles, a drive-capable state-variable filter, DC block, LR4 crossover. */
import { SR, TAU, type Mono } from './core';

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'peaking' | 'lowshelf' | 'highshelf' | 'allpass';

export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(type?: BiquadType, f?: number, q = 0.7071, gainDb = 0, sr = SR) { if (type && f !== undefined) this.set(type, f, q, gainDb, sr); }
  set(type: BiquadType, f: number, q = 0.7071, gainDb = 0, sr = SR): this {
    const w = TAU * Math.min(Math.max(f, 5), sr * 0.49) / sr, cs = Math.cos(w), sn = Math.sin(w);
    const A = Math.pow(10, gainDb / 40), alpha = sn / (2 * Math.max(1e-4, q));
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (type) {
      case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * cs; b2 = 1; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'allpass': b0 = 1 - alpha; b1 = -2 * cs; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha; break;
      case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A; break;
      case 'lowshelf': { const s2 = 2 * Math.sqrt(A) * alpha; b0 = A * ((A + 1) - (A - 1) * cs + s2); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s2); a0 = (A + 1) + (A - 1) * cs + s2; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s2; break; }
      case 'highshelf': { const s2 = 2 * Math.sqrt(A) * alpha; b0 = A * ((A + 1) + (A - 1) * cs + s2); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s2); a0 = (A + 1) - (A - 1) * cs + s2; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s2; break; }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  process(a: Mono): Mono { for (let i = 0; i < a.length; i++) a[i] = this.run(a[i]); return a; }
}
/** Applies a chain of biquad settings to a copy-free buffer. */
export function eq(a: Mono, stages: readonly [BiquadType, number, number?, number?][]): Mono {
  for (const [type, f, q, g] of stages) new Biquad(type, f, q ?? 0.7071, g ?? 0).process(a);
  return a;
}
export function eqStereo(a: [Mono, Mono], stages: readonly [BiquadType, number, number?, number?][]): [Mono, Mono] { eq(a[0], stages); eq(a[1], stages); return a; }

export class OnePole {
  private y = 0; private k = 1;
  constructor(cutoff = 1000, sr = SR) { this.setCutoff(cutoff, sr); }
  setCutoff(f: number, sr = SR): void { this.k = 1 - Math.exp(-TAU * Math.min(Math.max(f, 1), sr * 0.49) / sr); }
  run(x: number): number { this.y += this.k * (x - this.y); return this.y; }
  /** High-pass complement. */
  runHp(x: number): number { return x - this.run(x); }
  reset(): void { this.y = 0; }
}
export class DcBlock {
  private x1 = 0; private y1 = 0; private readonly r: number;
  constructor(f = 10, sr = SR) { this.r = 1 - TAU * f / sr; }
  run(x: number): number { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
}
/** Cytomic/Simper trapezoidal SVF: lowpass/highpass/bandpass outputs, optional drive in the loop. Cutoff set per sample is cheap. */
export class Svf {
  private ic1 = 0; private ic2 = 0;
  private g = 0; private k = 1; private a1 = 0; private a2 = 0; private a3 = 0;
  lp = 0; hp = 0; bp = 0;
  constructor(cutoff = 1000, resonance = 0.5, sr = SR) { this.set(cutoff, resonance, sr); }
  /** resonance in [0, 1): 0 = Butterworth-ish, 0.95 = screaming. */
  set(cutoff: number, resonance: number, sr = SR): void {
    this.g = Math.tan(Math.PI * Math.min(Math.max(cutoff, 10), sr * 0.45) / sr);
    this.k = 2 - 2 * Math.min(0.995, Math.max(0, resonance));
    this.a1 = 1 / (1 + this.g * (this.g + this.k)); this.a2 = this.g * this.a1; this.a3 = this.g * this.a2;
  }
  run(x: number): number {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v2;
  }
  reset(): void { this.ic1 = this.ic2 = 0; this.lp = this.hp = this.bp = 0; }
}
/** Linkwitz-Riley 4th order crossover: returns [low, high] (sum is flat). */
export function crossoverLR4(a: Mono, f: number): [Mono, Mono] {
  const low = new Float32Array(a), high = new Float32Array(a);
  new Biquad('lowpass', f, 0.7071).process(low); new Biquad('lowpass', f, 0.7071).process(low);
  new Biquad('highpass', f, 0.7071).process(high); new Biquad('highpass', f, 0.7071).process(high);
  return [low, high];
}
/** Windowed-sinc FIR low-pass kernel (odd length), normalised to unity DC gain. */
export function sincKernel(cutoffNorm: number, taps: number): Float64Array {
  const n = taps | 1, k = new Float64Array(n), mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid, s = x === 0 ? 2 * cutoffNorm : Math.sin(TAU * cutoffNorm * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(TAU * i / (n - 1)) + 0.08 * Math.cos(2 * TAU * i / (n - 1));
    k[i] = s * w; sum += k[i];
  }
  for (let i = 0; i < n; i++) k[i] /= sum;
  return k;
}
export function fir(a: Mono, k: Float64Array): Mono {
  const out = new Float32Array(a.length), n = k.length, mid = (n - 1) >> 1;
  for (let i = 0; i < a.length; i++) {
    let acc = 0;
    const from = Math.max(0, i - mid), to = Math.min(a.length - 1, i + mid);
    for (let j = from; j <= to; j++) acc += a[j] * k[mid + i - j];
    out[i] = acc;
  }
  return out;
}
