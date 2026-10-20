import { expect, it, vi } from 'vitest';
import { ResidentPageWorkers, initialPartitions, brickWorker, defaultWorkerCount, CANONICAL_SHARDS } from '../src/gpu/terrain/page-workers';
import { ResidentArrangement, type TetRequest } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { packPages } from '../src/gpu/terrain/page-packet';
import type { PageWorkerRequest } from '../src/gpu/terrain/page-worker';

it('terminates already-created workers if constructing the pool fails', () => {
  let created = 0, terminated = 0;
  class WorkerStub { constructor() { if (++created === 3) throw new Error('Worker quota'); } terminate() { terminated++; } }
  vi.stubGlobal('Worker', WorkerStub);
  try { expect(() => new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, 4)).toThrow('Worker quota'); expect(terminated).toBe(2); }
  finally { vi.unstubAllGlobals(); }
});

it.each(['decode', 'post'] as const)('rejects every pending job and releases the pool on %s failure', async (mode) => {
  let terminated = 0;
  class WorkerStub {
    onmessageerror?: Worker['onmessageerror'];
    postMessage() { if (mode === 'post') throw new Error('Post failed'); queueMicrotask(() => this.onmessageerror?.call(this as unknown as Worker, {} as MessageEvent)); }
    terminate() { terminated++; }
  }
  vi.stubGlobal('Worker', WorkerStub);
  const fixture = structuralFixture(), a = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
  const compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, 3);
  try {
    await expect(compiler.compile(a, [...a.lattice.bricks.keys()].map(brick => ({ brick, tets: null })), 1, [])).rejects.toThrow(mode === 'post' ? 'Post failed' : 'could not be decoded');
    expect(terminated).toBe(3); compiler.dispose(); expect(terminated).toBe(3);
    await expect(compiler.compile(a, [], 1, [])).rejects.toThrow('closed');
  } finally { compiler.dispose(); vi.unstubAllGlobals(); }
});

it('resends changed sample words when a rejected shot reuses its id and center with a different radius', async () => {
  const requests: PageWorkerRequest[] = [];
  class WorkerStub {
    onmessage?: Worker['onmessage']; onerror?: Worker['onerror'];
    postMessage(request: PageWorkerRequest) {
      requests.push(request);
      const pages = request.requests.map(r => ({ brick: r.brick, revision: request.revision, regions: [], removedVolume: 0, tetRemoved: new Float64Array() }));
      queueMicrotask(() => this.onmessage?.call(this as unknown as Worker, { data: { id: request.id, packet: packPages({ vertices: [], pages }), milliseconds: 0, cacheHit: false } } as MessageEvent));
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerStub);
  const fixture = structuralFixture(), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true);
  const compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v2', false, 3), bricks = [...arrangement.lattice.bricks.keys()].map(brick => ({ brick, tets: null })), base = arrangement.fields.length;
  try {
    await compiler.compile(arrangement, bricks, 1, []);
    arrangement.addCut({ id: 'same-impact', center: [0, 6, 0], radius: 1 }); await compiler.compile(arrangement, bricks, 2, []);
    arrangement.rollbackFields(base, 0);
    arrangement.addCut({ id: 'same-impact', center: [0, 6, 0], radius: 2 }); requests.length = 0;
    await compiler.compile(arrangement, bricks, 2, []);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) { expect(request.truncate).toBe(base); expect(request.fields).toHaveLength(1); expect(request.fields[0].cut?.radius).toBe(2); }
  } finally { compiler.dispose(); vi.unstubAllGlobals(); }
});

