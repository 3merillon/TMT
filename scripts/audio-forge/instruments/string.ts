/**
 * Plucked/picked string physical model (extended Karplus-Strong): a fractional delay loop with a damping low-pass and an
 * allpass tuner, excited by a pick-position-combed noise burst with a pick-hardness low-pass and a click transient.
 * Palm mutes shorten the loop's decay and darken it; dead notes are mostly pick noise; harmonics gate the loop at a node.
 */
import { SR, TAU, Rng, type Mono, mono, clamp } from '../dsp/core';
import { Biquad, OnePole } from '../dsp/filters';

export type Articulation = 'open' | 'pm' | 'dead' | 'harm' | 'tap';
export interface StringParams {
  /** Hz; the pitch can glide from `slideFrom` over `slideSamples`. */
  freq: number; slideFrom?: number; slideSamples?: number;
  /** Samples the note is held before it is damped (release follows). */
  gate: number;
  vel: number; art: Articulation;
  /** Loop low-pass cutoff for an open note at full velocity (Hz); palm mute multiplies it down. */
  brightness?: number;
  /** Loop feedback: sets the sustain (open ≈ 0.996, pm ≈ 0.93). */
  decay?: number;
  pickPos?: number; pickHard?: number;
  vibrato?: { rate: number; cents: number; delay: number };
  /** Detune in cents (for doubled takes and chord strings). */
  cents?: number;
  seed: number;
  /** Extra sustain when the string is let ring after the gate (seconds). */
  release?: number;
}
export function renderString(p: StringParams): Mono {
  const rng = new Rng(p.seed);
  const art = p.art;
  const brightOpen = p.brightness ?? 6500;
  const cut = art === 'pm' ? brightOpen * 0.22 : art === 'dead' ? 900 : art === 'harm' ? brightOpen * 0.8 : art === 'tap' ? brightOpen * 0.6 : brightOpen;
  const fb = p.decay ?? (art === 'pm' ? 0.945 : art === 'dead' ? 0.6 : art === 'harm' ? 0.994 : 0.9965);
  const release = p.release ?? (art === 'open' ? 0.35 : 0.08);
  const total = p.gate + Math.round(release * SR) + 400;
  const out = mono(total);
  const detune = Math.pow(2, (p.cents ?? 0) / 1200);
  const f0 = (p.slideFrom ?? p.freq) * detune, f1 = p.freq * detune, slideN = p.slideSamples ?? 0;
  // Delay line sized for the lowest pitch in play.
  const maxN = Math.ceil(SR / Math.min(f0, f1)) + 4;
  const line = new Float32Array(maxN);
  let w = 0;
  const loopCut = cut * (0.6 + 0.4 * clamp(p.vel, 0, 1));
  const lp = new OnePole(loopCut);
  // The loop low-pass delays the recirculating wave by about (1−k)/k samples; the delay line is shortened to match so
  // muted notes (low cutoff, long group delay) stay in tune with open ones.
  const kLp = 1 - Math.exp(-TAU * Math.min(Math.max(loopCut, 1), SR * 0.49) / SR), groupDelay = (1 - kLp) / kLp * 0.88;
  const dc = new Biquad('highpass', 40, 0.7);
  // Excitation: noise burst through pick hardness filter and pick-position comb, for one period.
  const pickPos = p.pickPos ?? (art === 'pm' ? 0.08 : 0.14), hard = p.pickHard ?? (art === 'pm' ? 0.55 : 0.75);
  const N0 = SR / f0;
  const exciteLen = Math.round(N0 * (art === 'dead' ? 2.5 : 1.1)) + 8;
  const ex = new Float32Array(exciteLen);
  const exLp = new OnePole(1800 + 9000 * hard * (0.5 + 0.5 * p.vel));
  for (let i = 0; i < exciteLen; i++) {
    const env = i < exciteLen * 0.9 ? 1 : (exciteLen - i) / (exciteLen * 0.1);
    ex[i] = exLp.run(rng.signed()) * env;
  }
  const comb = Math.max(1, Math.round(N0 * pickPos));
  for (let i = exciteLen - 1; i >= comb; i--) ex[i] -= ex[i - comb] * 0.92;
  // Pick click: a 1 ms high-passed burst that reads as the plectrum, stronger on mutes.
  const clickLen = Math.round(SR * 0.0012), clickHp = new Biquad('highpass', 2500, 0.8);
  const clickGain = art === 'dead' ? 0.9 : art === 'pm' ? 0.55 : 0.35;
  for (let i = 0; i < clickLen; i++) ex[i] += clickHp.run(rng.signed()) * clickGain * (1 - i / clickLen);
  const level = 0.6 * (0.45 + 0.55 * clamp(p.vel, 0, 1)) * (art === 'dead' ? 0.6 : 1);
  // Vibrato / glide per-sample pitch.
  const vib = p.vibrato;
  const harmonic = art === 'harm';
  // Allpass fractional delay state.
  let apY = 0, apX = 0;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    let f = slideN > 0 && i < slideN ? f0 * Math.pow(f1 / f0, i / slideN) : f1;
    if (vib && t > vib.delay) { const depth = Math.min(1, (t - vib.delay) / 0.12) * vib.cents; f *= Math.pow(2, depth * Math.sin(TAU * vib.rate * t) / 1200); }
    if (harmonic) f *= 2; // natural harmonic at the 12th fret node
    // Total loop delay = integer taps + allpass fraction + filter group delay = one period. The fraction is kept in
    // [0.5, 1.5) so the allpass coefficient stays well inside the stable range (Jaffe-Smith tuning).
    const N = SR / f, want = N - groupDelay - 1, Ni = Math.max(1, Math.floor(want - 0.5)), frac = want - Ni;
    const r1 = ((w - Ni - 1) % maxN + maxN) % maxN;
    const c = (1 - frac) / (1 + frac);
    const xin = line[r1], y = c * (xin - apY) + apX;
    apX = xin; apY = y;
    let loop = lp.run(y) * fb;
    // Damping after the gate: the fretting hand lifts, the loop loses energy quickly.
    if (i > p.gate) loop *= Math.exp(-(i - p.gate) / (release * SR) * 3);
    const input = i < exciteLen ? ex[i] : 0;
    const v = loop + input;
    line[w] = v;
    w = (w + 1) % maxN;
    out[i] = dc.run(v) * level;
  }
  return out;
}
/** Sum of strings for a chord shape: intervals in semitones from the root with relative gains. */
export function renderChord(base: StringParams, intervals: readonly number[], gains: readonly number[], centsSpread = 3): Mono {
  let out: Mono | null = null;
  intervals.forEach((semi, i) => {
    const s = renderString({ ...base, freq: base.freq * Math.pow(2, semi / 12), slideFrom: base.slideFrom !== undefined ? base.slideFrom * Math.pow(2, semi / 12) : undefined,
      cents: (base.cents ?? 0) + (i - (intervals.length - 1) / 2) * centsSpread, seed: base.seed + i * 7919 });
    if (!out) out = mono(s.length);
    for (let k = 0; k < s.length && k < out.length; k++) out[k] += s[k] * gains[i];
  });
  return out ?? mono(1);
}
