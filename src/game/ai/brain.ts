/** AI brains v1 (plan §3, Experience §1.15): observation-only personalities. A turn goes
 * belief → target → bracketed aim point → time-sliced shot search → personality dispersion → relocation plan →
 * (after the profile's reaction time, with the turret visibly slewing) fire → pure-pursuit scoot.
 * Everything a brain knows arrives in its BotObservation; its randomness is its own seeded stream. */
import type { BallisticTrace, BotBrain, BotDecision, BotObservation } from '../api/bot';
import type { BotProfileId, Difficulty } from '../api/match';
import type { DriveInput, V3 } from '../contracts';
import { add, clamp, cross, distance, mul, normalize, sub, tangent, wrapAngle } from '../math';
import { assembleKit, tankKit, type KitAssembly } from '../kit';
import { FIXED_DT } from '../rules/ballistics';
import { munitionSpeed } from '../munitions';
import { GRAVITY_BALLISTIC } from '../world-constants';
import { beliefs, chooseTarget, type TargetBelief } from './belief';
import { LegacyBrain } from './legacy';
import { isW1Profile, resolveProfile, type BrainParams } from './profiles';
import { BrainRandom } from './random';
import { Pursuit, RelocationPlanner } from './relocation';
import { missComponents, scoreImpact, ShotSearch } from './shot-search';

/** Turret slew rates while "thinking" (rad/s): the reaction time is made visible. */
export const SLEW_YAW = 1.6;
export const SLEW_PITCH = 1.1;

/** A brain for a setup's profile id. `legacy` is today's bot and draws from the match stream (`matchRandom`). */
export function createBrain(profile: BotProfileId, difficulty: Difficulty, seed: number, matchRandom: () => number): BotBrain {
  if (profile === 'legacy') return new LegacyBrain(matchRandom);
  if (!isW1Profile(profile)) throw new Error(`Bot brain '${profile}' arrives after Wave 1`);
  return new ProfileBrain(resolveProfile(profile, difficulty), seed);
}

/** The running estimate of the systematic miss along the line of fire (range) and across it (lateral), so it still
 * applies after the shooter scoots to a new firing position. */
interface Bracket { tank: number | null; reference: V3; range: number; lateral: number; shots: number; lastAim: { point: V3; from: V3 } | null; seenImpact: number }
interface Aim { yaw: number; pitch: number; power: number }
interface TurnPlan {
  target: TargetBelief | null; aimPoint: V3 | null; search: ShotSearch | null; final: Aim | null;
  /** The dispersed aim is traced once: a jitter that would land the shell on the shooter or an ally is re-rolled. */
  check: { trace: BallisticTrace; attempts: number; best: Aim } | null; checked: boolean;
  relocation: RelocationPlanner | null; scanned: boolean; probe: boolean;
}

export class ProfileBrain implements BotBrain {
  readonly profile: BotProfileId;
  readonly random: BrainRandom;
  private plan: TurnPlan = ProfileBrain.freshPlan();
  private bracket: Bracket | null = null;
  private turns = 0;
  private pursuit: Pursuit | null = null;
  /** The last completed decision (presentation and tests). */
  lastDecision: { aimPoint: V3 | null; target: number | null; yaw: number; pitch: number; power: number; relocation: V3 | null; spreadScale: number } | null = null;

  constructor(readonly params: BrainParams, seed: number) {
    this.profile = params.profile;
    this.random = new BrainRandom(seed);
  }

  private static freshPlan(): TurnPlan { return { target: null, aimPoint: null, search: null, final: null, check: null, checked: false, relocation: null, scanned: false, probe: false }; }

  begin(o: BotObservation): void {
    this.turns++;
    this.plan = ProfileBrain.freshPlan();
    this.pursuit = null;
    this.learnFromImpacts(o);
  }

