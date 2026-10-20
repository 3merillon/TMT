import { describe, expect, it } from 'vitest';
import { assembleKit, type GearId } from '../src/game/kit';
import { GEAR_TRACTION } from '../src/game/vehicle/tuning';
import { tilt, withWorld } from './helpers/vehicle-world';

const kit = (runningGear: GearId) => ({ hull: 'warden', runningGear, turret: 'dome', weapon: 'cannon', utility: 'antenna' } as const);
async function drive(gear: GearId) {
  return withWorld(w => {
    w.addPlane(); const tank = w.addTank({ kit: kit(gear), position: [0, .6, 0] });
    w.run(120); w.run(180, () => ({ throttle: 1, steer: 0 }));
    const speed = tank.velocity[2], z = tank.position[2];
    w.run(90); const stopping = tank.position[2] - z;
    w.run(180, () => ({ throttle: 1, steer: 1 }));
    return { speed, stopping, upright: tilt(tank).upDot, yaw: Math.abs(tank.yawVelocity) };
  });
}

describe('fantasy gear on the resident vehicle solver', () => {
  it('delivers its purchased mobility advantage in the same equipment and remains stable while turning and braking', async () => {
    for (const [variant, base, gain] of [['aether_drive', 'grip', 1.15], ['forge_tracks', 'crawler', 1.05]] as const) {
      const upgraded = assembleKit(kit(variant)), ordinary = assembleKit(kit(base));
      const actual = await drive(variant), comparison = await drive(base);
      expect(upgraded.stats.cost).toBeGreaterThan(ordinary.stats.cost);
      expect(upgraded.stats.traction).toBeGreaterThan(ordinary.stats.traction);
      expect(actual.speed).toBeGreaterThan(comparison.speed * gain);
      expect(actual.stopping).toBeLessThan(1.5); expect(actual.upright).toBeGreaterThan(.98); expect(actual.yaw).toBeGreaterThan(.8);
      expect(GEAR_TRACTION[variant].longitudinal).toBeLessThanOrEqual(1.6);
    }
  });

  it('climbs a forty-five degree ramp without a traction-induced backflip', async () => {
    for (const gear of ['aether_drive', 'forge_tracks'] as const) await withWorld(w => {
      const ramp = w.addRamp(45), tank = w.addTank({ kit: kit(gear), position: [0, .6, 0] });
      w.run(120); let flipped = false;
      w.run(600, () => ({ throttle: 1, steer: 0 }), () => { if (tilt(tank).upDot < .1) flipped = true; });
      expect(flipped, gear).toBe(false);
      expect(tank.position[2], gear).toBeGreaterThan(ramp.end + 1);
      expect(tank.position[1], gear).toBeGreaterThan(ramp.top);
    });
  });

  it('replays the new drive deterministically', async () => {
    expect(await drive('aether_drive')).toEqual(await drive('aether_drive'));
  });
});
