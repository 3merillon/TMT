import { expect, it } from 'vitest';
import type { TerrainTriangle, V3, WorldQuery } from '../src/game/contracts';
import { add, dot, mul, normalize, rotate, rotation, sub } from '../src/game/math';
import { DEFAULT_LOADOUT, getTreadContactStations, getWheelOffsets, ROAD_WHEEL_CENTER_Y, ROAD_WHEEL_RADIUS, WHEEL_SUPPORT_RADIUS, WHEEL_SHOE_CLEARANCE } from '../src/game/modules';
import { sampleTrackTerrain, sampleTreadContacts, treadWheelSupport } from '../src/game/tread-contact';

function patch(x0: number, x1: number, z0: number, z1: number, y: number): TerrainTriangle[] {
  return [
    { a: [x0, y, z0], b: [x0, y, z1], c: [x1, y, z1], normal: [0, 1, 0], material: 1 },
    { a: [x0, y, z0], b: [x1, y, z1], c: [x1, y, z0], normal: [0, 1, 0], material: 1 },
  ];
}
function triangleWorld(triangles: TerrainTriangle[]): WorldQuery {
  return { radius: 18, version: 1, isSolid: () => false, raycast: () => null, surface: () => null,
    queryTriangles: () => ({ triangles, overflow: false }) };
}
function heightAt(profile: number[], z: number, side = 0): number {
  const stations = getTreadContactStations(DEFAULT_LOADOUT);
  const index = stations.findIndex((station, index) => index < 8 && station <= z && stations[index + 1] >= z);
  const fraction = (z - stations[index]) / (stations[index + 1] - stations[index]);
  return profile[side * 9 + index] * (1 - fraction) + profile[side * 9 + index + 1] * fraction;
}

it('covers narrow peaks between stations and at a width edge without inventing taller obstacles', () => {
  const triangles = [
    ...patch(.435, .445, -.64, -.63, .2), // narrow outer edge patch, between the approach and rear wheel
    ...patch(.52, .58, -.49, -.48, -.1),
  ];
  const profile = sampleTreadContacts(triangleWorld(triangles), [0, 0, 0], [0, 0, 0, 1], DEFAULT_LOADOUT);
  expect(profile).toHaveLength(18);
  expect(profile.every(Number.isFinite)).toBe(true);
  expect(Math.max(...profile)).toBeLessThanOrEqual(.2 + 1e-8);
  expect(heightAt(profile, -.635)).toBeGreaterThanOrEqual(.2 - 1e-8);
  expect(heightAt(profile, -.485)).toBeGreaterThanOrEqual(-.1 - 1e-8);
  expect(profile.slice(9).every(value => value === -1.2)).toBe(true);
});

it('transmits an inter-wheel rock through the belt into its neighboring wheels', () => {
  const profile = Array(18).fill(-.5);
  profile[2] = -.34;
  const travel = treadWheelSupport(profile, DEFAULT_LOADOUT);
  expect(travel[0]).toBeGreaterThan(.03);
  expect(travel[1]).toBeGreaterThan(.03);
  expect(travel[4]).toBeLessThan(.01);
  const expanded = WHEEL_SUPPORT_RADIUS;
  const stations = getTreadContactStations(DEFAULT_LOADOUT);
  for (const [index, wheel] of getWheelOffsets(DEFAULT_LOADOUT).entries()) {
    const side = Math.floor(index / 4);
    for (let step = 0; step <= 100; step++) {
      const z = wheel[2] - expanded + 2 * expanded * step / 100;
      if (z < stations[0] || z > stations[8]) continue;
      const lowerCircle = ROAD_WHEEL_CENTER_Y + travel[index] - Math.sqrt(Math.max(0, expanded ** 2 - (z - wheel[2]) ** 2));
      expect(lowerCircle + 1e-8).toBeGreaterThanOrEqual(heightAt(profile, z, side) + WHEEL_SHOE_CLEARANCE);
    }
  }
});

it('does not accept a truncated mesh query as a complete contact profile', () => {
  let rays = 0;
  const world = triangleWorld(patch(.4, .7, -.8, .8, .2));
  world.queryTriangles = () => ({ triangles: patch(.4, .7, -.8, .8, .2), overflow: true });
  world.raycast = (origin, direction) => { rays++; const distance = (origin[1] + .5) / -direction[1]; return { point: add(origin, mul(direction, distance)), distance, normal: [0, 1, 0], material: 1 }; };
  expect(sampleTreadContacts(world, [0, 0, 0], [0, 0, 0, 1], DEFAULT_LOADOUT)).toEqual(Array(18).fill(-.5));
  expect(rays).toBe(54);
});

