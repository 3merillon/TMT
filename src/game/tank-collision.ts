/** The tank's rigid collision envelope (kit proxies + running-gear envelope) and a SAT penetration diagnostic.
 * The Rapier chassis (resident-tanks, W1-PHY) builds its colliders from `tankHullBoxes`; the legacy kinematic
 * motion solver that swept these boxes was removed in W1-GAME. */
import type { Loadout, Q4, TerrainQueryBounds, TerrainTriangle, V3, WorldQuery } from './contracts';
import { add, cross, dot, length, mul, multiplyRotations, rotate, sub } from './math';
import { getTankStats } from './modules';
import { TankBeltPath } from './tank-belt-path';
import { assembleLegacy, kitTrackHalfLength, kitTrunnionPivot, V1_PROXY } from './kit/assembly';
import { END_GEAR_PROXY_HALF, SUSPENSION_TRAVEL_SCALE, WHEEL_SUPPORT_RADIUS } from './kit/dimensions';
import type { KitAssembly } from './kit/types';

export interface TankCollisionPose { position: V3; rotation: Q4; turretYaw?: number; barrelPitch?: number; wheelSuspension?: number[]; treadContacts?: number[]; treadTerrain?: [number, number][][] }
interface HullBox { center: V3; half: V3; rotation?: Q4; barrel?: boolean; turret?: boolean; wheel?: boolean; endGear?: boolean }
interface OrientedBox extends TerrainQueryBounds { center: V3; half: V3; axes: [V3, V3, V3]; barrel?: boolean; turret?: boolean; wheel?: boolean; endGear?: boolean }
interface PreparedTriangle extends TerrainTriangle, TerrainQueryBounds { edges: [V3, V3, V3] }
interface Separation { gap: number; normal: V3 }
const AXIS_EPSILON = 1e-10;
const MAX_CANDIDATES = 512;
/** Belt solvers per running gear. Their shape depends on the current inputs only, so sharing is safe. */
const beltPaths = new Map<string, [TankBeltPath, TankBeltPath]>();
function beltPathsFor(kit: KitAssembly): [TankBeltPath, TankBeltPath] {
  let paths = beltPaths.get(kit.loadout.runningGear);
  if (!paths) {
    const halfLength = kitTrackHalfLength(kit);
    paths = [new TankBeltPath(halfLength), new TankBeltPath(halfLength)];
    beltPaths.set(kit.loadout.runningGear, paths);
  }
  return paths;
}

/**
 * Encloses the rigid belly, fenders, turret and raised track ends without putting a box under the wheels.
 * The static boxes come from the kit assembly's proxies (in their joint frames); the running-gear envelope
 * follows the suspension and belt take-up.
 */
