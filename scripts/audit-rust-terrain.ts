/** Semantic determinism of the canonical Rust construction across different partition counts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { initialPartitions } from '../src/gpu/terrain/page-workers';
import { unpackPages } from '../src/gpu/terrain/page-packet';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import { terrainConnectivity, auditBoundary } from '../src/game/terrain-connectivity';
import type { PlanetType } from '../src/game/planet-field';
import type { CompiledRegionPage } from '../src/gpu/terrain/contracts';

assert.ok(process.argv[2] && process.argv[3], 'Pass release WASM and external report path');
const module = await WebAssembly.compile(readFileSync(process.argv[2])), seed = Number(process.argv[4] ?? 7), kind = (process.argv[5] ?? 'temperate') as PlanetType;
const counts = (process.argv[6] ?? '8,4,1').split(',').map(Number);
const batch = Number(process.argv[7] ?? 0), configurations = [...(batch ? [{ count: 8, batch: 0 }] : []), ...counts.map(count => ({ count, batch }))];
const input = process.argv[5] === 'fixture' ? structuralFixture('three-bricks') : residentPlanet(seed, undefined, 'resident-f32-game-v3', kind), lattice = residentLattice(input.bounds), owner = new ResidentArrangement(lattice, input.sources, 2048, true, true);
const initial = encodeRustCore({ lattice, fields: owner.preparedFields(0), sources: owner.boxes, sourceFields: owner.boxFields, canonicalConstruction: true });
const requests = lattice.brickOrder.map(brick => ({ brick, tets: null })), bytes = Buffer.alloc(8);
const bits = (n: number) => { bytes.writeDoubleLE(n); return bytes.toString('hex'); };
const hash = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const results: unknown[] = []; let reference: Map<string, string> | undefined;
for (const { count, batch } of configurations) {
  const arrangement = new ResidentArrangement(lattice, input.sources, 2048, true, true), pages = new Map<string, CompiledRegionPage>();
  let peakWorkerBytes = 0;
  for (const partition of initialPartitions(requests, count)) {
    const core = await RustTerrainCore.create(module, lattice, initial);
    try {
      for (let at = 0; at < partition.length; at += batch || partition.length) {
        const selected = partition.slice(at, at + (batch || partition.length));
        const numeric = core.compile(selected, 1, [], owner.fields.length, [], undefined, true), packet = unpackRustPages(numeric, lattice, owner.boxes, owner.fields);
        peakWorkerBytes = Math.max(peakWorkerBytes, core.memoryBytes);
        for (const page of arrangement.acceptCompiled(packet)) pages.set(page.brick, page);
        if (batch) core.resetConstruction();
      }
    }
    finally { core.dispose(); }
  }
  const semantic = new Map<string, string>();
  const face = (f: { source: string; vertices: readonly number[] }) => {
    const cycle = f.vertices.map(id => arrangement.vertices[id].position.map(bits).join('/'));
    let start = 0; for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[start]) start = i;
    return JSON.stringify([f.source, [...cycle.slice(start), ...cycle.slice(0, start)]]);
  };
  for (const request of requests) {
    const page = pages.get(request.brick)!;
    semantic.set(page.brick, hash([bits(page.removedVolume), Array.from(page.tetRemoved ?? [], bits), page.regions.map(r => [r.id, r.material, r.source, r.anchor, r.constraints, bits(r.volume), r.faces.map(face).sort(), r.sourceFaces?.map(face).sort()])]));
  }
  const differences = reference ? [...semantic].filter(([key, value]) => reference!.get(key) !== value).map(([key]) => key) : [];
  const regions = requests.flatMap(r => [...pages.get(r.brick)!.regions]), graph = terrainConnectivity(regions, arrangement), boundary = auditBoundary(graph.boundary);
  const result = { seed, kind, workers: count, batch, peakWorkerBytes, regions: regions.length, recipes: arrangement.vertices.length, digest: hash([...semantic]), differences, boundary };
  results.push(result); console.log(JSON.stringify(result)); writeFileSync(process.argv[3], JSON.stringify({ scope: 'Canonical Rust CPU semantic output and closed boundary; sequential partition simulation, not multithread performance.', results }, null, 2));
  assert.deepEqual(boundary, { ...boundary, unpaired: 0, orientationErrors: 0 }); assert.equal(differences.length, 0, 'Worker partition changed canonical output'); reference ??= semantic;
}
