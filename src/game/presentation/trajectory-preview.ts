import type { GameSnapshot, TankState, V3 } from '../contracts';
import { assembleKit, tankKit } from '../kit';

const MAX_POINTS = 512;
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const copy = (p: readonly number[]): V3 => [p[0], p[1], p[2]];

/** Free drive keeps aiming at the next shot while the previous projectile or crater is resolving. */
export function trajectoryPreviewAllowed(state: Pick<GameSnapshot, 'phase' | 'active'>, observer: number, freeDrive = false): boolean {
  return state.phase !== 'finished' && (freeDrive || state.phase === 'aim' && state.active === observer);
}

/** The simulation counter-rotates turretYaw every driving tick to hold a planet bearing. Pose and angles therefore
 * invalidate the predictor cache but must NOT invalidate interpolation history. Small deliberate aim changes use
 * the same one-tick interpolation as the tank; a different weapon/power/target must respond immediately. */
export function trajectoryPreviewKeys(state: Pick<GameSnapshot, 'tick' | 'phase' | 'active'>, tank: TankState,
  observer: number, terrainVersion: number | undefined, full: boolean, collisionVersion = terrainVersion): { identity: string; refresh: string } {
  const identity = `${state.phase}/${state.active}/${observer}/${tank.power}/${tank.munition}/${assembleKit(tankKit(tank)).key}/${terrainVersion}/${full}`;
  return { identity, refresh: `${state.tick}/${tank.turretYaw}/${tank.barrelPitch}/${tank.position.join(',')}/${tank.rotation.join(',')}/${collisionVersion}/${identity}` };
}

function arcLengths(points: readonly V3[]): number[] {
  const arc = [0];
  for (let i = 1; i < points.length; i++) arc.push(arc[i - 1] + distance(points[i], points[i - 1]));
  return arc;
}

/** Match neighbouring traces by travelled distance so an extra terminal sample does not make vertices jump. */
function align(points: readonly V3[], parameters: readonly number[]): V3[] {
  const arc = arcLengths(points), total = arc.at(-1) ?? 0;
  let segment = 0;
  return parameters.map(t => {
    const at = t * total;
    while (segment < points.length - 2 && arc[segment + 1] < at) segment++;
    const a = points[segment], b = points[Math.min(segment + 1, points.length - 1)];
    const f = Math.max(0, Math.min(1, (at - arc[segment]) / Math.max(1e-9, arc[segment + 1] - arc[segment])));
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  });
}

/** Presentation interpolation only. The predictor's points and actual terrain endpoint remain authoritative.
 * The view feeds at most one trace per simulation tick and renders at the same alpha as tank/camera motion.
 * Weapon, power, terrain and observer changes start a new identity. Angle changes follow the rendered gun's
 * one-tick interpolation, including automatic turret compensation while driving; there is no low-pass aim lag. */
export class TrajectoryPreview {
  private current: V3[] = [];
  private previous: V3[] = [];
  private output: V3[] = [];
  private parameters: number[] = [];
  private identity = '';
  private tick = -1;
  private span = 0;
  private sourceStep = 0;
  private renderedStep = 0;
  private muzzleError = 0;
  private anchorTarget = true;
  private lastRendered: V3 | null = null;

  set(points: readonly V3[], tick: number, identity: string, anchorTarget = true): void {
    if (points.length < 2 || points.some(p => p.length < 3 || !p.every(Number.isFinite))) { this.clear(); return; }
    const next = points.length > MAX_POINTS ? align(points, Array.from({ length: MAX_POINTS }, (_, i) => i / (MAX_POINTS - 1))) : points.map(copy);
    const arc = arcLengths(next), total = arc.at(-1)!;
    this.parameters = arc.map((length, i) => total > 1e-8 ? length / total : i / (next.length - 1));
    const old = this.current;
    this.sourceStep = old.length ? distance(next[0], old[0]) : 0;
    const samePath = old.length > 1 && this.identity === identity && tick > this.tick && tick - this.tick <= 6
      && this.sourceStep < 1
      && Math.abs(old.length - next.length) <= Math.max(2, next.length * .15)
      // A newly hit wall or a cleared obstruction must show its actual target immediately.
      && distance(next.at(-1)!, old.at(-1)!) <= Math.max(.5, total * .025);
    this.previous = samePath ? align(old, this.parameters) : next;
    this.span = samePath ? tick - this.tick : 0;
    this.current = next;
    this.anchorTarget = anchorTarget;
    this.tick = tick; this.identity = identity;
    while (this.output.length < next.length) this.output.push([0, 0, 0]);
    this.output.length = next.length;
  }

  render(alpha: number, muzzle: readonly number[] | null): V3[] {
    if (this.current.length < 2) return this.output;
    const fraction = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
    // A 30 fps render may skip two fixed ticks: interpolate only the final tick, like renderedPose does.
    const a = this.span ? 1 - (1 - fraction) / this.span : 1;
    const last = this.current.length - 1;
    const start = this.current[0].map((v, k) => this.previous[0][k] + (v - this.previous[0][k]) * a);
    const finish = this.current[last].map((v, k) => this.previous[last][k] + (v - this.previous[last][k]) * a);
    for (let i = 0; i <= last; i++) {
      const t = this.parameters[i], endWeight = t * t * (3 - 2 * t);
      for (let k = 0; k < 3; k++) {
        this.output[i][k] = this.previous[i][k] + (this.current[i][k] - this.previous[i][k]) * a
          + ((muzzle?.[k] ?? start[k]) - start[k]) * (1 - endWeight)
          + (this.anchorTarget ? this.current[last][k] - finish[k] : 0) * endWeight;
      }
    }
    // Exact endpoints avoid numerical drift and keep the marker on the predictor's world-space terrain hit.
    for (let k = 0; k < 3; k++) {
      this.output[0][k] = muzzle?.[k] ?? this.output[0][k];
      if (this.anchorTarget) this.output[last][k] = this.current[last][k];
    }
    this.renderedStep = this.lastRendered ? distance(this.output[0], this.lastRendered) : 0;
    this.lastRendered = copy(this.output[0]);
    this.muzzleError = muzzle ? distance(this.output[0], muzzle) : 0;
    return this.output;
  }

  stats(): { tick: number; points: number; source: V3 | null; rendered: V3 | null; target: V3 | null; sourceStep: number; renderedStep: number; muzzleError: number; interpolating: boolean; anchored: boolean } {
    return { tick: this.tick, points: this.current.length, source: this.current.length ? copy(this.current[0]) : null,
      rendered: this.output.length ? copy(this.output[0]) : null, target: this.current.length ? copy(this.current.at(-1)!) : null,
      sourceStep: this.sourceStep, renderedStep: this.renderedStep, muzzleError: this.muzzleError, interpolating: this.span > 0, anchored: this.anchorTarget };
  }

  clear(): void {
    this.current = []; this.previous = []; this.output = []; this.parameters = [];
    this.identity = ''; this.tick = -1; this.span = 0; this.lastRendered = null;
    this.sourceStep = this.renderedStep = this.muzzleError = 0;
  }
}
