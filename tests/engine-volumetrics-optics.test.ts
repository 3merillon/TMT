import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { EngineServices, FrameState, LightInit, PassContext, PassDecl, TextureDecl } from '../src/engine/contracts';
import { Camera } from '../src/engine/frame/camera';
import { installOptics, localOpticalStrength, opticsSourceWgsl, projectOpticalSource, sunOpticalVisibility, OPTICS_PARAMS } from '../src/engine/passes/post/optics';
import { compositeShaderLinked } from '../src/engine/passes/post/composite';
import { volumetricsModule, VOLUME_TIERS, type VolumetricsFacet } from '../src/engine/passes/volumetrics/volumetrics';
import { volumeShaders, volumeTraceWgsl } from '../src/engine/passes/volumetrics/volumetrics.wgsl';
import { link } from '../src/engine/wgsl/module';

const headlight: LightInit = { type: 'spot', position: [0, 18, 0], direction: [0, 0, 1], color: [1, .88, .66], intensity: 7.5, range: 6.5, innerAngle: .22, outerAngle: .48, castShadow: true };
describe('source-coupled optics', () => {
  it('keeps flare and rays independent and clears stale sources if the source pipeline is unavailable', () => {
    const post = { flare: false, godRays: true, flareStrength: 1 }; let pass: PassDecl; let ready = true, cleared = 0; let uniform = new Float32Array();
    const facets = new Map<string, unknown>([['post', post], ['lighting', { view: 'none' }], ['fogOfWar', { volumeView: {}, paramsBuffer: {} }]]);
    const s = { scene: { get: (k: string) => facets.get(k) }, settings: { gbufferView: 'none' }, frameUniforms: {},
      ctx: { device: { createBuffer: () => ({}), createTexture: () => ({ createView: () => ({}) }), createSampler: () => ({}), createBindGroupLayout: () => ({}), createBindGroup: () => ({}) },
        queue: { writeBuffer: (_b: unknown, _o: number, data: ArrayBuffer) => { uniform = new Float32Array(data.slice(0)); } }, layouts: { frame: {} },
        pipelines: { register: () => {}, compile: () => Promise.resolve(), get: () => ready ? {} : undefined } },
      graph: { addPass: (p: PassDecl) => { pass = p; return () => {}; } },
    } as unknown as EngineServices;
    installOptics(s);
    const c = { frame: { eye: [0, 20, 0], sunDir: [0, .2, -1], display: [1000, 1000], proj: [0, 0, 0, 0, 0, 1], viewProjNoJitter: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, .08, 0] },
      resources: { view: () => ({}) }, timestampWrites: () => undefined, encoder: { clearBuffer: () => cleared++, beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {}, end: () => {} }) },
    } as unknown as PassContext;
    pass!.run(c); expect(uniform[7]).toBe(2); expect(uniform[3]).toBeGreaterThan(0);
    post.flare = true; post.godRays = false; pass!.run(c); expect(uniform[7]).toBe(1);
    post.godRays = true; pass!.run(c); expect(uniform[7]).toBe(3);
    post.flare = false; post.godRays = false; pass!.run(c); expect(uniform[7]).toBe(0); expect(uniform[3]).toBe(0);
    ready = false; pass!.run(c); expect(cleared).toBe(1);
  });
  it('local flare follows the physical cone, range and switch state', () => {
    expect(localOpticalStrength(headlight, [0, 18, 4])).toBeGreaterThan(0.5);
    expect(localOpticalStrength(headlight, [0, 18, -4])).toBe(0);
    expect(localOpticalStrength(headlight, [4, 18, 0])).toBe(0);
    expect(localOpticalStrength(headlight, [0, 18, 100])).toBe(0);
    expect(localOpticalStrength({ ...headlight, intensity: 0 }, [0, 18, 4])).toBe(0);
    expect(localOpticalStrength({ ...headlight, type: 'point' }, [0, 18, 4])).toBe(0);
    const angular = [.21, .3, .4, .48].map(a => localOpticalStrength(headlight, [4 * Math.sin(a), 18, 4 * Math.cos(a)]));
    expect(angular[0]).toBeGreaterThan(angular[1]); expect(angular[1]).toBeGreaterThan(angular[2]); expect(angular[3]).toBe(0);
  });
  it('projects a directional sun without translation and rejects sources behind the camera', () => {
    const cam = new Camera(); cam.update({ position: [0, 30, 25], target: [0, 18, 0], up: [0, 1, 0], fovY: .8 }, [1280, 720], [1280, 720], false, 1);
    const sun = [0, -.2, -1]; const p = projectOpticalSource(cam.viewProjNoJitter, sun, true);
    const translated = cam.viewProjNoJitter.slice(); translated[12] += 1e8; translated[13] -= 2e8;
    expect(projectOpticalSource(translated, sun, true)).toEqual(p);
    expect(p.inFront).toBe(true); expect(projectOpticalSource(cam.viewProjNoJitter, [0, .2, 1], true).inFront).toBe(false);
  });
  it('admits deep excavated views for actual depth occlusion, with a continuous screen-edge fade', () => {
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, .08, 0]);
    const f = { eye: [0, 18.01, 0], sunDir: [0, -.2, -Math.sqrt(.96)], viewProjNoJitter: matrix, display: [1000, 1000] } as Pick<FrameState, 'eye' | 'sunDir' | 'viewProjNoJitter' | 'display'>;
    expect(sunOpticalVisibility(f)).toBe(1);
    f.eye = [0, 2, 0]; expect(sunOpticalVisibility(f)).toBe(1);
    f.eye = [0, 40, 0]; f.sunDir = [0, -.2, -Math.sqrt(.96)]; expect(sunOpticalVisibility(f)).toBe(1);
    expect(sunOpticalVisibility({ ...f, sunDir: [0, 0, 1] })).toBe(0);
    const gains = [.96, 1, 1.04, 1.12].map(x => sunOpticalVisibility({ ...f, sunDir: [x / Math.hypot(x, 1), 0, -1 / Math.hypot(x, 1)] }));
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeLessThanOrEqual(gains[i - 1]); expect(gains[3]).toBe(0);
  });
  it('measures source occlusion after TAA, keeps flare out of history and rejects unseen emitters', () => {
    const code = opticsSourceWgsl.code, comp = compositeShaderLinked().code;
    expect(code).toContain('if(optical_depth_at(uv)>0.0){continue;}');
    expect(code).toContain('max(rgb-background,vec3f(0.0))');
    expect(code).toContain('if(scene_z+0.06<src.z){continue;}');
    expect(code).toContain('optical_fog,optical_sampler,uvw,0.0).r>0.05');
    expect(comp.indexOf('optical_effects(uv)')).toBeLessThan(comp.indexOf('var v = agx(c)'));
    expect(OPTICS_PARAMS.size).toBe(128);
  });
});

