/** A transported orbit follows the tank without inheriting steering or suspension roll. */
import type { TankState, V3, WorldQuery } from './contracts';
import { add, clamp, dot, mul, rotate, rotationBetweenUnitVectors, sub } from './math';
import { CameraPose, cameraUnit } from './presentation/camera-pose';

/** Constraints run in registration order after collision, before shake. */
export type CameraConstraint = (position: V3, target: V3) => V3;
const size = (v: V3) => Math.sqrt(dot(v, v));
const offset = (p: V3, direction: V3, amount: number): V3 => add(p, mul(direction, amount));
const copy = (out: V3, value: V3): void => { out[0] = value[0]; out[1] = value[1]; out[2] = value[2]; };
const lerp = (a: number, b: number, t: number) => (1 - t) * a + t * b;
const plane = (v: V3, normal: V3): V3 => {
  const denominator = dot(normal, normal);
  return denominator === 0 ? [...v] : sub(v, mul(normal, dot(normal, v) / denominator));
};

export function cameraClearanceRadius(camera: CameraPose): number {
  // Every near-plane corner must stay in air, including zoom and off-centre views.
  const p = camera.projectionMatrix;
  const x = camera.near * (1 + Math.abs(p[8])) / Math.abs(p[0]);
  const y = camera.near * (1 + Math.abs(p[9])) / Math.abs(p[5]);
  return Math.max(.28, Math.hypot(camera.near, x, y) + .05);
}
function cameraPointClear(point: V3, world: WorldQuery, radius: number): boolean {
  return !world.isSolid(point) && (!world.sweepSphere || world.sweepSphere(point, [0, 1, 0], 0, radius) === null);
}
/** A face-normal offset alone can still overlap an adjoining wall at a concave corner. */
function recoverCameraPoint(point: V3, up: V3, world: WorldQuery, radius: number, nearby: boolean): V3 {
  if (cameraPointClear(point, world, radius)) return point;
  if (nearby) for (const distance of [.35, .7, 1.4, 2.8, 5.6]) {
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue;
      const probe = offset(point, cameraUnit([x, y, z]), distance);
      if (cameraPointClear(probe, world, radius)) return probe;
    }
  }
  const radial = dot(point, point) > 1e-12 ? cameraUnit(point) : cameraUnit(up);
  const surface = world.surface(radial);
  if (surface) for (const extra of [.04, .25, .5, 1, 2, 4, 8, 16]) {
    const probe = offset(surface.point, surface.normal, radius + extra);
    if (cameraPointClear(probe, world, radius)) return probe;
  }
  // Search outward when a deeply engulfed focus cannot escape along one face normal.
  for (let distance = Math.max(world.radius, size(point), 1) + radius; distance < 1e6; distance *= 2) {
    const probe = mul(radial, distance);
    if (cameraPointClear(probe, world, radius)) return probe;
  }
  throw new Error('Unable to find terrain clearance for the camera');
}
/** Planet overview has an interior focus, so recover to the outer radial surface. */
export function keepOverviewOutsideTerrain(camera: CameraPose, world: WorldQuery): void {
  camera.position = recoverCameraPoint(camera.position, camera.up, world, cameraClearanceRadius(camera), false);
}
/** Throws on a non-finite constraint result (I3: no silent fallback). */
export function applyCameraConstraints(constraints: readonly CameraConstraint[], position: V3, target: V3): V3 {
  let p = position;
  for (const constraint of constraints) p = constraint(p, target);
  if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`A camera constraint returned an invalid position ${JSON.stringify(p)}`);
  return p;
}
export const CAMERA_SHAKE = { decay: 1.4, maxAngle: 0.035, maxOffset: 0.12 } as const;

export class TankFollowCamera {
  distance = 17;
  /** Screen-shake trauma in [0, 1]; shake amplitude is trauma². */
  trauma = 0;
  private elevation = Math.asin(.55);
  private heading: V3 = [0, 0, 0];
  private radial: V3 = [0, 1, 0];
  private previousUp: V3 = [0, 1, 0];
  private readonly focusPoint: V3 = [0, 0, 0];
  private initialized = false;
  private boom = 17;
  private lift = 0;
  private shakeTime = 0;

