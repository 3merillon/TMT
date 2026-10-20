/**
 * The temporal upscaler (src/engine/passes/post/tsr.ts, tsr.wgsl.ts) is four compute passes that nothing but a running GPU
 * frame exercises, and every mistake it can hold is silent: a jitter of the wrong sign still gives a picture (a soft one),
 * a uniform packed one slot off reads zeros, a binding whose kind differs from its layout is a validation error no gate
 * sees. This pins what can be pinned without a GPU: the jitter cycle and its sign against Camera.update, the motion and
 * sky conventions, the uniform block, every binding against its layout, when the passes exist, when the history resets,
 * the display-relative size class of the post chain, the native resolver left as it was, the settings steps and the
 * licence notices.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EngineServices, FrameState, PassContext, PassDecl, TextureDecl } from '../src/engine/contracts';
import { EventBus } from '../src/engine/events';
import { Camera, halton, jitterPhaseCount, jitterPixels, JITTER_SAMPLES } from '../src/engine/frame/camera';
import { FrameGraph } from '../src/engine/frame/frame-graph';
import { bloomModule, BLOOM_TEXTURES } from '../src/engine/passes/post/bloom';
import { taaWgsl, TSR_DEFAULTS, tsrWanted, velocityOf, type TsrControls } from '../src/engine/passes/post/taa';
import { installTsr, TSR_STAGES, TSR_TEXTURES, tsrLayoutEntries } from '../src/engine/passes/post/tsr';
import { TSR_DEBUG_VIEWS, TSR_PARAMS, tsrShaders, tsrSharpenWgsl } from '../src/engine/passes/post/tsr.wgsl';
import { DEFAULT_SETTINGS, RENDER_SCALE_STEPS, sanitizeSettings, SETTING_RANGES } from '../src/game/meta/settings';

type V3 = [number, number, number];
const rig = (position: V3, target: V3) => ({ position, target, up: [0, 1, 0] as V3, fovY: 47 * Math.PI / 180 });
function uvOf(m: ArrayLike<number>, p: readonly number[], w = 1): [number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12] * w, y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13] * w;
  const c = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15] * w;
  return [(x / c) * 0.5 + 0.5, 0.5 - (y / c) * 0.5];
}

describe('jitter cycle', () => {
  it('follows 8 × (display / internal)² below native and keeps the native 16 phases otherwise', () => {
    expect(jitterPhaseCount(1600, 1600)).toBe(16);
    expect(jitterPhaseCount(1600, Math.round(1600 * 0.77))).toBe(16);
    expect(jitterPhaseCount(1600, Math.round(1600 * 0.67))).toBe(18);
    expect(jitterPhaseCount(1600, 800)).toBe(32);
    expect(jitterPhaseCount(1600, 2000)).toBe(16);
    expect(jitterPhaseCount(3840, 960)).toBe(128);
  });

  it('is exactly the former 16-sample Halton(2,3) sequence at native, in the camera too', () => {
    for (let i = 0; i < 64; i++) {
      const k = (i % JITTER_SAMPLES) + 1;
      expect(jitterPixels(i)).toEqual([halton(k, 2) - 0.5, halton(k, 3) - 0.5]);
    }
    const size: [number, number] = [1600, 1000];
    const plain = new Camera(), native = new Camera();
    for (let f = 0; f < 40; f++) {
      plain.update(rig([3, 25, 12], [0, 18, 0]), size, size, true, f);
      native.update(rig([3, 25, 12], [0, 18, 0]), size, size, true, f, size);
      expect(Array.from(native.proj)).toEqual(Array.from(plain.proj));
      expect(native.jitter).toEqual(plain.jitter);
    }
  });

  it('covers a display pixel with the longer cycle when the frame is upscaled', () => {
    const cam = new Camera(), seen = new Set<string>();
    for (let f = 0; f < 32; f++) {
      cam.update(rig([3, 25, 12], [0, 18, 0]), [1600, 1000], [800, 500], true, f, [1600, 1000]);
      seen.add(cam.jitter.join());
      expect(Math.abs(cam.jitter[0]) * 800 / 2).toBeLessThanOrEqual(0.5);
    }
    expect(seen.size).toBe(32);
  });
});

describe('conventions the shaders rely on', () => {
  const internal: [number, number] = [1072, 670], display: [number, number] = [1600, 1000];

  it('texel centres sample the unjittered image at + tsr_jitter() render px (both signs opposite to the port source)', () => {
    expect(tsrShaders().accumulate.code).toContain('fn tsr_jitter() -> vec2f { return frame.jitter * frame_internal_size() * vec2f(-0.5, 0.5); }');
    const cam = new Camera();
    let worst = 0, moved = 0;
    for (let f = 1; f < 20; f++) {
      cam.update(rig([2, 24, 14], [0, 18, 0]), display, internal, true, f, display);
      const jitter = [-0.5 * cam.jitter[0] * internal[0], 0.5 * cam.jitter[1] * internal[1]];
      for (const p of [[0.3, 18.1, 0.2], [-2, 17, 3], [5, 19, -4]]) {
        const j = uvOf(cam.viewProj, p), u = uvOf(cam.viewProjNoJitter, p);
        worst = Math.max(worst, Math.abs((u[0] - j[0]) * internal[0] - jitter[0]), Math.abs((u[1] - j[1]) * internal[1] - jitter[1]));
        moved = Math.max(moved, Math.hypot(...jitter));
      }
    }
    expect(worst).toBeLessThan(1e-3);
    expect(moved).toBeGreaterThan(0.2);
  });

  it('motion is the negated velocity target, so uv − motion is where a static point was', () => {
    expect(tsrShaders().reconstruct.code).toContain('motion = -textureLoad(scene_velocity, at, 0).rg;');
    const cam = new Camera();
    cam.update(rig([0, 30, 20], [0, 18, 0]), display, internal, true, 1, display);
    cam.update(rig([0.6, 29.8, 19.5], [0, 18, 0]), display, internal, true, 2, display);
    const p = [1, 18.2, -1], v = velocityOf(cam.prevViewProj, cam.viewProjNoJitter, p);
    const cur = uvOf(cam.viewProjNoJitter, p), prev = uvOf(cam.prevViewProj, p), motion = [-v[0], -v[1]];
    expect(cur[0] - motion[0]).toBeCloseTo(prev[0], 9);
    expect(cur[1] - motion[1]).toBeCloseTo(prev[1], 9);
  });

  it('reprojects the sky by direction through the previous unjittered view-projection, off-centre and jittered', () => {
    const code = tsrShaders().reconstruct.code;
    expect(code).toContain('frame.prev_view_proj * vec4f(transpose(mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz)) * vr, 0.0)');
    const cam = new Camera();
    const off = (position: V3): Parameters<Camera['update']>[0] => ({ ...rig(position, [0, 18, 0]), viewOffset: [1600, 1000, 0, 260] });
    cam.update(off([0, 30, 20]), display, internal, true, 1, display);
    cam.update(off([1, 30, 19]), display, internal, true, 2, display);
    // CPU mirror of tsr_sky_prev at a texel centre: the unjittered pixel ray, rotated to world, projected as a direction.
    const dir: V3 = [0.2, 0.3, -0.93], v = cam.view, pr = cam.proj;
    const view = [v[0] * dir[0] + v[4] * dir[1] + v[8] * dir[2], v[1] * dir[0] + v[5] * dir[1] + v[9] * dir[2], v[2] * dir[0] + v[6] * dir[1] + v[10] * dir[2]];
    const uv = uvOf(cam.viewProjNoJitter, dir, 0), ndc = [uv[0] * 2 - 1, 1 - uv[1] * 2];
    const vr = [(ndc[0] + pr[8] + cam.jitter[0]) / pr[0], (ndc[1] + pr[9] + cam.jitter[1]) / pr[5], -1];
    expect(vr[0] / -vr[2]).toBeCloseTo(view[0] / -view[2], 6);
    expect(vr[1] / -vr[2]).toBeCloseTo(view[1] / -view[2], 6);
  });

  it('keeps every 3×3 tap of an 8×8 display group inside the accumulate pass\'s 11×11 tile at any scale up to native', () => {
    const code = tsrShaders().accumulate.code;
    expect(code).toContain('var<workgroup> tile: array<vec3f, 121>;');
    expect(code).toContain('let origin = vec2i(round((vec2f(wid.xy * 8u) + 0.5) / out_res * in_res - 0.5 - tsr_jitter())) - 1;');
    // WGSL round() is half to even.
    const round = (v: number) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
    let worst = 0;
    for (const [display, internal] of [[1600, 1072], [1600, 1232], [1600, 800], [1601, 1600], [3840, 1920], [7, 6], [1000, 999]]) {
      for (let group = 0; group * 8 < display; group += 1) for (const jitter of [-0.5, -0.31, 0, 0.17, 0.5]) {
        const at = (px: number) => (px + 0.5) / display * internal - 0.5 - jitter;
        const origin = round(at(group * 8)) - 1;
        for (let px = group * 8; px < Math.min(display, group * 8 + 8); px++) for (const o of [-1, 0, 1]) {
          const p = Math.min(Math.max(round(at(px)) + o, 0), internal - 1) - origin;
          expect(p).toBeGreaterThanOrEqual(0);
          worst = Math.max(worst, p);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(10);
  });

  it('dilates to the NEAREST reversed-Z depth and scatters it with atomicMax (an empty slot is 0)', () => {
    const { reconstruct, mask } = tsrShaders();
    expect(reconstruct.code).toContain('if (d > near) { near = d; at = p; }');
    expect(reconstruct.code).toContain('atomicMax(&scatter[u32(p.y * size.x + p.x)], bitcast<u32>(near));');
    expect(mask.code).toContain('if (z > tz) { c = clamp(tsr_tolerance(z, m.z) / (z - tz), 0.0, 1.0); }');
    expect(reconstruct.code).toContain('fn tsr_z(d: f32) -> f32 { return min(frame_near() / max(d, 1e-9), TSR_FAR); }');
  });

  it('keeps veiled pixels under the plain clip, as a re-committed page that kept its history', () => {
    const { mask, accumulate } = tsrShaders();
    expect(mask.code).toContain('textureStore(mask_out, center, vec4f(1.0 - confidence, f32(fresh && !known), reactive, max(f32(known), veil)));');
    expect(accumulate.code).toContain('let calm = (1.0 - reactive) * (1.0 - mask.a);');
  });
});

describe('uniform block and bindings', () => {
  it('packs TsrParams where the struct has it', () => {
    expect(TSR_PARAMS.size).toBe(48);
    expect(TSR_PARAMS.offsets).toEqual({ control: 0, tune: 16, look: 32 });
    const f = new Float32Array(TSR_PARAMS.pack({ control: [1, 0.8, 24, 3], tune: [16, 0.1, 1, 1], look: [0.5, 0, 0, 0] }));
    expect(Array.from(f)).toEqual([1, Math.fround(0.8), 24, 3, 16, Math.fround(0.1), 1, 1, 0.5, 0, 0, 0]);
    for (const code of Object.values(tsrShaders()).map(s => s.code)) expect(code).toContain('struct TsrParams {\n  control: vec4f,\n  tune: vec4f,\n  look: vec4f,\n}');
  });

  it('paints the debug views the controls name', () => {
    expect(TSR_DEBUG_VIEWS).toEqual(['off', 'motion', 'disocclusion', 'locks', 'age', 'reactive']);
    for (let v = 1; v < TSR_DEBUG_VIEWS.length - 1; v++) expect(tsrSharpenWgsl.code).toContain(`if (view == ${v}u)`);
  });

  it('declares every binding of every pass with the kind and format of its layout entry, and nothing else', () => {
    const entries = tsrLayoutEntries(), shaders = tsrShaders();
    expect(Object.keys(entries)).toEqual([...TSR_STAGES]);
    for (const stage of TSR_STAGES) {
      const code = shaders[stage].code;
      const decls = [...code.matchAll(/@group\(1\) @binding\((\d+)\) var(<[^>]+>)? (\w+): ([^;]+);/g)].map(m => ({ binding: Number(m[1]), space: m[2] ?? '', name: m[3], type: m[4] }));
      expect(decls.map(d => d.binding), stage).toEqual(entries[stage].map(e => e.binding));
      for (const [i, d] of decls.entries()) {
        const e = entries[stage][i], why = `${stage} binding ${d.binding} (${d.name})`;
        if (d.space === '<uniform>') expect(e.buffer?.type, why).toBe('uniform');
        else if (d.space === '<storage, read_write>') expect(e.buffer?.type, why).toBe('storage');
        else if (d.space === '<storage, read>') expect(e.buffer?.type, why).toBe('read-only-storage');
        else if (d.type === 'sampler') expect(e.sampler?.type, why).toBe('filtering');
        else if (d.type.startsWith('texture_storage_2d<')) expect(e.storageTexture?.format, why).toBe(d.type.slice(19).split(',')[0]);
        else if (d.type === 'texture_depth_2d') expect(e.texture?.sampleType, why).toBe('depth');
        else if (d.type === 'texture_2d<u32>') expect(e.texture?.sampleType, why).toBe('uint');
        else {
          expect(d.type, why).toBe('texture_2d<f32>');
          // Filtered reads need a filterable binding; textureLoad-only ones stay unfilterable (r32float has to).
          const filtered = new RegExp(`textureSampleLevel\\(${d.name},`).test(code);
          expect(e.texture?.sampleType, why).toBe(filtered ? 'float' : 'unfilterable-float');
        }
      }
    }
  });
});

describe('when the upscaler exists', () => {
  function fakeServices(renderScale = 1) {
    const passes = new Map<string, PassDecl>(), declared = new Map<string, TextureDecl>(), compiled: string[] = [], destroyed: unknown[] = [];
    const ready = new Set<string>(), writes: Float32Array[] = [];
    const s = {
      ctx: {
        device: { createBindGroupLayout: () => ({}), createSampler: () => ({}), createBuffer: (d: GPUBufferDescriptor) => ({ label: d.label }),
          createBindGroup: () => ({}), createPipelineLayout: () => ({}) },
        queue: { writeBuffer: (_b: unknown, _o: number, data: ArrayBuffer) => { writes.push(new Float32Array(data.slice(0))); } },
        layouts: { frame: {} }, deferDestroy: (r: unknown) => { if (r) destroyed.push(r); },
        pipelines: { register: () => undefined, compile: (key: string) => { compiled.push(key); return Promise.resolve({}); }, get: (key: string) => ready.has(key) ? {} : undefined, shaderModule: () => ({}) },
      },
      graph: { declareTexture: (n: string, d: TextureDecl) => { declared.set(n, d); }, addPass: (p: PassDecl) => { passes.set(p.name, p); return () => { passes.delete(p.name); }; } },
      events: new EventBus(), settings: { renderScale, exposure: 0.2 }, frameUniforms: {},
    } as unknown as EngineServices;
    return { s, passes, declared, compiled, destroyed, ready, writes };
  }
  const frame = (index: number, snap = false) => ({ index, snap, internal: [1072, 670], display: [1600, 1000] }) as unknown as FrameState;
  // What taa.ts hands over: the levers, and whether the last 'resize' left the frame below display size.
  function host(s: EngineServices, enabled = () => true) {
    const state = { wanted: false };
    s.events.on('resize', e => { state.wanted = tsrWanted(e.display, e.internal); });
    const controls = { ...TSR_DEFAULTS, debugView: 'off', active: false } as TsrControls;
    return { state, controls, args: [{ output: 'taaColor', enabled, wanted: () => state.wanted }, controls] as const };
  }
  function context(f: FrameState): PassContext {
    const pass = { setPipeline: () => undefined, setBindGroup: () => undefined, dispatchWorkgroups: () => undefined, end: () => undefined };
    return { frame: f, timestampWrites: () => undefined, resources: { view: () => ({}), texture: () => ({}), history: () => ({}), size: () => [1072, 670] },
      encoder: { clearBuffer: () => undefined, beginComputePass: () => pass, copyTextureToTexture: () => undefined } } as unknown as PassContext;
  }

  it('declares no target, registers no pass and builds nothing at native', () => {
    const f = fakeServices(), tsr = installTsr(f.s, ...host(f.s).args);
    f.s.events.emit('resize', { display: [1600, 1000], internal: [1600, 1000], dpr: 1 });
    f.s.events.emit('frameEnd', { frame: frame(0) });
    expect(f.passes.size).toBe(0);
    expect(f.declared.size).toBe(0);
    expect(f.compiled).toEqual([]);
    expect(tsr.active()).toBe(false);
    expect(tsrWanted([1600, 1000], [1600, 1000])).toBe(false);
    expect(tsrWanted([1600, 1000], [2000, 1250])).toBe(false);
    expect(tsrWanted([1600, 1000], [1600, 999])).toBe(true);
  });

  it('builds below native, takes over once built, and lets go of everything back at native', () => {
    const f = fakeServices(), tsr = installTsr(f.s, ...host(f.s).args);
    f.s.events.emit('resize', { display: [1600, 1000], internal: [1072, 670], dpr: 1 });
    expect(f.compiled).toEqual(TSR_STAGES.map(stage => `post:tsr-${stage}`));
    expect(tsr.active()).toBe(false);
    for (const key of f.compiled) f.ready.add(key);
    f.s.events.emit('frameEnd', { frame: frame(0) });
    expect(tsr.active()).toBe(true);
    // The backdrop sits after the haze (volumetrics.composite, clouds −19) and before the clouds (raymarch 0, composite 2);
    // the opaque copy after the water (fluids.depth, transparent −10) and before the gas (fluids.gasDraw, −5).
    expect([...f.passes.values()].map(p => [p.name, p.slot, p.order])).toEqual([
      ['tsr.backdrop', 'clouds', -10], ['tsr.veil', 'clouds', 10], ['tsr.opaque', 'transparent', -7],
      ['tsr.reconstruct', 'taa', 0], ['tsr.mask', 'taa', 1], ['tsr.accumulate', 'taa', 2], ['tsr.sharpen', 'taa', 3]]);
    expect(f.passes.get('tsr.sharpen')!.writes).toEqual(['taaColor']);
    expect(f.declared.get(TSR_TEXTURES.history)).toMatchObject({ size: 'display', history: true });
    expect(f.declared.get(TSR_TEXTURES.depth)).toMatchObject({ size: 'internal', history: true, format: 'r32float' });
    f.passes.get('tsr.reconstruct')!.run(context(frame(1)));
    f.s.events.emit('resize', { display: [1600, 1000], internal: [1600, 1000], dpr: 1 });
    expect(tsr.active()).toBe(false);
    expect(f.passes.size).toBe(0);
    expect(f.destroyed.some(r => (r as { label?: string }).label === 'tsr:scatter')).toBe(true);
    tsr.dispose();
    expect(f.destroyed.some(r => (r as { label?: string }).label === 'tsr:params')).toBe(true);
  });

  it('builds at install when the saved scale is below native, or when loaded for a frame below display size', () => {
    const f = fakeServices(0.67);
    installTsr(f.s, ...host(f.s).args);
    expect(f.compiled.length).toBe(TSR_STAGES.length);
    const g = fakeServices(), h = host(g.s);
    h.state.wanted = true;
    installTsr(g.s, ...h.args);
    expect(g.compiled.length).toBe(TSR_STAGES.length);
  });

  it('drops the history on the first frame, a snap, an invalidation, a skipped frame, a resize and while switched off', () => {
    const f = fakeServices();
    let enabled = true;
    const tsr = installTsr(f.s, ...host(f.s, () => enabled).args);
    f.s.events.emit('resize', { display: [1600, 1000], internal: [1072, 670], dpr: 1 });
    for (const key of f.compiled) f.ready.add(key);
    f.s.events.emit('frameEnd', { frame: frame(0) });
    const reset = (fr: FrameState) => { f.passes.get('tsr.reconstruct')!.run(context(fr)); return f.writes.at(-1)![0]; };
    expect(reset(frame(10))).toBe(1);
    expect(reset(frame(11))).toBe(0);
    expect(reset(frame(12, true))).toBe(1);
    expect(reset(frame(13))).toBe(0);
    tsr.invalidate();
    expect(reset(frame(14))).toBe(1);
    expect(reset(frame(16))).toBe(1);
    f.s.events.emit('tierChanged', { tier: 'low' });
    expect(reset(frame(17))).toBe(1);
    expect(reset(frame(18))).toBe(0);
    enabled = false;
    expect(reset(frame(19))).toBe(1);
    expect(reset(frame(20))).toBe(1);
    expect(f.writes.at(-1)!.slice(1, 4)).toEqual(new Float32Array([TSR_DEFAULTS.sharpness, TSR_DEFAULTS.maxAccumulation, 0]));
  });
});

describe('the native resolver and the post chain', () => {
  it('keeps the TAA shader of 29baad2 byte for byte', () => {
    expect(createHash('sha256').update(taaWgsl.code).digest('hex')).toBe('c317476029041531065dbbef6bdeed34af7e55b8a7616c433f9f2212e523d842');
  });

  it('sizes displayHalf from the display, identical to half at native', () => {
    const graph = new FrameGraph({ device: { createTexture: () => ({}) } as never, deferDestroy: () => undefined, tickIndex: 0 }, null);
    graph.setSize([1600, 1000], [1072, 670]);
    const t = { format: 'rgba16float' as GPUTextureFormat, usage: 0 };
    expect(graph.sizeOf({ ...t, size: 'displayHalf' })).toEqual([800, 500]);
    expect(graph.sizeOf({ ...t, size: 'half' })).toEqual([536, 335]);
    graph.setSize([1601, 999], [1601, 999]);
    expect(graph.sizeOf({ ...t, size: 'displayHalf' })).toEqual(graph.sizeOf({ ...t, size: 'half' }));
  });

  it('declares the bloom chain at half the DISPLAY, so its width does not follow the render scale', () => {
    const declared: [string, TextureDecl][] = [];
    const events = new EventBus();
    const s = { ctx: { device: { createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createSampler: () => ({}), createBuffer: () => ({}), createBindGroup: () => ({}) },
      canvas: { width: 1600, height: 1000 }, layouts: { frame: {} }, queue: {}, deferDestroy: () => undefined,
      pipelines: { register: () => undefined, compile: () => Promise.resolve({}), shaderModule: () => ({}) } },
      graph: { declareTexture: (n: string, d: TextureDecl) => { declared.push([n, d]); }, addPass: () => () => undefined }, events, frameUniforms: {} } as unknown as EngineServices;
    void bloomModule().install(s);
    expect(declared.map(([n]) => n).sort()).toEqual(Object.values(BLOOM_TEXTURES).sort());
    expect(declared.every(([, d]) => d.size === 'displayHalf' && d.mipLevelCount === 6)).toBe(true);
    declared.length = 0;
    events.emit('resize', { display: [1600, 1000], internal: [800, 500], dpr: 1 });
    expect(declared).toEqual([]);
    events.emit('resize', { display: [40, 30], internal: [40, 30], dpr: 1 });
    expect(declared.every(([, d]) => d.mipLevelCount === 4)).toBe(true);
  });
});

describe('settings', () => {
  it('lists native first, starts automatic graphics conservatively, and preserves explicit upscaling steps', () => {
    expect(RENDER_SCALE_STEPS.map(s => s.scale)).toEqual([1, 0.77, 0.67, 0.5]);
    expect(DEFAULT_SETTINGS.graphics.tier).toBe('auto');
    expect(DEFAULT_SETTINGS.graphics.renderScale).toBe(0.67);
    const [min, max] = SETTING_RANGES.renderScale;
    for (const { scale } of RENDER_SCALE_STEPS) {
      expect(scale).toBeGreaterThanOrEqual(min); expect(scale).toBeLessThanOrEqual(max);
      expect(sanitizeSettings({ graphics: { renderScale: scale } }).graphics.renderScale).toBe(scale);
    }
  });
});

describe('licence notices', () => {
  const pmndrs = 'Copyright (c) 2026 Dennis Smolek';
  const amd = 'Copyright (c) 2021-2023 Advanced Micro Devices, Inc. All rights reserved.';
  const permission = 'The above copyright notice and this permission notice shall be included in all';
  it('carries both copyright lines and the MIT permission notice in the source and in the shipped notices file', () => {
    const source = readFileSync('src/engine/passes/post/tsr.wgsl.ts', 'utf8');
    const header = source.slice(0, source.indexOf('import '));
    const shipped = readFileSync('public/THIRD-PARTY-NOTICES.txt', 'utf8');
    for (const text of [header, shipped]) for (const line of [pmndrs, amd, permission, 'Permission is hereby granted, free of charge, to any person obtaining a copy']) expect(text).toContain(line);
    expect(shipped).toContain('src/engine/passes/post/tsr.wgsl.ts');
    // The build strips WGSL comments, so the shader text cannot be where the notice lives.
    expect(Object.values(tsrShaders()).some(s => s.code.includes('Dennis Smolek'))).toBe(false);
  });
});
