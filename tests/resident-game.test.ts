import { expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { ResidentTanks } from '../src/game/resident-tanks';
import { StructuralPhysics } from '../src/game/structural-physics';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import type { TankState, V3 } from '../src/game/contracts';
import { add, cross, dot, normalize, rotate, rotation, sub } from '../src/game/math';
import { DEFAULT_LOADOUT } from '../src/game/modules';
import { replayResident, residentReplay, validateResidentCheckpoint } from '../src/game/resident-checkpoint';
import { PLANET_GENERATOR } from '../src/game/planet-field';
import { residentFootprintBounds } from '../src/game/resident-queries';

// This geometry gate exercises game/physics transactions; hardware is qualified separately.
it('commits game queries with ownership and transforms moving body rays/solids/triangles', async () => {
  const fixture = structuralFixture(), physics = await StructuralPhysics.create(fixture.planetCenter);
  fixture.staticSurface = true; fixture.localConstruction = true;
  const terrain = new ResidentTerrain(fixture, new GeometryGate().pages, physics, new FakeTerrainHost());
  try {
    await terrain.initialize(); expect(terrain.queries.isSolid([0, 6.5, 0])).toBe(true);
    expect(terrain.queries.raycast([0, 10, 0], [0, -1, 0], 10)?.point[1]).toBeCloseTo(7.125, 5);
    await terrain.cut(fixture.cuts[0]);
    const before = terrain.queries.fixed;
    await terrain.cut(fixture.cuts[1]);
    const changed = residentFootprintBounds(before, terrain.queries.fixed);
    expect(changed.some(box => [0, 7.125, 0].every((value, axis) => value >= box.min[axis] && value <= box.max[axis]))).toBe(true);
    expect(residentFootprintBounds(terrain.queries.fixed, terrain.queries.fixed)).toEqual([]);
    expect(terrain.queries.fixed.isSolid([0, 6.5, 0])).toBe(false);
    expect(terrain.queries.isSolid([0, 6.5, 0])).toBe(true);
    const structural = physics.bodies.get(1)!, local = sub([0, 6.5, 0], structural.candidate.center);
    for (let i = 0; i < 90; i++) terrain.step();
    const p = structural.body.translation(), q = structural.body.rotation(), point = add([p.x, p.y, p.z], rotate(local, [q.x, q.y, q.z, q.w]));
    expect(terrain.queries.isSolid(point)).toBe(true);
    expect(terrain.queries.isSolid([0, 6.5, 0])).toBe(false);
    const hit = terrain.queries.raycast(add(point, [0, 4, 0]), [0, -1, 0], 8); expect(hit).not.toBeNull();
    const triangles = terrain.queries.queryTriangles({ min: sub(point, [2, 2, 2]), max: add(point, [2, 2, 2]) }, 2048);
    expect(triangles.triangles.length).toBeGreaterThan(0); expect(triangles.overflow).toBe(false);
    await terrain.rebuild(); expect(terrain.queries.fixed.isSolid([0, 6.5, 0])).toBe(false); expect(terrain.queries.isSolid(point)).toBe(true);
  } finally { terrain.dispose(); }
}, 60000);

it('rejects a recut if its moving parent advances before the atomic commit', async () => {
  const fixture = structuralFixture(), physics = await StructuralPhysics.create(fixture.planetCenter), gate = new GeometryGate();
  const terrain = new ResidentTerrain(fixture, gate.pages, physics, new FakeTerrainHost());
  try {
    await terrain.initialize(); for (const cut of fixture.cuts) await terrain.cut(cut);
    const epoch = terrain.epoch, queries = terrain.queries, body = physics.bodies.get(1)!.body, fields = terrain.arrangement.fields.length;
    let release!: () => void, entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; });
    gate.gate = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
    const pending = terrain.cut({ id: 'stale-recut', center: [0, 6.5, 0], radius: 2.25 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'stale' }); await entering; terrain.step(); release(); await rejected;
    expect(terrain.epoch).toBe(epoch); expect(terrain.queries).toBe(queries); expect(physics.bodies.get(1)!.body).toBe(body); expect(terrain.arrangement.fields).toHaveLength(fields);
  } finally { terrain.dispose(); }
}, 60000);

const tank = (position: V3): TankState => ({ id: 0, position, rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: .75, power: .5, health: 100, charge: 1, movement: 7, recoil: 0,
  suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [0, 0], yawVelocity: 0,
  wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-.5), loadout: { ...DEFAULT_LOADOUT } });

