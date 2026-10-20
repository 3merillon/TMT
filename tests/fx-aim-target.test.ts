import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../src/engine/frame/camera';
import { aimTargetStatusText, cycleVisibleTankAimTarget, pickTerrainAimPoint, pickAimSelection, resolveAimSelection, visibleTankAimProxies, type AimTargetProxy, type RequestedAimTarget } from '../src/game/presentation/aim-target';
import { normalize, mul } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import { SphereWorld } from './helpers/sphere-world';
import { TANK_TARGET_RADIUS, type AimSelection } from '../src/game/rules/aim-target';
import { GameSimulation } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';

describe('ground target picking', () => {
  it.each([false, true])('round-trips visible terrain points through the exact rendered projection (view offset %s)', narrow => {
    const world = new SphereWorld(), camera = new Camera();
    for (const frame of [0, 1, 7]) {
      camera.update({ position: [0, 27, -13], target: [0, 18, 0], up: [0, 1, 0], fovY: 47 * Math.PI / 180,
        viewOffset: narrow ? [800, 1000, 0, 160] : undefined }, [800, 600], [1200, 900], true, frame);
      for (const direction of [[0, 1, 0], [.15, 1, -.08], [-.12, 1, -.1], [0, 1, .15]] as V3[]) {
        const expected = mul(normalize(direction), world.radius), screen = camera.project(expected);
        expect(screen.visible).toBe(true);
        const actual = pickTerrainAimPoint(camera, world, [screen.x, screen.y]);
        expect(actual).not.toBeNull();
        expect(Math.hypot(...actual!.map((value, i) => value - expected[i]))).toBeLessThan(1e-7);
      }
    }
  });

  it('returns null for sky and malformed/off-canvas coordinates without inventing a target', () => {
    const world = new SphereWorld(), camera = new Camera();
    camera.update({ position: [0, 26, -13], target: [0, 35, -20], up: [0, 1, 0], fovY: .8 }, [800, 600], [800, 600], false, 0);
    for (const point of [[400, 300], [-1, 300], [801, 300], [400, -1], [400, 601], [NaN, 100]] as [number, number][])
      expect(pickTerrainAimPoint(camera, world, point)).toBeNull();
  });

  it('uses only the first terrain-world intersection and copies the returned point', () => {
    const camera = new Camera(), point: V3 = [0, 18, 0];
    camera.update({ position: [0, 26, -13], target: point, up: [0, 1, 0], fovY: .8 }, [800, 600], [800, 600], false, 0);
    let calls = 0;
    const result = pickTerrainAimPoint(camera, { radius: 18, raycast(origin, direction, extent) {
      calls++; expect(origin).toEqual([0, 26, -13]); expect(Math.hypot(...direction)).toBeCloseTo(1, 10); expect(extent).toBeGreaterThan(60);
      return { point, normal: [0, 1, 0], distance: 15, material: 1 };
    } }, [400, 300]);
    expect(calls).toBe(1); expect(result).toEqual(point); expect(result).not.toBe(point);
  });
});

