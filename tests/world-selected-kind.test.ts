import { describe, expect, it, vi } from 'vitest';
import { createPlanetField, createPlanetSampler, planetNormalWGSL, planetType, PLANET_TYPES, resolvePlanetType } from '../src/game/planet-field';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { generatePlanetStructures } from '../src/game/terrain-structures';
import { TerrainPresentation } from '../src/game/presentation/terrain-module';
import type { Engine } from '../src/engine';
import type { Vec3 } from '../src/core/types';

describe('selected planet recipe', () => {
  const points: Vec3[] = [[18, 0, 0], [0, -18, 0], [9, 12, -8], [-13, 4, 7]];
  it('preserves historical auto generation and keeps all explicit choices independent of the random seed', () => {
    for (let seed = 0; seed < 16; seed++) {
      expect(resolvePlanetType(seed)).toBe(planetType(seed));
      const original = createPlanetSampler(seed, true), explicit = createPlanetSampler(seed, true, planetType(seed));
      for (const p of points) expect(explicit(p)).toEqual(original(p));
      for (const kind of PLANET_TYPES) expect(resolvePlanetType(seed, kind)).toBe(kind);
    }
    const radii = PLANET_TYPES.map(kind => points.map(createPlanetSampler(7, true, kind)).map(p => p.radius));
    expect(new Set(radii.map(values => JSON.stringify(values))).size).toBe(4);
    expect(createPlanetSampler(7, true, 'dune')(points[0])).not.toEqual(createPlanetSampler(5, true, 'dune')(points[0]));
  });
  it.each(PLANET_TYPES)('uses %s for both resident samples and conservative bounds', kind => {
    const field = createPlanetField(7, 1, true, kind);
    const resident = residentPlanet(7, [], 'resident-f32-game-v3', kind);
    const source = resident.sources.find(s => s.id === 'planet')!.fields![0];
    for (const p of points) {
      expect(source.sample(p)).toBe(field.sample(p));
      const bounds = { min: p.map(x => x - .2) as Vec3, max: p.map(x => x + .2) as Vec3 };
      const [lo, hi] = field.range!(bounds);
      expect(field.sample(p)).toBeGreaterThanOrEqual(lo); expect(field.sample(p)).toBeLessThanOrEqual(hi);
    }
    expect(generatePlanetStructures(7, 8, true, kind)).toEqual(generatePlanetStructures(7, 8, true, kind));
  });
  it('switches shaders, engine world (fluids, atmosphere, vegetation), and normals when kind changes at the same seed', async () => {
    const provide = vi.fn(), setPlanet = vi.fn(async () => {});
    const presentation = new TerrainPresentation({ services: { scene: { provide } }, setPlanet } as unknown as Engine);
    for (const kind of PLANET_TYPES) {
      await presentation.setSeed(7, true, kind);
      expect(provide).toHaveBeenLastCalledWith('terrainPlanetWGSL', planetNormalWGSL(7, true, kind));
      expect(setPlanet).toHaveBeenLastCalledWith({ seed: 7, kind, radius: 18 });
    }
    expect(setPlanet).toHaveBeenCalledTimes(4);
    await presentation.setSeed(7, true, 'temperate'); expect(setPlanet).toHaveBeenCalledTimes(4);
  });
});
