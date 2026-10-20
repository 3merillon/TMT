/** Actual worker execution, one configuration at a time. Node is CPU evidence, not a browser/phone claim. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { encodeRustCore, RustTerrainCore, unpackRustPages } from '../src/gpu/terrain/rust-core';
import { RustTerrainPool, type RustWorkerSurface } from '../src/gpu/terrain/rust-core-pool';
import { auditBoundary, terrainConnectivity } from '../src/game/terrain-connectivity';
import type { CompiledRegionPage } from '../src/gpu/terrain/contracts';
import type { PlanetType } from '../src/game/planet-field';

assert.ok(process.argv[2] && process.argv[3], 'Pass release WASM and a fresh G: output directory');
const out = resolve(process.argv[3]); assert.ok(!existsSync(out), 'Refuse to overwrite benchmark evidence'); mkdirSync(out, { recursive: true });
const seed = Number(process.argv[4] ?? 7), kind = (process.argv[5] ?? 'temperate') as PlanetType, counts = (process.argv[6] ?? '1,2,4,8').split(',').map(Number), batchSize = Number(process.argv[7] ?? 8);
const entry = join(out, 'worker.mjs');
await build({ entryPoints: ['src/gpu/terrain/rust-core-worker.ts'], bundle: true, platform: 'node', format: 'esm', outfile: entry, banner: { js: `import { parentPort } from 'node:worker_threads';
globalThis.self=globalThis;
globalThis.postMessage=(message,transfer)=>parentPort.postMessage(message,transfer);
parentPort.on('message',data=>globalThis.onmessage({data}));` } });
const wasm = readFileSync(process.argv[2]), startModule = performance.now(), module = await WebAssembly.compile(wasm), moduleMs = performance.now() - startModule;
const input = residentPlanet(seed, undefined, 'resident-f32-game-v3', kind), lattice = residentLattice(input.bounds), reference = new ResidentArrangement(lattice, input.sources, 2048, true, true), fields = reference.preparedFields(0);
const initial = encodeRustCore({ lattice, fields, sources: reference.boxes, sourceFields: reference.boxFields, canonicalConstruction: true }), requests = lattice.brickOrder.map(brick => ({ brick, tets: null }));
const bytes = Buffer.alloc(8), bits = (n: number) => { bytes.writeDoubleLE(n); return bytes.toString('hex'); }, hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rows: unknown[] = []; let expected: string | undefined;
const resident = process.argv.includes('--resident');
for (const count of counts) {
  globalThis.gc?.();
  const worldStarted = performance.now(), world = resident ? await RustTerrainCore.createWorld(module, initial, fields.length) : undefined, worldInitMs = performance.now() - worldStarted;
  world?.begin(1);
  const terminations: Promise<number>[] = [], created = performance.now();
  const pool = new RustTerrainPool(count, module, initial, lattice, fields, () => {
    const worker = new NodeWorker(entry), surface: RustWorkerSurface = {
      onmessage: null, onerror: null, onmessageerror: null,
      postMessage: (message, transfer) => worker.postMessage(message, transfer as import('node:worker_threads').Transferable[]), terminate: () => { terminations.push(worker.terminate()); },
    };
    worker.on('message', data => surface.onmessage?.({ data } as MessageEvent)); worker.on('error', error => surface.onerror?.({ message: error.message } as ErrorEvent)); worker.on('messageerror', () => surface.onmessageerror?.({} as MessageEvent)); return surface;
  });
  const packets = []; let initMs = 0, compileMs = 0, peakWorkerBytes = 0, workerCpuMs = 0, packetBytes = 0, mergeMs = 0, connectMs = 0, gpuRecipeMs = 0, gpuRecipeBytes = 0, worldMemoryBytes = 0;
  try {
    await pool.initialized(); initMs = performance.now() - created; const start = performance.now();
    for await (const result of pool.compile(requests, 1, [], fields, undefined, batchSize)) {
      if (world) { const merge = performance.now(); world.ingest(result.packet); mergeMs += performance.now() - merge; } else packets.push(result.packet);
      workerCpuMs += result.milliseconds; peakWorkerBytes = Math.max(peakWorkerBytes, result.memoryBytes); packetBytes += result.packet.words.byteLength + result.packet.values.byteLength;
    }
    compileMs = performance.now() - start;
    if (world) {
      let start = performance.now(); world.connect(); world.commit(); connectMs = performance.now() - start;
      start = performance.now(); gpuRecipeBytes = world.gpuRecipes().byteLength; gpuRecipeMs = performance.now() - start; worldMemoryBytes = world.memoryBytes;
    }
  } finally { pool.dispose(); await Promise.all(terminations); }
  // Diagnostic export and JS reference validation happen only after all timed work and memory sampling.
  if (world) { packets.push(world.exportWorld()); world.dispose(); }
  // Qualification is outside the timed block. Production should consume this numeric ABI in the Rust coordinator.
  const arrangement = new ResidentArrangement(lattice, input.sources, 2048, true, true), pages = new Map<string, CompiledRegionPage>();
  for (const packet of packets) for (const page of arrangement.acceptCompiled(unpackRustPages(packet, lattice, reference.boxes, reference.fields))) pages.set(page.brick, page);
  const face = (f: { source: string; vertices: readonly number[] }) => {
    const cycle = f.vertices.map(id => arrangement.vertices[id].position.map(bits).join('/')); let start = 0; for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[start]) start = i;
    return JSON.stringify([f.source, [...cycle.slice(start), ...cycle.slice(0, start)]]);
  };
  const semantic = requests.map(({ brick }) => { const p = pages.get(brick)!; return [brick, hash([bits(p.removedVolume), Array.from(p.tetRemoved ?? [], bits), p.regions.map(r => [r.id, r.material, r.source, r.anchor, r.constraints, bits(r.volume), r.faces.map(face).sort(), r.sourceFaces?.map(face).sort()])])]; });
  const digest = hash(semantic), regions = requests.flatMap(r => [...pages.get(r.brick)!.regions]), boundary = auditBoundary(terrainConnectivity(regions, arrangement).boundary);
  assert.equal(boundary.unpaired, 0); assert.equal(boundary.orientationErrors, 0); if (expected) assert.equal(digest, expected); expected ??= digest;
  const row = { count, batchSize, seed, kind, moduleMs, wasmBytes: wasm.byteLength, initMs, compileMs, workerCpuMs, peakWorkerBytes, packetBytes, ...(resident ? { worldInitMs, mergeMs, connectMs, gpuRecipeMs, gpuRecipeBytes, worldMemoryBytes, cpuPipelineMs: worldInitMs + initMs + compileMs + connectMs + gpuRecipeMs } : {}), regions: regions.length, digest, boundary }; rows.push(row); console.log(JSON.stringify(row));
  writeFileSync(join(out, 'results.json'), JSON.stringify({ scope: resident ? 'Real Node workers feeding the resident Rust coordinator. compileMs includes overlapping worker work, transfer, scheduling and numeric ingestion; mergeMs is contained within it. cpuPipelineMs includes coordinator/pool initialization, compile/merge, connectivity and recipe encoding. Source/lattice preparation, WebGPU submission, query BVH and physics are excluded; qualification export happens afterward. No browser or phone performance claim.' : 'Real Node worker threads; cold pool startup and bounded canonical compilation; numeric output only. TS bridge/merge/connectivity validation excluded from timing. No browser or phone performance claim.', rows }, null, 2));
}