  constructor(private camera: CameraPose) {}
  get focus(): V3 { return this.focusPoint; }
  get effectiveDistance(): number { return this.boom; }
  get altitude(): number { return dot(sub(this.camera.position, this.focusPoint), this.radial); }
  get elevationAngle(): number { return this.elevation + this.lift; }
  zoom(deltaPixels: number): void {
    this.distance = clamp(this.distance * Math.exp(clamp(deltaPixels, -400, 400) * .0015), 6, 36);
  }
  orbit(dx: number, dy: number): void {
    const half = -dx * .005 / 2, s = Math.sin(half), axis = mul(this.radial, s);
    this.heading = rotate(this.heading, [axis[0], axis[1], axis[2], Math.cos(half)]);
    this.elevation = clamp(this.elevation + dy * .005, -Math.PI * .47, Math.PI * .47);
  }
  addTrauma(amount: number): void {
    if (Number.isFinite(amount)) this.trauma = clamp(this.trauma + amount, 0, 1);
  }
  private clearance(world: WorldQuery | undefined, origin: V3, direction: V3, distance: number, radius: number): number {
    if (!world) return distance;
    const hit = world.sweepSphere ? world.sweepSphere(origin, direction, distance, radius) : world.raycast(origin, direction, distance)?.distance;
    return hit == null ? distance : Math.max(0, hit - (world.sweepSphere ? .02 : radius));
  }
  update(tank: Pick<TankState, 'position' | 'rotation'>, target: V3, dt: number, snap = false, world?: WorldQuery, constraints: readonly CameraConstraint[] = []): void {
    const position = tank.position;
    this.radial = cameraUnit(position);
    if (dot(this.radial, this.radial) < .5) this.radial = [...this.previousUp];
    if (snap || !this.initialized) {
      this.heading = plane(rotate([0, 0, -1], tank.rotation), this.radial);
      if (dot(this.heading, this.heading) < 1e-8) this.heading = plane(Math.abs(this.radial[0]) < .9 ? [1, 0, 0] : [0, 0, 1], this.radial);
      this.heading = cameraUnit(this.heading); this.elevation = Math.asin(.55); this.lift = 0;
      this.boom = this.distance; this.initialized = true;
    } else {
      this.heading = cameraUnit(plane(rotate(this.heading, rotationBetweenUnitVectors(this.previousUp, this.radial)), this.radial));
    }
    this.previousUp = [...this.radial];
    // Rigid focus avoids frame-dependent driving lag. Only clearance recovery eases.
    copy(target, offset(position, this.radial, .85));
    const elapsed = clamp(dt, 0, .1), ease = 1 - Math.exp(-5 * elapsed);
    const radius = cameraClearanceRadius(this.camera);
    if (world) copy(target, recoverCameraPoint(target, this.radial, world, radius, true));
    copy(this.focusPoint, target);
    const aim = (elevation: number) => cameraUnit(add(mul(this.heading, Math.cos(elevation)), mul(this.radial, Math.sin(elevation))));
    let desiredLift = 0, direction = aim(this.elevation);
    let safe = this.clearance(world, target, direction, this.distance, radius);
    for (let angle = this.elevation + .15; safe < 3 && angle < Math.PI * .48; angle += .15) {
      const candidate = this.clearance(world, target, aim(angle), this.distance, radius);
      if (candidate > safe) { safe = candidate; desiredLift = angle - this.elevation; }
    }
    this.lift = desiredLift > this.lift ? desiredLift : lerp(this.lift, desiredLift, ease);
    this.lift = Math.min(this.lift, Math.PI * .48 - this.elevation);
    direction = aim(this.elevation + this.lift);
    safe = this.clearance(world, target, direction, this.distance, radius);
    this.boom = safe < this.boom || snap ? safe : lerp(this.boom, safe, ease);
    this.camera.position = offset(target, direction, this.boom);
    this.camera.up = [...this.radial];
    this.camera.lookAt(offset(this.camera.position, direction, -1));
    if (constraints.length) {
      const before: V3 = [...this.camera.position];
      const after = applyCameraConstraints(constraints, before, [...target]);
      if (!after.every((v, axis) => v === before[axis])) {
        this.camera.position = [...after];
        const delta = sub(after, target);
        if (dot(delta, delta) > 1e-12) this.camera.lookAt(target);
      }
    }
    this.applyShake(elapsed);
    // Constraints and positional shake can cross a wall after the first sweep.
    if (world) {
      const delta = sub(this.camera.position, target), distance = size(delta);
      if (distance > 1e-12) {
        const ray = mul(delta, 1 / distance);
        this.camera.position = offset(target, ray, this.clearance(world, target, ray, distance, radius));
      }
      if (!cameraPointClear(this.camera.position, world, radius)) this.camera.position = [...target];
    }
    this.camera.updateWorld();
  }
  private applyShake(dt: number): void {
    if (this.trauma <= 0) return;
    this.shakeTime += dt;
    const amount = this.trauma * this.trauma, t = this.shakeTime * 31;
    const n = (k: number) => Math.sin(t * (1 + k * .37) + k * 1.7) * .6 + Math.sin(t * (2.3 + k * .21) + k * 4.1) * .4;
    const right = rotate([1, 0, 0], this.camera.rotation), up = rotate([0, 1, 0], this.camera.rotation);
    this.camera.position = offset(offset(this.camera.position, right, n(1) * amount * CAMERA_SHAKE.maxOffset), up, n(2) * amount * CAMERA_SHAKE.maxOffset);
    this.camera.rotateLocal([0, 0, 1], n(3) * amount * CAMERA_SHAKE.maxAngle);
    this.camera.rotateLocal([1, 0, 0], n(4) * amount * CAMERA_SHAKE.maxAngle * .6);
    this.trauma = Math.max(0, this.trauma - CAMERA_SHAKE.decay * dt);
  }
}
