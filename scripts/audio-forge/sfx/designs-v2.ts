/**
 * Next-level weapons and destruction (2026-10-17): howitzer-class reports in five layers with near/mid/far takes, a
 * sustained machine-gun loop with its stop tail, supersonic snaps, material ricochets, material-aware debris, the
 * shock-wave huff and planet echo, multi-stage wrecks, and the ear ring for the biggest near blasts.
 */
import { SR, type Mono, Rng, addInto, mono } from '../dsp/core';
import { n, noiseBand, toneSweep, partials, METAL, ticks, whine, ring, tear, mix, filter, sat, tube, tail, normalize, edges, trim, dull } from './kit';
import { coaxShot, explosion, ricochet, type BlastKind } from './designs';

const j = (rng: Rng, a: number) => rng.jitter(a);
export type Range = 'near' | 'mid' | 'far';
export type Material = 'soil' | 'rock' | 'concrete' | 'metal' | 'water';
/** out[(at + i) mod len] += buf[i]: additions wrap so a loop's tails fold into its start. */
function wrapAdd(out: Mono, buf: Mono, at: number, gain = 1): void { const L = out.length; for (let i = 0; i < buf.length; i++) out[(((at + i) % L) + L) % L] += buf[i] * gain; }
/** Two darkened slapbacks (the report echoing off the planet) at 90 and 210 ms. */
function planetEcho(src: Mono, len: number, o: { t1?: number; t2?: number; g1?: number; g2?: number; cut1?: number; cut2?: number } = {}): Mono {
  const out = mono(len), a = new Float32Array(src), b = new Float32Array(src);
  dull(a, o.cut1 ?? 1200, 2); dull(b, o.cut2 ?? 700, 2);
  addInto(out, a, n(o.t1 ?? 0.09), o.g1 ?? 0.32); addInto(out, b, n(o.t2 ?? 0.21), o.g2 ?? 0.2);
  return out;
}
/** The mechanical follow-through of a big gun: casing ejection, breech cycling, a pressure hiss. */
function followThrough(seed: number, len: number, scale = 1): Mono {
  const rng = new Rng(seed ^ 0x3f3), out = mono(len);
  // Casing: a bright ring as the shell case flies, then its clatter on the deck.
  addInto(out, partials(n(0.5), 2100 * j(rng, 0.08), [1, 1.9, 3.3, 5.1], [0.14, 0.08, 0.05, 0.02], 0.35, { seed: seed + 11 }), n(0.33 * scale));
  addInto(out, ticks(seed + 12, n(0.5), { count: 5, t0: 0.02, t1: 0.3, density: 1.3, fLo: 1800, fHi: 4200, dLo: 0.004, dHi: 0.012, pLo: 0.08, pHi: 0.18, fade: 0.5, q: 5 }), n(0.5 * scale));
  // Breech: two heavy chunks and a latch.
  addInto(out, noiseBand(seed + 13, n(0.09), { color: 'brown', filter: 'lowpass', f0: 420, f1: 160, q: 1, attack: 0.003, dur: 0.08, peak: 0.55 }), n(0.42 * scale));
  addInto(out, noiseBand(seed + 14, n(0.07), { color: 'brown', filter: 'lowpass', f0: 520, f1: 200, q: 1, attack: 0.003, dur: 0.06, peak: 0.45 }), n(0.56 * scale));
  addInto(out, partials(n(0.3), 1400 * j(rng, 0.05), [1, 1.6, 2.9], [0.1, 0.06, 0.03], 0.12, { seed: seed + 15 }), n(0.6 * scale));
  // Pressure hiss venting from the breech.
  addInto(out, noiseBand(seed + 16, n(0.8), { f0: 3200, f1: 1600, q: 0.8, attack: 0.08, dur: 0.75, swell: false, peak: 0.12 }), n(0.26 * scale));
  return out;
}
/** Howitzer-class cannon: five layers; `range` picks the near, mid (8-20 u) or far take. */
export function cannonReport(seed: number, range: Range = 'near'): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), far = range === 'far', mid = range === 'mid', len = n(far ? 1.8 : mid ? 1.7 : 1.6);
  // (1) sub thump 35-60 Hz, ~150 ms.  (2) mid punch 150-400 Hz.  (3) crack + breech click.  (4) rolling tail.  (5) follow-through.
  const sub = toneSweep(n(0.26), { f0: 64 * p, f1: 36, attack: 0.003, dur: 0.16, peak: 1.1 });
  const punch = mix(n(0.3), [noiseBand(seed + 1, n(0.26), { color: 'brown', filter: 'lowpass', f0: 460 * p, f1: 150, q: 0.9, attack: 0.004, dur: 0.24, peak: 1.3 }), 1], [toneSweep(n(0.16), { f0: 210 * p, f1: 120, attack: 0.003, dur: 0.13, peak: 0.6 }), 1]);
  const crack = mix(n(0.12), [noiseBand(seed + 2, n(0.09), { f0: 2700 * p, f1: 700, q: 1.1, attack: 0.0012, dur: 0.08, peak: 1 }), 1], [noiseBand(seed + 3, n(0.03), { f0: 5600 * p, f1: 3200, q: 0.8, filter: 'highpass', attack: 0.0008, dur: 0.025, peak: 0.6 }), 1],
    [noiseBand(seed + 4, n(0.16), { f0: 680 * p, f1: 420, q: 1.2, attack: 0.002, dur: 0.14, peak: 0.9 }), 1], [partials(n(0.1), 1500 * p, [1, 2.2, 3.7], [0.25, 0.12, 0.06], 0.05, { seed }), 1, 0.004]);
  const breech = partials(n(0.6), 330 * p, METAL, [0.3, 0.2, 0.12, 0.07, 0.03], 0.5, { seed, detune: 0.01 });
  const body = mix(n(0.45), [crack, 1], [punch, 1], [sub, 0.6]);
  const echoTail = planetEcho(body, len, { g1: far ? 0.5 : mid ? 0.42 : 0.32, g2: far ? 0.4 : mid ? 0.3 : 0.2 });
  const echo = noiseBand(seed + 5, n(1.1), { color: 'pink', filter: 'lowpass', f0: 1500, f1: 260, q: 0.6, attack: 0.03, dur: 1.0, peak: 0.35 });
  const follow = followThrough(seed, n(1.3));
  let out = mix(len, [crack, far ? 0.25 : mid ? 0.6 : 1], [punch, far ? 1.3 : mid ? 1.15 : 1], [sub, far ? 0.6 : mid ? 0.85 : 1], [breech, far ? 0 : mid ? 0.2 : 0.5, 0.12], [echoTail, 1], [echo, far ? 1.2 : mid ? 0.9 : 0.6, 0.05], [follow, far ? 0 : mid ? 0.35 : 0.8, 0.02]);
  out = tube(out, 1.9);
  if (far) { dull(out, 900, 2); filter(out, 'highpass', 50, 0.7); } else if (mid) { dull(out, 2600, 1); filter(out, 'highpass', 42, 0.7); }
  tail(out, { seconds: far ? 1.5 : mid ? 1.0 : 0.7, damp: far ? 1800 : mid ? 2800 : 3800, preDelayMs: far ? 40 : mid ? 22 : 12, size: 1.2 }, far ? 0.5 : mid ? 0.35 : 0.25, seed);
  return edges(trim(normalize(out)));
}
/** Mortar: a hollow thoomp (a resonant tube at 180 to 110 Hz) with the shell's exit whistle; mid take available. */
export function mortarReport(seed: number, range: Range = 'near'): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), far = range === 'far', mid = range === 'mid', len = n(far ? 1.5 : 1.3);
  const pop = toneSweep(n(0.24), { f0: 250 * p, f1: 68, attack: 0.003, dur: 0.22, peak: 1 });
  const thoomp = noiseBand(seed + 1, n(0.32), { f0: 190 * p, f1: 105, q: 7, attack: 0.003, dur: 0.3, peak: 1.2, stages: 2 });
  const tube_ = noiseBand(seed + 2, n(0.15), { f0: 640 * p, f1: 390, q: 5, attack: 0.002, dur: 0.14, peak: 0.6 });
  const body = noiseBand(seed + 3, n(0.4), { color: 'brown', filter: 'lowpass', f0: 900 * p, f1: 130, q: 0.7, attack: 0.004, dur: 0.38, peak: 1.1 });
  const click = noiseBand(seed + 4, n(0.05), { f0: 1900 * p, f1: 720, q: 1.1, attack: 0.002, dur: 0.05, peak: 0.5 });
  const whistle = toneSweep(n(0.7), { f0: 2300 * p, f1: 1100, attack: 0.12, dur: 0.65, peak: 0.16, vibrato: [11, 30], curve: 0.8 });
  const whistleAir = noiseBand(seed + 5, n(0.6), { f0: 2400 * p, f1: 1300, q: 4, attack: 0.1, dur: 0.55, peak: 0.12 });
  const metal = partials(n(0.45), 410 * p, [1, 2.76, 5.4], [0.2, 0.1, 0.05], 0.38, { seed });
  const echo = planetEcho(mix(n(0.4), [pop, 1], [thoomp, 1]), len, { g1: far ? 0.5 : 0.3, g2: far ? 0.4 : 0.18, cut1: 900, cut2: 500 });
  let out = mix(len, [pop, 1], [thoomp, far ? 1.2 : 1], [tube_, far ? 0.4 : mid ? 0.7 : 1], [body, far ? 1.3 : 1], [click, far ? 0 : mid ? 0.5 : 1], [whistle, far ? 0.3 : 1, 0.06], [whistleAir, far ? 0.3 : 1, 0.06], [metal, far ? 0 : mid ? 0.3 : 0.6, 0.01], [echo, 1]);
  out = tube(out, 1.5);
  if (far) dull(out, 700, 2); else if (mid) dull(out, 2200, 1);
  tail(out, { seconds: far ? 1.3 : mid ? 0.9 : 0.6, damp: 2800, preDelayMs: 15, size: 1.1 }, far ? 0.5 : mid ? 0.32 : 0.22, seed);
  return edges(trim(normalize(out)));
}
/** Rail: a capacitor charge that is FELT (a sub throb rising), an electric scream, the sonic crack, a long ionised tail. */
export function railReport(seed: number, range: Range = 'near'): Mono {
  const rng = new Rng(seed), p = j(rng, 0.04), c = 0.11, far = range === 'far', mid = range === 'mid', len = n(far ? 1.8 : 2.3);
  const throb = toneSweep(n(c + 0.05), { f0: 30 * p, f1: 60, attack: c - 0.01, dur: c + 0.04, swell: true, peak: 0.9 });
  for (let i = 0; i < throb.length; i++) { const t = i / SR; throb[i] *= 0.55 + 0.45 * Math.sin(6.283 * (16 + 60 * t / c) * t); }
  const charge = whine(n(c + 0.03), 380 * p, 2600 * p, c + 0.02, 0.45, 9);
  const scream = ring(seed + 7, n(c + 0.06), 2200 * p, 3400 * p, 2.5, c + 0.05, 0.35);
  const crack = noiseBand(seed + 1, n(0.07), { f0: 4600 * p, f1: 1300, q: 1.4, attack: 0.0012, dur: 0.06, peak: 1 });
  const zap = toneSweep(n(0.14), { wave: 'square', f0: 1900 * p, f1: 200, attack: 0.002, dur: 0.13, peak: 0.25 });
  const body = noiseBand(seed + 2, n(0.32), { color: 'brown', filter: 'lowpass', f0: 640 * p, f1: 140, q: 0.8, attack: 0.004, dur: 0.28, peak: 0.95 });
  const sub = toneSweep(n(0.2), { f0: 150 * p, f1: 50, attack: 0.003, dur: 0.17, peak: 0.8 });
  const ion = ring(seed + 3, n(1.6), 3000 * p, 2400 * p, 1.4, 1.4, 0.26);
  const ionAir = noiseBand(seed + 4, n(1.5), { color: 'pink', f0: 2600 * p, f1: 500, q: 1.1, attack: 0.02, dur: 1.4, peak: 0.22 });
  const recharge = toneSweep(n(1.3), { f0: 300 * p, f1: 1900 * p, attack: 0.3, dur: 1.2, swell: true, peak: 0.07, vibrato: [9, 25] });
  const echo = planetEcho(mix(n(0.35), [crack, 1], [body, 1]), len, { g1: far ? 0.5 : 0.3, g2: far ? 0.4 : 0.18 });
  let out = mix(len, [throb, far ? 0.4 : 1], [charge, far ? 0.3 : 1], [scream, far ? 0.2 : mid ? 0.6 : 1], [crack, far ? 0.3 : 1, c], [zap, far ? 0.3 : 1, c], [body, far ? 1.2 : 1, c], [sub, far ? 0.7 : 1, c], [ion, far ? 0.4 : 1, c + 0.01], [ionAir, far ? 0.5 : 1, c + 0.01], [recharge, far ? 0 : mid ? 0.5 : 1, c + 0.4], [echo, 1, c]);
  out = sat(out, 1.45);
  if (far) dull(out, 1100, 2); else if (mid) dull(out, 3000, 1);
  tail(out, { seconds: far ? 1.4 : mid ? 1.0 : 0.8, damp: 4200, preDelayMs: 10, size: 1.2 }, far ? 0.5 : mid ? 0.32 : 0.25, seed);
  return edges(trim(normalize(out)));
}
/** Arc cannon discharge (the arcs continuing at the target are `arcCrackle`). */
export function arcReport(seed: number, range: Range = 'near'): Mono {
  const rng = new Rng(seed), p = j(rng, 0.05), mid = range === 'mid', len = n(1.3);
  const build = whine(n(0.14), 200 * p, 3200 * p, 0.13, 0.4, 7);
  const discharge = noiseBand(seed + 1, n(0.22), { f0: 6200 * p, f1: 900, q: 1.6, attack: 0.001, dur: 0.2, peak: 1 });
  const crackle = ticks(seed + 2, n(0.6), { count: 26, t0: 0.0, t1: 0.5, density: 1.5, fLo: 2500, fHi: 9000, dLo: 0.002, dHi: 0.008, pLo: 0.2, pHi: 0.6, fade: 0.6, q: 4 });
  const arc = ring(seed + 3, n(0.7), 4200 * p, 3100 * p, 2, 0.6, 0.4);
  const sub = toneSweep(n(0.25), { f0: 90 * p, f1: 40, attack: 0.004, dur: 0.22, peak: 0.85 });
  const body = noiseBand(seed + 4, n(0.3), { color: 'brown', filter: 'lowpass', f0: 700, f1: 150, q: 0.8, attack: 0.004, dur: 0.28, peak: 0.75 });
  let out = mix(len, [build, mid ? 0.6 : 1], [discharge, 1, 0.12], [crackle, mid ? 0.6 : 1, 0.12], [arc, 1, 0.13], [sub, 1, 0.12], [body, mid ? 1.2 : 1, 0.12]);
  out = sat(out, 1.5);
  if (mid) dull(out, 3200, 1);
  tail(out, { seconds: 0.9, damp: 5000, preDelayMs: 10, size: 1.2 }, 0.3, seed);
  return edges(trim(normalize(out)));
}
/** Arcs crackling on at the target for ~0.9 s after an arc hit. */
export function arcCrackle(seed: number): Mono {
  const len = n(1.0);
  const cr = ticks(seed, len, { count: 34, t0: 0, t1: 0.85, density: 1.2, fLo: 2000, fHi: 9500, dLo: 0.002, dHi: 0.009, pLo: 0.15, pHi: 0.5, fade: 0.7, q: 4 });
  const hum = ring(seed + 1, n(0.9), 3300, 2500, 2, 0.8, 0.25);
  const zaps = ticks(seed + 2, len, { count: 6, t0: 0.05, t1: 0.7, fLo: 400, fHi: 1200, dLo: 0.02, dHi: 0.05, pLo: 0.2, pHi: 0.4, fade: 0.6, q: 2 });
  return edges(trim(normalize(sat(mix(len, [cr, 1], [hum, 1], [zaps, 1]), 1.4), 0.8)));
}
export function autocannonReport(seed: number, range: Range = 'near'): Mono {
  const rng = new Rng(seed), p = j(rng, 0.06), mid = range === 'mid', len = n(0.6);
  const crack = noiseBand(seed + 1, n(0.05), { f0: 3300 * p, f1: 900, q: 1.2, attack: 0.001, dur: 0.045, peak: 1 });
  const bark = noiseBand(seed + 2, n(0.11), { f0: 820 * p, f1: 500, q: 1.3, attack: 0.002, dur: 0.1, peak: 0.85 });
  const body = noiseBand(seed + 3, n(0.22), { color: 'brown', filter: 'lowpass', f0: 520 * p, f1: 120, q: 0.8, attack: 0.003, dur: 0.2, peak: 1 });
  const sub = toneSweep(n(0.12), { f0: 130 * p, f1: 55, attack: 0.002, dur: 0.1, peak: 0.7 });
  const link = partials(n(0.2), 1200 * p, [1, 2.4, 4.1], [0.12, 0.06, 0.03], 0.12, { seed });
  const bolt = noiseBand(seed + 4, n(0.04), { color: 'brown', filter: 'lowpass', f0: 600, f1: 250, q: 1, attack: 0.002, dur: 0.035, peak: 0.4 });
  const echo = planetEcho(mix(n(0.25), [crack, 1], [body, 1]), len, { g1: 0.25, g2: 0.14 });
  let out = mix(len, [crack, mid ? 0.6 : 1], [bark, 1], [body, mid ? 1.15 : 1], [sub, 1], [link, mid ? 0.4 : 1, 0.02], [bolt, mid ? 0.3 : 1, 0.07], [echo, 1]);
  out = tube(out, 1.7);
  if (mid) dull(out, 2800, 1);
  tail(out, { seconds: 0.5, damp: 3800, preDelayMs: 8 }, 0.18, seed);
  return edges(trim(normalize(out)));
}
/** Sustained machine-gun fire: a seamless loop of `rounds` rounds at ~12/s with varied timing, a mechanical rattle bed
 * and bolt thuds; tails wrap into the start. */
