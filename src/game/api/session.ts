// @contract v1 — docs/architecture.md#contracts-and-invariants
// api/session.ts — the only API the UI uses to run matches
import type { MunitionId } from '../munitions';
import type { MatchSetup } from './match';
import type { AimSelection, AimTargetAim, AimTargetResult } from '../rules/aim-target';
import type { V3 } from '../contracts';
export type PlayerCommand =
  | { k: 'aim'; yaw: number; pitch: number; power: number } | { k: 'fire' } | { k: 'munition'; id: MunitionId }
  | { k: 'scan' } | { k: 'endMove' } | { k: 'drive'; throttle: number; steer: number }
  | { k: 'brace' } | { k: 'tap' } | { k: 'utility'; id: string } | { k: 'selfRight' } | { k: 'hold' } | { k: 'reposition' };
export interface SessionApi {
  startMatch(setup: MatchSetup): Promise<void>;   // W0: 2-tank setups only (explicit error otherwise); W1-GAME: N tanks
  /** `fromStart`: a campaign mission from its beginning (its autosave is dropped), not its checkpoint. */
  restart(fromStart?: boolean): Promise<void>; endMatch(): void; setPaused(paused: boolean): void;
  command(tank: number, c: PlayerCommand): boolean;   // false = not accepted now / not supported yet
  /** Whether the tank's main gun can fire now (realtime: loaded; turns: its aim phase). */
  canFire?(tank: number): boolean;
  solveAimTarget(tank: number, target: V3 | AimSelection, previous?: AimTargetAim): AimTargetResult;
  readonly snapshot: import('../contracts').GameSnapshot | undefined; readonly setup: MatchSetup | undefined; readonly observer: number;
  on(event: 'ready' | 'event' | 'finish' | 'error' | 'realtime', cb: (payload: unknown) => void): () => void;
  telemetry(): Record<string, unknown>; dispose(): void;
}
let provided: SessionApi | undefined;
/** Registers the running session (app/session.ts calls this once per GameSession); the latest provider wins. */
export function provideSession(s: SessionApi): void { provided = s; }
export function session(): SessionApi {
  if (!provided) throw new Error('No game session has been provided yet');
  return provided;
}
