/** Bass: a picked string model with a blended sub oscillator, a drive stage for growl, and hard compression; plus the
 * "snarl" electronic bass (FM + unison saw → bit reduction → resonant filter → distortion) for industrial sections. */
import { SR, TAU, type Mono, mono, Rng, addInto, db } from '../dsp/core';
import { Biquad, Svf } from '../dsp/filters';
import { oversampledShape, shapers, bitcrush } from '../dsp/fx';
import { compressorGain, applyGain } from '../dsp/dynamics';
import { renderString } from './string';

export interface BassEvent { at: number; gate: number; freq: number; vel: number; art: 'open' | 'pm' | 'dead'; slideFrom?: number; slideSamples?: number }

export function renderPickedBass(events: readonly BassEvent[], length: number, o: { seed: number; drive?: number; sub?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed), subLevel = o.sub ?? 0.5;
  for (const e of events) {
    const s = renderString({ freq: e.freq, gate: e.gate, vel: e.vel, art: e.art, seed: rng.next() * 1e9 | 0, brightness: 3200, decay: e.art === 'pm' ? 0.95 : 0.9975, pickPos: 0.2, pickHard: 0.9, slideFrom: e.slideFrom, slideSamples: e.slideSamples, release: e.art === 'open' ? 0.25 : 0.08 });
    // Sub: a sine at the fundamental with a 4 ms attack and the string's gate.
    const subLen = Math.min(s.length, e.gate + Math.round(0.12 * SR)), rel = Math.round(0.08 * SR);
    for (let i = 0; i < subLen; i++) {
      const env = Math.min(1, i / (0.004 * SR)) * (i > e.gate ? Math.exp(-(i - e.gate) / rel * 3) : 1);
      s[i] += Math.sin(TAU * e.freq * i / SR) * env * subLevel * (0.5 + 0.5 * e.vel) * 0.35;
    }
    addInto(out, s, e.at);
  }
  // Drive + EQ + compression.
  new Biquad('highpass', 32, 0.7).process(out);
  let y = oversampledShape(out, shapers.tube(o.drive ?? 3.5, 0.05));
  new Biquad('lowshelf', 85, 0.7, 3).process(y);
  new Biquad('peaking', 900, 1, 3.5).process(y);
  new Biquad('peaking', 300, 1, -1.5).process(y);
  new Biquad('lowpass', 6500, 0.6).process(y);
  applyGain(y, compressorGain([y, y], { thresholdDb: -20, ratio: 4, attack: 0.006, release: 0.12, makeupDb: 6 }));
  return y;
}
export interface SnarlEvent { at: number; gate: number; freq: number; vel: number; cutoff?: number; accent?: boolean }
/** Snarling resampled bass: FM-rich unison saw, decimated, resonant SVF with envelope, then diode distortion. */
export function renderSnarlBass(events: readonly SnarlEvent[], length: number, o: { seed: number; bits?: number; downsample?: number; resonance?: number; drive?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed);
  for (const e of events) {
    const n = e.gate + Math.round(0.06 * SR), note = mono(n);
    const f = e.freq, det = [0, 7, -7, 12.5, -12.5];
    const ph = det.map(() => rng.next()), fm = rng.next();
    const svf = new Svf(1000, o.resonance ?? 0.55);
    const cut0 = (e.cutoff ?? 1400) * (0.7 + 0.6 * e.vel) * (e.accent ? 1.4 : 1);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let k = 0; k < det.length; k++) { ph[k] += f * Math.pow(2, det[k] / 1200) / SR; if (ph[k] >= 1) ph[k] -= 1; v += (2 * ph[k] - 1) * (k === 0 ? 1 : 0.45); }
      v += Math.sin(TAU * f * t + 2.2 * Math.sin(TAU * f * 2 * t + fm)) * 0.8;   // FM growl
      v += Math.sin(TAU * f * 0.5 * t) * 0.6;                                     // sub octave
      const env = i < e.gate ? 1 : Math.exp(-(i - e.gate) / (0.03 * SR));
      const fenv = Math.exp(-t / 0.18) * 0.8 + 0.3;
      svf.set(Math.min(16000, cut0 * fenv + 120), o.resonance ?? 0.55);
      note[i] = svf.run(v * 0.25) * env * (0.6 + 0.4 * e.vel);
    }
    bitcrush(note, o.bits ?? 9, o.downsample ?? 2);
    addInto(out, note, e.at);
  }
  new Biquad('lowpass', 7000, 0.7).process(out);
  const y = oversampledShape(out, shapers.diode(o.drive ?? 2.5));
  new Biquad('highpass', 36, 0.7).process(y); new Biquad('peaking', 120, 1, 2).process(y);
  applyGain(y, compressorGain([y, y], { thresholdDb: -18, ratio: 5, attack: 0.004, release: 0.1, makeupDb: 5 }));
  for (let i = 0; i < y.length; i++) y[i] *= db(-4);
  return y;
}