describe('bounded shadowed haze', () => {
  it('bounds all quality tiers without weakening shadow or visibility checks', () => {
    for (const tier of Object.values(VOLUME_TIERS)) { expect(tier.steps).toBeLessThanOrEqual(28); expect(tier.lights).toBeLessThanOrEqual(8); expect(tier.shadowSteps).toBeLessThanOrEqual(48); }
    const code = volumeTraceWgsl.code;
    expect(code).toContain('min(light_list.header.x, MAX_LIGHTS)');
    expect(code).toContain('volume_seen(l.position_range.xyz) < 0.95');
    expect(code).toContain('spot_falloff(-ld, l.direction.xyz, c.x, c.y)');
    expect(code).toContain('casters_vis_point_emitter(q, l.position_range.xyz');
    expect(code).toContain('let depth = textureLoad(vol_depth, px, 0)');
    expect(code).toContain('An exhausted trace is unknown');
  });
  it('omits interior resources and frees owned buffers / passes; disabled haze has exact feature-off parity', () => {
    const facets = new Map<string, unknown>(); const passes: PassDecl[] = []; const removed: PassDecl[] = []; const textures: TextureDecl[] = []; const retired: unknown[] = [];
    const s = { scene: { get: (key: string) => facets.get(key), provide: (key: string, value: unknown) => facets.set(key, value) }, settings: { gbufferView: 'none' },
      ctx: { device: { createBindGroupLayout: () => ({}), createBuffer: (x: unknown) => x, createSampler: () => ({}), createBindGroup: () => ({}) }, queue: {}, layouts: { frame: {} },
        pipelines: { register: () => {}, compile: () => Promise.resolve() }, deferDestroy: (x: unknown) => retired.push(x) },
      graph: { declareTexture: (_name: string, d: TextureDecl) => textures.push(d), addPass: (p: PassDecl) => { passes.push(p); return () => removed.push(p); } }, frameUniforms: {},
    } as unknown as EngineServices;
    facets.set('interior', {}); const interior = volumetricsModule(); interior.install(s); expect(passes).toHaveLength(0); expect(textures).toHaveLength(0);
    let invalidations = 0;
    facets.delete('interior'); facets.set('fogOfWar', {}); facets.set('sdfCasters', {}); facets.set('lighting', { view: 'none' }); facets.set('taa', { invalidate: () => invalidations++ });
    const volume = volumetricsModule(); volume.install(s); expect(passes).toHaveLength(2); expect(textures.every(t => t.size === 'quarter' && !t.history)).toBe(true);
    const facet = facets.get('volumetrics') as VolumetricsFacet;
    expect(passes.every(p => p.enabled?.({} as FrameState))).toBe(true);
    facet.enabled = false; expect(passes.every(p => !p.enabled?.({} as FrameState))).toBe(true);
    facet.enabled = true; facet.density = 0; expect(passes.every(p => !p.enabled?.({} as FrameState))).toBe(true);
    expect(invalidations).toBe(3); facet.density = 0; expect(invalidations).toBe(3);
    volume.dispose?.(); expect(removed).toHaveLength(2); expect(retired).toHaveLength(1);
  });
  it('rebinds graph targets after resize and never composites a missing or stale trace during warmup', () => {
    const facets = new Map<string, unknown>([['lighting', { view: 'none' }], ['fogOfWar', { volumeView: {}, paramsBuffer: {} }], ['sdfCasters', { atlasView: {}, listBuffer: {} }]]);
    const passes: PassDecl[] = []; const dispatches: number[][] = []; let draws = 0; let ready = true; let width = 320, height = 180;
    const groups: unknown[] = []; const writes: unknown[] = []; const buffers: unknown[] = [];
    const sdf = { volume: {}, params: { buffer: {} } }, lights = { list: { buffer: {} } }, clouds = { cube: {}, params: { buffer: {} } };
    const resources = new Map<string, unknown>(['depth', 'volumetricHaze', 'volumetricDistance', 'hdr'].map(name => [name, {}]));
    const s = { scene: { get: (k: string) => facets.get(k), provide: (k: string, v: unknown) => facets.set(k, v) }, settings: { gbufferView: 'none' },
      ctx: { device: { createBindGroupLayout: () => ({}), createBuffer: (d: unknown) => { buffers.push(d); return d; }, createSampler: () => ({}), createBindGroup: (d: unknown) => { groups.push(d); return d; } },
        queue: { writeBuffer: (...v: unknown[]) => writes.push(v) }, layouts: { frame: {} }, pipelines: { register: () => {}, compile: () => Promise.resolve(), get: () => ready ? {} : undefined } },
      graph: { declareTexture: () => {}, addPass: (p: PassDecl) => { passes.push(p); return () => {}; } },
      bindings: { get: (name: string) => name === 'sdf' ? sdf : name === 'lights' ? lights : clouds }, frameUniforms: {},
      telemetry: { gauge: () => {} },
    } as unknown as EngineServices;
    const volume = volumetricsModule(); volume.install(s);
    const c = { frame: { index: 1, tier: 'high' }, resources: { view: (name: string) => resources.get(name), size: () => [width, height] }, timestampWrites: () => undefined,
      encoder: { beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: (...v: number[]) => dispatches.push(v), end: () => {} }),
        beginRenderPass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, draw: () => draws++, end: () => {} }) },
    } as unknown as PassContext;
    ready = false; passes[0].run(c); passes[1].run(c); expect(draws).toBe(0);
    ready = true; passes[1].run(c); expect(draws).toBe(0); // Composite compiled first, trace still unavailable.
    passes[0].run(c); passes[1].run(c); expect(dispatches).toEqual([[40, 23]]); expect(draws).toBe(1);
    const groupCount = groups.length; passes[0].run(c); passes[1].run(c); expect(groups).toHaveLength(groupCount);
    c.frame.index = 2; ready = false; passes[0].run(c); ready = true; passes[1].run(c); expect(draws).toBe(2); // Prior frame's volume is rejected.
    width = 201; height = 101; for (const name of resources.keys()) resources.set(name, {});
    passes[0].run(c); passes[1].run(c); expect(dispatches.at(-1)).toEqual([26, 13]); expect(groups.length).toBeGreaterThan(groupCount);
    expect(buffers).toHaveLength(1); expect(writes).toHaveLength(3); // Resize changes graph targets, not private history/allocation.
  });
});

const naga = process.env.TMT_NAGA ?? join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'naga.exe' : 'naga');
describe.skipIf(!existsSync(naga))('volumetrics and optics Naga validation', () => {
  const shaders = { ...volumeShaders(), source: link(opticsSourceWgsl), final: compositeShaderLinked() };
  it.each(Object.keys(shaders))('%s', name => {
    const scratch = mkdtempSync(join(tmpdir(), 'tmt-volume-optics-')); const file = join(scratch, `${name}.wgsl`);
    try { writeFileSync(file, shaders[name as keyof typeof shaders].code); const result = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 }); expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0); }
    finally { unlinkSync(file); rmdirSync(scratch); }
  });
});
