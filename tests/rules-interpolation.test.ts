/** Render interpolation (plan §5.5 SimInterpolation) and the frame loop's dt cap. */
import { describe, expect, it } from 'vitest';
import { practiceSetup } from '../src/game/api/match';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { MAX_SIM_FRAME } from '../src/game/app/loop';
import { SphereWorld } from './helpers/sphere-world';
import { FakeTransactions } from './helpers/fake-transactions';

const PLAYER = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
const drive = () => new GameSimulation(new SphereWorld(), practiceSetup({ seed: 1, mode: 'drive', player: PLAYER }));

describe('SimInterpolation', () => {
  it('holds the poses before and after the latest tick and the fraction of the next tick already elapsed', () => {
    const simulation = drive();
    simulation.step(FIXED_DT * 10, { throttle: 1, steer: .3 });
    const before = simulation.state.tanks.map(tank => ({ position: [...tank.position], rotation: [...tank.rotation], turretYaw: tank.turretYaw, barrelPitch: tank.barrelPitch }));
    simulation.step(FIXED_DT * 1.5, { throttle: 1, steer: .3 });
    const interpolation = simulation.interpolation();
    expect(interpolation.alpha).toBeCloseTo(.5, 9);
    expect(interpolation.prev).toEqual(before);
    expect(interpolation.curr[0].position).toEqual(simulation.state.tanks[0].position);
    expect(interpolation.curr[0].position).not.toEqual(interpolation.prev[0].position);
    expect(interpolation.curr).toHaveLength(simulation.state.tanks.length);
  });

  it('returns detached copies: presentation can never write into the simulation', () => {
    const simulation = drive();
    simulation.step(FIXED_DT * 3, { throttle: 1, steer: 0 });
    const interpolation = simulation.interpolation();
    (interpolation.curr[0].position as number[])[0] = 999;
    expect(simulation.state.tanks[0].position[0]).not.toBe(999);
  });

  it('shows the current poses (alpha 1) before the first tick and while stalled on terrain', () => {
    const fresh = drive();
    expect(fresh.interpolation().alpha).toBe(1);
    expect(fresh.interpolation().prev).toEqual(fresh.interpolation().curr);
    const world = new SphereWorld();
    let frames = 0;
    world.transactions = new FakeTransactions(world, () => frames, { latency: 100000 });
    const simulation = new GameSimulation(world, practiceSetup({ seed: 11, mode: 'bot', player: PLAYER }));
    simulation.aim(0, 1, .5, .25); simulation.fire(0); simulation.endMove(0);
    for (let tick = 0; tick < 400 && !simulation.stalledOn; tick++) { frames++; simulation.step(FIXED_DT); }
    expect(simulation.stalledOn).not.toBeNull();
    const stalled = simulation.interpolation();
    expect(stalled.alpha).toBe(1);
    expect(stalled.prev).toEqual(stalled.curr);
  });
});

describe('frame loop dt cap', () => {
  it('keeps real time down to 20 fps and only dilates below it', () => {
    expect(MAX_SIM_FRAME).toBeCloseTo(1 / 20, 12);
    const simulation = drive();
    simulation.step(1 / 25);
    expect(simulation.state.tick).toBe(2);
    simulation.step(Math.min(1 / 12, MAX_SIM_FRAME));
    expect(simulation.state.tick).toBe(5);
  });
});
