/** Broad, seed-stable landforms sized for the game's side-3 tetrahedral cells. */
import { nextDown, nextUp, sphere } from '../core/fields';
import type { Bounds, Field, Vec3 } from '../core/types';
import { TERRAIN_RADIUS } from './terrain-config';

export const PLANET_GENERATOR = 'tmt-planet-v3' as const;
export const PLANET_TYPES = ['volcanic', 'dune', 'glacial', 'temperate'] as const;
export type PlanetType = typeof PLANET_TYPES[number];
export function planetType(seed: number): PlanetType { return PLANET_TYPES[seed >>> 0 & 3]; }
/** Explicit recipes keep the seed's random phases; auto and old saves keep the historical mapping. */
export function resolvePlanetType(seed: number, kind: PlanetType | 'auto' = 'auto'): PlanetType {
  return kind === 'auto' ? planetType(seed) : kind;
}
export interface PlanetLandform {
  /** Analytic radius before tetrahedral interpolation; collision always uses committed triangles. */
  radius: number;
  elevation: number;
  continent: number;
  mountain: number;
  drainage: number;
  basin: number;
  landing: number;
}

interface Arithmetic<T> {
  constant(value: number): T;
  add(a: T, b: T): T;
  multiply(a: T, b: T): T;
  sin(a: T): T;
  abs(a: T): T;
  smooth(lo: number, hi: number, a: T): T;
}
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const smooth = (lo: number, hi: number, x: number): number => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
const scalar: Arithmetic<number> = { constant: x => x, add: (a, b) => a + b, multiply: (a, b) => a * b,
  sin: Math.sin, abs: Math.abs, smooth };

type Interval = [number, number];
const enclose = (lo: number, hi: number): Interval => [nextDown(lo), nextUp(hi)];
const interval: Arithmetic<Interval> = {
  constant: x => [x, x],
  add: (a, b) => enclose(a[0] + b[0], a[1] + b[1]),
  multiply: (a, b) => {
    const products = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
    return enclose(Math.min(...products), Math.max(...products));
  },
  sin: ([lo, hi]) => {
    if (hi - lo >= 2 * Math.PI) return [-1, 1];
    let minimum = Math.min(Math.sin(lo), Math.sin(hi)), maximum = Math.max(Math.sin(lo), Math.sin(hi));
    if (Math.ceil((lo - Math.PI / 2) / (2 * Math.PI)) <= Math.floor((hi - Math.PI / 2) / (2 * Math.PI))) maximum = 1;
    if (Math.ceil((lo + Math.PI / 2) / (2 * Math.PI)) <= Math.floor((hi + Math.PI / 2) / (2 * Math.PI))) minimum = -1;
    // Allow ordinary JS libm rounding, in addition to directed arithmetic rounding.
    return [Math.max(-1, nextDown(minimum - 32 * Number.EPSILON)), Math.min(1, nextUp(maximum + 32 * Number.EPSILON))];
  },
  abs: ([lo, hi]) => enclose(lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi)), Math.max(Math.abs(lo), Math.abs(hi))),
  smooth: (lo, hi, a) => [Math.max(0, nextDown(smooth(lo, hi, a[0]) - 32 * Number.EPSILON)),
    Math.min(1, nextUp(smooth(lo, hi, a[1]) + 32 * Number.EPSILON))],
};

