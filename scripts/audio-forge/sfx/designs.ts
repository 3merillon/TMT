/**
 * The TMT effects palette, designed from physical cause: what struck what, how heavy, how far. Each design returns a
 * mono 48 kHz buffer; `seed` varies the take. Distance is handled at runtime (gain/low-pass/delay), but the far variants
 * here carry the muffled body that a distant boom actually has, so the runtime can crossfade near/far by distance.
 */
import { SR, type Mono, Rng, addInto } from '../dsp/core';
import { n, envelope, noiseBand, toneSweep, partials, METAL, ticks, whine, ring, tear, mix, filter, sat, tube, tail, normalize, edges, trim, loopable, dull } from './kit';
import { Noise } from '../dsp/osc';
import { Biquad } from '../dsp/filters';

const j = (rng: Rng, a: number) => rng.jitter(a);

// ---- Weapons ----------------------------------------------------------------------------------------------------------
export function cannonFire(seed: number, far = false): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), len = n(far ? 1.6 : 1.2);
  const crack = noiseBand(seed + 1, n(0.09), { f0: 2600 * p, f1: 700, q: 1.1, attack: 0.0015, dur: 0.08, peak: 1 });
  const slap = noiseBand(seed + 2, n(0.03), { f0: 5500 * p, f1: 3200, q: 0.8, filter: 'highpass', attack: 0.001, dur: 0.025, peak: 0.6 });
  const bark = noiseBand(seed + 3, n(0.16), { f0: 650 * p, f1: 420, q: 1.2, attack: 0.002, dur: 0.14, peak: 0.9 });
  const body = noiseBand(seed + 4, n(0.42), { color: 'brown', filter: 'lowpass', f0: 420 * p, f1: 90, q: 0.8, attack: 0.004, dur: 0.38, peak: 1.4 });
  const sub = toneSweep(n(0.2), { f0: 115 * p, f1: 44, attack: 0.003, dur: 0.18, peak: 0.9 });
  const breech = partials(n(0.6), 330 * p, METAL, [0.3, 0.2, 0.12, 0.07, 0.03], 0.5, { seed, detune: 0.01 });
  const echo = noiseBand(seed + 5, n(0.95), { color: 'pink', filter: 'lowpass', f0: 1500, f1: 280, q: 0.6, attack: 0.03, dur: 0.9, peak: 0.35 });
  let out = mix(len, [crack, far ? 0.25 : 1], [slap, far ? 0 : 1], [bark, 1], [body, far ? 1.3 : 1], [sub, far ? 0.6 : 1], [breech, far ? 0 : 0.5, 0.12], [echo, far ? 1.2 : 0.6, 0.05]);
  out = tube(out, 1.8);
  if (far) { dull(out, 900, 2); filter(out, 'highpass', 50, 0.7); }
  tail(out, { seconds: far ? 1.4 : 0.7, damp: far ? 1800 : 3800, preDelayMs: far ? 40 : 12, size: 1.2 }, far ? 0.5 : 0.25, seed);
  return edges(trim(normalize(out)));
}
export function mortarFire(seed: number, far = false): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), len = n(far ? 1.4 : 1.1);
  const pop = toneSweep(n(0.22), { f0: 262 * p, f1: 70, attack: 0.003, dur: 0.21, peak: 1 });
  const tube_ = noiseBand(seed + 1, n(0.15), { f0: 640 * p, f1: 390, q: 5, attack: 0.002, dur: 0.14, peak: 0.8 });
  const body = noiseBand(seed + 2, n(0.36), { color: 'brown', filter: 'lowpass', f0: 900 * p, f1: 140, q: 0.7, attack: 0.004, dur: 0.34, peak: 1.1 });
  const click = noiseBand(seed + 3, n(0.05), { f0: 1900 * p, f1: 720, q: 1.1, attack: 0.002, dur: 0.05, peak: 0.5 });
  const fwoop = noiseBand(seed + 4, n(0.3), { f0: 480 * p, f1: 1650, q: 2.2, attack: 0.1, dur: 0.28, peak: 0.25 });
  const metal = partials(n(0.45), 410 * p, [1, 2.76, 5.4], [0.2, 0.1, 0.05], 0.38, { seed });
  let out = mix(len, [pop, 1], [tube_, far ? 0.4 : 1], [body, far ? 1.3 : 1], [click, far ? 0 : 1], [fwoop, far ? 0 : 1, 0.03], [metal, far ? 0 : 0.6, 0.01]);
  out = tube(out, 1.5);
  if (far) dull(out, 700, 2);
  tail(out, { seconds: far ? 1.3 : 0.6, damp: 2800, preDelayMs: 15, size: 1.1 }, far ? 0.5 : 0.22, seed);
  return edges(trim(normalize(out)));
}
export function railFire(seed: number, far = false): Mono {
  const rng = new Rng(seed), p = j(rng, 0.04), c = 0.09, len = n(far ? 1.6 : 1.9);
  const charge = whine(n(c + 0.03), 380 * p, 2400 * p, c + 0.02, 0.45, 9);
  const crack = noiseBand(seed + 1, n(0.06), { f0: 4200 * p, f1: 1300, q: 1.4, attack: 0.0015, dur: 0.05, peak: 1 });
  const zap = toneSweep(n(0.13), { wave: 'square', f0: 1800 * p, f1: 220, attack: 0.002, dur: 0.12, peak: 0.25 });
  const body = noiseBand(seed + 2, n(0.3), { color: 'brown', filter: 'lowpass', f0: 620 * p, f1: 140, q: 0.8, attack: 0.004, dur: 0.26, peak: 0.9 });
  const sub = toneSweep(n(0.16), { f0: 150 * p, f1: 55, attack: 0.003, dur: 0.14, peak: 0.7 });
  const electric = ring(seed + 3, n(0.65), 3000 * p, 2600 * p, 1.5, 0.6, 0.3);
  const recharge = toneSweep(n(1.3), { f0: 300 * p, f1: 1900 * p, attack: 0.3, dur: 1.2, swell: true, peak: 0.08, vibrato: [9, 25] });
  let out = mix(len, [charge, far ? 0.3 : 1], [crack, far ? 0.3 : 1, c], [zap, far ? 0.3 : 1, c], [body, far ? 1.2 : 1, c], [sub, far ? 0.7 : 1, c], [electric, far ? 0.4 : 1, c + 0.01], [recharge, far ? 0 : 1, c + 0.35]);
  out = sat(out, 1.4);
  if (far) dull(out, 1100, 2);
  tail(out, { seconds: far ? 1.4 : 0.8, damp: 4200, preDelayMs: 10, size: 1.2 }, far ? 0.5 : 0.25, seed);
  return edges(trim(normalize(out)));
}
export function autocannonFire(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.06), len = n(0.5);
  const crack = noiseBand(seed + 1, n(0.05), { f0: 3200 * p, f1: 900, q: 1.2, attack: 0.001, dur: 0.045, peak: 1 });
  const bark = noiseBand(seed + 2, n(0.11), { f0: 820 * p, f1: 500, q: 1.3, attack: 0.002, dur: 0.1, peak: 0.8 });
  const body = noiseBand(seed + 3, n(0.2), { color: 'brown', filter: 'lowpass', f0: 500 * p, f1: 120, q: 0.8, attack: 0.003, dur: 0.18, peak: 0.9 });
  const sub = toneSweep(n(0.1), { f0: 130 * p, f1: 60, attack: 0.002, dur: 0.09, peak: 0.6 });
  const link = partials(n(0.2), 1200 * p, [1, 2.4, 4.1], [0.12, 0.06, 0.03], 0.12, { seed });
  let out = mix(len, [crack, 1], [bark, 1], [body, 1], [sub, 1], [link, 1, 0.02]);
  out = tube(out, 1.6);
  tail(out, { seconds: 0.5, damp: 3800, preDelayMs: 8 }, 0.18, seed);
  return edges(trim(normalize(out)));
}
export function arcCannonFire(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), len = n(1.4);
  const build = whine(n(0.14), 200 * p, 3200 * p, 0.13, 0.4, 7);
  const discharge = noiseBand(seed + 1, n(0.2), { f0: 6000 * p, f1: 900, q: 1.6, attack: 0.001, dur: 0.18, peak: 1 });
  const crackle = ticks(seed + 2, n(0.6), { count: 22, t0: 0.0, t1: 0.5, density: 1.5, fLo: 2500, fHi: 9000, dLo: 0.002, dHi: 0.008, pLo: 0.2, pHi: 0.6, fade: 0.6, q: 4 });
  const arc = ring(seed + 3, n(0.7), 4200 * p, 3100 * p, 2, 0.6, 0.4);
  const sub = toneSweep(n(0.25), { f0: 90 * p, f1: 40, attack: 0.004, dur: 0.22, peak: 0.8 });
  const body = noiseBand(seed + 4, n(0.3), { color: 'brown', filter: 'lowpass', f0: 700, f1: 150, q: 0.8, attack: 0.004, dur: 0.28, peak: 0.7 });
  let out = mix(len, [build, 1], [discharge, 1, 0.12], [crackle, 1, 0.12], [arc, 1, 0.13], [sub, 1, 0.12], [body, 1, 0.12]);
  out = sat(out, 1.5);
  tail(out, { seconds: 0.9, damp: 5000, preDelayMs: 10, size: 1.2 }, 0.3, seed);
  return edges(trim(normalize(out)));
}
export function forgeMortarFire(seed: number, far = false): Mono {
  const rng = new Rng(seed), p = j(rng, 0.04) * 0.62, len = n(far ? 2 : 1.7);
  const pop = toneSweep(n(0.35), { f0: 262 * p, f1: 48, attack: 0.004, dur: 0.33, peak: 1 });
  const tube_ = noiseBand(seed + 1, n(0.22), { f0: 640 * p, f1: 300, q: 4, attack: 0.003, dur: 0.2, peak: 0.8 });
  const body = noiseBand(seed + 2, n(0.7), { color: 'brown', filter: 'lowpass', f0: 600, f1: 90, q: 0.7, attack: 0.006, dur: 0.65, peak: 1.4 });
  const steam = noiseBand(seed + 3, n(0.9), { f0: 2200, f1: 900, q: 0.7, attack: 0.08, dur: 0.85, peak: 0.25 });
  const furnace = partials(n(0.9), 240 * p, METAL, [0.3, 0.18, 0.1, 0.05, 0.02], 0.8, { seed });
  let out = mix(len, [pop, 1], [tube_, far ? 0.4 : 1], [body, far ? 1.3 : 1], [steam, far ? 0.3 : 1, 0.12], [furnace, far ? 0.2 : 0.7, 0.02]);
  out = tube(out, 1.8);
  if (far) dull(out, 500, 2);
  tail(out, { seconds: far ? 1.8 : 0.9, damp: 2500, preDelayMs: 18, size: 1.3 }, far ? 0.5 : 0.25, seed);
  return edges(trim(normalize(out)));
}
/** Coaxial machine gun: a single round and a three-round burst. */
export function coaxShot(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.07), len = n(0.22);
  const crack = noiseBand(seed + 1, n(0.03), { f0: 4200 * p, f1: 1500, q: 1.2, attack: 0.0008, dur: 0.028, peak: 1 });
  const bark = noiseBand(seed + 2, n(0.07), { f0: 1100 * p, f1: 600, q: 1.5, attack: 0.001, dur: 0.065, peak: 0.7 });
  const thump = toneSweep(n(0.06), { f0: 220 * p, f1: 90, attack: 0.001, dur: 0.055, peak: 0.5 });
  const mech = partials(n(0.12), 2400 * p, [1, 1.9, 3.3], [0.1, 0.05, 0.03], 0.08, { seed });
  let out = mix(len, [crack, 1], [bark, 1], [thump, 1], [mech, 1, 0.012]);
  out = tube(out, 1.4);
  return edges(trim(normalize(out)));
}
export function coaxBurst(seed: number, rounds = 3, interval = 0.15): Mono {
  const len = n(interval * rounds + 0.3), out = new Float32Array(len);
  for (let r = 0; r < rounds; r++) addInto(out, coaxShot(seed + r * 17), n(interval * r), 0.95 - 0.05 * r);
  const rattle = ticks(seed + 99, len, { count: rounds * 2, t0: 0.02, t1: interval * rounds, fLo: 2500, fHi: 4500, dLo: 0.004, dHi: 0.01, pLo: 0.08, pHi: 0.16, q: 5 });
  addInto(out, rattle, 0);
  return edges(trim(normalize(out)));
}
/** The loader's clunk-chunk after a main-gun shot (timing per weapon is scheduled by the runtime). */
export function reloadClunk(seed: number, pitch = 1): Mono {
  const rng = new Rng(seed), p = pitch * j(rng, 0.04), len = n(0.45);
  const knock = noiseBand(seed + 1, n(0.05), { f0: 760 * p, f1: 520 * p, q: 2.2, attack: 0.002, dur: 0.045, peak: 0.6 });
  const clink = partials(n(0.25), 880 * p, [1, 2.76], [0.28, 0.14], 0.2, { seed });
  const chunk = noiseBand(seed + 2, n(0.08), { color: 'brown', filter: 'lowpass', f0: 520 * p, f1: 180 * p, q: 1, attack: 0.003, dur: 0.07, peak: 1 });
  const chunk2 = noiseBand(seed + 3, n(0.04), { f0: 480 * p, f1: 340 * p, q: 2, attack: 0.002, dur: 0.035, peak: 0.5 });
  const latch = partials(n(0.3), 1400 * p, [1, 1.6, 2.9], [0.12, 0.07, 0.03], 0.12, { seed: seed + 4 });
  let out = mix(len, [knock, 1], [clink, 1, 0.004], [chunk, 1, 0.16], [chunk2, 1, 0.162], [latch, 1, 0.2]);
  out = sat(out, 1.2);
  return edges(trim(normalize(out, 0.7)));
}

