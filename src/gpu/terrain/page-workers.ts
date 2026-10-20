/** Eight logical compiler shards preserve the desktop oracle's construction order at every physical worker count.
 * A worker may host several shards; each shard retains its own recipe history across edits. */
import type { TerrainStructure } from '../../game/terrain-structures';
import type { ResidentArrangement, OwnershipMask, TetRequest } from './arrangement';
import { ResidentFailure, type CompiledRegionPage, type SampleField, type CompilerMetrics, type TerrainPreparationProgress } from './contracts';
import type { PageWorkerRequest } from './page-worker';
import type { ResidentGameProfile } from './planet';
import { unpackPageSteps, type PackedResidentPages } from './page-packet';
import { drainTerrainWork, WorkBudget } from './work-budget';
import type { PlanetType } from '../../game/planet-field';
import { encodeRustCore, encodeRustCompile } from './rust-core';
import type { RustPageRequest } from './rust-page-worker-runtime';
import { PAGE_CACHE_VERSION } from './page-cache';

export const CANONICAL_SHARDS = 8;

export interface ResidentPageCompiler {
  /** Compile the requested tets (tets: null = the whole brick); results come back in request order. */
  compile(arrangement: ResidentArrangement, requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[], signal?: AbortSignal, progress?: (progress: TerrainPreparationProgress) => void): Promise<CompiledRegionPage[]>;
  readonly metrics?: CompilerMetrics;
  dispose(): void;
}
/** Worker of a brick: (x + 2y + 4z) mod N over brick coordinates. Any 2×2×2 block of neighbouring bricks takes 8
 * consecutive values, so a crater's dirty bricks spread over min(N, 8) workers; the whole planet stays balanced. */
export function brickWorker(brick: string, workers: number): number {
  const [x, y, z] = brick.split(',').map(Number);
  return (((x + 2 * y + 4 * z) % workers) + workers) % workers;
}
/** Cold builds use spatial batches: sharing a worker lets neighboring bricks reuse their face traces and recipes.
 * Split the longest spatial axis recursively; proportional splits keep every worker's brick count balanced.
 * Edits still use brickWorker so the 2×2×2 neighborhood of a crater runs in parallel. */
