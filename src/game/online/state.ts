import type { MatchSetup } from '../api/match';
import type { PlayerCommand } from '../api/session';
import type { GameEvent, GameSnapshot } from '../contracts';
import type { RealtimeCheckpoint, RealtimeEvent, RealtimeReplica } from '../realtime/match';
import type { MatchCheckpointV2 } from '../rules/checkpoint';
import type { ResidentGameCheckpoint, ResidentReplayEdit } from '../resident-checkpoint';
import type { StructuralMotion } from '../structural-physics';
import type { ChassisMotion } from '../resident-tanks';

export interface WorldDelta { from: number; count: number; edits: ResidentReplayEdit[]; bodies: StructuralMotion[]; chassis: ChassisMotion[]; tick: number; liquids?: import('../liquids').LiquidCheckpoint }
export interface NetworkSnapshot {
  state: GameSnapshot; realtime?: RealtimeReplica; world: WorldDelta;
  mission?: { id: import('../campaign/mission').MissionId; won: boolean; medal: boolean; optional: boolean; secrets: number;
    ending: 'rewind' | 'release' | null; beat?: string | null; commander?: number;
    objectives: import('../campaign/mission').ObjectiveState[]; marker: import('../contracts').V3 | null };
}
export interface Recovery {
  setup: MatchSetup; terrain: ResidentGameCheckpoint;
  turn?: MatchCheckpointV2; realtime?: RealtimeCheckpoint;
}
export interface NetworkEvent { id: number; game?: GameEvent; realtime?: RealtimeEvent }
export interface SessionNetwork {
  readonly seat: number; readonly host: boolean; readonly active: boolean;
  command(tank: number, command: PlayerCommand): boolean;
  step(dt: number): readonly GameEvent[];
  interpolation?(): import('../api/extensions').SimInterpolation | undefined;
}
