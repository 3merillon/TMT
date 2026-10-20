import { describe, expect, it } from 'vitest';
import { generatePlanetStructures, validateStructures } from '../src/game/terrain-structures';
import { createPlanetSampler, planetType } from '../src/game/planet-field';

describe('procedural planet identities and structures', () => {
  it('reproduces four planet types and finite structure layouts across the seed domain', () => {
    expect([0, 1, 2, 3].map(planetType)).toEqual(['volcanic', 'dune', 'glacial', 'temperate']);
    for (const seed of [0, 1, 2, 3, 7, 42, 987654321, 0xffffffff]) {
      expect(generatePlanetStructures(seed)).toEqual(generatePlanetStructures(seed));
      expect(createPlanetSampler(seed)([1, -1, 2])).toEqual(createPlanetSampler(seed)([2, -2, 4]));
    }
    for (let seed = 0; seed < 500; seed++) {
      const generated = generatePlanetStructures(seed);
      expect(generated).toHaveLength(36 + seed % 13);
      expect(generated.some(s => s.id === 'landing-wall')).toBe(false);
      expect(generated.some(s => s.center[1] < -8)).toBe(true);
      expect(generated.some(s => s.center[1] > 8)).toBe(true);
      // Leave a generous north-pole spawn zone clear.
      expect(generated.every(s => s.center[1] / Math.hypot(...s.center) < .94)).toBe(true);
    }
    const many = generatePlanetStructures(91, 128);
    expect(new Set(many.map(s => s.id)).size).toBe(128);
    expect(validateStructures([])).toEqual([]);
    expect(() => validateStructures([many[0], many[0]])).toThrow(/duplicate/);
    expect(() => validateStructures([{ ...many[1], axes: [[1, 0, 0], [1, 0, 0], [0, 0, 1]] }])).toThrow(/orthonormal/);
  });

  it('returns validated copies, so later edits to the authored input never reach a match', () => {
    const structures = generatePlanetStructures(91, 16);
    const validated = validateStructures(structures);
    expect(validated).toEqual(structures);
    structures[0].center[0] = 999;
    expect(validated[0].center[0]).not.toBe(999);
    expect(() => validateStructures([{ ...structures[1], halfSize: [1, 0, 1] }])).toThrow(/Invalid/);
    expect(() => validateStructures('not a list')).toThrow(/Invalid/);
  });
});
