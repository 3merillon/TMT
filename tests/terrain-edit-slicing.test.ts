/** The edit path's slicing and its commit report (perf pass): staging cooks between yields and creates nothing until its
 * last step, an abandoned stage frees what it cooked, the dirty box holds every static triangle a commit changes, the
 * page table clips its pages' bounds to that box, and page workers receive ownership masks as deltas. */
import { expect, it, vi } from 'vitest';
import type { Vec3 } from '../src/core/types';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { ResidentArrangement, type OwnershipMask } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { ResidentPageWorkers } from '../src/gpu/terrain/page-workers';
import { packPages } from '../src/gpu/terrain/page-packet';
import type { PageWorkerRequest } from '../src/gpu/terrain/page-worker';
import type { BodyCandidate } from '../src/gpu/terrain/contracts';
import { StructuralPhysics } from '../src/game/structural-physics';
import { structuralCandidate } from '../src/game/structural-colliders';
import { terrainConnectivity } from '../src/game/terrain-connectivity';
import { TerrainPageTable } from '../src/engine/scene/terrain-pages';
import type { PageBuffers } from '../src/gpu/terrain/render-host';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

const strip = (id: number, x: number): BodyCandidate => ({ id, regions: [], center: [0, 0, 0], colliders: [{ kind: 'trimesh', regionIds: [], volume: 0,
  vertices: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 0, 1]), indices: new Uint32Array([0, 2, 1]) }] });

it('creates no body before its last step, frees what it cooked when abandoned, and stages as stage() does', async () => {
  const fixture = structuralFixture('two-supports'), a = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
  fixture.cuts.forEach(cut => a.addCut(cut));
  const graph = terrainConnectivity([...a.lattice.bricks.keys()].flatMap(brick => a.rebuild(brick, 1).regions), a);
  const body = structuralCandidate(1, graph.detached[0], a), statics = [strip(-1, 0), strip(-2, 3), strip(-3, 6)];
  const physics = await StructuralPhysics.create(fixture.planetCenter), twin = await StructuralPhysics.create(fixture.planetCenter);
  try {
    const steps = physics.stageSteps(statics, [body]);
    for (let i = 0; i < 3; i++) expect(steps.next().done).toBe(false);
    expect(physics.world.bodies.len()).toBe(0);
    steps.return(undefined as never);
    expect(physics.world.bodies.len()).toBe(0); expect(physics.world.colliders.len()).toBe(0);
    const sliced = physics.stageSteps(statics, [body]); let next = sliced.next();
    while (!next.done) { expect(physics.world.colliders.len()).toBe(0); next = sliced.next(); }
    next.value.commit(); twin.stage(statics, [body]).commit();
    expect(physics.world.colliders.len()).toBe(twin.world.colliders.len());
    for (let i = 0; i < 120; i++) { physics.step(); twin.step(); }
    const pose = (p: StructuralPhysics) => { const b = p.bodies.get(1)!.body, t = b.translation(), q = b.rotation(); return [t.x, t.y, t.z, q.x, q.y, q.z, q.w]; };
    expect(pose(physics)).toEqual(pose(twin));
  } finally { physics.dispose(); twin.dispose(); }
}, 60000);

it('reports a dirty box holding every static triangle a commit adds or removes', async () => {
  const fixture = structuralFixture('two-supports'), host = new FakeTerrainHost(), boxes: ({ min: Vec3; max: Vec3 } | undefined)[] = [];
  const commit = host.commit.bind(host); host.commit = change => { boxes.push((change as { dirty?: { min: Vec3; max: Vec3 } }).dirty); commit(change); };
  const terrain = new ResidentTerrain(fixture, new GeometryGate().pages, await StructuralPhysics.create(fixture.planetCenter), host);
  const triangles = () => {
    const set = new Map<string, number>();
    for (const { mesh } of terrain.queries.fixed.chunks.values()) for (let t = 0; t < mesh.indices.length / 3; t++) {
      const points = [0, 1, 2].map(k => [...mesh.positions.subarray(mesh.indices[t * 3 + k] * 3, mesh.indices[t * 3 + k] * 3 + 3)]);
      const key = JSON.stringify(points) + mesh.materials[t]; set.set(key, (set.get(key) ?? 0) + 1);
    }
    return set;
  };
  try {
    await terrain.initialize(); expect(boxes.at(-1)).toBeUndefined();
    // The second support cut detaches the slab: its regions leave the static pages.
    for (const cut of [...fixture.cuts, { id: 'foundation', center: [1, 0.4, 3] as Vec3, radius: 1.4 }]) {
      const before = triangles(); await terrain.cut(cut); const after = triangles(), box = boxes.at(-1)!;
      expect(box).toBeDefined();
      for (let a = 0; a < 3; a++) { expect(box.min[a]).toBeLessThanOrEqual(cut.center[a] - cut.radius); expect(box.max[a]).toBeGreaterThanOrEqual(cut.center[a] + cut.radius); }
      let changed = 0;
      for (const key of new Set([...before.keys(), ...after.keys()])) if ((before.get(key) ?? 0) !== (after.get(key) ?? 0)) {
        changed++;
        for (const point of JSON.parse(key.slice(0, key.lastIndexOf(']') + 1)) as number[][]) for (let a = 0; a < 3; a++) {
          expect(point[a]).toBeGreaterThanOrEqual(box.min[a]); expect(point[a]).toBeLessThanOrEqual(box.max[a]);
        }
      }
      expect(changed).toBeGreaterThan(0);
    }
  } finally { terrain.dispose(); }
}, 60000);

