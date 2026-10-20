import { munitionSpeed, type MunitionId, type MunitionSource } from '../../munitions';

/** At fixed elevation, range is approximately proportional to launch speed squared. Change that quantity, then
 * invert the actual weapon/ammo speed function, keeping small wheel gestures equally useful across the power range.
 * Terrain, radial gravity and wind still determine the preview's actual endpoint; this is not an exact range solver. */
export function rangeAdjustedPower(source: MunitionSource, power: number, rangeScale: number, munition: MunitionId = 'explosive'): number {
  const current = Number.isFinite(power) ? Math.max(0, Math.min(1, power)) : 0;
  if (!Number.isFinite(rangeScale) || rangeScale <= 0 || rangeScale === 1) return current;
  const minimum = munitionSpeed(source, 0, munition), maximum = munitionSpeed(source, 1, munition);
  const target = munitionSpeed(source, current, munition) * Math.sqrt(rangeScale);
  if (target <= minimum) return 0;
  if (target >= maximum) return 1;
  // Fixed work, no world traces and no duplicated launch-speed curve. Resolves power to better than 0.00001%.
  let low = 0, high = 1;
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) * 0.5;
    if (munitionSpeed(source, middle, munition) < target) low = middle; else high = middle;
  }
  return (low + high) * 0.5;
}
