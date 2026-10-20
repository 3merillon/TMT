import { describe, expect, it } from 'vitest';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';
import { DEFAULT_LOADOUT } from '../src/game/modules';
import { munitionSpeed, type MunitionId } from '../src/game/munitions';
import { wheelRangeScale } from '../src/game/ui/input/mouse';
import { rangeAdjustedPower } from '../src/game/ui/input/range-power';

const kits = (['mortar', 'cannon', 'rail'] as const).map(barrel => assembleKit(kitLoadoutFromLegacy({ ...DEFAULT_LOADOUT, barrel })));
const munitions: MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];
const wheel = (deltaY: number) => wheelRangeScale({ deltaY, deltaMode: 0 }, 800);

describe('range-scaled launch power', () => {
  it('gives the same small proportional range change at low, middle and high power for every weapon and ammo', () => {
    for (const kit of kits) for (const munition of munitions) for (const power of [0.1, 0.5, 0.85]) {
      const next = rangeAdjustedPower(kit, power, wheel(-100), munition);
      const beforeSpeed = munitionSpeed(kit, power, munition), afterSpeed = munitionSpeed(kit, next, munition);
      expect(next).toBeGreaterThan(power);
      expect(afterSpeed ** 2 / beforeSpeed ** 2).toBeCloseTo(Math.exp(0.05), 6);
      expect(next - power).toBeLessThan(0.03);
    }
  });

  it('reverses an opposite wheel gesture and gives the same result for split trackpad deltas', () => {
    for (const kit of kits) for (const munition of munitions) for (const power of [0.1, 0.5, 0.85]) {
      const forward = rangeAdjustedPower(kit, power, wheel(-100), munition);
      expect(rangeAdjustedPower(kit, forward, wheel(100), munition)).toBeCloseTo(power, 6);
      const half = rangeAdjustedPower(kit, power, wheel(-50), munition);
      expect(rangeAdjustedPower(kit, half, wheel(-50), munition)).toBeCloseTo(forward, 6);
    }
  });

  it('reaches and leaves both weapon limits and ignores invalid or neutral scale values', () => {
    for (const kit of kits) for (const munition of munitions) {
      expect(rangeAdjustedPower(kit, 0.5, 1000, munition)).toBe(1);
      expect(rangeAdjustedPower(kit, 0.5, 0.0001, munition)).toBe(0);
      expect(rangeAdjustedPower(kit, 1, wheel(-100), munition)).toBe(1);
      expect(rangeAdjustedPower(kit, 0, wheel(100), munition)).toBe(0);
      expect(rangeAdjustedPower(kit, 1, wheel(100), munition)).toBeLessThan(1);
      expect(rangeAdjustedPower(kit, 0, wheel(-100), munition)).toBeGreaterThan(0);
      for (const scale of [Number.NaN, Infinity, 0, -1, 1]) expect(rangeAdjustedPower(kit, 0.5, scale, munition)).toBe(0.5);
    }
  });
});