/** One expression is evaluated with both Numbers and intervals, so pruning cannot drift from generation. */
function landforms<T>(n: [T, T, T], phases: number[], arithmetic: Arithmetic<T>, type: PlanetType = 'temperate', spherical = false): {
  elevation: T; continent: T; mountain: T; drainage: T; basin: T; landing: T;
} {
  const { constant: c, add, multiply: mul, sin, abs, smooth: s } = arithmetic;
  const scale = (a: T, amount: number): T => mul(a, c(amount));
  const plus = (a: T, amount: number): T => add(a, c(amount));
  const inverse = (a: T): T => plus(scale(a, -1), 1);
  const frequency = type === 'volcanic' ? 1.35 : type === 'glacial' ? 1.15 : type === 'dune' ? .8 : 1;
  // Cartesian domain warp on the unit sphere: no latitude/longitude wrapping,
  // hemisphere selection, or cube-face discontinuity. Legacy profiles replay unchanged.
  const domain: [T, T, T] = spherical ? [
    add(n[0], scale(sin(plus(add(scale(n[1], 3.7), scale(n[2], 2.3)), phases[3])), 0.10)),
    add(n[1], scale(sin(plus(add(scale(n[2], 3.1), scale(n[0], -2.7)), phases[5])), 0.10)),
    add(n[2], scale(sin(plus(add(scale(n[0], 3.3), scale(n[1], 2.9)), phases[6])), 0.10)),
  ] : n;
  const wave = (x: number, y: number, z: number, phase: number): T =>
    sin(plus(add(add(scale(domain[0], x * frequency), scale(domain[1], y * frequency)), scale(domain[2], z * frequency)), phases[phase]));
  const continental = add(add(scale(wave(2.1, .7, -.8, 0), .60), scale(wave(-.8, 2.3, 1.2, 1), .27)), scale(wave(1.2, -.4, 2.5, 2), .13));
  const shelf = s(-.38, .05, continental), continent = s(-.05, .38, continental);
  const basin = inverse(shelf);
  let elevation = add(plus(scale(shelf, 2.6), -2.6), scale(continent, 1.15));
  elevation = add(elevation, scale(mul(wave(3.2, -1.7, 2.2, 3), continent), .30));
  elevation = add(elevation, scale(mul(wave(2.7, 1.3, -2.2, 5), basin), .25));

  // Long folded belts instead of independent noise bumps. The secondary wave breaks up their crests.
  const fold = sin(add(plus(add(add(scale(n[0], 2.9), scale(n[1], -1.6)), scale(n[2], 2.1)), phases[4]), scale(wave(4.1, .6, 2.3, 5), .32)));
  const belt = inverse(s(.05, .72, abs(fold)));
  const mountain = mul(mul(continent, belt), plus(scale(wave(5, 1.3, -3.2, 6), .28), .72));
  elevation = add(elevation, scale(mountain, type === 'dune' ? 1.65 : type === 'glacial' ? 2.85 : 3.35));
  // Subordinate, continuous ridges become visible as the visual octree refines.
  const detail = mul(mul(mul(wave(21, -13, 17, 3), wave(-11, 19, 9, 6)), continent), spherical ? c(1) : inverse(s(.65, .79, n[1])));
  elevation = add(elevation, scale(detail, type === 'dune' ? .16 : .10));

  // Broad incised channels are a terrain-shaping approximation, not simulated hydrology or erosion.
  const river = sin(add(plus(add(add(scale(n[0], 2.5), scale(n[1], 1.1)), scale(n[2], -2.2)), phases[7]), scale(wave(2.4, 3.1, 1.3, 8), .45)));
  const drainage = mul(inverse(s(.03, .30, abs(river))), shelf);
  elevation = add(elevation, scale(drainage, type === 'dune' ? -.35 : type === 'volcanic' ? -.65 : -.95));

  // A gently curved landing plain protects the initial duel; its transition remains smooth.
  // The old product of X/Z bands made a rectangular shelf with long straight
  // shoulders. A broad, softly warped spherical cap keeps spawn space dry.
  const cap = add(n[1], scale(mul(wave(4.2, 1.1, 3.6, 8), inverse(s(.82, .93, n[1]))), .035));
  const landing = spherical ? s(.60, .93, cap)
    : mul(mul(s(.79, .91, n[1]), inverse(s(.36, .56, abs(n[0])))), inverse(s(.20, .37, abs(n[2]))));
  elevation = add(mul(elevation, inverse(landing)), scale(landing, .15));
  return { elevation, continent, mountain: mul(mountain, inverse(landing)), drainage: mul(drainage, inverse(landing)),
    basin: mul(basin, inverse(landing)), landing };
}

function seedPhases(seed: number): number[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Planet seed must be an unsigned 32-bit integer.');
  let state = seed >>> 0;
  return Array.from({ length: 9 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 * 2 * Math.PI;
  });
}

/** Generate analytic fragment derivatives from the same expression as density/range evaluation.
 * Dual numbers carry elevation in x and its direction-space derivative in yzw. */
export function planetNormalWGSL(seed: number, spherical = false, kind: PlanetType = planetType(seed)): string {
  const lines: string[] = [];
  const emit = (expression: string): string => {
    const name = `v${lines.length}`; lines.push(`let ${name} = ${expression};`); return name;
  };
  const literal = (v: number): string => Number.isInteger(v) ? `${v}.0` : `${v}`;
  const arithmetic: Arithmetic<string> = {
    constant: x => `vec4<f32>(${literal(x)}, 0.0, 0.0, 0.0)`,
    add: (a, b) => emit(`${a} + ${b}`),
    multiply: (a, b) => emit(`tmt_dual_mul(${a}, ${b})`),
    sin: a => emit(`vec4<f32>(sin(${a}.x), cos(${a}.x) * ${a}.yzw)`),
    abs: a => emit(`vec4<f32>(abs(${a}.x), sign(${a}.x) * ${a}.yzw)`),
    smooth: (lo, hi, a) => emit(`tmt_dual_smooth(${literal(lo)}, ${literal(hi)}, ${a})`),
  };
  const value = landforms(['vec4<f32>(n.x, 1.0, 0.0, 0.0)', 'vec4<f32>(n.y, 0.0, 1.0, 0.0)',
    'vec4<f32>(n.z, 0.0, 0.0, 1.0)'], seedPhases(seed), arithmetic, kind, spherical).elevation;
  return /* wgsl */ `
fn tmt_dual_mul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(a.x * b.x, a.yzw * b.x + b.yzw * a.x);
}

fn tmt_dual_smooth(lo: f32, hi: f32, a: vec4<f32>) -> vec4<f32> {
  let t = clamp((a.x - lo) / (hi - lo), 0.0, 1.0);
  return vec4<f32>(t * t * (3.0 - 2.0 * t), a.yzw * (6.0 * t * (1.0 - t) / (hi - lo)));
}
fn tmt_planet_normal(p: vec3<f32>) -> vec3<f32> {
  let r = max(length(p), 0.001);
  let n = p / r;
  ${lines.join('\n  ')}
  let elevation = ${value};
  let tangent = (elevation.yzw - n * dot(n, elevation.yzw)) / r;
  return normalize(p - (${TERRAIN_RADIUS.toFixed(1)} + elevation.x) * tangent);
}
`;
}

