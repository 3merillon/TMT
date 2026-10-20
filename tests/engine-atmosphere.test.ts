/**
 * Atmosphere: the TS mirror of `atmo_integrate` on the TMT presets against `referenceTransmittance` in
 * `src/engine/passes/atmosphere/mirror.ts`, with the same step counts the shaders use (sky 16, geometry
 * adaptive ≤ 12); transmittance bounds (temperate camera→tank T_blue ≥ 0.90, horizon T_blue ∈ [0.65, 0.80], limb at
 * b = 18.2 T_blue ≤ 0.70); the params layout; the Chapman sanity probe; the sunset grade and the default sun.
 */
import { describe, expect, it } from 'vitest';
import { RESERVED_BINDING_LAYOUT } from '../src/engine/contracts';
import { atmosphereFnWgsl } from '../src/engine/passes/atmosphere/integrate.wgsl';
import { ATMOSPHERE_PARAMS_BYTES } from '../src/engine/passes/atmosphere/luts';
import { atmoDensity, atmoIntegrate, lutTransmittance, raySphere, referenceTransmittance } from '../src/engine/passes/atmosphere/mirror';
import {
  ATMO_STEPS, ATMOSPHERE_PARAMS, ATMOSPHERE_PRESETS, packAtmosphereParams, PINIONFALL_MIE_SCATTER, PINIONFALL_RAYLEIGH, softTopRadius,
  surfaceSunTransmittance,
} from '../src/engine/passes/atmosphere/params';
import { defaultSun, planetKindFromSeed, SUN_ILLUMINANCE, sunsetGrade, SUNSET_GRADES, type PlanetKind } from '../src/world/sun';

type V3 = [number, number, number];
const len = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const norm = (v: readonly number[]): V3 => { const l = len(v); return [v[0] / l, v[1] / l, v[2] / l]; };
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** atmo-presets.mjs geometry: the follow camera at elevation asin(0.55) above a tank at r = 18.15. */
const cam = (boom: number): V3 => [0, 19 + boom * 0.55, boom * Math.cos(Math.asin(0.55))];
const TANK: V3 = [0, 18.15, 0];

/** The lighting shader's aerial step rule (lighting.wgsl.ts aerial_steps): ceil(in-air chord / 1.5) clamped to [2, 12]. */
function aerialSteps(kind: PlanetKind, eye: readonly number[], dir: readonly number[], dist: number): number {
  const soft = softTopRadius(ATMOSPHERE_PRESETS[kind]);
  const b = dot(eye, dir), qc = sub(eye, dir.map(x => x * b)), disc = soft * soft - dot(qc, qc);
  if (disc < 0) return 2;
  const s = Math.sqrt(disc);
  const chord = Math.max(Math.min(-b + s, dist) - Math.max(-b - s, 0), 0);
  return Math.min(ATMO_STEPS.high.geometry, Math.max(2, Math.ceil(chord / 1.5)));
}

function metrics(kind: PlanetKind) {
  const p = ATMOSPHERE_PRESETS[kind];
  const c17 = cam(17);
  const toTank = sub(TANK, c17);
  const dTank = norm(toTank), tTank = len(toTank);
  const rc = len(c17), up = norm(c17);
  const fwdRaw = sub([0, 0, -1], up.map(x => x * dot([0, 0, -1], up)));
  const fwd = norm(fwdRaw);
  const ang = Math.asin(18 / rc);
  const dHorizon = norm([-up[0] * Math.cos(ang) + fwd[0] * Math.sin(ang), -up[1] * Math.cos(ang) + fwd[1] * Math.sin(ang), -up[2] * Math.cos(ang) + fwd[2] * Math.sin(ang)]);
  const tHorizon = Math.sqrt(rc * rc - 324);
  const o = { planetRadius: 18 };
  return {
    tank: atmoIntegrate(p, c17, dTank, tTank, aerialSteps(kind, c17, dTank, tTank), 0.5, o).T,
    tankRef: referenceTransmittance(p, c17, dTank, tTank),
    horizon: atmoIntegrate(p, c17, dHorizon, tHorizon, aerialSteps(kind, c17, dHorizon, tHorizon), 0.5, o).T,
    horizonRef: referenceTransmittance(p, c17, dHorizon, tHorizon),
    limb182: atmoIntegrate(p, [-120, 18.2, 0], [1, 0, 0], 1e9, ATMO_STEPS.high.sky, 0.5, o).T,
    limb195: atmoIntegrate(p, [-120, 19.5, 0], [1, 0, 0], 1e9, ATMO_STEPS.high.sky, 0.5, o).T,
  };
}

