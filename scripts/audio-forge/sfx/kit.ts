/** Offline SFX building blocks (mono, 48 kHz): shaped noise bands, swept tones, struck-metal partials, tick trains,
 * resonators, saturation, reverb tails and mixing. Every design in designs.ts is a few of these summed. */
import { SR, TAU, type Mono, mono, Rng, addInto, clamp } from '../dsp/core';
import { Biquad, OnePole, type BiquadType } from '../dsp/filters';
import { Noise, Osc } from '../dsp/osc';
import { fdnReverb, type ReverbSpec, shape, shapers } from '../dsp/fx';

export const n = (seconds: number) => Math.round(seconds * SR);
const t60 = (t: number, s: number) => Math.exp(-6.9078 * t / Math.max(1e-4, s));
/** Attack (linear or swell) → optional hold → exponential decay to −60 dB at `dur`. */
export function envelope(len: number, attack: number, hold: number, dur: number, swell = false): Float32Array {
  const e = new Float32Array(len), a = Math.max(1, n(attack)), h = n(hold), d = Math.max(1, n(dur) - a - h);
  for (let i = 0; i < len; i++) e[i] = i < a ? (swell ? Math.pow(i / a, 2.5) : i / a) : i < a + h ? 1 : t60((i - a - h) / SR, d / SR);
  return e;
}
export function noiseBand(seed: number, len: number, o: { color?: 'white' | 'pink' | 'brown'; filter?: BiquadType; f0: number; f1?: number; q?: number; fMid?: number; midAt?: number; attack?: number; hold?: number; dur?: number; swell?: boolean; peak?: number; stages?: number }): Mono {
  const out = mono(len), nz = new Noise(seed), fl = Array.from({ length: o.stages ?? 1 }, () => new Biquad(o.filter ?? 'bandpass', o.f0, o.q ?? 1));
  const f1 = o.f1 ?? o.f0, env = envelope(len, o.attack ?? 0.003, o.hold ?? 0, o.dur ?? len / SR, o.swell);
  for (let i = 0; i < len; i++) {
    const p = i / len;
    const f = o.fMid !== undefined && o.midAt !== undefined ? (p < o.midAt ? o.f0 * Math.pow(o.fMid / o.f0, p / o.midAt) : o.fMid * Math.pow(f1 / o.fMid, (p - o.midAt) / (1 - o.midAt))) : o.f0 * Math.pow(f1 / o.f0, p);
    if (i % 32 === 0) for (const b of fl) b.set(o.filter ?? 'bandpass', f, o.q ?? 1);
    let v = o.color === 'pink' ? nz.pink() : o.color === 'brown' ? nz.brown() : nz.white();
    for (const b of fl) v = b.run(v);
    out[i] = v * env[i] * (o.peak ?? 1);
  }
  return out;
}
export function toneSweep(len: number, o: { wave?: 'sine' | 'saw' | 'square' | 'triangle'; f0: number; f1?: number; attack?: number; hold?: number; dur?: number; swell?: boolean; peak?: number; vibrato?: [number, number]; curve?: number }): Mono {
  const out = mono(len), osc = new Osc(o.f0), env = envelope(len, o.attack ?? 0.003, o.hold ?? 0, o.dur ?? len / SR, o.swell), f1 = o.f1 ?? o.f0;
  for (let i = 0; i < len; i++) {
    const p = Math.pow(i / len, o.curve ?? 1), t = i / SR;
    osc.freq = o.f0 * Math.pow(f1 / o.f0, p) * (o.vibrato ? Math.pow(2, o.vibrato[1] * Math.sin(TAU * o.vibrato[0] * t) / 1200) : 1);
    const v = o.wave === 'saw' ? osc.saw() : o.wave === 'square' ? osc.pulse(0.5) : o.wave === 'triangle' ? osc.triangle() : osc.sine();
    out[i] = v * env[i] * (o.peak ?? 1);
  }
  return out;
}
export const METAL = [1, 2.76, 5.4, 8.9, 13.3] as const;
/** Struck metal: inharmonic partials with per-partial decay (higher partials die faster) and a 2 ms attack. */
export function partials(len: number, f: number, ratios: readonly number[], peaks: readonly number[], decay: number, o: { detune?: number; seed?: number } = {}): Mono {
  const out = mono(len), rng = new Rng(o.seed ?? 1);
  for (let k = 0; k < ratios.length; k++) {
    const fk = f * ratios[k] * (1 + (o.detune ?? 0) * rng.signed()); if (fk > 18000) continue;
    const ph0 = rng.next(), d = decay / (1 + 0.6 * k);
    for (let i = 0; i < len; i++) { const t = i / SR; out[i] += Math.sin(TAU * (fk * t + ph0)) * peaks[k] * t60(t, d) * Math.min(1, t / 0.002); }
  }
  return out;
}
export function ticks(seed: number, len: number, o: { count: number; t0: number; t1: number; density?: number; fLo: number; fHi: number; dLo: number; dHi: number; pLo: number; pHi: number; fade?: number; color?: 'white' | 'brown' | 'pink'; q?: number; filter?: BiquadType }): Mono {
  const out = mono(len), rng = new Rng(seed), nz = new Noise(seed ^ 0x55), times: number[] = [];
  for (let i = 0; i < o.count; i++) times.push(o.t0 + (o.t1 - o.t0) * Math.pow(rng.next(), o.density ?? 1));
  times.sort((a, b) => a - b);
  for (const t of times) {
    const f = rng.range(o.fLo, o.fHi), dur = rng.range(o.dLo, o.dHi), age = (t - o.t0) / Math.max(1e-6, o.t1 - o.t0);
    const pk = rng.range(o.pLo, o.pHi) * (1 - (o.fade ?? 0) * clamp(age, 0, 1)), b = new Biquad(o.filter ?? 'bandpass', f, o.q ?? 3), at = n(t), L = n(dur);
    for (let i = 0; i < L && at + i < len; i++) { const v = o.color === 'brown' ? nz.brown() : o.color === 'pink' ? nz.pink() : nz.white(); out[at + i] += b.run(v) * pk * Math.min(1, i / 24) * t60(i / SR, dur); }
  }
  return out;
}
/** Capacitor whine: a saw sweeping through a resonant low-pass that tracks it. */
export function whine(len: number, f0: number, f1: number, dur: number, peak: number, q = 9): Mono {
  const out = mono(len), osc = new Osc(f0), lp = new Biquad('lowpass', f0 * 2.5, q), env = envelope(len, 0.02, 0, dur);
  for (let i = 0; i < len; i++) { const f = f0 * Math.pow(f1 / f0, i / len); osc.freq = f; if (i % 16 === 0) lp.set('lowpass', Math.min(16000, f * 2.5), q); out[i] = lp.run(osc.saw()) * env[i] * peak; }
  return out;
}
/** Ring-modulated band noise (electric tail). */
export function ring(seed: number, len: number, carrier: number, f: number, q: number, dur: number, peak: number): Mono {
  const out = mono(len), nz = new Noise(seed), bp = new Biquad('bandpass', f, q), env = envelope(len, 0.005, 0, dur);
  for (let i = 0; i < len; i++) out[i] = bp.run(nz.white()) * Math.sin(TAU * carrier * i / SR) * env[i] * peak * 3;
  return out;
}
/** Resonant metal tearing: noise through a sweeping high-Q band-pass with a wobble. */
export function tear(seed: number, len: number, f0: number, f1: number, dur: number, peak: number, q = 10, wobble = 7): Mono {
  const out = mono(len), nz = new Noise(seed), bp = new Biquad('bandpass', f0, q), env = envelope(len, 0.01, 0, dur);
  for (let i = 0; i < len; i++) { const t = i / SR; if (i % 16 === 0) bp.set('bandpass', f0 * Math.pow(f1 / f0, i / len) * (1 + 0.08 * Math.sin(TAU * wobble * t)), q); out[i] = bp.run(nz.white()) * env[i] * peak * 3; }
  return out;
}
export function mix(len: number, ...layers: (readonly [Mono, number, number?])[]): Mono {
  const out = mono(len);
  for (const [buf, gain, delay] of layers) addInto(out, buf, n(delay ?? 0), gain);
  return out;
}
export function filter(buf: Mono, type: BiquadType, f: number, q = 0.7, gainDb = 0): Mono { new Biquad(type, f, q, gainDb).process(buf); return buf; }
export function sat(buf: Mono, drive: number): Mono { return shape(buf, shapers.tanh(drive)); }
export function tube(buf: Mono, drive: number): Mono { return shape(buf, shapers.tube(drive, 0.1)); }
/** Adds a reverb tail (mono fold of the FDN) at `mixGain`. */
export function tail(buf: Mono, spec: ReverbSpec, mixGain: number, seed = 5): Mono {
  const wet = fdnReverb([buf, buf], spec, seed);
  for (let i = 0; i < buf.length; i++) buf[i] += (wet[0][i] + wet[1][i]) * 0.5 * mixGain;
  return buf;
}
export function normalize(buf: Mono, peak = 0.89): Mono { let p = 0; for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i])); if (p > 1e-9) { const g = peak / p; for (let i = 0; i < buf.length; i++) buf[i] *= g; } return buf; }
export function edges(buf: Mono, inSec = 0.001, outSec = 0.02): Mono { const a = n(inSec), b = n(outSec); for (let i = 0; i < a && i < buf.length; i++) buf[i] *= i / a; for (let i = 0; i < b && i < buf.length; i++) buf[buf.length - 1 - i] *= i / b; return buf; }
/** Trims trailing near-silence (keeping 30 ms) so sprites stay compact. */
export function trim(buf: Mono, floor = 0.0025): Mono {
  // End where a 20 ms window stays under the floor (peak-based), keeping 40 ms after it for a clean fade.
  const w = n(0.02); let end = buf.length;
  while (end > w) { let p = 0; for (let i = end - w; i < end; i++) p = Math.max(p, Math.abs(buf[i])); if (p >= floor) break; end -= w; }
  return buf.slice(0, Math.min(buf.length, end + n(0.04)));
}
/** Makes a buffer loop seamlessly: crossfades the last `fade` seconds into the start and cuts them. */
export function loopable(buf: Mono, fade = 0.05): Mono {
  const f = n(fade), len = buf.length - f, out = mono(len);
  for (let i = 0; i < len; i++) out[i] = buf[i];
  for (let i = 0; i < f; i++) { const t = i / f; out[i] = out[i] * t + buf[len + i] * (1 - t); }
  return out;
}
/** Low-pass by one-pole chain (cheap "distance" darkening). */
export function dull(buf: Mono, cutoff: number, stages = 2): Mono { for (let s = 0; s < stages; s++) { const lp = new OnePole(cutoff); for (let i = 0; i < buf.length; i++) buf[i] = lp.run(buf[i]); } return buf; }
export { addInto };
