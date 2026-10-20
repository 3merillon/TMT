import { describe, expect, it } from 'vitest';
import { createPlanetField, createPlanetSampler } from '../src/game/planet-field';
import type { Vec3 } from '../src/core/types';

describe('continuous sphere terrain profile', () => {
  it('is continuous across hemisphere planes and cube-face boundaries for many seeds', () => {
    for (let seed = 0; seed < 64; seed++) {
      const sample = createPlanetSampler(seed, true);
      for (const n of [[1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [1, 1, 0], [1, -1, 1], [-1, 1, -1]] as Vec3[]) {
        for (let a = 0; a < 3; a++) {
          const p: Vec3 = [...n], q: Vec3 = [...n]; p[a] += 1e-6; q[a] -= 1e-6;
          expect(Math.abs(sample(p).radius - sample(q).radius)).toBeLessThan(0.0001);
        }
      }
      expect(sample([0, 1, 0]).radius).toBeCloseTo(18.15, 10);
    }
  });
  it('keeps conservative interval bounds after domain warping', () => {
    for (let seed = 0; seed < 12; seed++) {
      const f = createPlanetField(seed, 1, true);
      for (let j = 0; j < 12; j++) {
        const p: Vec3 = [Math.sin(j * 2.4) * 18, Math.cos(j * 1.7) * 18, Math.sin(j * 0.7) * 18];
        const bounds = { min: p.map(x => x - 0.25) as Vec3, max: p.map(x => x + 0.25) as Vec3 };
        const [lo, hi] = f.range!(bounds);
        for (let k = 0; k < 8; k++) {
          const value = f.sample(p.map((x, a) => x + (k & (1 << a) ? 0.25 : -0.25)) as Vec3);
          expect(value).toBeGreaterThanOrEqual(lo); expect(value).toBeLessThanOrEqual(hi);
        }
      }
    }
  });
});