/** atmo-post §2.3 (atmo-presets.mjs output): camera(boom 17)→tank, →horizon, limb b = 18.2, limb b = 19.5. */
const REFERENCE: Record<PlanetKind, Record<'tank' | 'horizon' | 'limb182' | 'limb195', V3>> = {
  temperate: { tank: [0.984, 0.965, 0.918], horizon: [0.940, 0.877, 0.734], limb182: [0.903, 0.801, 0.592], limb195: [0.968, 0.928, 0.835] },
  glacial: { tank: [0.989, 0.975, 0.942], horizon: [0.960, 0.913, 0.805], limb182: [0.935, 0.858, 0.691], limb195: [0.978, 0.949, 0.880] },
  dune: { tank: [0.928, 0.951, 0.976], horizon: [0.766, 0.836, 0.911], limb182: [0.635, 0.737, 0.856], limb195: [0.849, 0.899, 0.951] },
  volcanic: { tank: [0.974, 0.966, 0.948], horizon: [0.905, 0.877, 0.822], limb182: [0.846, 0.803, 0.719], limb195: [0.949, 0.932, 0.896] },
};

describe('atmo_integrate TS mirror on the TMT presets', () => {
  it('meets the brief on temperate: subject T_blue ≥ 0.90, horizon ∈ [0.65, 0.80], limb (b = 18.2) ≤ 0.70', () => {
    const m = metrics('temperate');
    expect(m.tank[2]).toBeGreaterThanOrEqual(0.90);
    expect(m.horizon[2]).toBeGreaterThanOrEqual(0.65);
    expect(m.horizon[2]).toBeLessThanOrEqual(0.80);
    expect(m.limb182[2]).toBeLessThanOrEqual(0.70);
    // Subject haze 2–8 %, horizon 15–27 % blue (plan §4.11).
    expect(1 - m.tank[2]).toBeGreaterThanOrEqual(0.02);
    expect(1 - m.tank[2]).toBeLessThanOrEqual(0.08 + 0.005);
    expect(1 - m.horizon[2]).toBeGreaterThanOrEqual(0.15);
    expect(1 - m.horizon[2]).toBeLessThanOrEqual(0.27 + 0.005);
  });

  for (const kind of Object.keys(REFERENCE) as PlanetKind[]) {
    it(`matches atmo-presets.mjs for ${kind} with the shader step counts`, () => {
      const m = metrics(kind);
      for (const key of ['tank', 'horizon', 'limb182', 'limb195'] as const) {
        for (let c = 0; c < 3; c++) expect(Math.abs(m[key][c] - REFERENCE[kind][key][c]), `${kind} ${key}[${c}] = ${m[key][c]}`).toBeLessThan(0.006);
      }
      // The few-step shader estimate agrees with the 4000-step integral.
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(m.tank[c] - m.tankRef[c])).toBeLessThan(0.003);
        expect(Math.abs(m.horizon[c] - m.horizonRef[c])).toBeLessThan(0.003);
      }
    });
  }

  it('scatters sunlight on the day side, nothing behind the planet (analytic umbra), and fades the view', () => {
    const p = ATMOSPHERE_PRESETS.temperate;
    const eye: V3 = [0, 40, 0];
    const sunUp: V3 = [0, 1, 0];
    const direction = norm([0.46, -1, 0]);
    // The renderer supplies scene depth; this intact-body fixture must do the same.
    const sceneDepth = raySphere(eye, direction, 18)![0];
    const day = atmoIntegrate(p, eye, direction, sceneDepth, 16, 0.5, { sun: sunUp, planetRadius: 18 });
    const night = atmoIntegrate(p, eye, direction, sceneDepth, 16, 0.5, { sun: [0, -1, 0], planetRadius: 18 });
    expect(day.L[2]).toBeGreaterThan(day.L[0]);
    expect(day.L[2]).toBeGreaterThan(1e-3);
    expect(night.L[2]).toBeLessThan(day.L[2] * 0.02);
    // A ray that misses the shell is untouched.
    const miss = atmoIntegrate(p, [0, 40, 0], [1, 0, 0], 1e9, 16, 0.5, { sun: sunUp });
    expect(miss.T).toEqual([1, 1, 1]);
    expect(miss.L).toEqual([0, 0, 0]);
    // Jittered offsets change L only slightly (TAA converges them).
    const a = atmoIntegrate(p, eye, direction, sceneDepth, 16, 0.1, { sun: sunUp }).L[2];
    const b = atmoIntegrate(p, eye, direction, sceneDepth, 16, 0.9, { sun: sunUp }).L[2];
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.25);
  });

  it('bakes the transmittance LUT with the grazing continuation and the 0.08 dip fade', () => {
    const p = ATMOSPHERE_PRESETS.temperate;
    const r = 17.5;
    const cosH = -Math.sqrt(1 - (17 / r) ** 2);
    const atHorizon = lutTransmittance(p, r, cosH + 1e-6);
    const justBelow = lutTransmittance(p, r, cosH - 1e-6);
    for (let c = 0; c < 3; c++) expect(Math.abs(atHorizon[c] - justBelow[c])).toBeLessThan(1e-3); // continuous at the graze
    expect(lutTransmittance(p, r, cosH - 0.09)).toEqual([0, 0, 0]);
    const noon = lutTransmittance(p, 18.15, 1);
    expect(noon[2]).toBeGreaterThan(0.9);
  });

  it('continues air through exposed depths without an inner sphere or an opaque original-radius horizon', () => {
    const p = ATMOSPHERE_PRESETS.temperate;
    for (const r of [0, 4.5, 12, 17, 18, 24.5, softTopRadius(p)]) {
      const a = atmoDensity(p, Math.max(0, r - 1e-4)), b = atmoDensity(p, r + 1e-4);
      expect(a.every(Number.isFinite) && b.every(Number.isFinite)).toBe(true);
      expect(Math.abs(a[0] - b[0])).toBeLessThan(0.001);
    }
    const eye: V3 = [0, 12, 0], direction: V3 = [0, 1, 0];
    const empty = atmoIntegrate(p, eye, direction, 1e9, 128, 0.5, { terrainVisibility: () => 1 });
    const blocked = atmoIntegrate(p, eye, direction, 1e9, 128, 0.5, { terrainVisibility: () => 0 });
    const rock = atmoIntegrate(p, eye, direction, 1e9, 128, 0.5, { terrainVisibility: () => 0, air: () => 0 });
    expect(empty.L[2]).toBeGreaterThan(0.01);
    expect(blocked.L).toEqual([0, 0, 0]);
    expect(rock.T).toEqual([1, 1, 1]);
    const reference = referenceTransmittance(p, eye, direction, 1e9);
    empty.T.forEach((t, i) => expect(Math.abs(t - reference[i])).toBeLessThan(0.002));
    const short = atmoIntegrate(p, eye, direction, 1, 32, 0.5, { terrainVisibility: () => 1 });
    expect(short.T[2]).toBeGreaterThan(empty.T[2]);
    // A clear through-planet chord includes both atmospheric sides; no fabricated physical core terminates it.
    const through = atmoIntegrate(p, [0, 30, 0], [0, -1, 0], 1e9, 256, 0.5, { terrainVisibility: () => 1 });
    const half = atmoIntegrate(p, [0, 30, 0], [0, -1, 0], 30, 128, 0.5, { terrainVisibility: () => 1 });
    expect(through.T[2]).toBeLessThan(half.T[2]);
    expect(through.T[2]).toBeGreaterThan(0.01);
  });

  it('retains extinction in blocked excavated air without evaluating unobservable sun terms', () => {
    const p = ATMOSPHERE_PRESETS.temperate;
    let reads = 0;
    const multiscatter = (): V3 => { reads++; return [1, 1, 1]; };
    const blocked = atmoIntegrate(p, [0, 12, 0], [0, 1, 0], 20, 32, 0.5, { terrainVisibility: () => 0, multiscatter });
    expect(reads).toBe(0); expect(blocked.L).toEqual([0, 0, 0]);
    const clear = atmoIntegrate(p, [0, 12, 0], [0, 1, 0], 20, 32, 0.5, { terrainVisibility: () => 1, multiscatter });
    expect(reads).toBeGreaterThan(0); expect(clear.T).toEqual(blocked.T); expect(clear.L[2]).toBeGreaterThan(0);
    const partial = atmoIntegrate(p, [0, 12, 0], [0, 1, 0], 20, 32, 0.5, { terrainVisibility: () => 0.5, multiscatter });
    partial.L.forEach((v, i) => expect(v).toBeCloseTo(clear.L[i] * 0.5, 10));
    reads = 0;
    const rock = atmoIntegrate(p, [0, 12, 0], [0, 1, 0], 20, 32, 0.5, { air: () => 0, terrainVisibility: () => 1, multiscatter });
    expect(reads).toBe(0); expect(rock.T).toEqual([1, 1, 1]);
  });
});

