import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ResidentArrangement, sphereField, type OwnershipMask } from '../src/gpu/terrain/arrangement';
import { structuralFixture, type FixtureName } from '../src/gpu/terrain/fixtures';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import { terrainConnectivity, auditBoundary } from '../src/game/terrain-connectivity';
import { structuralCandidate } from '../src/game/structural-colliders';
import type { OccupiedRegion, RegionPage, SphereCut } from '../src/gpu/terrain/contracts';
import { add, rotate, sub } from '../src/game/math';
import type { Q4, V3 } from '../src/game/contracts';
import { residentQueryChunk, queryCollision } from '../src/game/resident-queries';

const module = WebAssembly.compile(readFileSync(new URL('../src/gpu/terrain/terrain-core.wasm', import.meta.url)));
async function fixture(name: FixtureName, count = 1) {
  const input = structuralFixture(name), lattice = residentLattice(input.bounds);
  const oracle = new ResidentArrangement(lattice, input.sources, 2048, true, true), base = oracle.fields.length;
  const initial = encodeRustCore({ lattice, fields: oracle.preparedFields(0), sources: oracle.boxes, sourceFields: oracle.boxFields, canonicalConstruction: true });
  const compiled = await module, world = await RustTerrainCore.createWorld(compiled, initial, base);
  const workers = await Promise.all(Array.from({ length: count }, () => RustTerrainCore.create(compiled, lattice, initial)));
  const pages = new Map<string, RegionPage>(), all = lattice.brickOrder.map(brick => ({ brick, tets: null }));
  let revision = 0, fields = base;
  const compile = (masks: readonly OwnershipMask[] | Uint32Array = []) => {
    const packets = [];
    for (let i = 0; i < all.length; i++) packets.push(workers[i % count].compile([all[i]], revision, masks, base, oracle.preparedFields(base), undefined, true));
    return packets;
  };
  const transaction = () => {
    world.begin(++revision, oracle.preparedFields(fields));
    for (const packet of compile()) {
      world.ingest(packet);
      for (const page of oracle.acceptCompiled(unpackRustPages(packet, lattice, oracle.boxes, oracle.fields))) pages.set(page.brick, oracle.assemble(page, pages.get(page.brick)));
    }
    world.connect(); world.commit(); fields = oracle.fields.length;
  };
  transaction(); for (const cut of input.cuts) { oracle.addCut(cut); transaction(); }
  return { world, oracle, lattice, all, pages, base, get revision() { return revision; }, set revision(v: number) { revision = v; }, fields, compile,
    body: (id: number, preview = false) => oracle.acceptCompiled(unpackRustPages(world.exportBody(id, preview), lattice, oracle.boxes, oracle.fields)).flatMap(p => p.regions),
    dispose: () => { world.dispose(); workers.forEach(w => w.dispose()); } };
}
function bodies(world: RustTerrainCore, preview = false) {
  const words = world.bodyWords(preview).slice(); expect(words[0]).toBe(1);
  return { removed: words[2], rows: Array.from({ length: words[1] }, (_, i) => ({ id: words[4 + 6 * i], count: words[5 + 6 * i], volume: words[6 + 6 * i], center: Array.from(words.subarray(7 + 6 * i, 10 + 6 * i)) as V3 })) };
}
const volume = (regions: readonly OccupiedRegion[]) => regions.reduce((s, r) => s + r.volume, 0);

function verifyBodyFeed(world: RustTerrainCore, oracle: ResidentArrangement, id: number, regions: OccupiedRegion[], preview = false) {
  const candidate = structuralCandidate(id, regions, oracle), graph = terrainConnectivity(regions, oracle);
  const chunk = residentQueryChunk('body', graph.boundary, oracle, candidate.center), query = world.bodyQueryBvh(id, preview);
  for (const key of ['positions', 'indices', 'materials'] as const) expect(query[key]).toEqual(chunk[key]);
  const bvh = queryCollision([chunk]).chunks.get('body')!;
  for (const key of ['box', 'skip', 'leaf', 'faces'] as const) expect(query[key]).toEqual(bvh[key]);
  const colliders = world.bodyColliders(id, preview);
  expect(colliders.descriptors.length / 8).toBe(candidate.colliders.length);
  candidate.colliders.forEach((c, i) => {
    const d = colliders.descriptors.subarray(i * 8, i * 8 + 8), mass = colliders.mass.subarray(i * 4, i * 4 + 4);
    expect(colliders.positions.subarray(d[0] * 3, (d[0] + d[1]) * 3)).toEqual(c.vertices);
    expect(colliders.indices.subarray(d[2], d[2] + d[3])).toEqual(c.indices);
    expect(mass[0]).toBe(c.volume); expect(Array.from(mass.subarray(1))).toEqual(c.offset ?? [0, 0, 0]);
    expect(Array.from(colliders.regions.subarray(d[4], d[4] + d[5]), j => regions[j].id)).toEqual(c.regionIds);
  });
  const volumes = world.bodyVolumes(id, preview); expect(volumes.volumes).toEqual(Float64Array.from(regions, r => r.volume));
  const surface = world.bodySurface(id, preview);
  expect(surface.triangles.length / 8).toBe(chunk.indices.length / 3);
  expect(surface.references.length / 8).toBe(graph.boundary.reduce((n, b) => n + b.face.vertices.length, 0));
}

