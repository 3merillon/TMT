import { describe, it, expect } from 'vitest';
import { volumeLightInterval, volumeLightSamples } from '../src/engine/passes/volumetrics/local-quadrature';
import type { Vec3 } from '../src/engine/contracts';

const axis: Vec3 = [0, 0, 1], outer = Math.cos(.48), unit = (v: Vec3) => v.map(x => x / Math.hypot(...v)) as Vec3;
describe('finite local haze quadrature', () => {
  it('clips inside, parallel, tangent, backwards and scene-occluded rays conservatively', () => {
    expect(volumeLightInterval([0, 0, 1], axis, axis, 6.5, outer, true, [0, 100])).toEqual([0, 5.5]);
    expect(volumeLightInterval([0, 0, -1], [0, 0, -1], axis, 6.5, outer, true, [0, 100])).toEqual([0, 0]);
    const empty = volumeLightInterval([7, 0, 0], axis, axis, 6.5, outer, true, [0, 100]); expect(empty[1]).toBeLessThanOrEqual(empty[0]);
    expect(volumeLightInterval([6.5, 0, 0], axis, axis, 6.5, outer, true, [0, 100])).toEqual([0, 0]);
    expect(volumeLightInterval([0, 0, 1], axis, axis, 6.5, outer, true, [0, .2])).toEqual([0, .2]);
    const tangent = unit([Math.sin(.48), 0, Math.cos(.48)]);
    const parallel = volumeLightInterval([0, 0, 1], tangent, axis, 6.5, outer, true, [0, 100]); expect(parallel[0]).toBe(0); expect(parallel[1]).toBeGreaterThan(0);
    expect(volumeLightInterval([0, 0, -1], [0, 0, -1], axis, 6.5, -.1, true, [0, 100])).toEqual([0, 5.5]);
  });
  it('matches dense direct cone membership across non-axis-aligned rays', () => {
    for (let k = 0; k < 240; k++) {
      const o: Vec3 = [Math.sin(k * 2.3) * 8, Math.cos(k * 1.7) * 5, Math.sin(k * .73) * 8], rd = unit([Math.sin(k * 1.11) + .01, Math.cos(k * .81), Math.sin(k * 1.91)]);
      const span = volumeLightInterval(o, rd, axis, 6.5, outer, true, [0, 15]);
      for (let j = 0; j < 300; j++) {
        const t = (j + .37) * 15 / 300, p = o.map((v, i) => v + rd[i] * t), length = Math.hypot(...p);
        const physical = length < 6.5 && p[2] > outer * length;
        expect(t > span[0] && t < span[1], `ray${k} t${t}`).toBe(physical);
      }
    }
  });
  it('is independent of distant background and stable when crossing a source axis', () => {
    const o: Vec3 = [-2, .1, 1], rd: Vec3 = [1, 0, 0];
    const near = volumeLightInterval(o, rd, axis, 6.5, outer, true, [0, 8]), far = volumeLightInterval(o, rd, axis, 6.5, outer, true, [0, 90]);
    expect(far).toEqual(near); expect(volumeLightSamples(o, rd, far, 12)).toEqual(volumeLightSamples(o, rd, near, 12));
    for (const epsilon of [0, 1e-9, -1e-9, .001]) for (const [t, w] of volumeLightSamples([epsilon, 0, -1], axis, [1, 7.5], 12)) {
      expect(Number.isFinite(t + w)).toBe(true); expect(w).toBeGreaterThan(0); expect(t).toBeGreaterThan(1); expect(t).toBeLessThan(7.5);
    }
  });
  it('resolves near-source cone energy against dense integration without changing radiance', () => {
    const falloff = (d2: number) => { const r = d2 / (6.5 * 6.5), window = Math.max(0, 1 - r * r); return window * window / Math.max(d2, .09); };
    const integrand = (o: Vec3, rd: Vec3, t: number) => {
      const p = o.map((v, i) => v + rd[i] * t), d2 = p.reduce((s, v) => s + v * v, 0), c = p[2] / Math.sqrt(d2);
      const cone = Math.max(0, Math.min(1, (c - outer) / (Math.cos(.22) - outer)));
      return falloff(d2) * cone * cone;
    };
    for (const lateral of [.02, .15, .3, .6, 1.5]) {
      const o: Vec3 = [lateral, 0, -2], rd = axis, span = volumeLightInterval(o, rd, axis, 6.5, outer, true, [0, 90]);
      const n = 30000, ds = (span[1] - span[0]) / n; let reference = 0;
      for (let i = 0; i < n; i++) reference += integrand(o, rd, span[0] + (i + .5) * ds) * ds;
      const estimate = volumeLightSamples(o, rd, span, 12).reduce((sum, [t, w]) => sum + integrand(o, rd, t) * w, 0);
      expect(Math.abs(estimate / reference - 1), `lateral${lateral}`).toBeLessThan(.055);
    }
  });
});
