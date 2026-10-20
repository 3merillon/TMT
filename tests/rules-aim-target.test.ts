import { describe, expect, it } from 'vitest';
import { practiceSetup } from '../src/game/api/match';
import type { Loadout, V3 } from '../src/game/contracts';
import { add, distance, mul, normalize, segmentSphere, sub } from '../src/game/math';
import type { MunitionId } from '../src/game/munitions';
import { GameSimulation, FIXED_DT } from '../src/game/simulation';
import { AIM_TARGET_BUDGET, TANK_TARGET_RADIUS, type AimSelection } from '../src/game/rules/aim-target';
import { SphereWorld } from './helpers/sphere-world';

const ground = (range: number, bearing = 0): V3 => [18 * Math.sin(range / 18) * Math.sin(bearing), 18 * Math.cos(range / 18), 18 * Math.sin(range / 18) * Math.cos(bearing)];
function fixture(weapon: Loadout['barrel'] = 'cannon', wind = false) {
  const setup = practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: weapon, armor: 'light' } });
  setup.tanks[0].spawn = { up: [0, 1, 0], heading: 0 };
  setup.tanks[1].spawn = { up: [0, -1, 0], heading: 0 };
  if (wind) setup.rules.wind = { mean: 1, gust: 0.35, period: 8 };
  const world = new SphereWorld(); world.kinematic = false;
  return { world, simulation: new GameSimulation(world, setup) };
}

