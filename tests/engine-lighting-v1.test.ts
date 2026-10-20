/**
 * W1-ENG-LOOK lighting v1: AO never scales direct light — with ambient at 0, AO on and off give identical images (CPU
 * mirror of the per-pixel composition) — the sampled-texture caps check that replaces v0's bind-everything layout, the
 * reserved-binding plan the shader declares, the WGSL structure (one compose, geometric-normal gate, contact shadow,
 * aerial last) and naga validation of every W1-ENG-LOOK shader (skipped with a message when naga is absent).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RESERVED_BINDING_NAMES, type EngineServices } from '../src/engine/contracts';
import { reservedBindingSlots } from '../src/engine/reserved-bindings';
import { atmosphereLutShaders } from '../src/engine/passes/atmosphere/luts';
import { lightingBindingPlan, lightingModule, lightingSampledTextures, lightingShader, type LightingFacet } from '../src/engine/passes/lighting/lighting';
import { composeLighting, lightPixelV1, specularOcclusion, type PixelInputsV1 } from '../src/engine/passes/lighting/lighting-mirror';
import { LIGHTING_PARAMS, LIGHTING_RESERVED, LIGHTING_RESERVED_NO_AO, LIGHTING_RESERVED_NO_GI, lightingShaderWgsl, buildLightingShader } from '../src/engine/passes/lighting/lighting.wgsl';
import { skyLightShaders } from '../src/engine/passes/lighting/sky-light';
import { bloomShaders } from '../src/engine/passes/post/bloom';
import { compositeShaderLinked, exposureShaderLinked, presentShaderLinked } from '../src/engine/passes/post/composite';
import { taaShader } from '../src/engine/passes/post/taa';
import { sunShadowClearShader, sunShadowProbeShader } from '../src/engine/passes/shadows/sun-shadows';
import { lookGpuLoadShader, lookStaticCasterShader, lookTerrainShader } from '../src/engine/sandbox/look-scene';

let seed = 1234;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const v3 = (s = 1): [number, number, number] => [rnd() * s, rnd() * s, rnd() * s];
function randomPixel(): PixelInputsV1 {
  return {
    direct: v3(20), emissive: rnd() < 0.2 ? v3(8) : [0, 0, 0], irradiance: v3(3), diffuseColor: v3(), specularEnv: v3(0.5),
    materialAo: rnd(), reservedAo: rnd(), ndv: rnd(), roughness: rnd(),
  };
}

describe('AO never scales direct light (CPU mirror of lighting v1)', () => {
  it('with ambient 0, AO on and AO off give identical images', () => {
    const image = Array.from({ length: 4096 }, randomPixel);
    const aoOn = image.map(p => lightPixelV1(p, 0, true));
    const aoOff = image.map(p => lightPixelV1(p, 0, false));
    expect(aoOn).toEqual(aoOff);
    // …and it is exactly direct + emissive.
    image.slice(0, 32).forEach((p, i) => aoOn[i].forEach((c, k) => expect(c).toBe(p.direct[k] + p.emissive[k])));
  });

  it('with ambient on, AO only darkens (the ambient terms), never below direct + emissive', () => {
    for (let i = 0; i < 2048; i++) {
      const p = randomPixel();
      const on = lightPixelV1(p, 1, true), off = lightPixelV1(p, 1, false);
      for (let k = 0; k < 3; k++) {
        expect(on[k]).toBeLessThanOrEqual(off[k] + 1e-12);
        expect(on[k]).toBeGreaterThanOrEqual(p.direct[k] + p.emissive[k] - 1e-12);
      }
    }
    expect(composeLighting({ direct: [1, 1, 1], emissive: [0, 0, 0], ambientDiffuse: [1, 1, 1], ambientSpecular: [1, 1, 1], ao: 0, specularOcclusion: 0 })).toEqual([1, 1, 1]);
  });

  it('derives specular occlusion from AO (Lagarde): 1 when unoccluded, ≤ AO-ish when occluded', () => {
    expect(specularOcclusion(0.7, 1, 0.5)).toBe(1);
    expect(specularOcclusion(0.7, 0, 0.5)).toBe(0);
    expect(specularOcclusion(0.5, 0.5, 1)).toBeLessThanOrEqual(0.51);
  });

  it('keeps the WGSL term split: one compose_lighting, no AO on direct, aerial perspective applied after composing', () => {
    const code = lightingShaderWgsl.code;
    expect(code.match(/compose_lighting\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/direct\s*\*=?\s*[^;]*\bao\b/);
    expect(code).not.toMatch(/\bao\s*\*\s*direct/);
    const compose = code.indexOf('var color = compose_lighting(');
    const aerial = code.indexOf('color = color * seg.T + seg.L;');
    expect(compose).toBeGreaterThan(0);
    expect(aerial).toBeGreaterThan(compose);
    expect(code).toContain('textureStore(hdr_out, px, vec4f(color, 1.0));');
    expect(code).toContain('let ambient_diffuse = brdf_diffuse_color(s.base_color, s.metalness) * (e_amb * amb_sun + e_night + e_moon_sky) * INV_PI * amb_scale;');
  });

  it('gates the sun (geometric normal, terrain by its shading terminator) and traces the SDF and the tank bricks', () => {
    const code = lightingShaderWgsl.code;
    expect(code).toContain('smoothstep(-0.12, 0.24, dot(ng, l))');
    // The world through the planet SDF from the terrain-lifted origin; tanks through their bricks from the surface.
    expect(code).toContain('vis = sky_trace(ps, l, params.sdf_shadow.x');
    expect(code).toContain('vis *= casters_vis_dir(p + off, l, params.sdf_shadow.x);');
    // The maps only until the SDF exists.
    expect(code).toContain('vis = sun_shadow(p, ng, l, vec2f(px));');
    // Punctual lights: the SDF (static world) times the bricks.
    expect(code).toContain('light_vis *= casters_vis_point_emitter(');
    expect(code).toContain('vis *= contact_shadow(p, ng, l, dist, xi);');
    expect(code).toContain('let sun_rgb = frame.sun_radiance * atmo_sun_color(p);');
    expect(code).toContain('eval_light(light, p, n, v');
  });
});

describe('sampled-texture caps check (v0 declared 19 per compute stage; the default limit is 16)', () => {
  it('counts the fog veil and visibility volume, the SDF and the GI probes', () => {
    expect(lightingSampledTextures(LIGHTING_RESERVED)).toBe(19);
    expect(lightingSampledTextures(LIGHTING_RESERVED_NO_GI)).toBe(18);
    expect(lightingSampledTextures(LIGHTING_RESERVED_NO_AO)).toBe(16);
    expect(lightingSampledTextures(RESERVED_BINDING_NAMES)).toBeGreaterThan(16); // what v0 did
  });

  it('drops the GI probes, then the AO texture, on tighter adapters and refuses an impossible one', () => {
    expect(lightingBindingPlan(48)).toBe(LIGHTING_RESERVED);
    expect(lightingBindingPlan(19)).toBe(LIGHTING_RESERVED);
    expect(lightingBindingPlan(18)).toBe(LIGHTING_RESERVED_NO_GI);
    expect(lightingBindingPlan(17)).toBe(LIGHTING_RESERVED_NO_AO);
    expect(lightingBindingPlan(16)).toBe(LIGHTING_RESERVED_NO_AO);
    expect(() => lightingBindingPlan(15)).toThrow(/sampled textures/);
  });

  it('declares exactly the planned reserved bindings in @group(2), consecutive from 0', () => {
    for (const [ao, gi, names] of [[true, true, LIGHTING_RESERVED], [true, false, LIGHTING_RESERVED_NO_GI], [false, false, LIGHTING_RESERVED_NO_AO]] as const) {
      const code = lightingShader(ao, gi).code;
      const bindings = [...code.matchAll(/@group\(2\) @binding\((\d+)\)/g)].map(m => Number(m[1])).sort((a, b) => a - b);
      expect(bindings).toEqual(reservedBindingSlots(names).map(s => s.binding));
      expect(code.includes('var rb_ao: texture_2d<f32>')).toBe(ao);
    }
    expect(buildLightingShader({ ao: false }).name).toBe('lighting-v1-no-ao');
    expect(LIGHTING_PARAMS.size % 16).toBe(0);
  });

  it.each([
    [16, 16, false, LIGHTING_RESERVED_NO_AO], [17, 17, true, LIGHTING_RESERVED_NO_AO],
    [18, 17, true, LIGHTING_RESERVED_NO_AO], [19, 19, true, LIGHTING_RESERVED_NO_GI],
    [20, 20, true, LIGHTING_RESERVED],
  ] as const)('installs within the %i-texture cap while preserving tank casters', async (limit, total, casters, names) => {
    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const facets = new Map<string, unknown>([['fogOfWar', {}], ['sdfCasters', {}]]);
    let shader = '', pipelineKey = '';
    const services = {
      ctx: { device: { limits: { maxSampledTexturesPerShaderStage: limit },
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return {}; },
        createPipelineLayout: () => ({}), createBuffer: () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
      }, queue: {}, layouts: { frame: {} }, deferDestroy: () => {}, pipelines: {
        register: (key: string, _kind: string, descriptor: () => unknown) => { pipelineKey = key; descriptor(); },
        shaderModule: (source: { code: string }) => { shader = source.code; return {}; }, compile: () => Promise.resolve(),
      } }, graph: { declareTexture: () => {}, addPass: () => () => {} }, frameUniforms: {},
      scene: { get: (key: string) => facets.get(key), provide: (key: string, value: unknown) => facets.set(key, value) },
    } as unknown as EngineServices;
    const module = lightingModule(); await module.install(services);
    const facet = facets.get('lighting') as LightingFacet;
    const boundTextures = layouts.flatMap(layout => [...layout.entries]).filter(entry => entry.texture).length;
    expect(boundTextures).toBe(total); expect(boundTextures).toBeLessThanOrEqual(limit);
    expect(facet.bindings).toBe(names); expect(facet.shared.options.casters).toBe(casters);
    expect(pipelineKey.endsWith('-no-casters')).toBe(!casters);
    expect(shader.includes('var caster_atlas: texture_3d<f32>')).toBe(casters);
    module.dispose?.();
  });
});

// ───────────────────────────── naga over every W1-ENG-LOOK shader ─────────────────────────────
function findNaga(): string | undefined {
  const exe = process.platform === 'win32' ? 'naga.exe' : 'naga';
  const candidates = [process.env.TMT_NAGA, ...(process.env.PATH ?? '').split(delimiter).map(dir => dir && join(dir, exe)), join(homedir(), '.cargo', 'bin', exe)];
  return candidates.find((path): path is string => !!path && existsSync(path));
}
const naga = findNaga();
if (!naga) console.warn('[engine-lighting-v1] naga not found: W1-ENG-LOOK WGSL validation skipped (cargo install naga-cli).');

describe.skipIf(!naga)('naga validates the W1-ENG-LOOK shaders', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tmt-naga-look-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const lut = atmosphereLutShaders(), sky = skyLightShaders(), bloom = bloomShaders();
  const shaders: Record<string, { code: string }> = {
    'atmosphere-transmittance': lut.transmittance, 'atmosphere-multiscatter': lut.multiscatter, 'atmosphere-sky-view': lut.skyView,
    'sky-dfg': sky.dfg, 'sky-sh': sky.sh, 'sky-cube': sky.cube, 'sky-prefilter': sky.prefilter,
    'lighting-v1': lightingShader(true), 'lighting-v1-no-ao': lightingShader(false),
    'shadow-probe': sunShadowProbeShader(), 'shadow-clear-rect': sunShadowClearShader(),
    taa: taaShader(), 'bloom-down-first': bloom.downFirst, 'bloom-down': bloom.down, 'bloom-up': bloom.up,
    'composite-v1': compositeShaderLinked(), 'auto-exposure': exposureShaderLinked(), present: presentShaderLinked(),
    'look-terrain': lookTerrainShader(), 'look-static-caster': lookStaticCasterShader(), 'look-gpu-load': lookGpuLoadShader(),
  };
  it.each(Object.keys(shaders))('%s', name => {
    const file = join(scratch, `${name}.wgsl`);
    writeFileSync(file, shaders[name].code);
    const run = spawnSync(naga!, [file], { encoding: 'utf8', timeout: 30000 });
    expect(run.status, `${run.stdout ?? ''}${run.stderr ?? ''}`).toBe(0);
  });
});

describe('exact building shadows', () => {
  it('packs oriented building boxes as centre + bounding radius and axis × half size', async () => {
    const { packShadowStructures } = await import('../src/engine/passes/lighting/lighting');
    const out = new Float32Array(64 * 16);
    const n = packShadowStructures([{ center: [1, 2, 3], halfSize: [0.5, 1, 2], axes: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] }, { center: [4, 5, 6], halfSize: [1, 1, 1] }], out);
    expect(n).toBe(2);
    expect(Array.from(out.slice(0, 4))).toEqual([1, 2, 3, Math.fround(Math.hypot(0.5, 1, 2))]);
    expect(Array.from(out.slice(4, 16))).toEqual([0, 1, 0, 0.5, -1, 0, 0, 1, 0, 0, 1, 2]);
    expect(Array.from(out.slice(20, 32))).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    expect(packShadowStructures([], out)).toBe(0);
    expect(out.every(v => v === 0)).toBe(true);
  });
});
