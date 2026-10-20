/** Compaction runs only at idle (maintenance()), never inside an edit; a new request preempts it; afterwards the
 * remapped connectivity still equals the global oracle, every surviving region is bit-identical to a full rebuild, and
 * edits continue. Compaction is invisible: a twin world that never compacts ends with identical collision (and so
 * render) geometry. Only cut-away cells, whose vertices are dead and recreated under new ids, may integrate their
 * removed volume in another order (ledger rounding, ~1e-8 relative). */
import { expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { normalize } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import type { RegionPage } from '../src/gpu/terrain/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

it('compacts at idle with remapped ids, preemptibly, never inside an edit', async () => {
  const input = residentPlanet(7), physics = await StructuralPhysics.create(input.planetCenter);
  const terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
  const twinPhysics = await StructuralPhysics.create(input.planetCenter), twin = new ResidentTerrain(residentPlanet(7), new GeometryGate().pages, twinPhysics, new FakeTerrainHost());
  try {
    await terrain.initialize(); await twin.initialize();
    terrain.compactionPolicy = { ratio: 1, slack: 4096 };
    const surface = (d: V3): V3 => terrain.queries.surface(normalize(d))?.point ?? normalize(d).map(v => v * 18) as V3;
    let shot = 0;
    const edit = async () => {
      const i = shot++, angle = i * 2.399963229728653, cut = { id: `c${i}`, center: surface([Math.cos(angle), 0.7 + 0.3 * Math.sin(i), Math.sin(angle)]), radius: 2.6, repeat: 'impact' as const };
      await twin.cut(cut); return terrain.cut(cut);
    };
    while (!terrain.compactionDue) { const before = terrain.compactions; const accepted = await edit(); expect(terrain.compactions).toBe(before); expect(accepted?.metrics.compactions).toBe(0); }
    // A request arriving during maintenance preempts it: the compaction is abandoned and the edit proceeds.
    const maintenance = terrain.maintenance(0.01), preempting = edit();
    expect(await maintenance).toBe(false);
    await preempting;
    expect(terrain.compactions).toBe(0);
    const vertices = terrain.arrangement.vertices.length, volume = terrain.history.at(-1)!.ledger.anchored, triangles = terrain.triangles;
    expect(await terrain.maintenance(2)).toBe(true);
    expect(terrain.compactions).toBe(1);
    expect(terrain.arrangement.vertices.length).toBeLessThan(vertices);
    expect(terrain.triangles).toBe(triangles);
    expect(terrain.verifyOracle()).toEqual([]);
    // The tet cache (pages) survived the remap: full rebuilds reproduce every surviving region bit for bit (they
    // may recreate the dead vertices of cut-away cells, which are never referenced by a region).
    const words = (page: RegionPage) => JSON.stringify(page.regions);
    for (const [brick, page] of terrain.pages) if (page.regions.length || page.removedVolume) {
      const full = terrain.arrangement.rebuild(brick, page.revision);
      expect(words(full), brick).toBe(words(page));
      expect(Math.abs(full.removedVolume - page.removedVolume)).toBeLessThan(1e-6 * Math.max(1, page.removedVolume));
    }
    // Edits continue on the compacted ids and the rebuild preserves the surviving volume.
    for (let i = 0; i < 4; i++) expect((await edit())?.ledger.error).toBeCloseTo(0, 4);
    expect(terrain.verifyOracle()).toEqual([]);
    // The twin never compacted: identical collision triangles in every chunk (same positions, same order).
    expect(twin.compactions).toBe(0);
    expect([...terrain.queries.fixed.chunks.keys()].sort()).toEqual([...twin.queries.fixed.chunks.keys()].sort());
    for (const [id, chunk] of terrain.queries.fixed.chunks) {
      const other = twin.queries.fixed.chunks.get(id)!.mesh;
      expect(chunk.mesh.positions, id).toEqual(other.positions); expect(chunk.mesh.indices, id).toEqual(other.indices); expect(chunk.mesh.materials, id).toEqual(other.materials);
    }
    const survived = terrain.history.at(-1)!.ledger.anchored;
    await terrain.rebuild();
    expect(terrain.history.at(-1)!.ledger.anchored).toBeCloseTo(survived, 3);
    expect(survived).toBeLessThan(volume);
  } finally { terrain.dispose(); twin.dispose(); }
}, 180000);