export function coaxLoop(seed: number, rounds = 9, rate = 12.5): Mono {
  const len = n(rounds / rate), out = mono(len), rng = new Rng(seed);
  const period = len / rounds;
  for (let r = 0; r < rounds; r++) {
    const at = Math.round(r * period + rng.signed() * 0.09 * period);
    wrapAdd(out, coaxShot(seed + r * 17), at, 0.85 + 0.15 * rng.next());
    wrapAdd(out, noiseBand(seed + 200 + r, n(0.03), { color: 'brown', filter: 'lowpass', f0: 500, f1: 220, q: 1, attack: 0.002, dur: 0.028, peak: 0.35 }), at + n(0.012));
  }
  wrapAdd(out, ticks(seed + 99, len, { count: rounds * 3, t0: 0, t1: len / SR, fLo: 2500, fHi: 4800, dLo: 0.003, dHi: 0.01, pLo: 0.06, pHi: 0.14, q: 5 }), 0);
  wrapAdd(out, noiseBand(seed + 300, len, { f0: 1800, q: 0.7, attack: 0.01, hold: len / SR, dur: len / SR, peak: 0.05 }), 0);
  sat(out, 1.3);
  return normalize(out, 0.88);
}
/** When the gun stops: bolt-cycling clatter, hot-barrel ticks, link rattle. */
export function coaxTail(seed: number): Mono {
  const len = n(1.4), rng = new Rng(seed);
  const bolt = mix(n(0.25), [noiseBand(seed + 1, n(0.05), { color: 'brown', filter: 'lowpass', f0: 520, f1: 200, q: 1, attack: 0.002, dur: 0.045, peak: 0.6 }), 1], [partials(n(0.2), 1500 * j(rng, 0.05), [1, 1.6, 2.9], [0.14, 0.08, 0.04], 0.1, { seed: seed + 2 }), 1, 0.03], [noiseBand(seed + 3, n(0.04), { color: 'brown', filter: 'lowpass', f0: 600, f1: 260, q: 1, attack: 0.002, dur: 0.035, peak: 0.5 }), 1, 0.11]);
  const hot = ticks(seed + 4, len, { count: 9, t0: 0.25, t1: 1.3, density: 0.8, fLo: 3200, fHi: 6500, dLo: 0.01, dHi: 0.03, pLo: 0.06, pHi: 0.16, fade: 0.4, q: 12 });
  const links = ticks(seed + 5, n(0.4), { count: 10, t0: 0.02, t1: 0.3, density: 1.4, fLo: 2200, fHi: 4200, dLo: 0.004, dHi: 0.01, pLo: 0.08, pHi: 0.18, fade: 0.5, q: 5 });
  return edges(trim(normalize(sat(mix(len, [bolt, 1], [hot, 1], [links, 1, 0.02]), 1.2), 0.7)));
}
/** Supersonic snap: a round passing within a couple of units of the listener (an N-wave whip). */
export function snap(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.1), len = n(0.16);
  const nwave = noiseBand(seed + 1, n(0.004), { f0: 7000 * p, f1: 4000, q: 0.7, filter: 'highpass', attack: 0.0003, dur: 0.0035, peak: 1 });
  const whip = toneSweep(n(0.03), { f0: 3400 * p, f1: 500, attack: 0.0005, dur: 0.028, peak: 0.6, curve: 0.5 });
  const air = noiseBand(seed + 2, n(0.12), { f0: 2600 * p, f1: 900, q: 1.2, attack: 0.001, dur: 0.11, peak: 0.35 });
  return edges(trim(normalize(sat(mix(len, [nwave, 1], [whip, 1], [air, 1, 0.002]), 1.5))), 0.0005, 0.01);
}
/** Ricochet / impact by material: armour (the ping), rock (chip crack + whine), concrete (dusty thwack + chips),
 * soil (thud + spray), water (plunk + splash + droplets). */
