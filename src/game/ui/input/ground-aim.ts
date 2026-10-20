import type { TankState, V3 } from '../../contracts';
import type { AimSelection, AimTargetAim, AimTargetCollider, AimTargetResult } from '../../rules/aim-target';
import type { Point } from './mouse';

/** Move the requested point shorter/farther along the same planet bearing, then put it back on terrain.
 * The untrimmed point stays exact, including a point picked on a wall. No enemy queries are involved. */
export function trimGroundTarget(origin: V3, target: V3, scale: number, surface: (direction: V3) => V3 | null): V3 {
  if (scale === 1 || !Number.isFinite(scale) || scale <= 0) return [...target];
  const a = Math.hypot(...origin), b = Math.hypot(...target);
  if (a < 1e-8 || b < 1e-8) return [...target];
  const up = origin.map(v => v / a), end = target.map(v => v / b);
  const cosine = Math.max(-1, Math.min(1, up.reduce((sum, v, i) => sum + v * end[i], 0)));
  const tangent = end.map((v, i) => v - up[i] * cosine), length = Math.hypot(...tangent);
  if (length < 1e-7) return [...target];
  const angle = Math.min(Math.PI - .01, Math.acos(cosine) * scale);
  const direction = up.map((v, i) => v * Math.cos(angle) + tangent[i] / length * Math.sin(angle)) as V3;
  return surface(direction) ?? [...target];
}

export interface GroundAimFeedback {
  target: V3;
  status: AimTargetResult['status'] | 'solving';
  error: number;
  collider?: AimTargetCollider;
  objectId?: string;
}

export interface GroundAimDeps {
  enabled(): boolean;
  tank(): TankState | undefined;
  pick(point: Point): AimSelection | null;
  resolve(selection: AimSelection): AimSelection | null;
  surface(direction: V3): V3 | null;
  surfaceVersion(): number;
  revision(): string;
  solve(target: AimSelection, previous?: AimTargetAim): AimTargetResult;
  aim(aim: AimTargetAim): boolean;
  show(result: GroundAimFeedback | null): void;
}

export const AIM_RESPONSE = { solveIntervalMs: 1000 / 30, response: 14, yawRate: 6, pitchRate: 4, powerRate: 3 } as const;
const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Aim commands follow the solution continuously. The firing command always uses this actual barrel pose. */
export function approachTargetAim(current: AimTargetAim, goal: AimTargetAim, dt: number): AimTargetAim {
  const time = Math.max(0, Math.min(.05, dt)), blend = 1 - Math.exp(-AIM_RESPONSE.response * time);
  const step = (difference: number, rate: number) => Math.max(-rate * time, Math.min(rate * time, difference * blend));
  return { yaw: wrap(current.yaw + step(wrap(goal.yaw - current.yaw), AIM_RESPONSE.yawRate)),
    pitch: current.pitch + step(goal.pitch - current.pitch, AIM_RESPONSE.pitchRate),
    power: current.power + step(goal.power - current.power, AIM_RESPONSE.powerRate) };
}

/** Picking and barrel motion run every frame; expensive trajectory search runs at most 30 Hz.
 * Releasing the mouse retains the chosen world target, so a click works even before the barrel arrives. */
export class GroundAimController {
  private pointer: Point | null = null;
  private pendingPoint = false;
  private held = false;
  private selection: AimSelection | null = null;
  private target: AimSelection | null = null;
  private selectedCollider?: AimTargetCollider;
  private rangeScale = 1;
  private previous?: AimTargetAim;
  private key = '';
  private lastSolve = -Infinity;
  private lastFrame?: number;
  private result: AimTargetResult | null = null;
  private calls = 0;
  private solveMs = 0;

  constructor(private readonly deps: GroundAimDeps) {}

  point(point: Point): void {
    if (!point.every(Number.isFinite)) return;
    if (!this.held) { this.rangeScale = 1; this.key = ''; this.lastSolve = -Infinity; }
    this.held = true;
    this.pointer = [...point];
    this.pendingPoint = true;
  }

  release(): void { this.held = false; if (!this.pendingPoint) this.pointer = null; }

  /** Keyboard/touch target cycling enters the same tracking and ballistic aiming path as a world click. */
  select(selection: AimSelection): void {
    if (!this.deps.enabled() || !selection.point.every(Number.isFinite)) return;
    this.clear();
    this.selection = structuredClone(selection);
    this.lastSolve = -Infinity;
  }

