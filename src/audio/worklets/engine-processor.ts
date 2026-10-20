/**
 * AudioWorklet processor for one tank's loops (the nearest 4 chassis get one node each). Runs on the audio render
 * thread; the main thread only writes eight k-rate AudioParams, so no node churn and no per-frame messages.
 *
 * - Engine: a heavy multi-cylinder diesel. Each firing is a short noise-and-tone pulse with per-firing amplitude and
 *   timing jitter (the unevenness that reads as a real machine), through an exhaust resonator (deep, load-tracking)
 *   and an intake resonator (mid, opens with load). A turbo whine (a detuned pair far above the fundamental) spools up
 *   with load and speed and blows off (a short hiss-and-flutter) when the load drops; valve-train ticks at twice the
 *   firing rate clatter through a bright resonator under load.
 * - Gears: the main thread's fundamental already steps by gear (tank-sfx-math.engineParams); the processor adds the
 *   shift itself: when the fundamental jumps, the load dips for ~120 ms and a clunk-and-hiss marks the change.
 * - Tread: link-slap grains at `tread` per second (belt speed / link pitch), each a noise burst through a pad thud
 *   resonator (~180 Hz) and a pin clink resonator (~1.4 kHz); above ~35 grains/s it crossfades to AM noise so a fast
 *   belt purrs instead of buzzing; a low ground roll rides under it. Hard turns (`turn`) add metallic track clatter:
 *   denser, brighter link hits with a scraping band.
 * - Slip squeal: a narrow, wobbling resonance on noise, scaled by track slip.
 * - Servo: a stepper-like motor hum (sine + 3rd harmonic) with gear ticks on aim motion.
 * - Damage (`damage`): firings drop out at random (misfires), timing jitter widens, and the occasional backfire pops
 *   through the exhaust.
 *
 * Bundled by Vite through `?worker&url` (see worklets/engine-url.ts). Pure DSP: no imports but the shared descriptors.
 */

import { ENGINE_PARAM_DESCRIPTORS, ENGINE_PROCESSOR, type EngineParamName } from './engine-params';

// AudioWorkletGlobalScope (TypeScript ships no lib for it). This file is a module (it imports), so these stay local.
// It must not export anything: Vite bundles it as an IIFE worker script.
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor { constructor(options?: unknown); }

const TAU = Math.PI * 2;

class Resonator {
  private b0 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  /** RBJ band-pass (0 dB peak). */
  tune(f: number, q: number, sr: number): void {
    const w = TAU * Math.min(f, sr * 0.45) / sr, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b2 = -alpha / a0; this.a1 = -2 * Math.cos(w) / a0; this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

type Params = Record<EngineParamName, Float32Array>;

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return ENGINE_PARAM_DESCRIPTORS; }

  private seed: number;
  // Engine state.
  private fireAcc = 0; private fireEnv = 0; private fireAmp = 1; private fireTone = 0; private readonly fireDecay: number;
  private readonly exhaust = new Resonator(); private readonly intake = new Resonator(); private readonly valve = new Resonator();
  private exhaustF = 0; private intakeF = 0;
  private turboA = 0; private turboB = 0; private gearPh = 0;
  private turboSpool = 0;        // the turbo's own inertia: spools up slowly, blows off when the load drops
  private blowOff = 0; private blowPh = 0;
  private valveAcc = 0; private valveEnv = 0; private readonly valveDecay: number;
  private hissLo = 0; private hissHi = 0; private sub = 0;
  // Gear shift state.
  private lastF = 0; private shiftEnv = 0; private shiftClunk = 0; private readonly shiftDecay: number; private readonly clunkDecay: number;
  private readonly clunk = new Resonator();
  // Damage: misfires and backfires.
  private misfire = 0; private backfireEnv = 0; private readonly backfireDecay: number; private readonly backfireLp = new Resonator();
  // Tread state.
  private treadAcc = 0; private grainEnv = 0; private grainAmp = 0; private readonly grainDecay: number;
  private readonly pad = new Resonator(); private readonly pin = new Resonator();
  private treadPh = 0; private amLp = 0; private rumble = 0;
  // Turn clatter.
  private clatterAcc = 0; private clatterEnv = 0; private readonly clatterDecay: number; private readonly clatter = new Resonator(); private readonly scrape = new Resonator(); private scrapePh = 0;
  // Slip and servo.
  private readonly squeal = new Resonator(); private squealPh = 0; private retune = 0;
  private servoPh = 0; private tickAcc = 0; private tickEnv = 0; private readonly tickDecay: number; private readonly gear = new Resonator();
  // Per-block smoothing (linear from the previous block's values).
  private f0 = 50; private load0 = 0.25; private tread0 = 0; private slip0 = 0; private servo0 = 0; private level0 = 0; private turn0 = 0; private damage0 = 0;
  private retuneEngine = 0;

