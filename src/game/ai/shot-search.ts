/** Shot search (Experience §1.15 step 3): a coarse (pitch × power) grid at the bearing of the aim point, each
 * candidate scored by expected splash damage over the target's belief minus self-damage and friendly-fire risk (and a
 * miss-distance tie-breaker), then golden-section refinement on power and a bearing correction for crosswind.
 * Time-sliced: every trace step comes from the observation's metered tracer, so a search spans as many ticks as its
 * budget needs. Pure over its inputs. */
import type { BallisticTrace, BotObservation } from '../api/bot';
import type { TankState, V3 } from '../contracts';
import { clamp, distance, dot, normalize, rotate, sub, tangent } from '../math';
import { munitionStats, type MunitionId } from '../munitions';
import type { KitAssembly } from '../kit/types';
import type { TargetBelief } from './belief';
import type { BrainParams } from './profiles';

const TANK_RADIUS = 0.7;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

export interface ShotChoice { yaw: number; pitch: number; power: number; impact: V3 | null; score: number; miss: number }
export interface SearchInput {
  self: TankState; kit: KitAssembly; munition: MunitionId; params: BrainParams;
  /** Where the shell should land (the target centroid after the bracketing correction). */
  aimPoint: V3; target: TargetBelief;
  /** Friendly tanks to spare (the shooter itself is always spared). */
  allies: readonly V3[];
  /** The tick the shot is planned for (default: the tick of each trace); traces fly through its wind. */
  launchTick?: number;
}

/** The hull-frame bearing (turret yaw) from a tank to a point. */
export function bearingTo(self: Pick<TankState, 'position' | 'rotation'>, point: V3): number {
  const delta = sub(point, self.position);
  return Math.atan2(dot(delta, rotate([1, 0, 0], self.rotation)), dot(delta, rotate([0, 0, 1], self.rotation)));
}

/** Expected damage over the belief minus 1.5 × self and 1.2 × friendly damage, minus 2 per unit of miss distance. */
export function scoreImpact(input: SearchInput, impact: V3 | null): { score: number; miss: number; selfDamage: number } {
  if (!impact) return { score: -1e6, miss: Infinity, selfDamage: 0 };
  const blast = munitionStats(input.kit, input.munition), extent = blast.radius * 1.65 + TANK_RADIUS;
  const exposure = (point: V3) => clamp(1 - distance(impact, point) / extent, 0, 1);
  let expected = 0;
  for (const hypothesis of input.target.hypotheses) expected += hypothesis.weight * blast.damage * exposure(hypothesis.position);
  const self = blast.damage * exposure(input.self.position);
  const allies = input.allies.reduce((sum, ally) => sum + blast.damage * exposure(ally), 0);
  const miss = distance(impact, input.aimPoint);
  return { score: expected - 1.5 * self - 1.2 * allies - 2 * miss, miss, selfDamage: self + allies };
}

type Job = { pitch: number; power: number; yaw: number; kind: 'grid' | 'golden' | 'bearing' };

export class ShotSearch {
  readonly yaw: number;
  private readonly jobs: Job[] = [];
  private active: { job: Job; trace: BallisticTrace } | null = null;
  private readonly powerSpacing: number;
  /** The full elevation envelope, searched once if the preferred arc cannot reach the aim point. */
  private relaxed: { low: number; high: number } | null = null;
  private stage: 'grid' | 'golden' | 'bearing' | 'bearing-run' | 'done' = 'grid';
  private golden: { a: number; b: number; c: number; d: number; fc: number | null; fd: number | null; pitch: number; left: number } | null = null;
  private readonly results: ShotChoice[] = [];
  best: ShotChoice | null = null;
  /** Trace steps this search has spent (telemetry). */
  steps = 0;

  constructor(private readonly input: SearchInput) {
    this.yaw = bearingTo(input.self, input.aimPoint);
    const limits = input.kit.pitchLimits(this.yaw);
    let low = Math.max(input.params.minPitch, limits.min), high = Math.min(input.params.maxPitch, limits.max);
    if (!(high > low)) { low = limits.min; high = limits.max; }
    if (low > limits.min + 1e-6 || high < limits.max - 1e-6) this.relaxed = { low: limits.min, high: limits.max };
    const count = input.params.candidates, powers = Math.max(2, Math.round(Math.sqrt(count / 2))), pitches = Math.max(2, Math.ceil(count / powers));
    this.powerSpacing = (1 - .12) / (powers - 1);
    for (let i = 0; i < pitches; i++) for (let j = 0; j < powers; j++)
      this.jobs.push({ pitch: low + (high - low) * i / (pitches - 1), power: .12 + this.powerSpacing * j, yaw: this.yaw, kind: 'grid' });
  }

