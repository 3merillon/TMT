// Ported from Pinionfall src/audio/combat-sfx-math.ts (MIT, same owner)
/**
 * Tank SFX parameter math, PURE (no DOM, no WebAudio, no imports but the seeded RNG).
 *
 * The discipline is Pinionfall's combat-sfx-math: this file owns the numbers, and `sfx/layers.ts` mechanically
 * translates a {@link Recipe} into WebAudio nodes. Every sound is a recipe of layers, so a test can walk every weapon,
 * munition, distance and seed and check the numbers (finite, monotone, in range) without an AudioContext.
 *
 * Conventions (shared with layers.ts):
 * - durations and delays are SECONDS, frequencies HERTZ, peaks are linear gain (0, 1.5];
 * - a layer's decay target is never 0 (`exponentialRampToValueAtTime` throws), the synth ramps to 0.0001;
 * - distances are TMT units (planet radius 18, tank ≈ 1.6 u long); the stylised speed of sound is 60 u/s.
 */
import { Rng } from '../rng';

// ---- Recipe model -----------------------------------------------------------------------------------------------------
export type NoiseColor = 'white' | 'pink' | 'brown';
export type FilterKind = 'lowpass' | 'bandpass' | 'highpass';
export type Wave = 'sine' | 'triangle' | 'sawtooth' | 'square';

/** Filtered noise read from a shared pool: linear attack, optional hold, exponential decay; the filter sweeps
 * exponentially f0 → (fMid at midAt·dur) → f1. `swell` makes the attack an exponential swell (pre-swells, suck-backs);
 * `lfo` = [f1, depth1, f2, depth2] rolls the gain (thunder rumble); `pan` is an extra stereo offset (peals). */
export interface NoiseLayer {
  kind: 'noise'; noise: NoiseColor; filter: FilterKind; delay: number; dur: number; attack: number; hold: number; peak: number;
  f0: number; f1: number; q: number; fMid?: number; midAt?: number; swell?: boolean; lfo?: readonly [number, number, number, number]; pan?: number;
}
/** An oscillator with an exponential pitch sweep f0 → f1 and the same envelope shape; optional vibrato [rate Hz, cents]. */
export interface ToneLayer {
  kind: 'tone'; wave: Wave; delay: number; dur: number; attack: number; hold: number; peak: number; f0: number; f1: number;
  swell?: boolean; vibrato?: readonly [number, number];
}
/** Struck metal: inharmonic sine partials f·ratio, each with a 2 ms attack and its own exponential decay (higher
 * partials die faster). */
export interface PartialLayer { kind: 'partials'; delay: number; f: number; ratios: readonly number[]; peaks: readonly number[]; decay: number }
/** A capacitor whine: a sawtooth sweeping f0 → f1 through a resonant low-pass that tracks the pitch. */
export interface WhineLayer { kind: 'whine'; delay: number; dur: number; attack: number; peak: number; f0: number; f1: number; q: number }
/** Ring-modulated band noise (a sine carrier multiplies band-passed noise): the rail's electric tail. */
export interface RingLayer { kind: 'ring'; delay: number; dur: number; attack: number; peak: number; carrier: number; f: number; q: number }
/** Granular ticks from ONE noise source, ONE filter and ONE gain: each tick is a gain spike and a filter jump, so a
 * debris rain of 30 ticks costs three nodes. Times are relative to `delay`, sorted, and each tick ends before the next. */
export interface TickLayer {
  kind: 'ticks'; noise: NoiseColor; filter: FilterKind; delay: number; q: number;
  times: readonly number[]; freqs: readonly number[]; peaks: readonly number[]; durs: readonly number[];
}
export type Layer = NoiseLayer | ToneLayer | PartialLayer | WhineLayer | RingLayer | TickLayer;
export interface Recipe { gain: number; layers: Layer[] }

/** Longest partial decay relative to the base decay (partial i decays over decay / (1 + 0.6 i)). */
export const partialDecay = (decay: number, i: number) => decay / (1 + 0.6 * i);

/** End of a layer relative to the recipe start (seconds). */
export function layerEnd(l: Layer): number {
  switch (l.kind) {
    case 'partials': return l.delay + l.decay;
    case 'ticks': {
      let end = 0;
      for (let i = 0; i < l.times.length; i++) end = Math.max(end, l.times[i] + l.durs[i]);
      return l.delay + end;
    }
    default: return l.delay + l.dur;
  }
}
/** End of the last layer (seconds): how long the voice lives, for budgeting and cleanup. */
export function recipeDuration(r: Recipe): number {
  let end = 0;
  for (const l of r.layers) end = Math.max(end, layerEnd(l));
  return end;
}