it('keeps initial spatial batches balanced and cuts distributed without losing or reordering bricks', () => {
  const requests: TetRequest[] = Array.from({ length: 512 }, (_, i) => ({ brick: `${Math.floor(i / 64) - 4},${Math.floor(i / 8) % 8 - 4},${i % 8 - 4}`, tets: null }));
  for (const count of [1, 2, 3, 4, 6, 8]) {
    const partitions = initialPartitions(requests, count), order = new Map(requests.map((r, i) => [r, i]));
    expect(partitions).toHaveLength(count);
    expect(new Set(partitions.flat())).toEqual(new Set(requests));
    expect(Math.max(...partitions.map(p => p.length)) - Math.min(...partitions.map(p => p.length))).toBeLessThanOrEqual(1);
    for (const partition of partitions) expect(partition.map(p => order.get(p))).toEqual(partition.map(p => order.get(p)).sort((a, b) => a! - b!));
  }
  const owners = new Map(initialPartitions(requests, 8).flatMap((p, i) => p.map(r => [r.brick, i] as const)));
  let spatialEdges = 0, coloredEdges = 0;
  for (const { brick } of requests) { const p = brick.split(',').map(Number); for (let a = 0; a < 3; a++) if (p[a] < 3) { const q = [...p]; q[a]++; const next = q.join(',');
    spatialEdges += Number(owners.get(brick) !== owners.get(next)); coloredEdges += Number(brickWorker(brick, 8) !== brickWorker(next, 8)); } }
  expect(spatialEdges).toBe(192); expect(coloredEdges).toBe(1344);
});

it('does not post work for a signal that was already cancelled, and only enables worker overrides with diagnostics', async () => {
  class WorkerStub { postMessage() { throw new Error('Cancelled job reached a worker'); } terminate() {} }
  vi.stubGlobal('Worker', WorkerStub);
  const fixture = structuralFixture(), a = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources), compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v2', false, 2, 'glacial');
  const abort = new AbortController(); abort.abort();
  try {
    await expect(compiler.compile(a, [{ brick: [...a.lattice.bricks.keys()][0], tets: null }], 1, [], abort.signal)).rejects.toMatchObject({ code: 'cancelled' });
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 }); vi.stubGlobal('location', { search: '?residentWorkers=1' }); expect(defaultWorkerCount()).toBe(7);
    vi.stubGlobal('location', { search: '?residentCheck&residentWorkers=1' }); expect(defaultWorkerCount()).toBe(1);
  } finally { compiler.dispose(); vi.unstubAllGlobals(); }
});

it('preserves eight-shard recipe history and packet bits with 1, 2, 4 or 8 physical workers through cuts and rollback', async () => {
  const fixture = structuralFixture('three-bricks');
  const create = () => new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true);
  const physical: WorkerStub[] = [];
  class WorkerStub {
    readonly states = new Map<number, ResidentArrangement>();
    onmessage?: Worker['onmessage'];
    constructor() { physical.push(this); }
    postMessage(request: PageWorkerRequest) {
      // Real workers serialize compilation, while unrelated workers can complete in any order. Reverse completion
      // timing here so the test checks that publication follows shard order, not message arrival.
      const shard = request.shard!; let a = this.states.get(shard);
      if (request.init) { a = create(); this.states.set(shard, a); }
      if (!a) throw new Error('Uninitialized logical shard');
      a.rollbackFields(request.truncate, request.cutCount); for (const field of request.fields) a.appendPreparedField(field);
      const packet = packPages(a.compileTets(request.requests, request.revision, request.masks));
      setTimeout(() => this.onmessage?.call(this as unknown as Worker, { data: { id: request.id, packet, milliseconds: 0, cacheHit: false } } as MessageEvent), CANONICAL_SHARDS - shard);
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerStub);
  try {
    let reference: ReturnType<typeof packPages>[] | undefined;
    for (const count of [8, 4, 2, 1]) {
      physical.length = 0;
      const a = create(), compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, count), base = a.fields.length;
      const requests = a.lattice.brickOrder.map(brick => ({ brick, tets: null })), packets: ReturnType<typeof packPages>[] = [];
      try {
        for (let stage = 1; stage <= 3; stage++) {
          if (stage === 2) a.addCut(fixture.cuts[0]);
          if (stage === 3) { a.rollbackFields(base, 0); a.addCut({ ...fixture.cuts[0], radius: fixture.cuts[0].radius * .75 }); }
          const pages = await compiler.compile(a, requests, stage, []);
          packets.push(packPages({ vertices: a.vertices.filter(v => v.edge), pages }));
        }
        expect(physical).toHaveLength(count);
        expect(new Set(physical.flatMap(w => [...w.states.keys()])).size).toBeGreaterThan(1);
        expect(compiler.metrics.workers).toBe(count); expect(compiler.metrics.logicalShards).toBe(8);
        if (reference) expect(packets).toEqual(reference); else reference = packets;
      } finally { compiler.dispose(); }
    }
  } finally { vi.unstubAllGlobals(); }
}, 30000);