  constructor(options?: { processorOptions?: { seed?: number } }) {
    super(options);
    this.seed = ((options?.processorOptions?.seed ?? 0x2545f491) >>> 0) || 1;
    this.fireDecay = Math.exp(-1 / (0.004 * sampleRate));
    this.valveDecay = Math.exp(-1 / (0.0012 * sampleRate));
    this.grainDecay = Math.exp(-1 / (0.0065 * sampleRate));
    this.tickDecay = Math.exp(-1 / (0.0025 * sampleRate));
    this.shiftDecay = Math.exp(-1 / (0.12 * sampleRate));
    this.clunkDecay = Math.exp(-1 / (0.018 * sampleRate));
    this.backfireDecay = Math.exp(-1 / (0.05 * sampleRate));
    this.clatterDecay = Math.exp(-1 / (0.004 * sampleRate));
    this.gear.tune(1800, 1.6, sampleRate);
    this.pad.tune(180, 2.5, sampleRate);
    this.pin.tune(1400, 6, sampleRate);
    this.valve.tune(2600, 5, sampleRate);
    this.exhaust.tune(95, 1.8, sampleRate);
    this.intake.tune(520, 1.4, sampleRate);
    this.clunk.tune(420, 3, sampleRate);
    this.backfireLp.tune(160, 1.2, sampleRate);
    this.clatter.tune(2200, 4, sampleRate);
    this.scrape.tune(3400, 9, sampleRate);
  }

