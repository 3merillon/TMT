// Ported from Pinionfall src/gpu/atmosphere-params.ts (MIT, same owner)
/**
 * Atmosphere parameters in ABSOLUTE TMT units (plan §4.11, atmo-post §2.3) and the one uniform block every atmosphere
 * consumer binds (the reserved binding `atmosphere.params`, 256 B).
 *
 * Adapted per plan §13: absolute ground/top radii instead of Pinionfall's `bodyRadius + groundOffset`, the camera-altitude
 * clamp 5.0 → 0.01, no Eco* multi-body writers, and three TMT additions: the sunset grade (applied identically in every
 * kernel), the diorama backdrop (a virtual near-surface observer anchored at the real limb) and the planet occluder radius
 * for the analytic umbra. `surfaceSunTransmittance` (the Chapman-airmass sanity probe) is kept as a unit-tested check.
 *
 * The presets target these transmittances (checked in tests/engine-atmosphere.test.ts): temperate camera(boom 17)→tank
 * T ≈ (0.98, 0.97, 0.92), horizon T_blue ≈ 0.73, limb (b = 18.2) T_blue ≈ 0.59.
 */
import type { PlanetKind, SunsetGrade, Vec3 } from '../../../world/sun';
import { SUN_ILLUMINANCE, SUNSET_GRADES } from '../../../world/sun';
import { wgslStruct } from '../../wgsl/module';

/** Pinionfall base coefficients (per unit) that the TMT presets scale. */
export const PINIONFALL_RAYLEIGH: Vec3 = [5.802e-3, 13.558e-3, 33.1e-3];
export const PINIONFALL_MIE_SCATTER = 3.996e-3;
export const PINIONFALL_MIE_ABSORPTION = 4.4e-4;

export interface AtmospherePreset {
  /** Atmosphere ground radius (density reference, below the r = 18 surface on purpose). */
  groundRadius: number;
  /** Nominal top; the kernels integrate to the soft top = top + 3·H_R so the limb fades instead of clipping. */
  topRadius: number;
  rayleighScatter: Vec3;
  rayleighH: number;
  mieScatter: number;
  mieAbsorption: number;
  mieH: number;
  mieG: number;
  sunIlluminance: number;
  /** Multiplier in the geometry aerial perspective only (LUTs unaffected). */
  aerialDensity: number;
  /** 0..1: how much of the diorama backdrop replaces black space above the limb (atmo-post §2.4 a). */
  diorama: number;
  /** Radiance scale of the backdrop and of the sky seen in reflections (art knob). */
  skyGain: number;
  /**
   * Sky-light gain for AMBIENT (the SH irradiance). The presets keep the subject within 2–8% haze, so the physical sky is
   * thin and fills shadows with ~2% of the sun; the miniature look wants a soft, toy-like fill (plan §4.12).
   */
  ambientGain: number;
  /** Saturation of the ambient sky light (1 = physical; < 1 pulls the deep-blue fill toward neutral). */
  ambientSaturation: number;
  /** Altitude of the virtual diorama observer above the ground radius (≈ 0.5·H_R). */
  dioramaAltitude: number;
  /** Planet-type ground albedo (multiscatter ground bounce, sky-light lower hemisphere). */
  groundAlbedo: Vec3;
  /** Night-side ambient floor (linear radiance-ish; the atmosphere gives ~0 there). */
  nightTint: Vec3;
  starBrightness: number;
  sunAngularRadius: number;
  sunset: SunsetGrade;
}

const scale = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

function preset(p: Partial<AtmospherePreset> & Pick<AtmospherePreset, 'rayleighScatter' | 'mieScatter' | 'mieAbsorption' | 'mieG' | 'mieH' | 'groundAlbedo' | 'sunset'>): AtmospherePreset {
  return {
    groundRadius: 17, topRadius: 24.5, rayleighH: 1.2, sunIlluminance: SUN_ILLUMINANCE, aerialDensity: 1, diorama: 1,
    skyGain: 3, ambientGain: 4, ambientSaturation: 0.7, dioramaAltitude: 0.6, nightTint: [0.012, 0.016, 0.03], starBrightness: 5, sunAngularRadius: 0.035,
    ...p,
  };
}

