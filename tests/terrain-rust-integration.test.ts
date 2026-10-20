import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ResidentPageWorkers } from '../src/gpu/terrain/page-workers';
import { RustPageWorkerRuntime, type RustPageRequest } from '../src/gpu/terrain/rust-page-worker-runtime';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { packPages } from '../src/gpu/terrain/page-packet';
import type { PageWorkerRequest } from '../src/gpu/terrain/page-worker';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

const fixture = { ...structuralFixture('three-bricks'), localConstruction: true, uniformRegions: true };
const create = () => new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true);
const module = WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
// Real WASM behind the production worker protocol, serialized as browser messages are.
class WorkerStub {
  static failInitializeOnce = false;
  private readonly rust = new RustPageWorkerRuntime(); private readonly ts = new Map<number, ResidentArrangement>();
  private queue = Promise.resolve(); private closed = false; onmessage?: Worker['onmessage'];
  postMessage(request: RustPageRequest | PageWorkerRequest) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      let data;
      try {
        if ('input' in request) {
          if (request.init && WorkerStub.failInitializeOnce) { WorkerStub.failInitializeOnce = false; throw new Error('Injected WASM initialization failure'); }
          data = await this.rust.run(request);
        }
        else {
          const shard = request.shard!; if (request.init) this.ts.set(shard, create()); const a = this.ts.get(shard)!;
          a.rollbackFields(request.truncate, request.cutCount); for (const field of request.fields) a.appendPreparedField(field);
          const packet = packPages(a.compileTets(request.requests, request.revision, request.masks)); a.releaseCaches();
          data = { id: request.id, packet, milliseconds: 0, cacheHit: false };
        }
      } catch (error) { data = { id: request.id, error: String(error) }; }
      if (!this.closed) this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent);
    });
  }
  terminate() { this.closed = true; void this.queue.then(() => this.rust.dispose()); }
}

it('live Rust worker adapter matches the TS eight-shard timeline at 1, 4 and 8 workers, including changed-field retry', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  try {
    let expected: ReturnType<typeof packPages>[] | undefined;
    for (const count of [0, 1, 4, 8]) {
      const a = create(), compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, count || 8, undefined, count ? { module: await module, generator: '' } : undefined);
      const base = a.fields.length, all = a.lattice.brickOrder.map(brick => ({ brick, tets: null })), timeline = [];
      try {
        for (let stage = 1; stage <= 3; stage++) {
          if (stage === 2) a.addCut(fixture.cuts[0]);
          if (stage === 3) { a.rollbackFields(base, 0); a.addCut({ ...fixture.cuts[0], radius: fixture.cuts[0].radius * .75 }); }
          const pages = await compiler.compile(a, all, stage, []);
          timeline.push(packPages({ vertices: a.vertices.filter(v => v.edge), pages }));
        }
        if (expected) expect(timeline).toEqual(expected); else expected = timeline;
        expect(compiler.metrics.backend).toBe(count ? 'rust-wasm' : 'typescript');
      } finally { compiler.dispose(); }
    }
  } finally { vi.unstubAllGlobals(); }
}, 30000);

it('reinitializes a shard after WASM startup failure instead of poisoning subsequent attempts', async () => {
  vi.stubGlobal('Worker', WorkerStub); WorkerStub.failInitializeOnce = true;
  const a = create(), compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, 4, undefined, { module: await module, generator: '' });
  const all = a.lattice.brickOrder.map(brick => ({ brick, tets: null }));
  try {
    await expect(compiler.compile(a, all, 1, [])).rejects.toThrow('Injected WASM initialization failure');
    const pages = await compiler.compile(a, all, 1, []); expect(pages).toHaveLength(all.length);
    expect(pages.reduce((n, p) => n + p.regions.length, 0)).toBeGreaterThan(0);
  } finally { compiler.dispose(); WorkerStub.failInitializeOnce = false; vi.unstubAllGlobals(); }
});

it('live Rust compiler preserves failed-edit rollback, detachment, body recuts and ownership masks in the real Rapier world', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v3', false, 4, undefined, { module: await module, generator: '' });
  const gate = new GeometryGate(), physics = await StructuralPhysics.create(fixture.planetCenter), host = new FakeTerrainHost();
  const terrain = new ResidentTerrain(fixture, gate.pages, physics, host, compiler);
  try {
    await terrain.initialize(); const pages = terrain.pages, queries = terrain.queries;
    gate.fail = true; await expect(terrain.cut(fixture.cuts[0])).rejects.toMatchObject({ code: 'capacity' });
    expect(terrain.pages).toBe(pages); expect(terrain.queries).toBe(queries); expect(terrain.epoch).toBe(1);
    gate.fail = false; await terrain.cut(fixture.cuts[0]);
    const detached = await terrain.cut(fixture.cuts[1]); expect(detached!.bodies.length).toBeGreaterThan(0);
    const recut = await terrain.cut({ id: 'body-recut', center: [0, 6.5, 0], radius: 1.5, repeat: 'impact' });
    expect(recut!.eligible!.length).toBeGreaterThan(0); expect(Math.abs(recut!.ledger.error)).toBeLessThan(1e-4);
    const bodies = [...physics.bodies.keys()]; expect(bodies.length).toBeGreaterThan(0);
    await terrain.rebuild(); expect([...physics.bodies.keys()]).toEqual(bodies);
    expect([...terrain.pages.values()].flatMap(p => p.regions).some(r => r.source === 'slab')).toBe(false);
    expect(terrain.history.every(e => e.seam.unpaired === 0 && e.seam.orientationErrors === 0)).toBe(true);
    expect(host.disposedWhileVisible).toBe(0);
  } finally { terrain.dispose(); vi.unstubAllGlobals(); expect(gate.live).toBe(0); }
}, 30000);