// ---- Explosions ---------------------------------------------------------------------------------------------------------
export type BlastKind = 'he' | 'heavy' | 'incendiary' | 'nuclear';
/** `size` 0..1 maps to the crater radius (0.2 small, 0.5 standard, 1 the biggest heavy/nuclear). */
export function explosion(seed: number, kind: BlastKind, size: number, far = false): Mono {
  const rng = new Rng(seed), m = Math.max(0.1, Math.min(1, size)), nuke = kind === 'nuclear', pre = nuke ? 0.35 : 0;
  const rumbleDur = (0.9 + 2.8 * m) * j(rng, 0.06), len = n(pre + rumbleDur + (nuke ? 2.2 : kind === 'incendiary' ? 2.8 : 1.3));
  const out = new Float32Array(len);
  const b = pre;
  if (!far) {
    addInto(out, noiseBand(seed + 1, n(0.12 + 0.12 * m), { f0: (3300 - 1400 * m) * j(rng, 0.06), f1: 650 - 250 * m, q: 1.1, attack: 0.003, dur: 0.1 + 0.1 * m, peak: 1 }), n(b), 0.5 + 0.5 * m);
    addInto(out, noiseBand(seed + 7, n(0.03), { f0: 6000, f1: 3000, q: 0.7, filter: 'highpass', attack: 0.0008, dur: 0.025, peak: 0.7 }), n(b));
    addInto(out, ticks(seed + 2, n(0.3), { count: Math.round((1 - m) * 6) + 3, t0: 0.004, t1: 0.25, fLo: 2000, fHi: 6200, dLo: 0.006, dHi: 0.018, pLo: 0.15, pHi: 0.35, fade: 0.3, q: 3 }), n(b));
  }
  // Mid "bark" (phone speakers hear this), rumble with rolling LFOs, peals, ground sub.
  addInto(out, noiseBand(seed + 3, n(0.25 + 0.2 * m), { f0: (520 - 160 * m) * j(rng, 0.08), f1: 260, q: 1, attack: 0.004, dur: 0.22 + 0.2 * m, peak: 1 }), n(b), far ? 0.7 : 1);
  const rumble = noiseBand(seed + 4, n(rumbleDur), { color: 'brown', filter: 'lowpass', f0: Math.max(60, (300 + 360 * m) * (far ? 0.5 : 1)), f1: Math.max(35, 130 - 80 * m), q: 0.7, attack: 0.04 + 0.07 * m, hold: 0.08 * rumbleDur, dur: rumbleDur, peak: 1.3 });
  for (let i = 0; i < rumble.length; i++) { const t = i / SR; rumble[i] *= 0.75 + 0.25 * Math.sin(6.283 * rng.range(0.5, 1.1) * t) * Math.sin(6.283 * 1.7 * t + 1); }
  addInto(out, rumble, n(b), far ? 1.4 : 1);
  const peals = nuke ? 3 : Math.round(m * 2) + (far ? 1 : 0);
  for (let i = 0; i < peals; i++) { const f = rng.range(90, 220), d = rng.range(0.4, 1.2); addInto(out, noiseBand(seed + 10 + i, n(d), { color: 'brown', filter: 'lowpass', f0: f, f1: f * 0.8, q: 0.6, attack: 0.3 * d, dur: d, peak: rng.range(0.4, 0.8) * (0.5 + 0.5 * m) }), n(b + rng.range(0.25, 0.85) * rumbleDur)); }
  const fsub = rng.range(50, 68);
  addInto(out, toneSweep(n(0.7 + 0.7 * m), { f0: fsub * 1.5, f1: fsub * 0.7, attack: 0.02, dur: 0.65 + 0.65 * m, peak: (0.3 + 0.7 * m * m) }), n(b), far ? 0.5 : 1);
  // Debris: grit and clods, density with carve volume.
  if (!far) {
    addInto(out, ticks(seed + 5, n(1.6), { count: Math.round(6 + 26 * m * m * m), t0: 0.3, t1: 1.5, density: 1.6, fLo: 900, fHi: 3600, dLo: 0.005, dHi: 0.025, pLo: 0.1, pHi: 0.3, fade: 0.6, q: 2.5 }), n(b));
    addInto(out, ticks(seed + 6, n(1.4), { count: Math.round(2 + 6 * m), t0: 0.35, t1: 1.3, density: 1.3, fLo: 160, fHi: 420, dLo: 0.04, dHi: 0.09, pLo: 0.3, pHi: 0.7, fade: 0.4, color: 'brown', filter: 'lowpass', q: 0.8 }), n(b));
  }
  if (nuke) {
    addInto(out, noiseBand(seed + 20, n(pre + 0.05), { f0: 180, f1: 1400, q: 1.2, attack: pre - 0.01, dur: pre + 0.05, swell: true, peak: 0.8 }), 0);
    addInto(out, toneSweep(n(pre + 0.04), { f0: 30, f1: 58, attack: pre - 0.02, dur: pre + 0.04, swell: true, peak: 0.6 }), 0);
    addInto(out, toneSweep(n(2.3), { f0: 40, f1: 27, attack: 0.3, hold: 0.2, dur: 2.2, peak: 1 }), n(b));
    addInto(out, noiseBand(seed + 21, n(1.3), { f0: 2400, f1: 260, q: 1, attack: 0.5, dur: 1.2, swell: true, peak: 0.5 }), n(b + 1.6));
  } else if (kind === 'incendiary') {
    addInto(out, noiseBand(seed + 22, n(0.5), { f0: 300, f1: 2600, q: 1.4, attack: 0.2, dur: 0.45, peak: 0.6 }), n(b + 0.02));
    addInto(out, noiseBand(seed + 23, n(2.6), { color: 'pink', filter: 'lowpass', f0: 600, f1: 300, q: 0.7, attack: 0.3, hold: 1, dur: 2.5, peak: 0.4 }), n(b + 0.05));
    addInto(out, ticks(seed + 24, n(2.6), { count: 18, t0: 0.3, t1: 2.5, density: 1.1, fLo: 1500, fHi: 5000, dLo: 0.003, dHi: 0.012, pLo: 0.15, pHi: 0.4, fade: 0.5, q: 2 }), n(b));
  }
  let y = tube(out, 1.6 + 0.4 * m);
  if (far) { dull(y, 600 - 200 * m, 2); filter(y, 'highpass', 45, 0.7); }
  tail(y, { seconds: far ? 1.6 : 0.8 + 0.6 * m, damp: far ? 1500 : 3000, preDelayMs: far ? 60 : 20, size: 1.3 }, far ? 0.5 : 0.28, seed);
  return edges(trim(normalize(y)));
}

