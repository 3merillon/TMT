import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { auditBoundary, ResidentConnectivity, terrainConnectivity } from '../src/game/terrain-connectivity';
import { generatePlanetStructures, structureVolume } from '../src/game/terrain-structures';
import type { ResidentWorldInput } from '../src/gpu/terrain/fixtures';

it('preserves the original six-plane samples throughout every structure-intersecting tet', () => {
  const structures = generatePlanetStructures(7), input = residentPlanet(7, structures), lattice = residentLattice(input.bounds);
  for (const structure of structures) {
    const original = structureVolume(structure), prepared = input.sources.find(s => s.id === structure.id)!;
    const tets = lattice.tets.filter(t => [0, 1, 2].every(a => Math.min(...t.vertices.map(v => lattice.positions[v][a])) <= original.bounds.max[a] && Math.max(...t.vertices.map(v => lattice.positions[v][a])) >= original.bounds.min[a]));
    for (const id of new Set(tets.flatMap(t => t.vertices))) for (let i = 0; i < 6; i++) expect(Math.fround(prepared.fields![i].sample(lattice.positions[id]))).toBe(Math.fround(original.fields[i].sample(lattice.positions[id])));
  }
});

it('builds the full seeded planet and generated structures, then conserves volume across a local cut', () => {
  const input = residentPlanet(7), a = new ResidentArrangement(residentLattice(input.bounds), input.sources, 2048, true, input.uniformRegions);
  const pages = new Map([...a.lattice.bricks.keys()].map(b => [b, a.rebuild(b, 1)])), regions = [...pages.values()].flatMap(p => [...p.regions]);
  const graph = terrainConnectivity(regions, a), sources = new Set(regions.map(r => r.source));
  const initial = new ResidentConnectivity().rebuild(pages, a);
  expect(initial.graph.anchored.map(r => r.id).sort()).toEqual(graph.anchored.map(r => r.id).sort());
  expect(graph.detached).toHaveLength(0); expect(a.fields.length).toBe(261);
  for (const source of input.sources) expect(sources.has(source.id)).toBe(true);
  expect(auditBoundary(graph.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
  const before = regions.reduce((v, r) => v + r.volume, 0), field = a.addCut({ id: 'north-cut', center: [0, 18, 0], radius: 3 });
  const dirty = a.dirtyBricks(field); expect(dirty.size).toBeLessThan(20);
  for (const brick of dirty) pages.set(brick, a.rebuild(brick, 2));
  const next = [...pages.values()].flatMap(p => [...p.regions]), after = next.reduce((v, r) => v + r.volume, 0), removed = [...pages.values()].reduce((v, p) => v + p.removedVolume, 0);
  expect(removed).toBeGreaterThan(1); expect(Math.abs(before - after - removed)).toBeLessThan(before * 1e-4);
  const oracle = terrainConnectivity(next, a), incremental = initial.cache.rebuild(pages, a).graph;
  expect(incremental.boundary.map(b => b.face.vertices.join(',')).sort()).toEqual(oracle.boundary.map(b => b.face.vertices.join(',')).sort());
  expect(incremental.anchored.map(r => r.id).sort()).toEqual(oracle.anchored.map(r => r.id).sort());
  expect(auditBoundary(incremental.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
}, 90000);

it('explicitly refuses the captured unresolved non-dyadic neighborhood', () => {
  const { fixture } = JSON.parse(readFileSync(new URL('./fixtures/terrain/resident-rejected-neighborhood.json', import.meta.url), 'utf8')) as { fixture: ResidentWorldInput };
  const a = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 512, true);
  expect(() => [...a.lattice.bricks.keys()].flatMap(b => a.rebuild(b, 1).regions)).toThrow(/canonical cap cycle/);
});

it.each([0, 8])('admits default-game seed %i with a closed material boundary', seed => {
  const input = residentPlanet(seed), a = new ResidentArrangement(residentLattice(input.bounds), input.sources, 2048, true, input.uniformRegions);
  const pages = new Map([...a.lattice.bricks.keys()].map(b => [b, a.rebuild(b, 1)]));
  const graph = new ResidentConnectivity().rebuild(pages, a).graph;
  expect(graph.anchored.length).toBeGreaterThan(0);
  expect(auditBoundary(graph.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
}, 90000);
