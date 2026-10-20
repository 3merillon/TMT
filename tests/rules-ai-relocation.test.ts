/** Relocation (Experience §1.15 step 5): of 12 endpoints within fuel, the planner picks one the threat cannot see,
 * refuses slopes over 25°, and pure pursuit drives the tank there. */
import { describe, expect, it } from 'vitest';
import type { BotObservation } from '../src/game/api/bot';
import { practiceSetup } from '../src/game/api/match';
import type { TerrainHit, V3 } from '../src/game/contracts';
import { add, distance, mul, normalize } from '../src/game/math';
import { resolveProfile } from '../src/game/ai/profiles';
import { BrainRandom } from '../src/game/ai/random';
import { MAX_SLOPE, Pursuit, RelocationPlanner, surfaceStep } from '../src/game/ai/relocation';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

/** A tall wall on the +Z half of the arena between the tank (+Y) and a threat 5.5 u towards +X. */
class CoverWorld extends SphereWorld {
  constructor(readonly min: V3 = [3, 16, 0], readonly max: V3 = [3.4, 23, 6]) { super(); }
  override isSolid(point: V3): boolean { return super.isSolid(point) || point.every((value, axis) => value >= this.min[axis] && value <= this.max[axis]); }
  override raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    const ground = super.raycast(origin, direction, maxDistance);
    let near = 0, far = maxDistance, normal: V3 = [0, 1, 0];
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(direction[axis]) < 1e-12) { if (origin[axis] < this.min[axis] || origin[axis] > this.max[axis]) return ground; continue; }
      const a = (this.min[axis] - origin[axis]) / direction[axis], b = (this.max[axis] - origin[axis]) / direction[axis];
      if (Math.min(a, b) > near) { near = Math.min(a, b); normal = [0, 0, 0]; normal[axis] = -Math.sign(direction[axis]); }
      far = Math.min(far, Math.max(a, b));
      if (near > far) return ground;
    }
    return near <= maxDistance && (!ground || near < ground.distance) ? { point: add(origin, mul(direction, near)), normal, distance: near, material: 3 } : ground;
  }
}

/** A bare observation of the committed world (the planner only uses world queries). */
function observe(world: SphereWorld): BotObservation {
  return { world } as unknown as BotObservation;
}
const budget = { traceSteps: 10000 };

describe('relocation endpoints', () => {
  it('picks the endpoint occluded from the threat', () => {
    const world = new CoverWorld(), simulation = new GameSimulation(world, practiceSetup({ seed: 2, mode: 'local', player: LOADOUT }));
    const self = { ...simulation.state.tanks[0], position: [0, 18.55, 0] as V3 };
    const threat = mul(normalize([Math.sin(5.5 / 18.55), Math.cos(5.5 / 18.55), 0]), 18.55);
    // A 2.5 u ring: every endpoint is within the threat's horizon, so only the wall can hide one.
    const params = { ...resolveProfile('tosser'), relocate: { min: 2.5, max: 2.5, cover: 1.5, height: .1 } };
    for (let seed = 1; seed <= 5; seed++) {
      const planner = new RelocationPlanner(self, params, [threat], new BrainRandom(seed), 7);
      expect(planner.step(observe(world), budget)).toBe(true);
      expect(planner.endpoints).toHaveLength(12);
      expect(planner.endpoints.some(endpoint => endpoint.covered === 1)).toBe(true);
      expect(planner.endpoints.some(endpoint => endpoint.covered === 0)).toBe(true);
      const chosen = planner.endpoints.find(endpoint => endpoint.position === planner.target)!;
      expect(chosen.covered).toBe(1);
      expect(planner.target![2]).toBeGreaterThan(0); // behind the wall's +Z half
      expect(planner.target![0]).toBeLessThan(3);
    }
  });

  it('never picks an endpoint steeper than 25 degrees and stays within fuel', () => {
    const world = new SphereWorld(), simulation = new GameSimulation(world, practiceSetup({ seed: 2, mode: 'local', player: LOADOUT }));
    const self = simulation.state.tanks[0];
    const planner = new RelocationPlanner(self, resolveProfile('cyborg'), [[0, -18, 0]], new BrainRandom(9), 3);
    planner.step(observe(world), budget);
    for (const endpoint of planner.endpoints) expect(endpoint.slope).toBeLessThanOrEqual(MAX_SLOPE);
    expect(distance(planner.target!, self.position)).toBeLessThanOrEqual(3 * .85 + .7);
  });

  it('spends its world queries within the tick budget and resumes', () => {
    const world = new CoverWorld(), simulation = new GameSimulation(world, practiceSetup({ seed: 2, mode: 'local', player: LOADOUT }));
    const planner = new RelocationPlanner(simulation.state.tanks[0], resolveProfile('tosser'), [[5, 17, 0], [-5, 17, 0]], new BrainRandom(3), 7);
    let queries = 0, ticks = 0;
    const counted = { get radius() { return world.radius; }, raycast: (...args: Parameters<SphereWorld['raycast']>) => { queries++; return world.raycast(...args); },
      surface: (direction: V3) => { queries++; return world.surface(direction); }, isSolid: (point: V3) => world.isSolid(point) };
    for (; ticks < 100; ticks++) {
      const limited = { traceSteps: 5 }, before = queries;
      const done = planner.step({ world: counted } as unknown as BotObservation, { get traceSteps() { return limited.traceSteps - (queries - before); } });
      expect(queries - before).toBeLessThanOrEqual(5);
      if (done) break;
    }
    expect(queries).toBe(12 * 3);
    expect(ticks).toBeGreaterThan(5);
  });
});

describe('pure pursuit', () => {
  it('drives the tank to its endpoint with the driver-facing steering convention', () => {
    const world = new SphereWorld();
    const simulation = new GameSimulation(world, practiceSetup({ seed: 2, mode: 'drive', player: LOADOUT }));
    const tank = simulation.state.tanks[0];
    for (const bearing of [0, 1.2, 2.8, -2]) {
      const target = mul(surfaceStep(tank.position, bearing, 4), 18.55), pursuit = new Pursuit(target);
      for (let tick = 0; tick < 600; tick++) {
        const input = pursuit.drive(tank, simulation.state.tick);
        if (input.throttle === 0 && input.steer === 0) break;
        simulation.step(FIXED_DT, input);
      }
      expect(distance(tank.position, target)).toBeLessThan(.8);
    }
  });
});
