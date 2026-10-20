import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { turretMotionRate, type TurretPose } from '../src/audio/turret-motion';
import { engineParams, SERVO_RATE_DEADZONE } from '../src/audio/sfx/tank-sfx-math';
import { TankAudioIntegrator } from '../src/audio/integrator';
import { FakeAudioContext, type FakeParam } from '../src/audio/testing/fake-audio-context';
import { GameSimulation, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import { holdPlanetBearing, mul, normalize, rotation, wrapAngle } from '../src/game/math';
import type { Q4, V3 } from '../src/game/contracts';
import { SphereWorld } from './helpers/sphere-world';

const pose = (): TurretPose => ({ position: [0, 18.4, 0], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: .3 });
const servo = (rate: number) => engineParams({ speed: 0, accel: 0, slip: 0, contact: 1, turretRate: rate }).servo;

describe('turret audio motion', () => {
  it('ignores planet transport, tangent-frame changes and chassis tilt while the bearing is held', () => {
    let before = pose();
    for (const direction of [[0, .1, 1], [.2, -.1, 1], [0, -1, .1], [-1, -.1, .1]] as V3[]) {
      const up = normalize(direction);
      const after: TurretPose = { ...before, position: mul(up, 18.4),
        rotation: new Quaternion(...rotation(up, .7)).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), .28)).toArray() as Q4 };
      after.turretYaw = holdPlanetBearing(before, after, before.turretYaw);
      expect(turretMotionRate(before, after, FIXED_DT)).toBeLessThan(1e-10);
      // The same sampled poses still detect an adjustment; it does not depend on player keyboard input.
      expect(turretMotionRate(before, { ...after, turretYaw: after.turretYaw + .01 }, FIXED_DT)).toBeCloseTo(.6, 10);
      before = after;
    }
  });

  it('measures deliberate yaw and pitch together and crosses angle wraps without a false burst', () => {
    const before = pose(), after = { ...pose(), turretYaw: .01, barrelPitch: .32 };
    expect(turretMotionRate(before, after, FIXED_DT)).toBeCloseTo(Math.hypot(.01, .02) / FIXED_DT, 10);
    before.turretYaw = Math.PI - .002;
    after.turretYaw = -Math.PI + .003; after.barrelPitch = before.barrelPitch;
    expect(turretMotionRate(before, after, FIXED_DT)).toBeCloseTo(.3, 10);
    expect(servo(turretMotionRate(before, after, FIXED_DT))).toBeGreaterThan(.15);
    for (const rate of [0, .001, SERVO_RATE_DEADZONE, -SERVO_RATE_DEADZONE]) expect(servo(rate)).toBe(0);
    expect(servo(.2)).toBeGreaterThan(0); expect(servo(2)).toBe(1);
  });

  it('discards invalid poses and clock discontinuities', () => {
    const before = pose(), after = { ...pose(), turretYaw: 1 };
    for (const dt of [0, -FIXED_DT, Infinity, NaN, .5]) expect(turretMotionRate(before, after, dt)).toBe(0);
    expect(turretMotionRate(before, { ...after, position: [0, 0, 0] }, FIXED_DT)).toBe(0);
    expect(turretMotionRate(before, { ...after, rotation: [0, NaN, 0, 1] }, FIXED_DT)).toBe(0);
    expect(turretMotionRate(before, { ...after, barrelPitch: NaN }, FIXED_DT)).toBe(0);
  });

  it('keeps real driving silent, voices deliberate aim while driving, and releases the actual loop envelope promptly', async () => {
    const setup = practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    const simulation = new GameSimulation(new SphereWorld(), setup), tank = simulation.state.tanks[0];
    const ctx = new FakeAudioContext(), loopParams: Record<string, FakeParam>[] = [];
    await ctx.resume();
    const audio = new TankAudioIntegrator(ctx.asAudioContext(), { loopFactory: () => {
      const node = ctx.createGain();
      const params = Object.fromEntries(['fundamental', 'load', 'tread', 'slip', 'servo', 'level'].map(name => [name, ctx.createGain().gain]));
      loopParams.push(params);
      return { node: node as unknown as AudioNode, params: params as never, sources: [], nodes: [node as unknown as AudioNode] };
    } });
    await audio.start(); audio.fadeIn(); audio.onMatchStart(setup);
    const frame = () => audio.onFrame({ realDt: FIXED_DT, simDt: FIXED_DT, snapshot: simulation.state,
      camera: { position: [0, 26, 8], target: [0, 18.4, 0], up: [0, 1, 0], fovY: .9 }, focus: tank.position });
    const target = () => loopParams[0].servo.events.filter(event => event.type === 'target').at(-1)?.value ?? 0;
    frame();
    let compensated = 0, previousYaw = tank.turretYaw;
    try {
      for (let i = 0; i < 150; i++) {
        simulation.step(FIXED_DT, { throttle: .7, steer: .6 });
        if (Math.abs(wrapAngle(tank.turretYaw - previousYaw)) > 1e-6) compensated++;
        previousYaw = tank.turretYaw;
        ctx.advance(FIXED_DT); frame();
        expect(target()).toBe(0);
      }
      expect(compensated).toBe(150);
      for (let i = 0; i < 30; i++) {
        simulation.aim(0, tank.turretYaw + .012, tank.barrelPitch, tank.power);
        simulation.step(FIXED_DT, { throttle: .7, steer: .6 });
        ctx.advance(FIXED_DT); frame();
        expect(target()).toBeGreaterThan(.4);
      }
      const heldTarget = target();
      frame(); expect(target()).toBe(heldTarget); // Extra display frames do not invent a new fixed-tick velocity.
      for (let i = 0; i < 10; i++) {
        simulation.step(FIXED_DT, { throttle: .7, steer: .6 });
        ctx.advance(FIXED_DT); frame();
        expect(target()).toBe(0);
      }
      expect(loopParams[0].servo.valueAt(ctx.currentTime)).toBeLessThan(.025);
      simulation.aim(0, tank.turretYaw, tank.barrelPitch + .012, tank.power);
      simulation.step(FIXED_DT, { throttle: .7, steer: .6 });
      ctx.advance(FIXED_DT); frame();
      expect(target()).toBeGreaterThan(.4);
    } finally { audio.dispose(); }
  });
});
