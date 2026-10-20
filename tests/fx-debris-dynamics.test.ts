import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { DebrisDynamics, type RigidShard } from '../src/game/presentation/debris-dynamics';
import { DEBRIS_STRIDE, DebrisHost, type DebrisCommand, type DebrisFrame, type DebrisTerrain, type DebrisWaterEntry } from '../src/game/presentation/debris-host';
import { rotate, add, mul, normalize, sub, length, dot } from '../src/game/math';
import { tankHullBoxes } from '../src/game/tank-collision';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { ResidentGameTerrain } from '../src/game/resident-terrain';
import type { DebrisBody, DebrisWater } from '../src/game/presentation/debris-physics';
import type { Q4, TankState, V3, WorldQuery } from '../src/game/contracts';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { bumpyPlanet } from './helpers/bumpy-planet';

beforeAll(async () => { await RAPIER.init(); });
const ground: WorldQuery = { radius: 18, version: 1, surface: () => null, raycast: () => null, isSolid: p => p[1] < 18,
  * visibilityTriangles() {
    yield { a: [-12, 18, -12], b: [12, 18, 12], c: [12, 18, -12], normal: [0, 1, 0], material: 1 };
    yield { a: [-12, 18, -12], b: [-12, 18, 12], c: [12, 18, 12], normal: [0, 1, 0], material: 1 };
  } };