it.each([-.5, .3, .5])('holds lateral grip on a %s-radian cross-slope and brakes sideways slip without pinning an airborne tank', async (angle) => {
  const physics = await StructuralPhysics.create([0, -10000, 0]), normal: V3 = [-Math.sin(angle), Math.cos(angle), 0], q = rotation(normal, 0);
  try {
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(30, .1, 30).setTranslation(...normal.map(v => -.1 * v) as V3).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }).setFriction(0));
    const t = tank(normal.map(v => v * .5) as V3); t.rotation = q;
    const bridge = new ResidentTanks(physics), step = () => { bridge.beforeStep([t], [{ throttle: 0, steer: 0 }], 1 / 60); physics.step(); bridge.afterStep([t], 1 / 60); };
    for (let i = 0; i < 120; i++) step();
    const position = [...t.position] as V3;
    for (let i = 0; i < 600; i++) step();
    const lateral = normalize(cross(normal, [0, 0, 1]));
    expect(Math.abs(dot(sub(t.position, position), lateral))).toBeLessThan(.02);
    expect(Math.abs(dot(t.velocity, lateral))).toBeLessThan(.003);
    t.velocity = add(t.velocity, lateral.map(v => v * .75) as V3);
    for (let i = 0; i < 60; i++) step(); expect(Math.abs(dot(t.velocity, lateral))).toBeLessThan(.08);
    // A jump receives no artificial in-air lateral lock.
    t.velocity = add(lateral.map(v => v * 2) as V3, normal.map(v => v * 6) as V3);
    for (let i = 0; i < 12; i++) step(); expect(Math.abs(dot(t.velocity, lateral))).toBeGreaterThan(1);
  } finally { physics.dispose(); }
});

it('holds at rest on uneven triangle terrain without uphill creep', async () => {
  const physics = await StructuralPhysics.create([0, -10000, 0]), positions: number[] = [], indices: number[] = [];
  for (let z = 0; z <= 40; z++) for (let x = 0; x <= 40; x++) { const px = (x - 20) * .5, pz = (z - 20) * .5; positions.push(px, px * .28 + .06 * Math.sin(px * 3) * Math.cos(pz * 2), pz); }
  for (let z = 0; z < 40; z++) for (let x = 0; x < 40; x++) { const a = z * 41 + x; indices.push(a, a + 41, a + 1, a + 1, a + 41, a + 42); }
  try {
    physics.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)).setFriction(0));
    const t = tank([0, .6, 0]); t.rotation = rotation(normalize([-.28, 1, 0]), 0);
    const bridge = new ResidentTanks(physics), step = () => { bridge.beforeStep([t], [{ throttle: 0, steer: 0 }], 1 / 60); physics.step(); bridge.afterStep([t], 1 / 60); };
    for (let i = 0; i < 180; i++) step(); const position = [...t.position] as V3;
    for (let i = 0; i < 1200; i++) step();
    expect(Math.hypot(...sub(t.position, position))).toBeLessThan(.04);
    expect(Math.hypot(...t.velocity)).toBeLessThan(.01);
  } finally { physics.dispose(); }
});

it('solver chassis settles, rides a moving platform and sends equal/opposite track impulses', async () => {
  const physics = await StructuralPhysics.create([0, -1000, 0]);
  try {
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(30, .1, 30).setTranslation(0, -.1, 0).setFriction(0));
    const platform = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, .3, 0));
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(4, .3, 4).setDensity(1).setFriction(0), platform); physics.actors.add(platform);
    const t = tank([0, 1.13, 0]), bridge = new ResidentTanks(physics);
    const step = (throttle = 0) => { bridge.beforeStep([t], [{ throttle, steer: 0 }], 1 / 60); physics.step(); bridge.afterStep([t], 1 / 60); };
    for (let i = 0; i < 180; i++) step();
    expect(t.position[1]).toBeGreaterThan(1.03); expect(t.position[1]).toBeLessThan(1.2); expect(Math.hypot(...t.velocity)).toBeLessThan(.15);
    platform.setLinvel({ x: 1, y: 0, z: 0 }, true);
    for (let i = 0; i < 180; i++) step();
    expect(t.position[0]).toBeGreaterThan(.4); expect(Math.abs(t.position[0] - platform.translation().x)).toBeLessThan(1.3);
    const before = platform.translation().z;
    for (let i = 0; i < 60; i++) step(.5);
    expect(t.position[2]).toBeGreaterThan(.2); expect(platform.translation().z).toBeLessThan(before - .02);
    // Gameplay recoil/blast velocity changes survive the solver synchronization.
    const v = t.velocity[1]; t.velocity[1] += 2; step(); expect(t.velocity[1]).toBeGreaterThan(v + 1);
  } finally { physics.dispose(); }
}, 60000);

