import type { RustTerrainCore } from '../../gpu/terrain/rust-core';
import type { BallisticTrace, BotBrain, BotDecision, BotObservation } from '../api/bot';
import type { DriveInput } from '../contracts';
import type { MunitionId } from '../munitions';
import type { BallisticQuery } from '../native-ballistics';

export type ResidentBotQueries = Pick<BotObservation, 'world' | 'trace'>;
const AMMO: readonly MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];

/** ABI 1 accepts detached observations; ABI 2 binds a resident unit. Rust
 * requests one candidate's bounded trace batch at a time through this adapter. */
export class NativeLegacyBrain implements BotBrain {
  readonly profile = 'legacy' as const;
  private id: number;
  private trace: BallisticTrace | null = null;
  private cursor = -1;
  private moveHeading = 0;
  private munition: MunitionId = 'explosive';
  private readonly batch = new Float64Array(2 + 32 * 8);
  constructor(private readonly core: RustTerrainCore, match: number, private readonly unit?: number) { this.id = core.createAI(unit === undefined ? [1, match] : [2, match, unit]); }
  begin(_observation?: BotObservation): void { this.call(0); this.trace = null; this.cursor = -1; }
  step(o: BotObservation | ResidentBotQueries): BotDecision | null {
    const snapshot = o as BotObservation;
    let w: Float64Array;
    if (this.unit !== undefined) w = this.call(1);
    else { const self = snapshot.self;
      w = this.call(1, [snapshot.phaseTime ?? 0, self.charge, snapshot.rules.radarCost, self.team ?? 0, self.heading, ...self.position, ...self.rotation,
        snapshot.visible.length + snapshot.lastKnown.length,
        ...snapshot.visible.flatMap(c => [c.tank, c.team, 1, c.observedAt, ...c.position]), ...snapshot.lastKnown.flatMap(c => [c.tank, c.team, 0, c.observedAt, ...c.position])]);
    }
    const munition = this.unit === undefined ? snapshot.self.munition ?? 'explosive' : this.munition;
    while (w[0] === 3) {
      if (this.cursor !== w[2] || !this.trace) { this.cursor = w[2]; this.trace = o.trace!(w[3], w[4], w[5], munition); }
      const trace = this.trace; let count = 0;
      for (; count < w[6]; count++) {
        const step = trace.step(); if (!step) break;
        const p = 2 + count * 8; this.batch.set(step.from, p); this.batch.set(step.to, p + 3); this.batch[p + 6] = +step.hit; this.batch[p + 7] = +step.expired;
        if (step.hit || step.expired) { count++; this.trace = null; break; }
      }
      this.batch[0] = this.cursor; this.batch[1] = count;
      w = this.call(2, this.batch.subarray(0, 2 + count * 8));
    }
    return this.decide(w, munition);
  }
  /** v16: trace batches run inside the engine on the world's composed query lease. */
  stepResident(lease: BallisticQuery): BotDecision | null {
    if (lease.core !== this.core || this.unit === undefined) throw new Error('Resident step requires a bound controller on its own engine');
    const w = this.call(4, [lease.kind, lease.id, lease.range]); return this.decide(w, this.munition);
  }
  private decide(w: Float64Array, munition: MunitionId): BotDecision | null {
    this.moveHeading = w[1];
    if (w[0] === 1) return { kind: 'scan' };
    if (w[0] === 2) return { kind: 'fire', yaw: w[2], pitch: w[3], power: w[4], munition };
    return null;
  }
  drive(o?: BotObservation): DriveInput {
    const w = this.call(3, this.unit === undefined ? [o!.self.heading] : []); this.moveHeading = w[2]; return { throttle: w[0], steer: w[1] };
  }
  get heading(): number { return this.moveHeading; }
  /** The engine controller handle (v17 tick heads name the bound controller explicitly). */
  get handle(): number { return this.id; }
  dispose(): void { if (this.id) { this.core.disposeAI(this.id); this.id = 0; this.trace = null; } }
  private call(op: number, data: ArrayLike<number> = []): Float64Array {
    if (!this.id) throw new Error('Resident AI is disposed');
    const w = this.core.aiCommand(this.id, op, data);
    if (this.unit !== undefined) { this.munition = AMMO[w[w.length - 1]]; return w.subarray(0, w.length - 1); } return w;
  }
}