it('owns support-cut detachment, keeps publication atomic, and retains body roots through collection and masked rebuilds', async () => {
  for (const name of ['one-support', 'two-supports', 'three-bricks', 'arch'] as FixtureName[]) {
    const f = await fixture(name), { world, oracle } = f;
    try {
      const regions = [...f.pages.values()].flatMap(p => p.regions), graph = terrainConnectivity(regions, oracle);
      expect(graph.detached).toHaveLength(1);
      const expected = structuralCandidate(1, graph.detached[0], oracle), before = world.exportWorld(), stats = world.worldStats;
      world.begin(f.revision + 1); world.connect(); world.detach();
      expect(bodies(world).rows).toHaveLength(0); expect(world.exportWorld()).toEqual(before);
      expect(bodies(world, true).rows[0]).toEqual({ id: 1, count: expected.regions.length, volume: volume(expected.regions), center: expected.center });
      world.abort(); expect(world.worldStats).toEqual(stats); expect(world.ownershipMasks().slice()).toEqual(new Uint32Array([0]));
      world.begin(++f.revision); world.connect(); world.detach(); world.commit();
      const owned = f.body(1); expect(owned.map(r => r.id).sort()).toEqual(expected.regions.map(r => r.id).sort());
      verifyBodyFeed(world, oracle, 1, owned);
      expect(world.worldStats.detachedGroups).toBe(0);
      const body = world.exportBody(1); world.compactPages(); expect(world.exportBody(1)).toEqual(body);
      // A worker that omitted the retained ownership masks must not resurrect a body.
      world.begin(++f.revision);
      expect(() => { for (const p of f.compile()) world.ingest(p); }).toThrow(/ownership/);
      expect(world.exportBody(1)).toEqual(body); expect(() => world.commit()).toThrow(/not prepared/);
      const masks = world.ownershipMasks().slice(); expect(masks[0]).toBe(expected.regions.length);
      world.begin(f.revision); for (const p of f.compile(masks)) world.ingest(p); world.connect(); world.commit();
      expect(world.worldStats.detachedGroups).toBe(0); expect(world.exportBody(1)).toEqual(body);
      expect(world.worldStats.regions).toBe(graph.anchored.length);
    } finally { f.dispose(); }
  }
}, 30000);

