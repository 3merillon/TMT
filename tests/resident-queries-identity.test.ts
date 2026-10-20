/** ResidentQueries with cached body bounds, scalar transforms and held poses answers exactly like the historical
 * per-query pose read and allocating transforms (kept below as the oracle), on moving structural bodies of the fixture
 * world and on collapsed towers of the seed-7 planet: same hits, sweeps, solids, surfaces and triangle lists, including
 * which body wins an equal-distance tie and where a bounded triangle query overflows. */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Q4, TerrainHit, TerrainQueryBounds, TerrainTriangleQuery, V3 } from '../src/game/contracts';
import { ResidentQueries, type ResidentQueryBody } from '../src/game/resident-queries';
import { TerrainCollision } from '../src/game/terrain-collision';
import { TriangleSoup } from '../src/game/triangle-soup';
import { TERRAIN_BOUND, TERRAIN_RADIUS } from '../src/game/terrain-config';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { structuralFixture } from '../src/gpu/terrain/fixtures';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { generatePlanetStructures } from '../src/game/terrain-structures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

// ---- oracle: src/game/resident-queries.ts before the cached bounds (93b8a7e), with its three.js math -----------------
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const rotate = (v: V3, q: Q4): V3 => new Vector3(...v).applyQuaternion(new Quaternion(...q)).toArray() as V3;
const inverse = (q: Q4): Q4 => [-q[0], -q[1], -q[2], q[3]];
class OracleQueries {
  readonly radius = TERRAIN_RADIUS;
  constructor(readonly fixed: TerrainCollision, readonly bodies: ReadonlyMap<number, ResidentQueryBody>) {}
  raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    let hit = this.fixed.raycast(origin, direction, maxDistance);
    for (const { collision, pose } of this.bodies.values()) {
      const { position, rotation } = pose(), q = inverse(rotation), candidate = collision.raycast(rotate(sub(origin, position), q), rotate(direction, q), hit?.distance ?? maxDistance);
      if (candidate) hit = { ...candidate, point: add(position, rotate(candidate.point, rotation)), normal: rotate(candidate.normal, rotation) };
    }
    return hit;
  }
  surface(direction: V3): TerrainHit | null {
    const length = Math.hypot(...direction), distance = TERRAIN_BOUND * Math.sqrt(3) + 1;
    if (!length || !Number.isFinite(length)) return null;
    return this.raycast(direction.map(v => v * distance / length) as V3, direction.map(v => -v) as V3, 2 * distance);
  }
  sweepSphere(origin: V3, direction: V3, maxDistance: number, radius: number): number | null {
    let hit = this.fixed.sweepSphere(origin, direction, maxDistance, radius);
    for (const { collision, pose } of this.bodies.values()) {
      const { position, rotation } = pose(), q = inverse(rotation);
      const candidate = collision.sweepSphere(rotate(sub(origin, position), q), rotate(direction, q), hit ?? maxDistance, radius);
      if (candidate !== null) hit = candidate;
    }
    return hit;
  }
  isSolid(point: V3): boolean {
    if (this.fixed.isSolid(point)) return true;
    for (const { collision, pose } of this.bodies.values()) { const p = pose(); if (collision.isSolid(rotate(sub(point, p.position), inverse(p.rotation)))) return true; }
    return false;
  }
  queryTriangles(bounds: TerrainQueryBounds, maxTriangles = 512): TerrainTriangleQuery {
    const result = this.fixed.queryTriangles(bounds, maxTriangles);
    for (const { collision, pose } of this.bodies.values()) {
      if (result.overflow) return result;
      const { position, rotation } = pose(), q = inverse(rotation);
      const corners = Array.from({ length: 8 }, (_, mask) => rotate(sub([0, 1, 2].map(a => mask & (1 << a) ? bounds.max[a] : bounds.min[a]) as V3, position), q));
      const local = { min: [0, 1, 2].map(a => Math.min(...corners.map(c => c[a]))) as V3, max: [0, 1, 2].map(a => Math.max(...corners.map(c => c[a]))) as V3 };
      const remaining = maxTriangles - result.triangles.length;
      const dynamic = collision.queryTriangles(local, Math.max(1, remaining));
      if (!remaining && dynamic.triangles.length) { result.overflow = true; return result; }
      result.overflow ||= dynamic.overflow;
      for (const triangle of dynamic.triangles) result.triangles.push({ ...triangle, a: add(position, rotate(triangle.a, rotation)), b: add(position, rotate(triangle.b, rotation)), c: add(position, rotate(triangle.c, rotation)), normal: rotate(triangle.normal, rotation) });
    }
    return result;
  }
}
// ---------------------------------------------------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function same(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') return Object.is(actual, expected);
  if (expected === null || actual === null) return actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => same(actual[i], v));
  if (typeof expected === 'object') { const keys = Object.keys(expected as object); return typeof actual === 'object' && same(Object.keys(actual as object), keys) && keys.every(k => same((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k])); }
  return actual === expected;
}
const unit = (rng: () => number): V3 => { const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z); return [r * Math.cos(a), z, r * Math.sin(a)]; };
const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];