const MIN_HZ = 20, MAX_HZ = 20000;
/** Problems with a recipe (empty = valid). Used by the tests and by a dev assertion in layers.ts. */
export function validateRecipe(r: Recipe): string[] {
  const out: string[] = [];
  const finite = (name: string, v: number) => { if (!Number.isFinite(v)) out.push(`${name} is not finite (${v})`); };
  const hz = (name: string, v: number) => { finite(name, v); if (!(v >= MIN_HZ && v <= MAX_HZ)) out.push(`${name} ${v} Hz is outside [${MIN_HZ}, ${MAX_HZ}]`); };
  const peak = (name: string, v: number) => { finite(name, v); if (!(v > 0 && v <= 1.5)) out.push(`${name} ${v} is outside (0, 1.5]`); };
  finite('gain', r.gain);
  if (!(r.gain > 0 && r.gain <= 2)) out.push(`gain ${r.gain} is outside (0, 2]`);
  r.layers.forEach((l, index) => {
    const n = `layers[${index}] ${l.kind}`;
    finite(`${n}.delay`, l.delay);
    if (!(l.delay >= 0)) out.push(`${n}.delay ${l.delay} is negative`);
    switch (l.kind) {
      case 'noise': case 'tone': case 'whine': case 'ring': {
        finite(`${n}.dur`, l.dur); finite(`${n}.attack`, l.attack);
        if (!(l.dur > 0)) out.push(`${n}.dur ${l.dur} must be positive`);
        const hold = l.kind === 'noise' || l.kind === 'tone' ? l.hold : 0;
        if (!(l.attack > 0 && l.attack + hold < l.dur)) out.push(`${n} attack ${l.attack} + hold ${hold} must be inside dur ${l.dur}`);
        peak(`${n}.peak`, l.peak);
        if (l.kind === 'noise') { hz(`${n}.f0`, l.f0); hz(`${n}.f1`, l.f1); finite(`${n}.q`, l.q); if (l.fMid !== undefined) hz(`${n}.fMid`, l.fMid);
          if (l.midAt !== undefined && !(l.midAt > 0 && l.midAt < 1)) out.push(`${n}.midAt ${l.midAt} is outside (0, 1)`);
          if (l.pan !== undefined && !(Math.abs(l.pan) <= 1)) out.push(`${n}.pan ${l.pan} is outside [-1, 1]`);
          if (l.lfo) l.lfo.forEach((v, i) => finite(`${n}.lfo[${i}]`, v)); }
        if (l.kind === 'tone') { hz(`${n}.f0`, l.f0); hz(`${n}.f1`, l.f1); if (l.vibrato) l.vibrato.forEach((v, i) => finite(`${n}.vibrato[${i}]`, v)); }
        if (l.kind === 'whine') { hz(`${n}.f0`, l.f0); hz(`${n}.f1`, l.f1); finite(`${n}.q`, l.q); }
        if (l.kind === 'ring') { hz(`${n}.carrier`, l.carrier); hz(`${n}.f`, l.f); finite(`${n}.q`, l.q); }
        break;
      }
      case 'partials': {
        hz(`${n}.f`, l.f); finite(`${n}.decay`, l.decay);
        if (!(l.decay > 0.003)) out.push(`${n}.decay ${l.decay} is too short`);
        if (l.ratios.length !== l.peaks.length || !l.ratios.length) out.push(`${n} needs one peak per ratio`);
        l.ratios.forEach((ratio, i) => { finite(`${n}.ratios[${i}]`, ratio); peak(`${n}.peaks[${i}]`, l.peaks[i]); });
        break;
      }
      case 'ticks': {
        finite(`${n}.q`, l.q);
        const count = l.times.length;
        if (!count || l.freqs.length !== count || l.peaks.length !== count || l.durs.length !== count) out.push(`${n} arrays must share one non-zero length`);
        for (let i = 0; i < count; i++) {
          finite(`${n}.times[${i}]`, l.times[i]); hz(`${n}.freqs[${i}]`, l.freqs[i]); peak(`${n}.peaks[${i}]`, l.peaks[i]);
          if (!(l.durs[i] > 0.0015)) out.push(`${n}.durs[${i}] ${l.durs[i]} is too short`);
          if (i > 0 && !(l.times[i] >= l.times[i - 1] + l.durs[i - 1] - 1e-9)) out.push(`${n} tick ${i} starts before tick ${i - 1} ends`);
        }
        if (count && !(l.times[0] >= 0)) out.push(`${n}.times[0] is negative`);
        break;
      }
    }
  });
  return out;
}

// ---- Small helpers ----------------------------------------------------------------------------------------------------
export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function clamp01(v: number): number { return Number.isFinite(v) ? clamp(v, 0, 1) : 0; }
function mix(a: number, b: number, t: number): number { return a + (b - a) * clamp01(t); }
const hzc = (v: number) => clamp(v, MIN_HZ + 1, 18000);

/** Builds a sorted, non-overlapping tick train. `density` shapes when ticks fall inside [t0, t1] (1 = uniform,
 * >1 = front-loaded like a debris rain thinning out). Peaks fall with time by `fade` (0 = flat). */
function tickTrain(rng: Rng, o: { count: number; t0: number; t1: number; density: number; fLo: number; fHi: number;
  dLo: number; dHi: number; pLo: number; pHi: number; fade: number }): { times: number[]; freqs: number[]; peaks: number[]; durs: number[] } {
  const count = Math.max(1, Math.round(o.count));
  const raw: number[] = [];
  for (let i = 0; i < count; i++) raw.push(o.t0 + (o.t1 - o.t0) * Math.pow(rng.next(), o.density));
  raw.sort((a, b) => a - b);
  const times: number[] = [], freqs: number[] = [], peaks: number[] = [], durs: number[] = [];
  let lastEnd = -Infinity;
  for (let i = 0; i < count; i++) {
    const t = Math.max(raw[i], lastEnd + 0.002);
    const nextStart = i + 1 < count ? Math.max(raw[i + 1], t + 0.004) : Infinity;
    const dur = Math.min(rng.range(o.dLo, o.dHi), nextStart - t - 0.0005);
    if (dur < 0.002) continue;
    const age = (t - o.t0) / Math.max(1e-6, o.t1 - o.t0);
    times.push(t); durs.push(dur);
    freqs.push(hzc(rng.range(o.fLo, o.fHi)));
    peaks.push(clamp(rng.range(o.pLo, o.pHi) * (1 - o.fade * clamp01(age)), 0.001, 1.5));
    lastEnd = t + dur;
  }
  return { times, freqs, peaks, durs };
}

// ---- Weapons -----------------------------------------------------------------------------------------------------------
export type WeaponVoice = 'mortar' | 'cannon' | 'rail';
export const WEAPON_VOICES: readonly WeaponVoice[] = ['mortar', 'cannon', 'rail'];
/** Kit weapon id (or the v1 barrel) → voice table; unknown ids sound like the cannon. */
export function weaponVoiceOf(id: string | undefined): WeaponVoice {
  return id === 'mortar' || id === 'rail' ? id : 'cannon';
}
/** When the loader clunks home after a shot (seconds). */
export const RELOAD_CLUNK_AT: Readonly<Record<WeaponVoice, number>> = { mortar: 1.3, cannon: 1.6, rail: 1.9 };
/** The rail's charge whine leads the crack by this much (s): short enough to stay inside audio-visual sync tolerance. */
export const RAIL_CHARGE_S = 0.09;

