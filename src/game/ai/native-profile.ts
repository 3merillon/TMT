import type { RustTerrainCore } from '../../gpu/terrain/rust-core';
import type { BallisticTrace, BotBrain, BotDecision, BotObservation } from '../api/bot';
import type { DriveInput, V3 } from '../contracts';
import { assembleKit, tankKit } from '../kit';
import { munitionSpeed, munitionStats } from '../munitions';
import { GRAVITY_BALLISTIC } from '../world-constants';
import type { BrainParams } from './profiles';
import type { KitAssembly } from '../kit';
import type { MunitionId } from '../munitions';
import type { ResidentBotQueries } from './native-legacy';
import type { BallisticQuery } from '../native-ballistics';
const AMMO: readonly MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];

/** ABI 1 accepts detached observations; ABI 2 binds a resident unit. Both retain
 * metered query/trace requests and the kit's custom elevation callback contract. */
export class NativeProfileBrain implements BotBrain {
  readonly profile: BrainParams['profile'];
  lastDecision: { aimPoint: V3 | null; target: number | null; yaw: number; pitch: number; power: number; relocation: V3 | null; spreadScale: number } | null = null;
  private id: number;
  private trace: { id: number; value: BallisticTrace } | null = null;
  private munition: MunitionId = 'explosive';
  constructor(private readonly core: RustTerrainCore, match: number, readonly params: BrainParams, seed: number, private readonly bound?: { unit: number; kit: () => KitAssembly }) {
    const p = params, r = p.relocate; this.profile = p.profile;
    this.id = core.createProfile([bound ? 2 : 1, match, seed >>> 0, ['rusty', 'tosser', 'vex', 'cyborg'].indexOf(p.profile),
      p.reaction, p.sigmaYaw, p.sigmaPitch, p.sigmaPower, p.bracket, p.candidates, p.refineEvaluations, p.minPitch, p.maxPitch,
      r.min, r.max, r.cover, r.height, +!!r.random, p.forgetTurns ?? -1, p.scanEvery ?? -1, ...(bound ? [bound.unit] : [])]);
  }
  begin(o?: BotObservation): void {
    const impact = this.bound ? undefined : o!.impacts?.at(-1); this.call(0, this.bound ? [] : [+!!impact, impact?.tick ?? 0, ...(impact?.position ?? [0, 0, 0])]); this.trace = null;
  }
  step(queries: BotObservation | ResidentBotQueries, budget: { traceSteps: number }): BotDecision | null {
    const o = queries as BotObservation;
    let w: Float64Array;
    if (this.bound) w = this.call(1, [budget.traceSteps]);
    else {
      const s = o.self, kit = assembleKit(tankKit(s)), munition = s.munition ?? 'explosive', blast = munitionStats(kit, munition);
      const impact = o.impacts?.at(-1), sound = o.sounds.at(-1);
      w = this.call(1, [o.tick, o.phaseTime ?? 0, budget.traceSteps, s.team ?? 0, s.charge, o.rules.radarCost, ...s.position, ...s.rotation,
        s.heading, s.turretYaw, s.barrelPitch, o.world.radius, kit.stats.fuel, munitionSpeed(kit, 1, munition), GRAVITY_BALLISTIC * o.rules.gravityScale, blast.radius, blast.damage,
        +!!impact, impact?.tick ?? 0, ...(impact?.position ?? [0, 0, 0]), +!!sound, sound?.bearing ?? 0, sound?.tick ?? 0,
        o.visible.length + o.lastKnown.length, ...o.visible.flatMap(c => [c.tank, c.team, 1, c.observedAt, 0, ...c.position]),
        ...o.lastKnown.flatMap(c => [c.tank, c.team, 0, c.observedAt, c.uncertainty, ...c.position])]);
    }
    const kit = this.bound ? this.bound.kit() : assembleKit(tankKit(o.self)), munition = this.bound ? this.munition : o.self.munition ?? 'explosive';
    while (w[0] >= 4) {
      let reply: number[];
      if (w[0] === 4) { const limits = kit.pitchLimits(w[2]); reply = [limits.min, limits.max]; }
      else if (w[0] === 5) {
        const hit = o.world.surface([w[2], w[3], w[4]]); reply = [+!!hit, ...(hit?.point ?? [0, 0, 0]), ...(hit?.normal ?? [0, 0, 0])];
      } else if (w[0] === 6) reply = [+!!o.world.raycast([w[2], w[3], w[4]], [w[5], w[6], w[7]], w[8])];
      else if (w[0] === 7) {
        if (this.trace?.id !== w[2]) this.trace = { id: w[2], value: o.trace!(w[3], w[4], w[5], munition, w[6]) };
        const trace = this.trace.value;
        if (w[7]) reply = [0, 0, 0, 0, 0, 0, 0]; // Safety rerolls create the trace now and resume next tick.
        else {
          let steps = 0, blocked = false;
          while (!trace.done && steps < 256) { if (!trace.step()) { blocked = true; break; } steps++; }
          reply = [steps, +trace.done, +!!trace.impact, ...(trace.impact ?? [0, 0, 0]), +blocked];
        }
      } else throw new Error('Unknown resident personality request');
      w = this.call(2, [w[1], budget.traceSteps, ...reply]);
    }
    return this.decide(w, munition);
  }
  /** v16: surface/ray/trace and canonical elevation requests run inside the
   * engine; only a custom kit's elevation callback returns here. */
  stepResident(lease: BallisticQuery): BotDecision | null {
    if (lease.core !== this.core || !this.bound) throw new Error('Resident step requires a bound controller on its own engine');
    const q = [lease.kind, lease.id, lease.range];
    let w = this.call(4, [...q, 0]);
    while (w[0] === 4) { const limits = this.bound.kit().pitchLimits(w[2]); w = this.call(4, [...q, 1, w[1], limits.min, limits.max]); }
    return this.decide(w, this.munition);
  }
  private decide(w: Float64Array, munition: MunitionId): BotDecision | null {
    if (w[0] === 1) return { kind: 'scan' };
    if (w[0] === 2) return { kind: 'aim', yaw: w[1], pitch: w[2], power: w[3] };
    if (w[0] === 3) {
      this.lastDecision = { aimPoint: w[4] ? [w[5], w[6], w[7]] : null, target: w[8] < 0 ? null : w[8],
        yaw: w[1], pitch: w[2], power: w[3], relocation: w[9] ? [w[10], w[11], w[12]] : null, spreadScale: w[13] };
      return { kind: 'fire', yaw: w[1], pitch: w[2], power: w[3], munition };
    }
    return null;
  }
  drive(o?: BotObservation): DriveInput { const w = this.call(3, this.bound ? [] : [o!.tick, ...o!.self.position, o!.self.heading]); return { throttle: w[0], steer: w[1] }; }
  /** The engine controller handle (v17 tick heads name the bound controller explicitly). */
  get handle(): number { return this.id; }
  dispose(): void { if (this.id) { this.core.disposeProfile(this.id); this.id = 0; this.trace = null; } }
  private call(op: number, data: ArrayLike<number> = []): Float64Array {
    if (!this.id) throw new Error('Resident personality is disposed');
    const w = this.core.profileCommand(this.id, op, data);
    if (this.bound) { this.munition = AMMO[w[w.length - 1]]; return w.subarray(0, w.length - 1); } return w;
  }
}
