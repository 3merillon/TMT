/**
 * Exact sun classes (src/engine/passes/atmosphere/sun-class.ts): a CPU mirror of the bounds, the dilation and the
 * per-cell proof over a synthetic planet field, checked against the marches it answers for (atmo_terrain_lit and the
 * haze's volume_sun_visible) at random points of every certain cell, for suns anywhere within the drift allowance.
 */
import { describe, expect, it } from 'vitest';
import type { EngineServices } from '../src/engine/contracts';
import { lightingModule } from '../src/engine/passes/lighting/lighting';
import { SUN_CLASS, SUN_CLASS_CELL, SUN_CLASS_DRIFT, sunClassClassifyWgsl, sunClassLookupWgsl } from '../src/engine/passes/atmosphere/sun-class';
import { atmosphereTerrainClassifiedWgsl, atmosphereTerrainWgsl } from '../src/engine/passes/atmosphere/terrain.wgsl';
import { volumeTraceClassifiedWgsl, volumeTraceWgsl } from '../src/engine/passes/volumetrics/volumetrics.wgsl';

type V = [number, number, number];
const N = 64, HALF = 24.5, VOX = 2 * HALF / N, G = N / SUN_CLASS_CELL, CELL = VOX * SUN_CLASS_CELL;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.sqrt(dot(a, a));
const norm = (a: V): V => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };
let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

/** A bumpy planet with a block on it and a crater-like dip: stored like the SDF build (signed, clamped to ±8). */
function field(p: V): number {
  const r = len(p), bumps = 0.8 * Math.sin(p[0] * 0.45) * Math.cos(p[2] * 0.37) + 0.5 * Math.sin(p[1] * 0.6 + p[0] * 0.2);
  const planet = r - (18 + bumps) * 0.98;
  const q: V = [Math.abs(p[0] - 4) - 1.5, Math.abs(p[1] - 18.5) - 2.5, Math.abs(p[2] + 3) - 1.5];
  const block = len([Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)]) + Math.min(Math.max(q[0], q[1], q[2]), 0);
  const dip = 3 - len([p[0] + 6, p[1] - 17, p[2] - 5]);
  return Math.max(-8, Math.min(8, Math.max(Math.min(planet, block), dip)));
}
const texels = new Float32Array(N * N * N);
for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
  texels[(z * N + y) * N + x] = Math.fround(field([(x + 0.5) * VOX - HALF, (y + 0.5) * VOX - HALF, (z + 0.5) * VOX - HALF]));
const texel = (x: number, y: number, z: number) => texels[(Math.min(N - 1, Math.max(0, z)) * N + Math.min(N - 1, Math.max(0, y))) * N + Math.min(N - 1, Math.max(0, x))];

/** sdf_terrain: trilinear over clamped texel centres inside the domain, 0.9 + the distance to the cube outside. */
function sample(p: V): number {
  const q = p.map(v => Math.abs(v) - HALF) as V;
  const outside = len([Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)]) + Math.min(Math.max(q[0], q[1], q[2]), 0);
  if (outside > 0) return outside + 0.9;
  const u = p.map(v => (v + HALF) / VOX - 0.5) as V, i = u.map(Math.floor) as V, f = u.map((v, k) => v - i[k]) as V;
  let s = 0;
  for (let c = 0; c < 8; c++) {
    const o = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
    s += texel(i[0] + o[0], i[1] + o[1], i[2] + o[2]) * o.reduce((w, b, k) => w * (b ? f[k] : 1 - f[k]), 1);
  }
  return s;
}

/** atmo_terrain_lit. */
function aerialLit(p: V, sun: V): number {
  const inv = sun.map(v => Math.sign(v + 1e-20) / Math.max(Math.abs(v), 1e-8));
  const a = p.map((v, k) => (-HALF - v) * inv[k]), b = p.map((v, k) => (HALF - v) * inv[k]);
  let t = Math.max(0.04, ...a.map((v, k) => Math.min(v, b[k])));
  const end = Math.min(...a.map((v, k) => Math.max(v, b[k])));
  let visibility = 1;
  for (let i = 0; i < 48; i++) {
    if (t > end) return visibility;
    const q: V = [p[0] + sun[0] * t, p[1] + sun[1] * t, p[2] + sun[2] * t];
    const d = sample(q);
    if (d < 0) return 0;
    visibility = Math.min(visibility, d / Math.max(t * 0.035, 0.025));
    t += Math.min(4, Math.max(0.08, d));
  }
  return 0;
}

