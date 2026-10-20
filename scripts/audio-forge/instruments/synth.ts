/** Electronic instruments: leads, pads, arpeggiators, risers, cinematic impacts, metallic pulses, glitch sequences. */
import { SR, TAU, type Mono, type Stereo, mono, stereo, Rng, addInto, addStereo, clamp, db } from '../dsp/core';
import { Biquad, Svf, OnePole } from '../dsp/filters';
import { Unison, Noise, Fm } from '../dsp/osc';
import { bitcrush, shape, shapers, chorus } from '../dsp/fx';
import { expDecay } from '../dsp/env';

export interface SynthEvent { at: number; gate: number; freq: number; vel: number; glideFrom?: number; accent?: boolean }

/** Saw-unison lead through an enveloped resonant filter with light drive; vibrato after a short delay. */
export function renderSawLead(events: readonly SynthEvent[], length: number, o: { seed: number; voices?: number; detune?: number; cutoff?: number; resonance?: number; drive?: number; vibrato?: number; pulse?: boolean }): Mono {
  const out = mono(length), rng = new Rng(o.seed);
  for (const e of events) {
    const n = e.gate + Math.round(0.25 * SR), note = mono(n), uni = new Unison(e.freq, o.voices ?? 5, o.detune ?? 10, rng), svf = new Svf(2000, o.resonance ?? 0.35);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let f = e.freq;
      if (e.glideFrom && t < 0.08) f = e.glideFrom * Math.pow(e.freq / e.glideFrom, t / 0.08);
      if (o.vibrato && t > 0.18) f *= Math.pow(2, Math.min(1, (t - 0.18) / 0.2) * (o.vibrato) * Math.sin(TAU * 5.6 * t) / 1200);
      uni.setFreq(f, o.detune ?? 10);
      const v = o.pulse ? uni.pulse(0.5 + 0.3 * Math.sin(TAU * 0.7 * t)) : uni.saw();
      const env = i < e.gate ? 1 : Math.exp(-(i - e.gate) / (0.12 * SR));
      const fenv = (o.cutoff ?? 2600) * (0.55 + 0.45 * Math.exp(-t / 0.25)) * (0.7 + 0.5 * e.vel) * (e.accent ? 1.5 : 1);
      svf.set(Math.min(15000, fenv), o.resonance ?? 0.35);
      note[i] = svf.run(v * 0.5) * env * (0.5 + 0.5 * e.vel) * Math.min(1, i / (0.004 * SR));
    }
    addInto(out, note, e.at);
  }
  shape(out, shapers.tanh(o.drive ?? 1.6));
  new Biquad('highpass', 120, 0.7).process(out);
  return out;
}
/** Wide pad: unison saws + sine floor, slow attack/release, lowpass, chorused to stereo. */
export function renderPad(events: readonly SynthEvent[], length: number, o: { seed: number; attack?: number; release?: number; cutoff?: number; dark?: boolean }): Stereo {
  const dry = mono(length), rng = new Rng(o.seed), atk = o.attack ?? 0.6, rel = o.release ?? 1.2;
  for (const e of events) {
    const n = e.gate + Math.round(rel * SR * 1.5), note = mono(n), uni = new Unison(e.freq, 7, 14, rng), uni2 = new Unison(e.freq * 2.002, 3, 9, rng), lp = new Biquad('lowpass', o.cutoff ?? 1800, 0.5);
    for (let i = 0; i < n; i++) {
      const t = i / SR, env = Math.min(1, t / atk) * (i < e.gate ? 1 : Math.exp(-(i - e.gate) / (rel * SR) * 3));
      note[i] = lp.run(uni.saw() * 0.5 + uni2.saw() * (o.dark ? 0.08 : 0.2) + Math.sin(TAU * e.freq * 0.5 * t) * 0.35) * env * (0.4 + 0.6 * e.vel) * 0.5;
    }
    addInto(dry, note, e.at);
  }
  new Biquad('highpass', 70, 0.7).process(dry);
  const wet = chorus(dry, 0.35, 5, 14, o.seed);
  const out = stereo(length);
  for (let i = 0; i < length; i++) { out[0][i] = dry[i] * 0.6 + wet[0][i] * 0.55; out[1][i] = dry[i] * 0.6 + wet[1][i] * 0.55; }
  return out;
}
/** Pulse-width sequence/arp voice: short gated notes, PWM, filter pluck, light bit reduction for grit. */
export function renderPluck(events: readonly SynthEvent[], length: number, o: { seed: number; cutoff?: number; crush?: number; width?: number; decay?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed);
  for (const e of events) {
    const n = e.gate + Math.round(0.08 * SR), note = mono(n), svf = new Svf(3000, 0.5), uni = new Unison(e.freq, 2, 6, rng);
    for (let i = 0; i < n; i++) {
      const t = i / SR, env = (i < e.gate ? expDecay(t, o.decay ?? 0.35) : expDecay(t, o.decay ?? 0.35) * Math.exp(-(i - e.gate) / (0.02 * SR)));
      svf.set(Math.min(14000, (o.cutoff ?? 4000) * (0.25 + 0.75 * expDecay(t, 0.12)) * (0.6 + 0.4 * e.vel)), 0.5);
      note[i] = svf.run(uni.pulse(o.width ?? 0.3) * 0.6) * env * (0.4 + 0.6 * e.vel);
    }
    if (o.crush) bitcrush(note, o.crush, 1);
    addInto(out, note, e.at);
  }
  new Biquad('highpass', 150, 0.7).process(out);
  return out;
}
/** Bell/ice lead: FM with a bright index decaying fast (cold precision). */
export function renderBell(events: readonly SynthEvent[], length: number, o: { seed: number; ratio?: number; index?: number; decay?: number }): Mono {
  const out = mono(length);
  for (const e of events) {
    const n = e.gate + Math.round((o.decay ?? 1.2) * SR), note = mono(n), op = new Fm(e.freq, o.ratio ?? 3.5, o.index ?? 2.2);
    for (let i = 0; i < n; i++) { const t = i / SR; const env = expDecay(t, o.decay ?? 1.2) * (i < e.gate ? 1 : Math.exp(-(i - e.gate) / (0.25 * SR))); note[i] = op.run(expDecay(t, 0.35)) * env * (0.4 + 0.6 * e.vel) * 0.6; }
    addInto(out, note, e.at);
  }
  return out;
}
/** Noise/saw riser over `seconds` into a hit point (returns a buffer that ends at the hit). */
export function riser(seconds: number, o: { seed: number; freqFrom?: number; freqTo?: number; noise?: number }): Mono {
  const n = Math.round(seconds * SR), out = mono(n), rng = new Rng(o.seed), noise = new Noise(rng.next() * 1e9 | 0), uni = new Unison(o.freqFrom ?? 80, 5, 20, rng), bp = new Svf(400, 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    uni.setFreq((o.freqFrom ?? 80) * Math.pow((o.freqTo ?? 320) / (o.freqFrom ?? 80), t), 20 + 30 * t);
    bp.set(300 * Math.pow(30, t), 0.6);
    const nz = bp.run(noise.white()); const w = (o.noise ?? 0.6);
    out[i] = (uni.saw() * (1 - w) * 0.5 + nz * w * 2) * Math.pow(t, 1.6);
  }
  return out;
}
/** Cinematic impact: sub drop + noise burst + metallic ring, returns stereo with a tail. */
export function impact(o: { seed: number; seconds?: number; subHz?: number; ring?: number }): Stereo {
  const n = Math.round((o.seconds ?? 2.5) * SR), out = stereo(n), rng = new Rng(o.seed), noise = new Noise(rng.next() * 1e9 | 0), lp = new OnePole(900), hp = new Biquad('highpass', 2000, 0.8);
  let ph = 0; const ratios = [1, 1.5, 2.2, 3.1], ph2 = ratios.map(() => rng.next()), f = (o.ring ?? 180) * rng.jitter(0.05);
  for (let i = 0; i < n; i++) {
    const t = i / SR, fs = (o.subHz ?? 36) * (1 + 1.8 * Math.exp(-t / 0.1)); ph += fs / SR;
    const sub = Math.sin(TAU * ph) * expDecay(t, 1.4) * 1.2, burst = lp.run(noise.brown()) * expDecay(t, 0.5) * 1.4 + hp.run(noise.white()) * expDecay(t, 0.06) * 0.8;
    let ring = 0; for (let k = 0; k < ratios.length; k++) { ph2[k] += f * ratios[k] / SR; ring += Math.sin(TAU * ph2[k]) * expDecay(t, 1.2 / (1 + k)) * 0.25; }
    const v = Math.tanh((sub + burst + ring) * 0.9) * Math.min(1, t / 0.002);
    out[0][i] = v; out[1][i] = v * 0.92 + (i > 300 ? out[0][i - 300] * 0.08 : 0);
  }
  return out;
}
/** Metallic machine pulse: ring-modulated noise ticks at a rate, for industrial percussion beds. */
export function machinePulse(length: number, o: { seed: number; rate: number; freq: number; q?: number; level?: number; duty?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed), noise = new Noise(rng.next() * 1e9 | 0), bp = new Biquad('bandpass', o.freq, o.q ?? 8), period = SR / o.rate;
  for (let i = 0; i < length; i++) {
    const ph = (i % period) / period, env = ph < (o.duty ?? 0.12) ? Math.exp(-ph / 0.03) : 0;
    out[i] = bp.run(noise.white()) * Math.sin(TAU * o.freq * 1.37 * i / SR) * env * (o.level ?? 0.5) * 4;
  }
  return out;
}
/** Glitch sequence: sample-and-hold gated noise bursts and pitched blips with bit reduction. */
export function glitchSeq(length: number, o: { seed: number; stepSamples: number; density?: number; baseHz?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed), noise = new Noise(rng.next() * 1e9 | 0), bp = new Svf(2000, 0.7);
  const steps = Math.ceil(length / o.stepSamples);
  for (let s = 0; s < steps; s++) {
    if (rng.next() > (o.density ?? 0.35)) continue;
    const at = s * o.stepSamples, len = Math.round(o.stepSamples * rng.range(0.25, 0.9)), pitched = rng.next() < 0.5, f = (o.baseHz ?? 220) * Math.pow(2, rng.int(24) / 12);
    bp.set(f * 2, 0.7);
    for (let i = 0; i < len && at + i < length; i++) {
      const t = i / SR, env = Math.min(1, i / 48) * expDecay(t, len / SR * 0.8);
      out[at + i] += (pitched ? (Math.sin(TAU * f * t) > 0 ? 0.5 : -0.5) : bp.run(noise.white()) * 2) * env * 0.5;
    }
  }
  bitcrush(out, 7, 3);
  new Biquad('highpass', 300, 0.7).process(out);
  return out;
}
/** Low drone/furnace bed: detuned sub saws through a slow filter wobble, mono. */
export function drone(length: number, o: { seed: number; freq: number; cutoff?: number; wobble?: number; level?: number }): Mono {
  const out = mono(length), rng = new Rng(o.seed), uni = new Unison(o.freq, 4, 9, rng), lp = new Svf(o.cutoff ?? 300, 0.2);
  for (let i = 0; i < length; i++) { const t = i / SR; lp.set((o.cutoff ?? 300) * (1 + (o.wobble ?? 0.4) * Math.sin(TAU * 0.07 * t)), 0.2); out[i] = lp.run(uni.saw() * 0.5 + Math.sin(TAU * o.freq * 0.5 * t) * 0.4) * (o.level ?? 0.5); }
  return out;
}
export function mixInto(dst: Stereo, src: Mono | Stereo, gainDb = 0, pan = 0): void { addStereo(dst, src instanceof Float32Array ? src : src, 0, db(gainDb) * (src instanceof Float32Array ? Math.cos((pan + 1) * Math.PI / 4) : 1), db(gainDb) * (src instanceof Float32Array ? Math.sin((pan + 1) * Math.PI / 4) : 1)); }
export { clamp };
