// @contract v1 — docs/architecture.md#contracts-and-invariants
// api/bot.ts
import type { V3 } from '../contracts';
import type { MunitionId } from '../munitions';
import type { BotProfileId, MatchRules, TeamId } from './match';
export interface BotObservation { tick: number; self: import('../contracts').TankState; rules: MatchRules; wind: V3 | null;
  visible: { tank: number; team: TeamId; position: V3; observedAt: number }[];
  lastKnown: { tank: number; team: TeamId; position: V3; observedAt: number; uncertainty: number }[];
  sounds: { bearing: number; tick: number }[];
  world: Pick<import('../contracts').WorldQuery, 'radius' | 'raycast' | 'surface' | 'isSolid'>;
  predict(yaw: number, pitch: number, power: number, munition: MunitionId): { impact: V3 | null; path: V3[]; flightTicks: number };
  /** CC-007: an incremental shell trace on the shared integrator, metered against the tick's trace-step budget.
   * `launchTick` (default: now) is the tick the brain plans to fire at, so the trace flies through that tick's wind. */
  trace?(yaw: number, pitch: number, power: number, munition: MunitionId, launchTick?: number): BallisticTrace;
  /** CC-007: seconds since this brain's aim phase began. */
  phaseTime?: number;
  /** CC-007: where this tank's own recent shells landed (every tank sees its own impacts), oldest first. */
  impacts?: { tick: number; position: V3 }[] }
/** CC-007: one integration step of a BallisticTrace. `to` is the impact point on a hit. */
export interface BallisticTraceStep { from: V3; to: V3; hit: boolean; expired: boolean }
/** CC-007: step() returns null once the trace is done or the tick's budget is spent (call again next tick). */
export interface BallisticTrace { readonly done: boolean; readonly impact: V3 | null; readonly steps: number; step(): BallisticTraceStep | null }
export type BotDecision = { kind: 'fire'; yaw: number; pitch: number; power: number; munition: MunitionId }
  | { kind: 'reposition'; target: V3 } | { kind: 'hold' } | { kind: 'scan' } | { kind: 'utility'; id: string }
  /** CC-007: still thinking; slew the turret here (visible "hunting"). A free, non-terminal decision. */
  | { kind: 'aim'; yaw: number; pitch: number; power: number };
export interface BotBrain { readonly profile: BotProfileId; begin(o: BotObservation): void;
  step(o: BotObservation, budget: { traceSteps: number }): BotDecision | null /* null: still thinking */;
  /** CC-007: the brain's drive input while its tank may move (post-shot scoot or a reposition turn). */
  drive?(o: BotObservation, budget: { traceSteps: number }): import('../contracts').DriveInput;
  /** Release resident decision state when the simulation ends. */
  dispose?(): void }
