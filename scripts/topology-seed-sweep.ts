import { mkdirSync, writeFileSync } from 'node:fs';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { localTopology, ResidentConnectivity } from '../src/game/terrain-connectivity';
import { brickWorker } from '../src/gpu/terrain/page-workers';
import type { RegionPage } from '../src/gpu/terrain/contracts';
import { PLANET_TYPES, planetType, type PlanetType } from '../src/game/planet-field';

// CPU topology qualification, not a timing benchmark or GPU/device claim.
// Usage: node --import tsx scripts/topology-seed-sweep.ts <first-seed> <count> [workers=0] [brick|-] [kind|all]
const startSeed = Number(process.argv[2] ?? 0), count = Number(process.argv[3] ?? 100), workers = Number(process.argv[4] ?? 0), profile = 'resident-f32-game-v3';
const brickOnly = process.argv[5] && process.argv[5] !== '-' ? process.argv[5] : undefined;
const selected = process.argv[6], kinds: readonly (PlanetType | undefined)[] = selected === 'all' ? PLANET_TYPES : selected ? [selected as PlanetType] : [undefined];
if (kinds.some(kind => kind !== undefined && !PLANET_TYPES.includes(kind))) throw new Error('Unknown selected world kind');
for (let seed = startSeed; seed < startSeed + count; seed++) for (const kind of kinds) {
  const t = performance.now(), input = residentPlanet(seed, undefined, profile, kind), a = new ResidentArrangement(residentLattice(input.bounds), input.sources, 2048, true, input.uniformRegions);
  let n = 0;
  const compiled = new Map<string, RegionPage>();
  if (workers) for (let w = 0; w < workers; w++) {
    const worker = new ResidentArrangement(a.lattice, input.sources, 2048, true, input.uniformRegions);
    const packet = worker.compilePages(a.lattice.brickOrder.filter(b => brickWorker(b, workers) === w), 1, []);
    for (const page of a.acceptCompiled(packet)) compiled.set(page.brick, page);
  }
  for (const brick of brickOnly ? [brickOnly] : a.lattice.brickOrder) {
    const page = workers ? compiled.get(brick)! : a.rebuild(brick, 1);
    compiled.set(brick, page);
    try { localTopology(page, a, () => ++n); } catch (error) {
      const message = String(error), key = message.match(/portal ([\d,]+)/)?.[1], ids = key?.split(',').map(Number);
      const matches = ids ? page.regions.filter(r => r.faces.some(f => f.vertices.length === ids.length && ids.every(v => f.vertices.includes(v)))) : page.regions;
      const tets = [...new Set(matches.map(r => r.tet))].map(id => a.lattice.tetById.get(id)!);
      const samples = tets.map(tet => ({ tet: tet.id, vertices: tet.vertices.map(id => a.lattice.positions[id]), fields: a.fields.map((field, i) => ({ id: field.id, values: tet.vertices.map(id => a.samples[i][id]) })).filter(f => f.values.some(v => v <= 0)) }));
      const used = [...new Set(matches.flatMap(r => r.faces.flatMap(f => [...f.vertices])))];
      const result = { seed, kind: kind ?? planetType(seed), profile, workers, brick, error: message, elapsedMs: performance.now() - t, regions: matches, vertices: used.map(id => ({ id, position: a.vertices[id].position, key: a.vertices[id].key })), samples };
      mkdirSync('artifacts/topology-seed-sweep', { recursive: true }); writeFileSync(`artifacts/topology-seed-sweep/startup-topology-failure-${seed}-${kind ?? 'auto'}-${workers}.json`, JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify({ seed, brick, error: message, tets: tets.map(t => t.id), regions: matches.map(r => ({ id: r.id, volume: r.volume, source: r.source })), elapsedMs: performance.now() - t })); process.exit(1);
    }
  }
  const graph = brickOnly ? undefined : new ResidentConnectivity().rebuild(compiled, a).graph;
  console.log(JSON.stringify({ seed, kind: kind ?? planetType(seed), workers, elapsedMs: performance.now() - t, n, vertices: a.vertices.length, boundary: graph?.boundary.length, detached: graph?.detached.length }));
}
