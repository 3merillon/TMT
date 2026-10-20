// Ported from Pinionfall src/weather/body-weather.ts (MIT, same owner)
/**
 * Match wind (Experience §1.10, plan §3): a pure function of (seed, tick) and the level's wind rule, so previews, AI
 * searches and live shots see the same air, replays reproduce it and nothing integrates. Pinionfall's seeded value-noise
 * FBM channels are kept verbatim; its coverage/storm/rain channels are not ported (no clouds or rain in TMT yet).
 *
 * The wind is a tangent acceleration field: solid rotation about an axis that wanders slowly with the heading channel,
 * `a(p) = strength · (axis × p̂)`, strongest on the rotation's equator (where the default arena sits) and calm at its two
 * poles (a smooth tangent field on a sphere must vanish somewhere). TMT units: u/s² at the surface; 1 bar = 0.24 u/s²,
 * so 5 bars = 1.2 u/s² (12% of g). World layer: pure, no game or engine imports.
 */
import type { Vec3 } from '../core/types';

/** Structurally equal to api/match WindRule: mean and gust amplitude in bars (0–5), gust period in seconds. */
export interface WindRuleLike { readonly mean: number; readonly gust: number; readonly period: number }
export interface WindState {
  readonly tick: number;
  /** Tangent acceleration at the rotation's equator, u/s². */
  readonly strength: number;
  /** Bars (strength / WIND_ACCEL_PER_BAR), for the HUD wind sock. */
  readonly bars: number;
  /** Heading of the wind at the +Y pole, radians from +Z towards +X. */
  readonly heading: number;
  /** Unit rotation axis of the field. */
  readonly axis: Vec3;
}
export const WIND_ACCEL_PER_BAR = 0.24;
export const WIND_MAX_BARS = 5;
export const WIND_TICK_SECONDS = 1 / 60;

/** Integer-lattice hash → [-1, 1] (Math.imul chain — deterministic everywhere). */
function hash1(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 0x9E3779B1 | 0)) | 0;
  h = Math.imul(h ^ (h >> 13), 1274126177);
  h = h ^ (h >> 16);
  return ((h >>> 0) & 0x7fffffff) / 0x3fffffff - 1;
}

/** Smooth 1D value noise over t (cubic-eased lattice interpolation), [-1, 1]. */
function smooth1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u;
}

/** 3-octave FBM of smooth1, normalized to [-1, 1]. */
export function fbm1(t: number, seed: number): number {
  return (smooth1(t, seed) * 0.6
    + smooth1(t * 2.7, (seed ^ 0x5b5b) | 0) * 0.28
    + smooth1(t * 6.1, (seed ^ 0xa7a7) | 0) * 0.12);
}

/** The wind at a fixed tick. Gusts follow the Pinionfall wind channel at the rule's period; the heading keeps a
 * seed-fixed prevailing direction and wanders ±0.6 rad on a six-times-slower channel. */
export function sampleWind(seed: number, tick: number, rule: WindRuleLike): WindState {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new Error(`Wind tick must be a non-negative integer, got ${tick}`);
  if (!(rule.mean >= 0) || !(rule.gust >= 0) || !(rule.period > 0)) throw new Error(`Invalid wind rule ${JSON.stringify(rule)}`);
  const t = tick * WIND_TICK_SECONDS, base = t / rule.period;
  const bars = Math.min(WIND_MAX_BARS, Math.max(0, rule.mean + rule.gust * fbm1(base * 1.7 + 41.3, (seed ^ 0x71bd) | 0)));
  const prevailing = (hash1(0x5eed, seed | 0) + 1) * Math.PI;
  const heading = prevailing + 0.6 * fbm1(base / 6 + 7.9, (seed ^ 0xd1a0) | 0);
  // axis × (+Y) = (sin h, 0, cos h): the wind at the +Y pole blows along the heading.
  const axis: Vec3 = [Math.cos(heading), 0, -Math.sin(heading)];
  return { tick, strength: bars * WIND_ACCEL_PER_BAR, bars, heading, axis };
}

/** The wind's tangent acceleration at a world position (planet centred on the origin). */
export function windAcceleration(state: WindState, position: Vec3): Vec3 {
  const length = Math.hypot(position[0], position[1], position[2]);
  if (!(length > 1e-9) || state.strength === 0) return [0, 0, 0];
  const [x, y, z] = [position[0] / length, position[1] / length, position[2] / length], a = state.axis, s = state.strength;
  return [(a[1] * z - a[2] * y) * s, (a[2] * x - a[0] * z) * s, (a[0] * y - a[1] * x) * s];
}
