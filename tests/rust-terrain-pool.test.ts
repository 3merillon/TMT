import { expect, it } from 'vitest';
import { RustTerrainPool, type RustWorkerSurface } from '../src/gpu/terrain/rust-core-pool';
import type { RustWorkerMessage } from '../src/gpu/terrain/rust-core-worker';
import type { ResidentLattice } from '../src/gpu/terrain/lattice';
import type { PreparedResidentField } from '../src/gpu/terrain/arrangement';

class Stub implements RustWorkerSurface {
  onmessage: RustWorkerSurface['onmessage'] = null;
  onerror: RustWorkerSurface['onerror'] = null;
  onmessageerror: RustWorkerSurface['onmessageerror'] = null;
  terminated = 0;
  constructor(private receive: (worker: Stub, message: RustWorkerMessage) => void) {}
  postMessage(message: RustWorkerMessage): void { this.receive(this, message); }
  terminate(): void { this.terminated++; }
  reply(data: unknown): void { this.onmessage?.({ data } as MessageEvent); }
}
const module = {} as WebAssembly.Module, lattice = { positions: [[0, 0, 0]], brickIndex: new Map(Array.from({ length: 20 }, (_, i) => [String(i), i])), tetById: new Map() } as unknown as ResidentLattice;
const result = (id: number) => ({ kind: 'result', id, packet: { strings: [], words: new Int32Array(), values: new Float64Array() }, memoryBytes: 0, milliseconds: 0, stages: {}, fallbacks: 0 });
const requests = Array.from({ length: 20 }, (_, i) => ({ brick: String(i), tets: null }));

it('bounds out-of-order completed jobs and publishes every result in input order', async () => {
  const workers: Stub[] = []; let posted = 0, beforeFirst = 0, firstDone = false;
  const pool = new RustTerrainPool(2, module, new Uint8Array(), lattice, [], () => {
    const worker = new Stub((w, message) => {
      if (message.kind === 'init') { queueMicrotask(() => w.reply({ kind: 'ready' })); return; }
      posted++; if (!firstDone) beforeFirst = posted;
      setTimeout(() => { if (message.id === 1) firstDone = true; w.reply(result(message.id)); }, message.id === 1 ? 40 : 0);
    }); workers.push(worker); return worker;
  });
  try {
    const published: number[] = [];
    for await (const result of pool.compile(requests, 1, [], [], undefined, 1)) published.push(result.id);
    expect(published).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(beforeFirst).toBe(4); expect(posted).toBe(20);
  } finally { pool.dispose(); }
  expect(workers.map(w => w.terminated)).toEqual([1, 1]);
});

it('aborts while workers are still initializing without waiting for a ready message', async () => {
  const workers: Stub[] = [], pool = new RustTerrainPool(2, module, new Uint8Array(), lattice, [], () => { const w = new Stub(() => {}); workers.push(w); return w; });
  const signal = new AbortController(), iteration = pool.compile(requests, 1, [], [], signal.signal).next(); signal.abort();
  await expect(iteration).rejects.toThrow('cancelled'); expect(workers.map(w => w.terminated)).toEqual([1, 1]);
});

it('resends replacement sample words after rollback even when the field id is reused', async () => {
  const initial = { field: { id: 'base' }, samples: new Float32Array([-1]), staticField: true } satisfies PreparedResidentField;
  const a = { field: { id: 'cut' }, samples: new Float32Array([1]), staticField: true } satisfies PreparedResidentField;
  const b = { ...a, samples: new Float32Array([-2]) }, sent: RustWorkerMessage[] = [];
  const pool = new RustTerrainPool(1, module, new Uint8Array(), lattice, [initial], () => new Stub((w, message) => {
    sent.push(message); queueMicrotask(() => w.reply(message.kind === 'init' ? { kind: 'ready' } : result(message.id)));
  }));
  try {
    for await (const _ of pool.compile(requests.slice(0, 1), 1, [], [initial, a])) { /* drain */ }
    for await (const _ of pool.compile(requests.slice(0, 1), 2, [], [initial, b])) { /* drain */ }
    const job = sent.at(-1)!; expect(job.kind).toBe('compile');
    if (job.kind === 'compile') {
      const view = new DataView(job.input.buffer, job.input.byteOffset, job.input.byteLength);
      expect(view.getUint32(4, true)).toBe(1); expect(view.getUint32(8, true)).toBe(1);
      // ABI field header: u32 text length, "cut", flags, then one f32 sample.
      expect(view.getFloat32(23, true)).toBe(-2);
    }
  } finally { pool.dispose(); }
});

it('closes pending workers when a consumer stops a streamed compile early', async () => {
  const workers: Stub[] = [], pool = new RustTerrainPool(2, module, new Uint8Array(), lattice, [], () => {
    const w = new Stub((w, message) => queueMicrotask(() => w.reply(message.kind === 'init' ? { kind: 'ready' } : result(message.id)))); workers.push(w); return w;
  });
  for await (const _ of pool.compile(requests, 1, [], [], undefined, 1)) break;
  expect(workers.map(w => w.terminated)).toEqual([1, 1]);
  await expect(pool.compile(requests, 1, [], []).next()).rejects.toThrow('closed');
});
