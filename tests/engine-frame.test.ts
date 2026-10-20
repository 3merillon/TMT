/**
 * Frame layer: reversed-Z infinite camera, depth reconstruction (CPU mirror of depth.wgsl), Halton jitter, snap, view
 * offset, project/unproject, frame uniforms, and the frame graph (ordering, validation, aliasing, history, one submit).
 */
import { describe, expect, it } from 'vitest';
import type { FrameState, PassDecl } from '../src/engine/contracts';
import { Camera, CAMERA_NEAR, jitterPixels, JITTER_SAMPLES, reversedInfinitePerspective, transformPoint } from '../src/engine/frame/camera';
import { FrameGraph, FRAME_SLOTS } from '../src/engine/frame/frame-graph';
import { packFrameUniforms } from '../src/engine/frame/frame-uniforms';
import { packPendingCuts } from '../src/engine/frame/pending-cuts';
import { FRAME_UNIFORMS } from '../src/engine/wgsl/common/frame.wgsl';

const f = Math.fround;
type V3 = [number, number, number];

/** f32 mirror of depth.wgsl world_pos_from_depth (view ray from the jittered proj terms + rigid inverse of view). */
function worldPosFromDepth(view: Float32Array, proj: Float32Array, uv: readonly [number, number], d: number): V3 {
  const ndcx = f(f(uv[0] * 2) - 1), ndcy = f(1 - f(uv[1] * 2));
  const near = proj[14];
  const lin = f(near / Math.max(d, 1e-30));
  const ray = [f(f(ndcx + proj[8]) / proj[0]), f(f(ndcy + proj[9]) / proj[5]), -1];
  const v = ray.map(c => f(c * lin));
  const t = [view[12], view[13], view[14]];
  const q = [f(v[0] - t[0]), f(v[1] - t[1]), f(v[2] - t[2])];
  const col = (c: number) => [view[c * 4], view[c * 4 + 1], view[c * 4 + 2]];
  const dot = (a: number[], b: number[]) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
  return [dot(col(0), q), dot(col(1), q), dot(col(2), q)];
}

function cameraAt(position: V3, target: V3, jitter = false, frame = 0, viewOffset?: [number, number, number, number]): Camera {
  const cam = new Camera();
  cam.update({ position, target, up: [0, 1, 0], fovY: 47 * Math.PI / 180, viewOffset }, [1920, 1080], [1920, 1080], jitter, frame);
  return cam;
}

