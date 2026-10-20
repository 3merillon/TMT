import { describe, expect, it } from 'vitest';
import { assembleKit, type KitLoadout } from '../src/game/kit';
import { INSTANCED_GROUPS } from '../src/game/kit/parts/types';
import { restState } from '../src/game/kit/rig';
import { PosedKit, sweepGunHull } from '../src/game/kit/validate';

const DEG = Math.PI / 180;
const pair = (o: { a: string; b: string }) => [o.a, o.b].sort().join('|');

describe('gun sweep conservative bounds', () => {
  it('retains every exact collision when lower pitch limits deliberately allow hull intersections', () => {
    const loadouts: KitLoadout[] = [
      { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' },
      { hull: 'skiff', runningGear: 'scout', turret: 'wedge', weapon: 'cannon', utility: 'antenna' },
      { hull: 'bastion', runningGear: 'grip', turret: 'wedge', weapon: 'rail', utility: 'antenna' },
    ];
    let collisions = 0;
    for (const loadout of loadouts) {
      const a = { ...assembleKit(loadout), pitchLimits: () => ({ min: -30 * DEG, max: 30 * DEG }) };
      const posed = new PosedKit(a), rest = restState(posed.ctx), expected = new Set<string>();
      let states = 0;
      // Independent exact queries visit every original sample, with no angular
      // interval or capsule proof. Include both recoil endpoints at every pose.
      for (let yaw = 0; yaw < 2 * Math.PI - 1e-9; yaw += 45 * DEG) {
        const pitches: number[] = [];
        for (let pitch = -30 * DEG; pitch < 30 * DEG - 1e-9; pitch += 5 * DEG) pitches.push(pitch);
        pitches.push(30 * DEG);
        for (const pitch of pitches) for (const recoil of [0, 1]) {
          for (const overlap of posed.place({ ...rest, yaw, pitch, recoil }).overlaps('', ['cradle', 'barrel'], ['hull', ...INSTANCED_GROUPS])) expected.add(pair(overlap));
          states++;
        }
      }
      const actual = sweepGunHull(a, { yawStep: 45 * DEG, pitchStep: 5 * DEG });
      expect(actual.states, a.key).toBe(states);
      expect([...new Set(actual.overlaps.map(pair))].sort(), a.key).toEqual([...expected].sort());
      collisions += expected.size;
    }
    expect(collisions).toBeGreaterThan(0);
  });
});
