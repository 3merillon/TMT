// Grass culling (src/engine/passes/vegetation/grass.ts): the indexed blade reproduces every list vertex, the cull radii
// bound every vertex the vertex shaders can emit, the cull thresholds sit at or beyond the shaders' own zero points, and
// the module draws only what this frame's cull listed.
import { describe, expect, it } from 'vitest';
import type { EngineServices, FrameState, GBufferDrawer, PassContext, PassDecl } from '../src/engine/contracts';
import { GRASS_BLADE_INDICES, grassBladeReach, grassModule, grassShadowReach } from '../src/engine/passes/vegetation/grass';

type V3 = [number, number, number];
const f = Math.fround;
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));
function mulberry(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** grass_height with the textures' answers given: burn, and the water texel (level, coverage) or none. */
function grassHeight(p: V3, w: number, burn: number, water: [number, number] | null): number {
  if (w === 0) return 0;
  const growth = 1 - smoothstep(0.16, 0.42, burn);
  if (water) { const depth = water[0] - Math.hypot(...p); if (water[1] > 0.08 && depth > 0.18) return -Math.min(depth * 0.7, Math.abs(w) * 1.5) * growth; }
  return (w < 0 ? 0.22 : w) * growth;
}

interface BladeInputs { root: V3; w: number; h: number; kind: number; hashHeight: number; burn: number; water: [number, number] | null; crush: number;
  dist: number; pixel: number; bend: number; blast: V3 }
/** The blade vertex shader's position (grass.ts vs) for corner (side, tip), from the per-blade inputs. */
function bladeVertex(b: BladeInputs, side: number, tip: number): V3 {
  const up = norm(b.root);
  const axis: V3 = Math.abs(up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a = norm(cross(up, axis)), bb = cross(up, a);
  const tangent = add(scale(a, Math.cos(b.h * 6.283185)), scale(bb, Math.sin(b.h * 6.283185)));
  const lean = cross(tangent, up);
  const broad = b.kind > 0.64, tuft = b.kind < 0.25;
  const local = grassHeight(b.root, b.w, b.burn, b.water);
  const aquatic = local < 0;
  let height = Math.abs(local) * mix(0.75, 1.15, b.hashHeight) * (tuft ? 0.72 : 1) * (1 - smoothstep(48, 64, b.dist));
  const crushed = smoothstep(0, 1, b.crush);
  const standing = height;
  height *= 1 - 0.92 * crushed;
  const width = Math.max(broad ? 0.028 : 0.016, Math.min(0.055, b.pixel * 0.5));
  const windScale = 1 - smoothstep(18, 45, b.dist) * 0.85;
  const wind = b.bend * windScale * (aquatic ? 2.5 : 1) * (1 - crushed);
  const curve = standing * (broad ? 0.65 : 0.22) + standing * crushed * 0.8;
  const profile = (1 - tip) * (0.65 + tip * 1.2);
  const blast = scale(b.blast, standing * (1 - crushed));
  let p = add(b.root, scale(tangent, (b.h - 0.5) * 0.1));
  p = add(p, scale(up, height * tip + crushed * 0.07));
  p = add(p, scale(tangent, side * width * profile));
  p = add(p, scale(lean, (wind + curve) * tip * tip));
  return add(p, scale(blast, tip * tip));
}

describe('indexed blade', () => {
  it('reproduces the (side, tip) of all 18 list vertices, triangle by triangle, in f32', () => {
    expect(GRASS_BLADE_INDICES).toHaveLength(18);
    for (let vi = 0; vi < 18; vi++) {
      const side = [-1, 1, 1, -1, 1, -1][vi % 6], tip = f(f(Math.floor(vi / 6) + [0, 0, 1, 0, 1, 1][vi % 6]) / 3);
      const u = GRASS_BLADE_INDICES[vi];
      expect([u & 1 ? 1 : -1, f(Math.floor(u / 2) / 3)]).toEqual([side, tip]);
      // The same value whether the GPU divides or multiplies by the rounded reciprocal.
      expect(f(Math.floor(u / 2) * f(1 / 3))).toBe(tip);
    }
    expect(new Set(GRASS_BLADE_INDICES).size).toBe(8);
  });
});

describe('cull radii', () => {
  it('bound every blade vertex: wind, curl, crush, flood, scorch, distance and a full blast', () => {
    const rnd = mulberry(11);
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      const dir = norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), radius = 14 + rnd() * 9, root = scale(dir, radius);
      const aquaticRoot = rnd() < 0.3;
      const w = aquaticRoot ? -(0.135 + rnd() * 0.585) : 0.16 + rnd() * 0.2;
      const extreme = rnd() < 0.5;
      const b: BladeInputs = { root, w, h: rnd(), kind: rnd(), hashHeight: extreme ? 1 : rnd(), burn: extreme ? 0 : rnd() * 0.5,
        water: rnd() < 0.5 ? [radius + rnd() * 3, rnd()] : null, crush: extreme ? 0 : rnd(), dist: extreme ? rnd() * 18 : rnd() * 70,
        pixel: rnd() * 0.3, bend: (rnd() * 2 - 1) * 0.055, blast: scale(norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), extreme ? 1 : rnd()) };
      const reach = grassBladeReach(w);
      for (const tip of [0, 1 / 3, 2 / 3, 1]) for (const side of [-1, 1]) {
        const d = Math.hypot(...add(bladeVertex(b, side, tip), scale(root, -1)));
        expect(d).toBeLessThan(reach);
        worst = Math.max(worst, d / reach);
      }
    }
    // Loose enough for f32 rounding, tight enough to matter at the frustum edges.
    expect(worst).toBeGreaterThan(0.5);
  });

  it('bound every clump shadow corner', () => {
    const rnd = mulberry(5);
    for (let i = 0; i < 5000; i++) {
      const up = norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), root = scale(up, 15 + rnd() * 8);
      const sun = norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]), sunUp = dot(up, sun);
      const projection = scale(add(sun, scale(up, -sunUp)), -1), length = Math.hypot(...projection);
      const fallback = norm(cross(up, Math.abs(up[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
      const axis = length > 0.001 ? scale(projection, 1 / Math.max(length, 1e-5)) : fallback, side = cross(up, axis);
      const height = rnd() * 1.3, reach = Math.min(0.1, height * length * 0.35), pixel = rnd() * 0.4;
      const width = Math.sqrt(0.065 * 0.065 + pixel * pixel * 0.4), centre = add(root, scale(up, 0.075));
      for (const q of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const corner = add(add(centre, scale(axis, reach * 0.5 + q[0] * (reach * 0.5 + width * 2.5))), scale(side, q[1] * width * 2.5));
        expect(Math.hypot(...add(corner, scale(root, -1)))).toBeLessThan(grassShadowReach(width));
      }
    }
  });

  it('keep everything short of the vertex shaders exact zero points', () => {
    expect(1 - smoothstep(48, 64, 64)).toBe(0);            // blade fade: culled from 64.01
    expect(1 - smoothstep(16, 30, 30)).toBe(0);            // clump shadow fade: culled from 30.01
    expect(smoothstep(0.05, 0.3, 0.05)).toBe(0);           // sun: culled below 0.0499
    expect(1 - smoothstep(0.16, 0.42, 0.42)).toBe(0);      // scorch: culled above 0.43
    expect(grassHeight([0, 18, 0], 0.3, 0.42, null)).toBe(0);
    expect(grassHeight([0, 18, 0], -0.4, 0.42, [19, 1])).toBe(-0);
  });
});

