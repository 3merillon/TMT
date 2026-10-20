import { describe, expect, it } from 'vitest';
import { assembleKit, type KitLoadout } from '../src/game/kit';
import { tilt, withWorld } from './helpers/vehicle-world';

const EQUIPMENT = { runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' } as const;
const builds: KitLoadout[] = ['skiff', 'warden', 'bastion'].map(hull => ({ ...EQUIPMENT, hull } as KitLoadout));
builds.push({ ...EQUIPMENT, hull: 'bastion', armor: 'reactive' });

async function measure(kit: KitLoadout) {
  return withWorld(w => {
    w.addPlane();
    const tank = w.addTank({ kit, position: [0, .6, 0] });
    w.run(120);
    w.run(30, () => ({ throttle: 1, steer: 0 }));
    const speedHalfSecond = tank.velocity[2];
    w.run(90, () => ({ throttle: 1, steer: 0 }));
    const topSpeed = tank.velocity[2], z = tank.position[2];
    w.run(90);
    const stoppingDistance = tank.position[2] - z;
    w.run(120, () => ({ throttle: 0, steer: 1 }));
    const pivot = Math.abs(tank.yawVelocity);
    w.run(120, () => ({ throttle: 1, steer: 1 }));
    return { speedHalfSecond, topSpeed, stoppingDistance, pivot, turn: Math.abs(tank.yawVelocity), upDot: tilt(tank).upDot,
      mass: assembleKit(kit).stats.mass, hp: assembleKit(kit).stats.hp };
  });
}

describe('equivalent-equipment armor driving scenarios', () => {
  it('retains a useful light mobility advantage, a medium compromise and perceptible reactive weight', async () => {
    const results = [];
    for (const kit of builds) results.push(await measure(kit));
    for (let i = 0; i < results.length - 1; i++) {
      const light = results[i], heavy = results[i + 1];
      expect(light.mass).toBeLessThan(heavy.mass);
      expect(light.speedHalfSecond, JSON.stringify(results)).toBeGreaterThan(heavy.speedHalfSecond);
      expect(light.topSpeed, JSON.stringify(results)).toBeGreaterThan(heavy.topSpeed);
      expect(light.pivot, JSON.stringify(results)).toBeGreaterThan(heavy.pivot);
      expect(light.turn, JSON.stringify(results)).toBeGreaterThan(heavy.turn);
    }
    expect(results[0].topSpeed / results[2].topSpeed).toBeGreaterThan(1.15);
    for (const r of results) {
      expect(r.stoppingDistance).toBeLessThan(1.2);
      expect(r.pivot).toBeGreaterThan(1.35);
      expect(r.upDot).toBeGreaterThan(.98);
    }
  });
  it('reproduces the same reactive equipped drive deterministically', async () => {
    expect(await measure(builds[3])).toEqual(await measure(builds[3]));
  });
});
