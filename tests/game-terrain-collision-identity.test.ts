/** TerrainCollision answers every query bit-identically to the historical scan of every chunk root with allocating
 * triangle tests (kept below as the oracle): the same point, normal, distance and material, the same winner of an
 * equal-distance tie (last in chunk Map order, then BVH order), the same overflow point of a bounded triangle query.
 * Inputs: the real seed-7 resident planet plus synthetic tie, boundary, degenerate and overflow cases. */
import { beforeAll, describe, expect, it } from 'vitest';
import type { TerrainHit, TerrainQueryBounds, TerrainTriangle, TerrainTriangleQuery, V3 } from '../src/game/contracts';
import type { BuiltTerrainChunk, BuiltTerrainUpdate } from '../src/game/terrain-config';
import { TERRAIN_BOUND } from '../src/game/terrain-config';
import { TerrainCollision } from '../src/game/terrain-collision';
import { TriangleSoup } from '../src/game/triangle-soup';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { Triangle, Vector3 } from 'three';

// ---- oracle: src/game/terrain-collision.ts and sphere-triangle.ts before the flat index (93b8a7e) ------------------
const triangle = new Triangle(), sOrigin = new Vector3(), sDirection = new Vector3(), closest = new Vector3();
const normalV = new Vector3(), contact = new Vector3(), edgeV = new Vector3(), relative = new Vector3(), radial = new Vector3(), velocity = new Vector3();
function firstRoot(a: number, b: number, c: number): number | null {
  if (a < 1e-16) return null;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 ? t : null;
}
function sphereTriangleDistance(o: V3, d: V3, maximum: number, radius: number, a: V3, b: V3, c: V3): number | null {
  sOrigin.fromArray(o); sDirection.fromArray(d);
  triangle.set(closest.fromArray(a), contact.fromArray(b), normalV.fromArray(c));
  triangle.closestPointToPoint(sOrigin, closest);
  if (closest.distanceToSquared(sOrigin) <= radius * radius) return 0;
  let best = maximum, hit = false;
  const accept = (t: number | null) => { if (t !== null && t <= best) { best = t; hit = true; } };
  triangle.getNormal(normalV);
  const distance = relative.subVectors(sOrigin, triangle.a).dot(normalV), rate = sDirection.dot(normalV);
  if (Math.abs(rate) > 1e-12) for (const side of [-1, 1]) {
    const t = (side * radius - distance) / rate;
    if (t < 0 || t > best) continue;
    contact.copy(sOrigin).addScaledVector(sDirection, t).addScaledVector(normalV, -side * radius);
    if (triangle.containsPoint(contact)) accept(t);
  }
  const corners = [triangle.a, triangle.b, triangle.c];
  for (let i = 0; i < 3; i++) {
    relative.subVectors(sOrigin, corners[i]);
    accept(firstRoot(1, relative.dot(sDirection), relative.lengthSq() - radius * radius));
    edgeV.subVectors(corners[(i + 1) % 3], corners[i]);
    const length = edgeV.length();
    if (length < 1e-12) continue;
    edgeV.divideScalar(length);
    const along = relative.dot(edgeV), speed = sDirection.dot(edgeV);
    radial.copy(relative).addScaledVector(edgeV, -along);
    velocity.copy(sDirection).addScaledVector(edgeV, -speed);
    const t = firstRoot(velocity.lengthSq(), radial.dot(velocity), radial.lengthSq() - radius * radius);
    if (t !== null && along + t * speed >= 0 && along + t * speed <= length) accept(t);
  }
  return hit ? best : null;
}
interface Box { min: V3; max: V3 }
interface Node extends Box { left?: Node; right?: Node; faces?: number[] }
interface OracleChunk { mesh: BuiltTerrainChunk; root: Node }
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const point = (mesh: BuiltTerrainChunk, vertex: number): V3 => { const i = mesh.indices[vertex] * 3; return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]; };
function makeTree(mesh: BuiltTerrainChunk, faces: number[]): Node {
  const count = mesh.indices.length / 3, centroid = new Float64Array(count * 3), lo = new Float64Array(count * 3), hi = new Float64Array(count * 3);
  const { positions, indices } = mesh;
  for (let f = 0; f < count; f++) for (let a = 0; a < 3; a++) {
    const x = positions[indices[f * 3] * 3 + a], y = positions[indices[f * 3 + 1] * 3 + a], z = positions[indices[f * 3 + 2] * 3 + a];
    centroid[f * 3 + a] = x + y + z; lo[f * 3 + a] = Math.min(x, y, z); hi[f * 3 + a] = Math.max(x, y, z);
  }
  const build = (list: number[]): Node => {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const face of list) for (let a = 0; a < 3; a++) { if (lo[face * 3 + a] < min[a]) min[a] = lo[face * 3 + a]; if (hi[face * 3 + a] > max[a]) max[a] = hi[face * 3 + a]; }
    if (list.length <= 10) return { min, max, faces: list };
    const axis = [0, 1, 2].sort((a, b) => (max[b] - min[b]) - (max[a] - min[a]))[0];
    list.sort((a, b) => centroid[a * 3 + axis] - centroid[b * 3 + axis]);
    const middle = Math.floor(list.length / 2);
    return { min, max, left: build(list.slice(0, middle)), right: build(list.slice(middle)) };
  };
  return build(faces);
}
function intersects(box: Box, origin: V3, direction: V3, distance: number, radius = 0): boolean {
  let near = 0, far = distance;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(direction[a]) < 1e-15) { if (origin[a] < box.min[a] - radius - 1e-7 || origin[a] > box.max[a] + radius + 1e-7) return false; }
    else {
      let lo = (box.min[a] - radius - origin[a]) / direction[a], hi = (box.max[a] + radius - origin[a]) / direction[a];
      if (lo > hi) [lo, hi] = [hi, lo];
      near = Math.max(near, lo); far = Math.min(far, hi);
      if (near > far + 1e-7) return false;
    }
  }
  return true;
}
function triangleHit(mesh: BuiltTerrainChunk, face: number, origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
  const a = point(mesh, face * 3), b = point(mesh, face * 3 + 1), c = point(mesh, face * 3 + 2);
  const e1 = sub(b, a), e2 = sub(c, a), p = cross(direction, e2), determinant = dot(e1, p);
  if (Math.abs(determinant) < 1e-12) return null;
  const inverse = 1 / determinant, t = sub(origin, a), u = dot(t, p) * inverse;
  if (u < -1e-8 || u > 1 + 1e-8) return null;
  const q = cross(t, e1), v = dot(direction, q) * inverse;
  if (v < -1e-8 || u + v > 1 + 1e-8) return null;
  const distance = dot(e2, q) * inverse;
  if (distance < -1e-7 || distance > maxDistance) return null;
  const normal = cross(e1, e2), length = Math.hypot(...normal);
  if (!length) return null;
  return { point: origin.map((value, i) => value + direction[i] * Math.max(0, distance)) as V3,
    normal: normal.map(value => value / length) as V3, distance: Math.max(0, distance), material: mesh.materials[face] };
}
class OracleCollision {
  constructor(readonly chunks: ReadonlyMap<string, OracleChunk> = new Map()) {}
  apply(update: BuiltTerrainUpdate): OracleCollision {
    const chunks = new Map(this.chunks);
    for (const mesh of update.chunks) chunks.set(mesh.id, { mesh, root: makeTree(mesh, Array.from({ length: mesh.indices.length / 3 }, (_, i) => i)) });
    return new OracleCollision(chunks);
  }
  raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    if (!origin.every(Number.isFinite) || !direction.every(Number.isFinite) || !(maxDistance >= 0) || !Number.isFinite(maxDistance)) return null;
    const length = Math.hypot(...direction); if (length < 1e-15) return null;
    const ray = direction.map(v => v / length) as V3;
    let hit: TerrainHit | null = null;
    const visit = (chunk: OracleChunk, node: Node): void => {
      if (!intersects(node, origin, ray, hit?.distance ?? maxDistance)) return;
      if (node.faces) for (const face of node.faces) { const candidate = triangleHit(chunk.mesh, face, origin, ray, hit?.distance ?? maxDistance); if (candidate) hit = candidate; }
      else { visit(chunk, node.left!); visit(chunk, node.right!); }
    };
    for (const chunk of this.chunks.values()) visit(chunk, chunk.root);
    return hit;
  }
  queryTriangles(bounds: TerrainQueryBounds, maxTriangles = 512): TerrainTriangleQuery {
    if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite) || bounds.min.some((value, axis) => value > bounds.max[axis])
      || !Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > 2048) throw new Error('Invalid bounded terrain triangle query.');
    const result: TerrainTriangleQuery = { triangles: [], overflow: false };
    const overlaps = (box: Box): boolean => box.min.every((value, axis) => value <= bounds.max[axis] + 1e-7 && box.max[axis] >= bounds.min[axis] - 1e-7);
    let visited = 0;
    const visit = (chunk: OracleChunk, node: Node): void => {
      if (result.overflow) return;
      if (++visited > 8192) { result.overflow = true; return; }
      if (!overlaps(node)) return;
      if (node.faces) for (const face of node.faces) {
        const a = point(chunk.mesh, face * 3), b = point(chunk.mesh, face * 3 + 1), c = point(chunk.mesh, face * 3 + 2);
        if ([0, 1, 2].some(axis => Math.min(a[axis], b[axis], c[axis]) > bounds.max[axis] + 1e-7 || Math.max(a[axis], b[axis], c[axis]) < bounds.min[axis] - 1e-7)) continue;
        if (result.triangles.length >= maxTriangles) { result.overflow = true; return; }
        const normal = cross(sub(b, a), sub(c, a)), length = Math.hypot(...normal);
        if (length > 1e-12) result.triangles.push({ a, b, c, normal: normal.map(value => value / length) as V3, material: chunk.mesh.materials[face] });
      }
      else { visit(chunk, node.left!); visit(chunk, node.right!); }
    };
    for (const chunk of this.chunks.values()) { visit(chunk, chunk.root); if (result.overflow) break; }
    return result;
  }
  * visibilityTriangles(): Iterable<TerrainTriangle> {
    for (const { mesh } of this.chunks.values()) for (let face = 0; face < mesh.indices.length / 3; face++) {
      const a = point(mesh, face * 3), b = point(mesh, face * 3 + 1), c = point(mesh, face * 3 + 2);
      const normal = cross(sub(b, a), sub(c, a)), length = Math.hypot(...normal);
      if (length > 1e-12) yield { a, b, c, normal: normal.map(value => value / length) as V3, material: mesh.materials[face] };
    }
  }
  sweepSphere(origin: V3, direction: V3, maxDistance: number, radius: number): number | null {
    if (!origin.every(Number.isFinite) || !direction.every(Number.isFinite) || !Number.isFinite(maxDistance) || maxDistance < 0 || !Number.isFinite(radius) || radius <= 0) return null;
    const length = Math.hypot(...direction); if (length < 1e-15) return null;
    const ray = direction.map(v => v / length) as V3;
    let distance: number | null = null;
    const visit = (chunk: OracleChunk, node: Node): void => {
      if (!intersects(node, origin, ray, distance ?? maxDistance, radius)) return;
      if (node.faces) for (const face of node.faces) {
        const hit = sphereTriangleDistance(origin, ray, distance ?? maxDistance, radius, point(chunk.mesh, face * 3), point(chunk.mesh, face * 3 + 1), point(chunk.mesh, face * 3 + 2));
        if (hit !== null) distance = hit;
      }
      else { visit(chunk, node.left!); visit(chunk, node.right!); }
    };
    for (const chunk of this.chunks.values()) visit(chunk, chunk.root);
    return distance;
  }
  surface(direction: V3): TerrainHit | null {
    const length = Math.hypot(...direction); if (!length || !Number.isFinite(length)) return null;
    const distance = TERRAIN_BOUND * Math.sqrt(3) + 1;
    return this.raycast(direction.map(v => v * distance / length) as V3, direction.map(v => -v) as V3, distance * 2);
  }
  isSolid(position: V3): boolean {
    const direction: V3 = [.8192319, .3721373, .4361951];
    const hit = this.raycast(position, direction, TERRAIN_BOUND * 4);
    return !!hit && (hit.distance < 1e-6 || dot(hit.normal, direction) > 0);
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
const plus = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vertexOf = (mesh: BuiltTerrainChunk, vertex: number): V3 => point(mesh, vertex);

/** Every query family, compared field by field with Object.is (so -0 and NaN must match too). */
function compare(world: TerrainCollision, oracle: OracleCollision, seed: number, counts = { rays: 6000, sweeps: 1500, solids: 3000, boxes: 1500 }): { hits: number; ties: number } {
  const rng = random(seed), meshes = [...world.chunks.values()].map(c => c.mesh);
  const randomVertex = (): V3 => { const mesh = meshes[Math.floor(rng() * meshes.length)]; return vertexOf(mesh, Math.floor(rng() * mesh.indices.length)); };
  const randomEdgePoint = (): V3 => {
    const mesh = meshes[Math.floor(rng() * meshes.length)], face = Math.floor(rng() * mesh.indices.length / 3), a = vertexOf(mesh, face * 3), b = vertexOf(mesh, face * 3 + 1 + Math.floor(rng() * 2)), t = [0, .5, .25, rng()][Math.floor(rng() * 4)];
    return plus(a, scale(sub(b, a), t));
  };
  const origin = (): V3 => {
    const pick = rng();
    if (pick < .5) return scale(unit(rng), 12 + rng() * 14);
    if (pick < .6) { const p = scale(unit(rng), 15 + rng() * 6); p[Math.floor(rng() * 3)] = 6 * Math.round(rng() * 8 - 4); return p; } // on a brick boundary plane
    if (pick < .75) return randomVertex();
    if (pick < .85) return randomEdgePoint();
    return [(rng() * 2 - 1) * 30, (rng() * 2 - 1) * 30, (rng() * 2 - 1) * 30];
  };
  const direction = (from: V3): V3 => {
    const pick = rng();
    if (pick < .15) return sub(randomVertex(), from); // through a shared vertex: equal-distance ties between neighbours
    if (pick < .25) return sub(randomEdgePoint(), from);
    if (pick < .35) { const d: V3 = [0, 0, 0]; d[Math.floor(rng() * 3)] = rng() < .5 ? -1 : 1; return d; } // axis aligned: two degenerate slabs
    if (pick < .45) { const d = unit(rng); d[Math.floor(rng() * 3)] = 0; return d; } // in a brick boundary plane
    if (pick < .48) return [0, 0, 0];
    if (pick < .5) return [1e-16, 0, -1e-16];
    if (pick < .52) return scale(unit(rng), 1e-14);
    return scale(unit(rng), [1, 1, .3, 7][Math.floor(rng() * 4)]);
  };
  const extent = (): number => { const pick = rng(); return pick < .05 ? 0 : pick < .08 ? -1 : pick < .5 ? rng() * .8 : pick < .9 ? rng() * 30 : TERRAIN_BOUND * 4; };
  let hits = 0, ties = 0;
  for (let i = 0; i < counts.rays; i++) {
    const o = origin(), d = direction(o), m = extent();
    const want = oracle.raycast(o, d, m), got = world.raycast(o, d, m);
    if (!same(got, want)) expect.fail(`raycast(${JSON.stringify([o, d, m])}) = ${JSON.stringify(got)}, historically ${JSON.stringify(want)}`);
    if (world.blocked(o, d, m) !== (want !== null)) expect.fail(`blocked(${JSON.stringify([o, d, m])}) disagrees with raycast`);
    if (want) hits++;
    if (want && want.distance === 0) ties++;
  }
  for (let i = 0; i < counts.sweeps; i++) {
    const o = origin(), d = direction(o), m = extent(), r = [.28, .05, 1, rng() * 2, 0, -1][Math.floor(rng() * 6)];
    const want = oracle.sweepSphere(o, d, m, r), got = world.sweepSphere(o, d, m, r);
    if (!same(got, want)) expect.fail(`sweepSphere(${JSON.stringify([o, d, m, r])}) = ${got}, historically ${want}`);
  }
  for (let i = 0; i < counts.solids; i++) {
    const p = rng() < .2 ? randomVertex() : rng() < .2 ? randomEdgePoint() : origin();
    if (world.isSolid(p) !== oracle.isSolid(p)) expect.fail(`isSolid(${JSON.stringify(p)}) disagrees`);
  }
  for (let i = 0; i < 400; i++) { const d = rng() < .1 ? [0, 0, 0] as V3 : direction([0, 0, 0]); if (!same(world.surface(d), oracle.surface(d))) expect.fail(`surface(${JSON.stringify(d)}) disagrees`); }
  for (let i = 0; i < counts.boxes; i++) {
    const center = rng() < .3 ? randomVertex() : origin(), half: V3 = [rng() * 4, rng() * 4, rng() * 4];
    if (rng() < .1) half[Math.floor(rng() * 3)] = 0;
    if (rng() < .05) half.fill(30);
    const bounds = { min: sub(center, half), max: plus(center, half) }, max = [512, 1, 2048, 64, Math.ceil(rng() * 2048)][Math.floor(rng() * 5)];
    const want = oracle.queryTriangles(bounds, max), got = world.queryTriangles(bounds, max);
    if (!same(got, want)) expect.fail(`queryTriangles(${JSON.stringify([bounds, max])}): ${got.triangles.length}/${got.overflow} vs ${want.triangles.length}/${want.overflow}`);
    const soup = new TriangleSoup(), overflow = world.collect(bounds, max, soup);
    if (overflow !== want.overflow || !same(soup.triangles(), want.triangles)) expect.fail('collect() disagrees with queryTriangles()');
  }
  return { hits, ties };
}
const build = (meshes: BuiltTerrainChunk[]) => {
  const update: BuiltTerrainUpdate = { version: 1, chunks: meshes, removed: [], milliseconds: 0, triangles: 0, rebuilt: meshes.length };
  return { world: new TerrainCollision().apply(update), oracle: new OracleCollision().apply(update) };
};
/** A unit-cube-grid mesh chunk: two triangles per cell, optionally tilted. */
function sheet(id: string, origin: V3, cells: number, size: number, tilt = 0, material = 1): BuiltTerrainChunk {
  const positions: number[] = [], indices: number[] = [];
  for (let j = 0; j <= cells; j++) for (let i = 0; i <= cells; i++) positions.push(origin[0] + i * size, origin[1] + (i + j) * tilt, origin[2] + j * size);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) { const a = j * (cells + 1) + i; indices.push(a, a + cells + 1, a + 1, a + 1, a + cells + 1, a + cells + 2); }
  return { id, positions: new Float32Array(positions), indices: new Uint32Array(indices), materials: new Uint16Array(indices.length / 3).fill(material), normals: new Float32Array(), colors: new Float32Array() };
}