/** Möller–Trumbore against a triangle list: the committed-mesh raycast of the fixture. */
function meshRaycast(triangles: TerrainTriangle[], origin: V3, direction: V3, maxDistance: number) {
  let best: { point: V3; normal: V3; distance: number; material: number } | null = null;
  for (const t of triangles) {
    const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a);
    const p: V3 = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(origin, t.a), u = dot(s, p) / det;
    if (u < 0 || u > 1) continue;
    const q: V3 = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = dot(direction, q) / det, at = dot(e2, q) / det;
    if (v < 0 || u + v > 1 || at < 0 || at > maxDistance || (best && at >= best.distance)) continue;
    best = { point: add(origin, mul(direction, at)), normal: t.normal, distance: at, material: t.material };
  }
  return best;
}

it('covers the full width at dense positions across a triangulated crater lip', () => {
  // A crater rim fan (the geometry the old seed-7 carve case exercised, W1-GAME dropped the legacy terrain):
  // a flat floor at the ride height, rising over a lip of three facets that crosses the rear wheels.
  const height = (z: number) => z < -.9 ? -.5 : z < -.55 ? -.5 + (z + .9) * .9 : z < -.25 ? -.185 + (z + .55) * -.4 : -.305 + (z + .25) * -.1;
  const triangles: TerrainTriangle[] = [];
  const breaks = [-1.6, -.9, -.55, -.25, 1.6];
  for (let i = 0; i + 1 < breaks.length; i++) for (let x = 0; x < 4; x++) {
    const x0 = -1 + x * .5, x1 = x0 + .5, z0 = breaks[i], z1 = breaks[i + 1];
    const tilt = x0 * .05; // a slight cross slope so the width edges see different heights
    const a: V3 = [x0, height(z0) + tilt, z0], b: V3 = [x0, height(z1) + tilt, z1], c: V3 = [x1, height(z1) + x1 * .05, z1], d: V3 = [x1, height(z0) + x1 * .05, z0];
    for (const [p, q, r] of [[a, b, c], [a, c, d]] as const) {
      const n = normalize([(q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]), (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]), (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])]);
      triangles.push({ a: p, b: q, c: r, normal: n[1] < 0 ? mul(n, -1) : n, material: 1 });
    }
  }
  const world = triangleWorld(triangles);
  world.raycast = (origin, direction, maxDistance) => meshRaycast(triangles, origin, direction, maxDistance);
  const position: V3 = [0, 0, 0], orientation = rotation([0, 1, 0], 0), profile = sampleTreadContacts(world, position, orientation, DEFAULT_LOADOUT);
  const localUp = rotate([0, 1, 0], orientation), stations = getTreadContactStations(DEFAULT_LOADOUT);
  let checked = 0;
  for (let side = 0; side < 2; side++) for (let segment = 0; segment < 8; segment++) for (let at = 0; at <= 4; at++) for (const edge of [-1, 0, 1]) {
    const z = stations[segment] + (stations[segment + 1] - stations[segment]) * at / 4;
    const x = (side === 0 ? .55 : -.55) + edge * .115;
    const hit = world.raycast(add(position, rotate([x, .3, z], orientation)), mul(localUp, -1), 1.5);
    if (!hit || dot(hit.normal, localUp) <= .05) continue;
    const ground = dot(sub(hit.point, position), localUp);
    expect(heightAt(profile, z, side) + 1e-6).toBeGreaterThanOrEqual(ground);
    checked++;
  }
  expect(checked).toBeGreaterThan(50);
});

it('retains the actual narrow peak breakpoint instead of raising neighboring sample bins', () => {
  const world = triangleWorld([...patch(.4, .7, -1, 1, -.5), ...patch(.48, .62, -.43, -.41, -.36)]);
  for (const advance of [0, .01, .02, .03]) {
    const sample = sampleTrackTerrain(world, [0, 0, advance], [0, 0, 0, 1], DEFAULT_LOADOUT);
    expect(sample.bands).not.toBeNull();
    const top = sample.terrain[0].filter(point => point[1] > -.4);
    expect(top.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...top.map(point => point[0]))).toBeCloseTo(-.43 - advance, 7);
    expect(Math.max(...top.map(point => point[0]))).toBeCloseTo(-.41 - advance, 7);
    expect(sample.terrain.every(side => side.length <= 128 && side.every((p, i) => i === 0 || p[0] >= side[i - 1][0]))).toBe(true);
  }
});