// ---- Impacts on armour ----------------------------------------------------------------------------------------------------
export function ricochet(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.08), len = n(0.55);
  const ping = partials(n(0.4), 1150 * p, [1, 2.1, 3.7, 5.9], [0.5, 0.3, 0.15, 0.08], 0.28, { seed, detune: 0.01 });
  const zing = toneSweep(n(0.13), { f0: 1600 * p, f1: 3400 * p, attack: 0.004, dur: 0.12, peak: 0.25, curve: 0.6 });
  const clank = noiseBand(seed + 1, n(0.03), { f0: 2300 * p, f1: 1200, q: 1.3, attack: 0.001, dur: 0.028, peak: 0.9 });
  const sparks = ticks(seed + 2, n(0.3), { count: 6, t0: 0.01, t1: 0.25, density: 1.5, fLo: 3500, fHi: 8000, dLo: 0.003, dHi: 0.008, pLo: 0.1, pHi: 0.25, fade: 0.5, q: 5 });
  const thud = toneSweep(n(0.07), { f0: 190 * p, f1: 90, attack: 0.002, dur: 0.065, peak: 0.35 });
  let out = mix(len, [clank, 1], [ping, 1, 0.002], [zing, 1, 0.01], [sparks, 1], [thud, 1]);
  out = sat(out, 1.3);
  tail(out, { seconds: 0.5, damp: 6000, preDelayMs: 6 }, 0.15, seed);
  return edges(trim(normalize(out)));
}
export function penetrate(seed: number, heavy = false): Mono {
  const rng = new Rng(seed), p = j(rng, 0.06), len = n(heavy ? 1.2 : 0.9);
  const clank = partials(n(0.9), (heavy ? 300 : 430) * p, METAL, [0.45, 0.28, 0.16, 0.09, 0.04], heavy ? 0.9 : 0.6, { seed, detune: 0.012 });
  const knock = noiseBand(seed + 1, n(0.04), { f0: 1100 * p, f1: 600, q: 1.5, attack: 0.002, dur: 0.035, peak: 0.8 });
  const thud = toneSweep(n(0.18), { f0: 150 * p, f1: 58, attack: 0.003, dur: 0.16, peak: 0.8 });
  const crunch = noiseBand(seed + 2, n(0.12), { f0: 700 * p, f1: 350, q: 1.1, attack: 0.003, dur: 0.11, peak: 0.9 });
  const rattle = ticks(seed + 3, n(0.4), { count: heavy ? 9 : 6, t0: 0.02, t1: 0.3, density: 1.4, fLo: 2500, fHi: 4500, dLo: 0.004, dHi: 0.01, pLo: 0.1, pHi: 0.2, fade: 0.5, q: 5 });
  const tin = partials(n(0.5), 2600 * p, [1, 1.3, 1.9], [0.12, 0.08, 0.05], 0.3, { seed: seed + 9 });
  const tearing = heavy ? tear(seed + 4, n(0.45), 2800, 500, 0.4, 0.5, 9) : null;
  let out = mix(len, [clank, 1], [knock, 1], [thud, 1, 0.003], [crunch, 1], [rattle, 1], [tin, 1, 0.01], ...(tearing ? [[tearing, 1, 0.03] as const] : []));
  out = tube(out, 1.6);
  tail(out, { seconds: 0.6, damp: 4500, preDelayMs: 8 }, 0.18, seed);
  return edges(trim(normalize(out)));
}
export function shieldHit(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), len = n(0.8);
  const shimmer = partials(n(0.7), 1800 * p, [1, 1.5, 2.0, 2.5, 3.01], [0.35, 0.28, 0.2, 0.14, 0.1], 0.5, { seed, detune: 0.004 });
  const zap = noiseBand(seed + 1, n(0.12), { f0: 5000 * p, f1: 1500, q: 2, attack: 0.001, dur: 0.1, peak: 0.8 });
  const hum = toneSweep(n(0.5), { f0: 220 * p, f1: 180, attack: 0.005, dur: 0.45, peak: 0.3, vibrato: [30, 12] });
  let out = mix(len, [zap, 1], [shimmer, 1], [hum, 1]);
  out = sat(out, 1.3);
  tail(out, { seconds: 0.9, damp: 7000, preDelayMs: 10 }, 0.3, seed);
  return edges(trim(normalize(out)));
}
export function empZap(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), len = n(1.3);
  const sweep = toneSweep(n(0.35), { wave: 'saw', f0: 2200 * p, f1: 55, attack: 0.002, dur: 0.33, peak: 0.5 });
  const crackle = ticks(seed + 1, n(0.6), { count: 26, t0: 0, t1: 0.55, density: 1.4, fLo: 2000, fHi: 9000, dLo: 0.002, dHi: 0.007, pLo: 0.2, pHi: 0.5, fade: 0.6, q: 4 });
  const powerDown = toneSweep(n(0.9), { f0: 420 * p, f1: 38, attack: 0.05, dur: 0.85, peak: 0.45, curve: 1.6 });
  const burst = noiseBand(seed + 2, n(0.1), { f0: 3000, f1: 800, q: 1, attack: 0.001, dur: 0.09, peak: 0.9 });
  let out = mix(len, [burst, 1], [sweep, 1], [crackle, 1], [powerDown, 1, 0.3]);
  out = sat(out, 1.4);
  tail(out, { seconds: 0.7, damp: 5000, preDelayMs: 8 }, 0.2, seed);
  return edges(trim(normalize(out)));
}

