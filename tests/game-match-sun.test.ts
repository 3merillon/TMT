// Integrator (wave-1 merge): the match sun the facade passes as FrameInput.sun (view.ts matchSun).
import { describe, expect, it } from 'vitest';
import { DAY_SECONDS, matchSun, moonAtTime, MOON_LUNATION_DAYS, sunAtTime } from '../src/game/view';

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('match sun', () => {
  it('stands 40 degrees above the observed spawn, on a unit vector, for any spawn direction', () => {
    for (const spawn of [[0, 18.4, 0], [0, -18.2, 0], [12, 9, -8], [1e-3, 0, 18]]) {
      const sun = matchSun(spawn, 7);
      const l = Math.hypot(...spawn), up = spawn.map(v => v / l);
      expect(Math.hypot(...sun)).toBeCloseTo(1, 12);
      expect(Math.asin(dot(sun, up)) * 180 / Math.PI).toBeCloseTo(40, 9);
    }
  });

  it('is a pure function of the spawn and the seed (the azimuth varies by seed)', () => {
    expect(matchSun([0, 18.4, 0], 7)).toEqual(matchSun([0, 18.4, 0], 7));
    expect(matchSun([0, 18.4, 0], 7)).not.toEqual(matchSun([0, 18.4, 0], 8));
  });

  it('advances across the local horizon from simulation time without changing length', () => {
    const spawn = [0, 18.4, 0], initial = matchSun(spawn, 7);
    const later = sunAtTime(initial, spawn, 120);
    expect(sunAtTime(initial, spawn, 0)).toEqual(initial);
    expect(Math.hypot(...later)).toBeCloseTo(1, 12);
    expect(dot(later, spawn)).toBeLessThan(0);
    expect(sunAtTime(initial, spawn, 120)).toEqual(later);
  });

  it('runs the moon through its phases: full opposite the sun, then quarter, new and full again', () => {
    const spawn = [12, 9, -8], initial = matchSun(spawn, 3), lunation = MOON_LUNATION_DAYS * DAY_SECONDS;
    const elongation = (t: number) => dot(moonAtTime(initial, spawn, t), sunAtTime(initial, spawn, t));
    expect(elongation(0)).toBeCloseTo(-1, 9);
    expect(elongation(lunation / 4)).toBeCloseTo(0, 9);
    expect(elongation(lunation / 2)).toBeCloseTo(1, 9);
    expect(elongation(lunation)).toBeCloseTo(-1, 9);
    expect(Math.hypot(...moonAtTime(initial, spawn, 777))).toBeCloseTo(1, 12);
  });

  it('keeps the moon on its own tilted path rather than the sun\'s', () => {
    const spawn = [0, 18.4, 0], initial = matchSun(spawn, 7);
    // Half a local day later the sun has swept its path; the moon, tilted and lagging, is off that path.
    const sunPathNormal = [0, 1, 2].map(i => [spawn[1] * initial[2] - spawn[2] * initial[1], spawn[2] * initial[0] - spawn[0] * initial[2], spawn[0] * initial[1] - spawn[1] * initial[0]][i]);
    const n = Math.hypot(...sunPathNormal);
    expect(Math.abs(dot(moonAtTime(initial, spawn, DAY_SECONDS / 2), sunPathNormal) / n)).toBeGreaterThan(0.05);
  });
});
