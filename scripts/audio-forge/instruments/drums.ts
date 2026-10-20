/**
 * Drum kit synthesis: each piece renders a one-shot from (velocity, variant). The kit caches hits per velocity bucket
 * and variant so a 3 000-hit track costs a few hundred renders. Industrial pieces (anvil, pipe, slam, chain, steam) share
 * the same interface so patterns can mix them with the kit.
 */
import { SR, TAU, type Mono, mono, Rng, db, clamp } from '../dsp/core';
import { Biquad, OnePole, Svf } from '../dsp/filters';
import { Noise } from '../dsp/osc';
import { shape, shapers } from '../dsp/fx';

export type Piece = 'kick' | 'snare' | 'rim' | 'hat' | 'hatOpen' | 'ride' | 'rideBell' | 'crash' | 'china' | 'tomHi' | 'tomMid' | 'tomLo' | 'anvil' | 'pipe' | 'slam' | 'chain' | 'steam' | 'clap' | 'stomp' | 'click';
export const PIECE_PAN: Record<Piece, number> = { kick: 0, snare: 0, rim: 0.05, hat: 0.3, hatOpen: 0.3, ride: 0.45, rideBell: 0.45, crash: -0.4, china: 0.5, tomHi: -0.25, tomMid: 0.1, tomLo: 0.35, anvil: -0.15, pipe: 0.25, slam: 0, chain: -0.35, steam: 0.4, clap: 0.1, stomp: 0, click: 0 };
const t60 = (t: number, s: number) => Math.exp(-6.9078 * t / s);

export interface KitStyle { kickTune?: number; kickClick?: number; snareTune?: number; snareNoise?: number; hatTune?: number; metallic?: number; roomMs?: number; drive?: number }