const noise = (o: Omit<NoiseLayer, 'kind' | 'hold'> & { hold?: number }): NoiseLayer => ({ kind: 'noise', hold: 0, ...o });
const tone = (o: Omit<ToneLayer, 'kind' | 'hold'> & { hold?: number }): ToneLayer => ({ kind: 'tone', hold: 0, ...o });
const METAL = [1, 2.76, 5.4, 8.9] as const;

/** The loader's "clunk-chunk": a knock + clink, then a lower knock. */
function reloadLayers(rng: Rng, at: number, pitch: number, level: number): Layer[] {
  return [
    noise({ noise: 'white', filter: 'bandpass', delay: at, dur: 0.045, attack: 0.002, peak: 0.16 * level, f0: 760 * pitch, f1: 520 * pitch, q: 2.2 }),
    { kind: 'partials', delay: at + 0.004, f: 880 * pitch * rng.jitter(0.05), ratios: [1, 2.76], peaks: [0.07 * level, 0.035 * level], decay: 0.2 },
    noise({ noise: 'brown', filter: 'lowpass', delay: at + 0.16, dur: 0.07, attack: 0.003, peak: 0.28 * level, f0: 520 * pitch, f1: 180 * pitch, q: 1 }),
    noise({ noise: 'white', filter: 'bandpass', delay: at + 0.162, dur: 0.035, attack: 0.002, peak: 0.12 * level, f0: 480 * pitch, f1: 340 * pitch, q: 2 }),
  ];
}
/** A hot barrel cooling: sparse, tiny metallic ticks (the clockwork-toy detail). */
function coolingTicks(rng: Rng, count: number, t0: number, t1: number, level: number): TickLayer {
  const train = tickTrain(rng, { count, t0, t1, density: 1.3, fLo: 3800, fHi: 6400, dLo: 0.004, dHi: 0.009, pLo: 0.02 * level, pHi: 0.045 * level, fade: 0.5 });
  return { kind: 'ticks', noise: 'white', filter: 'bandpass', delay: 0, q: 6, ...train };
}

/** Fire layers per weapon: mortar thunk, cannon crack + tail, rail capacitor whine rising to a crack. `power01` is the
 * shot power; `seed` (from the shot id) varies the recipe deterministically. */
export function weaponFireRecipe(weapon: WeaponVoice, power01: number, seed: number): Recipe {
  const rng = new Rng(seed);
  const p = clamp01(power01);
  const pitch = rng.jitter(0.04);              // recoil pitch jitter ±4 %
  const j = (amount: number) => rng.jitter(amount);
  const level = 0.82 + 0.18 * p;
  const reload = RELOAD_CLUNK_AT[weapon];
  switch (weapon) {
    case 'mortar': return {
      gain: 0.62 * level,
      layers: [
        // Hollow tube pop: a falling sine and the tube's band resonance.
        tone({ wave: 'sine', delay: 0, dur: 0.21 * j(0.08), attack: 0.003, peak: 0.78, f0: 262 * pitch, f1: 70 * pitch }),
        noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.14 * j(0.1), attack: 0.002, peak: 0.5, f0: 640 * pitch * j(0.06), f1: 390 * pitch, q: 5 }),
        noise({ noise: 'brown', filter: 'lowpass', delay: 0.002, dur: 0.34 * (0.9 + 0.2 * p), attack: 0.004, peak: 0.62, f0: 900 * pitch, f1: 140 * pitch, q: 0.7 }),
        noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.05, attack: 0.002, peak: 0.26, f0: 1900 * pitch, f1: 720 * pitch, q: 1.1 }),
        // The shell leaving the tube: a rising "fwoop".
        noise({ noise: 'white', filter: 'bandpass', delay: 0.03, dur: 0.26, attack: 0.1, peak: 0.1, f0: 480 * pitch, f1: 1650 * pitch, q: 2.2 }),
        { kind: 'partials', delay: 0.01, f: 410 * pitch * j(0.05), ratios: [1, 2.76, 5.4], peaks: [0.1, 0.05, 0.025], decay: 0.38 },
        ...reloadLayers(rng, reload, pitch, 0.9),
        coolingTicks(rng, 4, 0.7, 4.5, 0.8),
      ],
    };
    case 'cannon': return {
      gain: 0.6 * level,
      layers: [
        // Transient crack: white noise band 2.5 kHz → 800 Hz over 60 ms, 3 ms attack.
        noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.06 * j(0.1), attack: 0.003, peak: 0.9, f0: 2500 * pitch * j(0.05), f1: 800 * pitch, q: 1.2 }),
        noise({ noise: 'white', filter: 'highpass', delay: 0, dur: 0.022, attack: 0.0015, peak: 0.2, f0: 5200 * pitch, f1: 3000 * pitch, q: 0.7 }),
        // Body boom: brown noise low-pass 400 → 90 Hz over ~350 ms.
        noise({ noise: 'brown', filter: 'lowpass', delay: 0.002, dur: 0.36 * (0.9 + 0.2 * p) * j(0.08), attack: 0.004, peak: 0.8, f0: 420 * pitch, f1: 90 * pitch, q: 0.8 }),
        // Sub kick: sine 110 → 45 Hz over 180 ms.
        tone({ wave: 'sine', delay: 0, dur: 0.18 * j(0.06), attack: 0.003, peak: 0.75, f0: 110 * pitch, f1: 45 * pitch }),
        // The diorama's report rolling away.
        noise({ noise: 'pink', filter: 'lowpass', delay: 0.05, dur: 0.95 * j(0.1), attack: 0.03, peak: 0.16, f0: 1500 * pitch, f1: 280, q: 0.6 }),
        // Breech clank at +120 ms: inharmonic partials.
        { kind: 'partials', delay: 0.12, f: 320 * pitch * j(0.05), ratios: METAL, peaks: [0.12, 0.08, 0.05, 0.03], decay: 0.55 * j(0.1) },
        ...reloadLayers(rng, reload, pitch, 1),
        coolingTicks(rng, 6, 0.8, 4.6, 1),
      ],
    };
    case 'rail': {
      const c = RAIL_CHARGE_S;
      return {
        gain: 0.6 * level,
        layers: [
          { kind: 'whine', delay: 0, dur: c + 0.02, attack: 0.02, peak: 0.24, f0: 380 * pitch, f1: 2400 * pitch, q: 9 },
          noise({ noise: 'white', filter: 'bandpass', delay: c, dur: 0.05 * j(0.1), attack: 0.002, peak: 0.9, f0: 4200 * pitch, f1: 1300 * pitch, q: 1.4 }),
          tone({ wave: 'square', delay: c, dur: 0.12, attack: 0.002, peak: 0.1, f0: 1800 * pitch, f1: 220 * pitch }),
          noise({ noise: 'brown', filter: 'lowpass', delay: c + 0.002, dur: 0.26 * (0.9 + 0.2 * p), attack: 0.004, peak: 0.55, f0: 620 * pitch, f1: 140 * pitch, q: 0.8 }),
          tone({ wave: 'sine', delay: c, dur: 0.14, attack: 0.003, peak: 0.5, f0: 150 * pitch, f1: 55 * pitch }),
          { kind: 'ring', delay: c + 0.01, dur: 0.6 * j(0.1), attack: 0.005, peak: 0.16, carrier: 3000 * pitch, f: 2600 * pitch, q: 1.5 },
          // The capacitor recharging: a quiet rising whine with a flutter.
          tone({ wave: 'sine', delay: c + 0.35, dur: 1.2, attack: 0.3, peak: 0.05, f0: 300 * pitch, f1: 1900 * pitch, swell: true, vibrato: [9, 25] }),
          ...reloadLayers(rng, reload, pitch * 1.1, 0.8),
          coolingTicks(rng, 4, 0.5, 4.4, 0.8),
        ],
      };
    }
  }
}

