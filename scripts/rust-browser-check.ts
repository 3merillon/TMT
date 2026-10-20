/** Real WebGPU acceptance of resident Rust buffers; no JS geometry reconstruction. */
import { ResidentArrangement, sphereField } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { encodeRustCore, RustTerrainCore } from '../src/gpu/terrain/rust-core';
import { RustTerrainPool } from '../src/gpu/terrain/rust-core-pool';
import { ResidentGpuPages, brickBounds } from '../src/gpu/terrain/gpu-pages';
import type { GpuPage } from '../src/gpu/terrain/page-batch';
import type { TerrainRenderHost } from '../src/gpu/terrain/render-host';
import type { SliceMetrics } from '../src/gpu/terrain/contracts';
import { queryCollision } from '../src/game/resident-queries';
import type { TerrainChunk } from '../src/game/contracts';

export async function run(mode: 'fixture' | 'planet' | 'bodies', seed = 7, count = 8) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] }), errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message)); device.pushErrorScope('validation');
  const input = mode !== 'planet' ? structuralFixture('three-bricks') : residentPlanet(seed, undefined, 'resident-f32-game-v3', 'temperate'), lattice = residentLattice(input.bounds), samples = new ResidentArrangement(lattice, input.sources, 2048, true, true), fields = samples.preparedFields(0);
  const module = await WebAssembly.compile(await (await fetch('/core.wasm')).arrayBuffer()), initial = encodeRustCore({ lattice, fields, sources: samples.boxes, sourceFields: samples.boxFields, canonicalConstruction: true }), world = await RustTerrainCore.createWorld(module, initial, fields.length);
  const created = performance.now(), pool = new RustTerrainPool(count, module, initial, lattice, fields, () => new Worker('/worker.js', { type: 'module' })); await pool.initialized(); const poolInitMs = performance.now() - created;
  let id = 0, drawn: Map<string, GpuPage> = new Map();
  const host: TerrainRenderHost = { device, pageHooks: [], commit: () => {}, createPage: buffers => ({ id: ++id, setPose: () => {}, dispose: () => { for (const buffer of [buffers.position, buffers.normal, buffers.surface, buffers.index, buffers.indirect]) buffer.destroy(); } }) };
  const pipelineStart = performance.now(), gpu = await ResidentGpuPages.create(device, 1048576), pipelineMs = performance.now() - pipelineStart, rows: unknown[] = [];
  try {
    const all = lattice.brickOrder.map(brick => ({ brick, tets: null }));
    for (let stage = 0; stage < 1 + (mode !== 'planet' ? input.cuts.length : 0) + (mode === 'bodies' ? 1 : 0); stage++) {
      const metrics = { dirtyBricks: 0, cleanBricks: 0, regions: 0, activePlanes: 0, contractedNodes: 0, graphBytes: 0, graphMs: 0, topologyMs: 0, colliderMs: 0, colliderDescriptorBytes: 0, solverMs: 0, fallbackCount: 0, uploadBytes: 0, descriptorReadbackBytes: 0, submissions: 0, gpuMs: null, peakGpuBytes: 0, enqueueToCommitMs: 0, firstFallMs: null } satisfies SliceMetrics;
      const bodyStage = mode === 'bodies' && stage === input.cuts.length + 1;
      const previousFields = fields.length, field = bodyStage ? samples.addField(sphereField('body-recut', [0, 6.5, 0], 2.75), true) : stage ? samples.addCut(input.cuts[stage - 1]) : -1;
      if (stage) fields.push(...samples.preparedFields(previousFields));
      const requests = bodyStage ? [] : stage ? samples.tetRequests(samples.dirtyTets(field)) : all;
      const oldBodies = world.bodyWords().slice(), masks = world.ownershipMasks().slice();
      const started = performance.now(); world.begin(stage + 1, fields.slice(previousFields)); let mergeMs = 0, peakWorkerBytes = 0;
      for await (const result of pool.compile(requests, stage + 1, masks, fields)) { const at = performance.now(); world.ingest(result.packet); mergeMs += performance.now() - at; peakWorkerBytes = Math.max(peakWorkerBytes, result.memoryBytes); }
      const compiled = performance.now(); world.connect(); if (mode === 'bodies') world.detach();
      if (bodyStage) for (let i = 0; i < oldBodies[1]; i++) world.recutBody(oldBodies[4 + i * 6], field);
      const bodyWords = world.bodyWords(true).slice(), connected = performance.now(), batch = gpu.packedBatch(host, metrics);
      batch.constructPacked({ vertexCount: world.worldStats.vertices, recipes: from => world.gpuRecipes(from), volumes: () => mode === 'bodies' ? world.transactionVolumes() : world.gpuVolumes(true) });
      for (let brick = 0; brick < lattice.brickOrder.length; brick++) { const key = lattice.brickOrder[brick]; batch.pagePacked(key, world.gpuSurface({ brick, preview: true }), { brick: key, origin: [0, 0, 0] }, brickBounds(lattice, key)); }
      for (let i = 0; i < bodyWords[1]; i++) {
        const id = bodyWords[4 + i * 6], origin = Array.from(bodyWords.subarray(7 + i * 6, 10 + i * 6)) as [number, number, number], query = world.bodyQueryBvh(id, true);
        const bounds = { min: Array.from(query.box.subarray(0, 3)) as [number, number, number], max: Array.from(query.box.subarray(3, 6)) as [number, number, number] };
        batch.pagePacked(`body:${id}`, world.bodySurface(id, true), { bodyId: id, origin }, bounds);
      }
      const encoded = performance.now(), submitted = batch.submit(), chunks: TerrainChunk[] = [];
      for (let brick = 0; brick < lattice.brickOrder.length; brick++) { const data = world.queryChunk({ brick, preview: true }); chunks.push({ id: lattice.brickOrder[brick], positions: data.positions.slice(), indices: data.indices.slice(), materials: data.materials.slice(), normals: new Float32Array(), colors: new Float32Array() }); }
      const collision = queryCollision(chunks, stage + 1), queried = performance.now(), pages = await submitted; world.commit(); const finished = performance.now();
      for (const page of drawn.values()) page.dispose(); drawn = pages;
      rows.push({ stage, bodies: bodyWords[1], bodyRemoved: bodyWords[2], compileAndMergeMs: compiled - started, mergeMs, connectMs: connected - compiled, encodeMs: encoded - connected, queryMs: queried - encoded, readyMs: finished - started, pages: pages.size, queryChunks: collision.chunks.size, worldMemoryBytes: world.memoryBytes, peakWorkerBytes, stats: world.worldStats, metrics });
    }
    await device.queue.onSubmittedWorkDone(); const error = await device.popErrorScope(); if (error) errors.push(error.message); if (errors.length) throw new Error(errors.join('\n'));
    return { mode, seed, count, poolInitMs, pipelineMs, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, rows };
  } finally { pool.dispose(); for (const page of drawn.values()) page.dispose(); gpu.dispose(); world.dispose(); device.destroy(); }
}
