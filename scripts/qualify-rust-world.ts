/** Qualify resident packet ingestion, fine connectivity and direct GPU recipe bytes against the TS bridge. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import { terrainConnectivity, auditBoundary } from '../src/game/terrain-connectivity';
import type { RegionPage } from '../src/gpu/terrain/contracts';
import type { PlanetType } from '../src/game/planet-field';
import { verifyRustFeed } from './rust-feed-oracle';

assert.ok(process.argv[2] && process.argv[3], 'Pass release WASM and external report path');
const module = await WebAssembly.compile(readFileSync(process.argv[2])), mode = process.argv[4] ?? 'fixture', seed = Number(process.argv[5] ?? 7), kind = (process.argv[6] ?? 'temperate') as PlanetType;
const input = mode === 'fixture' ? structuralFixture('three-bricks') : residentPlanet(seed, undefined, 'resident-f32-game-v3', kind), lattice = residentLattice(input.bounds), reference = new ResidentArrangement(lattice, input.sources, 2048, true, true);
const initial = encodeRustCore({ lattice, fields: reference.preparedFields(0), sources: reference.boxes, sourceFields: reference.boxFields, canonicalConstruction: true });
const worker = await RustTerrainCore.create(module, lattice, initial), world = await RustTerrainCore.createWorld(module, initial, reference.fields.length), pages = new Map<string, RegionPage>();
let rustMergeMs = 0, tsMergeMs = 0;
try {
  world.begin(1);
  const requests = lattice.brickOrder.map(brick => ({ brick, tets: null }));
  for (let at = 0; at < requests.length; at += 8) {
    const packet = worker.compile(requests.slice(at, at + 8), 1, [], reference.fields.length, [], undefined, true); worker.resetConstruction();
    let start = performance.now(); world.ingest(packet); rustMergeMs += performance.now() - start;
    start = performance.now(); for (const page of reference.acceptCompiled(unpackRustPages(packet, lattice, reference.boxes, reference.fields))) pages.set(page.brick, page); tsMergeMs += performance.now() - start;
  }
  const ingestMemoryBytes = world.memoryBytes;
  let start = performance.now(); world.connect(); world.commit(); const rustGraphMs = performance.now() - start, connectedMemoryBytes = world.memoryBytes;
  start = performance.now(); const regions = [...pages.values()].flatMap(p => [...p.regions]), graph = terrainConnectivity(regions, reference), boundary = auditBoundary(graph.boundary), tsGraphMs = performance.now() - start, stats = world.worldStats;
  assert.equal(stats.regions, regions.length); assert.equal(stats.vertices, reference.vertices.length); assert.equal(stats.portals, graph.portals.length); assert.equal(stats.boundaryFaces, graph.boundary.length); assert.equal(stats.anchoredRegions, graph.anchored.length); assert.equal(stats.detachedGroups, graph.detached.length);
  assert.equal(stats.edges, boundary.edges); assert.equal(stats.unpaired, 0); assert.equal(stats.orientationErrors, 0);
  // Compare every output region without importing it through another canonical merge.
  const output = unpackRustPages(world.exportWorld(), lattice, reference.boxes, reference.fields);
  for (const page of output.pages) {
    const original = pages.get(page.brick)!; assert.equal(page.removedVolume, original.removedVolume); assert.deepEqual(page.tetRemoved, original.tetRemoved);
    assert.deepEqual(page.regions, original.regions, `Resident regions differ for ${page.brick}`);
  }
  // Reproduce the existing GPU upload contract, including the untouched padding and f32 barycentrics.
  const expected = new ArrayBuffer(reference.vertices.length * 64), u = new Uint32Array(expected), f = new Float32Array(expected);
  for (let i = 0; i < reference.vertices.length; i++) {
    const v = reference.vertices[i], k = i * 16; u[k] = v.edge?.[0] ?? 0; u[k + 1] = v.edge?.[1] ?? 0; u[k + 2] = v.level; u[k + 3] = v.basis ? 2 : v.edge ? 1 : 0;
    if (v.basis) { for (let j = 0; j < 4; j++) u[k + 4 + j] = v.basis[j] ?? v.basis[0]; f.set(v.barycentric!, k + 12); }
    if (v.base) f.set(v.base, k + 8); else f.set(v.values!, k + 8);
  }
  start = performance.now(); const gpu = world.gpuRecipes(); const gpuEncodeMs = performance.now() - start;
  assert.deepEqual(gpu, u, 'Rust GPU recipe bytes differ');
  const result = { mode, seed, kind, initialBytes: initial.byteLength, rustMergeMs, tsMergeMs, rustGraphMs, tsGraphMs, gpuEncodeMs, gpuBytes: gpu.byteLength, ingestMemoryBytes, connectedMemoryBytes, worldMemoryBytes: world.memoryBytes, stats };
  verifyRustFeed(world, reference, regions, graph);
  console.log(JSON.stringify(result)); writeFileSync(process.argv[3], JSON.stringify({ scope: 'Sequential qualification against identical canonical worker packets. TS graph is the independent full fine-graph oracle, not the production incremental graph; timings are diagnostic.', ...result }, null, 2));
} finally { worker.dispose(); world.dispose(); }