function hazeVisible(p: V, sun: V, steps: number): number {
  let t = 0.025;
  for (let i = 0; i < steps; i++) {
    const q: V = [p[0] + sun[0] * t, p[1] + sun[1] * t, p[2] + sun[2] * t];
    if (len(q) > HALF && dot(q, sun) > 0) return 1;
    const d = sample(q);
    if (d < 0.015) return 0;
    t += Math.min(4, Math.max(0.02, d * 0.85));
  }
  return 0;
}

// Bounds of each cell's own texels, then over its 5³ neighbourhood (sunClassReduceWgsl, sunClassDilateWgsl).
const core = Array.from({ length: G * G * G }, (_, c) => {
  const x = c % G, y = Math.floor(c / G) % G, z = Math.floor(c / (G * G));
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 64; k++) { const v = texel(x * 4 + (k & 3), y * 4 + ((k >> 2) & 3), z * 4 + (k >> 4)); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const margin = Math.max(Math.max(Math.abs(lo), Math.abs(hi)) * 0.002, 1e-4);
  return [lo - margin, hi + margin];
});
const dilated = core.map((_, c) => {
  const x = c % G, y = Math.floor(c / G) % G, z = Math.floor(c / (G * G));
  let lo = Infinity, hi = -Infinity;
  for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const [cx, cy, cz] = [x + dx, y + dy, z + dz];
    if ([cx, cy, cz].some(v => v < 0 || v >= G)) continue;
    const v = core[(cz * G + cy) * G + cx]; lo = Math.min(lo, v[0]); hi = Math.max(hi, v[1]);
  }
  return [lo, hi];
});

function boxBounds(lo: V, hi: V): [number, number] {
  let r: [number, number] = [Infinity, -Infinity];
  if (hi.every(v => v > -HALF) && lo.every(v => v < HALF)) {
    const c = lo.map((v, k) => Math.min(G - 1, Math.max(0, Math.floor(((v + hi[k]) * 0.5 + HALF) / CELL))));
    r = dilated[(c[2] * G + c[1]) * G + c[0]] as [number, number];
  }
  if (lo.some(v => v < -HALF) || hi.some(v => v > HALF)) {
    const beyond = lo.map((v, k) => Math.max(Math.max(Math.abs(v), Math.abs(hi[k])) - HALF, 0)) as V;
    r = [Math.min(r[0], 0.9), Math.max(r[1], 0.9 + len(beyond))];
  }
  return r;
}