describe('retained terrain anchors', () => {
  const camera = () => {
    const result = new Camera();
    result.update({ position: [0, 27, -13], target: [0, 18, 0], up: [0, 1, 0], fovY: .8 }, [800, 600], [800, 600], false, 0);
    return result;
  };

  it('rebases the selected bearing once onto a committed crater floor, then stays exact between commits', () => {
    const world = new SphereWorld(), pick = pickAimSelection(camera(), world, [400, 300])!;
    expect(pick.terrain?.version).toBe(0);
    expect(pick.terrain!.direction[1]).toBeCloseTo(1, 12);
    const original = structuredClone(pick), query = vi.spyOn(world, 'surface');
    world.crater = { center: [0, 18, 0], radius: 2 }; world.version++;
    let retained = resolveAimSelection(pick, [], world)!;
    expect(retained.terrain?.version).toBe(1); expect(retained.point[1]).toBeCloseTo(16, 10);
    expect(retained.terrain?.direction).toEqual(pick.terrain?.direction);
    for (let frame = 0; frame < 120; frame++) retained = resolveAimSelection(retained, [], world)!;
    expect(query).toHaveBeenCalledTimes(1); expect(retained.point[1]).toBeCloseTo(16, 10);
    expect(pick).toEqual(original);
    world.crater.radius = 3; world.version++;
    retained = resolveAimSelection(retained, [], world)!;
    expect(query).toHaveBeenCalledTimes(2); expect(retained.point[1]).toBeCloseTo(15, 10);
    expect(retained.terrain?.version).toBe(2);
  });

  it('preserves exact wall points and ignores falling-body revisions and noisy radial queries', () => {
    const fixed = new SphereWorld(), query = vi.spyOn(fixed, 'surface');
    const world = { ...fixed, version: 100, footprintSurface: fixed, surface: vi.fn(() => null) };
    let retained: AimSelection = { point: [3, 19, 1], terrain: { version: 0, direction: normalize([3, 19, 1]) } };
    const exact = structuredClone(retained);
    for (let frame = 0; frame < 120; frame++) { world.version++; retained = resolveAimSelection(retained, [], world)!; }
    expect(retained).toEqual(exact); expect(query).not.toHaveBeenCalled(); expect(world.surface).not.toHaveBeenCalled();
    fixed.version++;
    retained = resolveAimSelection(retained, [], world)!;
    expect(query).toHaveBeenCalledOnce(); expect(world.surface).not.toHaveBeenCalled();
    expect(Math.hypot(...retained.point)).toBeCloseTo(18, 10);
    expect(retained.terrain?.version).toBe(1);
  });

  it('clears a removed surface instead of aiming into space or the opposite side of a through-hole', () => {
    const pick = pickAimSelection(camera(), new SphereWorld(), [400, 300])!;
    expect(resolveAimSelection(pick, [], { version: 1, surface: () => null })).toBeNull();
    expect(resolveAimSelection(pick, [], { version: 1, surface: () => ({ point: [0, -18, 0], normal: [0, -1, 0], distance: 40, material: 1 }) })).toBeNull();
    // No shared cache survives a dropped selection or changes a fresh cursor pick.
    const world = new SphereWorld(); world.version = 1;
    const fresh = pickAimSelection(camera(), world, [420, 300])!;
    expect(fresh.terrain?.version).toBe(1); expect(fresh.terrain?.direction).not.toEqual(pick.terrain?.direction);
    expect(resolveAimSelection(fresh, [], world)).toEqual(fresh);
  });
});