describe('ground target ballistics', () => {
  it('solves nearby ground points in front, behind and beside each weapon within its fixed budget', () => {
    const failures: unknown[] = [];
    for (const weapon of ['mortar', 'cannon', 'rail'] as const) {
      const { simulation } = fixture(weapon);
      for (const range of [3, 8, 14]) for (const bearing of [0, 1.4, 3]) {
        const target = ground(range, bearing), result = simulation.solveAimTarget(0, target);
        expect(result.traces).toBeLessThanOrEqual(AIM_TARGET_BUDGET.traces);
        expect(result.steps).toBeLessThanOrEqual(AIM_TARGET_BUDGET.steps);
        if (result.status !== 'ready' || result.error > .25) failures.push({ weapon, range, bearing, ...result });
      }
    }
    expect(failures).toEqual([]);
  });

  it('uses the same wind and actual launch geometry as preview and a fired shot, without changing canonical state', () => {
    const { simulation } = fixture('cannon', true), target = ground(10, 0.4);
    const before = simulation.checkpoint(), state = structuredClone(simulation.state), budget = simulation.aiTelemetry();
    const result = simulation.solveAimTarget(0, target);
    expect(result.status).toBe('ready');
    expect(simulation.checkpoint()).toEqual(before);
    expect(simulation.state).toEqual(state);
    expect(simulation.aiTelemetry()).toEqual(budget);
    expect(simulation.command(0, { k: 'aim', ...result.aim! })).toBe(true);
    const preview = simulation.previewPrediction(0);
    expect(preview.hit).toBe(true);
    expect(distance(preview.points.at(-1)!, target)).toBeLessThanOrEqual(.25);
    expect(simulation.fire(0)).toBe(true);
    let impact: V3 | null = null;
    for (let tick = 0; tick < 480 && !impact; tick++) {
      for (const event of simulation.step(FIXED_DT)) if (event.type === 'impact') impact = event.position;
    }
    expect(impact).not.toBeNull();
    expect(distance(impact!, target)).toBeLessThanOrEqual(.25);
  });

  it('warm starts nearby moving targets without looking up enemies', () => {
    const { simulation } = fixture(), initial = simulation.solveAimTarget(0, ground(8));
    expect(initial.status).toBe('ready');
    simulation.state.tanks[1].position = ground(6); // A tank in the path must not steer terrain targeting.
    const near = simulation.solveAimTarget(0, ground(8.2, 0.02), initial.aim!);
    expect(near.status).toBe('ready');
    expect(near.traces).toBeLessThanOrEqual(7);
    expect(near.error).toBeLessThanOrEqual(.25);
  });

  it('finds reachable terrain endpoints across ammo speeds and low/high original arcs', () => {
    const failures: unknown[] = [];
    for (const weapon of ['mortar', 'cannon', 'rail'] as const) {
      const { simulation } = fixture(weapon);
      for (const munition of ['explosive', 'heavy', 'incendiary', 'nuclear'] as MunitionId[]) {
        simulation.selectMunition(0, munition);
        for (const power of [.25, .65]) for (const pitch of [.2, .7]) {
          simulation.aim(0, power < .5 ? 0.15 : 2.7, pitch, power);
          const prediction = simulation.previewPrediction(0);
          if (!prediction.hit) continue;
          const target = prediction.points.at(-1)!, result = simulation.solveAimTarget(0, target);
          if (result.status !== 'ready') failures.push({ weapon, munition, power, pitch, ...result });
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('returns explicit failures and bounded finite best candidates instead of claiming unreachable points', () => {
    const { simulation } = fixture('mortar');
    expect(simulation.solveAimTarget(99, ground(8)).status).toBe('invalid');
    expect(simulation.solveAimTarget(0, [NaN, 0, 0]).aim).toBeNull();
    const far = simulation.solveAimTarget(0, [1000, 1000, 1000]);
    expect(far.status).not.toBe('ready');
    expect(far.aim).not.toBeNull();
    expect(Object.values(far.aim!).every(Number.isFinite)).toBe(true);
    expect(far.traces).toBeLessThanOrEqual(AIM_TARGET_BUDGET.traces);
    expect(far.steps).toBeLessThanOrEqual(AIM_TARGET_BUDGET.steps);
  });

  it('tries a higher arc over an obstruction and reports a sealed muzzle as blocked', () => {
    const { world, simulation } = fixture('cannon');
    const terrainRay = world.raycast.bind(world), obstacle: V3 = [0, 19.8, 5];
    world.raycast = (origin, direction, extent) => {
      const terrain = terrainRay(origin, direction, extent), at = segmentSphere(origin, direction, extent, obstacle, 1.1);
      if (at === null || (terrain && terrain.distance < at)) return terrain;
      const point = add(origin, mul(direction, at));
      return { point, normal: normalize(sub(point, obstacle)), distance: at, material: 1 };
    };
    const result = simulation.solveAimTarget(0, ground(12));
    expect(result.status, JSON.stringify(result)).toBe('ready');
    expect(result.error).toBeLessThanOrEqual(.25);
    world.raycast = (origin, direction, extent) => {
      const at = Math.min(.1, extent), point = add(origin, mul(direction, at));
      return { point, normal: normalize(point), distance: at, material: 1 };
    };
    const blocked = simulation.solveAimTarget(0, ground(12));
    expect(blocked.status).toBe('blocked');
    expect(blocked.aim).not.toBeNull();
    expect(blocked.error).toBeGreaterThan(1);
  });

  it('intercepts only the supplied visible target sphere and clips preview at the same contact as the live shot', () => {
    const { simulation } = fixture('cannon', true), surface = ground(8, .3);
    const center = add(surface, mul(normalize(surface), .55));
    simulation.state.tanks[1].position = center;
    const selection: AimSelection = { point: add(center, [0, .2, 0]), object: {
      id: 'tank:1', kind: 'tank', collider: { shape: 'sphere', center, radius: TANK_TARGET_RADIUS },
    } };
    const before = simulation.checkpoint(), result = simulation.solveAimTarget(0, selection);
    expect(result.status, JSON.stringify(result)).toBe('ready');
    expect(result.hitTarget).toBe(true);
    expect(distance(result.point!, center)).toBeCloseTo(TANK_TARGET_RADIUS, 5);
    expect(simulation.checkpoint()).toEqual(before);
    simulation.state.tanks[1].position = ground(4); // Hidden/intervening tanks are excluded from assistance.
    expect(simulation.solveAimTarget(0, selection)).toEqual(result);
    simulation.state.tanks[1].position = center;
    simulation.command(0, { k: 'aim', ...result.aim! });
    const preview = simulation.previewPrediction(0, true, selection.object!.collider);
    expect(preview.hitTarget).toBe(true);
    expect(simulation.previewPrediction(0, true, selection.object!.collider).hitTarget).toBe(true); // Cached metadata survives.
    expect(distance(preview.points.at(-1)!, result.point!)).toBeLessThan(1e-5);
    simulation.fire(0);
    let impact: V3 | null = null;
    for (let tick = 0; tick < 480 && !impact; tick++) for (const event of simulation.step(FIXED_DT)) if (event.type === 'impact') impact = event.position;
    expect(impact).not.toBeNull();
    expect(distance(impact!, result.point!)).toBeLessThan(1e-5);
  });

  it('intercepts a supplied future object above the terrain and never treats its ground landing as success', () => {
    const { simulation } = fixture();
    const selection: AimSelection = { point: [0, 23, 8], object: {
      id: 'floating-target', kind: 'object', collider: { shape: 'sphere', center: [0, 23, 8], radius: .6 },
    } };
    const result = simulation.solveAimTarget(0, selection);
    expect(result.status, JSON.stringify(result)).toBe('ready');
    expect(result.hitTarget).toBe(true);
    expect(distance(result.point!, selection.object!.collider.center)).toBeCloseTo(.6, 5);
  });

  it('refines movements smaller than the ready tolerance with a small warm trace budget', () => {
    const { simulation } = fixture();
    let previous = simulation.solveAimTarget(0, ground(8));
    const traces: number[] = [];
    for (let step = 1; step <= 30; step++) {
      const target = ground(8 + step * .08, step * .002);
      const next = simulation.solveAimTarget(0, target, previous.aim!);
      expect(next.status).toBe('ready');
      expect(next.error).toBeLessThanOrEqual(AIM_TARGET_BUDGET.refinementTolerance);
      expect(distance(next.point!, previous.point!)).toBeGreaterThan(.025);
      traces.push(next.traces); previous = next;
    }
    expect(Math.max(...traces)).toBeLessThanOrEqual(7);
    expect(traces.reduce((sum, count) => sum + count, 0) / traces.length).toBeLessThanOrEqual(4);
  });

  it('tracks fine hovered-point changes on one object without a collider-sized dead zone or aim jumps', () => {
    const { simulation } = fixture('cannon', true), surface = ground(8);
    const center = add(surface, mul(normalize(surface), .55)), toward = normalize(sub(simulation.state.tanks[0].position, center));
    const object: NonNullable<AimSelection['object']> = { id: 'same-tank', kind: 'tank', collider: { shape: 'sphere', center, radius: .7 } };
    const point = (x: number) => add(center, add([x, 0, 0], mul(toward, Math.sqrt(.7 ** 2 - x ** 2))));
    let previous = simulation.solveAimTarget(0, { point: point(-.2), object });
    expect(previous.status, JSON.stringify(previous)).toBe('ready');
    const counts: number[] = [];
    for (let step = 1; step <= 20; step++) {
      const hovered = point(-.2 + step * .02), next = simulation.solveAimTarget(0, { point: hovered, object }, previous.aim!);
      expect(next.status, JSON.stringify(next)).toBe('ready');
      expect(next.hitTarget).toBe(true);
      expect(next.error).toBeLessThanOrEqual(AIM_TARGET_BUDGET.objectRefinementTolerance);
      const yawChange = Math.abs(next.aim!.yaw - previous.aim!.yaw);
      expect(yawChange).toBeGreaterThan(.0001);
      expect(yawChange).toBeLessThan(.01);
      expect(Math.abs(next.aim!.power - previous.aim!.power)).toBeLessThan(.01);
      counts.push(next.traces); previous = next;
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(7);
  });

  it('preserves a precise hovered mesh point outside the collider instead of forcing a different hit', () => {
    const { simulation } = fixture('cannon', true), surface = ground(8);
    const center = add(surface, mul(normalize(surface), .55));
    const object: NonNullable<AimSelection['object']> = {
      id: 'extended-track', kind: 'tank', collider: { shape: 'sphere', center, radius: .7 },
    };
    const central = simulation.solveAimTarget(0, { point: center, object });
    expect(central.status).toBe('ready');
    const hovered = add(center, [1.3, .2, 0]);
    const result = simulation.solveAimTarget(0, { point: hovered, object }, central.aim!);
    expect(result.error, JSON.stringify(result)).toBeLessThanOrEqual(AIM_TARGET_BUDGET.objectRefinementTolerance);
    expect(result.hitTarget).toBe(false);
    expect(result.status).not.toBe('ready');
    expect(Math.abs(result.aim!.yaw - central.aim!.yaw)).toBeGreaterThan(.1);
    expect(result.traces).toBeLessThanOrEqual(AIM_TARGET_BUDGET.traces);
    expect(result.steps).toBeLessThanOrEqual(AIM_TARGET_BUDGET.steps);
    simulation.command(0, { k: 'aim', ...result.aim! });
    expect(simulation.previewPrediction(0, true, object.collider).hitTarget).not.toBe(true);
  });

  it('keeps the chosen route stable around moving debris while actual preview and fire still collide with it', () => {
    const { simulation, world } = fixture(), committed = new SphereWorld();
    Object.assign(world, { footprintSurface: committed });
    const target = ground(10), intended = simulation.solveAimTarget(0, target);
    expect(intended.status).toBe('ready');
    simulation.command(0, { k: 'aim', ...intended.aim! });
    const clear = simulation.previewPrediction(0), terrainRay = world.raycast.bind(world);
    let debris: V3 = clear.points[3];
    world.raycast = (origin, direction, extent) => {
      const terrain = terrainRay(origin, direction, extent), at = segmentSphere(origin, direction, extent, debris, .25);
      if (at === null || (terrain && terrain.distance < at)) return terrain;
      const point = add(origin, mul(direction, at));
      return { point, normal: normalize(sub(point, debris)), distance: at, material: 1 };
    };
    const contacts: V3[] = [];
    for (const index of [3, 5, 7]) {
      debris = clear.points[index]; world.version++;
      const before = simulation.checkpoint();
      const goal = simulation.solveAimTarget(0, target);
      expect(goal).toEqual(intended);
      expect(simulation.checkpoint()).toEqual(before);
      const preview = simulation.previewPrediction(0);
      expect(preview.hit).toBe(true);
      contacts.push(preview.points.at(-1)!);
      expect(distance(contacts.at(-1)!, debris)).toBeCloseTo(.25, 5);
      expect(distance(contacts.at(-1)!, target)).toBeGreaterThan(1);
    }
    expect(distance(contacts[0], contacts[1])).toBeGreaterThan(.1);
    const expectedImpact = contacts.at(-1)!;
    simulation.fire(0);
    let actualImpact: V3 | null = null;
    for (let tick = 0; tick < 480 && !actualImpact; tick++) {
      for (const event of simulation.step(FIXED_DT)) if (event.type === 'impact') actualImpact = event.position;
    }
    expect(actualImpact).not.toBeNull();
    expect(distance(actualImpact!, expectedImpact)).toBeLessThan(1e-5);
  });
});