function shard(): RigidShard {
  const positions = new Float32Array(Array.from({ length: 8 }, (_, i) => [i & 1 ? .4 : -.4, i & 2 ? .06 : -.06, i & 4 ? .3 : -.3]).flat());
  return { body: { position: [0, 19, 0], velocity: [0, -1, 0], radius: .5, age: 0, bounces: 0, sleeping: false, density: 2.5 },
    positions, rotation: [0, 0, Math.sin(.3), Math.cos(.3)], angularVelocity: [.3, .2, .5] };
}
describe('convex terrain shards', () => {
  it('uses the mesh hull volume and settles flat without sphere clearance', () => {
    const sim = new DebrisDynamics(), s = shard();
    try {
      sim.add(s); sim.syncScene(ground, []);
      let volume = 0; sim.world.forEachCollider(c => { if (c.parent()) volume += c.volume(); });
      expect(volume).toBeCloseTo(.8 * .12 * .6, 5);
      for (let i = 0; i < 600; i++) sim.step([s]);
      const ys = Array.from({ length: 8 }, (_, i) => add(s.body.position, rotate(Array.from(s.positions.slice(i * 3, i * 3 + 3)) as V3, s.rotation))[1]);
      expect(Math.min(...ys)).toBeGreaterThan(17.97); expect(Math.min(...ys)).toBeLessThan(18.03);
      expect(s.body.position[1]).toBeLessThan(18.15);
      expect(s.body.sleeping).toBe(true);
    } finally { sim.dispose(); }
  });
  it('a moving tank wakes and pushes a sleeping convex shard', () => {
    const sim = new DebrisDynamics(), s = shard();
    const tank = { id: 0, position: [-2, 18.55, 0], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: 0,
      suspension: [], loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' } } as unknown as TankState;
    try {
      sim.add(s); sim.syncScene(ground, []);
      for (let i = 0; i < 360; i++) sim.step([s]);
      const x = s.body.position[0];
      for (let i = 0; i < 100; i++) {
        tank.position[0] = -2 + i * .025;
        sim.syncScene(ground, [tank]); sim.step([s]);
      }
      expect(s.body.position[0] - x).toBeGreaterThan(.4);
      expect(Math.hypot(...s.body.velocity)).toBeGreaterThan(.1);
    } finally { sim.dispose(); }
  });
  it('water buoyancy survives rigid-body integration and dense shards sink', () => {
    const sim = new DebrisDynamics(), ice = shard(), stone = shard();
    ice.body.position = [0, 18, 0]; stone.body.position = [2, 18, 0]; ice.body.velocity = stone.body.velocity = [0, 0, 0];
    ice.body.density = .92;
    ice.water = stone.water = { water: 4, surface: 18.5, velocity: [.1, 0, 0] };
    try {
      sim.add(ice); sim.add(stone);
      for (let i = 0; i < 600; i++) sim.step([ice, stone]);
      expect(Math.hypot(...ice.body.position)).toBeGreaterThan(18.1);
      expect(Math.hypot(...stone.body.position)).toBeLessThan(17);
    } finally { sim.dispose(); }
  });
});

/** The 29baad2 debris world, kept verbatim as the oracle for the allocation-free one. */
class ReferenceDynamics {
  readonly world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  private shards = new Map<DebrisBody, RAPIER.RigidBody>();
  private tanks = new Map<number, { body: RAPIER.RigidBody; colliders: RAPIER.Collider[]; key: string }>();
  private supports = new Map<number, { body: RAPIER.RigidBody; shapes: unknown }>();
  private terrain?: RAPIER.Collider;
  private terrainVersion = -1;
  constructor() { this.world.timestep = 1 / 60; this.world.integrationParameters.numSolverIterations = 8; this.world.integrationParameters.maxCcdSubsteps = 4; }
  static span(s: RigidShard): [number, number] {
    const up = normalize(s.body.position), radius = length(s.body.position);
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < s.positions.length; i += 3) {
      const height = radius + dot(rotate([s.positions[i], s.positions[i + 1], s.positions[i + 2]], s.rotation), up);
      low = Math.min(low, height); high = Math.max(high, height);
    }
    return [low, high];
  }
  static buoy(b: DebrisBody, water: DebrisWater, dt: number): void {
    if (!(water.water > 0.005) || !(water.surface > 0)) return;
    const h = Math.max(0, Math.min(2, (water.surface - length(b.position) + b.radius) / b.radius));
    const fraction = water.submergedFraction ?? h * h * (3 - h) / 4;
    if (!fraction) return;
    const density = b.density ?? 2.5;
    if (density < 1 || !b.sleeping) {
      b.sleeping = false;
      b.velocity = add(b.velocity, mul(normalize(b.position), 9.8 * fraction / density * dt));
      const flow = water.velocity ?? [0, 0, 0];
      b.velocity = add(flow, mul(sub(b.velocity, flow), 1 / (1 + dt * fraction * (3 + length(sub(b.velocity, flow))) / density)));
    }
  }
  add(s: RigidShard): void {
    const v = (p: V3) => ({ x: p[0], y: p[1], z: p[2] }), q = (p: Q4) => ({ x: p[0], y: p[1], z: p[2], w: p[3] });
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...s.body.position).setRotation(q(s.rotation))
      .setLinvel(...s.body.velocity).setAngvel(v(s.angularVelocity)).setCcdEnabled(true).setLinearDamping(0.12).setAngularDamping(0.5));
    this.world.createCollider(RAPIER.ColliderDesc.convexHull(s.positions)!.setDensity(s.body.density ?? 2.5).setFriction(0.8).setRestitution(0.25), rb);
    this.shards.set(s.body, rb);
  }
  remove(b: DebrisBody): void { const rb = this.shards.get(b); if (rb) this.world.removeRigidBody(rb); this.shards.delete(b); }
  kick(b: DebrisBody): void { this.shards.get(b)?.setLinvel({ x: b.velocity[0], y: b.velocity[1], z: b.velocity[2] }, true); }
  syncScene(query: WorldQuery, tanks: readonly TankState[]): void {
    const v = (p: V3) => ({ x: p[0], y: p[1], z: p[2] }), q = (p: Q4) => ({ x: p[0], y: p[1], z: p[2], w: p[3] }), fixed = query.footprintSurface ?? query;
    if (fixed.version !== this.terrainVersion && fixed.visibilityTriangles) {
      const positions: number[] = [];
      for (const t of fixed.visibilityTriangles()) positions.push(...t.a, ...t.b, ...t.c);
      if (this.terrain) this.world.removeCollider(this.terrain, true);
      this.terrain = positions.length ? this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions),
        Uint32Array.from({ length: positions.length / 3 }, (_, i) => i), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.85).setRestitution(0.18)) : undefined;
      this.terrainVersion = fixed.version;
    }
    const live = new Set<number>();
    for (const t of tanks) {
      live.add(t.id);
      let entry = this.tanks.get(t.id);
      const key = JSON.stringify(t.loadout);
      if (entry && entry.key !== key) { this.world.removeRigidBody(entry.body); this.tanks.delete(t.id); entry = undefined; }
      const shapes = tankHullBoxes(t.loadout, { turretYaw: t.turretYaw, barrelPitch: t.barrelPitch, wheelSuspension: t.suspension });
      if (!entry) {
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...t.position).setRotation(q(t.rotation)));
        entry = { body, key, colliders: shapes.map(s => this.world.createCollider(RAPIER.ColliderDesc.cuboid(...s.half).setTranslation(...s.center)
          .setRotation(q(s.rotation ?? [0, 0, 0, 1])).setFriction(0.7).setRestitution(0.3), body)) };
        this.tanks.set(t.id, entry);
      }
      shapes.forEach((s, i) => { entry!.colliders[i].setTranslationWrtParent(v(s.center)); entry!.colliders[i].setRotationWrtParent(q(s.rotation ?? [0, 0, 0, 1])); });
      entry.body.setNextKinematicTranslation(v(t.position)); entry.body.setNextKinematicRotation(q(t.rotation));
    }
    for (const [id, t] of this.tanks) if (!live.has(id)) { this.world.removeRigidBody(t.body); this.tanks.delete(id); }
    const supportIds = new Set<number>();
    for (const s of query.collisionBodies?.() ?? []) {
      supportIds.add(s.id);
      let entry = this.supports.get(s.id);
      if (entry && entry.shapes !== s.shapes) { this.world.removeRigidBody(entry.body); this.supports.delete(s.id); entry = undefined; }
      if (!entry) {
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...s.position).setRotation(q(s.rotation)));
        for (const c of s.shapes) { const shape = RAPIER.ColliderDesc.convexHull(c.vertices); if (shape) this.world.createCollider(shape.setTranslation(...(c.offset ?? [0, 0, 0])).setFriction(0.8).setRestitution(0.2), body); }
        entry = { body, shapes: s.shapes }; this.supports.set(s.id, entry);
      }
      entry.body.setNextKinematicTranslation(v(s.position)); entry.body.setNextKinematicRotation(q(s.rotation));
    }
    for (const [id, s] of this.supports) if (!supportIds.has(id)) { this.world.removeRigidBody(s.body); this.supports.delete(id); }
  }
  step(shards: RigidShard[]): void {
    const v = (p: V3) => ({ x: p[0], y: p[1], z: p[2] }), expected = new Map<DebrisBody, V3>();
    for (const s of shards) {
      const rb = this.shards.get(s.body); if (!rb) continue;
      const b = s.body; b.age += 1 / 60; b.impactSpeed = 0;
      rb.resetForces(false);
      const before: V3 = [...b.velocity], wasSleeping = b.sleeping;
      if (s.water) {
        const [low, high] = ReferenceDynamics.span(s);
        ReferenceDynamics.buoy(b, { ...s.water, submergedFraction: Math.max(0, Math.min(1, (s.water.surface - low) / Math.max(1e-5, high - low))) }, 1 / 60);
      }
      const accel = add(mul(normalize(b.position), -9.8), mul(sub(b.velocity, before), 60));
      expected.set(b, add(before, mul(accel, 1 / 60)));
      if (wasSleeping && !b.sleeping) rb.wakeUp();
      rb.addForce(v(mul(accel, rb.mass())), false);
      rb.setAngularDamping(s.water && s.water.surface > length(b.position) ? 2 : 0.5);
    }
    this.world.step();
    for (const s of shards) {
      const rb = this.shards.get(s.body); if (!rb) continue;
      const p = rb.translation(), r = rb.rotation(), vel = rb.linvel(), spin = rb.angvel();
      s.body.position = [p.x, p.y, p.z]; s.body.velocity = [vel.x, vel.y, vel.z]; s.body.sleeping = rb.isSleeping();
      s.body.impactSpeed = length(sub(s.body.velocity, expected.get(s.body)!));
      s.rotation = [r.x, r.y, r.z, r.w]; s.angularVelocity = [spin.x, spin.y, spin.z];
    }
  }
  dispose(): void { this.world.free(); }
}
type Sim = Pick<DebrisDynamics, 'add' | 'remove' | 'kick' | 'syncScene' | 'step' | 'dispose'> & { flush?(): void };
/** Shards dropped on radial ground, two tanks (parked, then driving, re-aimed and re-armed), two structures (one
 * settling, one rebuilt), rising water over light and dense shards, kicks, removals and a terrain commit, at 0-2
 * steps per frame. Returns every shard's full state after every step (perFrame: after every frame). */