/** Capture the seed once when sampling many positions (for example biome/authoring diagnostics). */
export function createPlanetSampler(seed = 7, spherical = false, kind: PlanetType = planetType(seed)): (position: Vec3) => PlanetLandform {
  const phases = seedPhases(seed);
  return position => {
    const length = Math.hypot(...position);
    const direction: Vec3 = length > 1e-12 ? position.map(v => v / length) as Vec3 : [0, 1, 0];
    const sample = landforms(direction, phases, scalar, kind, spherical);
    return { ...sample, radius: TERRAIN_RADIUS + sample.elevation };
  };
}
export const samplePlanetLandform = (position: Vec3, seed = 7): PlanetLandform => createPlanetSampler(seed)(position);

/** Radial density composed as one TMT primitive; fortifications and edits retain separate identities. */
export function createPlanetField(seed = 7, material = 1, spherical = false, kind: PlanetType = planetType(seed)): Field {
  const phases = seedPhases(seed), sampleLandform = createPlanetSampler(seed, spherical, kind);
  const radial = sphere('radial-bound', [0, 0, 0], TERRAIN_RADIUS);
  const density = (p: Vec3): number => p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - sampleLandform(p).radius ** 2;
  // The fixed side-3 grid repeatedly visits the same global half-cell samples in adjacent bricks.
  // Cache only exact lattice coordinates; arbitrary queries and shading gradients retain the analytic path.
  const latticeSamples = new Float64Array(33 ** 3).fill(NaN);
  const sample = (p: Vec3): number => {
    const x = p[0] / 1.5 + 16, y = p[1] / 1.5 + 16, z = p[2] / 1.5 + 16;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || x < 0 || y < 0 || z < 0 || x > 32 || y > 32 || z > 32) return density(p);
    const index = x + 33 * (y + 33 * z), cached = latticeSamples[index];
    if (!Number.isNaN(cached)) return cached;
    return latticeSamples[index] = density(p);
  };
  const rangeCache = new Map<string, Interval>();
  const computeRange = (bounds: Bounds): Interval => {
    const radius2 = radial.range!(bounds).map(v => v + TERRAIN_RADIUS ** 2) as Interval;
    const near = Math.sqrt(Math.max(0, radius2[0])), far = Math.sqrt(Math.max(0, radius2[1]));
    const directions = bounds.min.map((lo, i) => {
      if (near < 1e-10) return [-1, 1] as Interval;
      const divisions = [lo / near, lo / far, bounds.max[i] / near, bounds.max[i] / far];
      return [Math.max(-1, nextDown(Math.min(...divisions) - 32 * Number.EPSILON)),
        Math.min(1, nextUp(Math.max(...divisions) + 32 * Number.EPSILON))] as Interval;
    }) as [Interval, Interval, Interval];
    const elevation = landforms(directions, phases, interval, kind, spherical).elevation;
    // Independent global bounds also apply when interval dependency widens an expression.
    const lo = Math.max(-3.96, elevation[0]), hi = Math.min(4.96, elevation[1]);
    const padding = 4096 * Number.EPSILON * (1 + radius2[1] + (TERRAIN_RADIUS + hi) ** 2);
    return enclose(radius2[0] - (TERRAIN_RADIUS + hi) ** 2 - padding,
      radius2[1] - (TERRAIN_RADIUS + lo) ** 2 + padding);
  };
  const range = (bounds: Bounds): Interval => {
    const key = `${bounds.min.join(',')}/${bounds.max.join(',')}`;
    let value = rangeCache.get(key);
    if (!value) { value = computeRange(bounds); rangeCache.set(key, value); }
    return [...value];
  };
  return {
    id: 'planet', name: 'Continental planet', material, sample, range,
    // Any convex interpolant and the true value lie in the same conservative field range.
    // This deliberately loose bound cannot certify adaptive convergence; fixed game cells use it safely.
    interpolationError: bounds => { const [lo, hi] = range(bounds); return nextUp(hi - lo); },
    gradient: p => {
      const epsilon = .002;
      return p.map((_, axis) => {
        const a: Vec3 = [...p], b: Vec3 = [...p]; a[axis] += epsilon; b[axis] -= epsilon;
        return (density(a) - density(b)) / (2 * epsilon);
      }) as Vec3;
    },
  };
}
