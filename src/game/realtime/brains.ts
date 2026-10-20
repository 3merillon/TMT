/** Realtime brains v1 (docs/architecture.md). A brain sees only its team's knowledge (sight contacts and
 * last-known positions), decides at 5 Hz and returns an order; the match steers toward the order's goal every tick,
 * runs the automatic coax and admits at most one aim solve per tick across all brains. Deterministic: every random
 * draw comes from the unit's seeded stream. */
import type { TankState, V3 } from '../contracts';
import type { AimTargetAim } from '../rules/aim-target';
import { add, distance, dot, frame, mul, normalize, sub, tangent, wrapAngle } from '../math';
import type { DifficultyTuning } from './rules';

export type RealtimeBrainId = 'dummy' | 'patrol' | 'rustling' | 'rusty' | 'tosser' | 'ally' | 'hornet' | 'bulwark' | 'vex';
export const REALTIME_BRAINS: readonly RealtimeBrainId[] = Object.freeze(['dummy', 'patrol', 'rustling', 'rusty', 'tosser', 'ally', 'hornet', 'bulwark', 'vex']);

/** An enemy as the brain's team knows it: seen now, or last seen `age` seconds ago at `position`. */
export interface KnownEnemy { readonly id: number; readonly position: V3; readonly velocity?: V3; readonly visible: boolean; readonly age: number }

export interface BrainView {
  readonly tick: number;
  readonly self: TankState;
  readonly radius: number;
  /** Known enemies, nearest first. */
  readonly enemies: readonly KnownEnemy[];
  /** The tank an `ally` brain follows (the player), when alive. */
  readonly leader: TankState | null;
  readonly reloadReady: boolean;
  /** Patrol route as surface points. */
  readonly waypoints: readonly V3[];
  readonly tuning: DifficultyTuning;
  random(): number;
  /** A ballistic aim at `target`, or null when no arc reaches it or this tick's solve budget is spent. `lob`
   * prefers the high arc. */
  solve(target: V3, lob: boolean): AimTargetAim | null;
}

/** What the unit does until its next decision. */
export interface BrainOrder {
  /** Surface point to drive to; null holds position. */
  goal: V3 | null;
  /** Back away from `goal` instead of driving to it. */
  reverse?: boolean;
  /** Point the turret at this point (the coax engages within its arc). */
  face?: V3 | null;
  /** Aim to apply now; `fire` fires the main gun after aiming. */
  aim?: AimTargetAim;
  fire?: boolean;
}
export const HOLD: BrainOrder = Object.freeze({ goal: null });

export interface RealtimeBrain { readonly id: RealtimeBrainId; decide(view: BrainView): BrainOrder }

/** A point `distance` along the surface from `from`, `bearing` radians off the direction to `toward` (toward the
 * planet's local left for positive bearings), lifted onto the sphere of `from`. */
export function offsetAlong(from: V3, toward: V3, bearing: number, distanceU: number): V3 {
  const up = normalize(from), radius = Math.hypot(...from);
  const ahead = normalize(tangent(sub(toward, from), up), frame(up, 0).forward);
  const left = normalize(add(mul(ahead, Math.cos(bearing)), mul(normalize(cross3(up, ahead)), Math.sin(bearing))));
  const angle = distanceU / radius;
  return mul(normalize(add(mul(up, Math.cos(angle)), mul(left, Math.sin(angle)))), radius);
}
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The order's aim with the difficulty's seeded spread (no hidden accuracy rules beyond this). */
function spread(view: BrainView, aim: AimTargetAim, scale = 1): AimTargetAim {
  const t = view.tuning;
  return { yaw: wrapAngle(aim.yaw + (view.random() * 2 - 1) * t.yawSpread * scale), pitch: aim.pitch,
    power: Math.max(0, Math.min(1, aim.power + (view.random() * 2 - 1) * t.powerSpread * scale)) };
}

/** Shared gunnery: remember when a contact appeared, wait the reaction delay, then aim and fire on reload. */
class Gunner {
  private contact = -1;
  private since = 0;
  /** An aim at `target` once the reaction delay has passed since `enemy` became the target, else null. */
  shot(view: BrainView, enemy: KnownEnemy, lob: boolean, scale = 1): AimTargetAim | null {
    if (this.contact !== enemy.id) { this.contact = enemy.id; this.since = view.tick; }
    if (!view.reloadReady || view.tick - this.since < view.tuning.reactionTicks) return null;
    const aim = view.solve(enemy.position, lob);
    return aim ? spread(view, aim, scale) : null;
  }
  forget(): void { this.contact = -1; }
}

class Dummy implements RealtimeBrain {
  readonly id = 'dummy' as const;
  decide(): BrainOrder { return HOLD; }
}

class Patrol implements RealtimeBrain {
  readonly id = 'patrol' as const;
  private index = 0;
  decide(view: BrainView): BrainOrder {
    if (!view.waypoints.length) return HOLD;
    if (distance(view.self.position, view.waypoints[this.index % view.waypoints.length]) < 1.6) this.index = (this.index + 1) % view.waypoints.length;
    return { goal: view.waypoints[this.index % view.waypoints.length] };
  }
}

