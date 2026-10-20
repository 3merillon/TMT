import { expect, it } from 'vitest';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

it.each([
  { seed: 13, center: [2.74, 9.89, 15.26] as [number, number, number] },
  { seed: 27, center: [13.9167, 6.9115, -0.9115] as [number, number, number] },
])('retries captured startup seed $seed, audits adjacent bricks and destructs its failed neighborhood', async ({ seed, center }) => {
  const input = residentPlanet(seed, undefined, 'resident-f32-game-v3'), gate = new GeometryGate(), host = new FakeTerrainHost();
  const terrain = new ResidentTerrain(input, gate.pages, await StructuralPhysics.create(input.planetCenter), host);
  try {
    gate.fail = true;
    await expect(terrain.initialize()).rejects.toThrow('Injected resident capacity refusal');
    expect(terrain.epoch).toBe(0);
    expect(terrain.pages.size).toBe(0);
    expect(gate.live).toBe(0);
    expect(host.visible).toEqual([]);
    gate.fail = false;
    await terrain.initialize();
    expect(terrain.history[0].seam).toMatchObject({ unpaired: 0, orientationErrors: 0 });
    expect(terrain.verifyOracle()).toEqual([]);
    const before = terrain.queries.fixed, volume = terrain.history[0].ledger.anchored;
    const cut = { id: 'captured-neighborhood', center, radius: 2.6 };
    const staged = await terrain.prepare([cut]);
    expect(staged).not.toBeNull();
    terrain.abort(staged!);
    expect(terrain.queries.fixed).toBe(before);
    expect(terrain.arrangement.cuts).toHaveLength(0);
    const edit = await terrain.cut(cut);
    expect(edit?.metrics.dirtyBricks).toBeGreaterThan(1);
    expect(edit?.seam).toMatchObject({ unpaired: 0, orientationErrors: 0 });
    expect(edit?.ledger.anchored).toBeLessThan(volume);
    expect(edit?.ledger.error).toBeCloseTo(0, 4);
    expect(terrain.verifyOracle()).toEqual([]);
    expect(host.disposedWhileVisible).toBe(0);
    expect(gate.live).toBe(host.visible.length);
  } finally { terrain.dispose(); }
  expect(gate.live).toBe(0);
  expect(host.visible).toEqual([]);
}, 90000);
