import type { Q4, V3 } from '../contracts';
import { clamp, cross, distance, dot, normalize, rotate, sub, tangent, wrapAngle } from '../math';

export interface AimTargetAim { yaw: number; pitch: number; power: number }
export const TANK_TARGET_RADIUS = 0.7;
export interface AimTargetCollider { shape: 'sphere'; center: V3; radius: number }
/** Geometry is supplied by the visible picking result, never discovered by the solver from hidden world objects. */
export interface AimSelection {
  point: V3;
  object?: { id: string; kind: 'tank' | 'object'; collider: AimTargetCollider; rotation?: Q4 };
  /** Presentation anchor on the committed planet surface. Dynamic body revisions do not move this bearing. */
  terrain?: { version: number; direction: V3 };
}
export interface AimTargetResult {
  readonly status: 'ready' | 'blocked' | 'unreachable' | 'invalid';
  /** Best tested candidate, even on failure; ready requires a precise path and actual target contact. */
  readonly aim: AimTargetAim | null;
  readonly target: V3;
  readonly point: V3 | null;
  /** Terrain endpoint error, or hypothetical path distance to the hovered point through the selected object. */
  readonly error: number;
  readonly hitTarget?: boolean;
  readonly traces: number;
  readonly steps: number;
}
export interface AimTargetTrace { point: V3; hit: boolean; steps: number; hitTarget?: boolean; nearest?: V3 }
export interface AimTargetEnvironment {
  position: V3;
  rotation: Q4;
  gravity: number;
  collider?: AimTargetCollider;
  speed(power: number): number;
  limits(yaw: number): { min: number; max: number };
  muzzle(aim: AimTargetAim): V3;
  /** Endpoint only, terrain/extensions only, never enemies. Must stop at the supplied integration budget. */
  trace(aim: AimTargetAim, remainingSteps: number): AimTargetTrace;
}
export const AIM_TARGET_BUDGET = Object.freeze({ traces: 24, steps: 3600, tolerance: 0.25, refinementTolerance: 0.05, objectRefinementTolerance: 0.004 });

export function invalidAimTarget(target: V3): AimTargetResult {
  return { status: 'invalid', aim: null, target: [...target], point: null, error: Infinity, hitTarget: false, traces: 0, steps: 0 };
}

/** Bounded, read-only shooting method. Analytic seeds find an arc; actual flight endpoints refine its yaw and power.
 * Every branch obeys the weapon's yaw-dependent elevation envelope, and every accepted solution is a real contact. */