describe('visible object selection', () => {
  const proxy = (id: string, center: V3, kind: 'tank' | 'object' = 'tank'): AimTargetProxy => ({ id, kind,
    collider: { shape: 'sphere', center, radius: TANK_TARGET_RADIUS } });

  it('cycles nearest-first, wraps, and excludes allies, hidden contacts and wrecks', () => {
    const simulation = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const state = simulation.state, original = state.tanks[1];
    state.tanks[0].position = [0, 18, 0]; state.tanks[0].team = 0;
    state.tanks = [state.tanks[0], ...[6, 2, 4, 1, 0.5, 0.25].map((distance, index) => ({ ...structuredClone(original), id: index + 1,
      team: index === 3 ? 0 : 1, position: [distance, 18, 0] as V3, health: index === 5 ? 0 : 100 }))];
    const visible = (tank: typeof original) => tank.id !== 5;
    let selected = cycleVisibleTankAimTarget(state, 0, visible)!;
    expect(selected.object?.id).toBe('tank:2');
    expect(selected.point).not.toEqual(selected.object?.collider.center);
    for (const id of ['tank:3', 'tank:1', 'tank:2']) {
      selected = cycleVisibleTankAimTarget(state, 0, visible, selected.object!.id)!;
      expect(selected.object?.id).toBe(id);
    }
    state.tanks[2].health = 0;
    expect(cycleVisibleTankAimTarget(state, 0, visible, 'tank:2')!.object?.id).toBe('tank:3');
    expect(cycleVisibleTankAimTarget(state, 0, () => false)).toBeNull();
    expect(cycleVisibleTankAimTarget(state, 0, visible, 'component:3:turret')!.object?.id).toBe('tank:1');
  });

  it('uses rendered tank poses and omits self, hidden enemies and destroyed tanks', () => {
    const simulation = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const state = simulation.state, prev = structuredClone(state.tanks), curr = structuredClone(state.tanks);
    prev[1].position = [1, 18.4, 0]; curr[1].position = [3, 18.4, 0];
    const selected = visibleTankAimProxies(state, 0, () => true, { alpha: .25, prev, curr });
    expect(selected).toEqual([{ ...proxy('tank:1', [1.5, 18.4, 0]), rotation: state.tanks[1].rotation }]);
    expect(visibleTankAimProxies(state, 0, tank => tank.id === 0)).toEqual([]);
    state.tanks[1].health = 0;
    expect(visibleTankAimProxies(state, 0, () => true)).toEqual([]);
  });

  it('selects the nearest supplied tank/object sphere, while nearer terrain blocks the pick', () => {
    const camera = new Camera(), world = new SphereWorld();
    camera.update({ position: [0, 24, -10], target: [0, 18.4, 0], up: [0, 1, 0], fovY: .8 }, [800, 600], [800, 600], false, 0);
    const ray = camera.unproject(400, 300, 0).direction;
    const at = (distance: number): V3 => camera.eye.map((value, i) => value + ray[i] * distance) as V3;
    const tank = proxy('tank:1', [0, 18.4, 0]), object = proxy('crate:1', at(8), 'object');
    const nearest = pickAimSelection(camera, world, [400, 300], [tank, object])!;
    expect(nearest.object?.id).toBe('crate:1'); expect(nearest.object?.kind).toBe('object');
    expect(Math.hypot(...nearest.point.map((value, i) => value - at(8)[i]))).toBeCloseTo(TANK_TARGET_RADIUS, 9);
    const chosenTank = pickAimSelection(camera, world, [400, 300], [tank])!;
    expect(chosenTank.object?.id).toBe('tank:1');
    chosenTank.object!.collider.center[0] = 99; expect(tank.collider.center[0]).toBe(0);
    const wall = { radius: 18, raycast: () => ({ point: at(3), normal: [0, 1, 0] as V3, distance: 3, material: 1 }) };
    expect(pickAimSelection(camera, wall, [400, 300], [tank, object])).toEqual({ point: at(3) });
    expect(pickAimSelection(camera, world, [400, 300], [])?.object).toBeUndefined();
  });

  it('refreshes a retained visible selection without jumping to ground, and drops hidden/removed objects', () => {
    const selection: AimSelection = { point: [0, 18.4, -.7], object: proxy('tank:1', [0, 18.4, 0]) };
    const moved = proxy('tank:1', [2, 19, 3]);
    const next = resolveAimSelection(selection, [moved])!;
    expect(next.point).toEqual([2, 19, 2.3]); expect(next.object?.id).toBe('tank:1');
    expect(next.object?.collider.center).not.toBe(moved.collider.center);
    expect(resolveAimSelection(selection, [])).toBeNull();
    expect(resolveAimSelection(selection, [proxy('tank:2', [2, 19, 3])])).toBeNull();
    const terrain: AimSelection = { point: [0, 18, 0] };
    const retained = resolveAimSelection(terrain, [])!;
    expect(retained).toEqual(terrain); expect(retained.point).not.toBe(terrain.point);
  });

  it('retains a clicked surface offset as the visible object turns', () => {
    const selection: AimSelection = { point: [1, 18.4, 0], object: { ...proxy('tank:1', [0, 18.4, 0]), rotation: [0, 0, 0, 1] } };
    const moved: AimTargetProxy = { ...proxy('tank:1', [3, 19, 0]), rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
    const next = resolveAimSelection(selection, [moved])!;
    expect(next.point[0]).toBeCloseTo(3, 10); expect(next.point[1]).toBe(19); expect(next.point[2]).toBeCloseTo(-1, 10);
    expect(next.object?.rotation).not.toBe(moved.rotation);
  });

  it('uses rendered surface contact instead of the collider shell, and never falls back after a mesh miss', () => {
    const camera = new Camera();
    camera.update({ position: [0, 2, -10], target: [0, 2, 0], up: [0, 1, 0], fovY: .8 }, [800, 600], [800, 600], false, 0);
    const object = proxy('tank:1', [0, 2, 0]), world = { radius: 18, raycast: () => null };
    const selection = pickAimSelection(camera, world, [400, 300], [object], () => 9.8)!;
    expect(selection.point).toEqual([0, 2, -.1999999999999993]);
    expect(selection.object?.collider.radius).toBe(.7);
    expect(pickAimSelection(camera, world, [400, 300], [object], () => null)).toBeNull();
    expect(pickAimSelection(camera, world, [400, 300], [object], () => undefined)?.object?.id).toBe(object.id);
  });
});

describe('requested target feedback', () => {
  const request: RequestedAimTarget = { point: [0, 18, 0], status: 'reachable', error: .2 };
  it('does not duplicate the landing label for a reachable target', () => {
    expect(aimTargetStatusText(request)).toBe('');
    expect(aimTargetStatusText({ ...request, status: 'solving' })).toBe('Finding arc…');
  });
  it('distinguishes a blocked shot from a target outside the launch envelope', () => {
    expect(aimTargetStatusText({ ...request, status: 'blocked', error: 1.25 })).toBe('Blocked · 1.3 m miss');
    expect(aimTargetStatusText({ ...request, status: 'out-of-range', error: Infinity })).toBe('Out of range');
    expect(aimTargetStatusText({ ...request, status: 'out-of-range', error: Infinity, collider: { shape: 'sphere', center: [0, 0, 0], radius: .7 } })).toBe('No clear hit');
  });
});