  step(o: BotObservation, budget: { traceSteps: number }): BotDecision | null {
    const self = o.self, kit = assembleKit(tankKit(self)), plan = this.plan, munition = self.munition ?? 'explosive';
    this.learnFromImpacts(o);
    if (!plan.target && !plan.probe) {
      const all = beliefs(o, { forgetTurns: this.params.forgetTurns, fuelPerTurn: kit.stats.fuel, budget });
      const target = chooseTarget(o, all);
      const canScan = self.charge >= o.rules.radarCost && !plan.scanned;
      const scheduled = this.params.scanEvery !== undefined && this.turns % this.params.scanEvery === 0;
      if (canScan && (!target || (!target.visible && this.params.profile !== 'rusty') || (scheduled && !target?.visible))) { plan.scanned = true; return { kind: 'scan' }; }
      if (!target) plan.probe = true;
      else {
        plan.target = target;
        plan.aimPoint = this.aimPoint(o, target, budget);
        const allies = o.visible.filter(entry => entry.team === self.team).map(entry => entry.position);
        plan.search = new ShotSearch({ self, kit, munition, params: this.params, aimPoint: plan.aimPoint, target, allies, launchTick: this.fireTick(o) });
      }
    }
    if (plan.probe && !plan.final) {
      // No belief at all: a probing lob on a random bearing (never a read of hidden state).
      plan.final = envelope(kit, { yaw: this.random.next() * 2 * Math.PI - Math.PI, pitch: .95, power: .45 + this.random.next() * .3 });
    }
    if (plan.search && !plan.final) {
      const done = plan.search.step(o);
      const best = plan.search.best;
      if (!done) return best ? this.slew(o, best.yaw, best.pitch, best.power) : null;
      const chosen = best ?? { yaw: plan.search.yaw, pitch: .8, power: .5 };
      plan.final = envelope(kit, this.disperse(chosen));
      plan.check = { trace: o.trace!(plan.final.yaw, plan.final.pitch, plan.final.power, munition, this.fireTick(o)), attempts: 1, best: { yaw: chosen.yaw, pitch: chosen.pitch, power: chosen.power } };
    }
    if (!plan.final) return null;
    if (plan.check && !plan.checked) {
      const check = plan.check;
      while (!check.trace.done) if (!check.trace.step()) return this.slew(o, plan.final.yaw, plan.final.pitch, plan.final.power);
      const input = { self, kit, munition, params: this.params, aimPoint: plan.aimPoint!, target: plan.target!, allies: o.visible.filter(entry => entry.team === self.team).map(entry => entry.position) };
      if (scoreImpact(input, check.trace.impact).selfDamage > 0 && plan.target) {
        // Never a suicide by jitter: re-roll the spread twice, then shoot the undispersed solution.
        plan.final = envelope(kit, check.attempts < 3 ? this.disperse(check.best) : { ...check.best });
        plan.check = check.attempts < 3 ? { trace: o.trace!(plan.final.yaw, plan.final.pitch, plan.final.power, munition, this.fireTick(o)), attempts: check.attempts + 1, best: check.best } : null;
        plan.checked = !plan.check;
        return this.slew(o, plan.final.yaw, plan.final.pitch, plan.final.power);
      }
      plan.checked = true;
    }
    if (!plan.relocation) {
      const threats = beliefs(o, { budget }).map(belief => belief.centroid);
      plan.relocation = new RelocationPlanner(self, this.params, threats, this.random, kit.stats.fuel, this.reach(o));
    }
    if (!plan.relocation.done && !plan.relocation.step(o, budget)) return this.slew(o, plan.final.yaw, plan.final.pitch, plan.final.power);
    // Reaction time (visible turret hunting until it elapses and the turret is on target).
    const final = plan.final, onTarget = Math.abs(wrapAngle(final.yaw - self.turretYaw)) < .02 && Math.abs(final.pitch - self.barrelPitch) < .02;
    if ((o.phaseTime ?? 0) < this.params.reaction || !onTarget) return this.slew(o, final.yaw, final.pitch, final.power);
    if (this.bracket && plan.aimPoint) this.bracket.lastAim = { point: plan.aimPoint, from: [...self.position] };
    this.pursuit = plan.relocation.target ? new Pursuit(plan.relocation.target) : null;
    this.lastDecision = { aimPoint: plan.aimPoint, target: plan.target?.tank ?? null, ...final, relocation: plan.relocation.target, spreadScale: this.spreadScale() };
    return { kind: 'fire', ...final, munition };
  }

  drive(o: BotObservation): DriveInput {
    return this.pursuit ? this.pursuit.drive(o.self, o.tick) : { throttle: 0, steer: 0 };
  }

  /** Bracketing memory (Experience §1.15 step 4): each observed miss of the tracked target updates a running estimate
   * of the systematic aim error by `bracket × (miss − estimate)`, so the next aim point visibly zeroes in. */
  private learnFromImpacts(o: BotObservation): void {
    const bracket = this.bracket, impact = o.impacts?.at(-1);
    if (!bracket?.lastAim || !impact || impact.tick <= bracket.seenImpact) return;
    bracket.seenImpact = impact.tick;
    const miss = missComponents({ position: bracket.lastAim.from }, bracket.lastAim.point, impact.position), k = this.params.bracket;
    bracket.range = bracket.range * (1 - k) + miss.range * k;
    bracket.lateral = bracket.lateral * (1 - k) + miss.lateral * k;
    bracket.shots++;
    bracket.lastAim = null;
  }

