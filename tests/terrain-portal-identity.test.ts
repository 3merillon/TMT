import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { residentPlanet } from '../src/gpu/terrain/planet';
import type { OccupiedRegion, RegionFace, RegionPage } from '../src/gpu/terrain/contracts';
import { auditBoundary, localTopology, ResidentConnectivity, terrainConnectivity } from '../src/game/terrain-connectivity';
import { area } from '../src/gpu/terrain/math';

const captured = JSON.parse(readFileSync(new URL('./fixtures/terrain/startup-topology-failure.json', import.meta.url), 'utf8')) as {
  seed: number; brick: string; error: string; regions: OccupiedRegion[];
  vertices: { id: number; position: [number, number, number] }[];
};
const faceWords = (face: RegionFace, position: (id: number) => readonly number[]) => `${face.source}/${face.vertices.map(id => position(id).join(',')).sort().join(';')}`;

it('preserves the captured seed-13 geometry while pairing coincident patches by their source face', () => {
  const input = residentPlanet(captured.seed, undefined, 'resident-f32-game-v3');
  const a = new ResidentArrangement(residentLattice(input.bounds), input.sources, 2048, true, input.uniformRegions);
  const page = a.rebuild(captured.brick, 1), before = JSON.stringify(page), positions = new Map(captured.vertices.map(v => [v.id, v.position]));
  expect(captured.error).toContain('Non-manifold occupied portal');
  // The fixture was captured from the failing pre-fix eight-worker startup. The serial brick must retain all
  // three regions, every physical face and the integrated volume, despite its different allocation order.
  for (const old of captured.regions) {
    const region = page.regions.find(r => r.id === old.id)!;
    expect(region.volume).toBe(old.volume);
    expect(region.faces.map(f => faceWords(f, id => a.vertices[id].position)).sort()).toEqual(old.faces.map(f => faceWords(f, id => positions.get(id)!)).sort());
  }
  let node = 0;
  const topology = localTopology(page, a, () => ++node);
  expect(topology.nodes).toHaveLength(1);
  expect(topology.nodes[0].regions).toHaveLength(page.regions.length);
  expect(JSON.stringify(page)).toBe(before);
  expect(terrainConnectivity(page.regions, a).nodes).toBe(topology.nodes.length);
});

it('retains the captured seed-27 collinear subdivisions without moving vertices or removing surface area', () => {
  const old = JSON.parse(readFileSync(new URL('./fixtures/terrain/startup-seam-failure-27.json', import.meta.url), 'utf8')) as {
    seed: number; audit: { unpaired: number; orientationErrors: number }; regions: OccupiedRegion[];
    vertices: { id: number; position: [number, number, number] }[];
  };
  expect(old.audit).toMatchObject({ unpaired: 3, orientationErrors: 3 });
  const input = residentPlanet(old.seed, undefined, 'resident-f32-game-v3');
  const a = new ResidentArrangement(residentLattice(input.bounds), input.sources, 2048, true, input.uniformRegions);
  const page = a.rebuild(old.regions[0].brick, 1), positions = new Map(old.vertices.map(v => [v.id, v.position]));
  for (const before of old.regions) {
    const after = page.regions.find(r => r.id === before.id)!;
    expect(after.volume).toBe(before.volume);
    expect(after.faces).toHaveLength(before.faces.length);
    const beforePoints = new Set(before.faces.flatMap(f => f.vertices.map(id => positions.get(id)!.join(','))));
    expect(new Set(after.faces.flatMap(f => f.vertices.map(id => a.vertices[id].position.join(','))))).toEqual(beforePoints);
    expect(after.faces.reduce((sum, f) => sum + area(f.vertices.map(id => a.vertices[id].position)), 0)).toBeCloseTo(before.faces.reduce((sum, f) => sum + area(f.vertices.map(id => positions.get(id)!)), 0), 12);
    expect(auditBoundary(after.faces.map(face => ({ face, region: after })))).toMatchObject({ unpaired: 0, orientationErrors: 0 });
  }
});

function patches(): { a: ResidentArrangement; regions: OccupiedRegion[] } {
  const a = new ResidentArrangement(residentLattice({ min: [0, 0, 0], max: [3, 3, 3] }), []);
  const face = a.lattice.tets[0].vertices.slice(0, 3);
  const regions = ['plane-a', 'plane-b', 'plane-a', 'plane-b'].map((source, i): OccupiedRegion => ({
    id: `r${i}`, tet: `t${i}`, brick: i < 2 ? 'left' : 'right', material: 1, source: 'solid', anchor: i < 2 ? 'core' : undefined,
    faces: [{ source, vertices: i < 2 ? face : [...face].reverse() }], volume: 1, constraints: [],
  }));
  return { a, regions };
}

it('keeps distinct cross-brick portals separate through repeated prepares, updates, abort and retry', () => {
  const { a, regions } = patches(), cache = new ResidentConnectivity();
  const pages = new Map<string, RegionPage>(['left', 'right'].map(brick => [brick, { brick, revision: 1, regions: regions.filter(r => r.brick === brick), removedVolume: 0 }]));
  const cancelled = cache.begin(a);
  for (const page of pages.values()) cancelled.prepare(page);
  expect(cache.bricks).toBe(0); // Discarding a prepared delta publishes nothing.
  const delta = cache.begin(a);
  for (const page of pages.values()) { delta.prepare(page); delta.prepare(page); }
  delta.update(pages);
  expect(delta.components().nodes).toBe(4);
  expect(delta.components().detached).toEqual([]);
  expect(delta.boundary('left')).toEqual([]);
  expect(delta.boundary('right')).toEqual([]);
  expect(delta.finish()).toMatchObject({ unpaired: 0, orientationErrors: 0 });
  cache.apply(delta);
  expect(cache.boundary()).toEqual([]);
  // Retire one right-hand portal: only its matching source becomes boundary, and the other bond survives.
  const edit = cache.begin(a), right: RegionPage = { ...pages.get('right')!, revision: 2, regions: [regions[3]] };
  edit.prepare(right); edit.prepare(pages.get('right')!); edit.update(new Map([['right', right]]));
  expect(edit.boundary('left').map(f => f.face.source)).toEqual(['plane-a']);
  expect(edit.boundary('right')).toEqual([]);
  expect(edit.components().detached).toEqual([]);
  edit.prepare(pages.get('right')!); edit.update(new Map([['right', pages.get('right')!]]));
  expect(edit.finish()).toMatchObject({ unpaired: 0, orientationErrors: 0 });
  cache.apply(edit);
  expect(cache.boundary()).toEqual([]);
});

it('still rejects three incidences of the same supporting face locally and across bricks', () => {
  const { a, regions } = patches(), triples = [regions[0], { ...regions[2], brick: 'left' }, { ...regions[2], id: 'third', brick: 'left' }];
  expect(() => localTopology({ brick: 'left', regions: triples, revision: 1, removedVolume: 0 }, a, () => 1)).toThrow('Non-manifold occupied portal');
  expect(() => terrainConnectivity(triples, a)).toThrow('Non-manifold occupied portal');
  const delta = new ResidentConnectivity().begin(a);
  expect(() => delta.update(new Map(triples.map((r, i) => [`brick-${i}`, { brick: `brick-${i}`, revision: 1, removedVolume: 0, regions: [{ ...r, brick: `brick-${i}` }] }])))).toThrow('Non-manifold cross-brick portal');
});