  private rand(): number {
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s >>> 0;
    return this.seed / 4294967296;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], parameters: Params): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const n = out.length, sr = sampleRate;
    const f1 = parameters.fundamental[0], load1 = parameters.load[0], tread1 = parameters.tread[0];
    const slip1 = parameters.slip[0], servo1 = parameters.servo[0], level1 = parameters.level[0];
    const turn1 = parameters.turn?.[0] ?? 0, damage1 = parameters.damage?.[0] ?? 0;
    if (level1 < 1e-4 && this.level0 < 1e-4) { out.fill(0); this.level0 = level1; this.lastF = f1; return true; }
    // A gear shift: the fundamental jumped by more than a few Hz since the last block.
    if (this.lastF > 0 && Math.abs(f1 - this.lastF) > 6 && level1 > 0.05) { this.shiftEnv = 1; this.shiftClunk = 1; }
    this.lastF = f1;
    // Resonators follow the engine speed/load once per block (cheap, inaudible as steps at 128 samples).
    const exhaustF = 70 + f1 * 0.55, intakeF = 380 + 420 * load1 + f1 * 0.8;
    if (Math.abs(exhaustF - this.exhaustF) > 1 || Math.abs(intakeF - this.intakeF) > 4 || --this.retuneEngine <= 0) {
      this.exhaust.tune(exhaustF, 1.6 + 0.6 * load1, sr); this.intake.tune(intakeF, 1.3, sr); this.exhaustF = exhaustF; this.intakeF = intakeF; this.retuneEngine = 64;
    }
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const k = (i + 1) * inv;
      const f = this.f0 + (f1 - this.f0) * k;
      // The shift dips the load for ~120 ms (the clutch) before it comes back.
      const load = Math.max(0.05, (this.load0 + (load1 - this.load0) * k) * (1 - 0.7 * this.shiftEnv));
      const tread = this.tread0 + (tread1 - this.tread0) * k, slip = this.slip0 + (slip1 - this.slip0) * k;
      const servo = this.servo0 + (servo1 - this.servo0) * k, level = this.level0 + (level1 - this.level0) * k;
      const turn = this.turn0 + (turn1 - this.turn0) * k, damage = this.damage0 + (damage1 - this.damage0) * k;
      const white = this.rand() * 2 - 1;
      this.shiftEnv *= this.shiftDecay;

      // ---- Engine: firing pulses with jitter → exhaust + intake resonators; sub; turbo; valves; hiss; misfires.
      this.fireAcc += f / sr;
      if (this.fireAcc >= 1) {
        this.fireAcc -= 1 + (this.rand() - 0.5) * (0.05 + 0.1 * (1 - load) + 0.25 * damage);
        if (this.fireAcc < 0) this.fireAcc = 0;
        // A damaged engine drops firings (misfire) and, now and then, backfires through the exhaust.
        const miss = damage > 0.01 && this.rand() < 0.35 * damage;
        this.fireEnv = miss ? 0.12 : 1; this.fireAmp = 0.7 + 0.3 * this.rand() + 0.25 * load;
        this.fireTone = this.rand() * TAU;
        if (miss && this.rand() < 0.25) this.backfireEnv = 1;
        this.misfire = miss ? 1 : 0;
      }
      const pulse = (white * 0.6 + Math.sin(this.fireTone + this.fireEnv * 9) * 0.5) * this.fireEnv * this.fireAmp;
      this.fireEnv *= this.fireDecay;
      this.sub += f * 0.5 / sr; if (this.sub >= 1) this.sub -= 1;
      const exhaust = this.exhaust.run(pulse) * (2.2 + 1.2 * load);
      const intake = this.intake.run(pulse) * (0.5 + 1.6 * load);
      const subTone = Math.sin(TAU * this.sub) * (0.14 + 0.1 * load) * (0.6 + 0.4 * Math.max(0, Math.cos(TAU * this.fireAcc))) * (1 - 0.5 * this.misfire);
      const speed01 = Math.max(0, Math.min(1, (f - 46 - 22 * load) / 110));
      // Turbo: spools towards load*speed slowly (inertia), blows off when the demand drops sharply.
      const turboTarget = speed01 * (0.4 + 0.6 * load);
      const spoolRate = turboTarget > this.turboSpool ? 0.35 / sr : 1.4 / sr;
      if (turboTarget < this.turboSpool - 0.25 && this.blowOff <= 0.01) this.blowOff = 1;
      this.turboSpool += (turboTarget - this.turboSpool) * Math.min(1, spoolRate * 60);
      const turboF = f * (6 + 4 * this.turboSpool);
      this.turboA += turboF / sr; if (this.turboA >= 1) this.turboA -= 1;
      this.turboB += turboF * 1.008 / sr; if (this.turboB >= 1) this.turboB -= 1;
      const turbo = (Math.sin(TAU * this.turboA) + Math.sin(TAU * this.turboB)) * (0.008 + 0.04 * this.turboSpool);
      // Blow-off: a 250 ms hiss with a 38 Hz flutter.
      this.blowPh += 38 / sr; if (this.blowPh >= 1) this.blowPh -= 1;
      const blow = this.hissHi * this.blowOff * (0.55 + 0.45 * Math.sin(TAU * this.blowPh)) * 0.35;
      this.blowOff *= 1 - 4 / sr;
      this.gearPh += f * 4.5 / sr; if (this.gearPh >= 1) this.gearPh -= 1;
      const gearbox = (this.gearPh < 0.5 ? 1 : -1) * 0.012 * speed01;
      this.valveAcc += f * 2 / sr;
      if (this.valveAcc >= 1) { this.valveAcc -= 1; this.valveEnv = 0.5 + 0.5 * this.rand(); }
      const valves = this.valve.run(white * this.valveEnv) * (0.25 + 0.9 * load) * 0.6;
      this.valveEnv *= this.valveDecay;
      this.hissLo += 0.08 * (white - this.hissLo); this.hissHi += 0.35 * (white - this.hissHi);
      const hiss = (this.hissHi - this.hissLo) * (0.04 + 0.1 * load);
      // Gear shift clunk: a short knock through a mid resonator plus a hiss puff.
      const clunk = this.clunk.run(white * this.shiftClunk) * 3 + (this.hissHi - this.hissLo) * this.shiftClunk * 0.6;
      this.shiftClunk *= this.clunkDecay;
      // Backfire: a low pop through the exhaust.
      const backfire = this.backfireLp.run(white * this.backfireEnv) * 6 * damage;
      this.backfireEnv *= this.backfireDecay;
      const engineRaw = exhaust * 0.55 + intake * 0.3 + subTone + turbo + blow + gearbox + valves + hiss + clunk + backfire;
      const engine = 1.3 * engineRaw / (1 + Math.abs(engineRaw) * 0.8);

      // ---- Tread: link-slap grains through pad/pin resonators, AM noise at high rates, and a low ground roll.
      this.treadAcc += tread / sr;
      if (this.treadAcc >= 1) {
        this.treadAcc -= 1 + (this.rand() - 0.5) * 0.18;
        if (this.treadAcc < 0) this.treadAcc = 0;
        this.grainEnv = 1;
        this.grainAmp = 0.55 + 0.45 * this.rand();
        this.pin.tune(1100 + 900 * this.rand(), 6, sr);
      }
      const burst = white * this.grainEnv * this.grainAmp;
      const grain = this.pad.run(burst) * 3.2 + this.pin.run(burst) * 1.4;
      this.grainEnv *= this.grainDecay;
      this.treadPh += tread / sr; if (this.treadPh >= 1) this.treadPh -= 1;
      this.amLp += 0.25 * (white - this.amLp);
      const am = this.amLp * (0.55 + 0.45 * Math.sin(TAU * this.treadPh));
      const blend = Math.max(0, Math.min(1, (tread - 35) / 20));
      this.rumble += 0.02 * (white - this.rumble);
      let treadOut = (grain * (1 - blend) + am * 0.9 * blend) * Math.min(1, tread / 6) + this.rumble * 1.8 * Math.min(1, tread / 30);
      // Hard turns: metallic track clatter (denser, brighter link hits) and a scraping band that wobbles.
      if (turn > 0.01) {
        this.clatterAcc += (18 + 40 * turn) / sr;
        if (this.clatterAcc >= 1) { this.clatterAcc -= 1 + (this.rand() - 0.5) * 0.5; this.clatterEnv = 0.5 + 0.5 * this.rand(); this.clatter.tune(1600 + 1800 * this.rand(), 5, sr); }
        this.scrapePh += 7 / sr; if (this.scrapePh >= 1) this.scrapePh -= 1;
        if ((i & 31) === 0) this.scrape.tune(3000 + 900 * Math.sin(TAU * this.scrapePh), 9, sr);
        treadOut += this.clatter.run(white * this.clatterEnv) * 2.2 * turn + this.scrape.run(white) * 0.5 * turn;
        this.clatterEnv *= this.clatterDecay;
      }

      // ---- Slip squeal: a wobbling narrow resonance (retuned every 32 samples).
      let squeal = 0;
      if (slip > 0.01) {
        if (--this.retune <= 0) {
          this.retune = 32;
          this.squealPh += 32 * 5.3 / sr; if (this.squealPh >= 1) this.squealPh -= 1;
          this.squeal.tune(3100 + 350 * Math.sin(TAU * this.squealPh), 14, sr);
        }
        squeal = this.squeal.run(white) * slip * 1.4;
      }

      // ---- Servo: a stepper-like motor hum with gear ticks on aim motion.
      let servoOut = 0;
      if (servo > 0.01) {
        this.servoPh += (360 + 480 * servo) / sr; if (this.servoPh >= 1) this.servoPh -= 1;
        const sp = TAU * this.servoPh;
        this.tickAcc += (22 + 40 * servo) / sr;
        if (this.tickAcc >= 1) { this.tickAcc -= 1; this.tickEnv = 1; }
        const tick = this.gear.run(white * this.tickEnv) * 2;
        this.tickEnv *= this.tickDecay;
        servoOut = (Math.sin(sp) + 0.08 * Math.sin(3 * sp)) * servo * 0.055 + tick * servo * 0.12;
      }

      const mix = (engine * 0.6 + treadOut * 0.55 + squeal * 0.3 + servoOut) * level;
      out[i] = mix / (1 + Math.abs(mix) * 0.6);
    }
    this.f0 = f1; this.load0 = load1; this.tread0 = tread1; this.slip0 = slip1; this.servo0 = servo1; this.level0 = level1; this.turn0 = turn1; this.damage0 = damage1;
    return true;
  }
}

registerProcessor(ENGINE_PROCESSOR, EngineProcessor);
