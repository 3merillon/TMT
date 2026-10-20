/**
 * Presentation wind (scene facet `wind`, written by the engine every frame from FrameInput.wind): ONE air field that the
 * clouds, the grass, the water, the spray and the smoke all read, so what moves on screen is the match wind that bends
 * the shells. The field is the gameplay wind's own shape (world/weather.ts): solid rotation about `axis`, so the air
 * velocity at p is `speed · (axis × p̂)` (strongest on the rotation's equator, calm at its poles). Without a match wind a
 * gentle seeded breeze keeps the world alive (the HUD and the shots still see still air).
 *
 * Speeds are visual air speeds in u/s near the ground; the clouds ride a faster wind aloft (`aloft`).
 */
import type { Vec3 } from '../contracts';
import { makeModule } from '../wgsl/module';
import { sampleWind } from '../../world/weather';

export interface WindFacet {
  /** Unit rotation axis of the air field (world/weather.ts WindState.axis). */
  axis: Vec3;
  /** Gameplay wind in bars (gusts included), or the breeze's when the match has no wind. */
  bars: number;
  /** Air speed near the ground on the rotation's equator, u/s. */
  speed: number;
  /** Air speed at the cloud deck, u/s. */
  aloft: number;
}
declare module '../contracts' { interface SceneFacets { wind: WindFacet } }

export const WIND_VISUAL = {
  /** Ground air speed per bar (u/s): 5 bars, a gale, is about a tank length per second. */
  perBar: 0.22,
  /** The breeze when the match has no wind: bars, gust amplitude, gust period (s). */
  breeze: { mean: 0.7, gust: 0.35, period: 22 },
  /** Wind aloft: a multiple of the ground speed plus a floor, so the clouds always drift. */
  aloftGain: 2.4,
  aloftFloor: 0.08,
} as const;

/** The facet for a gameplay wind (bars) or, when `bars` is null, the seeded breeze at `time`. */
export function windFacet(axis: Vec3 | null, bars: number | null, seed: number, time: number): WindFacet {
  let a = axis, b = bars;
  if (!a || b === null) {
    const breeze = sampleWind(seed >>> 0, Math.max(0, Math.floor(time * 60)), WIND_VISUAL.breeze);
    a = breeze.axis; b = breeze.bars;
  }
  const speed = Math.max(0, b) * WIND_VISUAL.perBar;
  return { axis: a, bars: b, speed, aloft: speed * WIND_VISUAL.aloftGain + WIND_VISUAL.aloftFloor };
}

/** Air velocity (u/s) at p for a facet and a speed (ground or aloft). */
export function windVelocity(w: Pick<WindFacet, 'axis'>, speed: number, p: readonly number[]): Vec3 {
  const l = Math.hypot(p[0], p[1], p[2]) || 1, x = p[0] / l, y = p[1] / l, z = p[2] / l, a = w.axis;
  return [(a[1] * z - a[2] * y) * speed, (a[2] * x - a[0] * z) * speed, (a[0] * y - a[1] * x) * speed];
}

/** WGSL mirror: `wind` is (axis xyz, speed). */
export const windWgsl = makeModule('wind', /* wgsl */ `
fn wind_velocity(wind: vec4f, p: vec3f) -> vec3f { return cross(wind.xyz, p / max(length(p), 1e-6)) * wind.w; }
`);

// ───────────────────────────── Drift rotations (clouds aloft, ripples): world = R · drifted ─────────────────────────────
export type Quat = [number, number, number, number];
export const quatIdentity = (): Quat => [0, 0, 0, 1];
export function quatMul(a: readonly number[], b: readonly number[]): Quat {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
export function quatAxisAngle(axis: readonly number[], angle: number): Quat {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1, s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}
export function quatNormalize(q: readonly number[]): Quat { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
/** R · v. */
export function quatRotate(q: readonly number[], v: readonly number[]): Vec3 {
  const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
  return [v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1], v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2], v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]];
}
export const quatConjugate = (q: readonly number[]): Quat => [-q[0], -q[1], -q[2], q[3]];
