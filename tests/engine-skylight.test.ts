/**
 * W1-ENG-LOOK sky light: the L1-SH irradiance maths the bake and the lighting share (projection, the analytic
 * planet-ground hemisphere, E(n) evaluation), the atlas layout of the reserved `skyLight.dfg` texture, a CPU mirror of the
 * split-sum DFG bake, the energy compensation, the params layout and the bake-kernel invariants.
 */
import { describe, expect, it } from 'vitest';
import { RESERVED_BINDING_LAYOUT } from '../src/engine/contracts';
import { brdfEnergyCompensation, brdfWgsl } from '../src/engine/wgsl/common/brdf.wgsl';
import {
  fibonacciDir, groundHemisphereL1, halfToFloat, projectL1, SH_Y0, SH_Y1, shIrradiance, SKY_ATLAS, SKY_CUBE, SKY_CUBE_REBUILD_RAD,
  SKY_LIGHT_PARAMS, SKY_LIGHT_PARAMS_BYTES, skyLightFnWgsl, skyLightShaders,
} from '../src/engine/passes/lighting/sky-light';

const N = 4096;
const dirs = Array.from({ length: N }, (_, i) => fibonacciDir(i, N));

describe('L1 spherical harmonics irradiance', () => {
  it('reproduces E = πL for a constant environment, for every normal', () => {
    const sh = projectL1(dirs.map(dir => ({ dir, radiance: 0.7 })));
    expect(sh.c0).toBeCloseTo(0.7 * SH_Y0 * 4 * Math.PI, 3);
    for (const c of sh.c1) expect(Math.abs(c)).toBeLessThan(1e-3);
    for (const n of [[0, 1, 0], [1, 0, 0], [0, -1, 0], [0.6, 0, 0.8]]) expect(shIrradiance(sh, n)).toBeCloseTo(Math.PI * 0.7, 2);
  });

  it('adds the planet-ground lower hemisphere analytically, equal to the numeric projection', () => {
    const numeric = projectL1(dirs.map(dir => ({ dir, radiance: dir[1] < 0 ? 0.3 : 0 })));
    const analytic = groundHemisphereL1(0.3);
    expect(analytic.c0).toBeCloseTo(numeric.c0, 3);
    analytic.c1.forEach((c, k) => expect(c).toBeCloseTo(numeric.c1[k], 3));
    // L1 of a lower hemisphere gives exactly zero irradiance to an up-facing normal and πL/… downward.
    expect(shIrradiance(analytic, [0, 1, 0])).toBeCloseTo(0, 9);
    expect(shIrradiance(analytic, [0, -1, 0])).toBeCloseTo(0.3 * Math.PI, 1);
  });

  it('approximates the cosine-weighted irradiance of a sky hemisphere within L1 accuracy and never goes negative', () => {
    const sh = projectL1(dirs.map(dir => ({ dir, radiance: dir[1] > 0 ? 1 : 0 })));
    const exact = (n: number[]) => dirs.reduce((a, d) => a + (d[1] > 0 ? Math.max(0, d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) : 0), 0) * 4 * Math.PI / N;
    expect(shIrradiance(sh, [0, 1, 0])).toBeCloseTo(exact([0, 1, 0]), 1);
    expect(Math.abs(shIrradiance(sh, [1, 0, 0]) - exact([1, 0, 0])) / exact([1, 0, 0])).toBeLessThan(0.05);
    for (let i = 0; i < 64; i++) expect(shIrradiance(sh, fibonacciDir(i, 64))).toBeGreaterThanOrEqual(0);
  });

  it('writes the same constants into the WGSL evaluation', () => {
    const code = skyLightFnWgsl.code;
    expect(code).toContain(`PI * ${SH_Y0} * c0 + (2.0 * PI / 3.0) * ${SH_Y1} * c1n`);
    expect(code).toContain('let nl = vec3f(dot(n, side), dot(n, up), dot(n, sun_h));');
  });
});