/** Queries aimed at and around the bodies (both pre-reject outcomes) and at the planet at large. */
function compare(queries: ResidentQueries, oracle: OracleQueries, centers: V3[], seed: number, count = 3000): number {
  const rng = random(seed);
  const around = (): V3 => { const c = centers[Math.floor(rng() * centers.length)]; return add(c, scale(unit(rng), [0, .5, 2, 4, 9][Math.floor(rng() * 5)] * rng())); };
  const origin = (): V3 => rng() < .7 && centers.length ? around() : scale(unit(rng), 10 + rng() * 15);
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const o = origin(), target = rng() < .7 && centers.length ? around() : origin(), d = rng() < .05 ? [0, 0, 0] as V3 : rng() < .1 ? unit(rng) : sub(target, o);
    const m = [rng() * 2, rng() * 12, Math.hypot(...d), 96, 0][Math.floor(rng() * 5)];
    const want = oracle.raycast(o, d, m), got = queries.raycast(o, d, m);
    if (!same(got, want)) expect.fail(`raycast(${JSON.stringify([o, d, m])}) = ${JSON.stringify(got)}, historically ${JSON.stringify(want)}`);
    if (queries.blocked(o, d, m) !== (want !== null)) expect.fail(`blocked(${JSON.stringify([o, d, m])}) disagrees`);
    if (want) hits++;
    const r = [.28, .05, .8, 2][Math.floor(rng() * 4)], sweptWant = oracle.sweepSphere(o, d, m, r), sweptGot = queries.sweepSphere(o, d, m, r);
    if (!same(sweptGot, sweptWant)) expect.fail(`sweepSphere(${JSON.stringify([o, d, m, r])}) = ${sweptGot}, historically ${sweptWant}`);
    const p = around();
    if (queries.isSolid(p) !== oracle.isSolid(p)) expect.fail(`isSolid(${JSON.stringify(p)}) disagrees`);
    if (i % 4 === 0) { const s = unit(rng); if (!same(queries.surface(s), oracle.surface(s))) expect.fail(`surface(${JSON.stringify(s)}) disagrees`); }
    if (i % 3 === 0) {
      const center = around(), half: V3 = [rng() * 3, rng() * 3, rng() * 3], bounds = { min: sub(center, half), max: add(center, half) }, max = [512, 1, 2, 40, 2048][Math.floor(rng() * 5)];
      const triWant = oracle.queryTriangles(bounds, max), triGot = queries.queryTriangles(bounds, max);
      if (!same(triGot, triWant)) expect.fail(`queryTriangles(${JSON.stringify([bounds, max])}): ${triGot.triangles.length}/${triGot.overflow} vs ${triWant.triangles.length}/${triWant.overflow}`);
      const soup = new TriangleSoup(), overflow = queries.collect(bounds, max, soup);
      if (overflow !== triWant.overflow || !same(soup.triangles(), triWant.triangles)) expect.fail('collect() disagrees with queryTriangles()');
    }
  }
  return hits;
}
const centersOf = (terrain: ResidentTerrain): V3[] => [...terrain.physics.bodies.values()].map(({ body }) => { const p = body.translation(); return [p.x, p.y, p.z]; });

