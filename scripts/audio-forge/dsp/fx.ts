/** Effects: waveshaping with oversampling, delays, chorus, an FDN reverb, bitcrush, stereo tools, tape-ish saturation. */
import { SR, type Mono, type Stereo, mono, stereo, clamp, Rng } from './core';
import { Biquad, OnePole, fir, sincKernel } from './filters';

// ---- Waveshaping -------------------------------------------------------------------------------------------------------
export type Shaper = (x: number) => number;
export const shapers = {
  tanh: (drive: number): Shaper => x => Math.tanh(x * drive) / Math.tanh(Math.min(drive, 4)),
  /** Asymmetric tube-ish: softer on the positive half, harder negative, plus a bias so even harmonics appear. */
  tube: (drive: number, bias = 0.12): Shaper => x => { const v = x * drive + bias; const y = v >= 0 ? Math.tanh(v) : Math.tanh(v * 1.3) / 1.3; return (y - Math.tanh(bias)) / Math.tanh(Math.min(drive, 4)); },
  /** Hard-ish clip with rounded knee (diode-like). */
  diode: (drive: number): Shaper => x => { const v = x * drive; const a = Math.abs(v); const y = a < 0.6 ? v : Math.sign(v) * (0.6 + (1 - 0.6) * Math.tanh((a - 0.6) / (1 - 0.6))); return y; },
  fold: (drive: number): Shaper => x => { let v = x * drive; while (v > 1 || v < -1) v = v > 1 ? 2 - v : -2 - v; return v; },
  /** Rectifier blend for octave-up fizz. */
  rect: (amount: number): Shaper => x => x * (1 - amount) + Math.abs(x) * amount * 2 - amount,
};
let OS_KERNEL: Float64Array | null = null;
/** 4x oversampled nonlinearity: zero-stuff → FIR lowpass → shaper → FIR lowpass → decimate. Offline cost is fine. */
export function oversampledShape(a: Mono, shaper: Shaper, factor = 4): Mono {
  OS_KERNEL ??= sincKernel(0.5 / 4 * 0.92, 47);
  const k = OS_KERNEL, n = a.length, up = new Float32Array(n * factor);
  for (let i = 0; i < n; i++) up[i * factor] = a[i] * factor;
  const upF = fir(up, k);
  for (let i = 0; i < upF.length; i++) upF[i] = shaper(upF[i]);
  const downF = fir(upF, k), out = mono(n);
  for (let i = 0; i < n; i++) out[i] = downF[i * factor];
  return out;
}
export function shape(a: Mono, shaper: Shaper): Mono { for (let i = 0; i < a.length; i++) a[i] = shaper(a[i]); return a; }