describe('DFG split sum and energy compensation', () => {
  // CPU mirror of the DFG bake (Karis split sum, Smith height-correlated visibility, GGX importance sampling).
  function dfg(ndv: number, rough: number, samples = 2048): [number, number] {
    const a = Math.max(rough, 0.045) ** 2, a2 = a * a;
    const v = [Math.sqrt(1 - ndv * ndv), 0, ndv];
    let A = 0, B = 0;
    for (let i = 0; i < samples; i++) {
      const u1 = i / samples;
      let b = i; let rev = 0; for (let k = 0; k < 16; k++) { rev = (rev << 1) | (b & 1); b >>= 1; }
      const u2 = rev / 65536;
      const phi = 2 * Math.PI * u1;
      const ct = Math.sqrt((1 - u2) / (1 + (a2 - 1) * u2)), st = Math.sqrt(1 - ct * ct);
      const h = [Math.cos(phi) * st, Math.sin(phi) * st, ct];
      const vdh = v[0] * h[0] + v[1] * h[1] + v[2] * h[2];
      const l = [2 * vdh * h[0] - v[0], 2 * vdh * h[1] - v[1], 2 * vdh * h[2] - v[2]];
      if (l[2] <= 0 || vdh <= 0) continue;
      const vis = 0.5 / Math.max(l[2] * Math.sqrt(ndv * ndv * (1 - a2) + a2) + ndv * Math.sqrt(l[2] * l[2] * (1 - a2) + a2), 1e-4);
      const gv = 4 * vis * l[2] * vdh / Math.max(h[2], 1e-4);
      const fc = (1 - vdh) ** 5;
      A += (1 - fc) * gv; B += fc * gv;
    }
    return [A / samples, B / samples];
  }

  it('is ≈ (1, 0) for a smooth surface seen head-on and loses energy with roughness', () => {
    const [a, b] = dfg(0.999, 0.05);
    expect(a + b).toBeGreaterThan(0.95);
    expect(b).toBeLessThan(0.03);
    const [ra, rb] = dfg(0.5, 1);
    expect(ra + rb).toBeLessThan(0.85);
    for (const [n, r] of [[0.1, 0.3], [0.5, 0.5], [0.9, 0.9]] as const) {
      const [x, y] = dfg(n, r);
      expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0); expect(x + y).toBeLessThanOrEqual(1.02);
    }
  });

  it('compensates multi-scatter energy: ≥ 1, = 1 when no energy is lost, stronger for bright metals', () => {
    expect(brdfEnergyCompensation(0.9, 1, 0)).toBeCloseTo(1, 12);
    const [a, b] = dfg(0.5, 1);
    expect(brdfEnergyCompensation(0.04, a, b)).toBeGreaterThan(1);
    expect(brdfEnergyCompensation(0.95, a, b)).toBeGreaterThan(brdfEnergyCompensation(0.04, a, b));
    expect(brdfWgsl.code).toContain('fn brdf_energy_compensation(');
    expect(brdfWgsl.code).toContain('fn brdf_specular_occlusion(');
    // The v0 entry points other modules use stay intact.
    expect(brdfWgsl.code).toContain('fn brdf_direct(n: vec3f, v: vec3f, l: vec3f, base_color: vec3f, metalness: f32, roughness: f32) -> vec3f');
  });
});

describe('atlas, cube and params layout', () => {
  it('packs DFG + three SH blocks into the reserved skyLight.dfg texture, and the params into skyLight.sh', () => {
    expect(SKY_ATLAS.dfg + 3 * SKY_ATLAS.block).toBe(SKY_ATLAS.width);
    expect(SKY_ATLAS.width * 8 % 256).toBe(0); // rgba16float rows copy without padding (readback)
    expect(SKY_LIGHT_PARAMS.size % 16).toBe(0);
    expect(SKY_LIGHT_PARAMS.size).toBeLessThanOrEqual(SKY_LIGHT_PARAMS_BYTES);
    expect(RESERVED_BINDING_LAYOUT.skyLight.find(s => s.key === 'sh')?.size).toBe(SKY_LIGHT_PARAMS_BYTES);
    expect(RESERVED_BINDING_LAYOUT.skyLight.map(s => s.type)).toEqual(['texture-cube', 'texture-2d', 'uniform']);
    expect([SKY_CUBE.size, SKY_CUBE.lowSize, SKY_CUBE.mips]).toEqual([64, 32, 5]);
    expect(SKY_CUBE_REBUILD_RAD).toBeCloseTo(2 * Math.PI / 180, 12);
  });

  it('decodes IEEE halves for the atlas readback', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x3555)).toBeCloseTo(1 / 3, 3);
    expect(halfToFloat(0x0001)).toBeCloseTo(2 ** -24, 30);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(Number.isNaN(halfToFloat(0x7e00))).toBe(true);
  });

  it('bakes the ground hemisphere from the sun + sky irradiance and fills the cube below the focus horizon with ground', () => {
    const s = skyLightShaders();
    expect(s.sh.code).toContain('let lg = atmo.ground.rgb / PI * (e_sun + e_down);');
    expect(s.sh.code).toContain('c0 += lg * (');
    expect(s.cube.code).toContain('if (dot(d, up) >= 0.0) {');
    expect(s.cube.code).toContain('sh_ground_irradiance(ph, sun)');
    expect(s.prefilter.code).toContain('brdf_importance_ggx(brdf_hammersley(i, PF_SAMPLES), n, pf.roughness)');
  });
});
