/** Dynamics: compressor and true-peak limiter that can also EXPORT their gain curve, so synchronized stems get the exact
 * processing of the full mix (apply the same gain curve to each stem; the stems then still sum to the mastered mix). */
import { SR, type Mono, type Stereo, db, toDb } from './core';
import { Biquad } from './filters';

export interface CompSpec { thresholdDb: number; ratio: number; attack: number; release: number; kneeDb?: number; makeupDb?: number; detector?: 'peak' | 'rms'; sidechainHp?: number }
/** Gain curve (linear) of a feed-forward compressor keyed on the stereo max (or RMS). */
export function compressorGain(src: Stereo, s: CompSpec): Float32Array {
  const n = src[0].length, out = new Float32Array(n), knee = s.kneeDb ?? 6;
  const ka = 1 - Math.exp(-1 / (Math.max(1e-4, s.attack) * SR)), kr = 1 - Math.exp(-1 / (Math.max(1e-3, s.release) * SR));
  const hpL = s.sidechainHp ? new Biquad('highpass', s.sidechainHp, 0.7) : null, hpR = s.sidechainHp ? new Biquad('highpass', s.sidechainHp, 0.7) : null;
  let env = 0, rmsAcc = 0; const rmsK = 1 - Math.exp(-1 / (0.01 * SR));
  const makeup = db(s.makeupDb ?? 0);
  for (let i = 0; i < n; i++) {
    let l = src[0][i], r = src[1][i];
    if (hpL && hpR) { l = hpL.run(l); r = hpR.run(r); }
    let x: number;
    if (s.detector === 'rms') { rmsAcc += rmsK * ((l * l + r * r) * 0.5 - rmsAcc); x = Math.sqrt(rmsAcc); }
    else x = Math.max(Math.abs(l), Math.abs(r));
    env += (x > env ? ka : kr) * (x - env);
    const lvl = toDb(env), over = lvl - s.thresholdDb;
    let gr: number;
    if (over <= -knee / 2) gr = 0;
    else if (over >= knee / 2) gr = over * (1 - 1 / s.ratio);
    else { const t = over + knee / 2; gr = (1 - 1 / s.ratio) * t * t / (2 * knee); }
    out[i] = db(-gr) * makeup;
  }
  return out;
}
/** Lookahead brickwall limiter gain curve at `ceiling` (dBTP-ish, measured on 4x-interpolated peaks). */
export function limiterGain(src: Stereo, ceilingDb = -1, lookaheadMs = 1.5, releaseMs = 60): Float32Array {
  const n = src[0].length, out = new Float32Array(n).fill(1), ceiling = db(ceilingDb);
  const look = Math.max(1, Math.round(lookaheadMs * SR / 1000)), kr = 1 - Math.exp(-1 / (releaseMs / 1000 * SR));
  // Required gain per sample from the inter-sample peak estimate (max of neighbours, linear interpolation at 4x).
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const ch of src) {
      const a = ch[i], b = ch[Math.min(n - 1, i + 1)];
      for (let k = 0; k < 4; k++) { const v = Math.abs(a + (b - a) * k / 4); if (v > p) p = v; }
    }
    need[i] = p > ceiling ? ceiling / p : 1;
  }
  // Minimum over the lookahead window (attack), then a smoothed release.
  let g = 1;
  const windowMin = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 1; for (let j = i; j < Math.min(n, i + look); j++) if (need[j] < m) m = need[j]; windowMin[i] = m; }
  for (let i = 0; i < n; i++) {
    const target = windowMin[i];
    if (target < g) g += (target - g) * Math.min(1, 1 / look * 2); else g += (target - g) * kr;
    out[i] = Math.min(g, 1);
  }
  // A second pass guarantees the ceiling after smoothing.
  for (let i = 0; i < n; i++) if (out[i] > need[i]) out[i] = need[i];
  return out;
}
export function applyGain(dst: Stereo | Mono, gain: Float32Array): void {
  if (dst instanceof Float32Array) { for (let i = 0; i < dst.length; i++) dst[i] *= gain[i] ?? 1; return; }
  for (const ch of dst) for (let i = 0; i < ch.length; i++) ch[i] *= gain[i] ?? 1;
}
export function multiplyGains(a: Float32Array, b: Float32Array): Float32Array { const out = new Float32Array(a.length); for (let i = 0; i < a.length; i++) out[i] = a[i] * (b[i] ?? 1); return out; }
/** Transient shaper: boosts attacks (ratio > 1) or softens them, by comparing fast and slow envelopes. */
export function transientShape(a: Mono, attackGain = 1.5, sustainGain = 1): Mono {
  let fast = 0, slow = 0; const kf = 1 - Math.exp(-1 / (0.001 * SR)), ks = 1 - Math.exp(-1 / (0.04 * SR));
  for (let i = 0; i < a.length; i++) {
    const x = Math.abs(a[i]);
    fast += kf * (x - fast); slow += ks * (x - slow);
    const t = Math.max(0, fast - slow) / (slow + 1e-3);
    a[i] *= sustainGain + (attackGain - sustainGain) * Math.min(1, t);
  }
  return a;
}
