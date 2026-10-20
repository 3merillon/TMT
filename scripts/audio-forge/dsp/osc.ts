/** Oscillators and noise: polyBLEP saw/pulse (alias-free enough at 48 kHz), sine/triangle, FM operator, coloured noise. */
import { SR, TAU, Rng, type Mono, mono } from './core';

function polyBlep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
export class Osc {
  phase = 0;
  constructor(public freq = 110, public sr = SR, phase = 0) { this.phase = phase; }
  private step(): number { const dt = this.freq / this.sr; this.phase += dt; if (this.phase >= 1) this.phase -= 1; else if (this.phase < 0) this.phase += 1; return dt; }
  sine(): number { this.step(); return Math.sin(TAU * this.phase); }
  saw(): number { const dt = this.step(); return 2 * this.phase - 1 - polyBlep(this.phase, dt); }
  pulse(width = 0.5): number {
    const dt = this.step();
    let v = this.phase < width ? 1 : -1;
    v += polyBlep(this.phase, dt); v -= polyBlep((this.phase + 1 - width) % 1, dt);
    return v;
  }
  triangle(): number { this.step(); const p = this.phase; return 4 * Math.abs(p - 0.5) - 1; }
}
/** FM operator pair: carrier modulated by a modulator at ratio with index (in radians). */
export class Fm {
  private cp = 0; private mp = 0;
  constructor(public freq: number, public ratio = 1, public index = 1, public sr = SR) {}
  run(indexScale = 1): number {
    this.mp += this.freq * this.ratio / this.sr; if (this.mp >= 1) this.mp -= 1;
    this.cp += this.freq / this.sr; if (this.cp >= 1) this.cp -= 1;
    return Math.sin(TAU * this.cp + this.index * indexScale * Math.sin(TAU * this.mp));
  }
}
export class Noise {
  private rng: Rng;
  private b0 = 0; private b1 = 0; private b2 = 0; private b3 = 0; private b4 = 0; private b5 = 0; private b6 = 0;
  private brownLast = 0;
  constructor(seed: number) { this.rng = new Rng(seed); }
  white(): number { return this.rng.signed(); }
  /** Paul Kellet's pink approximation (−3 dB/oct), roughly unity peak. */
  pink(): number {
    const w = this.rng.signed();
    this.b0 = 0.99886 * this.b0 + w * 0.0555179; this.b1 = 0.99332 * this.b1 + w * 0.0750759; this.b2 = 0.96900 * this.b2 + w * 0.1538520;
    this.b3 = 0.86650 * this.b3 + w * 0.3104856; this.b4 = 0.55000 * this.b4 + w * 0.5329522; this.b5 = -0.7616 * this.b5 - w * 0.0168980;
    const out = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + w * 0.5362;
    this.b6 = w * 0.115926;
    return out * 0.11;
  }
  brown(): number { this.brownLast = (this.brownLast + 0.02 * this.rng.signed()) / 1.02; return this.brownLast * 3.5; }
  fill(n: number, kind: 'white' | 'pink' | 'brown' = 'white'): Mono { const out = mono(n); for (let i = 0; i < n; i++) out[i] = kind === 'white' ? this.white() : kind === 'pink' ? this.pink() : this.brown(); return out; }
}
/** A detuned stack of saws (unison), normalised. */
export class Unison {
  private oscs: Osc[] = []; private gains: number[] = [];
  constructor(freq: number, voices = 5, detuneCents = 12, rng?: Rng, sr = SR) {
    for (let i = 0; i < voices; i++) {
      const spread = voices === 1 ? 0 : (i / (voices - 1) - 0.5) * 2;
      const o = new Osc(freq * Math.pow(2, spread * detuneCents / 1200), sr, rng ? rng.next() : i / voices);
      this.oscs.push(o); this.gains.push(1 / Math.sqrt(voices));
    }
  }
  setFreq(freq: number, detuneCents = 12): void { const n = this.oscs.length; this.oscs.forEach((o, i) => { const spread = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2; o.freq = freq * Math.pow(2, spread * detuneCents / 1200); }); }
  saw(): number { let v = 0; for (let i = 0; i < this.oscs.length; i++) v += this.oscs[i].saw() * this.gains[i]; return v; }
  pulse(width = 0.5): number { let v = 0; for (let i = 0; i < this.oscs.length; i++) v += this.oscs[i].pulse(width) * this.gains[i]; return v; }
}