/** Swarm: charge the nearest known enemy and circle it at about 3 u; the coax does the damage. */
class Rustling implements RealtimeBrain {
  readonly id = 'rustling' as const;
  private side = 0;
  decide(view: BrainView): BrainOrder {
    const enemy = view.enemies[0];
    if (!enemy || enemy.age > 20) return view.waypoints.length ? { goal: view.waypoints[0] } : HOLD;
    if (this.side === 0) this.side = view.random() < 0.5 ? -1 : 1;
    const range = distance(view.self.position, enemy.position);
    const goal = range > 4.5 ? enemy.position : offsetAlong(enemy.position, view.self.position, this.side * 1.2, 3);
    return { goal, face: enemy.position };
  }
}

/** Line tank: close to 8–14 u of a known enemy, fire on reload, back off when crowded. */
class Rusty implements RealtimeBrain {
  readonly id = 'rusty' as const;
  private readonly gunner = new Gunner();
  decide(view: BrainView): BrainOrder {
    const enemy = view.enemies.find(e => e.visible) ?? view.enemies.find(e => e.age < 8);
    if (!enemy) { this.gunner.forget(); return view.waypoints.length ? { goal: view.waypoints[0] } : HOLD; }
    const range = distance(view.self.position, enemy.position);
    const order: BrainOrder = range > 14 ? { goal: enemy.position, face: enemy.position }
      : range < 6 ? { goal: enemy.position, reverse: true, face: enemy.position } : { goal: null, face: enemy.position };
    if (enemy.visible && range <= 22) {
      const aim = this.gunner.shot(view, enemy, false);
      if (aim) { order.aim = aim; order.fire = true; }
    }
    return order;
  }
}

/** Artillery: hold 12–20 u, lob high arcs at seen or recently seen enemies, shift position every two shots. */
class Tosser implements RealtimeBrain {
  readonly id = 'tosser' as const;
  private readonly gunner = new Gunner();
  private shots = 0;
  private relocate: { goal: V3; until: number } | null = null;
  decide(view: BrainView): BrainOrder {
    if (this.relocate && view.tick < this.relocate.until && distance(view.self.position, this.relocate.goal) > 1.5) return { goal: this.relocate.goal };
    this.relocate = null;
    const enemy = view.enemies.find(e => e.visible) ?? view.enemies.find(e => e.age < 8);
    if (!enemy) { this.gunner.forget(); return HOLD; }
    const range = distance(view.self.position, enemy.position);
    const order: BrainOrder = range > 20 ? { goal: enemy.position, face: enemy.position }
      : range < 12 ? { goal: enemy.position, reverse: true, face: enemy.position } : { goal: null, face: enemy.position };
    if (range <= 24) {
      // An old sighting is a guess: the spread widens with its age.
      const aim = this.gunner.shot(view, enemy, true, enemy.visible ? 1 : 1 + enemy.age * 0.25);
      if (aim) {
        order.aim = aim; order.fire = true;
        if (++this.shots % 2 === 0) {
          const side = view.random() < 0.5 ? -1 : 1;
          this.relocate = { goal: offsetAlong(view.self.position, enemy.position, side * Math.PI / 2, 5), until: view.tick + 180 };
        }
      }
    }
    return order;
  }
}

/** Wingman: stay near the leader, fight what the team can see within reach of the leader. */
class Ally implements RealtimeBrain {
  readonly id = 'ally' as const;
  private readonly gunner = new Gunner();
  decide(view: BrainView): BrainOrder {
    const leader = view.leader;
    const enemy = view.enemies.find(e => e.visible && distance(view.self.position, e.position) <= 18);
    const order: BrainOrder = { goal: null };
    if (leader && distance(view.self.position, leader.position) > 5) order.goal = offsetAlong(leader.position, view.self.position, 0.6, 2.5);
    if (enemy) {
      order.face = enemy.position;
      const aim = this.gunner.shot(view, enemy, false);
      if (aim) { order.aim = aim; order.fire = true; }
    } else this.gunner.forget();
    return order;
  }
}

export function createRealtimeBrain(id: RealtimeBrainId): RealtimeBrain {
  switch (id) {
    case 'dummy': return new Dummy();
    case 'patrol': return new Patrol();
    case 'rustling': return new Rustling();
    case 'rusty': return new Rusty();
    case 'tosser': return new Tosser();
    case 'ally': return new Ally();
    case 'hornet': return new Rustling();
    case 'bulwark': case 'vex': return new Rusty();
  }
}

/** Throttle and steer that drive `self` toward `goal` (or away from it), slowing on arrival. The chassis convention:
 * local +X is driver-left, a positive bearing is to the left, and steer +1 turns right. */
export function steerToward(self: Pick<TankState, 'position' | 'rotation'>, goal: V3 | null, reverse = false, rotateFn: (v: V3, q: TankState['rotation']) => V3): { throttle: number; steer: number } {
  if (!goal) return { throttle: 0, steer: 0 };
  const delta = sub(goal, self.position), range = Math.hypot(...delta);
  if (!reverse && range < 1.2) return { throttle: 0, steer: 0 };
  const forward = rotateFn([0, 0, 1], self.rotation), left = rotateFn([1, 0, 0], self.rotation);
  const bearing = Math.atan2(dot(delta, left), dot(delta, forward));
  const steer = Math.max(-1, Math.min(1, -bearing * 2));
  // Back away while still facing the goal: the front armour stays toward the threat.
  if (reverse) return { throttle: -0.8, steer };
  // Pivot hard turns in place; slow on arrival.
  const throttle = Math.abs(bearing) > 1.2 ? 0.15 : Math.min(1, 0.35 + range / 6) * (1 - Math.min(0.6, Math.abs(bearing) / 2));
  return { throttle, steer };
}
