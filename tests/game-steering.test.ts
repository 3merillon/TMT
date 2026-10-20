/** Steering convention seen through the chase camera, on the kinematic sphere-world chassis (tests/helpers/sphere-world). */
import { describe, expect, it } from 'vitest';
import { CameraPose } from '../src/game/presentation/camera-pose';
import type { V3 } from '../src/game/contracts';
import { add, mul, normalize, rotate, rotation } from '../src/game/math';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { TankFollowCamera } from '../src/game/view';
import { SphereWorld } from './helpers/sphere-world';

describe('steering as seen from behind the tank', () => {
  it('projects the model negative X side to the driver’s right', () => {
    const camera = new CameraPose(47, 1, .08, 220);
    const follow = new TankFollowCamera(camera);
    const tank = { position: [0, 18.55, 0] as V3, rotation: rotation([0, 1, 0], 0) };
    follow.update(tank, [0, 0, 0], FIXED_DT, true);
    const left = camera.project(add(tank.position, [.55, 0, 0]));
    const right = camera.project(add(tank.position, [-.55, 0, 0]));
    expect(left[0]).toBeLessThan(0);
    expect(right[0]).toBeGreaterThan(0);
  });

  for (const [name, input] of [['left', -1], ['right', 1]] as const) {
    it(`turns the nose screen-${name} for the ${name} action across local planet frames`, () => {
      const poses: { radial: V3; heading: number }[] = [
        { radial: [0, 1, 0], heading: 0 },
        { radial: [0, 1, 0], heading: Math.PI / 2 },
        { radial: [0, -1, 0], heading: -.7 },
        { radial: normalize([.3, .7, .65]), heading: 2.4 },
        { radial: normalize([.1, .15, -.99]), heading: -.5 },
      ];
      for (const { radial, heading } of poses) {
        const simulation = new GameSimulation(new SphereWorld(), { driveTest: true });
        const tank = simulation.state.tanks[0];
        tank.position = mul(radial, 18.55); tank.velocity = [0, 0, 0];
        tank.heading = heading; tank.rotation = rotation(radial, heading);
        for (let tick = 0; tick < 180; tick++) simulation.step(FIXED_DT);
        const camera = new CameraPose(47, 1, .08, 220);
        new TankFollowCamera(camera).update(tank, [0, 0, 0], FIXED_DT, true);
        const initialForward = rotate([0, 0, 1], tank.rotation);
        for (let tick = 0; tick < 24; tick++) simulation.step(FIXED_DT, { throttle: 0, steer: input });
        // Freeze the prior camera to observe the action's direction before follow smoothing catches up.
        // Project both nose directions from the same center, excluding incidental settling translation.
        const before = camera.project(add(tank.position, initialForward));
        const after = camera.project(add(tank.position, rotate([0, 0, 1], tank.rotation)));
        expect((after[0] - before[0]) * input).toBeGreaterThan(.015);
      }
    });
  }
});