export function initialPartitions(requests: readonly TetRequest[], workers: number): TetRequest[][] {
  const partitions: TetRequest[][] = [];
  const split = (entries: { request: TetRequest; point: number[]; order: number }[], count: number): void => {
    if (count === 1) { partitions.push(entries.sort((a, b) => a.order - b.order).map(e => e.request)); return; }
    const spans = [0, 1, 2].map(a => { let lo = Infinity, hi = -Infinity; for (const e of entries) { lo = Math.min(lo, e.point[a]); hi = Math.max(hi, e.point[a]); } return hi - lo; });
    const axis = spans.indexOf(Math.max(...spans)), left = Math.floor(count / 2), at = Math.round(entries.length * left / count);
    entries.sort((a, b) => a.point[axis] - b.point[axis] || a.order - b.order);
    split(entries.slice(0, at), left); split(entries.slice(at), count - left);
  };
  split(requests.map((request, order) => ({ request, point: request.brick.split(',').map(Number), order })), workers);
  return partitions;
}
export function defaultWorkerCount(): number {
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  const params = new URLSearchParams(search ?? ''), override = Number(params.get('residentWorkers'));
  if (params.has('residentCheck') && Number.isInteger(override) && override >= 1 && override <= 8) return override;
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(8, cores - 1));
}
export class ResidentPageWorkers implements ResidentPageCompiler {
  metrics: CompilerMetrics = { workerMs: [], packetBytes: 0, mergeMs: 0, cacheHits: 0, workers: 0, longestSliceMs: 0, workerStages: [] };
  private sequence = 0;
  private disposed = false;
  private readonly pool: Worker[] = [];
  /** Per worker: the fields and the masks it holds (masks are append-only, so later requests send only new ones). */
  private readonly workers: { worker: Worker; keys: SampleField[]; initialized: boolean; masks?: readonly OwnershipMask[]; maskCount: number }[] = [];
  private readonly pending = new Map<number, { resolve: (packet: PackedResidentPages) => void; reject: (error: Error) => void }>();
  constructor(private readonly seed: number, private readonly structures: readonly TerrainStructure[], private readonly profile: ResidentGameProfile, private readonly cache = true, count = defaultWorkerCount(), private readonly kind?: PlanetType, private readonly rust?: { module: WebAssembly.Module; generator: string }) {
    if (!Number.isInteger(count) || count < 1 || count > CANONICAL_SHARDS) throw new Error('Terrain worker count must be 1..8');
    try {
      for (let i = 0; i < count; i++) this.pool.push(rust ? new Worker(new URL('./rust-page-worker.ts', import.meta.url), { type: 'module' }) : new Worker(new URL('./page-worker.ts', import.meta.url), { type: 'module' }));
      for (let i = 0; i < CANONICAL_SHARDS; i++) this.workers.push({ worker: this.pool[i % count], keys: [], initialized: false, maskCount: 0 });
    }
    catch (error) { this.dispose(); throw error; }
    this.metrics.workers = count;
    for (const worker of this.pool) {
      worker.onmessage = event => { const { id, error, packet, milliseconds, cacheHit, stages } = event.data, pending = this.pending.get(id); if (!pending) return; this.pending.delete(id);
        if (error) pending.reject(new Error(error)); else { this.metrics.workerMs.push(milliseconds); if (stages) this.metrics.workerStages?.push(stages); this.metrics.packetBytes += packet.words.byteLength + packet.values.byteLength; this.metrics.cacheHits += Number(cacheHit); pending.resolve(packet); } };
      worker.onerror = event => this.fail(new Error(event.message || 'Terrain worker failed'));
      worker.onmessageerror = () => this.fail(new Error('Terrain worker result could not be decoded'));
    }
  }
  async compile(arrangement: ResidentArrangement, requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[], signal?: AbortSignal, progress?: (progress: TerrainPreparationProgress) => void): Promise<CompiledRegionPage[]> {
    if (this.disposed) throw new Error('Terrain workers were closed');
    this.metrics = { workerMs: [], packetBytes: 0, mergeMs: 0, cacheHits: 0, workers: this.pool.length, logicalShards: CANONICAL_SHARDS, longestSliceMs: 0, workerStages: [], backend: this.rust ? 'rust-wasm' : 'typescript' };
    // Frozen field identity includes its prepared scalar words. A failed shot
    // can reuse the same id/center with another radius; metadata is insufficient.
    if (signal?.aborted) throw new ResidentFailure('cancelled', 'Resident edit cancelled');
    const keys = [...arrangement.fields];
    const params = new URLSearchParams((globalThis as { location?: { search?: string } }).location?.search ?? '');
    const spatial = revision === 1 && requests.every(r => r.tets === null) && !(params.has('residentCheck') && params.get('residentPartition') === 'checkerboard');
    const partitions = spatial ? initialPartitions(requests, this.workers.length) : this.workers.map(() => [] as TetRequest[]);
    if (!spatial) for (const request of requests) partitions[brickWorker(request.brick, this.workers.length)].push(request);
    const ids: number[] = [];
    const cancel = () => { for (const id of ids) { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending.reject(new ResidentFailure('cancelled', 'Resident edit cancelled')); } } };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const base = arrangement.boxFields.flat().reduce((max, field) => Math.max(max, field + 1), 0);
      let rustInitial: Uint8Array | undefined;
      if (this.rust && this.workers.some(entry => !entry.initialized)) {
        const encoded = encodeRustCore({ lattice: arrangement.lattice, fields: arrangement.preparedFields(0).slice(0, base), sources: arrangement.boxes, sourceFields: arrangement.boxFields });
        if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated) { rustInitial = new Uint8Array(new SharedArrayBuffer(encoded.byteLength)); rustInitial.set(encoded); } else rustInitial = encoded;
      }
      const posted = this.workers.map(async (entry, worker) => {
        if (!partitions[worker].length) return undefined;
        let common = entry.initialized ? 0 : base;
        if (entry.initialized) while (common < keys.length && entry.keys[common] === keys[common]) common++;
        const id = ++this.sequence; ids.push(id);
        const maskStart = entry.initialized && entry.masks === masks && entry.maskCount <= masks.length ? entry.maskCount : 0;
        const request: PageWorkerRequest = { id, shard: worker, init: entry.initialized ? undefined : { seed: this.seed, structures: this.structures, profile: this.profile, kind: this.kind, cache: this.cache, workers: CANONICAL_SHARDS },
          truncate: common, cutCount: arrangement.cutFields.filter(field => field < common).length, fields: arrangement.preparedFields(common),
          requests: partitions[worker], revision, masks: maskStart ? masks.slice(maskStart) : masks, maskStart };
        const rustRequest: RustPageRequest | undefined = this.rust ? {
          id, shard: worker, init: entry.initialized ? undefined : { module: this.rust.module, initial: rustInitial! },
          input: encodeRustCompile(arrangement.lattice, partitions[worker], revision, masks, common, request.fields),
          cacheKey: this.cache && !entry.initialized && revision === 1 && !request.fields.length && !masks.length && partitions[worker].every(r => r.tets === null)
            ? JSON.stringify([PAGE_CACHE_VERSION, this.rust.generator, this.seed, this.profile, CANONICAL_SHARDS, partitions[worker].map(r => r.brick)]) : undefined,
        } : undefined;
        entry.initialized = true; entry.keys = keys; entry.masks = masks; entry.maskCount = masks.length;
        return new Promise<PackedResidentPages>((resolve, reject) => {
          if (this.disposed) { reject(new Error('Terrain workers were closed')); return; }
          this.pending.set(id, { resolve, reject });
          // The prepared samples are this worker's own copies: move them rather than clone them again.
          try { if (rustRequest) entry.worker.postMessage(rustRequest, [rustRequest.input.buffer]); else entry.worker.postMessage(request, request.fields.map(field => field.samples.buffer)); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
        }).catch(error => {
          // A failed/cancelled initialization may never have installed this shard. Retrying with a
          // fresh init is safe even when the previous message is still queued in its physical worker.
          if (request.init) { entry.initialized = false; entry.keys = []; entry.masks = undefined; entry.maskCount = 0; }
          throw error;
        });
      });
      // Every request settles (no unhandled rejection when an earlier one fails first).
      const settled = Promise.allSettled(posted);
      const pages = new Map<string, CompiledRegionPage>(), check = () => { if (signal?.aborted) throw new ResidentFailure('cancelled', 'Resident edit cancelled'); };
      let mergeMs = 0;
      // One slice clock for the whole merge: successive packets must not each start a fresh slice.
      const clock = new WorkBudget(revision === 1 ? 20 : 4, check);
      try {
        // Merge in stable worker order (the accepted f32 construction is independent of completion order), each
        // packet as soon as it and its predecessors arrive, overlapping the slower workers' compile.
        for (const result of posted) {
          clock.pause(); const packed = await result; check(); clock.reset(); if (!packed) continue;
          const merge = performance.now();
          const packet = await drainTerrainWork(unpackPageSteps(packed), check, clock);
          // posted/allSettled retain their resolved packet objects until the whole compile finishes.
          // Drop consumed transfer storage now; decoded objects keep the required strings and values.
          packed.words = new Int32Array(0); packed.values = new Float64Array(0); packed.strings = [];
          for (const page of await drainTerrainWork(arrangement.acceptCompiledSteps(packet), check, clock)) pages.set(page.brick, page);
          mergeMs += performance.now() - merge;
          progress?.({ stage: 'topology', completed: pages.size, total: requests.length });
        }
      } finally { await settled; }
      this.metrics.mergeMs = mergeMs; this.metrics.longestSliceMs = clock.longest;
      return requests.map(request => { const page = pages.get(request.brick); if (!page) throw new Error(`Terrain worker lost brick ${request.brick}`); return page; });
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  private fail(error: Error): void { for (const p of this.pending.values()) p.reject(error); this.pending.clear(); this.dispose(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const worker of this.pool) worker.terminate(); for (const p of this.pending.values()) p.reject(new Error('Terrain workers were closed')); this.pending.clear(); }
}
