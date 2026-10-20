/**
 * Per-planet colour grade (plan §4.12): an ASC-CDL (slope, offset, power) + saturation per planet kind, saturation
 * 1.15–1.25, warm highlights / cool shadows. With AgX (default) the CDL is the AgX "look", applied in the AgX log/sigmoid
 * domain; with Khronos PBR Neutral it is applied after the tonemap in display space. Also the per-kind exposure bias and
 * the lens constants of the final composite (cos⁴ vignette, grain, dither).
 */
import type { PlanetKind } from '../../../world/sun';

export interface Cdl { slope: [number, number, number]; offset: [number, number, number]; power: [number, number, number]; saturation: number }
export interface PlanetGrade { cdl: Cdl; exposureEv: number }

export const PLANET_GRADES: Readonly<Record<PlanetKind, PlanetGrade>> = {
  temperate: { cdl: { slope: [1.02, 1.0, 0.97], offset: [0.0, 0.0, 0.008], power: [1.06, 1.06, 1.06], saturation: 1.2 }, exposureEv: 0.5 },
  glacial: { cdl: { slope: [0.97, 1.0, 1.04], offset: [0.0, 0.004, 0.014], power: [1.08, 1.06, 1.04], saturation: 1.15 }, exposureEv: 0.1 },
  dune: { cdl: { slope: [1.06, 1.0, 0.92], offset: [0.01, 0.003, -0.004], power: [1.06, 1.08, 1.12], saturation: 1.22 }, exposureEv: 0.35 },
  volcanic: { cdl: { slope: [1.08, 0.96, 0.9], offset: [0.012, 0.0, 0.006], power: [1.1, 1.12, 1.12], saturation: 1.25 }, exposureEv: 0.7 },
};

/** Final-composite lens and film constants (atmo-post §6 "subtle lens" preset). */
export const COMPOSITE_LENS = { vignette: 0.25, cos4: 0.5, vignetteInner: 0.4, vignetteOuter: 1.4, grain: 0.025, ditherLsb: 1 } as const;

/** Auto-exposure (atmo-post §7): slow, ±1 EV around the manual exposure, geometric mean of the 1/16-res image. */
export const AUTO_EXPOSURE = { key: 0.16, tauUp: 1.5, tauDown: 0.7, range: 1 } as const;

/** CPU mirror of the CDL + saturation (per channel, in whatever domain the caller applies it). */
export function applyCdl(c: readonly number[], cdl: Cdl): [number, number, number] {
  const v = [0, 1, 2].map(i => Math.pow(Math.max(c[i] * cdl.slope[i] + cdl.offset[i], 0), cdl.power[i]));
  const l = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return v.map(x => l + cdl.saturation * (x - l)) as [number, number, number];
}