it.each(['resident-f32-game-v1', 'resident-f32-game-v2'] as const)('recuts and replays a moving slab with inherited momentum in %s', async (profile) => {
  const fixture = structuralFixture(), physics = await StructuralPhysics.create(fixture.planetCenter);
  fixture.staticSurface = true; fixture.localConstruction = true; fixture.uniformRegions = profile === 'resident-f32-game-v2';
  const terrain = new ResidentTerrain(fixture, new GeometryGate().pages, physics, new FakeTerrainHost());
  try {
    await terrain.initialize(); for (const cut of fixture.cuts) await terrain.cut(cut);
    const parent = physics.bodies.get(1)!, oldVolume = parent.candidate.regions.reduce((v, r) => v + r.volume, 0);
    const rotation: [number, number, number, number] = [0, 0, Math.sin(.2), Math.cos(.2)];
    parent.body.setTranslation({ x: 0, y: 14, z: 0 }, true); parent.body.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, true);
    parent.body.setLinvel({ x: 2, y: -1, z: .5 }, true); parent.body.setAngvel({ x: .2, y: .3, z: .4 }, true);
    const com = parent.body.worldCom(), oldCom: V3 = [com.x, com.y, com.z];
    const center = add([0, 14, 0], rotate(sub([0, 6.5, 0], parent.candidate.center), rotation));
    const cut = { id: 'moving-slab-cut', center, radius: 2.25 }, accepted = await terrain.cut(cut);
    expect(physics.bodies.has(1)).toBe(false); expect(physics.bodies.size).toBe(2); expect(accepted!.ledger.removed).toBeGreaterThan(0);
    const remaining = [...physics.bodies.values()].reduce((v, b) => v + b.candidate.regions.reduce((s, r) => s + r.volume, 0), 0);
    expect(Math.abs(oldVolume - remaining - accepted!.ledger.removed)).toBeLessThan(1e-3);
    for (const { body } of physics.bodies.values()) {
      const p = body.worldCom(), expected = add([2, -1, .5], cross([.2, .3, .4], sub([p.x, p.y, p.z], oldCom))), velocity = body.linvel();
      expect([velocity.x, velocity.y, velocity.z]).toEqual(expect.arrayContaining(expected.map(v => expect.closeTo(v, 4))));
    }
    expect(terrain.queries.isSolid(center)).toBe(false); expect(await terrain.cut(cut)).toBeNull();
    await terrain.rebuild(); expect(physics.bodies.size).toBe(2); expect(terrain.queries.fixed.isSolid([0, 6.5, 0])).toBe(false);
    for (let i = 0; i < 15; i++) terrain.step();
    const checkpoint = validateResidentCheckpoint({ format: 'tmt-resident-terrain', schemaVersion: 1, profile, generator: PLANET_GENERATOR,
      seed: 7, revision: terrain.epoch, structures: [], edits: residentReplay(terrain), tick: physics.tick, bodies: physics.motions(), chassis: [] });
    const restoredPhysics = await StructuralPhysics.create(fixture.planetCenter), restored = new ResidentTerrain(fixture, new GeometryGate().pages, restoredPhysics, new FakeTerrainHost());
    try {
      await replayResident(restored, checkpoint.edits, checkpoint.bodies, checkpoint.tick);
      const original = physics.motions(), roundtrip = restoredPhysics.motions();
      // Rapier normalizes a supplied f32 quaternion on restoration.
      expect(roundtrip).toEqual(original.map(m => ({ ...m, rotation: m.rotation.map(v => expect.closeTo(v, 6)) })));
      expect(restored.masks).toEqual(terrain.masks);
      expect([...restored.ownership]).toEqual([...terrain.ownership]); expect(restored.epoch).toBe(terrain.epoch);
      expect(restored.queries.fixed.isSolid([0, 6.5, 0])).toBe(false);
      physics.step(); restoredPhysics.step();
      const expected = physics.motions(), actual = restoredPhysics.motions();
      for (let i = 0; i < actual.length; i++) for (let axis = 0; axis < 3; axis++) expect(actual[i].position[axis]).toBeCloseTo(expected[i].position[axis], 4);
      expect(() => validateResidentCheckpoint({ ...checkpoint, bodies: [{ ...checkpoint.bodies[0], rotation: [0, 0, 0, 0] }] })).toThrow(/pose/);
    } finally { restored.dispose(); }
  } finally { terrain.dispose(); }
}, 60000);
