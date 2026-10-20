/**
 * Sun defaults (plan §4.11): a stable per-map sun direction and the per-planet sunset grade (atmo-post §2.6).
 *
 * Pure and deterministic (no wall clock, no Math.random, no GPU, no DOM), so the game and the engine can both import it.
 * The engine uses `defaultSun(seed, kind)` when `FrameInput.sun` is absent, and evaluates `sunsetGrade` per pixel on the
 * GPU with exactly these numbers (the WGSL mirror reads the grade from the atmosphere uniform).
 *
 * Why a CPU grade: a radius-18 planet has a Chapman factor of about 4.9, so grazing sun paths are short and a physical
 * sunset barely reddens. The grade multiplies the sun colour by a warm tint as cos(sun zenith) falls from `start` to 0,
 * and is applied identically in the LUT kernels, the lighting and (W3) the clouds so sky and ground agree.
 */

export type PlanetKind = 'temperate' | 'glacial' | 'dune' | 'volcanic';
export type Vec3 = [number, number, number];

/** Reference sun illuminance in scene units (plan §4.4). */
export const SUN_ILLUMINANCE = 20;

export interface SunDesc { dirToward: Vec3; illuminance: number }

/** Multiply the sun colour by mix(tint, 1, smoothstep(0, start, cosSun)); below the horizon the tint holds. */
export interface SunsetGrade { tint: Vec3; start: number }

export const SUNSET_GRADES: Readonly<Record<PlanetKind, SunsetGrade>> = {
  temperate: { tint: [1.0, 0.72, 0.45], start: 0.25 },
  glacial: { tint: [1.0, 0.8, 0.62], start: 0.2 },
  dune: { tint: [1.0, 0.66, 0.36], start: 0.3 },
  volcanic: { tint: [1.0, 0.52, 0.3], start: 0.35 },
};

/** Planet kind from a map seed (atmo-post §2.3: kind = seed & 3; 3 temperate, 2 glacial, 1 dune, 0 volcanic). */
export function planetKindFromSeed(seed: number): PlanetKind {
  return (['volcanic', 'dune', 'glacial', 'temperate'] as const)[(seed | 0) & 3];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** CPU mirror of the WGSL `sunset_grade(cos_sun)`. */
export function sunsetGrade(cosSun: number, grade: SunsetGrade): Vec3 {
  const w = smoothstep(0, Math.max(grade.start, 1e-4), cosSun);
  return [grade.tint[0] + (1 - grade.tint[0]) * w, grade.tint[1] + (1 - grade.tint[1]) * w, grade.tint[2] + (1 - grade.tint[2]) * w];
}

/** 32-bit integer hash (lowbias32), deterministic across platforms. */
export function hash32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

const KIND_SALT: Readonly<Record<PlanetKind, number>> = { temperate: 0x3c6ef372, glacial: 0xa54ff53a, dune: 0x510e527f, volcanic: 0x9b05688c };

/**
 * A stable per-map sun direction (unit vector toward the sun, planet-centred world frame). The same (seed, kind) always
 * gives the same bits. The elevation of the world vector is kept moderate (|y| ≤ 0.6) so both hemispheres of the usual
 * play latitudes get a readable day side and a terminator.
 */
export function defaultSun(seed: number, kind: PlanetKind): SunDesc {
  const h1 = hash32((seed | 0) ^ KIND_SALT[kind]);
  const h2 = hash32(h1 ^ 0x68e31da4);
  const azimuth = (h1 / 4294967296) * Math.PI * 2;
  const y = -0.25 + (h2 / 4294967296) * 0.85;
  const c = Math.sqrt(Math.max(0, 1 - y * y));
  return { dirToward: [c * Math.cos(azimuth), y, c * Math.sin(azimuth)], illuminance: SUN_ILLUMINANCE };
}
