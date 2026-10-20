import { describe, expect, it } from 'vitest';
import { MAX_SHOCKWAVES, SHOCKWAVE_PROFILES, ShockwavePool, shockwaveState, visibleShellLength } from '../src/engine/passes/shockwaves/shockwave-pool';
import { SHOCKWAVE_UNIFORMS } from '../src/engine/passes/shockwaves/shockwaves.wgsl';
import type { ShockwaveKind } from '../src/engine/passes/shockwaves/shockwave-pool';
import type { EngineServices, PassContext, PassDecl } from '../src/engine/contracts';
import { shockwaveRect, shockwavesModule, type ShockwaveFacet } from '../src/engine/passes/shockwaves/shockwaves';

describe('pressure front lifetime and allocation bounds', () => {
  it('keeps repeated nuclear blasts bounded, scales down live capacity, and clears before another scene', () => {
    const pool = new ShockwavePool();
    for (let i = 0; i < 1000; i++) pool.emit([i, 18, 0], [0, 1, 0], 4, 'nuclear');
    expect(pool.waves.length).toBe(MAX_SHOCKWAVES);
    expect(pool.emitted).toBe(1000);
    expect(pool.replaced).toBe(1000 - MAX_SHOCKWAVES);
    expect(SHOCKWAVE_UNIFORMS.size).toBe(400);
    pool.setTier('low');
    expect(pool.capacity).toBe(3);
    expect(pool.waves.map(w => w.center[0])).toEqual([997, 998, 999]);
    pool.clear();
    expect(pool.waves).toHaveLength(0);
    pool.emit([0, 18, 0], [0, 1, 0], 1, 'explosive');
    pool.advance(2);
    expect(pool.waves).toHaveLength(0);
  });

  it('copies impact pose and keeps ammunition identity through later caller changes', () => {
    const pool = new ShockwavePool();
    const position = [2, 18, 4], normal = [0, 10, 0];
    pool.emit(position, normal, 2, 'heavy');
    position.fill(100); normal.fill(50);
    expect(pool.waves[0]).toMatchObject({ center: [2, 18.2, 4], normal: [0, 1, 0], kind: 'heavy', radius: 2 });
    pool.emit([NaN, 1, 0], [0, 1, 0], 2, 'nuclear');
    pool.emit([0, 1, 0], [0, 1, 0], Infinity, 'nuclear');
    expect(pool.waves).toHaveLength(1);
    pool.advance(NaN); pool.advance(-1);
    expect(pool.waves[0].age).toBe(0);
  });

  it('expands monotonically, stays thin, and fades fully for each type', () => {
    const reach = {} as Record<ShockwaveKind, number>;
    for (const kind of Object.keys(SHOCKWAVE_PROFILES) as ShockwaveKind[]) {
      const pool = new ShockwavePool(); pool.emit([0, 18, 0], [0, 1, 0], 2, kind);
      const wave = pool.waves[0];
      let last = 0;
      for (let step = 0; step <= 100; step++) {
        wave.age = SHOCKWAVE_PROFILES[kind].duration * step / 100;
        const state = shockwaveState(wave);
        expect(state.radius).toBeGreaterThanOrEqual(last);
        expect(state.thickness).toBeLessThan(state.radius * 0.1);
        expect(state.fade).toBeGreaterThanOrEqual(0);
        expect(state.fade).toBeLessThanOrEqual(1);
        last = state.radius;
      }
      expect(shockwaveState(wave).fade).toBe(0);
      reach[kind] = last;
    }
    expect(reach.nuclear).toBeGreaterThan(reach.heavy);
    expect(reach.heavy).toBeGreaterThan(reach.explosive);
    expect(reach.explosive).toBeGreaterThan(reach.incendiary);
  });
});

describe('thin sphere optical depth with scene clipping', () => {
  const eye: [number, number, number] = [0, 0, 10];
  const ray: [number, number, number] = [0, 0, -1];
  const center: [number, number, number] = [0, 0, 0];
  it('is invisible behind a foreground object, visible against sky, and stops at terrain', () => {
    expect(visibleShellLength(eye, ray, center, 2, 0.05, 7)).toBe(0);
    expect(visibleShellLength(eye, ray, center, 2, 0.05, 1000)).toBeCloseTo(0.1, 8);
    expect(visibleShellLength(eye, ray, center, 2, 0.05, 9)).toBeCloseTo(0.05, 8);
    expect(visibleShellLength(eye, ray, center, 2, 0.05, 8.025)).toBeCloseTo(0.025, 8);
  });
  it('handles grazing rays, a missed shell and the camera passing through the shell', () => {
    expect(visibleShellLength([1.99, 0, 10], ray, center, 2, 0.05, 1000)).toBeGreaterThan(0.1);
    expect(visibleShellLength([2.01, 0, 10], ray, center, 2, 0.05, 1000)).toBe(0);
    expect(visibleShellLength(center, ray, center, 2, 0.05, 1000)).toBeCloseTo(0.05, 8);
    expect(visibleShellLength(center, ray, center, 2, 0.05, 1)).toBe(0);
  });
});