/** Presets per planet kind (atmo-post §2.3, absolute units; planet kind = seed & 3). */
export const ATMOSPHERE_PRESETS: Readonly<Record<PlanetKind, AtmospherePreset>> = {
  temperate: preset({
    rayleighScatter: scale(PINIONFALL_RAYLEIGH, 3.5), mieScatter: PINIONFALL_MIE_SCATTER * 2.5, mieAbsorption: PINIONFALL_MIE_ABSORPTION * 2.5,
    mieH: 0.6, mieG: 0.76, groundAlbedo: [0.16, 0.2, 0.1], skyGain: 3.0, sunset: SUNSET_GRADES.temperate,
  }),
  glacial: preset({
    rayleighScatter: scale(PINIONFALL_RAYLEIGH, 2.5), mieScatter: PINIONFALL_MIE_SCATTER * 1.2, mieAbsorption: PINIONFALL_MIE_ABSORPTION * 1.2,
    mieH: 0.5, mieG: 0.8, groundAlbedo: [0.55, 0.6, 0.66], skyGain: 3.3, sunset: SUNSET_GRADES.glacial,
  }),
  dune: preset({
    rayleighH: 1.3, rayleighScatter: scale([0.026, 0.016, 0.006], 3), mieScatter: PINIONFALL_MIE_SCATTER * 5, mieAbsorption: PINIONFALL_MIE_ABSORPTION * 5 * 2,
    mieH: 0.9, mieG: 0.65, groundAlbedo: [0.42, 0.3, 0.17], skyGain: 2.6, nightTint: [0.02, 0.014, 0.012], sunset: SUNSET_GRADES.dune,
  }),
  volcanic: preset({
    rayleighScatter: [0.018, 0.03, 0.055], mieScatter: PINIONFALL_MIE_SCATTER * 4, mieAbsorption: PINIONFALL_MIE_ABSORPTION * 4 * 6,
    mieH: 1.0, mieG: 0.55, groundAlbedo: [0.07, 0.06, 0.055], skyGain: 2.2, nightTint: [0.02, 0.01, 0.008], sunset: SUNSET_GRADES.volcanic,
  }),
};

export function softTopRadius(p: AtmospherePreset): number { return p.topRadius + 3 * p.rayleighH; }

// ───────────────────────────── LUT sizes ─────────────────────────────
export const TRANSMITTANCE_LUT = { w: 256, h: 64 } as const;
export const MULTISCATTER_LUT = { w: 32, h: 32 } as const;
/** One sky-view LUT; the texture holds two side by side: x < w the real camera observer, x ≥ w the diorama observer. */
export const SKY_VIEW_LUT = { w: 192, h: 128 } as const;

/** Sky / aerial integrator steps by tier (atmo-post quality table). */
export const ATMO_STEPS = {
  low: { sky: 8, geometry: 6 }, medium: { sky: 12, geometry: 8 }, high: { sky: 16, geometry: 12 }, ultra: { sky: 24, geometry: 16 },
} as const;

/** Diorama fade to stars by camera radius (atmo-post §2.4: smoothstep(35, 55, r_cam)). */
export const DIORAMA_FADE: readonly [number, number] = [35, 55];

// ───────────────────────────── Uniform (reserved binding atmosphere.params, 256 B) ─────────────────────────────
export const ATMOSPHERE_PARAMS = wgslStruct('AtmosphereParams', [
  ['rayleigh', 'vec4f'],     // rgb β_R per unit, w ground radius
  ['mie', 'vec4f'],          // x β_M scatter, y β_M absorption, z g, w top radius
  ['heights', 'vec4f'],      // x H_R, y H_M, z sun illuminance, w soft top radius
  ['sun', 'vec4f'],          // xyz world unit vector toward the sun, w valid (1 once provided; placeholder 0)
  ['sun_local', 'vec4f'],    // (0, cos, sin) of the sun in the LUT observer frame (Y up, sun in YZ), w real camera altitude
  ['sunset', 'vec4f'],       // rgb tint at the horizon, w start cos
  ['diorama', 'vec4f'],      // x weight, y sky gain, z virtual observer altitude, w star brightness
  ['fade', 'vec4f'],         // x/y diorama fade radii, z sun angular radius, w aerial density
  ['lut', 'vec4f'],          // x/y transmittance size, z/w one sky-view LUT size
  ['ground', 'vec4f'],       // rgb ground albedo, w planet occluder radius (solid surface, umbra)
  ['steps', 'vec4f'],        // x sky steps, y geometry steps, z/w inside↔outside crossfade radii (top, soft top)
  ['night', 'vec4f'],        // rgb night ambient floor, w multiscatter LUT size
]);

