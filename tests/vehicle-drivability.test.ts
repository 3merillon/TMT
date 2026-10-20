/** Drivability targets: the scenarios in tests/helpers/vehicle-world.ts
 * on the real resident chassis. Loadouts are legacy-mapped kits; every dimension comes from the kit assembly.
 *
 * Before W1-PHY (recorded as it.fails in ed175fa), scout/mortar/light | grip/cannon/heavy measured: launch pitch 12.7° | 8.9°,
 * brake pitch 15.7° | 9.1°; the 42° ramp flipped both; 6 and 8 u/s side slides flipped both (5 u/s: 44° roll); parked
 * tip at 45°; pivot 0.99 | 0.89 rad/s; full-throttle turn 0.80 | 0.46 rad/s. */
import { describe, expect, it } from 'vitest';
import { blast, crossSlopeTip, DEFAULT, drivingTurn, HEAVY, launchAndBrake, LEGACY_LOADOUTS, loadoutName, pivot, rampClimb, sideSlide } from './helpers/vehicle-world';

describe('launch, brake and climbing', () => {
  for (const loadout of LEGACY_LOADOUTS) {
    const name = loadoutName(loadout);
    it(`${name}: launch and brake pitch < 5°`, async () => {
      const r = await launchAndBrake(loadout);
      expect(r.launchPitch, JSON.stringify(r)).toBeLessThan(5);
      expect(r.brakePitch, JSON.stringify(r)).toBeLessThan(5);
      expect(r.t90, JSON.stringify(r)).toBeLessThan(1.2); // still a responsive launch
    });
    for (const angle of [32, 42]) it(`${name}: climbs a ${angle}° ramp without flipping`, async () => {
      const r = await rampClimb(loadout, angle);
      expect(r.flipped, JSON.stringify(r)).toBe(false);
      expect(r.topAt, JSON.stringify(r)).toBeLessThan(7);
    });
  }
});

describe('rollover resistance', () => {
  for (const loadout of LEGACY_LOADOUTS) {
    const name = loadoutName(loadout);
    for (const speed of [5, 6, 8]) it(`${name}: a ${speed} u/s side slide rolls < 15°`, async () => {
      const r = await sideSlide(loadout, speed);
      expect(r.maxRoll, JSON.stringify(r)).toBeLessThan(15);
      expect(r.upDot, JSON.stringify(r)).toBeGreaterThan(.99);
    });
    it(`${name}: parked cross-slope tip angle > 60°`, async () => {
      expect(await crossSlopeTip(loadout, 45)).toBeGreaterThan(60);
    }, 60000);
    it(`${name}: the standard blast impulse (25 per unit mass) rolls < 10°`, async () => {
      const r = await blast(loadout);
      expect(r.maxRoll, JSON.stringify(r)).toBeLessThan(10);
      expect(r.upDot, JSON.stringify(r)).toBeGreaterThan(.99);
    });
  }
});

describe('steering', () => {
  for (const loadout of LEGACY_LOADOUTS) {
    const name = loadoutName(loadout);
    it(`${name}: neutral pivot ≥ 1.5 rad/s, right steer turns clockwise`, async () => {
      const right = await pivot(loadout, 1), left = await pivot(loadout, -1);
      expect(-right.yawRate, JSON.stringify(right)).toBeGreaterThanOrEqual(1.5);
      expect(left.yawRate, JSON.stringify(left)).toBeGreaterThanOrEqual(1.5);
    });
  }
  for (const loadout of [DEFAULT, HEAVY]) {
    const name = loadoutName(loadout);
    it(`${name}: full-throttle turn ≥ 1 rad/s without tipping`, async () => {
      const r = await drivingTurn(loadout);
      expect(-r.yawRate, JSON.stringify(r)).toBeGreaterThanOrEqual(1);
      expect(r.maxRoll, JSON.stringify(r)).toBeLessThan(10);
    });
  }
});
