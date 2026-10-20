import { expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

/** Transaction fault injection only: these tests make no GPU qualification claim. */
it('commits ownership once and preserves the entire old world on capacity, stale and cancellation failures', async () => {
  const fixture = structuralFixture(), gate = new GeometryGate(), physics = await StructuralPhysics.create(fixture.planetCenter);
  const terrain = new ResidentTerrain(fixture, gate.pages, physics, new FakeTerrainHost());
  try {
    await terrain.initialize(); const pages = terrain.pages, queries = terrain.queries, epoch = terrain.epoch, live = gate.live;
    gate.fail = true; await expect(terrain.cut(fixture.cuts[0])).rejects.toMatchObject({ code: 'capacity' });
    expect(terrain.pages).toBe(pages); expect(terrain.queries).toBe(queries); expect(terrain.epoch).toBe(epoch); expect(physics.bodies.size).toBe(0); expect(gate.live).toBe(live); expect(terrain.arrangement.cuts).toHaveLength(0);
    gate.fail = false;
    let release!: () => void, entered!: () => void; const entering = new Promise<void>(r => { entered = r; });
    gate.gate = () => { entered(); return new Promise<void>(r => { release = r; }); };
    const stale = terrain.cut(fixture.cuts[0]); const staleResult = expect(stale).rejects.toMatchObject({ code: 'stale' }); await entering;
    const replacement = terrain.cut(fixture.cuts[0]); gate.gate = undefined; release(); await staleResult; await replacement;
    expect(terrain.epoch).toBe(epoch + 1); expect(physics.bodies.size).toBe(0); expect(terrain.arrangement.cuts).toHaveLength(1);
    const accepted = await terrain.cut(fixture.cuts[1]); expect(accepted?.bodies).toHaveLength(1); expect(Math.abs(accepted!.ledger.error)).toBeLessThan(1e-4);
    const body = physics.bodies.get(1)!.body, before = body.translation(); terrain.step(); expect(body.translation().y).toBeLessThan(before.y);
    const bodyIds = new Set([...terrain.ownership].filter(([, o]) => o.kind === 'body').map(([id]) => id));
    expect([...terrain.pages.values()].flatMap(p => [...p.regions]).some(r => bodyIds.has(r.id))).toBe(false);
    const cutEpoch = terrain.epoch; expect(await terrain.cut({ ...fixture.cuts[1], id: 'same-shape-different-id' })).toBeNull(); expect(terrain.epoch).toBe(cutEpoch);
    await terrain.rebuild(); expect(physics.bodies.get(1)!.body).toBe(body); expect([...terrain.pages.values()].some(p => p.regions.some(r => r.source === 'slab'))).toBe(false);
    const current = terrain.pages; const controller = new AbortController(); controller.abort();
    await expect(terrain.rebuild(controller.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(terrain.pages).toBe(current);
  } finally { terrain.dispose(); expect(gate.live).toBe(0); }
}, 60000);

it('cancels at collision preparation without publishing partial query pages and permits a retry', async () => {
  const fixture = structuralFixture(), gate = new GeometryGate(), host = new FakeTerrainHost();
  const terrain = new ResidentTerrain(fixture, gate.pages, await StructuralPhysics.create(fixture.planetCenter), host);
  try {
    await terrain.initialize(); const previous = terrain.queries, pages = terrain.pages, commits = host.commits.length;
    const controller = new AbortController(); terrain.onProgress = p => { if (p.stage === 'collision') controller.abort(); };
    await expect(terrain.rebuild(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(terrain.queries).toBe(previous); expect(terrain.pages).toBe(pages); expect(host.commits).toHaveLength(commits);
    terrain.onProgress = undefined; await terrain.rebuild(); expect(terrain.epoch).toBe(2);
    expect(terrain.queries.fixed.surface([0, 1, 0])).toEqual(previous.fixed.surface([0, 1, 0]));
  } finally { terrain.dispose(); expect(gate.live).toBe(0); }
});