// ---- Explosions --------------------------------------------------------------------------------------------------------
/** Stylised speed of sound (u/s): explosions 10-20 u away arrive 0.17-0.33 s after the flash. */
export const SPEED_OF_SOUND = 60;
/** Distance delay cap (s): across the planet the arc is ~56 u (~0.93 s). */
export const MAX_SOUND_DELAY = 0.8;
/** The largest blast radius (a nuclear mortar round) maps to magnitude 1. */
export const FULL_BLAST_RADIUS = 4.8;
/** The nuclear suck-back pre-swell that crests exactly at the boom (s). */
export const NUKE_PRE_ROLL = 0.35;

export function soundDelay(distance: number): number {
  return Number.isFinite(distance) && distance > 0 ? Math.min(MAX_SOUND_DELAY, distance / SPEED_OF_SOUND) : 0;
}
export function blastMagnitude01(radius: number): number { return clamp01(radius / FULL_BLAST_RADIUS); }
/** How loud a blast reads at the listener, for ducking: magnitude scaled by proximity. */
export function perceivedMagnitude(radius: number, distance: number): number {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 1e3;
  return blastMagnitude01(radius) / (1 + (d / 20) ** 2);
}

export type ExplosionKind = 'explosive' | 'heavy' | 'incendiary' | 'nuclear';
export function explosionKindOf(munition: string | undefined): ExplosionKind {
  return munition === 'heavy' || munition === 'incendiary' || munition === 'nuclear' ? munition : 'explosive';
}
export interface ExplosionPlan {
  recipe: Recipe;
  /** Seconds from the impact until the voice starts (the boom lands `preRoll` later). */
  start: number;
  /** Seconds from the voice start to the main boom (0 except for the nuclear pre-swell). */
  preRoll: number;
  magnitude: number;
}

/**
 * playThunder, re-tuned for TMT units: a crack with crackle ticks (near only), a brown-noise rumble with a swept-down
 * low-pass and two incommensurate gain LFOs, rolling peals, a ground-thump sub (1.5f → 0.7f), and a debris rain whose
 * density follows the carve volume (radius³). Delay d/60 s capped at 0.8 s. The nuclear round adds a suck-back
 * pre-swell that crests at the boom, a long sub swell and the air rushing back.
 */