// ---- Destruction, wrecks, fire ---------------------------------------------------------------------------------------------
export function destructionBurst(seed: number, big = false): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), len = n(big ? 3.2 : 2.4);
  const subDrop = toneSweep(n(0.8), { f0: 95 * p, f1: 32, attack: 0.01, dur: 0.75, peak: 1 });
  const blast = noiseBand(seed + 1, n(0.6), { color: 'brown', filter: 'lowpass', f0: 500, f1: 90, q: 0.8, attack: 0.004, dur: 0.55, peak: 1.3 });
  const crack = noiseBand(seed + 2, n(0.1), { f0: 2800 * p, f1: 700, q: 1.1, attack: 0.002, dur: 0.09, peak: 1 });
  const crunch = noiseBand(seed + 3, n(0.45), { f0: 1400 * p, f1: 350, q: 1.2, attack: 0.004, dur: 0.42, peak: 0.8 });
  const bigClank = partials(n(1.6), 280 * p, METAL, [0.5, 0.3, 0.18, 0.1, 0.05], 1.4, { seed, detune: 0.012 });
  const shriek = tear(seed + 4, n(0.7), 3200 * p, 420, 0.6, 0.5, 8, 5);
  const sproing = toneSweep(n(0.75), { wave: 'triangle', f0: 420 * p, f1: 180, attack: 0.005, dur: 0.7, peak: 0.12, vibrato: [14, 120] });
  const debris = ticks(seed + 5, n(2.2), { count: big ? 34 : 22, t0: 0.25, t1: 2.0, density: 1.5, fLo: 700, fHi: 3800, dLo: 0.005, dHi: 0.03, pLo: 0.1, pHi: 0.3, fade: 0.6, q: 2.5 });
  const clods = ticks(seed + 6, n(1.8), { count: big ? 8 : 5, t0: 0.35, t1: 1.6, density: 1.3, fLo: 150, fHi: 400, dLo: 0.04, dHi: 0.09, pLo: 0.3, pHi: 0.6, fade: 0.4, color: 'brown', filter: 'lowpass', q: 0.8 });
  const pops = ticks(seed + 7, n(2.4), { count: big ? 5 : 3, t0: 0.6, t1: 2.2, fLo: 300, fHi: 900, dLo: 0.03, dHi: 0.07, pLo: 0.4, pHi: 0.7, color: 'brown', filter: 'lowpass', q: 1 });
  let out = mix(len, [crack, 1], [blast, 1], [subDrop, 1, 0.04], [crunch, 1, 0.02], [bigClank, 1, 0.06], [shriek, 1, 0.08], [sproing, 1, 0.14], [debris, 1], [clods, 1], [pops, 1]);
  out = tube(out, 1.9);
  tail(out, { seconds: 1.4, damp: 3500, preDelayMs: 18, size: 1.3 }, 0.3, seed);
  return edges(trim(normalize(out)));
}
/** Seamless 4 s burning-wreck loop: fire crackle, low roar, hiss, the odd creak of cooling metal. */
export function wreckFireLoop(seed: number): Mono {
  const len = n(4.4), rng = new Rng(seed), nz = new Noise(seed ^ 0x77);
  const out = new Float32Array(len);
  const roar = noiseBand(seed + 1, len, { color: 'brown', filter: 'lowpass', f0: 320, q: 0.7, attack: 0.01, hold: 4.3, dur: 4.4, peak: 0.6 });
  for (let i = 0; i < len; i++) { const t = i / SR; roar[i] *= 0.7 + 0.3 * Math.sin(6.283 * 0.7 * t) * Math.sin(6.283 * 1.9 * t + 2); }
  addInto(out, roar, 0);
  addInto(out, noiseBand(seed + 2, len, { color: 'pink', filter: 'highpass', f0: 3500, q: 0.7, attack: 0.01, hold: 4.3, dur: 4.4, peak: 0.08 }), 0);
  addInto(out, ticks(seed + 3, len, { count: 170, t0: 0, t1: 4.35, fLo: 1500, fHi: 5500, dLo: 0.002, dHi: 0.01, pLo: 0.08, pHi: 0.35, q: 3 }), 0);
  addInto(out, ticks(seed + 4, len, { count: 20, t0: 0, t1: 4.3, fLo: 250, fHi: 700, dLo: 0.02, dHi: 0.05, pLo: 0.15, pHi: 0.35, color: 'brown', filter: 'lowpass', q: 1 }), 0);
  // Cooling-metal creaks and pings, sparse.
  for (let k = 0; k < 4; k++) addInto(out, partials(n(0.6), rng.range(700, 2200), [1, 2.3, 3.9], [0.15, 0.08, 0.04], 0.4, { seed: seed + 30 + k }), n(rng.range(0.1, 4.0)));
  addInto(out, tear(seed + 5, n(0.5), 900, 600, 0.45, 0.12, 14, 2), n(rng.range(0.3, 3.5)));
  void nz;
  sat(out, 1.3);
  return normalize(loopable(out, 0.08), 0.8);
}
export function metalCreak(seed: number): Mono {
  const rng = new Rng(seed), len = n(0.9);
  const creak = tear(seed, n(0.7), rng.range(500, 1100), rng.range(300, 700), 0.6, 0.6, 16, rng.range(3, 9));
  const groan = toneSweep(n(0.5), { wave: 'saw', f0: rng.range(90, 140), f1: rng.range(60, 100), attack: 0.05, dur: 0.45, peak: 0.15 });
  const settle = ticks(seed + 1, n(0.8), { count: 5, t0: 0.1, t1: 0.7, fLo: 200, fHi: 600, dLo: 0.02, dHi: 0.05, pLo: 0.2, pHi: 0.4, color: 'brown', filter: 'lowpass', q: 1 });
  let out = mix(len, [creak, 1], [groan, 1], [settle, 1]);
  out = sat(filter(out, 'lowpass', 6000, 0.7), 1.2);
  return edges(trim(normalize(out, 0.7)));
}
export function rubbleSettle(seed: number, size = 0.5): Mono {
  const len = n(1.2), r = 0.5 + size;
  const clods = ticks(seed, len, { count: Math.round(8 + r * 6), t0: 0, t1: 0.9, density: 1.4, fLo: 250, fHi: 700, dLo: 0.02, dHi: 0.06, pLo: 0.3, pHi: 0.7, fade: 0.6, color: 'brown', filter: 'lowpass', q: 0.8 });
  const bed = noiseBand(seed + 1, n(0.8), { color: 'pink', filter: 'lowpass', f0: 400, f1: 150, q: 0.7, attack: 0.06, dur: 0.75, peak: 0.4 });
  const grit = ticks(seed + 2, len, { count: 12, t0: 0, t1: 0.8, fLo: 900, fHi: 2600, dLo: 0.004, dHi: 0.015, pLo: 0.08, pHi: 0.2, fade: 0.6, q: 2.5 });
  return edges(trim(normalize(mix(len, [clods, 1], [bed, 1], [grit, 1]), 0.7)));
}
export function suspensionThump(seed: number, intensity = 0.6): Mono {
  const rng = new Rng(seed), i = Math.max(0, Math.min(1, intensity)), len = n(0.3);
  const knock = noiseBand(seed + 1, n(0.05 + 0.05 * i), { color: 'brown', filter: 'lowpass', f0: 240 * j(rng, 0.1), f1: 110, q: 0.8, attack: 0.003, dur: 0.05 + 0.05 * i, peak: 0.6 + 0.4 * i });
  const sine = toneSweep(n(0.1 + 0.06 * i), { f0: 120 * j(rng, 0.06), f1: 55, attack: 0.003, dur: 0.09 + 0.06 * i, peak: 0.5 + 0.4 * i });
  const clink = ticks(seed + 2, n(0.12), { count: 1 + Math.round(2 * i), t0: 0.005, t1: 0.08, fLo: 1600, fHi: 2400, dLo: 0.006, dHi: 0.02, pLo: 0.1 + 0.1 * i, pHi: 0.2 + 0.1 * i, q: 6 });
  const squeak = i > 0.5 ? toneSweep(n(0.08), { f0: 900 * j(rng, 0.1), f1: 1300, attack: 0.01, dur: 0.07, peak: 0.08 }) : null;
  return edges(trim(normalize(mix(len, [knock, 1], [sine, 1, 0.002], [clink, 1], ...(squeak ? [[squeak, 1, 0.01] as const] : [])), 0.75)));
}
export function treadLanding(seed: number): Mono {
  const len = n(0.5);
  const slam = noiseBand(seed, n(0.18), { color: 'brown', filter: 'lowpass', f0: 300, f1: 90, q: 0.8, attack: 0.003, dur: 0.17, peak: 1 });
  const sub = toneSweep(n(0.2), { f0: 110, f1: 45, attack: 0.003, dur: 0.18, peak: 0.8 });
  const rattle = ticks(seed + 1, n(0.4), { count: 10, t0: 0.01, t1: 0.3, density: 1.5, fLo: 1500, fHi: 3500, dLo: 0.004, dHi: 0.012, pLo: 0.1, pHi: 0.25, fade: 0.5, q: 5 });
  const clank = partials(n(0.3), 520, METAL, [0.2, 0.12, 0.07, 0.04, 0.02], 0.25, { seed });
  return edges(trim(normalize(sat(mix(len, [slam, 1], [sub, 1], [rattle, 1], [clank, 1, 0.005]), 1.4))));
}

