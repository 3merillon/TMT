// @contract v1 — docs/architecture.md#contracts-and-invariants
/** Lifted-centre crater (plan §4.3, impact step): the cut sphere is 1.3× the blast radius and its centre is
 * lifted along the surface normal by 0.55 of that radius, so craters open towards the shooter's side of the
 * surface instead of burying half of the sphere. Pure and deterministic; invalid input throws (I3). */
import type { V3 } from '../contracts';
import { MAX_TERRAIN_BLAST_RADIUS, MIN_TERRAIN_BLAST_RADIUS } from '../terrain-config';

export const CRATER_RADIUS_SCALE = 1.3;
export const CRATER_CENTER_LIFT = 0.55;

export function craterProfile(hit: V3, normal: V3, radius: number): { center: V3; radius: number } {
  if (!Number.isFinite(radius) || radius <= 0) throw new Error(`Crater blast radius ${radius} is not a finite positive number`);
  // Narrow-blast weapons (the scout autocannon) still cut the smallest crater the terrain supports; their damage radius
  // stays their own.
  const lifted = CRATER_RADIUS_SCALE * Math.max(radius, MIN_TERRAIN_BLAST_RADIUS);
  if (lifted > MAX_TERRAIN_BLAST_RADIUS)
    throw new Error(`Crater radius ${lifted} (1.3 × ${radius}) exceeds the maximum terrain blast radius ${MAX_TERRAIN_BLAST_RADIUS}`);
  if (hit.length !== 3 || !hit.every(Number.isFinite)) throw new Error(`Crater hit point ${JSON.stringify(hit)} is not a finite vector`);
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (normal.length !== 3 || !Number.isFinite(length) || length < 1e-9) throw new Error(`Crater normal ${JSON.stringify(normal)} is not a finite non-zero vector`);
  const lift = CRATER_CENTER_LIFT * lifted / length;
  return { center: [hit[0] + normal[0] * lift, hit[1] + normal[1] * lift, hit[2] + normal[2] * lift], radius: lifted };
}