export function explosionPlan(o: { munition?: string; radius: number; distance: number; seed: number }): ExplosionPlan {
  const rng = new Rng(o.seed);
  const kind = explosionKindOf(o.munition);
  const radius = Number.isFinite(o.radius) ? clamp(o.radius, 0.2, 8) : 2;
  const d = Number.isFinite(o.distance) ? Math.max(0, o.distance) : 40;
  const m = blastMagnitude01(radius);
  const delay = soundDelay(d);
  // Air absorbs the highs over range: the crack fades first, the rumble carries, the sub carries furthest.
  const nearF = Math.max(0, 1 - d / 30);
  const bodyDull = Math.max(0.35, 1 - d / 45);
  const subCarry = Math.max(0, 1 - d / 42);
  const preRoll = kind === 'nuclear' ? NUKE_PRE_ROLL : 0;
  const b = preRoll;                                  // the boom's time inside the recipe
  const layers: Layer[] = [];

  // 1. Crack + crackle: small blasts spit many bright ticks, big ones one darker, harder crack.
  const crackAmp = nearF * (0.45 + 0.55 * m);
  if (crackAmp > 0.02) {
    layers.push(noise({ noise: 'white', filter: 'bandpass', delay: b, dur: 0.1 + 0.1 * m, attack: 0.004, peak: clamp(0.9 * crackAmp, 0.001, 1.5),
      f0: (3200 - 1300 * m) * rng.jitter(0.06), f1: 700 - 250 * m, q: 1.1 }));
    const train = tickTrain(rng, { count: Math.round((1 - m) * 6) + 2, t0: 0.004, t1: 0.23, density: 1, fLo: 2000, fHi: 6200,
      dLo: 0.006, dHi: 0.018, pLo: 0.1 * crackAmp, pHi: 0.26 * crackAmp, fade: 0.3 });
    layers.push({ kind: 'ticks', noise: 'white', filter: 'bandpass', delay: b, q: 3, ...train });
  }
  // 2. Rumble: bigger → deeper floor and longer; far → duller.
  const rumbleDur = (0.8 + 2.6 * m) * rng.jitter(0.06);
  layers.push(noise({ noise: 'brown', filter: 'lowpass', delay: b, dur: rumbleDur, attack: 0.04 + 0.07 * m, hold: 0.08 * rumbleDur, peak: 0.8,
    f0: Math.max(60, (300 + 360 * m) * bodyDull), f1: Math.max(35, 130 - 80 * m), q: 0.7,
    lfo: [rng.range(0.5, 1.1), 0.25, rng.range(1.3, 2.2), 0.18] }));
  // 3. Rolling peals across the tail (big blasts only).
  const peals = kind === 'nuclear' ? 3 : Math.round(m * 2);
  for (let i = 0; i < peals; i++) {
    const dur = rng.range(0.4, 1.2);
    const f = rng.range(90, 220);
    layers.push(noise({ noise: 'brown', filter: 'lowpass', delay: b + rng.range(0.25, 0.85) * rumbleDur, dur, attack: 0.3 * dur, peak: rng.range(0.22, 0.5) * (0.5 + 0.5 * m),
      f0: f, f1: f * 0.8, q: 0.6, pan: rng.signed() * 0.5 }));
  }
  // 4. Ground-thump sub: 45-70 Hz, 1.5f → 0.7f; present for every blast, deep for big ones.
  const subAmp = (0.25 + 0.75 * m * m) * subCarry;
  if (subAmp > 0.03) {
    const f = rng.range(50, 68);
    layers.push(tone({ wave: 'sine', delay: b, dur: 0.6 + 0.6 * m, attack: 0.02, peak: clamp(0.6 * subAmp, 0.001, 1.5), f0: f * 1.5, f1: f * 0.7 }));
  }
  // 5. Debris rain: clods and grit falling back, density ∝ carve volume (radius³).
  const volume01 = (radius / FULL_BLAST_RADIUS) ** 3;
  const grit = tickTrain(rng, { count: 4 + 24 * volume01, t0: 0.3, t1: 1.5, density: 1.6, fLo: 900, fHi: 3600,
    dLo: 0.005, dHi: 0.025, pLo: 0.05, pHi: 0.16, fade: 0.6 });
  layers.push({ kind: 'ticks', noise: 'white', filter: 'bandpass', delay: b, q: 2.5, ...grit });
  const clods = tickTrain(rng, { count: 1 + radius * 1.2, t0: 0.35, t1: 1.3, density: 1.3, fLo: 180, fHi: 420,
    dLo: 0.04, dHi: 0.09, pLo: 0.12, pHi: 0.3, fade: 0.4 });
  layers.push({ kind: 'ticks', noise: 'brown', filter: 'lowpass', delay: b, q: 0.8, ...clods });

  if (kind === 'nuclear') {
    // Suck-back pre-swell: the air inhales, pitch rising, cresting at the boom.
    layers.push(noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: preRoll + 0.05, attack: preRoll - 0.01, peak: 0.5, swell: true, f0: 180, f1: 1400, q: 1.2 }));
    layers.push(tone({ wave: 'sine', delay: 0, dur: preRoll + 0.04, attack: preRoll - 0.02, peak: 0.35, swell: true, f0: 30, f1: 58 }));
    // A long sub swell under the rumble, then the air rushing back in.
    layers.push(tone({ wave: 'sine', delay: b, dur: 2.2, attack: 0.3, hold: 0.2, peak: 0.7 * Math.max(0.3, subCarry), f0: 40, f1: 27 }));
    layers.push(noise({ noise: 'white', filter: 'bandpass', delay: b + 1.6, dur: 1.2, attack: 0.5, peak: 0.3, swell: true, f0: 2400, f1: 260, q: 1 }));
  } else if (kind === 'incendiary') {
    // Whoosh up, a low roar, and fire crackle sputtering on.
    layers.push(noise({ noise: 'white', filter: 'bandpass', delay: b + 0.02, dur: 0.45, attack: 0.2, peak: 0.35, f0: 300, f1: 2600, q: 1.4 }));
    layers.push(noise({ noise: 'pink', filter: 'lowpass', delay: b + 0.05, dur: 2.5, attack: 0.3, hold: 1, peak: 0.18, f0: 600, f1: 300, q: 0.7 }));
    const crackle = tickTrain(rng, { count: 14, t0: 0.3, t1: 2.5, density: 1.1, fLo: 1500, fHi: 5000, dLo: 0.003, dHi: 0.012, pLo: 0.04, pHi: 0.12, fade: 0.5 });
    layers.push({ kind: 'ticks', noise: 'white', filter: 'bandpass', delay: b, q: 2, ...crackle });
  }
  const start = Math.max(0, delay - preRoll);
  return { recipe: { gain: 0.55 + 0.45 * m, layers }, start, preRoll, magnitude: m };
}

// ---- Impacts on tanks, kills, terrain -----------------------------------------------------------------------------------
/** Armour clank on a hit: metalHit-style partials (1, 2.76, 5.4, 8.9), decay 0.4-1.2 s, a knock, a thud and a tin
 * rattle (loose rivets on a toy). `damage01` = damage / max health (clamped), `direct` hits ring louder. */