function scenario(sim: Sim, perFrame = false): number[][] {
  let version = 1, supportY = 1.5;
  const up = (x: number, z: number, h: number): V3 => { const l = Math.hypot(x, 18 + h, z); return [x / l * (18 + h), (18 + h) / l * (18 + h), z / l * (18 + h)]; };
  const box = new Float32Array([-.4, -.4, -.4, .4, -.4, -.4, -.4, .4, -.4, .4, .4, -.4, -.4, -.4, .4, .4, -.4, .4, -.4, .4, .4, .4, .4, .4]);
  const fixed = [{ vertices: box, indices: new Uint32Array() }];
  let rebuilt = fixed;
  const world: WorldQuery = { ...ground, get version() { return version; }, visibilityTriangles: ground.visibilityTriangles, collisionBodies: () => [
    { id: 7, position: up(1, 1.2, .4), rotation: [0, 0, 0, 1] as Q4, shapes: fixed },
    { id: 8, position: up(-1, 2, supportY), rotation: [0, Math.sin(supportY), 0, Math.cos(supportY)] as Q4, shapes: rebuilt }] };
  const tank = (id: number, x: number) => ({ id, position: up(x, 0, .55), rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: 0, suspension: [.5, .5, .5, .5, .5, .5, .5, .5],
    loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' } } as unknown as TankState);
  const tanks = [tank(0, -2.6), tank(1, 3)];
  const shards = Array.from({ length: 32 }, (_, i): RigidShard => ({
    body: { position: up((i % 8) * .45 - 1.6, Math.floor(i / 8) * .45 - 1, .5 + (i % 3) * .3), velocity: [(i % 5) - 2, -1, (i % 3) - 1], radius: .3, age: 0, bounces: 0, sleeping: false, density: i % 4 ? 2.2 : .92 },
    positions: new Float32Array(Array.from({ length: 8 }, (_, k) => [k & 1 ? .25 : -.25, k & 2 ? .05 : -.05, k & 4 ? .2 : -.2]).flat()),
    rotation: [0, Math.sin(i * .3), 0, Math.cos(i * .3)], angularVelocity: [(i % 7) - 3, 1, -(i % 5)] }));
  for (const s of shards) sim.add(s);
  const trace: number[][] = [];
  for (let frame = 0; frame < 900; frame++) {
    if (frame === 100) tanks[1].turretYaw = .7;
    if (frame > 150 && frame < 400) tanks[1].position = up(3 - (frame - 150) * .02, 0, .55);
    if (frame === 420) tanks[1].loadout = { tracks: 'grip', barrel: 'mortar', armor: 'heavy' };
    if (frame === 500) tanks[0].loadout = { ...tanks[0].loadout };
    if (frame > 200 && frame < 320) supportY = Math.max(.4, supportY - .01);
    if (frame === 600) rebuilt = [...fixed];
    if (frame === 450) version = 2;
    if (frame >= 300) shards.forEach((s, i) => { s.water = s.body.position[0] > 0 ? { surface: 17.9 + Math.min(1, (frame - 300) / 300), water: 2, velocity: [.05, 0, 0] } : i % 2 ? { surface: 0, water: 0 } : undefined; });
    if (frame === 700) for (const s of shards.slice(0, 8)) { s.body.velocity = [s.body.velocity[0], s.body.velocity[1] + 4, s.body.velocity[2]]; s.body.sleeping = false; sim.kick(s.body); }
    if (frame === 760) for (const s of shards.splice(24, 4)) sim.remove(s.body);
    sim.syncScene(world, tanks);
    for (let k = frame % 7 === 3 ? 0 : frame % 11 === 5 ? 2 : 1; k > 0; k--) {
      sim.step(shards);
      if (!perFrame) trace.push(shards.flatMap(s => [...s.body.position, ...s.body.velocity, ...s.rotation, ...s.angularVelocity, s.body.sleeping ? 1 : 0, s.body.impactSpeed ?? -1, s.body.age]));
    }
    sim.flush?.();
    if (perFrame) trace.push(shards.flatMap(s => [...s.body.position, ...s.body.velocity, ...s.rotation, ...s.angularVelocity, s.body.sleeping ? 1 : 0, s.body.impactSpeed ?? -1, s.body.age]));
  }
  sim.dispose();
  return trace;
}
/** Shards dropped onto a still slab, a parked tank and the ground and left to settle while neither mirror moves (their
 * kinematic targets repeat), then the slab sinks under its sleepers and the terrain is recommitted. */
function resting(sim: Sim): number[][] {
  let version = 1, slabY = .4;
  const slab = new Float32Array([-2, -.2, -2, 2, -.2, -2, -2, .2, -2, 2, .2, -2, -2, -.2, 2, 2, -.2, 2, -2, .2, 2, 2, .2, 2]), shapes = [{ vertices: slab, indices: new Uint32Array() }];
  const world: WorldQuery = { ...ground, get version() { return version; }, collisionBodies: () => [{ id: 3, position: [0, 18 + slabY, 0] as V3, rotation: [0, 0, 0, 1] as Q4, shapes }] };
  const tank = { id: 0, position: [4.5, 18.55, 0], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: 0, suspension: [.5, .5, .5, .5],
    loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' } } as unknown as TankState;
  const spots: V3[] = [...Array.from({ length: 9 }, (_, i): V3 => [(i % 3 - 1) * 1.1, 19.3 + (i % 2) * .2, (Math.floor(i / 3) - 1) * 1.1]),
    [4.3, 19.8, -.3], [4.7, 20.1, .3], [4.5, 20.4, 0], [-4.5, 18.5, 0], [-5, 18.7, 1], [-4, 18.9, -1]];
  const shards = spots.map((position, i): RigidShard => ({ body: { position, velocity: [0, -.5, 0], radius: .3, age: 0, bounces: 0, sleeping: false, density: 2.2 },
    positions: new Float32Array(Array.from({ length: 8 }, (_, k) => [k & 1 ? .25 : -.25, k & 2 ? .05 : -.05, k & 4 ? .2 : -.2]).flat()),
    rotation: [0, Math.sin(i * .4), 0, Math.cos(i * .4)], angularVelocity: [0, (i % 3) - 1, 0] }));
  for (const s of shards) sim.add(s);
  const trace: number[][] = [];
  for (let frame = 0; frame < 900; frame++) {
    if (frame >= 520 && frame < 600) slabY -= .002;
    if (frame === 700) version = 2;
    sim.syncScene(world, [tank]);
    sim.step(shards); sim.flush?.();
    trace.push(shards.flatMap(s => [...s.body.position, ...s.body.velocity, ...s.rotation, ...s.angularVelocity, s.body.sleeping ? 1 : 0, s.body.impactSpeed ?? -1, s.body.age]));
  }
  sim.dispose();
  return trace;
}
const same = (expected: number[][], actual: number[][]) => {
  expect(actual.length).toBe(expected.length);
  expected.forEach((row, step) => { for (let i = 0; i < row.length; i++) if (!Object.is(row[i], actual[step][i])) throw new Error(`step ${step} value ${i}: ${actual[step][i]} instead of ${row[i]}`); });
};
describe('allocation-free debris world', () => {
  it('reproduces the reference debris world bit for bit, sleepers, mirrors and water included', () => {
    const expected = scenario(new ReferenceDynamics()), actual = scenario(new DebrisDynamics());
    same(expected, actual);
    // Sixteen values per shard; the fourteenth is its sleep flag: the parked path ran.
    expect(expected.at(-1)!.filter((_, i) => i % 16 === 13).some(v => v === 1)).toBe(true);
  }, 60000);
  it('reproduces it for shards asleep on a still structure and against a parked tank, until the structure sinks', () => {
    const expected = resting(new ReferenceDynamics()), actual = resting(new DebrisDynamics());
    same(expected, actual);
    const asleep = (frame: number, from: number, to: number) => expected[frame].filter((_, i) => i % 16 === 13).slice(from, to).filter(v => v === 1).length;
    // The slab's shards sleep on it while its target repeats, and its sinking wakes them.
    expect(asleep(519, 0, 9)).toBeGreaterThanOrEqual(6);
    expect(asleep(560, 0, 9)).toBe(0);
  }, 60000);
});

/** Flat square tiles at height 18, one collision page each, n x n triangles pairs per tile. */
function tiles(ids: string[], size = 4, n = 4) {
  return new Map(ids.map((id, t) => {
    const x0 = (t - ids.length / 2) * size, positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.push(x0 + i * size / n, 18, -size / 2 + j * size / n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const a = i * (n + 1) + j, b = a + n + 1; indices.push(a, a + 1, b + 1, a, b + 1, b); }
    return [id, { mesh: { positions: new Float32Array(positions), indices: new Uint32Array(indices) } }];
  }));
}
const paged = (pages: () => ReturnType<typeof tiles>, version: () => number): WorldQuery =>
  ({ radius: 18, get version() { return version(); }, surface: () => null, raycast: () => null, isSolid: p => p[1] < 18, fixedChunks: pages });
const terrainColliders = (sim: DebrisDynamics) => { const out: RAPIER.Collider[] = []; sim.world.forEachCollider(c => { if (!c.parent()) out.push(c); }); return out; };
describe('terrain pages', () => {
  it('cooks only the pages a commit replaced, and drops vanished ones', () => {
    let pages = tiles(['a', 'b', 'c']), version = 1;
    const sim = new DebrisDynamics(), world = paged(() => pages, () => version);
    try {
      expect(sim.syncTerrain(world)).toBe(true);
      const before = new Map(terrainColliders(sim).map(c => [c.handle, c]));
      expect(before.size).toBe(3);
      const next = tiles(['b', 'c', 'd']);
      pages = new Map([['b', pages.get('b')!], ['c', next.get('c')!], ['d', next.get('d')!]]); version = 2;
      sim.syncTerrain(world);
      const after = terrainColliders(sim), kept = after.filter(c => before.has(c.handle));
      expect(after.length).toBe(3);
      expect(kept.length).toBe(1);
      expect(sim.syncTerrain(world)).toBe(true);
    } finally { sim.dispose(); }
  });
  it('spreads the cook over budgeted calls and finishes it', () => {
    const pages = tiles(Array.from({ length: 12 }, (_, i) => `p${i}`), 4, 24), sim = new DebrisDynamics(), world = paged(() => pages, () => 1);
    try {
      let calls = 0;
      while (!sim.syncTerrain(world, 1e-6)) { calls++; expect(terrainColliders(sim).length).toBe(calls); }
      expect(calls).toBe(11);
      expect(terrainColliders(sim).length).toBe(12);
    } finally { sim.dispose(); }
  });
  it('skips zero-area triangles like the whole-surface walk did', () => {
    const flat = { positions: new Float32Array([0, 18, 0, 1, 18, 0, 2, 18, 0]), indices: new Uint32Array([0, 1, 2]) };
    const sim = new DebrisDynamics();
    try {
      sim.syncTerrain(paged(() => new Map([['line', { mesh: flat }], ...tiles(['a'])]), () => 1));
      expect(terrainColliders(sim).length).toBe(1);
    } finally { sim.dispose(); }
  });
  it('wakes the shards resting on a replaced page and lets the others sleep on', () => {
    let pages = tiles(['a', 'b'], 6), version = 1;
    const sim = new DebrisDynamics(), world = paged(() => pages, () => version), [onA, onB] = [shard(), shard()];
    onA.body.position = [-3, 18.3, 0]; onB.body.position = [3, 18.3, 0];
    try {
      sim.add(onA); sim.add(onB); sim.syncScene(world, []);
      for (let i = 0; i < 300; i++) sim.step([onA, onB]);
      expect(onA.body.sleeping && onB.body.sleeping).toBe(true);
      pages = new Map([['a', tiles(['a', 'b'], 6).get('a')!], ['b', pages.get('b')!]]); version = 2;
      sim.syncScene(world, []); sim.step([onA, onB]);
      expect(onA.body.sleeping).toBe(false);
      expect(onB.body.sleeping).toBe(true);
    } finally { sim.dispose(); }
  });
  it('the resident terrain lends its query pages, and a cut replaces only the pages it touched', async () => {
    const fixture = structuralFixture(), resident = new ResidentTerrain(fixture, new GeometryGate().pages, await StructuralPhysics.create(fixture.planetCenter), new FakeTerrainHost());
    const game = ResidentGameTerrain.adopt(resident, 7), sim = new DebrisDynamics();
    try {
      await game.initialize();
      const surface = game.footprintSurface!, before = surface.fixedChunks!();
      expect(before).toBe(resident.queries.fixed.chunks);
      sim.syncTerrain(game);
      const handles = new Map(terrainColliders(sim).map(c => [c.handle, c]));
      expect(handles.size).toBe(before.size);
      await game.carve([...fixture.cuts[0].center] as V3, fixture.cuts[0].radius);
      const after = surface.fixedChunks!(), changed = [...after].filter(([id, page]) => before.get(id) !== page).length;
      expect(changed).toBeGreaterThan(0); expect(changed).toBeLessThan(after.size);
      sim.syncTerrain(game);
      const now = terrainColliders(sim);
      expect(now.length).toBe(after.size);
      expect(now.filter(c => handles.has(c.handle)).length).toBe(after.size - changed);
    } finally { sim.dispose(); game.dispose(); }
  }, 60000);
});

describe('brick seams', () => {
  it('per-page colliders let shards slide across seams like the whole surface: no tunnelling, no snagging, the same rest', () => {
    const planet = bumpyPlanet(3);
    const run = (world: WorldQuery) => {
      let seed = 5;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const sim = new DebrisDynamics(), shards: RigidShard[] = [];
      for (let i = 0; i < 160; i++) {
        const d: V3 = [(random() - .5) * .6, 1, (random() - .5) * .6], l = Math.hypot(...d), up = d.map(v => v / l) as V3, ground = planet.collision.surface(up)!.point;
        const east = normalize([up[1], -up[0], 0]), north = normalize([up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]]);
        const angle = random() * Math.PI * 2, speed = 2 + random() * 5, sx = .1 + random() * .25, sy = .03 + random() * .07, sz = .1 + random() * .2;
        shards.push({ body: { position: add(ground, mul(up, .3 + random() * .4)), velocity: add(mul(east, Math.cos(angle) * speed), add(mul(north, Math.sin(angle) * speed), mul(up, -1))),
          radius: Math.max(sx, sz), age: 0, bounces: 0, sleeping: false, density: 2.2 },
          positions: new Float32Array(Array.from({ length: 8 }, (_, k) => [k & 1 ? sx : -sx, k & 2 ? sy : -sy, k & 4 ? sz : -sz]).flat()),
          rotation: [0, Math.sin(angle), 0, Math.cos(angle)], angularVelocity: [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1] });
      }
      const start = shards.map(s => [...s.body.position] as V3);
      for (const s of shards) sim.add(s);
      sim.syncScene(world, []);
      let inside = 0;
      for (let i = 1; i <= 420; i++) { sim.step(shards); if (i % 60 === 0) inside += shards.filter(s => planet.collision.isSolid(s.body.position)).length; }
      // Height of each resting shard's lowest corner above the surface straight below it.
      const rest = shards.map(s => Math.min(...Array.from({ length: 8 }, (_, k) => {
        const p = add(s.body.position, rotate(Array.from(s.positions.slice(k * 3, k * 3 + 3)) as V3, s.rotation)), up = normalize(p);
        return planet.collision.raycast(add(p, mul(up, .3)), mul(up, -1), 1.3)?.distance ?? 1.3;
      })) - .3);
      const travel = shards.map((s, i) => length(sub(s.body.position, start[i])));
      sim.dispose();
      const sorted = (v: number[]) => [...v].sort((a, b) => a - b);
      return { inside, travel: sorted(travel), rest: sorted(rest), asleep: shards.filter(s => s.body.sleeping).length };
    };
    const whole = run(planet.whole), pages = run(planet.pages), median = (v: number[]) => v[v.length >> 1], mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(planet.count).toBeGreaterThan(100);
    expect(pages.inside).toBe(0); expect(whole.inside).toBe(0);
    expect(Math.abs(mean(pages.travel) / mean(whole.travel) - 1)).toBeLessThan(.08);
    expect(Math.abs(median(pages.travel) / median(whole.travel) - 1)).toBeLessThan(.1);
    expect(pages.rest[0]).toBeGreaterThan(-.03); expect(Math.abs(median(pages.rest) - median(whole.rest))).toBeLessThan(.003);
    // Shards settle at least as readily (on a seam a shard no longer keeps a sub-degree rocking alive).
    expect(pages.asleep).toBeGreaterThanOrEqual(whole.asleep * .9);
  }, 120000);
});

/** The main thread's side of the debris channel, reduced to the Sim calls: each frame (one scene sync and its steps) is
 * one message, cloned as a worker would receive it, applied by a DebrisHost and published back into the caller's shards. */
class ChannelSim implements Sim {
  private readonly host = new DebrisHost(() => undefined);
  private readonly ids = new Map<DebrisBody, number>();
  private commands: DebrisCommand[] = [];
  private scene?: { world: WorldQuery; tanks: readonly TankState[] };
  private steps = 0; private shards: readonly RigidShard[] = [];
  private version = NaN; private readonly shapes = new Map<number, unknown>();
  add(s: RigidShard): void {
    const id = this.ids.size + 1; this.ids.set(s.body, id);
    this.commands.push(['add', { id, positions: s.positions, position: s.body.position, velocity: s.body.velocity, rotation: s.rotation, angularVelocity: s.angularVelocity,
      radius: s.body.radius, density: s.body.density ?? 2.5, generation: 0 }]);
  }
  remove(b: DebrisBody): void { this.commands.push(['remove', this.ids.get(b)!]); }
  kick(b: DebrisBody): void { this.commands.push(['kick', this.ids.get(b)!, b.velocity]); }
  syncScene(world: WorldQuery, tanks: readonly TankState[]): void { this.scene = { world, tanks }; }
  step(shards: readonly RigidShard[]): void { this.steps++; this.shards = shards; }
  flush(): void {
    const { world, tanks } = this.scene!, shards = this.shards, terrain: DebrisTerrain[] = [];
    if (world.version !== this.version) {
      this.version = world.version;
      terrain.push({ version: world.version, triangles: new Float32Array([...world.visibilityTriangles!()].flatMap(t => [...t.a, ...t.b, ...t.c])), complete: true });
    }
    const supports = (world.collisionBodies?.() ?? []).map(s => {
      const fresh = this.shapes.get(s.id) !== s.shapes; this.shapes.set(s.id, s.shapes);
      return { id: s.id, position: s.position, rotation: s.rotation, ...(fresh ? { shapes: s.shapes.map(c => ({ vertices: c.vertices })) } : {}) };
    });
    const frame: DebrisFrame = structuredClone({ frame: 0, commands: this.commands, terrain, supports, substeps: this.steps,
      water: shards.map(s => [this.ids.get(s.body)!, s.water ?? null, s.body.position] as DebrisWaterEntry),
      tanks: tanks.map(t => ({ id: t.id, position: t.position, rotation: t.rotation, turretYaw: t.turretYaw, barrelPitch: t.barrelPitch, suspension: t.suspension, loadout: t.loadout })) });
    this.commands = []; this.steps = 0;
    const state = this.host.apply(frame).state, byId = new Map(shards.map(s => [this.ids.get(s.body)!, s]));
    for (let o = 0; o < state.length; o += DEBRIS_STRIDE) {
      const s = byId.get(state[o]); if (!s) continue;
      s.body.position = [state[o + 1], state[o + 2], state[o + 3]]; s.body.velocity = [state[o + 4], state[o + 5], state[o + 6]];
      s.rotation = [state[o + 7], state[o + 8], state[o + 9], state[o + 10]]; s.angularVelocity = [state[o + 11], state[o + 12], state[o + 13]];
      s.body.sleeping = state[o + 14] === 1; s.body.impactSpeed = state[o + 15]; s.body.age = state[o + 16];
    }
  }
  dispose(): void { this.host.dispose(); }
}
describe('debris channel', () => {
  it('steps the debris world through cloned frame messages bit for bit, sleepers, mirrors and water included', () => {
    same(scenario(new DebrisDynamics(), true), scenario(new ChannelSim(), true));
  }, 60000);
  it('keeps shards asleep on a still structure through the channel', () => {
    same(resting(new DebrisDynamics()), resting(new ChannelSim()));
  }, 60000);
});
