/** One ballistic integrator for live shots, previews and AI searches (plan §3: preview, AI and live shots share it).
 * Radial gravity × the level's gravityScale plus the match wind × the munition's windFactor. Pure. */
import type { ProjectileState, V3 } from '../contracts';
import { normalize } from '../math';
import { windAcceleration, type WindState } from '../../world/weather';

/** The fixed simulation tick (60 Hz). */
export const FIXED_DT = 1 / 60;

export interface BallisticEnv {
  /** Radial gravity in u/s² (GRAVITY_BALLISTIC × rules.gravityScale). */
  readonly gravity: number;
  /** The match wind at a tick, or null for still air. */
  readonly wind: ((tick: number) => WindState) | null;
  /** The shell's wind drift multiplier (munitions.windFactor). */
  readonly windFactor: number;
}

/** The fixed tick in which a projectile's next integration step runs: launched between ticks at `launchTick`, its
 * first step runs in launchTick + 1. */
export function stepTick(projectile: Pick<ProjectileState, 'launchTick' | 'age'>, dt = FIXED_DT): number {
  return (projectile.launchTick ?? 0) + 1 + Math.round(projectile.age / dt);
}

/** A shell in flight as mutable numbers: one object per trace instead of one projectile per step. `position` is
 * replaced (never written) by each step, so callers may keep the arrays. */
export interface Flight { position: V3; vx: number; vy: number; vz: number; age: number; launchTick?: number }

/** Semi-implicit Euler in place: velocity first, then position (the historical operation order, bit for bit when still). */
export function advanceFlight(flight: Flight, env: BallisticEnv, dt = FIXED_DT): void {
  // normalize(position) inline: the same hypot, reciprocal and [0, 1, 0] fallback.
  const p = flight.position, length = Math.hypot(p[0], p[1], p[2]), g = -env.gravity * dt;
  let nx = 0, ny = 1, nz = 0;
  if (length > 1e-10) { const s = 1 / length; nx = p[0] * s; ny = p[1] * s; nz = p[2] * s; }
  let vx = flight.vx + nx * g, vy = flight.vy + ny * g, vz = flight.vz + nz * g;
  if (env.wind && env.windFactor !== 0) {
    const wind = env.wind(stepTick(flight, dt));
    if (wind.strength !== 0) { const a = windAcceleration(wind, p), k = env.windFactor * dt; vx = vx + a[0] * k; vy = vy + a[1] * k; vz = vz + a[2] * k; }
  }
  flight.vx = vx; flight.vy = vy; flight.vz = vz;
  flight.position = [p[0] + vx * dt, p[1] + vy * dt, p[2] + vz * dt];
  flight.age = flight.age + dt;
}

export function integrateProjectile(projectile: ProjectileState, env: BallisticEnv, dt = FIXED_DT): ProjectileState {
  const flight: Flight = { position: projectile.position, vx: projectile.velocity[0], vy: projectile.velocity[1], vz: projectile.velocity[2], age: projectile.age, launchTick: projectile.launchTick };
  advanceFlight(flight, env, dt);
  return { ...projectile, velocity: [flight.vx, flight.vy, flight.vz], position: flight.position, age: flight.age };
}

/** Flight statistics of a finished shot (ImpactEvent.flight). */
export function flightStats(origin: V3, impact: V3, ticks: number, peakAltitude: number, radius: number) {
  const a = normalize(origin), b = normalize(impact);
  const centralAngle = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  return { ticks, centralAngle, peakAltitude, distance: centralAngle * radius, ricochets: 0, skips: 0 };
}