describe('presets and the uniform', () => {
  it('uses the atmo-post §2.3 absolute presets', () => {
    const t = ATMOSPHERE_PRESETS.temperate;
    expect([t.groundRadius, t.topRadius, t.rayleighH, t.mieH, t.mieG]).toEqual([17, 24.5, 1.2, 0.6, 0.76]);
    t.rayleighScatter.forEach((v, i) => expect(v).toBeCloseTo(PINIONFALL_RAYLEIGH[i] * 3.5, 12));
    expect(t.mieScatter).toBeCloseTo(PINIONFALL_MIE_SCATTER * 2.5, 12);
    expect(softTopRadius(t)).toBeCloseTo(28.1, 12);
    expect(softTopRadius(ATMOSPHERE_PRESETS.dune)).toBeCloseTo(28.4, 12);
    for (const k of ['temperate', 'glacial', 'dune', 'volcanic'] as const) {
      expect(ATMOSPHERE_PRESETS[k].sunIlluminance).toBe(SUN_ILLUMINANCE);
      expect(ATMOSPHERE_PRESETS[k].sunAngularRadius).toBe(0.035);
      expect(ATMOSPHERE_PRESETS[k].sunset).toBe(SUNSET_GRADES[k]);
    }
  });

  it('fits the reserved 256 B params slot, packs the observer frame and clamps the camera altitude', () => {
    expect(ATMOSPHERE_PARAMS.size % 16).toBe(0);
    expect(ATMOSPHERE_PARAMS.size).toBeLessThanOrEqual(ATMOSPHERE_PARAMS_BYTES);
    expect(RESERVED_BINDING_LAYOUT.atmosphere.find(s => s.key === 'params')?.size).toBe(ATMOSPHERE_PARAMS_BYTES);
    const p = ATMOSPHERE_PRESETS.temperate;
    const sun = norm([0.3, 0.8, 0.52]);
    const f = new Float32Array(packAtmosphereParams(p, { sunDir: sun, eye: [0, 22, 0], planetRadius: 18, tier: 'high' }));
    const at = (name: string, i = 0) => f[ATMOSPHERE_PARAMS.offsets[name] / 4 + i];
    expect(at('rayleigh', 3)).toBe(17);
    expect(at('sun', 3)).toBe(1); // valid
    expect(at('sun_local', 1)).toBeCloseTo(sun[1], 6);
    expect(at('sun_local', 2)).toBeCloseTo(Math.sqrt(1 - sun[1] ** 2), 6);
    expect(at('sun_local', 3)).toBeCloseTo(5, 5);
    expect(at('steps', 0)).toBe(16);
    expect(at('steps', 1)).toBe(12);
    expect(at('ground', 3)).toBe(18);
    const low = new Float32Array(packAtmosphereParams(p, { sunDir: sun, eye: [0, 16.9, 0], planetRadius: 18, tier: 'low' }));
    expect(low[ATMOSPHERE_PARAMS.offsets.sun_local / 4 + 3]).toBeCloseTo(0.01, 6); // clamp ≥ 0.01 (was 5.0 in Pinionfall)
    const far = new Float32Array(packAtmosphereParams(p, { sunDir: sun, eye: [0, 70, 0], planetRadius: 18, tier: 'high' }));
    expect(far[ATMOSPHERE_PARAMS.offsets.sun_local / 4 + 3]).toBeCloseTo(softTopRadius(p) - 17, 5);
  });

  it('keeps the Chapman sanity probe near the integrated sun transmittance', () => {
    const p = ATMOSPHERE_PRESETS.temperate;
    const noon = surfaceSunTransmittance(p, 18.15, 1);
    [0.990, 0.977, 0.947].forEach((v, i) => expect(Math.abs(noon[i] - v)).toBeLessThan(0.01));
    const graze = surfaceSunTransmittance(p, 18.15, 0.02);
    expect(graze[2]).toBeLessThan(noon[2]);
  });

  it('declares one density function used by every kernel', () => {
    expect(atmosphereFnWgsl.code.match(/fn atmo_density\(/g)).toHaveLength(1);
    expect(atmosphereFnWgsl.code).toContain('fn atmo_integrate(');
    expect(atmosphereFnWgsl.code).toContain('fn atmo_ray_transmittance(');
  });
});

describe('world/sun', () => {
  it('grades the sun warm toward the horizon and not at all above `start`', () => {
    const g = SUNSET_GRADES.temperate;
    expect(sunsetGrade(0, g)).toEqual(g.tint);
    expect(sunsetGrade(-0.5, g)).toEqual(g.tint);
    expect(sunsetGrade(g.start, g)).toEqual([1, 1, 1]);
    expect(sunsetGrade(1, g)).toEqual([1, 1, 1]);
    const mid = sunsetGrade(g.start / 2, g);
    expect(mid[2]).toBeGreaterThan(g.tint[2]);
    expect(mid[2]).toBeLessThan(1);
  });

  it('gives a stable, unit, per-map default sun', () => {
    const a = defaultSun(7, 'temperate'), b = defaultSun(7, 'temperate');
    expect(a).toEqual(b);
    expect(len(a.dirToward)).toBeCloseTo(1, 12);
    expect(a.illuminance).toBe(20);
    expect(defaultSun(8, 'temperate').dirToward).not.toEqual(a.dirToward);
    expect(defaultSun(7, 'dune').dirToward).not.toEqual(a.dirToward);
    for (let s = 0; s < 200; s++) expect(Math.abs(defaultSun(s, 'glacial').dirToward[1])).toBeLessThanOrEqual(0.6);
  });

  it('maps seed & 3 to the planet kind (3 temperate, 2 glacial, 1 dune, 0 volcanic)', () => {
    expect([7, 6, 5, 4].map(planetKindFromSeed)).toEqual(['temperate', 'glacial', 'dune', 'volcanic']);
  });
});
