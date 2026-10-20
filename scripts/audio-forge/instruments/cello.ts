/**
 * Heavy bowed cello: a bowed-string digital waveguide (two delay lines meeting at the bow, a stick-slip friction table
 * driven by bow velocity and pressure, a lossy bridge reflection, bow-hair noise) through cello body resonances
 * (200 / 400 / 700 / 1100 Hz). Articulations: legato (one bow, 40 ms attack), détaché (short bows with gaps), tremolo
 * (bow reversals at 12–14 Hz, each a re-attack), marcato (pressure overshoot on the attack), col legno (the stick
 * strikes the string), harmonic (a light bow at the octave node). Portamento glides the string length; vibrato
 * modulates it; double stops sum two strings. The dry output can go through the guitar amp (see guitar.ts presets
 * celloCrunch / celloRhythm) for cello metal.
 */
import { SR, TAU, type Mono, mono, Rng, addInto, clamp } from '../dsp/core';
import { Biquad, OnePole } from '../dsp/filters';
import { renderString } from './string';

export type CelloArt = 'legato' | 'detache' | 'tremolo' | 'marcato' | 'colLegno' | 'harmonic';
export interface CelloEvent {
  at: number; gate: number; freq: number; vel: number; art: CelloArt;
  slideFrom?: number; slideSamples?: number; vibrato?: { rate: number; cents: number; delay: number };
  /** Double stop: a second string this many semitones up (7 = fifth, 12 = octave). */
  double?: number;
}
export interface CelloOptions { seed: number; /** Bow pressure 0..1 (default 0.72): more = raspier, scratchier. */ pressure?: number; /** Bow position from the bridge 0..0.5 (default 0.13). */ position?: number; /** Tremolo rate Hz (default 12.5). */ tremoloHz?: number }

class FracDelay {
  private buf: Float32Array; private w = 0; last = 0;
  constructor(max: number) { this.buf = new Float32Array(Math.ceil(max) + 4); }
  tick(x: number, d: number): number {
    this.buf[this.w] = x;
    const n = this.buf.length, pos = this.w - d, i0 = Math.floor(pos), frac = pos - i0;
    const a = this.buf[((i0 % n) + n) % n], b = this.buf[(((i0 + 1) % n) + n) % n];
    this.w = (this.w + 1) % n;
    return this.last = a + (b - a) * frac;
  }
}
/** One bowed note (dry string + body). */
function bowedNote(e: CelloEvent, freq: number, o: CelloOptions, seed: number): Mono {
  const rng = new Rng(seed), pressure = clamp(o.pressure ?? 0.72, 0.05, 1), beta = clamp(o.position ?? 0.13, 0.03, 0.5);
  const release = Math.round(0.35 * SR), total = e.gate + release + 200, out = mono(total);
  const f0 = e.slideFrom ?? freq, f1 = freq, slideN = e.slideSamples ?? 0, vib = e.vibrato;
  const maxLen = SR / Math.min(f0, f1) + 8;
  const neck = new FracDelay(maxLen), bridge = new FracDelay(maxLen);
  const bridgeLp = new OnePole(2800 + 2200 * pressure);  // the lossy bridge: darker under heavy pressure
  const slope0 = 5 - 4 * pressure, offset = 0.001;
  const tremHz = o.tremoloHz ?? 12.5, marcato = e.art === 'marcato';
  const attackS = e.art === 'legato' ? 0.045 : e.art === 'detache' ? 0.018 : marcato ? 0.008 : 0.02;
  const maxVel = (0.08 + 0.16 * e.vel) * (e.art === 'harmonic' ? 0.45 : 1);
  const gateEnd = e.gate, relS = e.art === 'detache' ? 0.03 : 0.06;
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    let f = slideN > 0 && i < slideN ? f0 * Math.pow(f1 / f0, i / slideN) : f1;
    if (vib && t > vib.delay) f *= Math.pow(2, Math.min(1, (t - vib.delay) / 0.15) * vib.cents * Math.sin(TAU * vib.rate * t) / 1200);
    const L = SR / f - 2.2;
    // Bow velocity envelope: attack, hold, release; tremolo reverses the bow with a dip at each reversal.
    let env = i < gateEnd ? Math.min(1, t / attackS) : Math.exp(-(i - gateEnd) / (relS * SR));
    if (marcato && t < 0.06) env *= 1 + 0.6 * (1 - t / 0.06);
    let bowVel = maxVel * env;
    if (e.art === 'tremolo') { const ph = Math.sin(TAU * tremHz * t); bowVel *= Math.sign(ph) * Math.pow(Math.abs(ph), 0.25); }
    bowVel += rng.signed() * 0.004 * pressure * env;  // bow-hair noise
    const slope = slope0 * (marcato && t < 0.05 ? 1.5 : 1);
    const bridgeRefl = -bridgeLp.run(bridge.last) * 0.96;
    const nutRefl = -neck.last;
    const velDiff = bowVel - (bridgeRefl + nutRefl);
    let tab = (velDiff + offset) * slope; tab = Math.pow(Math.abs(tab) + 0.75, -4); tab = clamp(tab, 0.01, 0.98);
    const newVel = velDiff * tab;
    neck.tick(bridgeRefl + newVel, L * (1 - beta));
    bridge.tick(nutRefl + newVel, L * beta);
    out[i] = bridge.last;
  }
  return out;
}
/** Dry cello part: every event bowed (or struck), body resonances applied once. */
export function renderCello(events: readonly CelloEvent[], length: number, o: CelloOptions): Mono {
  const dry = mono(length), rng = new Rng(o.seed);
  for (const e of events) {
    const seed = rng.next() * 1e9 | 0;
    if (e.art === 'colLegno') { addInto(dry, renderString({ freq: e.freq, gate: Math.min(e.gate, Math.round(0.08 * SR)), vel: e.vel, art: 'dead', brightness: 2600, pickHard: 1, seed }), e.at, 1.2); continue; }
    const f = e.art === 'harmonic' ? e.freq * 2 : e.freq;
    addInto(dry, bowedNote(e, f, o, seed), e.at, 1);
    if (e.double) addInto(dry, bowedNote({ ...e, slideFrom: e.slideFrom ? e.slideFrom * Math.pow(2, e.double / 12) : undefined }, f * Math.pow(2, e.double / 12), o, seed + 977), e.at, 0.85);
  }
  // Body: cello resonances, a soundpost bump, the f-hole low end, a gentle top roll-off.
  const body = new Float32Array(dry);
  new Biquad('highpass', 55, 0.7).process(body);
  new Biquad('peaking', 200, 2.5, 7).process(body); new Biquad('peaking', 400, 3, 5).process(body); new Biquad('peaking', 700, 3, 4).process(body); new Biquad('peaking', 1100, 2.5, 2).process(body);
  new Biquad('peaking', 2800, 1.5, 1.5).process(body); new Biquad('lowpass', 6500, 0.7).process(body);
  // Scale to the string model's level range so amp presets behave alike.
  for (let i = 0; i < body.length; i++) body[i] *= 1.8;
  return body;
}