export function tankHullBoxes(loadout: Loadout, pose: Pick<TankCollisionPose, 'turretYaw' | 'barrelPitch' | 'wheelSuspension' | 'treadContacts' | 'treadTerrain'> = {}): readonly HullBox[] {
  getTankStats(loadout); // Throws for an invalid or over-budget loadout, as before.
  const kit = assembleLegacy(loadout), running = kit.running, proxies = kit.proxies;
  const halfTrackWidth = running.trackWidth * .5;
  const trackHalfLength = kitTrackHalfLength(kit);
  const yaw = pose.turretYaw ?? 0, pitch = pose.barrelPitch ?? 0;
  const turretRotation: Q4 = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const barrelRotation = multiplyRotations(turretRotation, [Math.sin(-pitch / 2), 0, 0, Math.cos(pitch / 2)]);
  const trunnion = kitTrunnionPivot(kit);
  const pivot = add(trunnion.axisPoint, rotate([0, 0, trunnion.forward], turretRotation));
  // Cradle-frame boxes pitch with the barrel but do not recoil.
  const barrel = (index: number): HullBox => {
    const box = proxies[index].box;
    return { center: add(pivot, rotate(box.center, barrelRotation)), half: [...box.half], rotation: barrelRotation, barrel: true };
  };
  const runningGear: HullBox[] = [];
  for (let side = 0; side < 2; side++) {
    const x = side === 0 ? running.halfSpacing : -running.halfSpacing;
    const heights = Array.from({ length: 4 }, (_, wheel) => running.stations[side * 4 + wheel].y0
      + Math.max(-running.droop, Math.min(running.compression, ((pose.wheelSuspension?.[side * 4 + wheel] ?? .5) - .5) * SUSPENSION_TRAVEL_SCALE)));
    const bottom = Math.min(...heights) - WHEEL_SUPPORT_RADIUS, top = Math.max(...heights) + WHEEL_SUPPORT_RADIUS;
    const path = beltPathsFor(kit)[side];
    path.update(heights, pose.treadContacts?.slice(side * 9, side * 9 + 9), pose.treadTerrain?.[side]);
    const fender = proxies[V1_PROXY.fender[side]].box;
    runningGear.push(
      { center: [x, (bottom + top) / 2, 0], half: [halfTrackWidth, (top - bottom) / 2, trackHalfLength], wheel: true },
      { center: [x, running.idler.y, path.circles[4].z], half: [halfTrackWidth, END_GEAR_PROXY_HALF, END_GEAR_PROXY_HALF], endGear: true },
      { center: [x, running.sprocket.y, running.sprocket.z], half: [halfTrackWidth, END_GEAR_PROXY_HALF, END_GEAR_PROXY_HALF], endGear: true },
      { center: [...fender.center], half: [...fender.half] },
    );
    // The end wheels round upward. Extending the lowest wheel's square bank
    // corner beyond them catches the back of a crater lip even when the actual
    // raised wheel/belt is clear. Four circumscribed arc slabs per end preserve
    // the complete wheel envelope while using each end wheel's own suspension.
    for (const end of [-1, 1]) for (let slab = 0; slab < 4; slab++) {
      const near = WHEEL_SUPPORT_RADIUS * Math.sin(slab * Math.PI / 8), far = WHEEL_SUPPORT_RADIUS * Math.sin((slab + 1) * Math.PI / 8);
      runningGear.push({ center: [x, heights[end < 0 ? 0 : 3], end * (trackHalfLength + (near + far) / 2)],
        half: [halfTrackWidth, WHEEL_SUPPORT_RADIUS * Math.cos(slab * Math.PI / 8), (far - near) / 2], wheel: true });
    }
  }
  const hull = proxies[V1_PROXY.hull].box, armor = proxies[V1_PROXY.armor].box, turret = proxies[V1_PROXY.turret].box;
  return [
    { center: [...hull.center], half: [...hull.half] },
    { center: [...armor.center], half: [...armor.half], rotation: [...armor.rotation!] },
    ...runningGear,
    { center: add(kit.frames.turretRing.position, rotate(turret.center, turretRotation)), half: [...turret.half], rotation: [...turretRotation] as Q4, turret: true },
    barrel(V1_PROXY.breech),
    barrel(V1_PROXY.sleeve),
    barrel(V1_PROXY.shaft),
  ];
}

