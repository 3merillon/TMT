/** The tank's rigid envelope (tankHullBoxes) and the SAT penetration diagnostic against synthetic triangles.
 * Rapier wall pressure and pushing are covered by tests/vehicle-contact.test.ts; crater escape by tests/vehicle-recovery.test.ts. */
import { describe, expect, it } from 'vitest';
import type { Loadout, TerrainTriangle, V3, WorldQuery } from '../src/game/contracts';
import { DEFAULT_LOADOUT } from '../src/game/modules';
import { rotation } from '../src/game/math';
import { tankHullBoxes, tankHullPenetration, type TankCollisionPose } from '../src/game/tank-collision';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';
import { kitTrunnionPivot } from '../src/game/kit/assembly';

/** A vertical wall x = at (normal -X), two triangles spanning y ∈ [15, 25] and z ∈ [-5, 5]. */
function wall(at: number, material = 3): TerrainTriangle[] {
  const normal: V3 = [-1, 0, 0];
  return [
    { a: [at, 15, -5], b: [at, 25, -5], c: [at, 25, 5], normal, material },
    { a: [at, 15, -5], b: [at, 25, 5], c: [at, 15, 5], normal, material },
  ];
}
function floor(y: number): TerrainTriangle[] {
  const normal: V3 = [0, 1, 0];
  return [
    { a: [-5, y, -5], b: [-5, y, 5], c: [5, y, 5], normal, material: 1 },
    { a: [-5, y, -5], b: [5, y, 5], c: [5, y, -5], normal, material: 1 },
  ];
}
function triangleWorld(triangles: TerrainTriangle[], overflow = false): WorldQuery {
  const overlaps = (t: TerrainTriangle, min: V3, max: V3) => [0, 1, 2].every(axis =>
    Math.max(t.a[axis], t.b[axis], t.c[axis]) >= min[axis] && Math.min(t.a[axis], t.b[axis], t.c[axis]) <= max[axis]);
  return { radius: 18, version: 1, raycast: () => null, surface: () => null, isSolid: () => false,
    queryTriangles: (bounds, maximum) => {
      const inside = triangles.filter(t => overlaps(t, bounds.min, bounds.max));
      return { triangles: inside.slice(0, maximum), overflow: overflow || (maximum !== undefined && inside.length > maximum) };
    } };
}
const pose = (position: V3, extra: Partial<TankCollisionPose> = {}): TankCollisionPose => ({ position, rotation: rotation([0, 1, 0], 0), turretYaw: 0, barrelPitch: 0, ...extra });

describe('rigid tank envelope', () => {
  it('builds the static proxies, the two running-gear envelopes and the articulated turret and barrel boxes', () => {
    const boxes = tankHullBoxes(DEFAULT_LOADOUT);
    // hull + armor, per side: envelope, 2 end gears, fender, 8 end-arc slabs; turret; breech, sleeve, shaft.
    expect(boxes).toHaveLength(2 + 2 * 12 + 1 + 3);
    expect(boxes.filter(box => box.barrel)).toHaveLength(3);
    expect(boxes.filter(box => box.turret)).toHaveLength(1);
    expect(boxes.filter(box => box.endGear)).toHaveLength(4);
    for (const box of boxes) expect([...box.center, ...box.half].every(Number.isFinite)).toBe(true);
    expect(() => tankHullBoxes({ tracks: 'grip', barrel: 'rail', armor: 'heavy' })).toThrow('Invalid or over-budget gameplay loadout');
  });

  it('pitches the barrel boxes about the kit trunnion and yaws the turret box with the turret', () => {
    const trunnion = kitTrunnionPivot(assembleKit(kitLoadoutFromLegacy(DEFAULT_LOADOUT)));
    const pivot: V3 = [trunnion.axisPoint[0], trunnion.axisPoint[1], trunnion.axisPoint[2] + trunnion.forward];
    const reach = (center: V3) => Math.hypot(center[0] - pivot[0], center[1] - pivot[1], center[2] - pivot[2]);
    const level = tankHullBoxes(DEFAULT_LOADOUT, { barrelPitch: 0 }).filter(box => box.barrel);
    const raised = tankHullBoxes(DEFAULT_LOADOUT, { barrelPitch: Math.PI / 4 }).filter(box => box.barrel);
    for (let index = 0; index < 3; index++) {
      // Every barrel box keeps its distance to the trunnion pivot while it elevates.
      expect(reach(raised[index].center)).toBeCloseTo(reach(level[index].center), 10);
      // Kit v2's mantlet box is a solid of revolution centred on the trunnion axis: elevation only turns it in place.
      if (reach(level[index].center) < 1e-6) expect(raised[index].rotation).not.toEqual(level[index].rotation);
      else expect(raised[index].center[1]).toBeGreaterThan(level[index].center[1]);
    }
    expect(level.some(box => reach(box.center) > .1)).toBe(true);
    const ahead = tankHullBoxes(DEFAULT_LOADOUT, { turretYaw: 0 }).find(box => box.turret)!;
    const turned = tankHullBoxes(DEFAULT_LOADOUT, { turretYaw: Math.PI / 2 }).find(box => box.turret)!;
    expect(turned.rotation).not.toEqual(ahead.rotation);
  });

  it('lowers the running-gear envelope with suspension droop and raises it under compression', () => {
    const envelope = (value: number) => tankHullBoxes(DEFAULT_LOADOUT, { wheelSuspension: Array(8).fill(value) }).find(box => box.wheel)!;
    expect(envelope(0).center[1]).toBeLessThan(envelope(.5).center[1]);
    expect(envelope(1).center[1]).toBeGreaterThan(envelope(.5).center[1]);
  });
});