describe('ResidentQueries matches the historical per-query body transforms bit for bit', () => {
  it('on the falling and tumbling fixture slab, live and with held poses', async () => {
    const fixture = structuralFixture(), physics = await StructuralPhysics.create(fixture.planetCenter);
    fixture.staticSurface = true; fixture.localConstruction = true;
    const terrain = new ResidentTerrain(fixture, new GeometryGate().pages, physics, new FakeTerrainHost());
    try {
      await terrain.initialize(); for (const cut of fixture.cuts) await terrain.cut(cut);
      const slab = physics.bodies.get(1)!.body;
      slab.setAngvel({ x: .7, y: -.4, z: 1.1 }, true); slab.setLinvel({ x: 1.5, y: 2, z: -.5 }, true);
      // Live: a fresh object reads every pose per query. Held: the owner syncs after each step (ResidentGameTerrain.fixedStep).
      const { fixed, bodies } = terrain.queries, held = new ResidentQueries(1, fixed, bodies), oracle = new OracleQueries(fixed, bodies);
      expect(held.syncPoses()).toBe(true);
      expect(held.syncPoses()).toBe(false);
      let hits = 0;
      for (let round = 0; round < 6; round++) {
        hits += compare(new ResidentQueries(1, fixed, bodies), oracle, centersOf(terrain), round * 2 + 1, 1500);
        hits += compare(held, oracle, centersOf(terrain), round * 2 + 2, 1500);
        for (let i = 0; i < 9; i++) terrain.step();
        expect(held.syncPoses()).toBe(true);
      }
      expect(hits).toBeGreaterThan(500);
      // At rest the poses stop changing although the body may still be awake: no new revision is needed.
      for (let i = 0; i < 1200; i++) terrain.step();
      held.syncPoses(); terrain.step();
      expect(held.syncPoses()).toBe(false);
    } finally { terrain.dispose(); }
  }, 120000);

  it('with ties between coincident bodies and a pose that is not quite unit', () => {
    const box = (center: V3): ReturnType<typeof queryChunk> => queryChunk(center);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(.3, 1, -.2).normalize(), .9).toArray() as Q4;
    const loose = rotation.map(v => v * (1 + 3e-6)) as Q4, far = rotation.map(v => v * 1.01) as Q4;
    const pose = (position: V3, q: Q4) => () => ({ position, rotation: q });
    const bodies = new Map<number, ResidentQueryBody>([
      [1, { collision: box([0, 0, 0]), pose: pose([0, 20, 0], rotation) }],
      [2, { collision: box([0, 0, 0]), pose: pose([0, 20, 0], rotation) }],
      [3, { collision: box([0, 0, 0]), pose: pose([0.5, 20.2, 0], loose) }],
      [4, { collision: box([0, 0, 0]), pose: pose([-3, 19, 1], far) }],
      [5, { collision: new TerrainCollision(), pose: pose([0, 21, 0], rotation) }],
    ]);
    const fixed = box([0, 17, 0]), queries = new ResidentQueries(1, fixed, bodies), oracle = new OracleQueries(fixed, bodies), centers: V3[] = [[0, 20, 0], [0.5, 20.2, 0], [-3, 19, 1], [0, 17, 0]];
    expect(compare(queries, oracle, centers, 21, 4000)).toBeGreaterThan(500);
    queries.syncPoses();
    expect(compare(queries, oracle, centers, 22, 4000)).toBeGreaterThan(500);
  });

  it('on collapsed towers of the seed-7 planet', async () => {
    const structures = generatePlanetStructures(7, undefined, true), input = residentPlanet(7, structures, 'resident-f32-game-v3');
    const physics = await StructuralPhysics.create(input.planetCenter), terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
    try {
      await terrain.initialize();
      for (const structure of structures) {
        if (physics.bodies.size >= 4) break;
        if (!structure.axes || structure.halfSize[1] < 1.75) continue;
        await terrain.cut({ id: `tower-${structure.id}`, center: add(structure.center, scale(structure.axes[1], 1.3 - structure.halfSize[1])), radius: 2, repeat: 'impact' });
      }
      expect(physics.bodies.size).toBeGreaterThan(1);
      const { fixed, bodies } = terrain.queries, held = new ResidentQueries(1, fixed, bodies), oracle = new OracleQueries(fixed, bodies);
      let hits = 0;
      for (let round = 0; round < 3; round++) {
        held.syncPoses();
        hits += compare(new ResidentQueries(1, fixed, bodies), oracle, centersOf(terrain), 40 + round, 1200);
        hits += compare(held, oracle, centersOf(terrain), 50 + round, 1200);
        for (let i = 0; i < 20; i++) terrain.step();
      }
      expect(hits).toBeGreaterThan(300);
    } finally { terrain.dispose(); }
  }, 180000);
});

/** A closed 2 × 1 × 3 box mesh centred on `center` as a one-chunk collision. */
function queryChunk(center: V3): TerrainCollision {
  const [x, y, z] = center, [a, b, c] = [1, .5, 1.5];
  const positions = [x - a, y - b, z - c, x + a, y - b, z - c, x + a, y + b, z - c, x - a, y + b, z - c, x - a, y - b, z + c, x + a, y - b, z + c, x + a, y + b, z + c, x - a, y + b, z + c];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return new TerrainCollision().apply({ version: 1, removed: [], milliseconds: 0, triangles: 12, rebuilt: 1,
    chunks: [{ id: 'box', positions: new Float32Array(positions), indices: new Uint32Array(indices), materials: new Uint16Array(12).fill(2), normals: new Float32Array(), colors: new Float32Array() }] });
}