/** Mirror of sunClassClassifyWgsl's main for one cell. */
function classify(cell: V, s: V, drift: number): number {
  const bmin = cell.map(v => v * CELL - HALF - 1e-3) as V, bmax = bmin.map(v => v + CELL + 2e-3) as V;
  const sa = s.map(Math.abs) as V, smax = Math.max(...sa);
  let endFar = 1e30, endNear = 1e30;
  for (let k = 0; k < 3; k++) {
    const ahead = s[k] > 0 ? HALF - bmax[k] : HALF + bmin[k];
    if (sa[k] > drift) endFar = Math.min(endFar, (s[k] > 0 ? HALF - bmin[k] : bmax[k] + HALF) / (sa[k] - drift));
    const gap = sa[k] > drift ? ahead : HALF - Math.max(Math.abs(bmin[k]), Math.abs(bmax[k]));
    endNear = Math.min(endNear, Math.max(gap, 0) / (sa[k] + drift));
  }
  let a = 0, lit = endFar * 0.035 <= 0.899, litSamples = 1, litSeg = [0, 4], dark = false, darkRun = 0;
  let hazeLit = true, hazeSamples = 0, hazeSeg = [0, 4], hazeOut = false, hazeDark = false, hazeRun = 0;
  const merge = (seg: number[], step: number, length: number, count: (n: number) => void) => {
    if (seg[0] > 0 && (step < 0.7 * seg[1] || step > 1.5 * seg[1])) { count(Math.ceil(seg[0] / seg[1])); seg[0] = 0; seg[1] = step; }
    seg[1] = seg[0] === 0 ? step : Math.min(seg[1], step); seg[0] += length;
  };
  for (let j = 0; j < 256; j++) {
    const room = 6.2 * VOX - (0.5 * CELL + 1e-3) - drift * a;
    if (room <= 0.01 || a > 90) break;
    const length = room / (0.5 * smax + drift), b = a + length;
    const lo = bmin.map((v, k) => v + Math.min(s[k] * a, s[k] * b) - drift * b) as V;
    const hi = bmax.map((v, k) => v + Math.max(s[k] * a, s[k] * b) + drift * b) as V;
    const v = boxBounds(lo, hi);
    if (a <= endFar) {
      if (lit) {
        lit = v[0] >= Math.max(0.035 * b, 0.025) * 1.002 + 1e-4;
        merge(litSeg, Math.min(4, Math.max(0.08, v[0])) - 1e-5, length, n => { litSamples += n; });
      }
      if (!dark) { if (v[1] <= -1e-3 && b <= endNear) { darkRun += length; dark = darkRun >= 4.05; } else darkRun = 0; }
    }
    const nearest = len(lo.map((l, k) => Math.min(Math.max(0, l), hi[k])) as V);
    if (!hazeOut) {
      const farthest = len(lo.map((l, k) => Math.max(Math.abs(l), Math.abs(hi[k]))) as V);
      const toward = s.reduce((sum, sk, k) => sum + sk * (sk > 0 ? lo[k] : hi[k]), 0);
      if (nearest > HALF * 1.0001 && toward > drift * farthest + 1e-4) hazeOut = true;
      else {
        if (hazeLit) {
          hazeLit = v[0] >= 0.015 * 1.002 + 1e-4;
          merge(hazeSeg, Math.min(4, Math.max(0.02, 0.85 * v[0])) - 1e-5, length, n => { hazeSamples += n; });
        }
        if (!hazeDark) { if (v[1] <= 0.014 && farthest < HALF) { hazeRun += length; hazeDark = hazeRun >= 4.05; } else hazeRun = 0; }
      }
    }
    a = b;
    if ((a > endFar || (!lit && (dark || a > endNear))) && (hazeOut || (!hazeLit && (hazeDark || nearest > HALF)))) break;
  }
  litSamples += Math.ceil(litSeg[0] / litSeg[1]); hazeSamples += Math.ceil(hazeSeg[0] / hazeSeg[1]);
  let bits = 0;
  if (lit && a > endFar && litSamples <= 47) bits |= SUN_CLASS.aerialLit;
  if (dark) bits |= SUN_CLASS.aerialDark;
  if (hazeLit && hazeOut && hazeSamples <= 255) bits |= SUN_CLASS.hazeLit | (hazeSamples << 8);
  if (hazeDark) bits |= SUN_CLASS.hazeDark;
  return bits;
}

