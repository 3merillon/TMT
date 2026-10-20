import { describe, expect, it } from 'vitest';
import { CRATER_CENTER_LIFT, CRATER_RADIUS_SCALE, craterProfile } from '../src/game/rules/crater';
import { MAX_TERRAIN_BLAST_RADIUS, MIN_TERRAIN_BLAST_RADIUS } from '../src/game/terrain-config';
import type { V3 } from '../src/game/contracts';

describe('craterProfile (lifted-centre crater)', () => {
  it('scales the radius by 1.3 and lifts the centre along the unit normal by 0.55 R′', () => {
    expect(CRATER_RADIUS_SCALE).toBe(1.3);
    expect(CRATER_CENTER_LIFT).toBe(0.55);
    const { center, radius } = craterProfile([0, 18, 0], [0, 1, 0], 2);
    expect(radius).toBeCloseTo(2.6, 12);
    expect(center[0]).toBe(0);
    expect(center[1]).toBeCloseTo(18 + 0.55 * 2.6, 12);
    expect(center[2]).toBe(0);
  });

  it('normalises the normal, so its length never changes the lift', () => {
    const hit: V3 = [3, -4, 12], normal: V3 = [1, 2, -2], unit = normal.map(v => v / 3) as V3;
    const scaled = craterProfile(hit, [10, 20, -20], 4), exact = craterProfile(hit, unit, 4);
    expect(scaled.radius).toBeCloseTo(5.2, 12);
    for (let a = 0; a < 3; a++) {
      expect(scaled.center[a]).toBeCloseTo(hit[a] + unit[a] * 0.55 * 5.2, 12);
      expect(scaled.center[a]).toBeCloseTo(exact.center[a], 12);
    }
    const lift = Math.hypot(...scaled.center.map((v, a) => v - hit[a]));
    expect(lift).toBeCloseTo(0.55 * 5.2, 12);
  });

  it('accepts the whole valid range, cuts narrow blasts at the terrain minimum and rejects invalid radii explicitly', () => {
    expect(craterProfile([0, 0, 18], [0, 0, 1], MIN_TERRAIN_BLAST_RADIUS).radius).toBeCloseTo(1.3 * MIN_TERRAIN_BLAST_RADIUS, 12);
    expect(craterProfile([0, 0, 18], [0, 0, 1], 9.2).radius).toBeCloseTo(11.96, 12);
    // The scout autocannon's 1.25 blast: the smallest crater the terrain can cut, not a throw mid-match.
    expect(craterProfile([0, 0, 18], [0, 0, 1], 1.25)).toEqual(craterProfile([0, 0, 18], [0, 0, 1], MIN_TERRAIN_BLAST_RADIUS));
    expect(() => craterProfile([0, 0, 18], [0, 0, 1], MAX_TERRAIN_BLAST_RADIUS / 1.3 + 1e-6)).toThrow(/exceeds the maximum/);
    expect(() => craterProfile([0, 0, 18], [0, 0, 1], 10)).toThrow(/exceeds the maximum/);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -3, 0]) expect(() => craterProfile([0, 0, 18], [0, 0, 1], bad)).toThrow();
  });

  it('rejects degenerate normals and non-finite hit points', () => {
    expect(() => craterProfile([0, 18, 0], [0, 0, 0], 3)).toThrow(/normal/);
    expect(() => craterProfile([0, 18, 0], [Number.NaN, 1, 0], 3)).toThrow(/normal/);
    expect(() => craterProfile([0, Number.POSITIVE_INFINITY, 0], [0, 1, 0], 3)).toThrow(/hit point/);
  });

  it('is deterministic and pure: identical inputs give bit-identical outputs and inputs stay untouched', () => {
    const hit: V3 = [1.234567891, 17.3, -2.5], normal: V3 = [0.1, 0.99, -0.07];
    const a = craterProfile(hit, normal, 2.75), b = craterProfile([...hit], [...normal], 2.75);
    expect(Object.is(a.radius, b.radius)).toBe(true);
    expect(a.center.every((v, i) => Object.is(v, b.center[i]))).toBe(true);
    expect(hit).toEqual([1.234567891, 17.3, -2.5]);
    expect(normal).toEqual([0.1, 0.99, -0.07]);
    expect(a.center).not.toBe(hit);
  });
});