  get done(): boolean { return this.stage === 'done'; }

  /** Spend what the tick's budget allows. Returns true once the search is finished. */
  step(o: BotObservation): boolean {
    while (this.stage !== 'done') {
      if (!this.active) {
        const job = this.nextJob();
        if (!job) continue;
        this.active = { job, trace: o.trace!(job.yaw, job.pitch, job.power, this.input.munition, this.input.launchTick) };
      }
      const step = this.active.trace.step();
      if (!step) return false;
      this.steps++;
      if (!this.active.trace.done) continue;
      const { job, trace } = this.active;
      this.active = null;
      const scored = scoreImpact(this.input, trace.impact);
      const choice: ShotChoice = { yaw: job.yaw, pitch: job.pitch, power: job.power, impact: trace.impact, score: scored.score, miss: scored.miss };
      this.results.push(choice);
      if (!this.best || choice.score > this.best.score) this.best = choice;
      if (job.kind === 'golden' && this.golden) {
        if (this.golden.fc === null) this.golden.fc = choice.score; else this.golden.fd = choice.score;
      }
      if (job.kind === 'bearing') this.stage = 'done';
    }
    return true;
  }

  private nextJob(): Job | null {
    if (this.stage === 'grid') {
      const job = this.jobs.shift();
      if (job) return job;
      if (this.relaxed && (!this.best?.impact || this.best.miss > 2.5)) {
        // The arc preference is a preference: out of its reach, search the whole envelope once (6 pitches).
        const { low, high } = this.relaxed, powers = Math.round((1 - .12) / this.powerSpacing) + 1;
        this.relaxed = null;
        for (let i = 0; i < 6; i++) for (let j = 0; j < powers; j++) this.jobs.push({ pitch: low + (high - low) * (i + .5) / 6, power: .12 + this.powerSpacing * j, yaw: this.yaw, kind: 'grid' });
        return null;
      }
      this.stage = this.input.params.refineEvaluations > 0 && this.best?.impact ? 'golden' : 'done';
      if (this.stage === 'golden') {
        const center = this.best!.power, a = clamp(center - this.powerSpacing, 0, 1), b = clamp(center + this.powerSpacing, 0, 1);
        this.golden = { a, b, c: b - GOLDEN * (b - a), d: a + GOLDEN * (b - a), fc: null, fd: null, pitch: this.best!.pitch, left: this.input.params.refineEvaluations };
      }
      return null;
    }
    if (this.stage === 'golden') {
      const g = this.golden!;
      if (g.fc === null) return { pitch: g.pitch, power: g.c, yaw: this.yaw, kind: 'golden' };
      if (g.fd === null) return { pitch: g.pitch, power: g.d, yaw: this.yaw, kind: 'golden' };
      if (--g.left <= 0) { this.stage = 'bearing'; return null; }
      // Maximise the score: keep the better interior point and probe the section on its side.
      if (g.fc >= g.fd) { g.b = g.d; g.d = g.c; g.fd = g.fc; g.c = g.b - GOLDEN * (g.b - g.a); g.fc = null; }
      else { g.a = g.c; g.c = g.d; g.fc = g.fd; g.d = g.a + GOLDEN * (g.b - g.a); g.fd = null; }
      return null;
    }
    if (this.stage === 'bearing') {
      const best = this.best;
      // Crosswind and hull tilt push the shell off the bearing: turn by the angular miss and try once more.
      const correction = best?.impact ? bearingTo(this.input.self, this.input.aimPoint) - bearingTo(this.input.self, best.impact) : 0;
      if (!best || Math.abs(correction) < 2e-4) { this.stage = 'done'; return null; }
      this.stage = 'bearing-run';
      return { pitch: best.pitch, power: best.power, yaw: best.yaw + correction, kind: 'bearing' };
    }
    return null;
  }
}

/** The lateral (cross-range) and longitudinal (range) components of a miss, in the tangent plane at the aim point. */
export function missComponents(self: Pick<TankState, 'position'>, aimPoint: V3, impact: V3): { lateral: number; range: number } {
  const up = normalize(aimPoint), along = normalize(tangent(sub(aimPoint, self.position), up));
  const miss = tangent(sub(impact, aimPoint), up), across: V3 = [up[1] * along[2] - up[2] * along[1], up[2] * along[0] - up[0] * along[2], up[0] * along[1] - up[1] * along[0]];
  return { lateral: dot(miss, across), range: dot(miss, along) };
}