  /** The tick this turn's shot is planned for: the end of the reaction time (a brain never fires before it), or now
   * once it has passed. Searches and checks trace through that tick's wind, like the live shell will. */
  private fireTick(o: BotObservation): number {
    const turnStart = o.tick - Math.round((o.phaseTime ?? 0) / FIXED_DT);
    return Math.max(o.tick, turnStart + Math.ceil(this.params.reaction / FIXED_DT - 1e-9));
  }

  /** The target centroid corrected by the bracketing estimate; the memory resets when the target changes or moves.
   * The ground query is metered: with the tick's budget spent, the point is projected at the centroid's height. */
  private aimPoint(o: BotObservation, target: TargetBelief, budget: { traceSteps: number }): V3 {
    const moved = !this.bracket || this.bracket.tank !== target.tank || distance(this.bracket.reference, target.centroid) > 1.5;
    if (moved) this.bracket = { tank: target.tank, reference: [...target.centroid], range: 0, lateral: 0, shots: 0, lastAim: null, seenImpact: o.impacts?.at(-1)?.tick ?? -1 };
    const up = normalize(target.centroid), along = normalize(tangent(sub(target.centroid, o.self.position), up)), across = cross(up, along);
    const corrected = sub(target.centroid, add(mul(along, this.bracket!.range), mul(across, this.bracket!.lateral)));
    const hit = budget.traceSteps > 0 ? o.world.surface(normalize(corrected)) : null;
    return hit ? hit.point : mul(normalize(corrected), Math.hypot(...target.centroid));
  }

  /** Effective range: three quarters of the flat range at the elevation nearest 45° inside the preferred arc, at full power. */
  private reach(o: BotObservation): number {
    const speed = munitionSpeed(assembleKit(tankKit(o.self)), 1, o.self.munition), gravity = GRAVITY_BALLISTIC * o.rules.gravityScale;
    const pitch = clamp(Math.PI / 4, this.params.minPitch, this.params.maxPitch);
    return .75 * speed * speed * Math.sin(2 * pitch) / gravity;
  }

  /** Personality spread shrinks as a bracket closes on a static target: σ × max(0.25, 1 − bracket)^shots. */
  private spreadScale(): number { return Math.max(.25, 1 - this.params.bracket) ** (this.bracket?.shots ?? 0); }

  private disperse(best: { yaw: number; pitch: number; power: number }): { yaw: number; pitch: number; power: number } {
    const scale = this.spreadScale(), p = this.params;
    return {
      yaw: wrapAngle(best.yaw + this.random.gaussian() * p.sigmaYaw * scale),
      pitch: best.pitch + this.random.gaussian() * p.sigmaPitch * scale,
      power: clamp(best.power * (1 + this.random.gaussian() * p.sigmaPower * scale), 0, 1),
    };
  }

  /** Move the turret toward an aim at the slew rates (the brain is still thinking). */
  private slew(o: BotObservation, yaw: number, pitch: number, power: number): BotDecision {
    const self = o.self, maxYaw = SLEW_YAW * FIXED_DT, maxPitch = SLEW_PITCH * FIXED_DT;
    const dy = clamp(wrapAngle(yaw - self.turretYaw), -maxYaw, maxYaw), dp = clamp(pitch - self.barrelPitch, -maxPitch, maxPitch);
    return { kind: 'aim', yaw: self.turretYaw + dy, pitch: self.barrelPitch + dp, power };
  }
}

/** The sim clamps every aim to the kit's elevation envelope at its bearing (pitchLimits, plan §5.3). A planned or
 * dispersed pitch outside it would never read as "on target" (the barrel stops at the limit), so the brain would
 * hunt forever without firing: kit v2's Dome tops out at 75 deg, where steep close lobs sit. */
function envelope(kit: KitAssembly, aim: { yaw: number; pitch: number; power: number }): { yaw: number; pitch: number; power: number } {
  const limits = kit.pitchLimits(aim.yaw);
  return { ...aim, pitch: clamp(aim.pitch, limits.min, limits.max) };
}