export function armorClankRecipe(damage01: number, direct: boolean, seed: number): Recipe {
  const rng = new Rng(seed);
  const t = clamp01(damage01);
  const hit = direct ? 1.2 : 1;
  const f = (620 - 180 * t) * rng.jitter(0.06);
  const rattle = tickTrain(rng, { count: rng.range(4, 7), t0: 0.02, t1: 0.26, density: 1.4, fLo: 2500, fHi: 4500, dLo: 0.004, dHi: 0.01, pLo: 0.04, pHi: 0.08, fade: 0.5 });
  return {
    gain: 0.6 + 0.4 * t,
    layers: [
      { kind: 'partials', delay: 0, f, ratios: METAL, peaks: [0.32, 0.2, 0.12, 0.07].map(v => v * (0.55 + 0.45 * t) * hit), decay: (0.4 + 0.8 * t) * rng.jitter(0.1) },
      noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.035, attack: 0.002, peak: 0.5, f0: 1100 * rng.jitter(0.08), f1: 600, q: 1.5 }),
      tone({ wave: 'sine', delay: 0.003, dur: 0.16, attack: 0.003, peak: 0.45 * (0.5 + 0.5 * t), f0: 150, f1: 60 }),
      { kind: 'ticks', noise: 'white', filter: 'bandpass', delay: 0, q: 5, ...rattle },
    ],
  };
}

/** Kill accent: a descending sub, a metal crunch, a big clank and a toy spring's "sproing". */
export function killAccentRecipe(seed: number): Recipe {
  const rng = new Rng(seed);
  return {
    gain: 0.8,
    layers: [
      tone({ wave: 'sine', delay: 0.06, dur: 0.6, attack: 0.01, peak: 0.36, f0: 92, f1: 34 }),
      noise({ noise: 'white', filter: 'bandpass', delay: 0.06, dur: 0.42, attack: 0.004, peak: 0.25, f0: 1400 * rng.jitter(0.05), f1: 350, q: 1.2 }),
      { kind: 'partials', delay: 0.07, f: 280 * rng.jitter(0.05), ratios: METAL, peaks: [0.22, 0.14, 0.08, 0.05], decay: 1.4 },
      tone({ wave: 'triangle', delay: 0.14, dur: 0.75, attack: 0.005, peak: 0.1, f0: 420 * rng.jitter(0.04), f1: 180, vibrato: [14, 120] }),
    ],
  };
}

/** Rubble settling after a terrain commit. */
export function rubbleSettleRecipe(radius: number, seed: number): Recipe {
  const rng = new Rng(seed);
  const r = Number.isFinite(radius) ? clamp(radius, 0.5, 6) : 2;
  const ticks = tickTrain(rng, { count: 8 + r * 2, t0: 0, t1: 0.9, density: 1.4, fLo: 250, fHi: 700, dLo: 0.02, dHi: 0.06, pLo: 0.06, pHi: 0.16, fade: 0.6 });
  return {
    gain: 0.55,
    layers: [
      { kind: 'ticks', noise: 'brown', filter: 'lowpass', delay: 0, q: 0.8, ...ticks },
      noise({ noise: 'pink', filter: 'lowpass', delay: 0, dur: 0.8, attack: 0.06, peak: 0.12, f0: 400, f1: 150, q: 0.7 }),
    ],
  };
}

// ---- Suspension --------------------------------------------------------------------------------------------------------
/** A wheel compression rate (compression units per second; 0.5 is nominal) above which a thump plays. */
export const THUMP_RATE_THRESHOLD = 1.8;
/** Compression rate → thump intensity in [0, 1] (0 below the threshold). */
export function thumpIntensity(rate: number): number {
  return Number.isFinite(rate) && rate > THUMP_RATE_THRESHOLD ? clamp01((rate - THUMP_RATE_THRESHOLD) / (4 * THUMP_RATE_THRESHOLD)) : 0;
}
/** Suspension thump: a low noise knock, a falling sine and a toy spring clink. */
export function suspensionThumpRecipe(intensity01: number, seed: number): Recipe {
  const rng = new Rng(seed);
  const i = clamp01(intensity01);
  const clink = tickTrain(rng, { count: 1 + Math.round(2 * i), t0: 0.005, t1: 0.08, density: 1, fLo: 1600, fHi: 2400, dLo: 0.006, dHi: 0.02, pLo: 0.03 + 0.03 * i, pHi: 0.05 + 0.03 * i, fade: 0.3 });
  return {
    gain: 0.7,
    layers: [
      noise({ noise: 'brown', filter: 'lowpass', delay: 0, dur: 0.05 + 0.05 * i, attack: 0.003, peak: 0.25 + 0.45 * i, f0: 240 * rng.jitter(0.1), f1: 110, q: 0.8 }),
      tone({ wave: 'sine', delay: 0.002, dur: 0.09 + 0.06 * i, attack: 0.003, peak: 0.2 + 0.35 * i, f0: 120 * rng.jitter(0.06), f1: 55 }),
      { kind: 'ticks', noise: 'white', filter: 'bandpass', delay: 0, q: 6, ...clink },
    ],
  };
}

// ---- UI ----------------------------------------------------------------------------------------------------------------
export type UiSound = 'click' | 'hover' | 'confirm' | 'cancel' | 'open' | 'close' | 'aim' | 'turn' | 'turn-other' | 'denied' | 'victory' | 'defeat'
  | 'objective-new' | 'objective-done' | 'objective-failed' | 'checkpoint' | 'banner' | 'alarm' | 'incoming' | 'overheat' | 'repair' | 'capture-tick' | 'reload-ready' | 'depot-ping';
