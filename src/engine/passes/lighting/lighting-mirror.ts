/**
 * CPU mirror of the lighting term split and shaped ambient (lighting.wgsl.ts). Tests use it to pin the rule that AO never
 * multiplies direct light, the Pinionfall shaped-ambient factors and the v1 per-pixel composition (with the ambient
 * scale knob: at ambient 0 the image must not depend on AO at all).
 */
import { SHAPED_AMBIENT } from './lighting.wgsl';

type V3 = readonly [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export interface PixelTerms { direct: V3; emissive: V3; ambientDiffuse: V3; ambientSpecular: V3; ao: number; specularOcclusion?: number }

/** Mirror of compose_lighting. */
export function composeLighting(t: PixelTerms): [number, number, number] {
  const so = t.specularOcclusion ?? t.ao;
  return [0, 1, 2].map(i => t.direct[i] + t.emissive[i] + t.ambientDiffuse[i] * t.ao + t.ambientSpecular[i] * so) as [number, number, number];
}

export interface ShapedAmbientParams {
  ambShadowKeep: number; nightAmbScale: number; dayLo: number; dayHi: number;
  backFillNight: number; terminatorGain: number; skyGain: number; hemiGround: number;
}

/** Mirror of the scalar ambient shaping (level only; colour is sky hue ↔ night tint by `day`). */
export function shapedAmbientLevel(n: V3, up: V3, l: V3, castVis = 1, p: ShapedAmbientParams = SHAPED_AMBIENT): { level: number; fill: number; day: number } {
  const sunEl = dot(up, l);
  const day = smoothstep(p.dayLo, p.dayHi, sunEl);
  const wouldBeLit = smoothstep(0, 0.5, dot(n, l));
  const ambSun = 1 - (1 - p.ambShadowKeep) * (1 - castVis) * wouldBeLit * day;
  const ambNight = mix(p.nightAmbScale, 1, day);
  const hemi = 0.5 + 0.5 * dot(n, up);
  const rim = Math.max(-dot(n, l), 0);
  const termW = Math.min(1, Math.max(0, (1 - Math.abs(sunEl)) * p.terminatorGain));
  const fill = (1 - day) * p.backFillNight * mix(hemi, rim, termW);
  return { level: mix(p.hemiGround, 1, hemi) * ambSun * ambNight, fill, day };
}

/** Lagarde specular occlusion (brdf_specular_occlusion). */
export function specularOcclusion(ndv: number, ao: number, roughness: number): number {
  return Math.min(1, Math.max(0, Math.pow(ndv + ao, 2 ** (-16 * roughness - 1)) - 1 + ao));
}

export interface PixelInputsV1 {
  /** Direct sun + punctual light radiance (already × shadow and contact shadow). */
  direct: V3;
  emissive: V3;
  /** Sky irradiance E(n) (SH) × amb_sun plus the night floor, before the diffuse albedo. */
  irradiance: V3;
  diffuseColor: V3;
  /** Prefiltered environment × split-sum weight. */
  specularEnv: V3;
  materialAo: number;
  reservedAo: number;
  ndv: number;
  roughness: number;
}

/** Mirror of lighting v1's per-pixel composition (before aerial perspective). ambientScale = params.ground.w; aoOn = sun_disc.z. */
export function lightPixelV1(i: PixelInputsV1, ambientScale = 1, aoOn = true): [number, number, number] {
  const ao = aoOn ? Math.min(i.materialAo, i.reservedAo) : 1;
  const so = specularOcclusion(Math.max(i.ndv, 1e-3), ao, i.roughness);
  const ambientDiffuse = [0, 1, 2].map(k => i.diffuseColor[k] * i.irradiance[k] / Math.PI * ambientScale) as [number, number, number];
  const ambientSpecular = [0, 1, 2].map(k => i.specularEnv[k] * ambientScale) as [number, number, number];
  return composeLighting({ direct: i.direct, emissive: i.emissive, ambientDiffuse, ambientSpecular, ao, specularOcclusion: so });
}
