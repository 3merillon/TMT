import { describe, expect, it } from 'vitest';
import { Placed, pointBoxDistance, segmentBoxDistance } from '../src/game/kit/geometry/convex';
import { gjkDistance } from '../src/game/kit/geometry/gjk';
import { Shape, box as makeBox, mm, rx, ry, tr } from '../src/game/kit/geometry/shapes';

describe('conservative capsule broad phase', () => {
  const box = Float64Array.of(-1, -1, -1, 1, 1, 1);
  it('handles touching, crossing, parallel and zero-length segments', () => {
    expect(segmentBoxDistance([-2, 0, 0], [2, 0, 0], box)).toBe(0);
    expect(segmentBoxDistance([-2, 1, 0], [2, 1, 0], box)).toBe(0);
    expect(segmentBoxDistance([-2, 2, 0], [2, 2, 0], box)).toBeCloseTo(1, 10);
    expect(segmentBoxDistance([2, 2, 2], [2, 2, 2], box)).toBeCloseTo(Math.sqrt(3), 10);
    expect(segmentBoxDistance([-2, 2, 2], [2, 2, 2], box)).toBeCloseTo(Math.sqrt(2), 10);
  });
  it('matches an independent high-accuracy minimizer without overestimating the gap', () => {
    let seed = 81723;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    for (let sample = 0; sample < 800; sample++) {
      const a = Array.from({ length: 3 }, () => random() * 8 - 4), b = Array.from({ length: 3 }, () => random() * 8 - 4);
      const distance = (t: number) => pointBoxDistance(...a.map((v, k) => v + (b[k] - v) * t) as [number, number, number], box);
      let lo = 0, hi = 1;
      for (let i = 0; i < 80; i++) { const u = (2 * lo + hi) / 3, v = (lo + 2 * hi) / 3; if (distance(u) < distance(v)) hi = v; else lo = u; }
      const expected = Math.min(distance(0), distance(1), distance((lo + hi) / 2)), actual = segmentBoxDistance(a, b, box);
      expect(actual).toBeLessThanOrEqual(expected + 1e-12);
      expect(actual).toBeCloseTo(expected, 9);
      expect(segmentBoxDistance(b, a, box)).toBeCloseTo(actual, 9);
    }
  });
});

it('keeps GJK distances and early separation bounds exact under common rigid transforms', () => {
  let seed = 15637;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let i = 0; i < 240; i++) {
    const dimensions = () => [.05 + random() * 2, .05 + random() * 2, .05 + random() * 2] as [number, number, number];
    const sizeA = dimensions(), sizeB = dimensions(), center = [random() * 5 - 2.5, random() * 5 - 2.5, random() * 5 - 2.5] as [number, number, number];
    const a = new Shape(), b = new Shape(); makeBox(a, null, sizeA); makeBox(b, tr(...center), sizeB);
    const frame = mm(tr(random(), random(), random()), rx(random() * 6), ry(random() * 6));
    const pa = new Placed(a.hulls[0]).set(frame), pb = new Placed(b.hulls[0]).set(frame);
    const gaps = center.map((c, k) => Math.max(0, Math.abs(c) - (sizeA[k] + sizeB[k]) / 2)), expected = Math.hypot(...gaps);
    expect(gjkDistance(pa, pb)).toBeCloseTo(expected, 7);
    expect(gjkDistance(pb, pa)).toBeCloseTo(expected, 7);
    const threshold = random() * .3, reported = gjkDistance(pa, pb, threshold);
    expect(reported).toBeLessThanOrEqual(expected + 1e-7);
    expect(reported > threshold).toBe(expected > threshold);
  }
});
