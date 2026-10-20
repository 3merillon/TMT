import { expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { enduranceCut } from '../src/lab/resident-endurance';

// Source/solver endurance; actual GPU construction is run in structural-check. The global oracle (fine-graph
// connectivity, full seam audit, incremental boundary face by face) runs here and behind ?residentCheck=1 only.
it('keeps admitting cuts beyond 24 overlapping impacts, compacts only at idle and agrees with the global oracle', async () => {
  const input = residentPlanet(7), physics = await StructuralPhysics.create(input.planetCenter);
  const terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
  try {
    await terrain.initialize();
    expect(terrain.verifyOracle()).toEqual([]);
    let idle = 0;
    for (let i = 0; i < 64; i++) {
      const cut = enduranceCut(terrain.queries, i), compactions = terrain.compactions;
      try { await terrain.cut(cut); } catch (error) { throw new Error(`Impact ${i + 1} ${JSON.stringify(cut)}: ${String(error)}`, { cause: error }); }
      expect(terrain.compactions, 'no compaction inside an edit').toBe(compactions);
      if (i % 8 === 7) {
        expect(terrain.verifyOracle(), `oracle after impact ${i + 1}`).toEqual([]);
        if (await terrain.maintenance(1e9)) idle++;
        console.log(`resident endurance: ${i + 1} impacts, ${terrain.arrangement.vertices.length} recipes, ${physics.bodies.size} bodies, ${idle} idle compactions`);
      }
    }
    expect(terrain.history.filter(edit => edit.cut)).toHaveLength(64); expect(terrain.lastFailure).toBeNull();
    expect(terrain.history.every(edit => edit.metrics.compactions === 0)).toBe(true);
    const before = terrain.arrangement.vertices.length, volume = terrain.history.at(-1)!.ledger.anchored;
    terrain.compact(); expect(terrain.arrangement.vertices.length).toBeLessThan(before);
    expect(terrain.verifyOracle()).toEqual([]);
    await terrain.rebuild(); expect(terrain.history.at(-1)!.ledger.anchored).toBeCloseTo(volume, 3);
    expect(terrain.verifyOracle()).toEqual([]);
  } finally { terrain.dispose(); }
}, 480000);
