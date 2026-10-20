/** sampleTrackTerrain on flat buffers returns exactly the historical profile (kept below as the oracle, with its
 * three.js rotation): the same 18 heights, the same exact envelope points (or the same fallback) and the same band
 * polygons, bit for bit, on the seed-7 planet with and without collapsed bodies, through the flat triangle path and
 * through a plain queryTriangles world, for every running gear. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import type { Q4, TerrainTriangle, V3, WorldQuery } from '../src/game/contracts';
import { sampleTrackTerrain, type TrackTerrainSample, type TreadSource } from '../src/game/tread-contact';
import { DEFAULT_LOADOUT, TREAD_CONTACT_CEILING, TREAD_CONTACT_FLOOR, WHEEL_SUPPORT_RADIUS } from '../src/game/modules';
import { assembleKit, legalKitLoadouts } from '../src/game/kit';
import { assembleLegacy, kitWheelOffsets } from '../src/game/kit/assembly';
import type { KitAssembly } from '../src/game/kit/types';
import { rotation as frameRotation } from '../src/game/math';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { generatePlanetStructures } from '../src/game/terrain-structures';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';

// ---- oracle: src/game/tread-contact.ts sampleTrackTerrain before the flat buffers (93b8a7e) ---------------------------
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rotate = (v: V3, q: Q4): V3 => new Vector3(...v).applyQuaternion(new Quaternion(...q)).toArray() as V3;
const gearOf = (source: TreadSource): KitAssembly => 'running' in source ? source : assembleLegacy(source);
type Polygon = V3[];
type Line = { lo: number; hi: number; slope: number; intercept: number };
function upperEnvelope(band: Polygon[], low: number, high: number): [number, number][] | null {
  const lines: Line[] = [{ lo: low, hi: high, slope: 0, intercept: TREAD_CONTACT_FLOOR }];
  for (const polygon of band) for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if (Math.abs(b[2] - a[2]) < 1e-10) continue;
    const lo = Math.max(low, Math.min(a[2], b[2])), hi = Math.min(high, Math.max(a[2], b[2]));
    if (hi - lo < 1e-10) continue;
    const slope = (b[1] - a[1]) / (b[2] - a[2]);
    lines.push({ lo, hi, slope, intercept: a[1] - slope * a[2] });
  }
  if (lines.length > 192) return null;
  const breaks = lines.flatMap(line => [line.lo, line.hi]);
  for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
    const first = lines[a], second = lines[b], slope = first.slope - second.slope;
    if (Math.abs(slope) < 1e-10) continue;
    const z = (second.intercept - first.intercept) / slope;
    if (z > Math.max(first.lo, second.lo) + 1e-9 && z < Math.min(first.hi, second.hi) - 1e-9) breaks.push(z);
    if (breaks.length > 4096) return null;
  }
  breaks.sort((a, b) => a - b);
  const points: [number, number][] = [];
  function append(z: number, y: number): void {
    const last = points.at(-1), prior = points.at(-2);
    if (last && Math.abs(last[0] - z) < 1e-9 && Math.abs(last[1] - y) < 1e-8) return;
    if (prior && last && Math.abs((last[1] - prior[1]) * (z - last[0]) - (y - last[1]) * (last[0] - prior[0])) < 1e-9) points.pop();
    points.push([z, y]);
  }
  for (let index = 0; index + 1 < breaks.length; index++) {
    const lo = breaks[index], hi = breaks[index + 1];
    if (hi - lo < 1e-9) continue;
    const mid = (lo + hi) * .5;
    let winner = lines[0], height = TREAD_CONTACT_FLOOR;
    for (const line of lines) if (line.lo <= mid && line.hi >= mid) {
      const y = line.slope * mid + line.intercept;
      if (y > height) { height = y; winner = line; }
    }
    append(lo, winner.slope * lo + winner.intercept);
    append(hi, winner.slope * hi + winner.intercept);
  }
  return points.length <= 128 ? points : null;
}
function clip(polygon: Polygon, axis: number, boundary: number, sign: number): Polygon {
  const result: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = (a[axis] - boundary) * sign, db = (b[axis] - boundary) * sign;
    if (da >= -1e-10) result.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const at = da / (da - db); result.push(a.map((value, component) => value + (b[component] - value) * at) as V3); }
  }
  return result;
}
const slab = (polygon: Polygon, axis: number, min: number, max: number): Polygon => clip(clip(polygon, axis, min, 1), axis, max, -1);
function oracleSample(world: WorldQuery, position: V3, rotation: Q4, source: TreadSource): TrackTerrainSample {
  const kit = gearOf(source), stations = kit.running.treadStations, TRACK_HALF_SPACING = kit.running.halfSpacing;
  const end = Math.abs(kitWheelOffsets(kit)[0][2]) + WHEEL_SUPPORT_RADIUS, halfWidth = kit.running.trackWidth * .5;
  const up = rotate([0, 1, 0], rotation), inverse: Q4 = [-rotation[0], -rotation[1], -rotation[2], rotation[3]];
  const result = Array<number>(18).fill(TREAD_CONTACT_FLOOR);
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [-1, 1]) for (const y of [TREAD_CONTACT_FLOOR, TREAD_CONTACT_CEILING]) for (const z of [-end, end]) {
    const corner = add(position, rotate([x * (TRACK_HALF_SPACING + halfWidth), y, z], rotation));
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], corner[axis]) - 1e-7; max[axis] = Math.max(max[axis], corner[axis]) + 1e-7; }
  }
  const queried = world.queryTriangles?.({ min, max }, 512);
  if (queried && !queried.overflow) {
    const polygons = queried.triangles.filter(triangle => dot(triangle.normal, up) > .05)
      .map(triangle => slab([triangle.a, triangle.b, triangle.c].map(vertex => rotate(sub(vertex, position), inverse)), 1, TREAD_CONTACT_FLOOR, TREAD_CONTACT_CEILING));
    const bands: Polygon[][] = [], terrain: [number, number][][] = [];
    let exact = true;
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? TRACK_HALF_SPACING : -TRACK_HALF_SPACING;
      const band = polygons.map(polygon => slab(polygon, 0, x - halfWidth, x + halfWidth)).filter(polygon => polygon.length);
      bands.push(band);
      for (let station = 0; station < 9; station++) for (const polygon of band) {
        for (const vertex of slab(polygon, 2, stations[station], stations[station])) result[side * 9 + station] = Math.max(result[side * 9 + station], vertex[1]);
      }
      for (let station = 0; station < 8; station++) {
        const a = side * 9 + station, b = a + 1, span = stations[station + 1] - stations[station];
        let raise = 0, maximum = Math.max(result[a], result[b]);
        for (const polygon of band) for (const vertex of slab(polygon, 2, stations[station], stations[station + 1])) {
          const fraction = Math.max(0, Math.min(1, (vertex[2] - stations[station]) / span));
          raise = Math.max(raise, vertex[1] - (result[a] * (1 - fraction) + result[b] * fraction));
          maximum = Math.max(maximum, vertex[1]);
        }
        if (Math.max(result[a], result[b]) + raise > maximum + 1e-8) result[a] = result[b] = maximum;
        else { result[a] += raise; result[b] += raise; }
      }
      const envelope = upperEnvelope(band, -end, end);
      if (!envelope) exact = false;
      terrain.push(envelope ?? stations.map((z, index) => [z, result[side * 9 + index]]));
    }
    if (!exact) return { heights: result, bands: null, terrain: [0, 1].map(side => stations.map((z, index) => [z, result[side * 9 + index]])) };
    return { heights: result, bands, terrain };
  }
  for (let side = 0; side < 2; side++) for (let station = 0; station < 9; station++) for (const edge of [-1, 0, 1]) {
    const x = (side === 0 ? TRACK_HALF_SPACING : -TRACK_HALF_SPACING) + edge * halfWidth;
    const origin = add(position, rotate([x, TREAD_CONTACT_CEILING, stations[station]], rotation));
    const hit = world.raycast(origin, mul(up, -1), TREAD_CONTACT_CEILING - TREAD_CONTACT_FLOOR);
    if (hit && dot(hit.normal, up) > .05) result[side * 9 + station] = Math.max(result[side * 9 + station], dot(sub(hit.point, position), up));
  }
  return { heights: result, bands: null, terrain: [0, 1].map(side => stations.map((z, index) => [z, result[side * 9 + index]])) };
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
/** A world exposing only the object query API (the generic path), over the same answers. */
const plain = (world: WorldQuery): WorldQuery => ({ radius: world.radius, version: world.version, raycast: world.raycast.bind(world), surface: world.surface.bind(world),
  isSolid: world.isSolid.bind(world), queryTriangles: world.queryTriangles!.bind(world) });