describe('module wiring', () => {
  it('draws only after this frame\'s cull, from the indirect lists, and releases every buffer', async () => {
    const passes = new Map<string, PassDecl>(), drawers: GBufferDrawer[] = [], facets = new Map<string, unknown>();
    const buffers: object[] = [], destroyed: object[] = [], calls: string[] = [];
    const encoderPass = new Proxy({}, { get: (_t, name) => typeof name !== 'string' ? undefined : (...a: unknown[]) => {
      calls.push(/^(draw|dispatch)/.test(name) ? `${name}(${a.filter(x => typeof x === 'number').join(',')})` : name);
    } });
    const s = {
      ctx: {
        device: { createBuffer: () => { const b = {}; buffers.push(b); return b; }, createSampler: () => ({}), createBindGroupLayout: () => ({}),
          createBindGroup: () => ({}), createPipelineLayout: () => ({}) },
        queue: { writeBuffer: () => undefined }, layouts: { frame: {} },
        pipelines: { register: () => undefined, compile: async () => ({}), get: () => ({}), shaderModule: () => ({}) },
        deferDestroy: (b: object) => destroyed.push(b),
      },
      graph: { addPass: (p: PassDecl) => { passes.set(p.name, p); return () => passes.delete(p.name); } },
      scene: { provide: (k: string, v: unknown) => facets.set(k, v), get: (k: string) => facets.get(k),
        addGBufferDrawer: (d: GBufferDrawer) => { drawers.push(d); return () => drawers.splice(drawers.indexOf(d), 1); } },
      bindings: { get: () => ({ cube: {}, surface: {} }) },
      events: { on: () => () => undefined }, frameUniforms: {}, telemetry: { gauge: () => undefined },
    } as unknown as EngineServices;
    facets.set('planet', { seed: 7, kind: 'temperate', radius: 18 });
    facets.set('sdf', { valid: true, serial: 1, volumeView: {}, paramsBuffer: {}, band: {} });
    const module = grassModule(); await module.install(s);
    const viewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0.08, 0]);
    const frame = (index: number) => ({ index, time: index / 60, viewProj }) as unknown as FrameState;
    const ctx = (index: number) => ({ frame: frame(index), encoder: { beginComputePass: () => encoderPass, beginRenderPass: () => encoderPass },
      timestampWrites: () => undefined, resources: { view: () => ({}) } }) as unknown as PassContext;
    // Before the cull has run in a frame, nothing is drawn.
    drawers[0].draw(encoderPass as GPURenderPassEncoder, frame(0));
    expect(passes.get('grass.shadows')!.enabled!(frame(0))).toBe(false);
    expect(calls).toEqual([]);
    passes.get('grass.place')!.run(ctx(1));
    expect(passes.get('grass.cull')!.enabled!(frame(1))).toBe(true);
    passes.get('grass.cull')!.run(ctx(1));
    expect(calls.filter(c => c.startsWith('dispatch'))).toEqual(['dispatchWorkgroups(3456)', 'dispatchWorkgroups(3456)', 'dispatchWorkgroups(54)']);
    calls.length = 0;
    drawers[0].draw(encoderPass as GPURenderPassEncoder, frame(1));
    expect(calls).toContain('drawIndexedIndirect(0)');
    expect(passes.get('grass.shadows')!.enabled!(frame(1))).toBe(true);
    passes.get('grass.shadows')!.run(ctx(1));
    expect(calls).toContain('drawIndirect(20)');
    // A stale list is never drawn in a later frame.
    calls.length = 0;
    drawers[0].draw(encoderPass as GPURenderPassEncoder, frame(2));
    expect(passes.get('grass.shadows')!.enabled!(frame(2))).toBe(false);
    expect(calls).toEqual([]);
    (facets.get('grass') as { density: number }).density = 0;
    expect(passes.get('grass.cull')!.enabled!(frame(3))).toBe(false);
    module.dispose!();
    expect(destroyed).toHaveLength(buffers.length);
    expect(buffers.every(b => destroyed.includes(b))).toBe(true);
    expect(passes.size).toBe(0); expect(drawers).toHaveLength(0);
  });
});