  selectedObjectId(): string | undefined { return this.selection?.object?.id; }

  /** Recoil and a newly excavated crater must not move a held cursor's chosen place. A fresh drag resumes picking. */
  shotFired(): void {
    this.pointer = null; this.pendingPoint = false;
    if (this.target) this.selection = structuredClone(this.target);
    this.rangeScale = 1;
  }

  adjustRange(scale: number): boolean {
    if (!this.held || !this.deps.enabled() || !Number.isFinite(scale) || scale <= 0) return false;
    this.rangeScale = Math.max(.25, Math.min(4, this.rangeScale * scale));
    if (Math.abs(this.rangeScale - 1) < 1e-8) this.rangeScale = 1;
    return true;
  }

  update(now: number, flush = false): void {
    const dt = this.lastFrame === undefined ? 1 / 60 : Math.max(0, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!this.deps.enabled()) { this.clear(); return; }
    const tank = this.deps.tank();
    if (this.pointer) {
      this.selection = this.deps.pick(this.pointer);
      this.pendingPoint = false;
      if (!this.held) this.pointer = null;
    } else if (this.selection) this.selection = this.deps.resolve(this.selection);
    if (!tank || !this.selection) {
      this.target = null; this.result = null; this.previous = undefined; this.selectedCollider = undefined; this.key = '';
      this.deps.show(null); return;
    }
    const target: AimSelection = this.rangeScale === 1 ? this.selection : {
      point: trimGroundTarget(tank.position, this.selection.point, this.rangeScale, this.deps.surface),
    };
    if (this.rangeScale !== 1) {
      const radius = Math.hypot(...target.point);
      if (radius > 1e-8) target.terrain = { version: this.deps.surfaceVersion(), direction: target.point.map(v => v / radius) as V3 };
    }
    this.target = target;
    this.selectedCollider = target.object?.collider;
    // Ignore sub-millimetre noise, but never skip visual cursor or turret updates between solver calls.
    const key = [...target.point, ...tank.position, ...tank.rotation,
      ...(target.object ? [...target.object.collider.center, target.object.collider.radius] : [])]
      .map(v => Math.round(v * 1000)).join(',')
      + `/${target.object?.id ?? ''}/${tank.id}/${tank.munition}/${JSON.stringify(tank.kit ?? tank.loadout)}/${this.deps.revision()}`;
    if (key !== this.key && (flush || now - this.lastSolve >= AIM_RESPONSE.solveIntervalMs - .01)) {
      this.key = key; this.lastSolve = now;
      const started = performance.now();
      this.result = this.deps.solve(target, this.previous);
      this.solveMs = performance.now() - started; this.calls++;
      this.previous = this.result.aim ? { ...this.result.aim } : undefined;
    }
    if (this.result?.aim && !flush) {
      const current = { yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power };
      const next = approachTargetAim(current, this.result.aim, dt);
      if (Math.abs(wrap(next.yaw - current.yaw)) + Math.abs(next.pitch - current.pitch) + Math.abs(next.power - current.power) > 1e-6)
        this.deps.aim(next);
    }
    const targetChange = this.result ? Math.hypot(...target.point.map((v, i) => v - this.result!.target[i])) : Infinity;
    this.deps.show({ target: target.point, collider: target.object?.collider, objectId: target.object?.id,
      status: targetChange > .25 ? 'solving' : this.result?.status ?? 'solving', error: this.result?.error ?? Infinity });
  }

  collider(): AimTargetCollider | undefined { return this.selectedCollider; }

  clear(): void {
    this.pointer = null; this.pendingPoint = false; this.held = false; this.selection = null; this.selectedCollider = undefined;
    this.target = null; this.previous = undefined; this.rangeScale = 1; this.key = ''; this.result = null; this.lastFrame = undefined;
    this.deps.show(null);
  }

  snapshot() {
    return { active: this.held, tracking: !!this.selection, pointer: this.pointer ? [...this.pointer] : null, rangeScale: this.rangeScale,
      selection: this.selection ? structuredClone(this.selection) : null, solveMs: this.solveMs, calls: this.calls,
      result: this.result ? { ...this.result, target: [...this.result.target],
        point: this.result.point ? [...this.result.point] : null, aim: this.result.aim ? { ...this.result.aim } : null } : null };
  }
}