const SOURCES: TreadSource[] = [DEFAULT_LOADOUT, { tracks: 'grip', barrel: 'rail', armor: 'heavy' },
  ...[...new Map(legalKitLoadouts().map(kit => [kit.runningGear, kit])).values()].map(kit => assembleKit(kit))];

/** Surface poses (spawn-like, tilted, jittered and sunk) on a world; returns how many were exact envelopes. */
function compare(world: WorldQuery, seed: number, count: number): { exact: number; fallback: number } {
  const rng = random(seed);
  let exact = 0, fallback = 0;
  for (let i = 0; i < count; i++) {
    const up = unit(rng), surface = world.surface(up), lift = [.5, .35, .2, .7, 0][Math.floor(rng() * 5)];
    const position = scale(up, Math.hypot(...(surface?.point ?? scale(up, 18))) + lift);
    const tilt = rng() < .3 ? unit(rng).map(v => v * .4) as V3 : [0, 0, 0] as V3;
    const rotation = frameRotation(add(up, tilt), rng() * Math.PI * 2);
    if (rng() < .2) for (let k = 0; k < 3; k++) position[k] += (rng() - .5) * 1e-6;
    const source = SOURCES[Math.floor(rng() * SOURCES.length)];
    const want = oracleSample(world, position, rotation, source), got = sampleTrackTerrain(world, position, rotation, source);
    if (!same(got, want)) expect.fail(`sampleTrackTerrain(${JSON.stringify([position, rotation])}) differs: heights ${JSON.stringify(got.heights)} vs ${JSON.stringify(want.heights)}`);
    if (want.bands) exact++; else fallback++;
  }
  return { exact, fallback };
}