// ---- Delays ------------------------------------------------------------------------------------------------------------
export class DelayLine {
  private buf: Float32Array; private w = 0;
  constructor(maxSamples: number) { this.buf = new Float32Array(Math.max(2, Math.ceil(maxSamples) + 2)); }
  write(x: number): void { this.buf[this.w] = x; this.w = (this.w + 1) % this.buf.length; }
  /** Read `d` samples behind the write head (fractional, linear). */
  read(d: number): number {
    const n = this.buf.length, pos = this.w - 1 - d, i0 = Math.floor(pos), frac = pos - i0;
    const a = this.buf[((i0 % n) + n) % n], b = this.buf[(((i0 + 1) % n) + n) % n];
    return a + (b - a) * frac;
  }
  readInt(d: number): number { const n = this.buf.length; return this.buf[(((this.w - 1 - d) % n) + n) % n]; }
}
/** Stereo ping-pong delay with damping and feedback; returns wet signal only. */
export function pingPong(src: Stereo, timeL: number, timeR: number, feedback = 0.4, damp = 3500, mix = 1): Stereo {
  const n = src[0].length, out = stereo(n), dl = new DelayLine(timeL * SR + 8), dr = new DelayLine(timeR * SR + 8);
  const lpL = new OnePole(damp), lpR = new OnePole(damp);
  let fbL = 0, fbR = 0;
  for (let i = 0; i < n; i++) {
    const l = src[0][i] + fbR * feedback, r = src[1][i] + fbL * feedback;
    dl.write(l); dr.write(r);
    fbL = lpL.run(dl.read(timeL * SR)); fbR = lpR.run(dr.read(timeR * SR));
    out[0][i] = fbL * mix; out[1][i] = fbR * mix;
  }
  return out;
}
/** Chorus/doubler: modulated short delays, stereo, returns wet. */
export function chorus(src: Mono, rate = 0.8, depthMs = 4, baseMs = 12, seed = 1): Stereo {
  const n = src.length, out = stereo(n), d = new DelayLine((baseMs + depthMs) * SR / 1000 + 8), rng = new Rng(seed), ph0 = rng.next();
  for (let i = 0; i < n; i++) {
    d.write(src[i]);
    const t = i / SR;
    const mL = Math.sin((t * rate + ph0) * Math.PI * 2), mR = Math.sin((t * rate * 1.07 + ph0 + 0.3) * Math.PI * 2);
    out[0][i] = d.read((baseMs + depthMs * (0.5 + 0.5 * mL)) * SR / 1000);
    out[1][i] = d.read((baseMs + depthMs * (0.5 + 0.5 * mR)) * SR / 1000);
  }
  return out;
}

// ---- Reverb (8-line FDN with Hadamard feedback, damping, pre-delay) -------------------------------------------------------
export interface ReverbSpec { seconds: number; damp?: number; preDelayMs?: number; size?: number; lowCut?: number; highCut?: number; modulate?: number }
export function fdnReverb(src: Stereo, spec: ReverbSpec, seed = 7): Stereo {
  const n = src[0].length, N = 8, rng = new Rng(seed);
  const size = spec.size ?? 1;
  const base = [1117, 1237, 1381, 1493, 1657, 1789, 1931, 2053].map(v => Math.round(v * size * (SR / 44100)));
  const lines = base.map(len => new DelayLine(len + 64)), lens = base.map(len => len + rng.int(13));
  const damps = lens.map(() => new OnePole(spec.damp ?? 4500));
  const g = lens.map(len => Math.pow(10, -3 * len / SR / Math.max(0.05, spec.seconds)));
  const pre = Math.round((spec.preDelayMs ?? 10) * SR / 1000), preL = new DelayLine(pre + 4), preR = new DelayLine(pre + 4);
  const hp = new Biquad('highpass', spec.lowCut ?? 120, 0.7), hpR = new Biquad('highpass', spec.lowCut ?? 120, 0.7);
  const lp = new Biquad('lowpass', spec.highCut ?? 9000, 0.7), lpR = new Biquad('lowpass', spec.highCut ?? 9000, 0.7);
  const out = stereo(n), state = new Float64Array(N), mixed = new Float64Array(N);
  const mod = spec.modulate ?? 0.3, modRates = lens.map(() => 0.1 + rng.next() * 0.4), modPh = lens.map(() => rng.next());
  // Hadamard 8x8 (normalised).
  const H: number[][] = [];
  for (let i = 0; i < N; i++) { H.push([]); for (let j = 0; j < N; j++) { let bits = i & j, p = 0; while (bits) { p ^= bits & 1; bits >>= 1; } H[i].push((p ? -1 : 1) / Math.sqrt(N)); } }
  for (let i = 0; i < n; i++) {
    preL.write(src[0][i]); preR.write(src[1][i]);
    const inL = hp.run(preL.readInt(pre)), inR = hpR.run(preR.readInt(pre));
    const t = i / SR;
    for (let k = 0; k < N; k++) { const d = lens[k] + mod * 6 * Math.sin((t * modRates[k] + modPh[k]) * Math.PI * 2); state[k] = damps[k].run(lines[k].read(d)); }
    for (let k = 0; k < N; k++) { let acc = 0; for (let j = 0; j < N; j++) acc += H[k][j] * state[j]; mixed[k] = acc * g[k]; }
    for (let k = 0; k < N; k++) lines[k].write(mixed[k] + (k % 2 === 0 ? inL : inR) * 0.5);
    let l = 0, r = 0;
    for (let k = 0; k < N; k++) { if (k % 2 === 0) l += state[k]; else r += state[k]; }
    out[0][i] = lp.run(l * 0.5); out[1][i] = lpR.run(r * 0.5);
  }
  return out;
}
/** Convenience: dry + wet at `mix`, wet decorrelated by the FDN. */
export function reverbMix(src: Stereo, spec: ReverbSpec, mix: number, seed = 7): Stereo {
  const wet = fdnReverb(src, spec, seed), out = stereo(src[0].length);
  for (let c = 0; c < 2; c++) for (let i = 0; i < out[0].length; i++) out[c][i] = src[c][i] + wet[c][i] * mix;
  return out;
}

