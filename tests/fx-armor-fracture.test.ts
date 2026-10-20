import { expect, it } from 'vitest';
import { Triangle, Vector3 } from 'three';
import { fractureArmor, armorSplinters } from '../src/game/presentation/armor-fracture';
import { shape, plate, finish } from '../src/game/presentation/campaign-machining';
import { vehicleFireSource } from '../src/game/presentation/vehicle-damage';
import type { TankSurfaceMark } from '../src/engine';
import type { TankState, V3 } from '../src/game/contracts';
import { pointTriangleDistanceSquared } from '../src/game/sphere-triangle';
const mark: TankSurfaceMark = { position: [0, .05, 0], normal: [0, 1, 0], radius: .25, opacity: 1, softness: .5, color: [.02, .02, .02], damage: true };
it('matches the Three closest-point oracle exactly at armor faces, edges, vertices and degenerate triangles', () => {
  const a: V3 = [0, 0, 0], b: V3 = [2, 0, 0], c: V3 = [0, 2, 0];
  const triangles: V3[][] = [[a, b, c], [a, c, b], [a, a, a], [a, b, [4, 0, 0]], [[-.8, 1.2, .9], [1.5, -.2, 2.1], [-2, -1.3, .4]]];
  const points: V3[] = [a, b, c, [.4, .6, 0], [.4, .6, .25], [1, -.1, 0], [-.1, 1, 0], [1.1, 1.1, .1], [-1, -1, 0], [3, 0, 0], [0, 3, 0]];
  // Fixed integer PRNG supplies arbitrary orientations and distances without a random test seed.
  let seed = 0x1badf00d;
  const next = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return (seed >>> 0) / 0x100000000 * 8 - 4; };
  for (let i = 0; i < 128; i++) points.push([next(), next(), next()]);
  for (const corners of triangles) {
    const triangle = new Triangle(...corners.map(v => new Vector3(...v)) as [Vector3, Vector3, Vector3]);
    // Nonzero indices check the same packed-array interface used by collision queries.
    const packed = Float64Array.of(99, ...corners.flat());
    for (const point of points) {
      const p = new Vector3(...point), closest = triangle.closestPointToPoint(p, new Vector3());
      const expected = closest.distanceToSquared(p), actual = pointTriangleDistanceSquared(point, packed, 1, 4, 7);
      expect(actual).toBe(expected);
      for (const radius of [0, .25, 1, 3]) expect(actual < radius ** 2).toBe(expected < radius ** 2);
    }
  }
});
it('dents a sparse armor panel locally without changing the shared source or its far edges', () => {
  const s = shape(0); plate(s, [0, 0, 0], [2, .1, 2]); const part = finish(s, 'plate', 'hull', 0), original = part.positions.slice();
  const fractured = fractureArmor(part, [mark]);
  expect(part.positions).toEqual(original); expect(fractured.indices.length).toBeGreaterThan(part.indices.length);
  expect(fractured.positions.every(Number.isFinite)).toBe(true); expect(fractured.normals.every(Number.isFinite)).toBe(true);
  const top = Array.from(fractured.positions).filter((v, i) => i % 3 === 1 && Math.abs(fractured.positions[i - 1]) < .1 && Math.abs(fractured.positions[i + 1]) < .1);
  expect(top.some(y => y < .04 && y > -.04)).toBe(true);
  expect(Math.max(...fractured.indices)).toBeLessThan(fractured.positions.length / 3);
  expect(fractured.positions.length).toBeLessThan(50_000);
  expect(armorSplinters(mark)).toHaveLength(5);
});
it('preserves smooth normals, material coordinates and attributes outside the impact', () => {
  const s = shape(0); plate(s, [0, 0, 0], [2, .1, 2]); const part = finish(s, 'plate', 'hull', 0);
  part.normals.fill(.57735); part.partLocal.fill(42);
  const unchanged = fractureArmor(part, [{ ...mark, position: [12, 12, 12] }]);
  for (let i = 0; i < part.indices.length; i++) {
    const source = part.indices[i];
    expect(unchanged.normals.slice(i * 3, i * 3 + 3)).toEqual(part.normals.slice(source * 3, source * 3 + 3));
    expect(unchanged.partLocal.slice(i * 3, i * 3 + 3)).toEqual(part.partLocal.slice(source * 3, source * 3 + 3));
    expect(unchanged.attrs[i]).toBe(part.attrs[source]);
  }
});
it('emits smoke at machinery, escalates to fire, and retires old/recycled wreck sources', () => {
  const t = { id: 3, generation: 2, health: 45, maxHealth: 100, position: [0, 18, 0], rotation: [0, 0, 0, 1] } as TankState;
  expect(vehicleFireSource(t, 0)?.burning).toBe(false);
  t.health = 20; expect(vehicleFireSource(t, 0)?.burning).toBe(true);
  expect(vehicleFireSource(t, 0)?.key).toBe('vehicle:3:2');
  t.health = 0; t.destroyedAt = 0; expect(vehicleFireSource(t, 1600)).toBeNull();
  t.health = 100; t.destroyedAt = undefined; t.generation = 3; expect(vehicleFireSource(t, 1600)).toBeNull();
});
