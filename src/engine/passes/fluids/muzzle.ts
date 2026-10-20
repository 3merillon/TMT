import type { QualityTier, Vec3 } from '../../contracts';

/** Immutable shot presentation data. No selected weapon or ammunition is read after emission. */
export interface MuzzleEmission {
  position: readonly number[];
  direction: readonly number[];
  up?: readonly number[];
  munition: 'explosive' | 'heavy' | 'incendiary' | 'nuclear';
  weapon: 'mortar' | 'cannon' | 'rail';
  seed?: number;
}

/** Separate atlas: muzzle firing can never evict a blast or mushroom cloud. */
export const MUZZLE_GAS_TIERS: Readonly<Record<QualityTier, { n: number; iterations: number; slots: number }>> = {
  low: { n: 16, iterations: 4, slots: 2 },
  medium: { n: 20, iterations: 6, slots: 2 },
  high: { n: 24, iterations: 8, slots: 3 },
  ultra: { n: 24, iterations: 8, slots: 4 },
};

export const MUZZLE_SMOKE = {
  explosive: { edge: 3.4, radius: 0.075, lifetime: 2.2, smoke: 25, albedo: .40, heat: .20, momentum: 8.5, spread: 1.4 },
  heavy: { edge: 4.5, radius: 0.092, lifetime: 2.8, smoke: 35, albedo: .32, heat: .24, momentum: 10, spread: 2 },
  incendiary: { edge: 3.8, radius: 0.082, lifetime: 2.6, smoke: 30, albedo: .21, heat: .48, momentum: 8.2, spread: 1.7 },
  nuclear: { edge: 5.1, radius: 0.10, lifetime: 3.0, smoke: 40, albedo: .46, heat: .30, momentum: 10.5, spread: 2.2 },
} as const;

export const MUZZLE_WEAPON = {
  mortar: { edge: .86, radius: 1.2, smoke: 1.15, momentum: .65, spread: 1.5, duration: .19 },
  cannon: { edge: 1, radius: 1, smoke: 1, momentum: 1, spread: 1, duration: .16 },
  rail: { edge: .9, radius: .75, smoke: .35, momentum: 1.65, spread: .45, duration: .10 },
} as const;

/** Atlas texture storage only; all nine simulation textures are allocated once per tier, at 56 bytes/cell. */
export function muzzleGasAtlasBytes(tier: QualityTier): number {
  const t = MUZZLE_GAS_TIERS[tier];
  return t.n ** 3 * t.slots * 56;
}

export function muzzleUnit(v: readonly number[], fallback: Vec3 = [0, 1, 0]): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return Number.isFinite(length) && length > 1e-6 ? [v[0] / length, v[1] / length, v[2] / length] : [...fallback];
}

export function validMuzzleEmission(emission: MuzzleEmission): boolean {
  return emission.position.length >= 3 && emission.position.slice(0, 3).every(Number.isFinite)
    && emission.direction.length >= 3 && emission.direction.slice(0, 3).every(Number.isFinite)
    && Math.hypot(...emission.direction.slice(0, 3)) > 1e-6
    && Object.hasOwn(MUZZLE_SMOKE, emission.munition) && Object.hasOwn(MUZZLE_WEAPON, emission.weapon);
}
