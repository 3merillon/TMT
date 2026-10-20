/** Relocation (Experience §1.15 step 5): 12 endpoints within fuel, scored for cover against the believed threat
 * positions, height, slope (< 25°) and crater lips (never stop inside a hole), then pure-pursuit steering with stuck
 * recovery. Time-sliced on the observation's metered world queries. */
import type { BotObservation } from '../api/bot';
import type { DriveInput, TankState, V3 } from '../contracts';
import { add, clamp, distance, dot, frame, mul, normalize, sub, tangent, wrapAngle } from '../math';
import type { BrainRandom } from './random';
import type { BrainParams } from './profiles';

export const ENDPOINTS = 12;
export const MAX_SLOPE = 25 * Math.PI / 180;
const EYE = .8;

export interface Endpoint { position: V3; covered: number; height: number; slope: number; score: number }

/** A point `distance` u along the surface from `position` at world heading `bearing` (radians in frame(up, 0)). */
export function surfaceStep(position: V3, bearing: number, distance: number): V3 {
  const up = normalize(position), axes = frame(up, 0), angle = distance / Math.hypot(...position);
  const heading = add(mul(axes.forward, Math.cos(bearing)), mul(axes.right, Math.sin(bearing)));
  return normalize(add(mul(up, Math.cos(angle)), mul(heading, Math.sin(angle))));
}

export class RelocationPlanner {
  private readonly bearings: number[] = [];
  private readonly distances: number[] = [];
  private cursor = 0;
  private pending: { direction: V3; distance: number; point: V3 | null; normalDot: number; threat: number; covered: number } | null = null;
  readonly endpoints: Endpoint[] = [];
  target: V3 | null = null;
  done = false;

  /** `reach` is the shooter's effective range: endpoints farther than it from every threat are penalised, so a cover
   * seeker never scoots out of its own firing envelope. */
  constructor(private readonly self: TankState, private readonly params: BrainParams, private readonly threats: readonly V3[], random: BrainRandom, fuel: number,
    private readonly reach = Infinity) {
    const { min, max } = params.relocate, drive = Math.max(.5, fuel * .85), offset = random.next() * 2 * Math.PI / ENDPOINTS;
    for (let i = 0; i < ENDPOINTS; i++) {
      this.bearings.push(offset + i * 2 * Math.PI / ENDPOINTS);
      this.distances.push(Math.min(drive, min + (max - min) * random.next()));
    }
    if (params.relocate.random) { this.bearings.length = 1; this.distances.length = 1; }
  }

  /** Evaluate endpoints while the tick's budget lasts. True once a target is chosen. */
  step(o: BotObservation, budget: { traceSteps: number }): boolean {
    const start = Math.hypot(...this.self.position) - o.world.radius;
    while (!this.done) {
      if (!this.pending) {
        if (this.cursor >= this.bearings.length) { this.finish(); break; }
        if (budget.traceSteps < 1) return false;
        const direction = surfaceStep(this.self.position, this.bearings[this.cursor], this.distances[this.cursor]);
        const hit = o.world.surface(direction);
        this.pending = { direction, distance: this.distances[this.cursor], point: hit?.point ?? null, normalDot: hit ? dot(hit.normal, normalize(hit.point)) : 0, threat: 0, covered: 0 };
        this.cursor++;
      }
      const pending = this.pending;
      if (pending.point && !this.params.relocate.random && pending.threat < this.threats.length) {
        if (budget.traceSteps < 1) return false;
        const threat = this.threats[pending.threat++];
        const from = add(threat, mul(normalize(threat), EYE)), to = add(pending.point, mul(normalize(pending.point), EYE)), span = distance(from, to);
        if (o.world.raycast(from, normalize(sub(to, from)), Math.max(0, span - .2))) pending.covered++;
        continue;
      }
      this.pending = null;
      if (!pending.point) continue;
      const slope = Math.acos(clamp(pending.normalDot, -1, 1)), height = Math.hypot(...pending.point) - o.world.radius;
      const covered = this.threats.length ? pending.covered / this.threats.length : 0;
      const hole = Math.max(0, start - height - .35);
      const nearest = this.threats.reduce((best, threat) => Math.min(best, distance(threat, pending.point!)), Infinity);
      const outOfReach = Number.isFinite(nearest) ? Math.max(0, nearest - this.reach) : 0;
      const score = slope > MAX_SLOPE ? -Infinity
        : this.params.relocate.cover * covered + this.params.relocate.height * height - 1.5 * hole - .6 * outOfReach
          - .02 * Math.abs(pending.distance - (this.params.relocate.min + this.params.relocate.max) / 2);
      this.endpoints.push({ position: add(pending.point, mul(normalize(pending.point), .55)), covered, height, slope, score });
    }
    return true;
  }

  private finish(): void {
    this.done = true;
    const best = this.endpoints.filter(endpoint => Number.isFinite(endpoint.score)).sort((a, b) => b.score - a.score)[0];
    this.target = best?.position ?? null;
  }
}

/** Pure-pursuit steering toward a surface point, with stuck recovery: 45 ticks of commanded throttle without 0.1 u of
 * progress reverse briefly (a deliberate pivot in place never counts as stuck). */
export class Pursuit {
  private anchor: { position: V3; tick: number } | null = null;
  private reverseUntil = -1;
  constructor(readonly target: V3) {}
  drive(self: TankState, tick: number): DriveInput {
    const up = normalize(self.position), axes = frame(up, 0);
    const delta = tangent(sub(this.target, self.position), up), range = Math.hypot(...delta);
    if (range < .6) return { throttle: 0, steer: 0 };
    if (tick < this.reverseUntil) return { throttle: -.8, steer: 0 };
    const desired = Math.atan2(dot(delta, axes.right), dot(delta, axes.forward));
    const error = wrapAngle(desired - self.heading);
    // Right steer (+1) yaws negatively: a positive heading error steers left. A large error pivots in place and the
    // approach slows down, so the turning circle never orbits the endpoint.
    const throttle = Math.abs(error) > .8 ? 0 : clamp(range / 1.5, .35, 1), steer = -clamp(error * 1.8, -1, 1);
    if (throttle === 0) this.anchor = null;
    else if (!this.anchor) this.anchor = { position: [...self.position], tick };
    else if (tick - this.anchor.tick >= 45) {
      const stuck = distance(this.anchor.position, self.position) < .1;
      this.anchor = stuck ? null : { position: [...self.position], tick };
      if (stuck) { this.reverseUntil = tick + 30; return { throttle: -.8, steer: 0 }; }
    }
    return { throttle, steer };
  }
}
