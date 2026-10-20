import { describe, expect, it } from 'vitest';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { auditBoundary, terrainConnectivity } from '../src/game/terrain-connectivity';
import { area } from '../src/gpu/terrain/math';
import { meshArrangement } from '../src/core/arrangement';
import { buildAdaptiveGrid } from '../src/core/octree';
import { difference, intersection, leaf, union } from '../src/core/fields';
import { auditMesh } from '../src/core/audit';

describe('resident occupied-region geometry', () => {
  it('uses the canonical 24 tetrahedra in each side-3 cell', () => {
    const lattice = residentLattice({ min: [0, 0, 0], max: [6, 6, 6] });
    expect(lattice.tets).toHaveLength(24 * 8); expect(lattice.bricks.size).toBe(1);
  });
  for (const name of ['one-support', 'two-supports', 'three-bricks', 'arch'] as const) it(`${name}: surviving remote volume detaches only after the last support`, () => {
    const fixture = structuralFixture(name), arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
    const pages = new Map([...arrangement.lattice.bricks.keys()].map(key => [key, arrangement.rebuild(key, 0)]));
    const getRegions = () => [...pages.values()].flatMap(p => [...p.regions]);
    let graph = terrainConnectivity(getRegions(), arrangement);
    expect(graph.detached).toHaveLength(0); expect(auditBoundary(graph.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
    const initial = graph.anchored.reduce((s, r) => s + r.volume, 0);
    for (const r of getRegions()) for (const face of r.faces) for (let i = 1; i + 1 < face.vertices.length; i++) expect(area([face.vertices[0], face.vertices[i], face.vertices[i + 1]].map(id => arrangement.vertices[id].position))).toBeGreaterThan(0);
    for (let i = 0; i < fixture.cuts.length; i++) {
      const field = arrangement.addCut(fixture.cuts[i]);
      for (const brick of arrangement.dirtyBricks(field)) pages.set(brick, arrangement.rebuild(brick, i + 1));
      graph = terrainConnectivity(getRegions(), arrangement);
      expect(auditBoundary(graph.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
      for (const r of getRegions()) for (const face of r.faces) for (let j = 1; j + 1 < face.vertices.length; j++) expect(area([face.vertices[0], face.vertices[j], face.vertices[j + 1]].map(id => arrangement.vertices[id].position))).toBeGreaterThan(0);
      if (i + 1 < fixture.cuts.length) expect(graph.detached).toHaveLength(0);
    }
    expect(graph.detached).toHaveLength(1);
    const detached = graph.detached.flat();
    expect(new Set(detached.map(r => r.brick)).size).toBeGreaterThanOrEqual(3);
    const slabVolume = detached.filter(r => r.source === 'slab').reduce((s, r) => s + r.volume, 0);
    const slab = fixture.sources.find(b => b.id === 'slab')!.bounds;
    expect(slabVolume).toBeCloseTo(slab.min.reduce((s, x, i) => s * (slab.max[i] - x), 1), 3);
    expect(getRegions().reduce((s, r) => s + r.volume, 0)).toBeLessThan(initial);
    // Replay uses original source signs plus ownership masks, not rounded render geometry.
    const masks = detached.map(r => ({ tet: r.tet, constraints: r.constraints, body: 1 }));
    for (const brick of pages.keys()) pages.set(brick, arrangement.rebuild(brick, 3, masks));
    graph = terrainConnectivity(getRegions(), arrangement);
    expect(graph.detached).toHaveLength(0);
    expect(getRegions().some(r => r.source === 'slab')).toBe(false);
    const before = arrangement.fields.length; arrangement.addCut(fixture.cuts.at(-1)!); expect(arrangement.fields.length).toBe(before);
  }, 60000);
  it('captures the f32 source words for the independent exact arrangement oracle', () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [6, 6, 6] as [number, number, number] };
    const a = new ResidentArrangement(residentLattice(bounds), [
      { id: 'a', material: 1, bounds: { min: [.5, .5, .5], max: [5.5, 2.5, 5.5] } },
      { id: 'b', material: 2, bounds: { min: [1.5, 1.5, 1.5], max: [4.5, 5.5, 4.5] } },
    ]); a.addCut({ id: 'cut', center: [3, 3, 3], radius: 1.875 });
    const boxExpressions = a.boxFields.map(fields => fields.map(i => leaf(a.fields[i].id)).reduce((left, right) => intersection(left, right)));
    const expression = difference(union(boxExpressions[0], boxExpressions[1]), leaf('cut'));
    const scene = { fields: a.fields.map(field => ({ ...field, name: field.id, material: 1 })), expression, materials: [] };
    const grid = buildAdaptiveGrid(scene, { bounds, maxDepth: 1, minDepth: 1, tolerance: .001, adaptive: false });
    const exact = meshArrangement(grid, scene), regions = a.rebuild('0,0,0', 0).regions;
    const volume = regions.reduce((s, r) => s + r.volume, 0);
    expect(volume).toBeCloseTo(auditMesh(exact).signedVolume, 4);
    expect(auditBoundary(terrainConnectivity(regions, a).boundary).unpaired).toBe(0);
  }, 60000);
});