function boxesAt(pose: TankCollisionPose, shapes: readonly HullBox[]): OrientedBox[] {
  const axes: [V3, V3, V3] = [rotate([1, 0, 0], pose.rotation), rotate([0, 1, 0], pose.rotation), rotate([0, 0, 1], pose.rotation)];
  return shapes.map(shape => {
    const orientation = shape.rotation ? multiplyRotations(pose.rotation, shape.rotation) : undefined;
    const localAxes: [V3, V3, V3] = orientation ? [rotate([1, 0, 0], orientation), rotate([0, 1, 0], orientation), rotate([0, 0, 1], orientation)] : axes;
    const center = add(pose.position, rotate(shape.center, pose.rotation));
    const extent = center.map((_, dimension) => localAxes.reduce((sum, axis, index) => sum + Math.abs(axis[dimension]) * shape.half[index], 0)) as V3;
    return { center, half: shape.half, axes: localAxes, min: sub(center, extent), max: add(center, extent), barrel: shape.barrel, turret: shape.turret, wheel: shape.wheel, endGear: shape.endGear };
  });
}
function axisAt(box: OrientedBox, triangle: PreparedTriangle, index: number): V3 {
  if (index < 3) return box.axes[index];
  if (index === 3) return triangle.normal;
  return cross(triangle.edges[Math.floor((index - 4) / 3)], box.axes[(index - 4) % 3]);
}
function project(box: OrientedBox, triangle: PreparedTriangle, axis: V3): { low: number; high: number; radius: number } {
  const center = dot(box.center, axis);
  const a = dot(triangle.a, axis) - center, b = dot(triangle.b, axis) - center, c = dot(triangle.c, axis) - center;
  return { low: Math.min(a, b, c), high: Math.max(a, b, c),
    radius: box.half[0] * Math.abs(dot(box.axes[0], axis)) + box.half[1] * Math.abs(dot(box.axes[1], axis)) + box.half[2] * Math.abs(dot(box.axes[2], axis)) };
}
/** Triangle/OBB SAT includes the three box axes, triangle normal and all nine edge-cross axes. */
function separation(box: OrientedBox, triangle: PreparedTriangle, stopWhenSeparated = false, clearThreshold = Infinity): Separation {
  let gap = -Infinity, normal: V3 = triangle.normal;
  // The world axes are also valid SAT directions. Most candidates are separated
  // on one of these cheap bounds, avoiding thirteen detailed projections.
  for (let dimension = 0; dimension < 3; dimension++) {
    const before = triangle.min[dimension] - box.max[dimension], after = box.min[dimension] - triangle.max[dimension];
    if (before > gap) { gap = before; normal = [0, 0, 0]; normal[dimension] = -1; }
    if (after > gap) { gap = after; normal = [0, 0, 0]; normal[dimension] = 1; }
  }
  if (stopWhenSeparated && gap >= 0 || gap >= clearThreshold) return { gap, normal };
  for (let index = 0; index < 13; index++) {
    const raw = axisAt(box, triangle, index);
    const size = length(raw); if (size < AXIS_EPSILON) continue;
    const axis = mul(raw, 1 / size), p = project(box, triangle, axis);
    const before = p.low - p.radius, after = -p.high - p.radius;
    if (before > gap) { gap = before; normal = mul(axis, -1); }
    if (after > gap) { gap = after; normal = axis; }
    if (stopWhenSeparated && gap >= 0 || gap >= clearThreshold) return { gap, normal };
  }
  return { gap, normal };
}

function prepare(triangles: TerrainTriangle[]): PreparedTriangle[] {
  return triangles.map(triangle => ({ ...triangle, edges: [sub(triangle.b, triangle.a), sub(triangle.c, triangle.b), sub(triangle.a, triangle.c)],
    min: triangle.a.map((value, dimension) => Math.min(value, triangle.b[dimension], triangle.c[dimension])) as V3,
    max: triangle.a.map((value, dimension) => Math.max(value, triangle.b[dimension], triangle.c[dimension])) as V3 }));
}

function compoundBounds(boxes: readonly OrientedBox[], padding = 0): TerrainQueryBounds {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], box.min[axis] - padding);
    max[axis] = Math.max(max[axis], box.max[axis] + padding);
  }
  return { min, max };
}

/** Maximum SAT overlap depth for diagnostics/tests; zero means no surface cuts the rigid envelope. */
export function tankHullPenetration(world: WorldQuery, pose: TankCollisionPose, loadout: Loadout): number {
  if (!world.queryTriangles) return 0;
  const shapes = tankHullBoxes(loadout, pose), boxes = boxesAt(pose, shapes);
  const query = world.queryTriangles(compoundBounds(boxes), MAX_CANDIDATES);
  if (query.overflow) return Infinity;
  let penetration = 0;
  const triangles = prepare(query.triangles);
  for (const box of boxes) for (const triangle of triangles) penetration = Math.max(penetration, -separation(box, triangle, true).gap);
  return penetration;
}