describe('SAT penetration diagnostic', () => {
  const at: V3 = [0, 20, 0];
  const bodyHalfWidth = () => Math.max(...tankHullBoxes(DEFAULT_LOADOUT).filter(box => !box.barrel && !box.turret).map(box => Math.abs(box.center[0]) + box.half[0]));

  it('reports zero for a clear pose and for analytic worlds without triangle queries', () => {
    expect(tankHullPenetration(triangleWorld(wall(3)), pose(at), DEFAULT_LOADOUT)).toBe(0);
    expect(tankHullPenetration({ radius: 18, version: 0, raycast: () => null, surface: () => null, isSolid: () => false }, pose(at), DEFAULT_LOADOUT)).toBe(0);
  });

  it('measures a wall cutting the hull by at most its overlap depth', () => {
    // SAT depth against a thin face is the smaller push-out of the two sides of each box, so it never exceeds the cut.
    const depth = tankHullPenetration(triangleWorld(wall(bodyHalfWidth() - .1)), pose(at), DEFAULT_LOADOUT);
    expect(depth).toBeGreaterThan(.05);
    expect(depth).toBeLessThan(.1 + 1e-9);
    expect(tankHullPenetration(triangleWorld(wall(bodyHalfWidth() + .01)), pose(at), DEFAULT_LOADOUT)).toBe(0);
  });

  it.each(['cannon', 'rail'] as const)('detects the %s barrel only when the turret aims it into the wall', barrel => {
    const loadout: Loadout = { ...DEFAULT_LOADOUT, barrel };
    const world = triangleWorld(wall(bodyHalfWidth() + .2));
    expect(tankHullPenetration(world, pose(at, { turretYaw: 0 }), loadout)).toBe(0);
    // +X is driver-left; yaw +π/2 swings the level barrel across the wall.
    expect(tankHullPenetration(world, pose(at, { turretYaw: Math.PI / 2 }), loadout)).toBeGreaterThan(0);
  });

  it('reports a floor inside the belly but not one just below the running gear', () => {
    const lowest = Math.min(...tankHullBoxes(DEFAULT_LOADOUT).map(box => box.center[1] - box.half[1]));
    expect(tankHullPenetration(triangleWorld(floor(at[1] + lowest - .01)), pose(at), DEFAULT_LOADOUT)).toBe(0);
    expect(tankHullPenetration(triangleWorld(floor(at[1] + lowest + .05)), pose(at), DEFAULT_LOADOUT)).toBeGreaterThan(.04);
  });

  it('never claims a clear pose from an incomplete bounded query', () => {
    expect(tankHullPenetration(triangleWorld(wall(3), true), pose(at), DEFAULT_LOADOUT)).toBe(Infinity);
  });
});
