/** CPU/WASM startup evidence. No browser, GPU timing, or mobile-hardware claim. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet, type ResidentGameProfile } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from '../tests/helpers/geometry-gate';

const seeds = (process.env.TMT_SEEDS ?? '4,5,6,7').split(',').map(Number);
const profile = (process.env.TMT_PROFILE ?? 'resident-f32-game-v3') as ResidentGameProfile;
const repeats = Number(process.env.TMT_REPEATS ?? 3), results: unknown[] = [];
for (let repeat = 0; repeat < repeats; repeat++) for (const seed of seeds) {
  (globalThis as { gc?: () => void }).gc?.();
  const before = process.memoryUsage(), started = performance.now();
  const input = residentPlanet(seed, undefined, profile), generated = performance.now();
  const physics = await StructuralPhysics.create(input.planetCenter), physicsReady = performance.now();
  const terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost()), prepared = performance.now();
  let peakHeap = process.memoryUsage().heapUsed, peakRss = process.memoryUsage().rss;
  const memory = setInterval(() => { const m = process.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakRss = Math.max(peakRss, m.rss); }, 5);
  let error: string | undefined;
  try { await terrain.initialize(); } catch (e) { error = String(e); }
  clearInterval(memory);
  const ready = performance.now(), after = process.memoryUsage(); peakHeap = Math.max(peakHeap, after.heapUsed); peakRss = Math.max(peakRss, after.rss);
  // Outside the measured initialization: hash every region/source/f32 face word in stable page order.
  const digest = createHash('sha256');
  for (const page of terrain.pages.values()) for (const region of page.regions) {
    digest.update(JSON.stringify([region.id, region.material, region.source, region.anchor, region.constraints, region.volume]));
    for (const face of region.faces) digest.update(JSON.stringify([face.source, face.vertices.map(id => terrain.arrangement.vertices[id].position)]));
  }
  const result = { seed, profile, repeat, error, inputMs: generated - started, physicsLoadMs: physicsReady - generated, arrangementMs: prepared - physicsReady,
    totalMs: ready - started, initializationMs: ready - prepared, metrics: terrain.history[0]?.metrics, digest: digest.digest('hex'),
    regions: [...terrain.pages.values()].reduce((n, p) => n + p.regions.length, 0), recipes: terrain.arrangement.vertices.length,
    memory: { before, after, peakHeap, peakRss, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, sampling: '5ms event-loop samples; process high-water RSS includes earlier runs' } };
  results.push(result); console.log(JSON.stringify(result)); terrain.dispose();
}
const evidence = { timestamp: new Date().toISOString(), label: process.env.TMT_RUN ?? 'latest', scope: 'Serial CPU/WASM only. GeometryGate substitutes GPU work. No workers, browser, real GPU, or mobile hardware.',
  machine: { node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemory: totalmem() }, results };
mkdirSync('artifacts/startup', { recursive: true });
writeFileSync(`artifacts/startup/${process.env.TMT_RUN ?? 'latest'}.json`, JSON.stringify(evidence, null, 2) + '\n');
