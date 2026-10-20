// @contract v1 — docs/architecture.md#contracts-and-invariants
// transactions.ts — non-blocking terrain edits (implemented by W1-TER on ResidentGameTerrain, consumed by W1-GAME)
import type { TerrainQueryBounds, TerrainUpdate, V3 } from '../../game/contracts';
import type { CutShell } from './contracts';
export interface CutRequest { readonly id: string /* deterministic: `${tick}:${shot}:${i}` */; readonly center: V3; readonly radius: number;
  /** Material crater shells (rust-engine-v22, rules/material-craters.ts); center/radius bound them. */
  readonly shells?: readonly CutShell[] }
export type TerrainTicket = number;
export type CommitResult = { status: 'committed'; update: TerrainUpdate } | { status: 'not-ready' } | { status: 'failed'; code: string; message: string };
export interface TerrainTransactions {
  prepare(cuts: readonly CutRequest[], commitTick: number, options?: { speculative?: boolean }): TerrainTicket;
  promote(ticket: TerrainTicket, cuts: readonly CutRequest[], commitTick: number): boolean; // speculative → real when the cuts are identical
  commitReady(ticket: TerrainTicket, tick: number): CommitResult;                            // synchronous; only at a fixed-tick boundary
  cancel(ticket: TerrainTicket): void;                                                       // never blocks the serial tail
  freezeBodies(bounds: TerrainQueryBounds, untilTick: number): void;                         // stale-recut fence for dynamic bodies in the cut AABB
  status(ticket: TerrainTicket): 'preparing' | 'ready' | 'failed' | 'cancelled' | 'committed';
}
// src/game/contracts.ts: WorldQuery gains `readonly transactions?: TerrainTransactions`.
