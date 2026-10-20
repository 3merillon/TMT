/** CPU / WASM evidence only. Browser geometry evidence is emitted by dev/structural-check.html. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { terrainConnectivity, auditBoundary } from '../src/game/terrain-connectivity';
import { structuralCandidate } from '../src/game/structural-colliders';
import { StructuralPhysics } from '../src/game/structural-physics';
import type { OwnershipMask } from '../src/gpu/terrain/arrangement';

const evidence: { fixture: string; stages: unknown[]; physics: unknown }[] = [];
for (const name of ['one-support', 'two-supports', 'three-bricks', 'arch'] as const) {
  const fixture = structuralFixture(name), a = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources), stages: unknown[] = [];
  const pages = new Map(), masks: OwnershipMask[] = []; const physics = await StructuralPhysics.create(fixture.planetCenter);
  let oldVolume = 0, oldRemoved = 0;
  for (let stage = 0; stage <= fixture.cuts.length; stage++) {
    const started = performance.now(), dirty = stage ? a.dirtyBricks(a.addCut(fixture.cuts[stage - 1])) : new Set(a.lattice.bricks.keys());
    for (const brick of dirty) pages.set(brick, a.rebuild(brick, stage, masks));
    const topologyMs = performance.now() - started, regions = [...pages.values()].flatMap(p => p.regions), graph = terrainConnectivity(regions, a);
    const cooking = performance.now(), bodies = graph.detached.map((r, i) => structuralCandidate(i + 1, r, a)), fixed = structuralCandidate(0, graph.anchored, a);
    physics.stage([fixed], bodies).commit(); const colliderMs = performance.now() - cooking;
    const anchored = graph.anchored.reduce((s, r) => s + r.volume, 0), detached = graph.detached.flat().reduce((s, r) => s + r.volume, 0);
    const totalRemoved = [...pages.values()].reduce((s, p) => s + p.removedVolume, 0), removed = totalRemoved - oldRemoved;
    const volume = anchored + detached, ledger = { before: stage ? oldVolume : volume, anchored, detached, removed, error: stage ? oldVolume - volume - removed : 0 };
    stages.push({ stage, dirtyBricks: dirty.size, cleanBricks: pages.size - dirty.size, regions: regions.length, canonicalVertices: a.vertices.length, sourcePlanes: a.fields.length,
      localNodes: graph.nodes, portals: graph.portals.length, graphBytes: graph.graphBytes, topologyMs, graphMs: graph.milliseconds, colliderMs, colliders: fixed.colliders.length + bodies.reduce((s, b) => s + b.colliders.length, 0), fallbackCount: a.fallbackCount, ledger, seams: auditBoundary(graph.boundary) });
    oldVolume = volume; oldRemoved = totalRemoved;
  }
  const first = physics.snapshot(), start = performance.now(); physics.step(); const firstStep = physics.snapshot(); let solverMs = physics.lastStepMs, maxSolverMs = solverMs;
  for (let i = 1; i < 720; i++) { physics.step(); solverMs += physics.lastStepMs; maxSolverMs = Math.max(maxSolverMs, physics.lastStepMs); }
  evidence.push({ fixture: name, stages, physics: { first, firstStep, after12seconds: physics.snapshot(), contacts: physics.contacts, bodyContacts: physics.bodyContacts, wallMs: performance.now() - start, meanSolverMs: solverMs / 720, maxSolverMs } }); physics.dispose();
}
const result = { profile: 'resident-f32-v1', rapier: '0.20.0', timestamp: new Date().toISOString(), node: process.version, cpu: cpus()[0].model,
  gpuValidation: 'NOT RUN: browser UI automation unavailable; this file is CPU/WASM evidence only.', fixtures: evidence };
mkdirSync('artifacts/resident-terrain-benchmark', { recursive: true }); writeFileSync('artifacts/resident-terrain-benchmark/resident-cpu.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

// Retain the first isolated rejected neighborhood encountered while qualifying
// non-dyadic authoring coordinates. Never silently weld the collapsed f32 cap.
const pathological = structuralFixture('one-support');
pathological.sources[0].bounds.max[1] = .6;
pathological.sources[1] = { ...pathological.sources[1], bounds: { min: [-5.3, .6, -.9], max: [-3.7, 6, .9] } };
pathological.sources[2] = { ...pathological.sources[2], bounds: { min: [-8.4, 6, -1.5], max: [8.4, 7.2, 1.5] } };
const rejected = new ResidentArrangement(residentLattice(pathological.bounds), pathological.sources);
for (const brick of rejected.lattice.bricks.keys()) try { rejected.rebuild(brick, 0); } catch (error) {
  const counterexample = { profile: 'resident-f32-v1', brick, fixture: pathological, error: String(error),
    continuation: 'Resolve this local collapsed-cap construction from original sample constraints; preserve the old accepted world until the replacement passes volume and seam validation.' };
  writeFileSync('artifacts/resident-terrain-benchmark/resident-rejected-neighborhood.json', JSON.stringify(counterexample, null, 2) + '\n'); break;
}
