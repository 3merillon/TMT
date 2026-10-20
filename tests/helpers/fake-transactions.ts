/** Deterministic stand-in for W1-TER's TerrainTransactions (plan §5.1) over the analytic SphereWorld. Readiness is
 * measured on a caller-supplied frame clock, never on ticks: a stalled simulation does not advance ticks, while the
 * harness keeps presenting frames, exactly like a real asynchronous preparer. Committing subtracts the cut spheres
 * from the world and bumps its version; a failure keeps the old world. */
import type { CommitResult, CutRequest, TerrainTicket, TerrainTransactions } from '../../src/gpu/terrain/transactions';
import type { TerrainQueryBounds } from '../../src/game/contracts';
import type { SphereWorld } from './sphere-world';

export interface FakeTicket {
  readonly id: TerrainTicket; cuts: readonly CutRequest[]; commitTick: number; speculative: boolean; preparedAt: number;
  status: 'preparing' | 'ready' | 'failed' | 'cancelled' | 'committed';
}
export interface FakeTransactionOptions {
  /** Frames between prepare and readiness (1 = ready on the next frame). */
  latency?: number;
  /** Returns a failure for a ticket's cuts, or null to commit. */
  fail?: (cuts: readonly CutRequest[]) => { code: string; message: string } | null;
  /** Like the resident preparer: one edit at a time, in prepare order. A ticket is ready only once every earlier ticket
   * has committed, failed or been cancelled. */
  serial?: boolean;
}
export type FakeCall = { op: 'prepare'; ticket: number; cuts: string[]; commitTick: number; speculative: boolean; frame: number }
  | { op: 'promote'; ticket: number; ok: boolean; frame: number } | { op: 'commitReady'; ticket: number; tick: number; result: CommitResult['status']; frame: number }
  | { op: 'cancel'; ticket: number; frame: number } | { op: 'freeze'; bounds: TerrainQueryBounds; untilTick: number; frame: number };

export const sameCuts = (a: readonly CutRequest[], b: readonly CutRequest[]) => a.length === b.length
  && a.every((cut, i) => cut.id === b[i].id && cut.radius === b[i].radius && cut.center.every((value, axis) => value === b[i].center[axis]));

export class FakeTransactions implements TerrainTransactions {
  readonly tickets = new Map<TerrainTicket, FakeTicket>();
  readonly calls: FakeCall[] = [];
  latency: number;
  private next = 1;
  constructor(private readonly world: SphereWorld, private readonly frame: () => number, private readonly options: FakeTransactionOptions = {}) {
    this.latency = options.latency ?? 1;
  }
  prepare(cuts: readonly CutRequest[], commitTick: number, options?: { speculative?: boolean }): TerrainTicket {
    const id = this.next++;
    this.tickets.set(id, { id, cuts: cuts.map(cut => ({ ...cut, center: [...cut.center] })), commitTick, speculative: !!options?.speculative, preparedAt: this.frame(), status: 'preparing' });
    this.calls.push({ op: 'prepare', ticket: id, cuts: cuts.map(cut => cut.id), commitTick, speculative: !!options?.speculative, frame: this.frame() });
    return id;
  }
  promote(ticket: TerrainTicket, cuts: readonly CutRequest[], commitTick: number): boolean {
    const record = this.tickets.get(ticket);
    const ok = !!record && record.speculative && record.status !== 'cancelled' && record.status !== 'failed' && sameCuts(record.cuts, cuts);
    if (ok) { record.speculative = false; record.commitTick = commitTick; }
    this.calls.push({ op: 'promote', ticket, ok, frame: this.frame() });
    return ok;
  }
  commitReady(ticket: TerrainTicket, tick: number): CommitResult {
    const record = this.tickets.get(ticket);
    if (!record || record.speculative || record.status === 'cancelled' || record.status === 'committed') throw new Error(`commitReady on ticket ${ticket} in state ${record?.status ?? 'unknown'}${record?.speculative ? ' (speculative)' : ''}`);
    if (tick !== record.commitTick) throw new Error(`commitReady for ticket ${ticket} at tick ${tick}, but it commits at ${record.commitTick}`);
    let result: CommitResult;
    const blocked = this.options.serial && [...this.tickets.values()].some(t => t.id < record.id && (t.status === 'preparing' || t.status === 'ready'));
    if (blocked || this.frame() - record.preparedAt < this.latency) result = { status: 'not-ready' };
    else {
      const failure = this.options.fail?.(record.cuts) ?? null;
      if (failure) { record.status = 'failed'; result = { status: 'failed', ...failure }; }
      else {
        record.status = 'committed';
        this.world.craters.push(...record.cuts.map(cut => ({ center: [...cut.center] as [number, number, number], radius: cut.radius })));
        this.world.version++;
        result = { status: 'committed', update: { version: this.world.version, chunks: [], removed: [], milliseconds: 0, triangles: 0, rebuilt: record.cuts.length } };
      }
    }
    this.calls.push({ op: 'commitReady', ticket, tick, result: result.status, frame: this.frame() });
    return result;
  }
  cancel(ticket: TerrainTicket): void {
    const record = this.tickets.get(ticket);
    if (record && record.status !== 'committed') record.status = 'cancelled';
    this.calls.push({ op: 'cancel', ticket, frame: this.frame() });
  }
  freezeBodies(bounds: TerrainQueryBounds, untilTick: number): void {
    this.calls.push({ op: 'freeze', bounds, untilTick, frame: this.frame() });
  }
  status(ticket: TerrainTicket): FakeTicket['status'] {
    const record = this.tickets.get(ticket);
    if (!record) throw new Error(`unknown ticket ${ticket}`);
    if (record.status === 'preparing' && this.frame() - record.preparedAt >= this.latency) return 'ready';
    return record.status;
  }
}