// ---- Machines and loops ---------------------------------------------------------------------------------------------------
export function rotorLoop(seed: number): Mono {
  const len = n(2.0), out = new Float32Array(len), nz = new Noise(seed), bp = new Biquad('bandpass', 1050, 4), lp = new Biquad('lowpass', 1600, 0.7), chop = 24;
  for (let i = 0; i < len; i++) {
    const t = i / SR, ph = (t * chop) % 1, blade = Math.pow(Math.max(0, Math.sin(ph * Math.PI)), 3);
    const wash = lp.run(nz.white()) * (0.35 + 0.65 * blade) * 0.9;
    // The gearbox whine is a faint, wavering band of noise rather than a pure tone (a steady sine reads as a test tone).
    const whineV = bp.run(nz.white()) * 0.22 * (0.7 + 0.3 * Math.sin(6.283 * 0.9 * t));
    out[i] = wash + whineV + Math.sin(6.283 * chop * 2 * t) * 0.1 * blade + Math.sin(6.283 * chop * t) * 0.06;
  }
  sat(out, 1.3);
  return normalize(loopable(out, 0.06), 0.8);
}
export function hoverLoop(seed: number): Mono {
  const len = n(2.4), out = new Float32Array(len), nz = new Noise(seed), hp = new Biquad('highpass', 5000, 0.7);
  for (let i = 0; i < len; i++) {
    const t = i / SR, f = 112;
    let v = 0; for (let k = 1; k <= 6; k++) v += Math.sin(6.283 * f * k * t + 0.3 * k) * (1 / k) * (k % 2 ? 1 : 0.6);
    const phase = 0.5 + 0.5 * Math.sin(6.283 * 0.4 * t);
    out[i] = v * 0.18 * (0.8 + 0.2 * phase) + hp.run(nz.white()) * 0.05 + Math.sin(6.283 * 1340 * t) * 0.02 * phase;
  }
  return normalize(loopable(out, 0.08), 0.75);
}
export function swarmLoop(seed: number): Mono {
  const len = n(2.6), out = new Float32Array(len), rng = new Rng(seed);
  addInto(out, ticks(seed + 1, len, { count: 140, t0: 0, t1: 2.55, fLo: 2500, fHi: 7000, dLo: 0.002, dHi: 0.006, pLo: 0.15, pHi: 0.4, q: 6 }), 0);
  addInto(out, noiseBand(seed + 2, len, { color: 'pink', filter: 'bandpass', f0: 3200, q: 0.8, attack: 0.01, hold: 2.5, dur: 2.6, peak: 0.12 }), 0);
  for (let k = 0; k < 6; k++) addInto(out, toneSweep(n(0.18), { wave: 'saw', f0: rng.range(1800, 3600), f1: rng.range(2500, 4800), attack: 0.02, dur: 0.16, peak: 0.05 }), n(rng.range(0, 2.4)));
  for (let k = 0; k < 10; k++) addInto(out, partials(n(0.15), rng.range(1500, 4000), [1, 2.2], [0.1, 0.05], 0.08, { seed: seed + 50 + k }), n(rng.range(0, 2.5)));
  return normalize(loopable(out, 0.06), 0.7);
}
export function crawlerLoop(seed: number): Mono {
  const len = n(3.0), out = new Float32Array(len), nz = new Noise(seed), lp = new Biquad('lowpass', 500, 0.8);
  for (let i = 0; i < len; i++) {
    const t = i / SR, f = 21, fire = Math.pow(Math.max(0, Math.sin(6.283 * f * t)), 6);
    out[i] = lp.run(nz.brown() * 1.2 * (0.4 + 0.6 * fire)) + Math.sin(6.283 * f * 2 * t) * 0.25 + Math.sin(6.283 * 43 * t) * 0.15;
  }
  addInto(out, ticks(seed + 1, len, { count: 60, t0: 0, t1: 2.95, fLo: 700, fHi: 2200, dLo: 0.004, dHi: 0.012, pLo: 0.08, pHi: 0.2, q: 4 }), 0);
  addInto(out, noiseBand(seed + 2, len, { f0: 2600, q: 0.6, attack: 0.01, hold: 2.9, dur: 3, peak: 0.06 }), 0);
  sat(out, 1.5);
  return normalize(loopable(out, 0.08), 0.8);
}
export function spireLoop(seed: number): Mono {
  const len = n(3.2), out = new Float32Array(len), nz = new Noise(seed), bp = new Biquad('bandpass', 120, 6);
  for (let i = 0; i < len; i++) { const t = i / SR; out[i] = Math.sin(6.283 * 55 * t) * 0.3 + Math.sin(6.283 * 110 * t + 0.5) * 0.12 * (0.7 + 0.3 * Math.sin(6.283 * 0.3 * t)) + bp.run(nz.white()) * 0.6 + Math.sin(6.283 * 1200 * t) * 0.02 * (Math.sin(6.283 * 7 * t) > 0.8 ? 1 : 0); }
  addInto(out, ticks(seed + 1, len, { count: 30, t0: 0, t1: 3.1, fLo: 3000, fHi: 9000, dLo: 0.002, dHi: 0.005, pLo: 0.1, pHi: 0.3, q: 5 }), 0);
  return normalize(loopable(out, 0.08), 0.7);
}
export function searchlightLoop(seed: number): Mono {
  const len = n(2.0), out = new Float32Array(len), nz = new Noise(seed), bp = new Biquad('bandpass', 1700, 3);
  for (let i = 0; i < len; i++) { const t = i / SR; out[i] = Math.sin(6.283 * 240 * t) * 0.18 + Math.sin(6.283 * 480 * t) * 0.06 + bp.run(nz.white()) * 0.08 * (((t * 18) % 1) < 0.1 ? 1 : 0.2); }
  return normalize(loopable(out, 0.05), 0.6);
}
export function shieldLoop(seed: number): Mono {
  const len = n(2.8), out = new Float32Array(len), rng = new Rng(seed), fs = [1210, 1520, 1830, 2420].map(f => f * rng.jitter(0.01));
  for (let i = 0; i < len; i++) { const t = i / SR; let v = 0; for (let k = 0; k < fs.length; k++) v += Math.sin(6.283 * fs[k] * t) * (0.5 + 0.5 * Math.sin(6.283 * (0.9 + k * 0.37) * t)) * 0.12; out[i] = v + Math.sin(6.283 * 90 * t) * 0.15; }
  return normalize(loopable(out, 0.08), 0.6);
}
