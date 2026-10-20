/** Miniature-planet adaptation of Planets' shell/profile cloud design (MIT, same owner). */
import type { FrameState, PlanetDesc, QualityTier, Vec3 } from '../../contracts';
import { CLOUD_FIELD, CLOUD_FIELD_REGIONS } from './field';
import { wgslStruct } from '../../wgsl/module';

export interface CloudPreset {
  base: number; top: number; coverage: number; density: number; shapeScale: number;
  type: number; highLayer: number; wind: number; tint: Vec3;
}
/** Heights above the terrain datum, in TMT units. These are authored weather choices, not performance claims. */
export const CLOUD_PRESETS: Readonly<Record<PlanetDesc['kind'], CloudPreset>> = {
  temperate: { base: 3.2, top: 6.2, coverage: 0.58, density: 1.8, shapeScale: 0.055, type: 0.9, highLayer: 0.18, wind: 0.003, tint: [1, 0.99, 0.97] },
  glacial: { base: 3.8, top: 6.4, coverage: 0.49, density: 1.15, shapeScale: 0.07, type: 0.25, highLayer: 0.5, wind: 0.004, tint: [0.93, 0.97, 1] },
  dune: { base: 5, top: 7.2, coverage: 0.27, density: 0.6, shapeScale: 0.045, type: 0.1, highLayer: 0.7, wind: 0.0045, tint: [1, 0.88, 0.7] },
  volcanic: { base: 3.4, top: 6, coverage: 0.4, density: 1.6, shapeScale: 0.065, type: 0.65, highLayer: 0.12, wind: 0.0025, tint: [0.65, 0.59, 0.54] },
};
export const CLOUD_TIERS: Readonly<Record<QualityTier, { steps: number; lightSteps: number; shadowSize: number; shadowSteps: number }>> = {
  low: { steps: 20, lightSteps: 2, shadowSize: 48, shadowSteps: 12 },
  medium: { steps: 28, lightSteps: 3, shadowSize: 48, shadowSteps: 16 },
  high: { steps: 40, lightSteps: 4, shadowSize: 64, shadowSteps: 20 },
  ultra: { steps: 64, lightSteps: 5, shadowSize: 96, shadowSteps: 28 },
};
export const CLOUD_PARAMS_BYTES = 256;
export const CLOUD_VISIBILITY = { coreRadius: 9, feather: 5, opticalDepth: 0.18, flowStart: 0.05, flowEnd: 0.8, flowRelease: 0.6 } as const;
export type CloudImpactKind = 'blast' | 'incendiary' | 'nuclear';
export function cloudImpactProfile(radius: number, kind: CloudImpactKind = 'blast') {
  // Kept independent of gas.ts to avoid its lighting -> cloud shader import cycle.
  // Qualification checks these authored lifetimes/domains against GAS_PRESETS.
  return { lifetime: kind === 'nuclear' ? 14 : kind === 'incendiary' ? 13 : 6, domain: kind === 'nuclear' ? Math.min(34, radius * 5.8) : Math.min(40, radius * (kind === 'incendiary' ? 4.6 : 8)), kind: kind === 'nuclear' ? 2 : kind === 'incendiary' ? 1 : 0 };
}
export const CLOUD_PARAMS = wgslStruct('CloudParams', [
  ['shell', 'vec4f'], // solid radius, inner, outer, extinction
  ['weather', 'vec4f'], // coverage, shape scale, cumulus fraction, high layer
  ['wind', 'vec4f'], // the clouds' rotation by the wind so far, a unit quaternion (world = R · advected)
  ['sun', 'vec4f'], // toward sun xyz, illuminance
  ['tint', 'vec4f'], // cloud albedo, shadow minimum
  ['control', 'vec4f'], // valid, shadows, history reset, field gain g (multiplies every stored field value)
  ['quality', 'vec4f'], // view steps, sun steps, shadow steps, shadow dimension
  ['focus', 'vec4f'], // actual gameplay position, receiver visibility radius
  ['seed', 'vec4f'], // 3D noise offset xyz, time
  ['wind_prev', 'vec4f'], // last frame's rotation (history reprojection)
  ['field', 'vec4f'], // half extent H of the persistent field (u), padding of rays crossing damage, damaged regions, unused
  ['regions', { array: 'vec4f', count: CLOUD_FIELD_REGIONS }], // world centre + radius of each damaged region
  ['shock_control', 'vec4f'], // field updating this frame (1/0), local lighting, departure bound, unused
]);
export interface CloudControls { enabled: boolean; shadows: boolean; coverage: number; density: number; localLights?: boolean; quality?: QualityTier }
/** The wind's rotation of the deck (now and last frame) and the persistent field's state (field.ts). */
export interface CloudMotion {
  rotation: readonly number[]; previous: readonly number[];
  field?: { half: number; gain: number; regions: readonly (readonly number[])[]; updating: boolean };
}
export const CLOUD_STILL: CloudMotion = { rotation: [0, 0, 0, 1], previous: [0, 0, 0, 1] };
export function packCloudParams(planet: PlanetDesc, frame: FrameState, controls: CloudControls, reset: boolean, illuminance = 20, out?: ArrayBuffer, motion: CloudMotion = CLOUD_STILL): ArrayBuffer {
  const p = CLOUD_PRESETS[planet.kind], q = CLOUD_TIERS[controls.quality ?? frame.tier];
  const seed = planet.seed >>> 0;
  // A rotation preserves the spherical weather field and has no UV seam or wrapping discontinuity.
  const field = motion.field, regions = new Float32Array(CLOUD_FIELD_REGIONS * 4);
  const count = Math.min(CLOUD_FIELD_REGIONS, field?.regions.length ?? 0);
  for (let i = 0; i < count; i++) regions.set(field!.regions[i].slice(0, 4), i * 4);
  const padding = count > 0 ? CLOUD_FIELD.padding : 0;
  return CLOUD_PARAMS.pack({
    shell: [planet.radius, planet.radius + p.base, planet.radius + p.top, p.density * Math.max(0, controls.density)],
    weather: [Math.min(1, Math.max(0, p.coverage * controls.coverage)), p.shapeScale, p.type, p.highLayer],
    wind: [...motion.rotation], sun: [...frame.sunDir, illuminance], tint: [...p.tint, 0.38],
    control: [controls.enabled ? 1 : 0, controls.shadows ? 1 : 0, reset ? 1 : 0, field?.gain ?? 1],
    quality: [q.steps, q.lightSteps, q.shadowSteps, q.shadowSize], focus: [...frame.focus.world, CLOUD_VISIBILITY.coreRadius],
    seed: [(seed % 97) * 0.013, ((seed >>> 5) % 89) * 0.017, ((seed >>> 12) % 83) * 0.019, frame.time],
    wind_prev: [...motion.previous], field: [field?.half ?? 28, padding, count, 0], regions,
    shock_control: [field?.updating ? 1 : 0, controls.localLights === false ? 0 : 1, padding, 0],
  }, out);
}

