/** Resident transactions, partial edits, rollback/retry and detached ownership across worker histories. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ResidentArrangement, type OwnershipMask, type TetRequest } from '../src/gpu/terrain/arrangement';
import { structuralFixture, type FixtureName } from '../src/gpu/terrain/fixtures';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import { terrainConnectivity, auditBoundary } from '../src/game/terrain-connectivity';
import type { RegionPage } from '../src/gpu/terrain/contracts';
import type { PackedResidentPages } from '../src/gpu/terrain/page-packet';
import { verifyRustFeed } from './rust-feed-oracle';

assert.ok(process.argv[2] && process.argv[3], 'Pass release WASM and report path');
const module = await WebAssembly.compile(readFileSync(process.argv[2])), rows: unknown[] = [];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const packetHash = (p: PackedResidentPages) => createHash('sha256').update(new Uint8Array(p.words.buffer, p.words.byteOffset, p.words.byteLength)).update(new Uint8Array(p.values.buffer, p.values.byteOffset, p.values.byteLength)).digest('hex');
for (const name of ['one-support', 'two-supports', 'three-bricks', 'arch'] as FixtureName[]) {
  let expected: string | undefined;
  for (const [count, batch] of [[1, 1], [4, 3], [8, 8]]) {
    const input = structuralFixture(name), lattice = residentLattice(input.bounds), reference = new ResidentArrangement(lattice, input.sources, 2048, true, true), base = reference.fields.length;
    const initial = encodeRustCore({ lattice, fields: reference.preparedFields(0), sources: reference.boxes, sourceFields: reference.boxFields, canonicalConstruction: true });
    const world = await RustTerrainCore.createWorld(module, initial, base), workers = await Promise.all(Array.from({ length: count }, () => RustTerrainCore.create(module, lattice, initial)));
    const pages = new Map<string, RegionPage>(), timeline: unknown[] = []; let job = 0, revision = 0, worldFields = base;
    const all = lattice.brickOrder.map(brick => ({ brick, tets: null }));
    const compile = (requests: readonly TetRequest[], rev: number, masks: readonly OwnershipMask[] = []) => {
      const worker = workers[job++ % count], packet = worker.compile(requests, rev, masks, base, reference.preparedFields(base), undefined, true); worker.resetConstruction(); return packet;
    };
    const verify = (label: string) => {
      const regions = lattice.brickOrder.flatMap(brick => pages.get(brick)?.regions ?? []), graph = terrainConnectivity(regions, reference), boundary = auditBoundary(graph.boundary), stats = world.worldStats;
      assert.equal(boundary.unpaired, 0); assert.equal(boundary.orientationErrors, 0); assert.equal(stats.regions, regions.length); assert.equal(stats.portals, graph.portals.length); assert.equal(stats.boundaryFaces, graph.boundary.length); assert.equal(stats.anchoredRegions, graph.anchored.length); assert.equal(stats.detachedGroups, graph.detached.length); assert.equal(stats.edges, boundary.edges);
      verifyRustFeed(world, reference, regions, graph);
      for (const p of unpackRustPages(world.exportWorld(), lattice, reference.boxes, reference.fields).pages) {
        const old = pages.get(p.brick)!; assert.deepEqual(p.regions, old.regions); assert.deepEqual(p.tetRemoved, old.tetRemoved); assert.equal(p.removedVolume, old.removedVolume);
      }
      const face = (f: { source: string; vertices: readonly number[] }) => { const cycle = f.vertices.map(id => JSON.stringify(reference.vertices[id].position)); let at = 0; for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[at]) at = i; return [f.source, [...cycle.slice(at), ...cycle.slice(0, at)]]; };
      timeline.push([label, regions.map(r => [r.id, r.volume, r.constraints, r.faces.map(face).map(f => JSON.stringify(f)).sort()]), graph.detached.map(group => group.map(r => r.id).sort()).sort()]);
      return graph;
    };
    const transaction = (label: string, requests: readonly TetRequest[], masks: readonly OwnershipMask[] = []) => {
      world.begin(++revision, reference.preparedFields(worldFields));
      for (let at = 0; at < requests.length; at += batch) {
        const packet = compile(requests.slice(at, at + batch), revision, masks); world.ingest(packet);
        for (const page of reference.acceptCompiled(unpackRustPages(packet, lattice, reference.boxes, reference.fields))) pages.set(page.brick, reference.assemble(page, pages.get(page.brick)));
      }
      world.connect(); world.commit(); worldFields = reference.fields.length; return verify(label);
    };
    try {
      transaction('startup', all);
      assert.throws(() => world.compileEncoded(new Uint8Array()), /compiler handle/); assert.throws(() => workers[0].connect(), /world handle/);
      const old = packetHash(world.exportWorld()), stats = world.worldStats;
      const field = reference.addCut(input.cuts[0]), requests = reference.tetRequests(reference.dirtyTets(field));
      const packet = compile(requests, revision + 1), delta = reference.preparedFields(worldFields);
      world.begin(revision + 1, delta); world.ingest(packet);
      assert.equal(packetHash(world.exportWorld()), old, 'Staged pages escaped publication'); assert.equal(world.worldStats.regions, stats.regions);
      world.abort(); assert.equal(packetHash(world.exportWorld()), old); assert.deepEqual(world.worldStats, stats);
      world.begin(revision + 1, delta);
      assert.throws(() => world.ingest({ ...packet, words: Int32Array.from([...packet.words, 123]) }), /Trailing/);
      assert.equal(packetHash(world.exportWorld()), old); assert.deepEqual(world.worldStats, stats); assert.throws(() => world.commit(), /not prepared/);
      world.begin(revision + 1, delta); world.ingest(packet); assert.throws(() => world.ingest(packet), /Duplicate/); assert.equal(packetHash(world.exportWorld()), old); assert.deepEqual(world.worldStats, stats);
      world.begin(revision + 1, delta); assert.throws(() => world.ingest(compile(requests, revision)), /revision mismatch/); assert.equal(packetHash(world.exportWorld()), old);
      // Same numeric field slot after an aborted edit, with genuinely different sample words.
      reference.rollbackFields(base, 0); reference.addCut({ ...input.cuts[0], radius: input.cuts[0].radius * .75 });
      const smaller = reference.tetRequests(reference.dirtyTets(base));
      world.begin(revision + 1, reference.preparedFields(base)); world.ingest(compile(smaller, revision + 1)); world.connect(); world.abort(); assert.equal(packetHash(world.exportWorld()), old); assert.deepEqual(world.worldStats, stats);
      reference.rollbackFields(base, 0); reference.addCut(input.cuts[0]);
      let graph = transaction('cut-0', requests);
      for (let i = 1; i < input.cuts.length; i++) { const id = reference.addCut(input.cuts[i]); graph = transaction(`cut-${i}`, reference.tetRequests(reference.dirtyTets(id))); }
      assert.equal(graph.detached.length, 1, 'Last support must detach the remote slab');
      const masks = graph.detached.flatMap(group => group.map(r => ({ tet: r.tet, constraints: r.constraints, body: 1 })));
      graph = transaction('ownership', all, masks); assert.equal(graph.detached.length, 0); assert.ok(![...pages.values()].some(p => p.regions.some(r => r.source === 'slab')));
      if (count === 1) {
        let warmMemory = 0;
        for (let i = 0; i < 32; i++) {
          world.begin(++revision); assert.throws(() => world.compactPages(), /during/);
          for (let at = 0; at < all.length; at += batch) world.ingest(compile(all.slice(at, at + batch), revision, masks));
          world.connect(); world.commit(); const before = packetHash(world.exportWorld()); world.compactPages(); assert.equal(packetHash(world.exportWorld()), before, 'Arena collection changed committed geometry');
          if (i === 15) warmMemory = world.memoryBytes;
        }
        assert.ok(world.memoryBytes <= warmMemory + 2 * 65536, 'Repeated equivalent page replacement must reach a bounded allocation plateau');
        verifyRustFeed(world, reference, lattice.brickOrder.flatMap(brick => pages.get(brick)?.regions ?? []), graph);
      }
      assert.throws(() => world.begin(revision), /Stale/);
      const digest = hash(timeline); if (expected) assert.equal(digest, expected, 'Canonical edits differ across worker/batch histories'); expected ??= digest;
      const row = { name, count, batch, digest, stages: timeline.length, memoryBytes: world.memoryBytes }; rows.push(row); console.log(JSON.stringify(row));
    } finally { world.dispose(); for (const worker of workers) worker.dispose(); }
  }
}
writeFileSync(process.argv[3], JSON.stringify({ scope: 'Semantic deterministic geometry and resident transaction qualification, not a performance benchmark.', rows }, null, 2));