export interface AtmosphereFrame {
  sunDir: Vec3;
  eye: Vec3;
  /** Solid planet radius (frame planet radius, 18). */
  planetRadius: number;
  tier: keyof typeof ATMO_STEPS;
}

/**
 * Pack the uniform. The sun is also rotated into the LUT observer frame (Pinionfall writeAtmosphereUniforms): Y = the
 * radial up at the eye, sun in the YZ plane (azimuth 0).
 */
export function packAtmosphereParams(p: AtmospherePreset, f: AtmosphereFrame, out?: ArrayBuffer): ArrayBuffer {
  const r = Math.hypot(f.eye[0], f.eye[1], f.eye[2]);
  const up: Vec3 = r > 1e-3 ? [f.eye[0] / r, f.eye[1] / r, f.eye[2] / r] : [0, 1, 0];
  const cosSun = up[0] * f.sunDir[0] + up[1] * f.sunDir[1] + up[2] * f.sunDir[2];
  const sinSun = Math.sqrt(Math.max(0, 1 - cosSun * cosSun));
  const soft = softTopRadius(p);
  // Real observer altitude, clamped inside the soft shell (the real LUT is only used there) and ≥ 0.01 (atmo-post §2.6).
  const camAlt = Math.min(Math.max(r - p.groundRadius, 0.01), soft - p.groundRadius);
  const steps = ATMO_STEPS[f.tier];
  return ATMOSPHERE_PARAMS.pack({
    rayleigh: [...p.rayleighScatter, p.groundRadius],
    mie: [p.mieScatter, p.mieAbsorption, p.mieG, p.topRadius],
    heights: [p.rayleighH, p.mieH, p.sunIlluminance, soft],
    sun: [...f.sunDir, 1],
    sun_local: [0, cosSun, sinSun, camAlt],
    sunset: [...p.sunset.tint, p.sunset.start],
    diorama: [p.diorama, p.skyGain, p.dioramaAltitude, p.starBrightness],
    fade: [DIORAMA_FADE[0], DIORAMA_FADE[1], p.sunAngularRadius, p.aerialDensity],
    lut: [TRANSMITTANCE_LUT.w, TRANSMITTANCE_LUT.h, SKY_VIEW_LUT.w, SKY_VIEW_LUT.h],
    ground: [...p.groundAlbedo, f.planetRadius],
    steps: [steps.sky, steps.geometry, p.topRadius, soft],
    night: [...p.nightTint, MULTISCATTER_LUT.w],
  }, out);
}

/**
 * Analytic per-channel sun transmittance at a surface radius (Pinionfall `surfaceSunTransmittance`, absolute radii): the
 * vertical optical depth of each exponential column times a Chapman-capped airmass. A boot-time sanity probe against
 * over-thick authored atmospheres.
 */
export function surfaceSunTransmittance(p: AtmospherePreset, surfaceRadius: number, cosSun = 1): Vec3 {
  const h = Math.max(surfaceRadius - p.groundRadius, 0);
  const airmass = (H: number) => 1 / Math.max(cosSun, 1 / Math.sqrt((Math.PI * Math.max(surfaceRadius, 1)) / (2 * H)));
  const colR = p.rayleighH * Math.exp(-h / p.rayleighH) * airmass(p.rayleighH);
  const colM = (p.mieScatter + p.mieAbsorption) * p.mieH * Math.exp(-h / p.mieH) * airmass(p.mieH);
  return [0, 1, 2].map(c => Math.exp(-(p.rayleighScatter[c] * colR + colM))) as Vec3;
}
