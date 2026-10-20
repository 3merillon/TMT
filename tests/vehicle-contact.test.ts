/** Rigid contact on the Rapier chassis (W1-PHY re-covers what the legacy kinematic pair/wall suites asserted, which
 * W1-GAME deletes): wall pressure never climbs, tunnels or flips; a tank pushes another, pins it against a wall without
 * pushing it through, and can always reverse free; ramming keeps both tanks planted; steering while pressed nose to
 * nose turns away from the other tank.
 *
 * Before the tank-contact model (TANK_CONTACT in src/game/vehicle/tuning.ts), ramming at top speed on flat ground reared
 * both tanks into an A-frame: rammer / target peak pitch 28.5° / 28.6° (scout into scout), 25.8° / 25.2°, 20.9° / 22.1°
 * and 21.4° / 21.8°; and full throttle with full steer while pressed nose to nose turned the pair together, as one
 * body, by only 0.31–0.55 rad in 2 s. */
import { describe, expect, it } from 'vitest';
import { DEFAULT, HEAVY, loadoutName, pushContest, pushTurn, ram, wallPress } from './helpers/vehicle-world';

describe('wall pressure', () => {
  for (const loadout of [DEFAULT, HEAVY]) it(`${loadoutName(loadout)}: full throttle into a vertical wall stays planted and outside it`, async () => {
    const r = await wallPress(loadout);
    expect(r.maxPitch, JSON.stringify(r)).toBeLessThan(15);
    expect(r.minUp, JSON.stringify(r)).toBeGreaterThan(.95);
    expect(r.penetration, JSON.stringify(r)).toBeLessThan(.02);
    expect(r.reached, JSON.stringify(r)).toBeLessThan(3); // the root never gets to the wall face
    expect(r.finalUpDot, JSON.stringify(r)).toBeGreaterThan(.99);
    expect(r.finalSpeed, JSON.stringify(r)).toBeLessThan(.05);
  });
});

describe('pushing', () => {
  for (const [pusher, pushed] of [[DEFAULT, DEFAULT], [DEFAULT, HEAVY], [HEAVY, DEFAULT]]) {
    it(`${loadoutName(pusher)} pushes an idle ${loadoutName(pushed)} and reverses free`, async () => {
      const r = await pushContest(pusher, pushed);
      expect(r.pushedMoved, JSON.stringify(r)).toBeGreaterThan(.15);
      expect(r.minUp, JSON.stringify(r)).toBeGreaterThan(.5);
      expect(r.reversed, JSON.stringify(r)).toBeGreaterThan(1);
    });
  }
  it('pins a tank against a wall without pushing it into the wall, then reverses free', async () => {
    const r = await pushContest(HEAVY, DEFAULT, { wallAt: 4.6 });
    expect(r.intoWall, JSON.stringify(r)).toBeLessThan(.02);
    expect(r.pushedMoved, JSON.stringify(r)).toBeGreaterThan(.15);
    expect(r.minUp, JSON.stringify(r)).toBeGreaterThan(.5);
    expect(r.reversed, JSON.stringify(r)).toBeGreaterThan(1);
  });
});

const PAIRS = [[DEFAULT, DEFAULT], [DEFAULT, HEAVY], [HEAVY, DEFAULT], [HEAVY, HEAVY]] as const;
describe('ramming', () => {
  // Measured 2.3–8.0° (rammer) and 2.2–7.2° (target); the drive capture budget allows 25°.
  for (const [rammer, target] of PAIRS) {
    it(`${loadoutName(rammer)} ramming ${loadoutName(target)} at full speed keeps both tanks planted (pitch < 12°)`, async () => {
      const r = await ram(rammer, target);
      expect(r.perched, JSON.stringify(r)).toBe(false);
      expect(r.maxPitch, JSON.stringify(r)).toBeLessThan(12);
      expect(r.targetPitch, JSON.stringify(r)).toBeLessThan(12);
      expect(r.minUp, JSON.stringify(r)).toBeGreaterThan(.97);
      expect(Math.min(...r.finalUp), JSON.stringify(r)).toBeGreaterThan(.99);
    });
  }
});

describe('steering against another tank', () => {
  // Measured 1.24–2.15 rad for the rammer and at most 0.47 rad for the target.
  for (const [rammer, target] of PAIRS) for (const steer of [-1, 1]) {
    it(`${loadoutName(rammer)} pressed nose to nose against ${loadoutName(target)} turns ${steer < 0 ? 'left' : 'right'} away from it (≥ 1 rad in 2 s)`, async () => {
      const r = await pushTurn(rammer, target, steer);
      expect(r.pressed, JSON.stringify(r)).toBeLessThan(2.3); // the turn starts in contact
      expect(-Math.sign(steer) * r.turned, JSON.stringify(r)).toBeGreaterThanOrEqual(1);
      expect(Math.abs(r.targetTurned), JSON.stringify(r)).toBeLessThan(.7); // the pair no longer spins as one body
      expect(Math.max(r.maxPitch, r.targetPitch), JSON.stringify(r)).toBeLessThan(12);
      expect(r.minUp, JSON.stringify(r)).toBeGreaterThan(.97);
    });
  }
});
