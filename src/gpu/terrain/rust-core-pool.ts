import type { ResidentLattice } from './lattice';
import type { OwnershipMask, PreparedResidentField, TetRequest } from './arrangement';
import type { PackedResidentPages } from './page-packet';
import type { RustWorkerMessage } from './rust-core-worker';
import { encodeRustCompile } from './rust-core';

export interface RustWorkerSurface {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: RustWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface RustWorkerResult {
  id: number; packet: PackedResidentPages; milliseconds: number; memoryBytes: number;
  stages: Record<string, number>; fallbacks: number;
  cacheHit?: boolean;
}
interface Slot { worker: RustWorkerSurface; sent: PreparedResidentField[]; busy: boolean; memoryBytes: number }
interface Pending { resolve: (value: RustWorkerResult) => void; reject: (error: Error) => void }

/** A bounded sliding window keeps CPUs occupied without collecting an entire world's packets.
 * Jobs publish in input order, regardless of which physical worker runs or finishes them. */
export class RustTerrainPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>[] = [];
  private readonly readyReject: ((error: Error) => void)[] = [];
  private schedule: (() => void) | undefined;
  private closed: Error | undefined; private running = false; private serial = 0;
  constructor(count: number, module: WebAssembly.Module, initial: Uint8Array, private readonly lattice: ResidentLattice, initialFields: readonly PreparedResidentField[], createWorker: () => RustWorkerSurface = () => new Worker(new URL('./rust-core-worker.ts', import.meta.url), { type: 'module' })) {
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Rust terrain worker count must be 1..8');
    // Shared bootstrap avoids a structured-clone copy for each worker when isolation is available.
    let input = initial;
    if (typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated !== false) { input = new Uint8Array(new SharedArrayBuffer(initial.byteLength)); input.set(initial); }
    try {
      for (let i = 0; i < count; i++) {
        if (this.closed) throw this.closed;
        const worker = createWorker(), slot: Slot = { worker, sent: [...initialFields], busy: false, memoryBytes: 0 }; this.slots.push(slot);
        this.ready.push(new Promise<void>((resolve, reject) => {
          this.readyReject.push(reject);
          worker.onmessage = event => {
            const reply = event.data;
            if (reply.kind === 'ready') { slot.memoryBytes = reply.memoryBytes; resolve(); return; }
            if (reply.kind === 'error') { const error = new Error(reply.error); reject(error); this.fail(error); return; }
            const pending = this.pending.get(reply.id); if (!pending) return;
            this.pending.delete(reply.id); slot.busy = false; slot.memoryBytes = reply.memoryBytes; pending.resolve(reply); this.schedule?.();
          };
          worker.onerror = event => { const error = new Error(event.message || 'Rust terrain worker failed'); reject(error); this.fail(error); };
          worker.onmessageerror = () => { const error = new Error('Rust terrain worker message could not be decoded'); reject(error); this.fail(error); };
          worker.postMessage({ kind: 'init', module, initial: input });
        }));
      }
    } catch (error) { for (const ready of this.ready) void ready.catch(() => {}); this.fail(error instanceof Error ? error : new Error(String(error))); throw error; }
    // A startup error can precede the first compile/await. Keep it observed until compile reports it.
    for (const ready of this.ready) void ready.catch(() => {});
  }
  private fail(error: Error): void {
    if (this.closed) return; this.closed = error;
    for (const reject of this.readyReject) reject(error);
    for (const slot of this.slots) slot.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error); this.pending.clear();
  }
  dispose(): void { this.fail(new Error('Rust terrain pool is closed')); }
  /** Each worker's WASM linear memory, as last reported (diagnostics). */
  get memory(): number[] { return this.slots.map(s => s.memoryBytes); }
  async initialized(): Promise<void> { await Promise.all(this.ready); if (this.closed) throw this.closed; }
  async * compile(requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[] | Uint32Array, fields: readonly PreparedResidentField[], signal?: AbortSignal, batchSize = 8, cachePrefix?: string): AsyncGenerator<RustWorkerResult> {
    if (this.running) throw new Error('Rust terrain compile already in progress');
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid Rust terrain batch size');
    if (this.closed) throw this.closed; this.running = true;
    const cancel = () => this.fail(new Error('Rust terrain compile cancelled'));
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const waiting = new Map<number, Promise<RustWorkerResult>>(); let submitted = 0, sequence = 0, published = 0, completed = false;
    const submit = (slot: Slot) => {
      let same = 0; while (same < fields.length && same < slot.sent.length && fields[same] === slot.sent[same]) same++;
      // Prepared fields are immutable records. A retry with changed samples must use a fresh record.
      const delta = fields.slice(same), id = ++this.serial, selected = requests.slice(submitted, submitted + batchSize); submitted += selected.length;
      slot.busy = true; slot.sent = [...fields];
      const promise = new Promise<RustWorkerResult>((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
      void promise.catch(() => {}); waiting.set(sequence++, promise);
      try { const input = encodeRustCompile(this.lattice, selected, revision, masks, same, delta);
        const cacheKey = cachePrefix && revision === 1 && selected.every(r => r.tets === null) ? `${cachePrefix}:${selected.map(r => this.lattice.brickIndex.get(r.brick)).join(',')}` : undefined;
        slot.worker.postMessage({ kind: 'compile', id, input, cacheKey }, [input.buffer as ArrayBuffer]); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    };
    const refill = () => { if (this.closed) return; for (const slot of this.slots) if (!slot.busy && submitted < requests.length && waiting.size < this.slots.length * 2) submit(slot); };
    try {
      await Promise.all(this.ready); if (this.closed) throw this.closed;
      this.schedule = refill; refill();
      while (waiting.size) {
        const result = await waiting.get(published)!; waiting.delete(published++); refill(); yield result;
        if (this.closed) throw this.closed;
      }
      completed = true;
    } finally {
      signal?.removeEventListener('abort', cancel); this.running = false; this.schedule = undefined;
      if (!completed) this.dispose();
    }
  }
}
