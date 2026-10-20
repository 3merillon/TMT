/** Analytic test planet (W1-GAME): a radius-18 sphere with optional spherical craters and a 30-line kinematic
 * `stepTanks`. The chassis holds its surface pose and slides at the commanded speed, so rules tests (turns, radar,
 * observations, checkpoints, ammo, AI) run without Rapier. Vehicle handling is tested on Rapier by W1-PHY. */
import type { DriveInput, TankState, TerrainHit, V3, WorldQuery } from '../../src/game/contracts';
import type { TerrainTransactions } from '../../src/gpu/terrain/transactions';
import { add, clamp, distance, dot, frame, mul, normalize, rotation, sub, tangent, wrapAngle } from '../../src/game/math';
import { assembleKit, tankKit } from '../../src/game/kit';
import { ROOT_SURFACE_LIFT, TRACK_HALF_SPACING } from '../../src/game/kit/dimensions';
import { testMatchLifecycle, testBallistics, testCombat } from './native-match';

/** Pivot rate at full steer (rad/s); right steer (+1) yaws negatively, as on the real chassis. */
export const KINEMATIC_TURN_RATE = 1.6;

export class SphereWorld implements WorldQuery {
  createMatchLifecycle = testMatchLifecycle;
  createBallistics = testBallistics;
  createCombat = testCombat;
  readonly radius = 18;
  version = 0;
  craters: { center: V3; radius: number }[] = [];
  /** Kinematic chassis; set to false to leave tanks exactly where a test put them. */
  kinematic = true;
  /** Non-blocking terrain edits (tests/helpers/fake-transactions.ts); absent = the serial compatibility path. */
  transactions?: TerrainTransactions;

  get crater(): { center: V3; radius: number } | null { return this.craters[0] ?? null; }
  set crater(value: { center: V3; radius: number } | null) { this.craters = value ? [value] : []; }

  isSolid(point: V3): boolean {
    return dot(point, point) < this.radius * this.radius && this.craters.every(crater => distance(point, crater.center) > crater.radius);
  }

  surface(direction: V3): TerrainHit | null {
    const up = normalize(direction);
    return this.raycast(mul(up, this.radius + 10), mul(up, -1), this.radius * 2 + 20);
  }

  raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    if (maxDistance <= 0) return null;
    const candidates: { t: number; crater: { center: V3; radius: number } | null }[] = [];
    const roots = (center: V3, radius: number, crater: { center: V3; radius: number } | null) => {
      const offset = sub(origin, center);
      const b = dot(offset, direction);
      const discriminant = b * b - (dot(offset, offset) - radius * radius);
      if (discriminant < 0) return;
      for (const t of [-b - Math.sqrt(discriminant), -b + Math.sqrt(discriminant)]) if (t >= 0 && t <= maxDistance) candidates.push({ t, crater });
    };
    roots([0, 0, 0], this.radius, null);
    for (const crater of this.craters) roots(crater.center, crater.radius, crater);
    candidates.sort((a, b) => a.t - b.t);
    for (const { t, crater } of candidates) {
      if (this.isSolid(add(origin, mul(direction, t - 1e-5))) === this.isSolid(add(origin, mul(direction, t + 1e-5)))) continue;
      const point = add(origin, mul(direction, t));
      return { point, normal: crater ? mul(normalize(sub(point, crater.center)), -1) : normalize(point), distance: t, material: 1 };
    }
    return null;
  }

  stepTanks(tanks: TankState[], inputs: readonly DriveInput[], dt: number): void {
    if (!this.kinematic) return;
    for (const tank of tanks) {
      const input = inputs[tank.id] ?? { throttle: 0, steer: 0 };
      const throttle = clamp(input.throttle, -1, 1), steer = clamp(input.steer, -1, 1);
      tank.recoil *= Math.exp(-6 * dt);
      if (throttle === 0 && steer === 0) {
        if (tank.trackSpeeds.some(speed => speed !== 0)) { tank.trackSpeeds = [0, 0]; tank.trackGroundSpeeds = [0, 0]; tank.velocity = [0, 0, 0]; tank.yawVelocity = 0; }
        continue;
      }
      const speed = throttle * assembleKit(tankKit(tank)).stats.speed, yawRate = -steer * KINEMATIC_TURN_RATE;
      const up = normalize(tank.position), forward = frame(up, wrapAngle(tank.heading + yawRate * dt)).forward;
      const next = normalize(add(tank.position, mul(forward, speed * dt)));
      const ground = this.surface(next)?.point ?? mul(next, this.radius);
      const moved = normalize(tangent(forward, next)), axes = frame(next, 0);
      tank.heading = Math.atan2(dot(moved, axes.right), dot(moved, axes.forward));
      tank.position = add(ground, mul(next, ROOT_SURFACE_LIFT));
      tank.rotation = rotation(next, tank.heading);
      tank.velocity = mul(moved, speed); tank.yawVelocity = yawRate;
      // Driver-left belt first; a right turn (negative yaw) drives the left belt faster.
      tank.trackSpeeds = [speed - yawRate * TRACK_HALF_SPACING, speed + yawRate * TRACK_HALF_SPACING];
      tank.trackGroundSpeeds = [...tank.trackSpeeds]; tank.trackSlip = [0, 0]; tank.trackContact = [.5, .5];
      for (let side = 0; side < 2; side++) tank.trackPhases[side] += tank.trackSpeeds[side] * dt;
      tank.trackPhase = (tank.trackPhases[0] + tank.trackPhases[1]) * .5;
    }
  }
}