export function solveAimTarget(env: AimTargetEnvironment, target: V3, previous?: AimTargetAim): AimTargetResult {
  if (!target.every(Number.isFinite) || !env.position.every(Number.isFinite) || !(env.gravity > 0)) return invalidAimTarget(target);
  const aimPoint = target;
  if (env.collider && (env.collider.shape !== 'sphere' || !env.collider.center.every(Number.isFinite) || !(env.collider.radius > 0) || !Number.isFinite(env.collider.radius))) return invalidAimTarget(target);
  const offset = sub(aimPoint, env.position), extent = distance(aimPoint, env.position);
  if (extent < 0.15) return invalidAimTarget(target);
  const up = rotate([0, 1, 0], env.rotation), left = rotate([1, 0, 0], env.rotation), forward = rotate([0, 0, 1], env.rotation);
  const bearing = Math.atan2(dot(offset, left), dot(offset, forward));
  const sourceUp = normalize(env.position), targetUp = normalize(aimPoint);
  const along = normalize(tangent(targetUp, sourceUp), forward), across = normalize(cross(sourceUp, along), left);
  const targetAngle = Math.atan2(dot(targetUp, along), dot(targetUp, sourceUp)), radius = Math.hypot(...aimPoint);
  let traces = 0, steps = 0;
  type Sample = { aim: AimTargetAim; point: V3; hit: boolean; hitTarget: boolean; error: number; residual: V3 };
  let best: Sample | null = null;
  const constrain = (aim: AimTargetAim): AimTargetAim => {
    const yaw = wrapAngle(aim.yaw), limits = env.limits(yaw);
    return { yaw, pitch: clamp(aim.pitch, limits.min, limits.max), power: clamp(aim.power, 0, 1) };
  };
  const evaluate = (candidate: AimTargetAim): Sample | null => {
    if (traces >= AIM_TARGET_BUDGET.traces || steps >= AIM_TARGET_BUDGET.steps) return null;
    const aim = constrain(candidate), trace = env.trace(aim, AIM_TARGET_BUDGET.steps - steps);
    traces++; steps += trace.steps;
    const direction = normalize(trace.point), nearest = trace.nearest ?? trace.point, hitTarget = trace.hitTarget === true;
    const error = env.collider ? distance(nearest, aimPoint) : distance(trace.point, target);
    const angle = Math.atan2(dot(direction, along), dot(direction, sourceUp));
    // Angular distance stays monotone around the curved planet, including beyond the tangent horizon.
    const sample: Sample = { aim, point: [...trace.point], hit: trace.hit, hitTarget, error,
      residual: env.collider ? sub(nearest, aimPoint) : [wrapAngle(angle - targetAngle) * radius, dot(direction, across) * radius, 0] };
    if (env.collider) {
      // A visible barrel/track can extend beyond its physical sphere. Preserve the exact hovered path;
      // pulling a miss back onto that sphere would turn fine cursor movement into unwanted aim snapping.
      if (!best || sample.error < best.error || (sample.error === best.error && hitTarget && !best.hitTarget)) best = sample;
    } else if (!best || (sample.hit && !best.hit) || (sample.hit === best.hit && sample.error < best.error)) best = sample;
    return sample;
  };
  const ready = () => best !== null && (env.collider ? best.hitTarget : best.hit) && best.error <= AIM_TARGET_BUDGET.tolerance;
  const converged = () => best !== null && (env.collider || best.hit)
    && best.error <= (env.collider ? AIM_TARGET_BUDGET.objectRefinementTolerance : AIM_TARGET_BUDGET.refinementTolerance);
  const powerForSpeed = (speed: number) => {
    if (speed <= env.speed(0)) return 0;
    if (speed >= env.speed(1)) return 1;
    let low = 0, high = 1;
    for (let i = 0; i < 18; i++) { const middle = (low + high) * 0.5; if (env.speed(middle) < speed) low = middle; else high = middle; }
    return (low + high) * 0.5;
  };
  const seed = (pitch: number): AimTargetAim => {
    const aim = constrain({ yaw: bearing, pitch, power: 0.5 });
    const delta = sub(aimPoint, env.muzzle(aim)), height = dot(delta, up), horizontal = Math.hypot(dot(delta, left), dot(delta, forward));
    const denominator = 2 * Math.cos(aim.pitch) ** 2 * (horizontal * Math.tan(aim.pitch) - height);
    aim.power = powerForSpeed(denominator > 1e-6 ? Math.sqrt(env.gravity * horizontal ** 2 / denominator) : env.speed(1));
    return aim;
  };
  const refine = (initial: AimTargetAim, iterations: number) => {
    let current = evaluate(initial);
    for (let iteration = 0; current && !converged() && (iteration < iterations || (current.error < 2 && iteration < iterations + 2)); iteration++) {
      const yawStep = 0.012, powerStep = current.aim.power < 0.96 ? 0.025 : -0.025;
      const y = evaluate({ ...current.aim, yaw: current.aim.yaw + yawStep });
      if (!y || converged()) break;
      const p = evaluate({ ...current.aim, power: current.aim.power + powerStep });
      if (!p || converged()) break;
      const jy = y.residual.map((value, axis) => (value - current!.residual[axis]) / yawStep) as V3;
      const jp = p.residual.map((value, axis) => (value - current!.residual[axis]) / powerStep) as V3;
      const a = dot(jy, jy), b = dot(jy, jp), d = dot(jp, jp), determinant = a * d - b * b;
      // A wall gives nearly identical endpoints over power changes. Try another arc instead of amplifying noise.
      if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-4) break;
      const ry = dot(jy, current.residual), rp = dot(jp, current.residual);
      const yaw = clamp((-ry * d + b * rp) / determinant, -0.22, 0.22);
      const power = clamp((b * ry - a * rp) / determinant, -0.22, 0.22);
      if (Math.abs(yaw) < 1e-5 && Math.abs(power) < 1e-5) break;
      current = evaluate({ ...current.aim, yaw: current.aim.yaw + yaw, power: current.aim.power + power });
    }
  };
  if (previous && [previous.yaw, previous.pitch, previous.power].every(Number.isFinite) && Math.abs(wrapAngle(previous.yaw - bearing)) < 0.6)
    refine(previous, 2);
  // Low trajectory first, then a lob over intervening terrain, then the minimum-elevation near-target branch.
  const elevation = Math.atan2(dot(offset, up), Math.hypot(dot(offset, left), dot(offset, forward)));
  const limits = env.limits(bearing);
  for (const pitch of [Math.max(elevation + 0.6, targetAngle > 0.8 ? 0.3 : -Infinity), 1.1, limits.min + 0.025]) {
    if (converged() || traces >= AIM_TARGET_BUDGET.traces || steps >= AIM_TARGET_BUDGET.steps) break;
    refine(seed(pitch), 3);
  }
  const selected = best as Sample | null;
  if (!selected) return invalidAimTarget(target);
  const short = selected.hit && distance(env.position, selected.point) < extent - 0.5 && selected.aim.power < 0.98;
  return { status: ready() ? 'ready' : short ? 'blocked' : 'unreachable', aim: { ...selected.aim }, target: [...target],
    point: [...selected.point], error: selected.error, hitTarget: selected.hitTarget, traces, steps };
}
