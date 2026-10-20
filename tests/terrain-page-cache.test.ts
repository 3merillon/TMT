/** The page cache is keyed by a generator hash: PAGE_CACHE_VERSION embeds residentPlanet(7)'s, so a generator change
 * fails this test until the version is bumped (stale cached topology can never load). */
import { expect, it } from 'vitest';
import { generatorHash, PAGE_CACHE_VERSION, PLANET_7_GENERATOR_HASH } from '../src/gpu/terrain/page-cache';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { generatePlanetStructures } from '../src/game/terrain-structures';

it('changes PAGE_CACHE_VERSION whenever the residentPlanet(7) descriptors change', () => {
  const hash = generatorHash(residentPlanet(7));
  expect(hash, 'planet generation changed: update PLANET_7_GENERATOR_HASH (and so PAGE_CACHE_VERSION)').toBe(PLANET_7_GENERATOR_HASH);
  expect(PAGE_CACHE_VERSION).toContain(hash);
  expect(generatorHash(residentPlanet(7))).toBe(hash);
  expect(generatorHash(residentPlanet(8))).not.toBe(hash);
  expect(generatorHash(residentPlanet(7, undefined, 'resident-f32-game-v1'))).not.toBe(hash);
  const structures = generatePlanetStructures(7), moved = structures.map((s, i) => i ? s : { ...s, center: [s.center[0] + 0.5, s.center[1], s.center[2]] as typeof s.center });
  expect(generatorHash(residentPlanet(7, moved))).not.toBe(hash);
  const input = residentPlanet(7), planet = input.sources.find(s => s.id === 'planet')!, field = planet.fields![0];
  const perturbed = { ...input, sources: input.sources.map(s => s === planet ? { ...s, fields: [{ ...field, sample: (p: [number, number, number]) => field.sample(p) + 1e-3 }] } : s) };
  expect(generatorHash(perturbed)).not.toBe(hash);
});
