/** Measurement: ITU-R BS.1770 K-weighted integrated loudness (with gating), true peak (4x), crest, correlation, bands. */
import { SR, type Mono, type Stereo, toDb } from './core';
import { Biquad } from './filters';

function kWeight(ch: Mono): Mono {
  // Stage 1: high shelf +4 dB around 1.5 kHz; stage 2: high-pass at ~38 Hz (BS.1770 coefficients approximated with RBJ forms).
  const out = new Float32Array(ch);
  new Biquad('highshelf', 1500, 0.7071, 4).process(out);
  new Biquad('highpass', 38, 0.5).process(out);
  return out;
}
export interface Loudness { integratedLufs: number; shortTermMaxLufs: number; truePeakDb: number; peakDb: number; crestDb: number; correlation: number; rmsDb: number }
export function measure(s: Stereo): Loudness {
  const n = s[0].length, kl = kWeight(s[0]), kr = kWeight(s[1]);
  const block = Math.round(0.4 * SR), hop = Math.round(0.1 * SR), blocks: number[] = [];
  for (let start = 0; start + block <= n; start += hop) {
    let e = 0;
    for (let i = start; i < start + block; i++) e += kl[i] * kl[i] + kr[i] * kr[i];
    blocks.push(-0.691 + 10 * Math.log10(e / block + 1e-20));
  }
  const gated = blocks.filter(v => v > -70);
  const mean = (list: number[]) => list.length ? list.reduce((a, b) => a + Math.pow(10, b / 10), 0) / list.length : 1e-20;
  const relative = -0.691 + 10 * Math.log10(mean(gated)) - 10;
  const final = gated.filter(v => v > relative);
  const integrated = final.length ? -0.691 + 10 * Math.log10(mean(final)) : -70;
  // Short-term (3 s) max.
  const st = Math.round(3 * SR); let stMax = -70;
  for (let start = 0; start + st <= n; start += hop * 5) { let e = 0; for (let i = start; i < start + st; i++) e += kl[i] * kl[i] + kr[i] * kr[i]; stMax = Math.max(stMax, -0.691 + 10 * Math.log10(e / st + 1e-20)); }
  let peakV = 0, tp = 0, e = 0, lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < n; i++) {
    const l = s[0][i], r = s[1][i];
    peakV = Math.max(peakV, Math.abs(l), Math.abs(r));
    const l2 = s[0][Math.min(n - 1, i + 1)], r2 = s[1][Math.min(n - 1, i + 1)];
    for (let k = 1; k < 4; k++) tp = Math.max(tp, Math.abs(l + (l2 - l) * k / 4), Math.abs(r + (r2 - r) * k / 4));
    e += (l * l + r * r) * 0.5; lr += l * r; ll += l * l; rr += r * r;
  }
  const rmsV = Math.sqrt(e / Math.max(1, n));
  return { integratedLufs: round1(integrated), shortTermMaxLufs: round1(stMax), truePeakDb: round1(toDb(Math.max(tp, peakV))), peakDb: round1(toDb(peakV)), crestDb: round1(toDb(peakV) - toDb(rmsV)), correlation: round2(ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 1), rmsDb: round1(toDb(rmsV)) };
}
/** Band energy balance in dB RMS: sub (<60), low (60-250), lowmid (250-800), mid (800-3k), high (3k-10k), air (>10k). */
export function bands(s: Stereo): Record<string, number> {
  const m = new Float32Array(s[0].length);
  for (let i = 0; i < m.length; i++) m[i] = (s[0][i] + s[1][i]) * 0.5;
  const edges: [string, number, number][] = [['sub', 20, 60], ['low', 60, 250], ['lowmid', 250, 800], ['mid', 800, 3000], ['high', 3000, 10000], ['air', 10000, 20000]];
  const out: Record<string, number> = {};
  for (const [name, lo, hi] of edges) {
    const b = new Float32Array(m);
    new Biquad('highpass', lo, 0.7071).process(b); new Biquad('highpass', lo, 0.7071).process(b);
    new Biquad('lowpass', hi, 0.7071).process(b); new Biquad('lowpass', hi, 0.7071).process(b);
    let e = 0; for (let i = 0; i < b.length; i++) e += b[i] * b[i];
    out[name] = round1(toDb(Math.sqrt(e / Math.max(1, b.length))));
  }
  return out;
}
/** RMS (dB) per bar, for a dynamics profile. */
export function barProfile(s: Stereo, barSamples: number): number[] {
  const out: number[] = [];
  for (let start = 0; start + barSamples <= s[0].length; start += barSamples) { let e = 0; for (let i = start; i < start + barSamples; i++) e += (s[0][i] * s[0][i] + s[1][i] * s[1][i]) * 0.5; out.push(round1(toDb(Math.sqrt(e / barSamples)))); }
  return out;
}
/** Loop seam check: sample discontinuity at the seam and the RMS of the 20 ms either side (in dB). */
export function seamCheck(s: Stereo, loopStart: number, loopEnd: number): { stepDb: number; beforeDb: number; afterDb: number } {
  const w = Math.round(0.02 * SR);
  let step = 0, before = 0, after = 0;
  for (const ch of s) {
    step = Math.max(step, Math.abs(ch[loopEnd - 1] - ch[loopStart]));
    for (let i = 0; i < w; i++) { before += ch[loopEnd - 1 - i] ** 2; after += ch[loopStart + i] ** 2; }
  }
  return { stepDb: round1(toDb(step)), beforeDb: round1(toDb(Math.sqrt(before / (2 * w)))), afterDb: round1(toDb(Math.sqrt(after / (2 * w)))) };
}
/** Onset density: onsets per second from a spectral-flux-free envelope detector (good enough to judge transient punch). */
export function onsetsPerSecond(s: Stereo): number {
  const n = s[0].length; let fast = 0, slow = 0, count = 0, cooldown = 0;
  const kf = 1 - Math.exp(-1 / (0.002 * SR)), ks = 1 - Math.exp(-1 / (0.06 * SR));
  for (let i = 0; i < n; i++) {
    const x = Math.abs(s[0][i]) + Math.abs(s[1][i]);
    fast += kf * (x - fast); slow += ks * (x - slow);
    if (cooldown > 0) cooldown--;
    else if (fast > slow * 1.8 && fast > 0.02) { count++; cooldown = Math.round(0.05 * SR); }
  }
  return Math.round(count / (n / SR) * 10) / 10;
}
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