export function ricochetMaterial(seed: number, material: Material): Mono {
  const rng = new Rng(seed), p = j(rng, 0.08);
  switch (material) {
    case 'metal': return ricochet(seed);
    case 'rock': {
      const len = n(0.5);
      const crack = noiseBand(seed + 1, n(0.04), { f0: 2200 * p, f1: 900, q: 1.4, attack: 0.001, dur: 0.035, peak: 1 });
      const whine_ = toneSweep(n(0.1), { f0: 1100 * p, f1: 1700 * p, attack: 0.004, dur: 0.09, peak: 0.18, curve: 0.7 });
      const chips = ticks(seed + 2, n(0.4), { count: 9, t0: 0.01, t1: 0.3, density: 1.5, fLo: 1200, fHi: 4000, dLo: 0.004, dHi: 0.012, pLo: 0.12, pHi: 0.3, fade: 0.5, q: 3 });
      const thud = toneSweep(n(0.08), { f0: 240 * p, f1: 110, attack: 0.002, dur: 0.07, peak: 0.4 });
      return edges(trim(normalize(sat(mix(len, [crack, 1], [whine_, 1, 0.006], [chips, 1], [thud, 1]), 1.3))));
    }
    case 'concrete': {
      const len = n(0.55);
      const thwack = noiseBand(seed + 1, n(0.06), { color: 'brown', filter: 'lowpass', f0: 900 * p, f1: 350, q: 1, attack: 0.001, dur: 0.055, peak: 1 });
      const crack = noiseBand(seed + 2, n(0.03), { f0: 1800 * p, f1: 800, q: 1.2, attack: 0.001, dur: 0.028, peak: 0.6 });
      const dust = noiseBand(seed + 3, n(0.3), { color: 'pink', filter: 'lowpass', f0: 2200, f1: 700, q: 0.7, attack: 0.01, dur: 0.28, peak: 0.3 });
      const chips = ticks(seed + 4, n(0.4), { count: 7, t0: 0.02, t1: 0.3, density: 1.5, fLo: 700, fHi: 2500, dLo: 0.006, dHi: 0.02, pLo: 0.1, pHi: 0.25, fade: 0.5, q: 2.5 });
      return edges(trim(normalize(sat(mix(len, [thwack, 1], [crack, 1], [dust, 1], [chips, 1]), 1.3))));
    }
    case 'soil': {
      const len = n(0.5);
      const thud = noiseBand(seed + 1, n(0.08), { color: 'brown', filter: 'lowpass', f0: 380 * p, f1: 120, q: 0.9, attack: 0.002, dur: 0.075, peak: 1 });
      const spray = ticks(seed + 2, n(0.35), { count: 16, t0: 0.01, t1: 0.25, density: 1.6, fLo: 400, fHi: 1600, dLo: 0.004, dHi: 0.014, pLo: 0.08, pHi: 0.22, fade: 0.6, color: 'brown', filter: 'lowpass', q: 1 });
      const grit = ticks(seed + 3, n(0.3), { count: 8, t0: 0.01, t1: 0.2, fLo: 1500, fHi: 3500, dLo: 0.003, dHi: 0.008, pLo: 0.05, pHi: 0.12, fade: 0.5, q: 3 });
      return edges(trim(normalize(sat(mix(len, [thud, 1], [spray, 1], [grit, 1]), 1.2), 0.85)));
    }
    case 'water': {
      const len = n(0.6);
      const plunk = toneSweep(n(0.08), { f0: 520 * p, f1: 160, attack: 0.002, dur: 0.07, peak: 0.9, curve: 0.6 });
      const splash = noiseBand(seed + 1, n(0.3), { f0: 2600 * p, f1: 1500, q: 0.8, attack: 0.004, dur: 0.28, peak: 0.6 });
      const drops = ticks(seed + 2, n(0.5), { count: 7, t0: 0.08, t1: 0.45, density: 1.2, fLo: 1800, fHi: 4200, dLo: 0.006, dHi: 0.015, pLo: 0.08, pHi: 0.2, fade: 0.5, q: 8 });
      for (let i = 0; i < drops.length; i++) drops[i] *= 1 + 0.5 * Math.sin(6.283 * 40 * i / SR);
      return edges(trim(normalize(mix(len, [plunk, 1], [splash, 1, 0.004], [drops, 1]), 0.8)));
    }
  }
}
/** Material-aware explosion: the v1 blast plus a shock-wave huff, a delayed planet echo and debris chosen by material. */
export function explosionMaterial(seed: number, kind: BlastKind, size: number, material: Material, far = false): Mono {
  const base = explosion(seed, kind, size, far), rng = new Rng(seed ^ 0x9a7), m = Math.max(0.1, Math.min(1, size)), nuke = kind === 'nuclear', pre = nuke ? 0.35 : 0;
  const len = base.length + n(0.6), out = mono(len);
  addInto(out, base, 0);
  // Shock-wave huff: a short pressure front just after the crack.
  if (!far) addInto(out, noiseBand(seed + 31, n(0.14), { color: 'brown', filter: 'lowpass', f0: 260, f1: 55, q: 0.9, attack: 0.004, dur: 0.12, peak: 1.3 * (0.6 + 0.4 * m) }), n(pre + 0.012));
  // Planet echo: the bark returning off the horizon, darkened, at 220 and 480 ms.
  const bark = noiseBand(seed + 32, n(0.25), { f0: 500, f1: 240, q: 1, attack: 0.004, dur: 0.22, peak: 0.8 });
  addInto(out, planetEcho(bark, n(0.9), { t1: 0.22, t2: 0.48, g1: far ? 0.5 : 0.35, g2: far ? 0.4 : 0.22, cut1: 900, cut2: 520 }), n(pre));
  if (!far) {
    const b = pre + 0.25, dens = 0.5 + 0.5 * m;
    switch (material) {
      case 'soil':
        addInto(out, ticks(seed + 41, n(1.7), { count: Math.round(10 + 18 * dens), t0: b, t1: b + 1.3, density: 1.5, fLo: 150, fHi: 420, dLo: 0.03, dHi: 0.08, pLo: 0.3, pHi: 0.7, fade: 0.5, color: 'brown', filter: 'lowpass', q: 0.8 }), 0);
        addInto(out, ticks(seed + 42, n(1.5), { count: Math.round(16 * dens), t0: b, t1: b + 1.1, density: 1.6, fLo: 900, fHi: 3000, dLo: 0.004, dHi: 0.02, pLo: 0.08, pHi: 0.22, fade: 0.6, q: 2.5 }), 0);
        break;
      case 'rock':
        addInto(out, ticks(seed + 43, n(1.8), { count: Math.round(14 + 22 * dens), t0: b, t1: b + 1.4, density: 1.4, fLo: 1100, fHi: 4200, dLo: 0.004, dHi: 0.018, pLo: 0.12, pHi: 0.35, fade: 0.6, q: 3 }), 0);
        addInto(out, ticks(seed + 44, n(2.0), { count: Math.round(3 + 4 * dens), t0: b + 0.1, t1: b + 1.6, density: 1.2, fLo: 120, fHi: 300, dLo: 0.06, dHi: 0.14, pLo: 0.35, pHi: 0.7, fade: 0.4, color: 'brown', filter: 'lowpass', q: 1 }), 0);
        break;
      case 'concrete':
        addInto(out, ticks(seed + 45, n(2.0), { count: Math.round(4 + 6 * dens), t0: b + 0.05, t1: b + 1.5, density: 1.2, fLo: 220, fHi: 600, dLo: 0.04, dHi: 0.1, pLo: 0.35, pHi: 0.75, fade: 0.4, color: 'brown', filter: 'lowpass', q: 1.2 }), 0);
        addInto(out, noiseBand(seed + 46, n(1.6), { color: 'pink', filter: 'lowpass', f0: 2400, f1: 500, q: 0.7, attack: 0.15, dur: 1.5, peak: 0.3 }), n(b));
        addInto(out, ticks(seed + 47, n(1.4), { count: Math.round(10 * dens), t0: b, t1: b + 1.0, density: 1.5, fLo: 700, fHi: 2400, dLo: 0.005, dHi: 0.02, pLo: 0.1, pHi: 0.25, fade: 0.6, q: 2.5 }), 0);
        break;
      case 'metal':
        for (let k = 0; k < Math.round(4 + 6 * dens); k++) addInto(out, partials(n(0.5), rng.range(1400, 4200), [1, 1.9, 3.4], [0.16, 0.08, 0.04], rng.range(0.15, 0.4), { seed: seed + 50 + k }), n(b + rng.range(0, 1.3)));
        addInto(out, ticks(seed + 48, n(1.6), { count: Math.round(12 * dens), t0: b, t1: b + 1.2, density: 1.4, fLo: 2000, fHi: 6000, dLo: 0.003, dHi: 0.012, pLo: 0.1, pHi: 0.3, fade: 0.6, q: 6 }), 0);
        for (let k = 0; k < 3; k++) addInto(out, toneSweep(n(0.3), { f0: rng.range(2600, 4000), f1: rng.range(900, 1500), attack: 0.02, dur: 0.28, peak: 0.1, curve: 0.8 }), n(b + 0.1 + k * rng.range(0.15, 0.4)));
        break;
      case 'water':
        addInto(out, noiseBand(seed + 49, n(1.2), { f0: 3000, f1: 1200, q: 0.8, attack: 0.02, dur: 1.1, peak: 0.5 }), n(pre + 0.03));
        addInto(out, ticks(seed + 51, n(2.2), { count: Math.round(18 * dens), t0: b + 0.3, t1: b + 1.9, density: 1.1, fLo: 1500, fHi: 4000, dLo: 0.006, dHi: 0.016, pLo: 0.08, pHi: 0.22, fade: 0.4, q: 8 }), 0);
        break;
    }
  }
  return edges(trim(normalize(sat(out, 1.15))));
}
/** Secondary pops after a kill: 2-6 s of ammunition cooking off, hull pops, a tearing panel. */
export function wreckPops(seed: number): Mono {
  const rng = new Rng(seed), len = n(5.5), out = mono(len);
  const count = 4 + rng.int(4);
  for (let k = 0; k < count; k++) {
    const at = rng.range(0.1, 4.6), big = rng.next() < 0.35, p = j(rng, 0.1);
    addInto(out, noiseBand(seed + 10 + k, n(0.4), { color: 'brown', filter: 'lowpass', f0: (big ? 700 : 1100) * p, f1: 120, q: 0.8, attack: 0.003, dur: big ? 0.38 : 0.2, peak: big ? 1 : 0.6 }), n(at));
    addInto(out, noiseBand(seed + 30 + k, n(0.06), { f0: 2400 * p, f1: 900, q: 1.2, attack: 0.001, dur: 0.05, peak: big ? 0.8 : 0.5 }), n(at));
    if (big) addInto(out, toneSweep(n(0.3), { f0: 90 * p, f1: 40, attack: 0.004, dur: 0.28, peak: 0.6 }), n(at));
    addInto(out, ticks(seed + 50 + k, n(0.6), { count: 6, t0: 0.05, t1: 0.5, density: 1.4, fLo: 1500, fHi: 5000, dLo: 0.003, dHi: 0.01, pLo: 0.06, pHi: 0.16, fade: 0.6, q: 4 }), n(at));
  }
  addInto(out, tear(seed + 70, n(0.8), 2600 * j(rng, 0.1), 450, 0.7, 0.35, 9, 4), n(rng.range(1.5, 3.5)));
  addInto(out, ticks(seed + 71, len, { count: 30, t0: 0.2, t1: 5.2, fLo: 1500, fHi: 5500, dLo: 0.002, dHi: 0.01, pLo: 0.04, pHi: 0.16, q: 3 }), 0);
  return edges(trim(normalize(sat(out, 1.4), 0.85)));
}
/** The turret ring-out: a big struck-metal ring with a clank, ~2.5 s. */
export function turretRing(seed: number): Mono {
  const rng = new Rng(seed), p = j(rng, 0.06), len = n(2.8);
  const ringOut = partials(n(2.6), 175 * p, METAL, [0.5, 0.32, 0.2, 0.1, 0.05], 2.2, { seed, detune: 0.01 });
  const clank = noiseBand(seed + 1, n(0.05), { f0: 1200 * p, f1: 600, q: 1.4, attack: 0.002, dur: 0.045, peak: 0.9 });
  const thud = toneSweep(n(0.2), { f0: 140 * p, f1: 60, attack: 0.003, dur: 0.18, peak: 0.7 });
  const grind = tear(seed + 2, n(0.6), 900 * p, 500, 0.5, 0.25, 12, 3);
  return edges(trim(normalize(tube(mix(len, [clank, 1], [thud, 1], [ringOut, 1, 0.004], [grind, 1, 0.08]), 1.5))));
}
/** Ear ring after the biggest near blasts: a 3 kHz tone fading over 1.4 s with a thin hiss, played non-spatially. */
export function earRing(seed: number): Mono {
  const len = n(1.5), tone = toneSweep(n(1.45), { f0: 3050, f1: 2950, attack: 0.02, dur: 1.4, peak: 0.5 });
  const hiss = noiseBand(seed, n(1.3), { f0: 6000, q: 0.5, filter: 'highpass', attack: 0.02, dur: 1.2, peak: 0.08 });
  return edges(trim(normalize(mix(len, [tone, 1], [hiss, 1]), 0.6)));
}
