/**
 * TMT audio forge: core types and helpers for the offline renderer (Node, pure TypeScript, no WebAudio).
 * Everything renders at SR = 48 kHz in Float32Array channels; math runs in doubles.
 */
export const SR = 48000;
export const TAU = Math.PI * 2;

export type Mono = Float32Array;
export type Stereo = [Float32Array, Float32Array];

export const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const db = (dbValue: number) => Math.pow(10, dbValue / 20);
export const toDb = (lin: number) => lin > 1e-12 ? 20 * Math.log10(lin) : -240;
export const midiHz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
export const secs = (s: number) => Math.round(s * SR);

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "B1", "F#2", "Eb3" → MIDI note number. */
export function noteMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`bad note '${name}'`);
  const base = NOTE_INDEX[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (Number(m[3]) + 1) * 12 + base;
}
export const noteHz = (name: string) => midiHz(noteMidi(name));

/** Deterministic PRNG (mulberry32) with the helpers the instruments use. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  signed(): number { return this.next() * 2 - 1; }
  jitter(amount: number): number { return 1 + this.signed() * amount; }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(list: readonly T[]): T { return list[this.int(list.length)]; }
  /** Approximately normal (sum of 4 uniforms, zero mean, unit-ish variance). */
  gauss(): number { return (this.next() + this.next() + this.next() + this.next() - 2) * 1.2; }
  fork(salt: number): Rng { return new Rng(hash32(this.s, salt)); }
}
export function hash32(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c | 0) ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  return h >>> 0;
}
export function hashString(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// ---- buffers -----------------------------------------------------------------------------------------------------------
export const mono = (n: number): Mono => new Float32Array(Math.max(0, Math.round(n)));
export const stereo = (n: number): Stereo => [mono(n), mono(n)];
export function copyMono(a: Mono): Mono { return new Float32Array(a); }
/** out[at + i] += src[i] * gain. Clips to out's bounds. */
export function addInto(out: Mono, src: Mono, at: number, gain = 1): void {
  const start = Math.max(0, at), end = Math.min(out.length, at + src.length);
  for (let i = start; i < end; i++) out[i] += src[i - at] * gain;
}
export function addStereo(out: Stereo, src: Stereo | Mono, at: number, gainL = 1, gainR = gainL): void {
  if (src instanceof Float32Array) { addInto(out[0], src, at, gainL); addInto(out[1], src, at, gainR); }
  else { addInto(out[0], src[0], at, gainL); addInto(out[1], src[1], at, gainR); }
}
export function scale(a: Mono, g: number): Mono { for (let i = 0; i < a.length; i++) a[i] *= g; return a; }
export function scaleStereo(a: Stereo, g: number): Stereo { scale(a[0], g); scale(a[1], g); return a; }
export function mixStereo(a: Stereo, b: Stereo, gb = 1): Stereo { addStereo(a, b, 0, gb, gb); return a; }
export function peak(a: Mono | Stereo): number {
  let p = 0;
  for (const ch of (a instanceof Float32Array ? [a] : a)) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > p) p = v; }
  return p;
}
export function rms(a: Mono): number { let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i]; return Math.sqrt(e / Math.max(1, a.length)); }
/** Equal-power pan: returns [gainL, gainR] for pan in [-1, 1]. */
export function panGains(pan: number): [number, number] { const a = (clamp(pan, -1, 1) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; }
export function toStereo(m: Mono, pan = 0, gain = 1): Stereo { const [l, r] = panGains(pan); const out = stereo(m.length); for (let i = 0; i < m.length; i++) { out[0][i] = m[i] * l * gain; out[1][i] = m[i] * r * gain; } return out; }
export function toMono(s: Stereo): Mono { const out = mono(s[0].length); for (let i = 0; i < out.length; i++) out[i] = (s[0][i] + s[1][i]) * 0.5; return out; }
export function trimTail(a: Mono, threshold = 1e-4): Mono { let end = a.length; while (end > 0 && Math.abs(a[end - 1]) < threshold) end--; return a.subarray(0, end); }
export function fadeIn(a: Mono, n: number, at = 0): void { for (let i = 0; i < n && at + i < a.length; i++) a[at + i] *= i / n; }
export function fadeOut(a: Mono, n: number, end = a.length): void { for (let i = 0; i < n && end - 1 - i >= 0; i++) a[end - 1 - i] *= i / n; }
export function fadeStereo(a: Stereo, inN: number, outN: number): void { for (const ch of a) { fadeIn(ch, inN); fadeOut(ch, outN); } }
export function normalizePeak(a: Stereo | Mono, target = 0.9): number { const p = peak(a); if (p < 1e-9) return 1; const g = target / p; if (a instanceof Float32Array) scale(a, g); else scaleStereo(a, g); return g; }
export function assertFinite(a: Mono | Stereo, label = 'buffer'): void {
  for (const ch of (a instanceof Float32Array ? [a] : a)) for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) throw new Error(`${label}: non-finite sample at ${i}`);
}
/** Soft saturation (tanh-like, cheap). */
export const soft = (x: number) => x / (1 + Math.abs(x));
export const tanh = Math.tanh;
export function smoothstep(t: number): number { t = clamp01(t); return t * t * (3 - 2 * t); }
