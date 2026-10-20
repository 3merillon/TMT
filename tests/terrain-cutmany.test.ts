/** cutMany: several cuts in ONE transaction (union dirty set, cuts applied in id order). The volume ledger balances
 * within the one transaction, and the world equals the same cuts applied one by one. */
import { expect, it } from 'vitest';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import type { ResidentWorldInput } from '../src/gpu/terrain/fixtures';
import type { SphereCut } from '../src/gpu/terrain/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

async function world(input: ResidentWorldInput) {
  const gate = new GeometryGate(), physics = await StructuralPhysics.create(input.planetCenter);
  let transactions = 0; const construct = gate.constructRegions.bind(gate);
  gate.constructRegions = async () => { transactions++; return construct(); };
  const terrain = new ResidentTerrain(input, gate.pages, physics, new FakeTerrainHost());
  await terrain.initialize();
  return { terrain, physics, transactions: () => transactions };
}
const staticVolume = (terrain: ResidentTerrain) => [...terrain.pages.values()].reduce((s, p) => s + p.regions.reduce((v, r) => v + r.volume, 0), 0);
const bodyVolume = (physics: StructuralPhysics) => [...physics.bodies.values()].reduce((s, b) => s + b.candidate.regions.reduce((v, r) => v + r.volume, 0), 0);

it('detaches a structure in one transaction and balances its ledger', async () => {
  const fixture = structuralFixture(), one = await world(fixture), serial = await world(structuralFixture());
  try {
    const cuts = [...fixture.cuts].reverse(), transactions = one.transactions(), history = one.terrain.history.length;
    const edit = (await one.terrain.cutMany(cuts))!;
    expect(one.terrain.history).toHaveLength(history + 1);
    expect(one.transactions()).toBe(transactions + 1);
    expect(edit.cuts?.map(c => c.id)).toEqual([...fixture.cuts].map(c => c.id).sort());
    expect(edit.bodies).toHaveLength(1);
    expect(Math.abs(edit.ledger.error)).toBeLessThan(1e-6);
    expect(edit.ledger.removed).toBeGreaterThan(0);
    for (const cut of fixture.cuts) await serial.terrain.cut(cut);
    expect(one.physics.bodies.size).toBe(serial.physics.bodies.size);
    expect(staticVolume(one.terrain)).toBeCloseTo(staticVolume(serial.terrain), 6);
    expect(bodyVolume(one.physics)).toBeCloseTo(bodyVolume(serial.physics), 6);
    const removed = serial.terrain.history.slice(1).reduce((s, e) => s + e.ledger.removed, 0);
    expect(edit.ledger.removed).toBeCloseTo(removed, 6);
    // A cutMany that also recuts the detached body: still one balanced transaction.
    const body = [...one.physics.bodies.values()][0], p = body.body.translation();
    const recut: SphereCut[] = [{ id: 'z-slab-a', center: [p.x - 2, p.y + .5, p.z], radius: 2.25, repeat: 'impact' }, { id: 'z-slab-b', center: [p.x + 2, p.y + .5, p.z], radius: 2.25, repeat: 'impact' }];
    const before = bodyVolume(one.physics), second = (await one.terrain.cutMany(recut))!;
    expect(Math.abs(second.ledger.error)).toBeLessThan(1e-6);
    expect(before - bodyVolume(one.physics)).toBeCloseTo(second.ledger.removed, 5);
    expect(one.physics.bodies.has(body.candidate.id)).toBe(false);
  } finally { one.terrain.dispose(); serial.terrain.dispose(); }
}, 60000);

it('applies a four-cut salvo on the planet as one transaction equal to four serial edits', async () => {
  const input = residentPlanet(7), one = await world(input), serial = await world(residentPlanet(7));
  try {
    const salvo: SphereCut[] = [[0.4, 17.6, 0.2], [-1.6, 17.5, 1.1], [1.9, 17.4, -1.3], [8, 15.8, 3]].map((center, i) => ({ id: `12:0:${3 - i}`, center: center as [number, number, number], radius: 2.6, repeat: 'impact' as const }));
    const transactions = one.transactions(), before = staticVolume(one.terrain);
    const edit = (await one.terrain.cutMany(salvo))!;
    expect(one.transactions()).toBe(transactions + 1);
    expect(edit.cuts).toHaveLength(4);
    expect(Math.abs(edit.ledger.error)).toBeLessThan(Math.max(1e-5, edit.ledger.before * 1e-6));
    expect(before - staticVolume(one.terrain) - bodyVolume(one.physics)).toBeCloseTo(edit.ledger.removed, 3);
    for (const cut of [...salvo].sort((a, b) => a.id < b.id ? -1 : 1)) await serial.terrain.cut(cut);
    expect(staticVolume(one.terrain)).toBeCloseTo(staticVolume(serial.terrain), 3);
    expect(one.terrain.verifyOracle()).toEqual([]);
    expect(one.terrain.triangles).toBe(serial.terrain.triangles);
  } finally { one.terrain.dispose(); serial.terrain.dispose(); }
}, 120000);
