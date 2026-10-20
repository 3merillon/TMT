import type { Vec3 } from '../../core/types';
import { createPlanetField, type PlanetType } from '../../game/planet-field';
import { generatePlanetStructures, structureVolume, validateStructures, type TerrainStructure } from '../../game/terrain-structures';
import { TERRAIN_BOUND } from '../../game/terrain-config';
import type { SourceBox } from './contracts';
import type { ResidentWorldInput } from './fixtures';
export type ResidentGameProfile = 'resident-f32-game-v1' | 'resident-f32-game-v2' | 'resident-f32-game-v3';

/** All scalar words are prepared globally on the shared lattice. A structure's
 * plane traces have finite support (one-cell collar in v2; two in v1). All
 * vertices of every tet intersecting that source retain the original samples, so its six-plane CSG is
 * unchanged there; remote planets are not subdivided by hundreds of infinite
 * construction planes. Neighboring tets still receive identical face samples. */
export function residentPlanet(seed: number, structures?: readonly TerrainStructure[], profile: ResidentGameProfile = 'resident-f32-game-v2', kind?: PlanetType): ResidentWorldInput {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid resident planet seed');
  const bounds = { min: [-TERRAIN_BOUND, -TERRAIN_BOUND, -TERRAIN_BOUND] as Vec3, max: [TERRAIN_BOUND, TERRAIN_BOUND, TERRAIN_BOUND] as Vec3 };
  const planet = createPlanetField(seed, 1, profile === 'resident-f32-game-v3', kind), sources: SourceBox[] = [];
  const accepted = validateStructures(structures ?? generatePlanetStructures(seed, undefined, profile === 'resident-f32-game-v3', kind));
  for (const structure of [...accepted].reverse()) {
    const volume = structureVolume(structure);
    const corners = Array.from({ length: 8 }, (_, mask) => [0, 1, 2].map(a => mask & (1 << a) ? volume.bounds.max[a] + 3.001 : volume.bounds.min[a] - 3.001) as Vec3);
    const collarScale = Math.max(1, ...volume.fields.flatMap(field => corners.map(p => -field.sample(p) / 3)));
    // Strictly positive beyond the collar (Chebyshev distance): the lattice samples only this box (plus a margin).
    const collar = profile === 'resident-f32-game-v1' ? 6.002 : 3.001;
    const support = { min: volume.bounds.min.map(v => v - collar) as Vec3, max: volume.bounds.max.map(v => v + collar) as Vec3 };
    const { min, max } = volume.bounds;
    sources.push({ id: structure.id, bounds: volume.bounds, material: structure.material, fields: volume.fields.map(field => ({ id: field.id, support, sample: p => {
      // Sampled at every lattice point of the support in each worker: no per-sample arrays.
      const distance = Math.max(Math.max(min[0] - p[0], p[0] - max[0]), Math.max(min[1] - p[1], p[1] - max[1]), Math.max(min[2] - p[2], p[2] - max[2]));
      const value = field.sample(p);
      // Every vertex of a side-3 tet intersecting the authored AABB is at most
      // 3 units outside it. Preserve those words exactly, make all more remote
      // words positive, and share the same samples across neighboring tets.
      // v1 remains available for exact replay of existing checkpoints.
      return profile === 'resident-f32-game-v1' ? Math.max(value, (distance - 6.002) * collarScale) : distance > 3.001 ? Math.max(1, value) : value;
    } })) });
  }
  // A small explicit protected core supplies foundations. Surface rock remains
  // destructible and can detach; neither source name nor component size anchors it.
  sources.push({ id: 'planet-core', bounds, material: 2, anchor: 'planet-core', fields: [{ id: 'planet-core', support: { min: [-6, -6, -6], max: [6, 6, 6] }, sample: p => Math.hypot(...p) - 6 }] });
  sources.push({ id: 'bedrock', bounds, material: 2, fields: [{ id: 'bedrock', surface: { kind: 'planet' }, sample: p => planet.sample(p) + 34 }] });
  sources.push({ id: 'planet', bounds, material: 1, fields: [{ id: 'planet', surface: { kind: 'planet' }, sample: planet.sample }] });
  return { name: `planet-${seed}${profile === 'resident-f32-game-v3' ? '-spherical' : ''}`, bounds, sources, cuts: [], planetCenter: [0, 0, 0], staticSurface: true, localConstruction: true, uniformRegions: profile !== 'resident-f32-game-v1' };
}