// ---- Lo-fi / character --------------------------------------------------------------------------------------------------
export function bitcrush(a: Mono, bits = 8, downsample = 1): Mono {
  const levels = Math.pow(2, bits), hold = Math.max(1, Math.round(downsample));
  let last = 0;
  for (let i = 0; i < a.length; i++) { if (i % hold === 0) last = Math.round(a[i] * levels) / levels; a[i] = last; }
  return a;
}
/** Tape-ish: gentle HF roll + soft saturation + low shelf. */
export function tape(a: Mono, drive = 1.2): Mono {
  const lp = new Biquad('lowpass', 16000, 0.6), sh = new Biquad('lowshelf', 90, 0.7, 1.5);
  for (let i = 0; i < a.length; i++) a[i] = sh.run(lp.run(Math.tanh(a[i] * drive) / Math.tanh(drive)));
  return a;
}
/** Mid/side width (1 = unchanged, 0 = mono, 1.6 = wide). */
export function width(s: Stereo, w: number): Stereo {
  for (let i = 0; i < s[0].length; i++) { const m = (s[0][i] + s[1][i]) * 0.5, sd = (s[0][i] - s[1][i]) * 0.5 * w; s[0][i] = m + sd; s[1][i] = m - sd; }
  return s;
}
/** Haas doubler: a short delayed copy on the other side. */
export function haas(m: Mono, ms = 14, level = 0.7): Stereo {
  const d = Math.round(ms * SR / 1000), out = stereo(m.length);
  for (let i = 0; i < m.length; i++) { out[0][i] = m[i]; out[1][i] = (i >= d ? m[i - d] : 0) * level; }
  return out;
}
export function tremolo(a: Mono, rate: number, depth = 0.5, shape: 'sine' | 'square' = 'sine'): Mono {
  for (let i = 0; i < a.length; i++) { const ph = (i / SR) * rate % 1; const m = shape === 'sine' ? 0.5 + 0.5 * Math.sin(ph * Math.PI * 2) : ph < 0.5 ? 1 : 0; a[i] *= 1 - depth + depth * m; }
  return a;
}
/** Sidechain-style ducking: gain follows an envelope of `key`, dipping by `depth` with attack/release (seconds). */
export function duckBy(target: Stereo, key: Mono, depth = 0.5, attack = 0.004, release = 0.12): Stereo {
  let env = 0; const ka = 1 - Math.exp(-1 / (attack * SR)), kr = 1 - Math.exp(-1 / (release * SR));
  for (let i = 0; i < target[0].length; i++) {
    const x = Math.abs(key[i] ?? 0);
    env += (x > env ? ka : kr) * (x - env);
    const g = 1 - depth * clamp(env * 2.5, 0, 1);
    target[0][i] *= g; target[1][i] *= g;
  }
  return target;
}