/** Recipe stand-ins for the bank-only cues (played only before the bank has decoded). */
const UI_FALLBACK: Partial<Record<UiSound, UiSound>> = { 'objective-new': 'turn', 'objective-done': 'victory', 'objective-failed': 'defeat', checkpoint: 'confirm', banner: 'open', alarm: 'denied', incoming: 'turn-other', overheat: 'cancel', repair: 'confirm', 'capture-tick': 'aim', 'reload-ready': 'click', 'depot-ping': 'turn' };
/** Music-box note (a plucked tine): partials with a quick decay. */
function tine(delay: number, f: number, peak: number, decay = 0.7): PartialLayer {
  return { kind: 'partials', delay, f: hzc(f), ratios: [1, 2, 3.02], peaks: [peak, peak * 0.32, peak * 0.12], decay };
}
const midiHz = (n: number) => 440 * 2 ** ((n - 69) / 12);
/** Procedural UI sounds (Pinionfall synthUi recipes, noise from the shared pool) plus the game cues. `value01` pitches
 * the aim tick (slider position). */
export function uiRecipe(kind: UiSound, value01 = 0.5, seed = 0): Recipe {
  const rng = new Rng(seed);
  switch (UI_FALLBACK[kind] ?? kind) {
    case 'click': return { gain: 0.5, layers: [tone({ wave: 'sine', delay: 0, dur: 0.025, attack: 0.001, peak: 0.55, f0: 1800, f1: 800 }),
      noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.012, attack: 0.001, peak: 0.18, f0: 3400, f1: 3400, q: 1.4 })] };
    case 'hover': return { gain: 0.25, layers: [tone({ wave: 'sine', delay: 0, dur: 0.025, attack: 0.001, peak: 0.55, f0: 1800, f1: 800 }),
      noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.012, attack: 0.001, peak: 0.18, f0: 3400, f1: 3400, q: 1.4 })] };
    case 'confirm': return { gain: 0.5, layers: [tone({ wave: 'sine', delay: 0, dur: 0.05, attack: 0.003, peak: 0.38, f0: 620, f1: 720 }),
      tone({ wave: 'sine', delay: 0.038, dur: 0.07, attack: 0.003, peak: 0.34, f0: 880, f1: 1000 })] };
    case 'cancel': return { gain: 0.5, layers: [tone({ wave: 'sine', delay: 0, dur: 0.11, attack: 0.004, peak: 0.38, f0: 780, f1: 340 }),
      noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.09, attack: 0.004, peak: 0.08, f0: 900, f1: 400, q: 2 })] };
    case 'open': return { gain: 0.45, layers: [noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.18, attack: 0.02, hold: 0.1, peak: 0.5, f0: 380, f1: 1700, q: 3 }),
      tone({ wave: 'sine', delay: 0.015, dur: 0.16, attack: 0.02, peak: 0.14, f0: 780, f1: 1350 })] };
    case 'close': return { gain: 0.45, layers: [noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.15, attack: 0.02, hold: 0.08, peak: 0.46, f0: 1600, f1: 360, q: 3 }),
      tone({ wave: 'sine', delay: 0, dur: 0.14, attack: 0.01, peak: 0.14, f0: 1080, f1: 440 })] };
    case 'aim': {
      // A ratchet tick pitched by the slider: ±5 semitones around 2.2 kHz.
      const f = 2200 * 2 ** ((clamp01(value01) - 0.5) * 10 / 12);
      return { gain: 0.3, layers: [tone({ wave: 'triangle', delay: 0, dur: 0.02, attack: 0.001, peak: 0.3, f0: f, f1: f * 0.7 }),
        noise({ noise: 'white', filter: 'bandpass', delay: 0, dur: 0.008, attack: 0.001, peak: 0.08, f0: f * 1.6, f1: f * 1.6, q: 3 })] };
    }
    case 'turn': return { gain: 0.55, layers: [tine(0, midiHz(79), 0.3), tine(0.09, midiHz(84), 0.3, 0.9)] };
    case 'turn-other': return { gain: 0.45, layers: [tine(0, midiHz(72), 0.22), tine(0.1, midiHz(67), 0.22, 0.8)] };
    case 'denied': return { gain: 0.4, layers: [tone({ wave: 'square', delay: 0, dur: 0.12, attack: 0.004, peak: 0.12, f0: 220, f1: 180 }),
      tone({ wave: 'square', delay: 0.14, dur: 0.12, attack: 0.004, peak: 0.12, f0: 196, f1: 160 })] };
    case 'victory': {
      const root = 72 + rng.int(3) * 2;
      return { gain: 0.6, layers: [
        tine(0, midiHz(root), 0.28), tine(0.13, midiHz(root + 4), 0.28), tine(0.26, midiHz(root + 7), 0.28), tine(0.39, midiHz(root + 12), 0.32, 1.4),
        tone({ wave: 'sine', delay: 0.39, dur: 1.2, attack: 0.02, peak: 0.25, f0: midiHz(root - 24), f1: midiHz(root - 24) * 0.99 }),
      ] };
    }
    case 'defeat': {
      const root = 69;
      return { gain: 0.6, layers: [
        tine(0, midiHz(root), 0.26), tine(0.18, midiHz(root - 4), 0.26), tine(0.36, midiHz(root - 9), 0.28, 1.3),
        tone({ wave: 'sine', delay: 0.36, dur: 1.3, attack: 0.02, peak: 0.3, f0: midiHz(root - 24), f1: midiHz(root - 26) }),
      ] };
    }
    default: return uiRecipe('click', value01, seed);
  }
}

// ---- Doppler and shell whistles -----------------------------------------------------------------------------------------
type Vec = readonly [number, number, number];
/** Pitch ratio heard from a moving source: v_r = dot(v_src − v_lis, normalize(p_lis − p_src)), f = c / (c − v_r),
 * clamped to [min, max]. WebAudio removed doppler from PannerNode, so the whistles compute it by hand. */