/** A sun within `angle` of s. */
function drifted(s: V, angle: number): V {
  const helper: V = Math.abs(s[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm([s[1] * helper[2] - s[2] * helper[1], s[2] * helper[0] - s[0] * helper[2], s[0] * helper[1] - s[1] * helper[0]]);
  const w: V = [s[1] * u[2] - s[2] * u[1], s[2] * u[0] - s[0] * u[2], s[0] * u[1] - s[1] * u[0]];
  const phi = rnd() * 2 * Math.PI, theta = angle * Math.sqrt(rnd());
  return norm(s.map((v, k) => v * Math.cos(theta) + (u[k] * Math.cos(phi) + w[k] * Math.sin(phi)) * Math.sin(theta)) as V);
}

describe('exact sun classes', () => {
  const suns: V[] = [norm([0.6, 0.7, 0.39]), [0, 1, 0], norm([-0.3, 0.12, 0.95]), norm([0.2, -0.97, 0.1]), norm([1, 0.05, 0])];
  it.each(suns.map((s, i) => [i, s] as const))('answers exactly what the marches return (sun %i)', (_i, sun) => {
    const counts = { aerialLit: 0, aerialDark: 0, hazeLit: 0, hazeDark: 0, uncertain: 0 };
    for (let c = 0; c < G * G * G; c++) {
      const cell: V = [c % G, Math.floor(c / G) % G, Math.floor(c / (G * G))];
      const bits = classify(cell, sun, 2 * Math.sin(SUN_CLASS_DRIFT / 2));
      if (!bits) { counts.uncertain++; continue; }
      for (let k = 0; k < 3; k++) {
        const p = cell.map(v => (v + rnd()) * CELL - HALF) as V, s = drifted(sun, SUN_CLASS_DRIFT);
        if (bits & SUN_CLASS.aerialLit) { counts.aerialLit++; expect(aerialLit(p, s), `aerial lit ${cell}`).toBe(1); }
        if (bits & SUN_CLASS.aerialDark) { counts.aerialDark++; expect(aerialLit(p, s), `aerial dark ${cell}`).toBe(0); }
        if (bits & SUN_CLASS.hazeLit) {
          counts.hazeLit++;
          const needed = ((bits >>> 8) & 255) + 1;
          expect(hazeVisible(p, s, needed), `haze lit ${cell}`).toBe(1);
        }
        if (bits & SUN_CLASS.hazeDark) { counts.hazeDark++; expect(hazeVisible(p, s, 40), `haze dark ${cell}`).toBe(0); }
      }
    }
    // The proof must also be useful: most of the domain is far from the surface.
    expect(counts.aerialLit + counts.aerialDark).toBeGreaterThan(G * G * G * 0.3);
    expect(counts.hazeLit + counts.hazeDark).toBeGreaterThan(G * G * G * 0.3);
  });

  it.each([[20, false], [21, true]] as const)('lighting binds the classes only with a sampled texture to spare (limit %i)', async (limit, expected) => {
    const layouts: GPUBindGroupLayoutDescriptor[] = [], passes: string[] = [];
    const facets = new Map<string, unknown>([['fogOfWar', {}], ['sdfCasters', {}], ['sdf', { valid: false, size: 256, serial: 0, half: 24.5, volumeView: {} }]]);
    let shader = '';
    const texture = { createView: () => ({}) };
    const services = {
      ctx: { device: { limits: { maxSampledTexturesPerShaderStage: limit },
        createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return {}; }, createPipelineLayout: () => ({}), createBuffer: () => ({}),
        createSampler: () => ({}), createBindGroup: () => ({}), createTexture: () => texture,
      }, queue: {}, layouts: { frame: {} }, deferDestroy: () => {}, pipelines: {
        register: (_key: string, _kind: string, descriptor: () => unknown) => { descriptor(); },
        shaderModule: (source: { code: string }) => { if (source.code.includes('fn main(@builtin(global_invocation_id) gid: vec3u) {\n  if (gid.x >= params.scissor.z')) shader = source.code; return {}; },
        compile: () => Promise.resolve(),
      } }, graph: { declareTexture: () => {}, addPass: (p: { name: string }) => { passes.push(p.name); return () => {}; } }, frameUniforms: {},
      events: { on: () => () => {} },
      scene: { get: (key: string) => facets.get(key), provide: (key: string, value: unknown) => facets.set(key, value) },
    } as unknown as EngineServices;
    const module = lightingModule(); await module.install(services);
    const lighting = layouts.find(l => l.label === 'layout:lighting-gbuffer')!;
    expect([...lighting.entries].some(e => e.binding === 14)).toBe(expected);
    expect(shader.includes('var sun_class: texture_3d<u32>')).toBe(expected);
    expect(passes.includes('atmosphere.sunClass')).toBe(expected);
    expect(facets.has('sunClass')).toBe(expected);
    module.dispose?.();
  });

  it('keeps the plain consumers byte-identical and guards the classified ones by the frame sun and active cuts', () => {
    expect(atmosphereTerrainWgsl.code).not.toContain('sun_class');
    expect(volumeTraceWgsl.code).not.toContain('sun_class');
    const terrain = atmosphereTerrainClassifiedWgsl(1, 14).code;
    expect(terrain).toContain('if (all(sun == frame.sun_dir)) {');
    expect(terrain).toContain('sun_class_dark_valid()');
    // The classified march is the plain one after the start lookup.
    expect(terrain.slice(terrain.indexOf('  // Clip to the actual terrain cube.'))).toBe(atmosphereTerrainWgsl.code.slice(atmosphereTerrainWgsl.code.indexOf('  // Clip to the actual terrain cube.')));
    expect(terrain.indexOf('sun_class_at(p)')).toBeLessThan(terrain.indexOf('for (var i = 0u; i < 48u; i++)'));
    expect(volumeTraceClassifiedWgsl.code).toContain('((class_bits >> 8u) & 255u) < u32(vp.quality.z)');
    expect(sunClassLookupWgsl(1, 14).code).toContain('fn sun_class_dark_valid() -> bool { return sdf_params.info.w < 0.5; }');
    for (const constant of ['max(0.035 * b, 0.025) * 1.002', 'end_far * 0.035 <= 0.899', 'dark_run >= 4.05', '6.2 * vox', 'v.y <= 0.014'])
      expect(sunClassClassifyWgsl.code).toContain(constant);
  });
});
