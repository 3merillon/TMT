import type { V3 } from '../contracts';

export interface DebrisBody {
  position: V3; velocity: V3; radius: number; age: number; bounces: number; sleeping: boolean;
  /** Density relative to water (ice < 1, rock > 1). */
  density?: number; impactSpeed?: number;
}
export interface DebrisWater { surface: number; water: number; velocity?: V3; submergedFraction?: number }

/** Archimedes' force for a sphere's submerged cap, with implicit fluid drag. Updates b.velocity in place;
 * `submerged` overrides water.submergedFraction. */
export function buoyDebris(b: DebrisBody, water: DebrisWater, dt: number, submerged = water.submergedFraction): void {
  if (!(water.water > 0.005) || !(water.surface > 0)) return;
  const p = b.position, distance = Math.hypot(p[0], p[1], p[2]);
  const h = Math.max(0, Math.min(2, (water.surface - distance + b.radius) / b.radius));
  const fraction = submerged ?? h * h * (3 - h) / 4;
  if (!fraction) return;
  const density = b.density ?? 2.5;
  if (density < 1 || !b.sleeping) {
    b.sleeping = false;
    const flow = water.velocity, fx = flow ? flow[0] : 0, fy = flow ? flow[1] : 0, fz = flow ? flow[2] : 0;
    const inverse = 1 / distance, up = distance > 1e-10, lift = 9.8 * fraction / density * dt, v = b.velocity;
    const dx = v[0] + (up ? p[0] * inverse : 0) * lift - fx, dy = v[1] + (up ? p[1] * inverse : 1) * lift - fy, dz = v[2] + (up ? p[2] * inverse : 0) * lift - fz;
    const drag = 1 / (1 + dt * fraction * (3 + Math.hypot(dx, dy, dz)) / density);
    v[0] = fx + dx * drag; v[1] = fy + dy * drag; v[2] = fz + dz * drag;
  }
}
