/** Tick determinism (plan §6 I9): the chassis model reads only tick-state, inputs and Rapier queries, so two fresh runs
 * of the same schedule on the same build are bit-equal, including the chassis checkpoint payload. */
import { expect, it } from 'vitest';
import type { DriveInput } from '../src/game/contracts';
import { axisAngle, DEFAULT, HEAVY, IDLE, rideHeight, withWorld } from './helpers/vehicle-world';

/** Two tanks on rolling trimesh terrain: drive, turn, reverse, a sideways shove, analog input and a self-right press. */
async function trace(): Promise<{ poses: Float64Array; motions: string }> {
  return withWorld(w => {
    w.addHeightfield((x, z) => .35 * Math.sin(x * .7) * Math.cos(z * .5) + .12 * Math.sin(x * 2.3 + z * 1.7), { size: 40, cells: 160 });
    const a = w.addTank({ loadout: DEFAULT, position: [0, 0, 0] }), b = w.addTank({ loadout: HEAVY, position: [3, 0, 2], rotation: axisAngle([0, 1, 0], 2.2) });
    a.position = [0, rideHeight(a) + 1, 0]; b.position = [3, rideHeight(b) + 1, 2];
    const ticks = 600, poses = new Float64Array(ticks * 2 * 14);
    const schedule = (i: number): DriveInput[] => [
      i < 120 ? IDLE : i < 240 ? { throttle: 1, steer: 0 } : i < 360 ? { throttle: 1, steer: -1 } : i < 420 ? { throttle: -1, steer: .4 } : { throttle: .63, steer: .27, selfRight: i === 500 },
      i < 200 ? { throttle: 0, steer: 1 } : { throttle: .85, steer: -.5 },
    ];
    w.run(ticks, schedule, i => {
      if (i === 300) b.velocity = [b.velocity[0] + 2.5, b.velocity[1] + 1.2, b.velocity[2]];
      let k = i * 28;
      for (const t of w.tanks) for (const v of [...t.position, ...t.rotation, ...t.velocity, t.yawVelocity, ...t.trackSpeeds, t.trackPhase]) poses[k++] = v;
    });
    return { poses, motions: JSON.stringify(w.bridge.motions()) };
  });
}

it('two identical runs are bit-equal', async () => {
  const first = await trace(), second = await trace();
  expect(first.poses.every(Number.isFinite)).toBe(true);
  expect(Buffer.from(second.poses.buffer).equals(Buffer.from(first.poses.buffer))).toBe(true);
  expect(second.motions).toBe(first.motions);
}, 60000);