describe('sampleTrackTerrain matches the historical profile bit for bit', () => {
  let terrain: ResidentTerrain;
  beforeAll(async () => {
    const structures = generatePlanetStructures(7, undefined, true), input = residentPlanet(7, structures, 'resident-f32-game-v3');
    terrain = new ResidentTerrain(input, new GeometryGate().pages, await StructuralPhysics.create(input.planetCenter), new FakeTerrainHost());
    await terrain.initialize();
  }, 180000);

  it('on the seed-7 planet, through the flat path and through queryTriangles', () => {
    const flat = compare(terrain.queries, 3, 1500), objects = compare(plain(terrain.queries), 4, 400);
    expect(flat.exact).toBeGreaterThan(1000); expect(objects.exact).toBeGreaterThan(250);
  }, 120000);

  it('with collapsed bodies near the tracks, and on overflowing and analytic worlds', async () => {
    const structures = generatePlanetStructures(7, undefined, true);
    for (const structure of structures) {
      if (terrain.physics.bodies.size >= 4) break;
      if (!structure.axes || structure.halfSize[1] < 1.75) continue;
      await terrain.cut({ id: `tower-${structure.id}`, center: add(structure.center, scale(structure.axes[1], 1.3 - structure.halfSize[1])), radius: 2, repeat: 'impact' });
    }
    expect(terrain.physics.bodies.size).toBeGreaterThan(1);
    const rng = random(9);
    for (const { body } of terrain.physics.bodies.values()) {
      const p = body.translation(), up = Math.hypot(p.x, p.y, p.z);
      for (let i = 0; i < 40; i++) {
        const position: V3 = [p.x + (rng() - .5) * 2, p.y + (rng() - .5) * 2, p.z + (rng() - .5) * 2], rotation = frameRotation([p.x / up, p.y / up, p.z / up], rng() * 7);
        const source = SOURCES[i % SOURCES.length];
        if (!same(sampleTrackTerrain(terrain.queries, position, rotation, source), oracleSample(terrain.queries, position, rotation, source))) expect.fail(`differs near body at ${JSON.stringify(position)}`);
      }
    }
    terrain.queries.syncPoses();
    compare(terrain.queries, 5, 300);
    // A 1-triangle budget overflows (ray fallback); a dense fan exceeds the 192-line envelope budget (station fallback).
    const tiny: WorldQuery = { ...plain(terrain.queries), queryTriangles: bounds => terrain.queries.queryTriangles(bounds, 1) };
    expect(compare(tiny, 6, 60).fallback).toBeGreaterThan(50);
    const fan: TerrainTriangle[] = [];
    for (let i = 0; i < 160; i++) {
      const z0 = -1 + i / 80, z1 = z0 + 1 / 80, y = (i % 2 ? .02 : -.02) - .45;
      fan.push({ a: [-1, y, z0], b: [-1, -y - .9, z1], c: [1, y, z1], normal: [0, 1, 0], material: 1 });
    }
    const dense: WorldQuery = { radius: 18, version: 1, raycast: () => null, surface: () => null, isSolid: () => false, queryTriangles: () => ({ triangles: fan, overflow: false }) };
    for (const source of SOURCES) {
      const want = oracleSample(dense, [0, 0, 0], [0, 0, 0, 1], source);
      expect(same(sampleTrackTerrain(dense, [0, 0, 0], [0, 0, 0, 1], source), want)).toBe(true);
    }
  }, 180000);
});
