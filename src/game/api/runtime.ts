// api/runtime.ts — what the session needs from a running match, whichever rules drive it (docs/architecture.md).
// GameSimulation (turn-based, optionally on the resident Rust match) and RealtimeMatch (src/game/realtime) implement it.
import type { DriveInput, GameEvent, GameSnapshot, PlayerId, TerrainUpdate, TrajectoryPrediction, V3 } from '../contracts';
import type { CutRequest, TerrainTicket } from '../../gpu/terrain/transactions';
import type { AimSelection, AimTargetAim, AimTargetCollider, AimTargetResult } from '../rules/aim-target';
import type { SimInterpolation } from './extensions';
import type { MatchSetup } from './match';
import type { PlayerCommand } from './session';

/** What a stalled match is waiting for: the edit due at `commitTick` is not prepared yet (a deterministic stall). */
export interface RuntimeStall { readonly commitTick: number; readonly cutIds: readonly string[]; readonly ticket: TerrainTicket | null; readonly serial: boolean }

export interface MatchRuntime {
  readonly state: GameSnapshot;
  readonly setup: MatchSetup;
  /** The sandbox drive test (no damage, no brains). */
  readonly driveTest: boolean;
  readonly stalledOn: RuntimeStall | null;
  readonly terrainPending: boolean;
  readonly stalledFrames: number;
  /** dt is real seconds; the drive input steers the active (human) tank. */
  step(dt: number, drive?: DriveInput): GameEvent[];
  command(tank: PlayerId, c: PlayerCommand): boolean;
  canFire(tank: PlayerId): boolean;
  /** The brain driving a tank, or null for a human. */
  brainOf(tank: PlayerId): string | null;
  interpolation(): SimInterpolation;
  previewPrediction(tank: PlayerId, full?: boolean, collider?: AimTargetCollider): TrajectoryPrediction;
  solveAimTarget(tank: PlayerId, selection: V3 | AimSelection, previous?: AimTargetAim): AimTargetResult;
  drainTerrainUpdates(): TerrainUpdate[];
  /** COMPAT: the cuts a serial carve must apply (worlds without transactions). */
  pendingSerialCuts(): readonly CutRequest[];
  completeLegacyCarve(result?: { status: 'committed'; update?: TerrainUpdate } | { status: 'failed'; code: string; message: string }): void;
  aiTelemetry(): { peakStepsPerTick: number; budget: number; decisions: number; lastDecisionTicks: number };
  timeline(count?: number): PlayerId[];
  commandLog(): readonly unknown[];
  dispose(): void;
}