describe('pressure front GPU resource lifetime', () => {
  it('allocates once across shots, does no drawing when idle, and unregisters/destroys on disposal', () => {
    const passes = new Map<string, PassDecl>();
    const events = new Map<string, (event: never) => void>();
    const facets = new Map<string, unknown>();
    const buffers: object[] = [], destroyed: object[] = [];
    let writes = 0;
    const s = {
      ctx: {
        device: { createBuffer: () => { const buffer = {}; buffers.push(buffer); return buffer; }, createSampler: () => ({}),
          createBindGroupLayout: () => ({}), createBindGroup: () => ({}) },
        queue: { writeBuffer: () => writes++ }, layouts: { frame: {} },
        pipelines: { register: () => undefined, compile: async () => undefined },
        deferDestroy: (buffer: object) => destroyed.push(buffer),
      },
      graph: { addPass: (pass: PassDecl) => { passes.set(pass.name, pass); return () => passes.delete(pass.name); } },
      scene: { provide: (key: string, value: unknown) => facets.set(key, value), get: (key: string) => facets.get(key) },
      events: { on: (name: string, listener: (event: never) => void) => { events.set(name, listener); return () => events.delete(name); } },
      telemetry: { gauge: () => undefined }, settings: { tier: 'high' }, frameUniforms: {},
    } as unknown as EngineServices;
    const module = shockwavesModule(); module.install(s);
    const facet = facets.get('shockwaves') as ShockwaveFacet;
    const frame = { dt: 0, tier: 'high' } as PassContext['frame'];
    expect(passes.get('shockwaves')!.enabled!(frame)).toBe(false);
    for (let i = 0; i < 1000; i++) {
      facet.emit([0, 18, 0], [0, 1, 0], 4, 'nuclear');
      passes.get('shockwaves.update')!.run({ frame } as PassContext);
    }
    expect(buffers).toHaveLength(1);
    expect(writes).toBe(1000);
    expect(facet.stats()).toMatchObject({ live: 8, emitted: 1000, bytes: 400 });
    events.get('planetChanged')!({} as never);
    expect(facet.stats().live).toBe(0);
    expect(passes.get('shockwaves')!.enabled!(frame)).toBe(false);
    passes.get('shockwaves.update')!.run({ frame } as PassContext);
    expect(writes).toBe(1000);
    module.dispose!(); module.dispose!();
    expect(destroyed).toEqual(buffers);
    expect(passes.size).toBe(0); expect(events.size).toBe(0);
  });
});

describe('shockwave scissor', () => {
  // A column-major view-projection whose clip w is the distance along the view direction (as the engine's).
  const camera = (eye: number[], target: number[], tanY: number, aspect: number) => {
    const fwd = target.map((v, i) => v - eye[i]), fl = Math.hypot(...fwd); for (let i = 0; i < 3; i++) fwd[i] /= fl;
    const right = [fwd[2], 0, -fwd[0]], rl = Math.hypot(...right); for (let i = 0; i < 3; i++) right[i] /= rl;
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const m = new Float32Array(16), tanX = tanY * aspect, dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let a = 0; a < 3; a++) { m[a * 4] = right[a] / tanX; m[a * 4 + 1] = up[a] / tanY; m[a * 4 + 3] = fwd[a]; }
    m[12] = -dot(eye, right) / tanX; m[13] = -dot(eye, up) / tanY; m[15] = -dot(eye, fwd);
    return { m, ray: (x: number, y: number) => { const r = [0, 1, 2].map(a => fwd[a] + x * tanX * right[a] + y * tanY * up[a]), l = Math.hypot(...r); return r.map(v => v / l); } };
  };

  it('contains every pixel whose ray meets a wave out to its contact wake, and falls back to the full view near one', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const [width, height] = [320, 200], uniforms = new Float32Array(SHOCKWAVE_UNIFORMS.size / 4);
    const centers = SHOCKWAVE_UNIFORMS.offsets.centers / 4, motions = SHOCKWAVE_UNIFORMS.offsets.motions / 4;
    let scissored = 0;
    for (let trial = 0; trial < 60; trial++) {
      const eye = [random() * 20 - 10, 18 + random() * 6, random() * 20 - 10], target = [random() * 4 - 2, 17 + random(), random() * 4 - 2];
      const view = camera(eye, target, Math.tan(0.41), width / height), count = 1 + Math.floor(random() * 3);
      const spheres: { c: number[]; r: number }[] = [];
      for (let i = 0; i < count; i++) {
        const c = [random() * 16 - 8, 16 + random() * 3, random() * 16 - 8], blast = 1 + random() * 3, front = blast * (0.2 + random() * 3);
        uniforms.set([...c, front], centers + i * 4); uniforms[motions + i * 4 + 2] = blast;
        spheres.push({ c, r: front + 0.25 * Math.max(0.06, blast * 0.1) });
      }
      const rect = shockwaveRect(view.m, [width, height], uniforms, count);
      if (!rect) continue;
      scissored++;
      for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
        const d = view.ray(((x + 0.5) / width) * 2 - 1, 1 - ((y + 0.5) / height) * 2);
        const hit = spheres.some(({ c, r }) => {
          const o = eye.map((v, i) => v - c[i]), b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], disc = b * b - (o[0] ** 2 + o[1] ** 2 + o[2] ** 2) + r * r;
          return disc > 0 && -b + Math.sqrt(disc) > 0;
        });
        if (hit) expect(x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3]).toBe(true);
      }
    }
    expect(scissored).toBeGreaterThan(10);
    // The eye inside a wave's reach sees it everywhere: no scissor.
    uniforms.set([0, 18, 0, 3], centers); uniforms[motions + 2] = 2;
    expect(shockwaveRect(camera([0, 18.5, 0], [1, 18, 1], 0.4, 1.6).m, [width, height], uniforms, 1)).toBeNull();
  });
});