export function cloudSphereInterval(origin: Vec3, direction: Vec3, radius: number): [number, number] | null {
  const b = origin.reduce((v, p, i) => v + p * direction[i], 0);
  const closest = origin.map((p, i) => p - direction[i] * b);
  const d = radius * radius - closest.reduce((s, v) => s + v * v, 0);
  if (d < 0) return null;
  const root = Math.sqrt(d); return [-b - root, -b + root];
}
/** Exact hollow shell chords, including a camera inside the deck and both bands of a limb ray. */
export function cloudShellIntervals(origin: Vec3, direction: Vec3, inner: number, outer: number, depth = Infinity): [number, number][] {
  const o = cloudSphereInterval(origin, direction, outer); if (!o) return [];
  const lo = Math.max(0, o[0]), hi = Math.min(depth, o[1]); if (hi <= lo) return [];
  const i = cloudSphereInterval(origin, direction, inner);
  if (!i || i[1] <= lo || i[0] >= hi) return [[lo, hi]];
  const result: [number, number][] = [];
  if (i[0] > lo) result.push([lo, Math.min(hi, i[0])]);
  if (i[1] < hi) result.push([Math.max(lo, i[1]), hi]);
  return result;
}
/** Position along the same sun ray at the outer shell: invariant under receiver movement along that ray. */
export function cloudShadowLookup(position: Vec3, sun: Vec3, outer: number): Vec3 {
  const b = position.reduce((v, p, i) => v + p * sun[i], 0);
  const r = Math.hypot(...position), t = -b + Math.sqrt(Math.max(0, b * b - (r - outer) * (r + outer)));
  const q = position.map((p, i) => p + sun[i] * t); const len = Math.hypot(...q);
  return q.map(v => v / len) as Vec3;
}
export function cloudHistoryValid(currentDepth: number, previousDepth: number, reset: boolean, inBounds: boolean): boolean {
  return !reset && inBounds && Math.abs(currentDepth - previousDepth) < Math.max(0.8, currentDepth * 0.035);
}
/** Smooth local optical-depth protection around gameplay, identical for sky and geometry rays. */
export function cloudLocalProtection(position: Vec3, focus: Vec3, departure = 0): number {
  const distance = Math.hypot(...position.map((v, i) => v - focus[i]));
  const smooth = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  return (1 - smooth(CLOUD_VISIBILITY.coreRadius, CLOUD_VISIBILITY.coreRadius + CLOUD_VISIBILITY.feather, distance)) * (1 - CLOUD_VISIBILITY.flowRelease * smooth(CLOUD_VISIBILITY.flowStart, CLOUD_VISIBILITY.flowEnd, departure));
}