it('clips the pages bounding box to the reported dirty box, never widening it', () => {
  const buffer = {} as GPUBuffer, buffers: PageBuffers = { position: buffer, normal: buffer, surface: buffer, index: buffer, indirect: buffer, vertexCount: 3, indexCount: 3 };
  const table = new TerrainPageTable({ release() {} });
  const page = (x: number) => table.create(buffers, { brick: `${x},0,0`, origin: [0, 0, 0], bounds: { min: [x * 6, 0, 0], max: [x * 6 + 6, 6, 6] } });
  const a = page(0), b = page(1);
  const all = table.commit({ show: [a], hide: [] }).dirty!;
  expect(table.commit({ show: [b], hide: [a], dirty: { min: [5, 1, 1], max: [7, 2, 2] } }).dirty).toEqual({ min: [5, 1, 1], max: [7, 2, 2] });
  const wide = table.commit({ show: [a], hide: [b], dirty: { min: [-100, -100, -100], max: [100, 100, 100] } }).dirty!;
  expect(wide.max[0] - wide.min[0]).toBeLessThan(200); expect(all.min[0]).toBeLessThan(0);
  expect(table.commit({ show: [], hide: [], dirty: { min: [0, 0, 0], max: [1, 1, 1] } }).dirty).toBeNull();
});

it('sends page workers only the ownership masks appended since their last request, and moves the field samples', async () => {
  const requests: { request: PageWorkerRequest; transfer?: Transferable[] }[] = [];
  class WorkerStub {
    onmessage?: Worker['onmessage'];
    postMessage(request: PageWorkerRequest, transfer?: Transferable[]) {
      // A real post clones the request now; the caller keeps appending to the array it passed.
      requests.push({ request: { ...request, masks: [...request.masks] }, transfer });
      const pages = request.requests.map(r => ({ brick: r.brick, revision: request.revision, regions: [], removedVolume: 0, tetRemoved: new Float64Array() }));
      queueMicrotask(() => this.onmessage?.call(this as unknown as Worker, { data: { id: request.id, packet: packPages({ vertices: [], pages }), milliseconds: 0, cacheHit: false } } as MessageEvent));
    }
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerStub);
  const fixture = structuralFixture(), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true);
  const compiler = new ResidentPageWorkers(7, [], 'resident-f32-game-v2', false, 1), bricks = [...arrangement.lattice.bricks.keys()].map(brick => ({ brick, tets: null }));
  const masks: OwnershipMask[] = [];
  try {
    await compiler.compile(arrangement, bricks, 1, masks);
    masks.push({ tet: 'a', constraints: [1], body: 1 }, { tet: 'b', constraints: [-2], body: 1 });
    arrangement.addCut({ id: 'shot', center: [0, 6, 0], radius: 1 });
    await compiler.compile(arrangement, bricks, 2, masks);
    masks.push({ tet: 'c', constraints: [3], body: 2 });
    await compiler.compile(arrangement, bricks, 3, masks);
    // Delta history belongs to logical shards, even when they all share one physical Worker.
    for (const shard of new Set(requests.map(r => r.request.shard))) {
      const history = requests.filter(r => r.request.shard === shard);
      expect(history.map(({ request }) => [request.maskStart, request.masks.map(m => m.tet)])).toEqual([[0, []], [0, ['a', 'b']], [2, ['c']]]);
      const shot = history[1];
      expect(shot.request.fields).toHaveLength(1);
      expect(shot.transfer).toEqual([shot.request.fields[0].samples.buffer]);
    }
    await compiler.compile(arrangement, bricks, 4, [...masks]);
    expect(requests.at(-1)!.request.maskStart).toBe(0); expect(requests.at(-1)!.request.masks).toHaveLength(3);
  } finally { compiler.dispose(); vi.unstubAllGlobals(); }
});