export function dopplerRatio(srcPos: Vec, srcVel: Vec, lisPos: Vec, lisVel: Vec, c = SPEED_OF_SOUND, min = 0.5, max = 2): number {
  const dx = lisPos[0] - srcPos[0], dy = lisPos[1] - srcPos[1], dz = lisPos[2] - srcPos[2];
  const d = Math.hypot(dx, dy, dz);
  if (!(d > 1e-6) || !(c > 0)) return 1;
  const vr = ((srcVel[0] - lisVel[0]) * dx + (srcVel[1] - lisVel[1]) * dy + (srcVel[2] - lisVel[2]) * dz) / d;
  if (!Number.isFinite(vr)) return 1;
  if (vr >= c) return max;
  return clamp(c / (c - vr), min, max);
}
/** Whistle base frequency from the shell speed (u/s): shells run 1.8-23 u/s → ~970-1820 Hz. */
export function whistleBaseHz(speed: number): number { return 900 + 40 * clamp(Number.isFinite(speed) ? Math.abs(speed) : 0, 0, 40); }
/** The descending "incoming" glissando: f × (0.75 + 0.25·height01) as the shell drops. */
export function incomingPitch(height01: number): number { return 0.75 + 0.25 * clamp01(height01); }
/** Whistle loudness vs distance (u): 1 / (1 + d²/9). */
export function whistleGain(distance: number): number {
  return Number.isFinite(distance) ? 1 / (1 + (Math.max(0, distance) ** 2) / 9) : 0;
}
/** A shell counts as incoming when its predicted landing is this close to the listener focus (u). */
export const INCOMING_RADIUS = 4;
export const MAX_WHISTLES = 6;

// ---- Engine and tread loops --------------------------------------------------------------------------------------------
/** Tread link pitch (u): one link slap per 0.085 u of belt travel. */
export const TREAD_LINK_PITCH = 0.085;
/** Link-slap grains per second are capped here; above ~40/s the worklet blends to AM noise. */
export const MAX_TREAD_RATE = 60;
/** Track speed (u/s) that reads as full speed. */
export const ENGINE_FULL_SPEED = 3.2;
/** Ignore sub-two-degree/s numerical bearing drift and tiny settling corrections. */
export const SERVO_RATE_DEADZONE = .035;
export interface EngineInput { speed: number; accel: number; slip: number; contact: number; turretRate: number; /** Yaw rate (rad/s) for hard-turn clatter. */ yawRate?: number; /** Health 0..1 for the misfire mode (below 0.3). */ health?: number }
export interface EngineParams { fundamental: number; load: number; tread: number; slip: number; servo: number; level: number; turn: number; damage: number }
/** Gear steps: the engine's pitch climbs within a gear and drops at each shift (every GEAR_SPAN u/s), four gears. */
export const GEAR_SPAN = 0.8, GEARS = 4;
export function gearOf(speed: number): number { return Math.min(GEARS - 1, Math.floor(Math.max(0, speed) / GEAR_SPAN)); }
/** Loop parameters for one tank: an engine hum whose pitch follows track speed, tread clatter at a rate following the
 * belt speed, slip squeal and a clockwork servo whine on turret motion. Non-finite inputs read as 0. */
export function engineParams(i: EngineInput): EngineParams {
  const speed = Number.isFinite(i.speed) ? Math.abs(i.speed) : 0;
  const speed01 = clamp01(speed / ENGINE_FULL_SPEED);
  const load = clamp01(0.25 + 0.5 * clamp01((Number.isFinite(i.accel) ? Math.abs(i.accel) : 0) / 3) + 0.25 * speed01);
  // Within a gear the revs climb over the gear's span; each shift drops them back by two thirds of the climb, so the
  // pitch saws up through the gears instead of rising once; the top gear keeps climbing to full speed.
  const gear = gearOf(speed), inGear = gear < GEARS - 1 ? clamp01((speed - gear * GEAR_SPAN) / GEAR_SPAN) : clamp01((speed - gear * GEAR_SPAN) / Math.max(0.1, ENGINE_FULL_SPEED - gear * GEAR_SPAN));
  const revs = clamp01(0.2 * gear + 0.42 * inGear);
  const yaw = Number.isFinite(i.yawRate) ? Math.abs(i.yawRate!) : 0;
  const health = Number.isFinite(i.health) ? clamp01(i.health!) : 1;
  return {
    fundamental: 46 + 110 * revs + 22 * load,
    load,
    tread: Math.min(MAX_TREAD_RATE, speed / TREAD_LINK_PITCH),
    slip: clamp01((Number.isFinite(i.slip) ? Math.abs(i.slip) : 0) / 1.2) * clamp01(i.contact),
    servo: clamp01(((Number.isFinite(i.turretRate) ? Math.abs(i.turretRate) : 0) - SERVO_RATE_DEADZONE) / (1.4 - SERVO_RATE_DEADZONE)),
    // A quiet idle and a present but not dominant drive: about 0.19 at rest, 0.7 at full speed under load.
    level: 0.16 + 0.42 * speed01 + 0.12 * load,
    // Hard turns: yaw against a moving belt (a pivot turn at speed clatters the most).
    turn: clamp01((yaw - 0.4) / 1.6) * clamp01(0.3 + speed01) * clamp01(i.contact),
    damage: health < 0.3 ? clamp01((0.3 - health) / 0.3) : 0,
  };
}

// ---- Seeds -------------------------------------------------------------------------------------------------------------
/** Seed of a shot's fire variation from the shot id (tick, tank, projectile id): deterministic but varied. */
export function shotSeed(tick: number, tank: number, projectile = 0): number {
  const h = Math.imul((tick | 0) ^ 0x51ed270b, 0x9e3779b1) ^ Math.imul((tank | 0) + 1, 0x85ebca77) ^ Math.imul((projectile | 0) + 7, 0xc2b2ae3d);
  return (h ^ (h >>> 15)) >>> 0;
}
