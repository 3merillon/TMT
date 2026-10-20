/** Deterministic standing-water ballistics. Mirrored in rust/terrain-core/src/projectile_water.rs. */
import type { V3 } from '../contracts';
import type { BasinSolution } from '../../world/basins';
import { cellOfDir, cubeGrid } from '../../world/cube-grid';

export interface ProjectileWater { readonly n: number; readonly levels: Float64Array; readonly maxLevel: number }
/** Effective Cd * density * area / (2 * mass), in inverse world units. Compact shells
 * retain exp(-k * distance) of their speed; gravity then bends the slowed flight down. */
export const PROJECTILE_WATER_DRAG = 1.2;
export function projectileWater(solution?: BasinSolution): ProjectileWater | undefined {
  if (!solution) return undefined;
  const { n, labels, basins } = solution, grid = cubeGrid(n), levels = new Float64Array(labels.length);
  let maxLevel = 0;
  for (let c = 0; c < labels.length; c++) {
    let label = labels[c];
    // Match GameLiquids.sample's shoreline extension and material precedence.
    if (!label) for (let i = 0; i < 4; i++) { label = labels[grid.neighbours[c * 4 + i]]; if (label) break; }
    const basin = label ? basins[label - 1] : undefined;
    if (basin?.material === 'water') { levels[c] = basin.level; maxLevel = Math.max(maxLevel, basin.level); }
  }
  return maxLevel > 0 ? { n, levels, maxLevel } : undefined;
}
export function inProjectileWater(p: V3, water?: ProjectileWater): boolean {
  return !!water && Math.hypot(...p) < water.levels[cellOfDir(water.n, p)];
}

/** Forces have already been applied for this tick. Integrate quadratic drag exactly
 * along the resulting direction, splitting at spherical water surfaces. Short spatial
 * slices resolve basin edges; the sphere intersection also catches shallow grazing entry.
 * Dry flights retain the historical arithmetic exactly. */
export function advanceThroughWater(p: V3, velocity: V3, dt: number, water: ProjectileWater): { position: V3; velocity: V3 } | null {
  let speed = Math.hypot(...velocity);
  if (speed < 1e-10) return null;
  const direction = velocity.map(v => v / speed) as V3, distance = speed * dt;
  const along = p[0] * direction[0] + p[1] * direction[1] + p[2] * direction[2];
  const nearest = Math.max(0, Math.min(distance, -along));
  if (Math.hypot(p[0] + direction[0] * nearest, p[1] + direction[1] * nearest, p[2] + direction[2] * nearest) >= water.maxLevel) return null;
  const steps = Math.max(1, Math.min(128, Math.ceil(distance / .05))), h = dt / steps;
  let travelled = 0, wet = false;
  for (let i = 0; i < steps; i++) {
    const start = p.map((v, k) => v + direction[k] * travelled) as V3;
    const midpoint = start.map((v, k) => v + direction[k] * speed * h * .5) as V3;
    const level = water.levels[cellOfDir(water.n, midpoint)];
    const b = start[0] * direction[0] + start[1] * direction[1] + start[2] * direction[2];
    const discriminant = b * b - (start[0] ** 2 + start[1] ** 2 + start[2] ** 2 - level * level);
    if (level <= 0 || discriminant <= 0) { travelled += speed * h; continue; }
    const root = Math.sqrt(discriminant), entry = Math.max(0, -b - root), exit = -b + root;
    if (exit <= 0 || entry >= speed * h) { travelled += speed * h; continue; }
    const remaining = h - entry / speed, k = PROJECTILE_WATER_DRAG;
    const waterTime = Math.min(remaining, Math.expm1(k * Math.min(exit - entry, speed * remaining)) / (k * speed));
    travelled += entry + Math.log1p(k * speed * waterTime) / k;
    speed /= 1 + k * speed * waterTime;
    travelled += speed * (remaining - waterTime); wet = true;
  }
  return wet ? { position: p.map((v, k) => v + direction[k] * travelled) as V3, velocity: direction.map(v => v * speed) as V3 } : null;
}
