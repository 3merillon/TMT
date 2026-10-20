/** The query revision (ResidentGameTerrain.version) changes exactly when a query answer can: at a commit and on a
 * fixed step that moved a structural body, not merely because a body is still awake. */
import { expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import type { V3 } from '../src/game/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

it('bumps the revision on commits and on steps that move a body, not while one rests awake', async () => {
  const fixture = structuralFixture(), physics = await StructuralPhysics.create(fixture.planetCenter);
  const resident = new ResidentTerrain(fixture, new GeometryGate().pages, physics, new FakeTerrainHost()), game = ResidentGameTerrain.adopt(resident, 7);
  try {
    await game.initialize();
    for (const cut of fixture.cuts) await game.carve(cut.center, cut.radius);
    const slab = physics.bodies.get(1)!.body, pose = () => { const p = slab.translation(), q = slab.rotation(); return [p.x, p.y, p.z, q.x, q.y, q.z, q.w]; };
    game.fixedStep(); // the first step after a commit has no earlier poses to compare with
    let moved = 0, still = 0;
    for (let i = 0; i < 1500; i++) {
      const before = pose(), version = game.version;
      game.fixedStep();
      const changed = pose().some((v, k) => !Object.is(v, before[k]));
      expect(game.version !== version).toBe(changed);
      if (changed) moved++; else still++;
    }
    expect(moved).toBeGreaterThan(10); expect(still).toBeGreaterThan(10);
    const version = game.version, p = slab.translation();
    await game.carve([p.x, p.y, p.z] as V3, 2.25);
    expect(game.version).toBeGreaterThan(version);
  } finally { game.dispose(); }
}, 120000);
