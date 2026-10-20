import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { ResidentArrangement } from '../src/gpu/terrain/arrangement';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { terrainConnectivity } from '../src/game/terrain-connectivity';
import { structuralCandidate } from '../src/game/structural-colliders';
import { testPhysics } from './helpers/native-physics';
import type { BodyCandidate } from '../src/gpu/terrain/contracts';

it('retains clean static colliders across local commits and preserves them when staging is cancelled', async () => {
  const physics = await testPhysics([0, 0, 0]);
  const page = (id: number, x: number): BodyCandidate => ({ id, regions: [], center: [0, 0, 0], colliders: [{ kind: 'trimesh', regionIds: [], volume: 0,
    vertices: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 0, 1]), indices: new Uint32Array([0, 2, 1]) }] });
  const a = page(-1, 0), b = page(-2, 3);
  try {
    physics.stage([a, b], []).commit(); expect(physics.lastStaticCooked).toBe(2);
    const original = [...physics.world.bodies.getAll()];
    const pending = physics.stage([a, page(-2, 4)], []); pending.cancel();
    expect(physics.world.bodies.getAll()).toEqual(original);
    physics.stage([{ ...a }, page(-2, 4)], []).commit(); expect(physics.lastStaticCooked).toBe(1);
    expect(physics.world.bodies.getAll()).toContain(original[0]);
    physics.stage([a], []).commit(); expect(physics.lastStaticCooked).toBe(0);
    expect(physics.world.bodies.getAll()).toEqual([original[0]]);
  } finally { physics.dispose(); }
});

it('keeps the authored volume of thin convex fragments without a second hull reduction', async () => {
  const physics = await testPhysics([0, 0, 0]);
  const height = Math.fround(.000044528), vertices = new Float32Array([0, 0, 0, 6, 0, 0, 0, 2, 0, 5.999, 1.9, height]);
  const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]), volume = 2 * height;
  try {
    physics.stage([], [{ id: 1, regions: [], center: [12, 18, -9], colliders: [{ regionIds: [], vertices, indices, volume, offset: [-7, 2, 4] }] }]).commit();
    const body = physics.bodies.get(1)!.body;
    expect(body.mass()).toBeCloseTo(volume, 9);
    expect(physics.massFallbacks).toBe(1);
    // Ray hits retain the original thin boundary; this is not an inflated proxy.
    const hit = body.collider(0).castRay(new RAPIER.Ray({ x: 10, y: 21.5, z: -4 }, { x: 0, y: 0, z: -1 }), 2, false);
    expect(hit).toBeCloseTo(1 - height * 1.5 / 1.9, 5);
    for (let i = 0; i < 60; i++) physics.step();
    expect(Object.values(body.translation()).every(Number.isFinite)).toBe(true);
  } finally { physics.dispose(); }
});

describe('persistent Rapier structural bodies', () => {
  for (const name of ['one-support', 'two-supports', 'three-bricks', 'arch'] as const) it(`${name}: volume compound falls, contacts, rotates and persists`, async () => {
    const fixture = structuralFixture(name), a = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources);
    fixture.cuts.forEach(c => a.addCut(c)); const regions = [...a.lattice.bricks.keys()].flatMap(b => a.rebuild(b, 1).regions), graph = terrainConnectivity(regions, a);
    expect(graph.detached).toHaveLength(1);
    const candidate = structuralCandidate(1, graph.detached[0], a), fixed = structuralCandidate(0, graph.anchored, a);
    const physics = await testPhysics(fixture.planetCenter);
    try {
      physics.stage([fixed], [candidate]).commit(); const body = physics.bodies.get(1)!.body;
      expect(body.mass()).toBeCloseTo(candidate.regions.reduce((s, r) => s + r.volume, 0), 3);
      if (name === 'arch') {
        const ray = new RAPIER.Ray({ x: 0, y: 5.5, z: -4 }, { x: 0, y: 0, z: 1 });
        for (let i = 0; i < body.numColliders(); i++) expect(body.collider(i).castRay(ray, 8, true)).toBe(-1);
      }
      const initial = body.translation(); physics.step(); expect(body.translation().y).toBeLessThan(initial.y);
      for (let i = 1; i < 720; i++) physics.step();
      expect(physics.bodies.size).toBe(1); expect(physics.contacts).toBeGreaterThan(0); expect(body.translation().y).toBeGreaterThan(0);
      const q = body.rotation(); expect(Math.hypot(q.x, q.y, q.z)).toBeGreaterThan(.001);
      const v = body.linvel(); expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(.15);
      body.sleep(); expect(body.isSleeping()).toBe(true); physics.stage([], []).commit(); expect(body.isSleeping()).toBe(false);
      const supportedY = body.translation().y; physics.step(); expect(body.translation().y).toBeLessThan(supportedY);
    } finally { physics.dispose(); }
  }, 60000);
});

it('compound bodies contact each other; CCD catches a fast thin-wall crossing', async () => {
  const a = new ResidentArrangement(residentLattice({ min: [-3, 0, -3], max: [3, 9, 3] }), [
    { id: 'floor', material: 1, anchor: 'floor', bounds: { min: [-3, 0, -3], max: [3, .125, 3] } },
    { id: 'lower', material: 2, bounds: { min: [-1, 1, -1], max: [1, 2, 1] } },
    { id: 'upper', material: 2, bounds: { min: [-.5, 5, -.5], max: [.5, 6, .5] } },
  ]);
  const regions = [...a.lattice.bricks.keys()].flatMap(b => a.rebuild(b, 0).regions), g = terrainConnectivity(regions, a);
  expect(g.detached).toHaveLength(2);
  const physics = await testPhysics([0, -1000, 0]);
  try {
    physics.stage([structuralCandidate(0, g.anchored, a)], g.detached.map((r, i) => structuralCandidate(i + 1, r, a))).commit();
    for (let i = 0; i < 720; i++) physics.step();
    expect(physics.bodyContacts).toBeGreaterThan(0); expect(physics.bodies.size).toBe(2);
    for (const { body } of physics.bodies.values()) expect(body.translation().y).toBeGreaterThan(0);
  } finally { physics.dispose(); }
  const fast = await testPhysics([0, -1000, 0]);
  try {
    const upper = g.detached.find(r => r.some(r => r.source === 'upper'))!;
    fast.stage([structuralCandidate(0, g.anchored, a)], [structuralCandidate(1, upper, a)]).commit();
    const body = fast.bodies.get(1)!.body; body.setLinvel({ x: 0, y: -180, z: 0 }, true);
    // A step travels 3 units, twenty-four times the wall thickness.
    for (let i = 0; i < 60; i++) { fast.step(); expect(body.translation().y).toBeGreaterThan(.12); }
    expect(fast.contacts).toBeGreaterThan(0); expect(body.linvel().y).toBeGreaterThan(-1);
  } finally { fast.dispose(); }
}, 60000);