describe('TerrainCollision matches the historical full scan bit for bit', () => {
  let planet: { world: TerrainCollision; oracle: OracleCollision };
  beforeAll(async () => {
    const input = residentPlanet(7, undefined, 'resident-f32-game-v3'), physics = await StructuralPhysics.create(input.planetCenter);
    const terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
    try { await terrain.initialize(); planet = build([...terrain.queries.fixed.chunks.values()].map(chunk => chunk.mesh)); }
    finally { terrain.dispose(); }
  }, 180000);

  it('on the seed-7 planet: rays, sweeps, solids, surfaces and boxes', () => {
    expect(planet.world.chunks.size).toBeGreaterThan(150);
    const { hits, ties } = compare(planet.world, planet.oracle, 7);
    expect(hits).toBeGreaterThan(1000); expect(ties).toBeGreaterThan(10);
  }, 120000);

  it('on the seed-7 planet: grazing rays and sweeps along the surface from on and just above it', () => {
    const rng = random(23);
    let hits = 0;
    for (let i = 0; i < 1500; i++) {
      const surface = planet.oracle.surface(unit(rng));
      if (!surface) continue;
      const lift = [0, 1e-9, 1e-6, 1e-3, -1e-7][Math.floor(rng() * 5)], tangent = cross(surface.normal, unit(rng)), length = Math.hypot(...tangent);
      if (length < 1e-6) continue;
      const o = plus(surface.point, scale(surface.normal, lift)), d = scale(tangent, (rng() < .5 ? 1 : -1) / length), m = [.5, 3, 30][Math.floor(rng() * 3)];
      const want = planet.oracle.raycast(o, d, m);
      if (!same(planet.world.raycast(o, d, m), want)) expect.fail(`grazing raycast(${JSON.stringify([o, d, m])}) disagrees`);
      if (planet.world.blocked(o, d, m) !== (want !== null)) expect.fail(`grazing blocked(${JSON.stringify([o, d, m])}) disagrees`);
      if (!same(planet.world.sweepSphere(o, d, m, .28), planet.oracle.sweepSphere(o, d, m, .28))) expect.fail(`grazing sweepSphere(${JSON.stringify([o, d, m])}) disagrees`);
      if (planet.world.isSolid(o) !== planet.oracle.isSolid(o)) expect.fail(`isSolid(${JSON.stringify(o)}) on the surface disagrees`);
      if (want) hits++;
    }
    expect(hits).toBeGreaterThan(100);
  }, 120000);

  it('resolves equal distances across duplicate chunks and duplicate triangles by Map and visiting order', () => {
    const a = sheet('a', [-2, 0, -2], 8, .5, 0, 1), b = { ...sheet('b', [-2, 0, -2], 8, .5, 0, 2) }, c = sheet('c', [-2, 0, -2], 8, .5, 0, 3);
    const twice = { ...a, id: 'twice', indices: Uint32Array.from([...a.indices, ...a.indices]), materials: Uint16Array.from([...a.materials].flatMap(() => [4]).concat([...a.materials].map(() => 5))) };
    const cases = build([a, b, twice, c, sheet('tilted', [-2, -1, -2], 8, .5, .05, 6)]);
    compare(cases.world, cases.oracle, 11, { rays: 3000, sweeps: 1000, solids: 1000, boxes: 800 });
    expect(cases.world.raycast([0, 3, 0], [0, -1, 0], 10)?.material).toBe(3);
  });

  it('reproduces the visited-node overflow when thousands of chunk roots are skipped', () => {
    const meshes: BuiltTerrainChunk[] = [];
    for (let i = 0; i < 9000; i++) meshes.push(sheet(`tile-${i}`, [(i % 100) * .3 - 15, Math.floor(i / 100) * .25 - 11, (i * 7919 % 13) * .1], 1, .2, .01));
    const cases = build(meshes), rng = random(3);
    for (let i = 0; i < 300; i++) {
      const center: V3 = [(rng() * 2 - 1) * 16, (rng() * 2 - 1) * 12, rng() * 1.3], half: V3 = [rng() * 6, rng() * 6, rng() * 2];
      const bounds = { min: sub(center, half), max: plus(center, half) }, max = [2048, 512, 7][Math.floor(rng() * 3)];
      const want = cases.oracle.queryTriangles(bounds, max), got = cases.world.queryTriangles(bounds, max);
      if (!same(got, want)) expect.fail(`queryTriangles(${JSON.stringify([bounds, max])}): ${got.triangles.length}/${got.overflow} vs ${want.triangles.length}/${want.overflow}`);
    }
    expect(cases.world.queryTriangles({ min: [-20, -12, -1], max: [20, 13, 2] }, 2048).overflow).toBe(true);
    compare(cases.world, cases.oracle, 5, { rays: 1500, sweeps: 300, solids: 300, boxes: 300 });
  }, 120000);

  it('rejects the same invalid input and keeps the historical visibility triangles', () => {
    const { world, oracle } = build([sheet('a', [0, 0, 0], 3, 1)]);
    for (const bounds of [{ min: [0, 0, 0], max: [-1, 0, 0] }, { min: [NaN, 0, 0], max: [1, 1, 1] }] as TerrainQueryBounds[]) {
      expect(() => world.queryTriangles(bounds)).toThrow('Invalid bounded terrain triangle query.');
      expect(() => oracle.queryTriangles(bounds)).toThrow('Invalid bounded terrain triangle query.');
    }
    for (const max of [0, 2049, 1.5]) expect(() => world.queryTriangles({ min: [0, 0, 0], max: [1, 1, 1] }, max)).toThrow();
    expect(same([...world.visibilityTriangles()], [...oracle.visibilityTriangles()])).toBe(true);
    for (const args of [[[NaN, 0, 0], [0, 1, 0], 1], [[0, 0, 0], [Infinity, 1, 0], 1], [[0, 0, 0], [0, 1, 0], Infinity], [[0, 0, 0], [0, 1, 0], NaN]] as [V3, V3, number][]) {
      expect(world.raycast(...args)).toBeNull(); expect(world.blocked(...args)).toBe(false); expect(world.sweepSphere(...args, .3)).toBeNull();
    }
    expect(new TerrainCollision().raycast([0, 0, 0], [0, 1, 0], 5)).toBeNull();
    expect(new TerrainCollision().queryTriangles({ min: [0, 0, 0], max: [1, 1, 1] })).toEqual({ triangles: [], overflow: false });
  });
});