it('recuts retained source geometry after a rotated/translated pose, with independent removal and changed-word retry', async () => {
  const digests: unknown[] = [];
  for (const count of [1, 4, 8]) {
    const f = await fixture('three-bricks', count), { world, oracle } = f;
    try {
      world.begin(++f.revision); world.connect(); world.detach(); world.commit();
      const parent = f.body(1), original = world.exportBody(1), state = world.worldStats;
      const center = bodies(world).rows[0].center, position: V3 = [4, 12, -8], rotation: Q4 = [0, 0, Math.sin(.37), Math.cos(.37)];
      const target: V3 = [0, 6.5, 0], worldCut = add(position, rotate(sub(target, center), rotation));
      const sourceCut = add(center, rotate(sub(worldCut, position), [-rotation[0], -rotation[1], -rotation[2], rotation[3]]));
      const cut: SphereCut = { id: 'same-body-cut', center: sourceCut, radius: 2.75 };
      const run = (radius: number) => {
        const expected = oracle.clipRegions(parent, { ...cut, radius });
        world.begin(f.revision + 1, oracle.preparedFields(f.fields)); world.connect(); world.recutBody(1, f.fields);
        // TS recutting and canonical Rust construction intentionally use different
        // arithmetic. Use a fresh import for exact descriptor checks, so the TS oracle's
        // new intersection keys cannot hide the Rust coordinates under the same key.
        const feedOracle = new ResidentArrangement(f.lattice, oracle.boxes, 2048, true, true);
        for (const field of oracle.preparedFields(f.base)) feedOracle.appendPreparedField(field);
        const result = bodies(world, true), actual = result.rows.flatMap(b => {
          const regions = feedOracle.acceptCompiled(unpackRustPages(world.exportBody(b.id, true), f.lattice, oracle.boxes, oracle.fields)).flatMap(p => p.regions);
          verifyBodyFeed(world, feedOracle, b.id, regions, true); return regions;
        });
        expect(result.removed).toBeGreaterThan(0); expect(result.removed).toBeCloseTo(expected.removed, 4);
        expect(volume(actual)).toBeCloseTo(volume(expected.regions), 4);
        expect(volume(parent) - volume(actual) - result.removed).toBeCloseTo(0, 4);
        // Only new body cells need GPU acceptance in a body-only edit; unchanged
        // static terrain must not be revalidated or silently omit child volume checks.
        expect(world.transactionVolumes().volumes).toEqual(Float64Array.from(actual, r => r.volume));
        const expectedByKey = new Map(expected.regions.map(r => [`${r.tet}/${r.constraints}`, r]));
        expect(actual.length).toBe(expected.regions.length);
        for (const region of actual) {
          const other = expectedByKey.get(`${region.tet}/${region.constraints}`)!; expect(other).toBeDefined();
          expect(region.volume).toBeCloseTo(other.volume, 5);
          const points = (r: OccupiedRegion, a: ResidentArrangement) => [...new Set(r.sourceFaces!.flatMap(f => [...f.vertices]))].map(id => a.vertices[id].position).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
          const a = points(region, feedOracle), b = points(other, oracle); expect(a.length).toBe(b.length);
          // Compare point sets rather than relying on ordering of nearly equal f32 words.
          for (const p of a) expect(b.some(q => p.every((v, i) => Math.abs(v - q[i]) < 2e-6))).toBe(true);
        }
        const graph = terrainConnectivity(actual, feedOracle), seam = auditBoundary(graph.boundary);
        expect(seam.unpaired).toBe(0); expect(seam.orientationErrors).toBe(0); expect(result.rows).toHaveLength(graph.detached.length);
        expect(world.exportBody(1)).toEqual(original); // staged replacement is not published
        return result;
      };
      run(1.8); world.abort(); expect(world.worldStats).toEqual(state); expect(world.exportBody(1)).toEqual(original);
      oracle.rollbackFields(f.fields, oracle.cuts.length);
      const result = run(cut.radius);
      digests.push(result); if (digests.length > 1) expect(result).toEqual(digests[0]);
      world.commit(); expect(() => world.exportBody(1)).toThrow(/Unknown/);
      const retained = result.rows.map(b => world.exportBody(b.id)); world.compactPages();
      expect(result.rows.map(b => world.exportBody(b.id))).toEqual(retained);
      const masks = world.ownershipMasks().slice(); world.begin(f.revision += 2, []);
      // Body-only fields never become static cutters; the original masks still own the source cells.
      for (const p of f.compile(masks)) world.ingest(p); world.connect(); world.commit();
      expect(world.worldStats.detachedGroups).toBe(0); expect(world.ownershipMasks().slice()).toEqual(masks);
      if (count === 1) {
        const before = bodies(world), checkpoint = world.bodyWords().slice(), field = oracle.addField(sphereField('remove-all', [0, 6.5, 0], 100), true);
        const stageRemoval = () => {
          world.begin(f.revision + 1, oracle.preparedFields(field)); world.connect();
          for (const b of before.rows) world.recutBody(b.id, field);
          expect(bodies(world, true).rows).toHaveLength(0);
          expect(bodies(world, true).removed).toBeCloseTo(before.rows.reduce((s, b) => s + b.volume, 0), 8);
          expect(world.transactionVolumes().volumes).toHaveLength(0);
        };
        stageRemoval(); world.abort(); expect(world.bodyWords().slice()).toEqual(checkpoint);
        stageRemoval(); world.commit(); world.compactPages();
        expect(bodies(world).rows).toHaveLength(0); expect(world.ownershipMasks().slice()).toEqual(masks);
      }
    } finally { f.dispose(); }
  }
}, 30000);
