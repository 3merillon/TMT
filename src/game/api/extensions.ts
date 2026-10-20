// @contract v1 — docs/architecture.md#contracts-and-invariants
// api/extensions.ts
import type { Q4, V3 } from '../contracts';
import type { MatchRules } from './match';
export interface SimContext { tick: number; state: import('../contracts').GameSnapshot; rules: MatchRules; world: import('../contracts').WorldQuery;
  rng(stream: string): () => number; emit(e: import('../contracts').GameEvent): void; damage(tank: number, amount: number, cause: string): void }
export interface SegmentHit { point: V3; normal: V3; t: number; kind: string; detonate: boolean }
export interface SimExtension { readonly id: string;
  onMatchStart?(c: SimContext): void; onTick?(c: SimContext): void;
  traceSegment?(c: SimContext, p0: V3, p1: V3, p: import('../contracts').ProjectileState): SegmentHit | null;
  onImpact?(c: SimContext, e: import('../contracts').ImpactEvent): void; onTerrainCommit?(c: SimContext, u: import('../contracts').TerrainUpdate): void;
  snapshot?(): unknown; restore?(v: unknown): void }

// api/extensions.ts additions made by W0-DECK (needed by W1 presenters):
export interface TankPose { position: V3; rotation: Q4; turretYaw: number; barrelPitch: number }
export interface SimInterpolation {
  alpha: number; prev: readonly TankPose[]; curr: readonly TankPose[];
  /** Authoritative snapshot endpoints for remote shells; presentation only, never a local hit decision. */
  projectiles?: readonly { id: number; previous: V3; current: V3 }[];
}
// GameView.update(state, observer, dt, preview, fullPreview, interp?: SimInterpolation)
