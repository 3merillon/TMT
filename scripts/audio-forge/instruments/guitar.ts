/**
 * Guitar: string model → tight noise gate (keyed by the dry signal) → screamer-style boost → two oversampled gain stages
 * → tone stack → cabinet (resonances + steep 5 kHz roll-off + close-mic reflection). Rhythm takes are rendered twice with
 * different seeds and detune and panned hard for the classic double-tracked wall; leads get a single centred take with
 * delay/reverb handled by the part's effects.
 */
import { SR, type Mono, type Stereo, mono, stereo, Rng, db, addInto, clamp } from '../dsp/core';
import { Biquad, OnePole } from '../dsp/filters';
import { oversampledShape, shapers } from '../dsp/fx';
import { renderChord, renderString, type Articulation } from './string';

export interface GuitarEvent {
  /** Start sample, gate length in samples. */
  at: number; gate: number; freq: number; vel: number; art: Articulation;
  chord?: 'single' | 'power' | 'power8' | 'fifth' | 'octave';
  slideFrom?: number; slideSamples?: number; vibrato?: { rate: number; cents: number; delay: number };
}
export interface AmpPreset {
  /** Pre-boost emphasis (screamer): centre Hz and dB. */
  boostHz: number; boostDb: number; tightHz: number;
  gain1: number; gain2: number; bias: number;
  /** Tone stack: bass (dB @ 120), mid (dB @ 500), presence (dB @ 3.2k), treble lowpass. */
  bass: number; mid: number; midHz: number; presence: number; lowpass: number;
  cabLow: number; cabPresence: number; cabCut: number;
  gateDb: number; outDb: number;
  brightness: number;
}
export const AMPS: Record<'rhythm' | 'lead' | 'crunch' | 'clean' | 'bassDrive', AmpPreset> = {
  rhythm: { boostHz: 800, boostDb: 7, tightHz: 170, gain1: 24, gain2: 5, bias: 0.1, bass: 2.5, mid: -3.5, midHz: 480, presence: 3, lowpass: 7800, cabLow: 4, cabPresence: 3.5, cabCut: 5200, gateDb: -46, outDb: -19, brightness: 7000 },
  lead: { boostHz: 900, boostDb: 8, tightHz: 220, gain1: 30, gain2: 6, bias: 0.14, bass: 0, mid: 2, midHz: 900, presence: 2.5, lowpass: 7500, cabLow: 2, cabPresence: 4, cabCut: 5600, gateDb: -54, outDb: -21, brightness: 7500 },
  crunch: { boostHz: 700, boostDb: 3, tightHz: 120, gain1: 7, gain2: 2.2, bias: 0.08, bass: 2, mid: -1, midHz: 600, presence: 2, lowpass: 7000, cabLow: 3, cabPresence: 2.5, cabCut: 5000, gateDb: -52, outDb: -17, brightness: 6500 },
  clean: { boostHz: 1200, boostDb: 0, tightHz: 90, gain1: 1.6, gain2: 1.1, bias: 0.03, bass: 1, mid: 0, midHz: 800, presence: 1.5, lowpass: 9000, cabLow: 1.5, cabPresence: 2, cabCut: 6500, gateDb: -70, outDb: -10, brightness: 7500 },
  bassDrive: { boostHz: 900, boostDb: 4, tightHz: 60, gain1: 9, gain2: 2.5, bias: 0.06, bass: 3, mid: 1.5, midHz: 900, presence: 1, lowpass: 6000, cabLow: 3, cabPresence: 2, cabCut: 4800, gateDb: -56, outDb: -17, brightness: 3800 },
};
const CHORDS: Record<NonNullable<GuitarEvent['chord']>, [number[], number[]]> = {
  single: [[0], [1]], power: [[0, 7], [1, 0.8]], power8: [[0, 7, 12], [1, 0.75, 0.5]], fifth: [[0, 7], [1, 0.9]], octave: [[0, 12], [1, 0.6]],
};
/** Renders the DRY string signal of a part (one take). */
export function renderDryGuitar(events: readonly GuitarEvent[], length: number, o: { seed: number; cents?: number; brightness?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed);
  for (const e of events) {
    const [intervals, gains] = CHORDS[e.chord ?? 'single'];
    const base = { freq: e.freq, gate: e.gate, vel: e.vel, art: e.art, seed: rng.fork(e.at).next() * 1e9 | 0, cents: (o.cents ?? 0) + rng.signed() * 1.5,
      slideFrom: e.slideFrom, slideSamples: e.slideSamples, vibrato: e.vibrato, brightness: o.brightness };
    const note = intervals.length === 1 ? renderString(base) : renderChord(base, intervals, gains);
    addInto(out, note, e.at);
  }
  return out;
}
/** The amp/cab chain on a dry take. `key` (optional) drives the gate; defaults to the dry signal itself. */
export function ampChain(dry: Mono, a: AmpPreset, key: Mono = dry): Mono {
  const n = dry.length, x = new Float32Array(dry);
  // Gate envelope from the dry signal (fast attack, 60 ms release) so the amp's noise and ring never smear chugs.
  const gate = new Float32Array(n); let env = 0; const ka = 1 - Math.exp(-1 / (0.0005 * SR)), kr = 1 - Math.exp(-1 / (0.05 * SR)), thr = db(a.gateDb);
  for (let i = 0; i < n; i++) { const v = Math.abs(key[i]); env += (v > env ? ka : kr) * (v - env); gate[i] = clamp((env - thr * 0.5) / (thr * 1.5), 0, 1); }
  // Screamer boost: HPF tightness, band emphasis.
  new Biquad('highpass', a.tightHz, 0.7).process(x);
  new Biquad('peaking', a.boostHz, 0.8, a.boostDb).process(x);
  // Stage 1: tube-ish asymmetric, oversampled.
  let y = oversampledShape(x, shapers.tube(a.gain1, a.bias));
  new Biquad('lowpass', 6800, 0.6).process(y); new Biquad('highpass', 110, 0.7).process(y);
  // Stage 2: harder diode clip.
  y = oversampledShape(y, shapers.diode(a.gain2));
  // Tone stack.
  new Biquad('lowshelf', 120, 0.7, a.bass).process(y);
  new Biquad('peaking', a.midHz, 0.9, a.mid).process(y);
  new Biquad('peaking', 3200, 1.1, a.presence).process(y);
  new Biquad('lowpass', a.lowpass, 0.7).process(y);
  // Cabinet: cone resonance, presence peak, steep high roll-off, plus a short close-mic reflection and a 4k notch.
  new Biquad('highpass', 72, 0.9).process(y);
  new Biquad('peaking', 105, 1.3, a.cabLow).process(y);
  new Biquad('peaking', 2500, 1.4, a.cabPresence).process(y);
  new Biquad('peaking', 3900, 3, -2.5).process(y);
  new Biquad('lowpass', a.cabCut, 0.9).process(y); new Biquad('lowpass', a.cabCut * 1.15, 0.6).process(y);
  const refl = Math.round(SR * 0.00085), out = mono(n), outGain = db(a.outDb);
  for (let i = 0; i < n; i++) out[i] = (y[i] + (i >= refl ? y[i - refl] * -0.28 : 0)) * gate[i] * outGain;
  return out;
}
/** Double-tracked rhythm part: two takes, hard-panned. */
export function renderRhythmGuitar(events: readonly GuitarEvent[], length: number, o: { seed: number; amp?: AmpPreset; spread?: number }): Stereo {
  const amp = o.amp ?? AMPS.rhythm, spread = o.spread ?? 0.9;
  const takeL = ampChain(renderDryGuitar(events, length, { seed: o.seed, cents: -4, brightness: amp.brightness }), amp);
  const takeR = ampChain(renderDryGuitar(events, length, { seed: o.seed + 1013, cents: 4, brightness: amp.brightness }), amp);
  const out = stereo(length);
  const l = (1 + spread) / 2, r = (1 - spread) / 2;
  for (let i = 0; i < length; i++) { out[0][i] = takeL[i] * l + takeR[i] * r; out[1][i] = takeR[i] * l + takeL[i] * r; }
  return out;
}
/** Single lead take, centred, with a slight doubler for width. */
export function renderLeadGuitar(events: readonly GuitarEvent[], length: number, o: { seed: number; amp?: AmpPreset }): Stereo {
  const amp = o.amp ?? AMPS.lead;
  const take = ampChain(renderDryGuitar(events, length, { seed: o.seed, brightness: amp.brightness }), amp);
  const out = stereo(length), d = Math.round(SR * 0.011);
  for (let i = 0; i < length; i++) { out[0][i] = take[i]; out[1][i] = take[i] * 0.75 + (i >= d ? take[i - d] * 0.25 : 0); }
  return out;
}
/** Feedback-style sustain tail helper: a one-pole smoothing for level followers (exported for leads). */
export const follower = (a: Mono, ms: number) => { const f = new OnePole(1000 / ms); const out = mono(a.length); for (let i = 0; i < a.length; i++) out[i] = f.run(Math.abs(a[i])); return out; };