export class DrumKit {
  private cache = new Map<string, Mono>();
  constructor(readonly style: KitStyle = {}, readonly seed = 11) {}
  /** The one-shot for a piece at velocity (0..1) and round-robin variant. */
  hit(piece: Piece, vel: number, variant = 0): Mono {
    const vb = Math.round(clamp(vel, 0, 1) * 4) / 4, key = `${piece}:${vb}:${variant % 3}`;
    let b = this.cache.get(key);
    if (!b) { b = this.render(piece, vb, variant % 3); this.cache.set(key, b); }
    return b;
  }
  private render(piece: Piece, vel: number, variant: number): Mono {
    const rng = new Rng(this.seed * 7919 + variant * 131 + piece.length), s = this.style, v = 0.35 + 0.65 * vel;
    const noise = new Noise(rng.next() * 1e9 | 0);
    switch (piece) {
      case 'kick': {
        const n = Math.round(0.55 * SR), out = mono(n), tune = s.kickTune ?? 1, click = s.kickClick ?? 1;
        let ph = 0; const bp = new Biquad('bandpass', 3800, 1.2), hp = new Biquad('highpass', 1800, 0.7);
        for (let i = 0; i < n; i++) {
          const t = i / SR, f = (54 + 130 * Math.exp(-t / 0.04)) * tune * rng.jitter(0.002);
          ph += f / SR;
          const body = Math.sin(TAU * ph) * t60(t, 0.36) * Math.min(1, t / 0.0015);
          const beat = bp.run(noise.white()) * t60(t, 0.012) * 1.0 * click + hp.run(noise.white()) * t60(t, 0.004) * 1.1 * click;
          const knock = Math.sin(TAU * 1100 * t) * t60(t, 0.008) * 0.35 * click;
          out[i] = Math.tanh((body * 1.2 + beat * 0.6 + knock) * (1 + (s.drive ?? 0.3))) * v;
        }
        new Biquad('peaking', 62, 1, 1.5).process(out); new Biquad('peaking', 320, 1.2, -3).process(out); new Biquad('peaking', 3600, 1.2, 3.5).process(out); new Biquad('highpass', 34, 0.7).process(out);
        return out;
      }
      case 'snare': case 'rim': {
        const n = Math.round(0.42 * SR), out = mono(n), tune = s.snareTune ?? 1, nz = s.snareNoise ?? 1, rim = piece === 'rim';
        const bpN = new Biquad('bandpass', rim ? 3200 : 2400, rim ? 1.4 : 0.5), hpN = new Biquad('highpass', 900, 0.7), crack = new Biquad('highpass', 2600, 0.8);
        let p1 = 0, p2 = 0;
        for (let i = 0; i < n; i++) {
          const t = i / SR, drop = 1 + 0.35 * Math.exp(-t / 0.02);
          p1 += 186 * tune * drop / SR; p2 += 331 * tune * drop / SR;
          const body = (Math.sin(TAU * p1) * 0.7 + Math.sin(TAU * p2) * 0.45) * t60(t, rim ? 0.07 : 0.14);
          const wires = bpN.run(hpN.run(noise.white())) * t60(t, rim ? 0.12 : 0.21) * (1 + 0.6 * vel) * nz;
          const transient = crack.run(noise.white()) * t60(t, 0.006) * 1.3;
          out[i] = Math.tanh((body * (rim ? 0.6 : 1) + wires * 0.9 + transient) * 1.3) * v;
        }
        new Biquad('peaking', 200, 1.2, rim ? -2 : 2.5).process(out); new Biquad('peaking', 5200, 1, 3).process(out); new Biquad('highpass', 90, 0.7).process(out);
        return out;
      }
      case 'clap': {
        const n = Math.round(0.3 * SR), out = mono(n), bp = new Biquad('bandpass', 1500, 0.8);
        for (let i = 0; i < n; i++) { const t = i / SR; let env = 0; for (const o of [0, 0.011, 0.022, 0.033]) if (t >= o) env += t60(t - o, o === 0.033 ? 0.18 : 0.012); out[i] = bp.run(noise.white()) * env * 0.6 * v; }
        return out;
      }
      case 'hat': case 'hatOpen': {
        const open = piece === 'hatOpen', n = Math.round((open ? 0.5 : 0.1) * SR), out = mono(n), base = 410 * (s.hatTune ?? 1);
        const ratios = [1, 1.342, 1.2312, 1.6532, 1.9523, 2.1437].map(r => r * rng.jitter(0.01)), ph = ratios.map(() => rng.next());
        const bp = new Biquad('bandpass', 9500, 0.7), hp = new Biquad('highpass', 6800, 0.7);
        for (let i = 0; i < n; i++) {
          const t = i / SR; let m = 0;
          for (let k = 0; k < 6; k++) { ph[k] += base * ratios[k] / SR; if (ph[k] >= 1) ph[k] -= 1; m += ph[k] < 0.5 ? 1 : -1; }
          const env = open ? t60(t, 0.4) : t60(t, 0.055 + 0.02 * vel);
          out[i] = hp.run(bp.run(m / 6 * 0.8 + noise.white() * 0.35)) * env * (0.25 + 0.5 * vel) * 0.9;
        }
        return out;
      }
      case 'ride': case 'rideBell': {
        const bell = piece === 'rideBell', n = Math.round(1.6 * SR), out = mono(n), base = 520;
        const ratios = [1, 1.47, 2.09, 2.56, 3.01, 3.9, 4.7].map(r => r * rng.jitter(0.015)), ph = ratios.map(() => rng.next());
        const hp = new Biquad('highpass', bell ? 2500 : 4000, 0.7), bp = new Biquad('bandpass', bell ? 3800 : 7000, bell ? 3 : 0.8);
        for (let i = 0; i < n; i++) {
          const t = i / SR; let m = 0;
          for (let k = 0; k < ratios.length; k++) { ph[k] += base * ratios[k] / SR; if (ph[k] >= 1) ph[k] -= 1; m += Math.sin(TAU * ph[k]) * (k === 0 ? 1 : 0.6); }
          out[i] = (bp.run(m / 4) * (bell ? 1.1 : 0.7) + hp.run(noise.white()) * 0.25 * t60(t, 0.4)) * t60(t, bell ? 1.1 : 1.3) * (0.3 + 0.5 * vel) * 0.8;
        }
        return out;
      }
      case 'crash': case 'china': {
        const china = piece === 'china', n = Math.round((china ? 1.6 : 2.4) * SR), out = mono(n), base = china ? 330 : 440;
        const ratios = [1, 1.21, 1.47, 1.83, 2.09, 2.56, 3.01, 3.7, 4.4, 5.3].map(r => r * rng.jitter(0.02)), ph = ratios.map(() => rng.next());
        const hp = new Biquad('highpass', china ? 1800 : 2400, 0.6), sweep = new Svf(12000, 0.1);
        for (let i = 0; i < n; i++) {
          const t = i / SR; let m = 0;
          for (let k = 0; k < ratios.length; k++) { ph[k] += base * ratios[k] / SR; if (ph[k] >= 1) ph[k] -= 1; m += (ph[k] < 0.5 ? 1 : -1) * 0.5 + Math.sin(TAU * ph[k]) * 0.5; }
          sweep.set(3500 + 9000 * Math.exp(-t / (china ? 0.3 : 0.6)), 0.1);
          const wash = sweep.run(noise.white()) * 1.2;
          out[i] = hp.run(m / 5 * 0.7 + wash) * t60(t, china ? 1.2 : 2.1) * Math.min(1, t / 0.004) * (0.3 + 0.5 * vel) * 0.7;
        }
        if (china) new Biquad('peaking', 4200, 2, 5).process(out);
        return out;
      }
      case 'tomHi': case 'tomMid': case 'tomLo': {
        const f0 = piece === 'tomHi' ? 240 : piece === 'tomMid' ? 170 : 110, n = Math.round(0.45 * SR), out = mono(n), bp = new Biquad('bandpass', f0 * 6, 1);
        let ph = 0;
        for (let i = 0; i < n; i++) { const t = i / SR; ph += f0 * (1 + 0.5 * Math.exp(-t / 0.05)) / SR; out[i] = (Math.sin(TAU * ph) * t60(t, 0.32) + bp.run(noise.white()) * t60(t, 0.03) * 0.5) * v * 0.9; }
        return out;
      }
      case 'anvil': {
        const n = Math.round(1.4 * SR), out = mono(n), f = 640 * rng.jitter(0.03), ratios = [1, 2.76, 5.4, 8.9, 12.3], amps = [1, 0.55, 0.3, 0.15, 0.08], ph = ratios.map(() => rng.next());
        const hp = new Biquad('highpass', 2200, 0.8);
        for (let i = 0; i < n; i++) {
          const t = i / SR; let m = 0;
          for (let k = 0; k < ratios.length; k++) { ph[k] += f * ratios[k] / SR; if (ph[k] >= 1) ph[k] -= 1; m += Math.sin(TAU * ph[k]) * amps[k] * t60(t, 1.1 / (1 + 0.5 * k)); }
          out[i] = (m * 0.5 + hp.run(noise.white()) * t60(t, 0.01) * 0.9) * Math.min(1, t / 0.001) * v;
        }
        return out;
      }
      case 'pipe': {
        const n = Math.round(0.8 * SR), out = mono(n), f = 240 * rng.jitter(0.05), r1 = new Biquad('bandpass', f, 28), r2 = new Biquad('bandpass', f * 2.4, 22), r3 = new Biquad('bandpass', f * 4.1, 18), tr = new Biquad('highpass', 1500, 0.7);
        for (let i = 0; i < n; i++) { const t = i / SR, w = noise.white() * t60(t, 0.02); out[i] = (r1.run(w) * 6 + r2.run(w) * 3 + r3.run(w) * 1.5) * t60(t, 0.6) * 0.8 * v + tr.run(w) * 0.4 * v; }
        return out;
      }
      case 'slam': {
        const n = Math.round(1.2 * SR), out = mono(n), lp = new OnePole(220), hp = new Biquad('highpass', 1200, 0.8);
        let ph = 0;
        for (let i = 0; i < n; i++) { const t = i / SR, f = 40 + 90 * Math.exp(-t / 0.08); ph += f / SR; out[i] = (Math.sin(TAU * ph) * t60(t, 0.7) * 1.2 + lp.run(noise.brown()) * t60(t, 0.5) * 1.5 + hp.run(noise.white()) * t60(t, 0.03) * 0.9) * v; }
        shape(out, shapers.tanh(1.6));
        return out;
      }
      case 'chain': {
        const n = Math.round(0.5 * SR), out = mono(n), bp = new Biquad('bandpass', 3800, 4);
        for (let i = 0; i < n; i++) { const t = i / SR; const g = (Math.sin(t * 97) > 0.6 ? 1 : 0.1) * (rng.next() < 0.3 ? 1 : 0.4); out[i] = bp.run(noise.white()) * g * t60(t, 0.35) * 0.9 * v; }
        return out;
      }
      case 'steam': {
        const n = Math.round(0.9 * SR), out = mono(n), bp = new Biquad('bandpass', 2800, 0.6), lp = new Biquad('lowpass', 7000, 0.7);
        for (let i = 0; i < n; i++) { const t = i / SR; out[i] = lp.run(bp.run(noise.white())) * Math.min(1, t / 0.03) * t60(t, 0.7) * 0.7 * v; }
        return out;
      }
      case 'stomp': {
        const n = Math.round(0.4 * SR), out = mono(n), lp = new OnePole(300);
        let ph = 0;
        for (let i = 0; i < n; i++) { const t = i / SR; ph += (55 + 60 * Math.exp(-t / 0.03)) / SR; out[i] = (Math.sin(TAU * ph) * t60(t, 0.25) + lp.run(noise.white()) * t60(t, 0.06) * 1.2) * v; }
        return out;
      }
      case 'click': {
        const n = Math.round(0.03 * SR), out = mono(n), hp = new Biquad('highpass', 3000, 0.7);
        for (let i = 0; i < n; i++) out[i] = hp.run(noise.white()) * t60(i / SR, 0.008) * v;
        return out;
      }
    }
  }
}
/** Light glue for a drum stem: parallel-style saturation and a transient-preserving compressor are applied in master.ts. */
export const DRUM_LEVEL: Record<Piece, number> = { kick: db(-4.5), snare: db(1.5), rim: db(-1), hat: db(-7), hatOpen: db(-6.5), ride: db(-6.5), rideBell: db(-5.5), crash: db(-6), china: db(-5.5), tomHi: db(-3), tomMid: db(-3), tomLo: db(-3.5), anvil: db(-6), pipe: db(-5), slam: db(-4), chain: db(-11), steam: db(-11), clap: db(-6), stomp: db(-4), click: db(-15) };