describe('reversed-Z infinite projection', () => {
  it('maps the near plane to depth 1 and infinity to depth 0, monotonically', () => {
    const p = reversedInfinitePerspective({ fovY: 1, near: CAMERA_NEAR, width: 16, height: 9 });
    expect(p[10]).toBe(0);            // proj[2][2]
    expect(p[14]).toBeCloseTo(CAMERA_NEAR); // proj[3][2]
    expect(p[11]).toBe(-1);
    const depth = (dist: number) => { const c = transformPoint(p, [0, 0, -dist]); return c[2] / c[3]; };
    expect(depth(CAMERA_NEAR)).toBeCloseTo(1, 12);
    expect(depth(1e9)).toBeLessThan(1e-9);
    let last = 2;
    for (const dist of [0.08, 0.5, 6, 17, 36, 70, 1e4]) { const d = depth(dist); expect(d).toBeLessThan(last); last = d; expect(d).toBeCloseTo(CAMERA_NEAR / dist, 12); }
  });

  it('reconstructs world positions from depth within 1e-4 u at 60 u (f32, jittered, off-centre)', () => {
    const eye: V3 = [3, 25, 12];
    const cam = cameraAt(eye, [0, 0, 0], true, 5, [1920, 1080, 0, 1080 * 0.26]);
    let worst = 0;
    for (let i = 0; i < 64; i++) {
      // A point 60 u from the eye, spread across the view.
      const fx = ((i % 8) / 7 - 0.5) * 1.2, fy = (Math.floor(i / 8) / 7 - 0.5) * 0.7;
      const fwd = [-eye[0], -eye[1], -eye[2]]; const l = Math.hypot(...fwd); const dir = fwd.map(c => c / l);
      const right = [dir[2], 0, -dir[0]]; const rl = Math.hypot(...right); const r = right.map(c => c / rl);
      const up = [r[1] * dir[2] - r[2] * dir[1], r[2] * dir[0] - r[0] * dir[2], r[0] * dir[1] - r[1] * dir[0]];
      const raw = [0, 1, 2].map(k => dir[k] + r[k] * fx + up[k] * fy); const rawL = Math.hypot(...raw);
      const p = [0, 1, 2].map(k => eye[k] + raw[k] / rawL * 60) as V3;
      const clip = transformPoint(cam.viewProj, p);
      const d = f(clip[2] / clip[3]);
      const uv: [number, number] = [f((clip[0] / clip[3]) * 0.5 + 0.5), f(0.5 - (clip[1] / clip[3]) * 0.5)];
      const w = worldPosFromDepth(cam.view, cam.proj, uv, d);
      worst = Math.max(worst, Math.hypot(w[0] - p[0], w[1] - p[1], w[2] - p[2]));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('has 16 Halton(2,3) jitter samples with a mean under 0.05 px, off unless enabled', () => {
    let sx = 0, sy = 0;
    for (let i = 0; i < JITTER_SAMPLES; i++) {
      const [x, y] = jitterPixels(i);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5); expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      sx += x; sy += y;
    }
    expect(Math.abs(sx / JITTER_SAMPLES)).toBeLessThan(0.05);
    expect(Math.abs(sy / JITTER_SAMPLES)).toBeLessThan(0.05);
    expect(jitterPixels(3)).toEqual(jitterPixels(3 + JITTER_SAMPLES));
    const off = cameraAt([0, 0, 10], [0, 0, 0], false, 3);
    expect(off.jitter).toEqual([0, 0]);
    const on = cameraAt([0, 0, 10], [0, 0, 0], true, 3);
    expect(on.jitter[0]).toBeCloseTo(2 * jitterPixels(3)[0] / 1920, 12);
    expect(Array.from(on.viewProjNoJitter)).toEqual(Array.from(off.viewProjNoJitter));
    expect(on.proj[8]).not.toBe(off.proj[8]);
  });
});

describe('camera history, snap, view offset and projection', () => {
  it('keeps the previous unjittered view-projection and flags jumps over 3 u', () => {
    const cam = new Camera();
    const rig = (x: number) => ({ position: [x, 5, 20] as V3, target: [0, 0, 0] as V3, up: [0, 1, 0] as V3, fovY: 0.8 });
    cam.update(rig(0), [800, 600], [800, 600], false, 0);
    expect(cam.snap).toBe(true); // first frame
    const before = new Float32Array(cam.viewProjNoJitter);
    cam.update(rig(0.5), [800, 600], [800, 600], true, 1);
    expect(cam.snap).toBe(false);
    expect(Array.from(cam.prevViewProj)).toEqual(Array.from(before));
    cam.update(rig(4), [800, 600], [800, 600], true, 2);
    expect(cam.snap).toBe(true);
    expect(Array.from(cam.prevViewProj)).toEqual(Array.from(cam.viewProjNoJitter)); // history reset on snap
  });

  it('shifts the image like three.js setViewOffset(w, h, 0, 0.26h, w, h)', () => {
    const plain = cameraAt([0, 0, 10], [0, 0, 0]);
    const shifted = cameraAt([0, 0, 10], [0, 0, 0], false, 0, [1920, 1080, 0, 1080 * 0.26]);
    const a = plain.project([0, 0, 0]), b = shifted.project([0, 0, 0]);
    expect(a.x).toBeCloseTo(960, 6); expect(a.y).toBeCloseTo(540, 6);
    expect(b.x).toBeCloseTo(960, 6); expect(b.y).toBeCloseTo(540 - 1080 * 0.26, 6);
  });

  it('round-trips project / unproject in CSS pixels', () => {
    const cam = cameraAt([4, 9, 14], [0, 1, 0]);
    const p: V3 = [1.5, 0.5, -2];
    const s = cam.project(p);
    expect(s.visible).toBe(true);
    const clip = transformPoint(cam.viewProjNoJitter, p);
    const back = cam.unproject(s.x, s.y, clip[2] / clip[3]).point!;
    expect(Math.hypot(back[0] - p[0], back[1] - p[1], back[2] - p[2])).toBeLessThan(1e-6);
    expect(cam.project([-40, -40, 100]).visible).toBe(false); // behind the camera
  });

  it('packs FrameState and extras into the 512 B uniform block', () => {
    const cam = cameraAt([0, 0, 30], [0, 0, 0]);
    const state: FrameState = {
      index: 42, time: 1.5, dt: 0.016, tier: 'high', internal: [960, 540], display: [1920, 1080],
      view: cam.view, proj: cam.proj, viewProj: cam.viewProj, invViewProj: cam.invViewProj, prevViewProj: cam.prevViewProj, viewProjNoJitter: cam.viewProjNoJitter,
      eye: [0, 0, 30], jitter: [0, 0], sunDir: [0, 1, 0], focus: { world: [0, 18, 0], tilt: 0.5, distance: 17 },
    };
    const buf = packFrameUniforms(state, { sunRadiance: [20, 20, 20], exposure: 0.2, prevJitter: [0, 0], planet: { center: [0, 0, 0], radius: 18, seaRadius: 17.2 }, renderScale: 0.5 });
    const fl = new Float32Array(buf);
    expect(buf.byteLength).toBe(512);
    const o = (k: string) => FRAME_UNIFORMS.offsets[k] / 4;
    expect(fl[o('proj') + 14]).toBeCloseTo(CAMERA_NEAR, 6);
    expect(Array.from(fl.subarray(o('viewport'), o('viewport') + 4))).toEqual([960, 540, 1920, 1080]);
    expect(Array.from(fl.subarray(o('misc'), o('misc') + 4)).map(v => Math.round(v * 100) / 100)).toEqual([42, 0.5, 2, 17.2]);
    expect(fl[o('exposure')]).toBeCloseTo(0.2, 6);
    const cuts = new Float32Array(packPendingCuts([{ center: [1, 2, 3], radius: 1.5, t0: 9 }]));
    expect(new Uint32Array(cuts.buffer)[0]).toBe(1);
    expect(Array.from(cuts.subarray(4, 8))).toEqual([1, 2, 3, 1.5]);
  });
});

// ───────────────────────────── Frame graph ─────────────────────────────
function fakeGraphCtx() {
  let tick = 0, textures = 0, submits = 0;
  const device = {
    createTexture(d: GPUTextureDescriptor) {
      textures++;
      const size = d.size as GPUExtent3DDict;
      const t = { label: d.label, width: size.width, height: size.height ?? 1, format: d.format, destroyed: false, createView: () => ({ of: t }), destroy() { t.destroyed = true; } };
      return t as unknown as GPUTexture;
    },
    createCommandEncoder: () => ({ pushDebugGroup() { /* */ }, popDebugGroup() { /* */ }, finish: () => ({}) }) as unknown as GPUCommandEncoder,
    queue: { submit: () => { submits++; } },
  };
  const ctx = { device: device as never, deferDestroy() { /* */ }, get tickIndex() { return tick; } };
  return { ctx, stats: () => ({ textures, submits }), advance: () => { tick++; } };
}

const frame = (index: number): FrameState => ({
  index, time: index / 60, dt: 1 / 60, tier: 'high', internal: [64, 32], display: [128, 64],
  view: new Float32Array(16), proj: new Float32Array(16), viewProj: new Float32Array(16), invViewProj: new Float32Array(16),
  prevViewProj: new Float32Array(16), viewProjNoJitter: new Float32Array(16), eye: [0, 0, 0], jitter: [0, 0], sunDir: [0, 1, 0],
  focus: { world: [0, 0, 0], tilt: 0, distance: 1 },
});

const tex = { format: 'rgba8unorm' as GPUTextureFormat, size: 'internal' as const, usage: 0x14 };

describe('frame graph', () => {
  it('runs passes in slot order, then order, then registration, with one submit per frame', () => {
    const g = fakeGraphCtx();
    const graph = new FrameGraph(g.ctx, null, { dev: true });
    const ran: string[] = [];
    const pass = (name: string, slot: PassDecl['slot'], order?: number): PassDecl => ({ name, slot, order, reads: [], writes: [], run: () => { ran.push(name); } });
    graph.addPass(pass('composite', 'composite'));
    graph.addPass(pass('lighting', 'lighting'));
    graph.addPass(pass('upload-b', 'upload', 5));
    graph.addPass(pass('upload-a', 'upload', 5));
    graph.addPass(pass('upload-first', 'upload', -1));
    graph.addPass({ ...pass('skipped', 'debug'), enabled: () => false });
    graph.execute(frame(0));
    expect(ran).toEqual(['upload-first', 'upload-b', 'upload-a', 'lighting', 'composite']);
    expect(graph.lastExecuted).toEqual(ran);
    graph.execute(frame(1));
    expect(g.stats().submits).toBe(2);
    expect(() => graph.addPass(pass('lighting', 'lighting'))).toThrow(/already registered/);
    expect(() => graph.addPass(pass('x', 'nope' as never))).toThrow(/unknown slot/);
    expect(FRAME_SLOTS[0]).toBe('upload');
    expect(FRAME_SLOTS.at(-1)).toBe('debug');
  });

  it('throws on read-before-write and on undeclared access in dev', () => {
    const g = fakeGraphCtx();
    const graph = new FrameGraph(g.ctx, null, { dev: true });
    graph.declareTexture('a', tex);
    graph.addPass({ name: 'reader', slot: 'lighting', reads: ['a'], writes: [], run: () => undefined });
    graph.addPass({ name: 'writer', slot: 'composite', reads: [], writes: ['a'], run: () => undefined });
    expect(() => graph.execute(frame(0))).toThrow(/read-before-write/);

    const g2 = fakeGraphCtx();
    const graph2 = new FrameGraph(g2.ctx, null, { dev: true });
    graph2.declareTexture('a', tex);
    graph2.declareTexture('b', tex);
    graph2.addPass({ name: 'w', slot: 'upload', reads: [], writes: ['a', 'b'], run: () => undefined });
    graph2.addPass({ name: 'sneaky', slot: 'lighting', reads: ['a'], writes: [], run: c => { c.resources.view('b'); } });
    expect(() => graph2.execute(frame(0))).toThrow(/without declaring/);

    const g3 = fakeGraphCtx();
    const graph3 = new FrameGraph(g3.ctx, null, { dev: true });
    graph3.declareTexture('h', { ...tex, history: true });
    graph3.addPass({ name: 'taa', slot: 'taa', reads: [], writes: ['h'], run: c => { c.resources.history('h'); } });
    expect(() => graph3.execute(frame(0))).toThrow(/history of "h" without declaring/);
    const g4 = fakeGraphCtx();
    const graph4 = new FrameGraph(g4.ctx, null, { dev: true });
    graph4.declareTexture('t', tex);
    graph4.addPass({ name: 'bad', slot: 'taa', reads: ['history:t'], writes: ['t'], run: () => undefined });
    expect(() => graph4.execute(frame(0))).toThrow(/not a history texture/);
  });

  it('aliases transient textures with disjoint lifetimes and keeps overlapping ones apart', () => {
    const g = fakeGraphCtx();
    const graph = new FrameGraph(g.ctx, null, { dev: true });
    for (const n of ['a', 'b', 'c']) graph.declareTexture(n, tex);
    graph.declareTexture('other', { ...tex, format: 'rgba16float' });
    graph.addPass({ name: 'p1', slot: 'upload', reads: [], writes: ['a'], run: () => undefined });
    graph.addPass({ name: 'p2', slot: 'compute.pre', reads: ['a'], writes: ['other'], run: () => undefined });
    graph.addPass({ name: 'p3', slot: 'lighting', reads: ['other'], writes: ['b'], run: () => undefined });
    graph.addPass({ name: 'p4', slot: 'composite', reads: ['b'], writes: ['c'], run: c => { c.resources.view('b'); c.resources.view('c'); } });
    const alias = graph.aliasing();
    expect(alias.a).toBe(alias.b);          // a dies at p2, b is born at p3
    expect(alias.c).not.toBe(alias.b);      // b and c are both live in p4
    expect(alias.other).not.toBe(alias.a);  // different descriptor
    expect(graph.physicalTextureCount).toBe(3);
    graph.execute(frame(0));
    expect(g.stats().textures).toBe(3);
    graph.execute(frame(1));
    expect(g.stats().textures).toBe(3);      // stable across frames
  });

  it('ping-pongs history textures and sizes by class', () => {
    const g = fakeGraphCtx();
    const graph = new FrameGraph(g.ctx, null, { dev: true });
    graph.setSize([128, 64], [64, 32]);
    graph.declareTexture('h', { ...tex, history: true });
    graph.declareTexture('q', { ...tex, size: 'quarter' });
    const seen: { cur: unknown; prev: unknown; qSize: readonly number[] }[] = [];
    graph.addPass({ name: 'taa', slot: 'taa', reads: ['history:h'], writes: ['h', 'q'], run: c => { seen.push({ cur: c.resources.view('h'), prev: c.resources.history('h'), qSize: c.resources.size('q') }); } });
    graph.execute(frame(0));
    graph.execute(frame(1));
    graph.execute(frame(2));
    expect(seen[1].prev).toBe(seen[0].cur);
    expect(seen[2].prev).toBe(seen[1].cur);
    expect(seen[2].cur).toBe(seen[0].cur);
    expect(seen[0].qSize).toEqual([16, 8]);
  });

  it('lets persistent textures be read in later frames without a writer, until reallocated', () => {
    const g = fakeGraphCtx();
    const graph = new FrameGraph(g.ctx, null, { dev: true });
    graph.declareTexture('lut', { ...tex, size: [32, 32], persistent: true });
    let bake = true;
    graph.addPass({ name: 'bake', slot: 'compute.pre', reads: [], writes: ['lut'], enabled: () => bake, run: () => undefined });
    graph.addPass({ name: 'use', slot: 'lighting', reads: ['lut'], writes: [], run: () => undefined });
    graph.execute(frame(0));
    bake = false;
    expect(() => graph.execute(frame(1))).not.toThrow();
    graph.declareTexture('lut', { ...tex, size: [64, 64], persistent: true }); // new size → new texture → contents gone
    expect(() => graph.execute(frame(2))).toThrow(/read-before-write/);
  });

  it('reallocates on resize and imports external buffers as always readable', () => {
    const g = fakeGraphCtx();
    const graph = new FrameGraph(g.ctx, null, { dev: true });
    graph.declareTexture('a', tex);
    graph.importBuffer('frameUniforms', {} as GPUBuffer);
    graph.addPass({ name: 'w', slot: 'gbuffer.opaque', reads: ['frameUniforms'], writes: ['a'], run: c => { c.resources.buffer('frameUniforms'); } });
    graph.execute(frame(0));
    const before = g.stats().textures;
    graph.setSize([256, 128], [256, 128]);
    graph.execute(frame(1));
    expect(g.stats().textures).toBe(before + 1);
  });
});
