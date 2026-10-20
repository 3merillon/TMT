import { expect, it } from 'vitest';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import type { RegionPage } from '../src/gpu/terrain/contracts';
import { packPages, unpackPages } from '../src/gpu/terrain/page-packet';
import { drainTerrainWork } from '../src/gpu/terrain/work-budget';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { auditBoundary, terrainConnectivity } from '../src/game/terrain-connectivity';
import { initialPartitions, brickWorker } from '../src/gpu/terrain/page-workers';

it('merges independently compiled partitions, source recipes and later cuts across collection and field rollback', () => {
  const fixture = structuralFixture('three-bricks');
  const create = () => new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true);
  const main = create(), workers = Array.from({ length: 4 }, create), pages = new Map<string, RegionPage>(), base = main.fields.length;
  const rebuild = (revision: number) => {
    const bricks = [...main.lattice.bricks.keys()];
    const requests = bricks.map(brick => ({ brick, tets: null }));
    const partitions = revision === 1 ? initialPartitions(requests, workers.length) : workers.map((_, i) => requests.filter(r => brickWorker(r.brick, workers.length) === i));
    workers.forEach((worker, i) => {
      worker.rollbackFields(base, 0); for (const field of main.preparedFields(base)) worker.appendPreparedField(field);
      const packet = unpackPages(structuredClone(packPages(worker.compileTets(partitions[i], revision, []))));
      for (const page of main.acceptCompiled(packet)) pages.set(page.brick, page);
    });
    const regions = [...pages.values()].flatMap(page => page.regions), graph = terrainConnectivity(regions, main);
    expect(auditBoundary(graph.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
    return { regions, graph, volume: regions.reduce((sum, region) => sum + region.volume, 0) };
  };
  const initial = rebuild(1); expect(initial.graph.detached).toHaveLength(0);
  main.addCut(fixture.cuts[0]); const first = rebuild(2); expect(first.volume).toBeLessThan(initial.volume);
  const remap = main.compact(first.regions); for (const [key, page] of pages) pages.set(key, { ...page, regions: page.regions.map(region => remap.get(region)!) });
  // A rejected source index is reused with a different shape on the next request.
  const count = main.fields.length, cuts = main.cuts.length;
  main.addCut({ id: 'rejected', center: [0, 0, 0], radius: 1 }); main.rollbackFields(count, cuts);
  main.addCut(fixture.cuts[1]); const last = rebuild(3);
  expect(last.graph.detached).toHaveLength(1); expect(last.volume).toBeLessThan(first.volume);
});

it('imports deferred shared sample words and yields without changing the accepted topology', async () => {
  const fixture = structuralFixture('two-supports'), lattice = residentLattice(fixture.bounds);
  const worker = new ResidentArrangement(lattice, fixture.sources, 2048, true, true);
  const main = new ResidentArrangement(lattice, fixture.sources, 2048, true, true, true);
  const fields = worker.preparedFields(0); main.acceptPreparedSamples(fields.map(field => field.samples));
  const packet = unpackPages(packPages(worker.compilePages([...lattice.bricks.keys()], 1, [])));
  const pages = await drainTerrainWork(main.acceptCompiledSteps(packet), undefined, 0);
  const graph = terrainConnectivity(pages.flatMap(page => [...page.regions]), main);
  expect(graph.detached).toHaveLength(0); expect(auditBoundary(graph.boundary)).toMatchObject({ unpaired: 0, orientationErrors: 0 });
  const field = main.addCut(fixture.cuts[0]); expect(main.dirtyBricks(field).size).toBeGreaterThan(0);
  expect(() => main.acceptPreparedSamples([])).toThrow(/prepared lattice samples/);
});
