/**
 * W1-ENG-LOOK sun shadows: the ported Pinionfall sun-hold test (src/gpu/shadow-sun-hold.test.ts), the fixed-basis fitting
 * rules (texel snap, lock/relock with the damped half shift, radius quantisation + slew), the ortho light projection,
 * the dirty-rect scissor maths, the tier table, the params layout and a CPU mirror of the Hero blend.
 */
import { describe, expect, it } from 'vitest';
import {
  aabbTexelRect, HERO_MAX_RADIUS, HERO_MIN_RADIUS, HERO_STEP, HeroFit, heroTargetRadius, lightBasis, orthoLightViewProj,
  PLANET_SHADOW_HALF_EXTENT, quantizeHeroRadius, SHADOW_DEPTH_HALF, SHADOW_TIERS, sphereInSquare, toLight, transform, unionRect,
} from '../src/engine/passes/shadows/fitting';
import { chordSq, heldProjectionShear, sunHoldToleranceRad } from '../src/engine/passes/shadows/sun-hold';
import { SUN_SHADOW_PARAMS, SUN_SHADOW_PARAMS_BYTES, shadowSampleWgsl } from '../src/engine/passes/shadows/shadow.wgsl';
import { CONTACT_SHADOW, HERO_BLEND_START } from '../src/engine/passes/shadows/sun-shadows';
import { RESERVED_BINDING_LAYOUT, SHADOW_DEPTH } from '../src/engine/contracts';

const DEG = Math.PI / 180;
type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const xform = (m: ArrayLike<number>, p: V3): V3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
function rotate(v: V3, axis: V3, ang: number): V3 {
  const k = norm(axis), c = Math.cos(ang), s = Math.sin(ang), kv = dot(k, v);
  const x: V3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [v[0] * c + x[0] * s + k[0] * kv * (1 - c), v[1] * c + x[1] * s + k[1] * kv * (1 - c), v[2] * c + x[2] * s + k[2] * kv * (1 - c)];
}
function perp(v: V3): V3 {
  const r: V3 = Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return norm([v[1] * r[2] - v[2] * r[1], v[2] * r[0] - v[0] * r[2], v[0] * r[1] - v[1] * r[0]]);
}
let seed = 0x2f6e2b1;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return ((seed >>> 8) & 0xffffff) / 0xffffff; };

describe('sun hold (ported from Pinionfall shadow-sun-hold.test.ts)', () => {
  it('the chord resolves separations a dot product cannot', () => {
    const a = norm([0.3, -0.8, 0.52]);
    expect(Math.abs(Math.sqrt(chordSq(a, rotate(a, perp(a), 0.03 * DEG))) / DEG - 0.03)).toBeLessThan(1e-6);
    expect(Math.abs(Math.sqrt(chordSq(a, rotate(a, perp(a), 0.0005 * DEG))) / DEG - 0.0005)).toBeLessThan(1e-7);
  });

  it('sizes the tolerance ladder by texel, arm and elevation (home calibration)', () => {
    const base = 0.03 * DEG, max = 0.5 * DEG;
    const home = (texelM: number, sinElev = 0.77) => sunHoldToleranceRad({ baseRad: base, texelM, sinElev, armHeightM: 300, stepTexels: 1, maxRad: max }) / DEG;
    expect(home(0.031)).toBeCloseTo(0.03, 12);
    expect(home(0.074)).toBeCloseTo(0.03, 12);
    expect(home(0.22)).toBeGreaterThanOrEqual(0.03);
    expect(home(0.22)).toBeLessThan(0.04);
    expect(home(1.16)).toBeGreaterThan(0.16);
    expect(home(1.16)).toBeLessThan(0.19);
    expect(home(2.9)).toBeGreaterThan(0.41);
    expect(home(2.9)).toBeLessThan(0.45);
    expect(home(40)).toBe(0.5);
    expect(home(0.66, 0.05)).toBeCloseTo(0.03, 12);
    for (const s of [0, 0.01, 0.2, 0.6, 1]) expect(home(0.66, s)).toBeGreaterThanOrEqual(0.03 - 1e-12);
    expect(home(0.66, 0.3)).toBeLessThanOrEqual(home(0.66, 0.6));
    expect(home(0.66, 0.6)).toBeLessThanOrEqual(home(0.66, 0.9));
    for (const [texel, s] of [[0.66, 0.77], [1.6, 0.4], [1.6, 0.9], [4.2, 0.6]] as const) {
      expect(sunHoldToleranceRad({ baseRad: 0, texelM: texel, sinElev: s, armHeightM: 300, stepTexels: 1, maxRad: max })).toBe(0);
      const t2 = sunHoldToleranceRad({ baseRad: 1e-9, texelM: texel, sinElev: s, armHeightM: 300, stepTexels: 1, maxRad: 10 });
      expect(t2 * (300 / s)).toBeLessThanOrEqual(texel * (1 + 1e-9));
    }
    expect(sunHoldToleranceRad({ baseRad: base, texelM: 0.66, sinElev: 0.77, armHeightM: 1575, stepTexels: 1, maxRad: max }) / DEG).toBeCloseTo(0.03, 12);
    expect(sunHoldToleranceRad({ baseRad: base, texelM: 0, sinElev: 1, armHeightM: 300, stepTexels: 1, maxRad: max })).toBe(base);
  });

  it('the shear draws a caster where the TRUE sun shadows it (400 random cases)', () => {
    const out = new Float64Array(16);
    const h = norm([0.35, -0.9, 0.26]);
    heldProjectionShear(out, h, h, [10, 700, -40]);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    let worstLateral = 0, worstDepth = 0, worstNaive = 0;
    for (let n = 0; n < 400; n++) {
      const held = norm([rnd() - 0.5, -(0.1 + rnd()), rnd() - 0.5]);
      const tru = norm(rotate(held, [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], (0.002 + rnd() * 0.5) * DEG));
      const C: V3 = [(rnd() - 0.5) * 400, 750 + rnd() * 60, (rnd() - 0.5) * 400];
      const arm = 300 + rnd() * 4700;
      const P: V3 = add(add(C, held, -arm), [(rnd() - 0.5) * 600, (rnd() - 0.5) * 80, (rnd() - 0.5) * 600]);
      const s = dot(add(C, P, -1), held) / dot(tru, held);
      const Q = add(P, tru, s);
      const Pp = xform(heldProjectionShear(out, held, tru, C), P);
      const e = add(Pp, Q, -1), along = dot(e, held);
      worstLateral = Math.max(worstLateral, Math.hypot(e[0] - held[0] * along, e[1] - held[1] * along, e[2] - held[2] * along));
      const e0 = add(P, Q, -1), a0 = dot(e0, held);
      worstNaive = Math.max(worstNaive, Math.hypot(e0[0] - held[0] * a0, e0[1] - held[1] * a0, e0[2] - held[2] * a0));
      worstDepth = Math.max(worstDepth, Math.abs(dot(Pp, held) - dot(P, held)));
    }
    expect(worstLateral).toBeLessThan(5e-3);
    expect(worstNaive).toBeGreaterThan(1);
    expect(worstDepth).toBeLessThan(0.25);
  });

  it('a receiver off the plane keeps offset × angle, not arm × angle', () => {
    const out = new Float64Array(16);
    const held = norm([0.4, -0.85, 0.2]);
    const tru = norm(rotate(held, perp(held), 0.1 * DEG));
    const C: V3 = [0, 780, 0];
    const P = add(C, held, -1100);
    const Pp = xform(heldProjectionShear(out, held, tru, C), P);
    for (const off of [25, 100, 300]) {
      const Q = add(P, tru, (1100 + off) / dot(tru, held));
      const e = add(Pp, Q, -1), al = dot(e, held);
      const lat = Math.hypot(e[0] - held[0] * al, e[1] - held[1] * al, e[2] - held[2] * al);
      const want = off * (0.1 * DEG);
      expect(Math.abs(lat - want)).toBeLessThan(want * 0.01 + 1e-3);
    }
  });

  it('degenerate input is the identity, never a NaN matrix; sun directions may be toward-sun (TMT) or travel', () => {
    const out = new Float64Array(16);
    heldProjectionShear(out, [0, -1, 0], [0, 1, 0], [0, 800, 0]);
    expect([out[0], out[5], out[10], out[12], out[13]]).toEqual([1, 1, 1, 0, 0]);
    heldProjectionShear(out, [0, -1, 0], [NaN, NaN, NaN], [0, 800, 0]);
    expect(Array.from(out).every(Number.isFinite)).toBe(true);
    // Negating both directions (TMT passes the toward-sun vector) gives the same shear.
    const h = norm([0.2, 0.9, 0.3]), t = norm(rotate(h, perp(h), 0.2 * DEG));
    const a = Array.from(heldProjectionShear(new Float64Array(16), h, t, [1, 18, 2]));
    const b = Array.from(heldProjectionShear(new Float64Array(16), h.map(x => -x), t.map(x => -x), [1, 18, 2]));
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 12));
  });
});

describe('fixed light basis and the ortho projection', () => {
  it('builds an orthonormal basis from the sun alone (no camera input), stable near the poles', () => {
    for (const sun of [[0.45, 0.8, 0.4], [0, 1, 0], [0.01, -0.9999, 0], [1, 0, 0], [-0.3, 0.2, -0.93]] as V3[]) {
      const b = lightBasis(sun);
      const s = norm(sun);
      for (const [u, v] of [[b.x, b.y], [b.y, b.z], [b.z, b.x]]) expect(Math.abs(dot(u, v))).toBeLessThan(1e-12);
      for (const u of [b.x, b.y, b.z]) expect(Math.hypot(...u)).toBeCloseTo(1, 12);
      b.z.forEach((c, i) => expect(c).toBeCloseTo(s[i], 12));
    }
  });

  it('maps the planet slab to reversed-Z depth (1 on the sun side, 0 on the far side) and ±half to NDC ±1', () => {
    const sun = norm([0.45, 0.8, 0.4]);
    const b = lightBasis(sun);
    const m = orthoLightViewProj(b, 0, 0, PLANET_SHADOW_HALF_EXTENT);
    const near = transform(m, sun.map(v => v * SHADOW_DEPTH_HALF));
    const far = transform(m, sun.map(v => -v * SHADOW_DEPTH_HALF));
    expect(near[2]).toBeCloseTo(1, 6); // f32 matrix
    expect(far[2]).toBeCloseTo(0, 6);
    expect(near[3]).toBe(1);
    const edge = transform(m, b.x.map(v => v * PLANET_SHADOW_HALF_EXTENT));
    expect(edge[0]).toBeCloseTo(1, 6);
    // Everything on the planet (r ≤ 24.5) lands inside the slab.
    for (let i = 0; i < 200; i++) {
      const d = norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]);
      const c = transform(m, d.map(v => v * 24.5));
      expect(c[2]).toBeGreaterThanOrEqual(0);
      expect(c[2]).toBeLessThanOrEqual(1);
      expect(Math.max(Math.abs(c[0]), Math.abs(c[1]))).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(SHADOW_DEPTH).toEqual({ format: 'depth32float', compare: 'greater', clear: 0 });
  });

  it('computes padded texel scissor rects and unions them', () => {
    const b = lightBasis([0, 1, 0]);
    const m = orthoLightViewProj(b, 0, 0, PLANET_SHADOW_HALF_EXTENT);
    const r = aabbTexelRect(m, [-1, 17, -1], [1, 19, 1], 2048, 4)!;
    const texel = 49 / 2048;
    expect(r.w).toBeGreaterThanOrEqual(Math.floor(2 / texel));
    expect(r.w).toBeLessThanOrEqual(Math.ceil(2 / texel) + 10);
    expect(r.x + r.w / 2).toBeCloseTo(1024, -1);
    expect(aabbTexelRect(m, [100, 17, 100], [101, 19, 101], 2048, 4)).toBeNull();
    expect(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 20, w: 10, h: 5 })).toEqual({ x: 0, y: 0, w: 15, h: 25 });
    expect(unionRect(null, { x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('Hero fit: texel snap, lock/relock, radius quantisation and slew (Pinionfall rules)', () => {
  it('quantises clamp(0.45·d + 2, 4, 14) to 1.25× steps, monotone in the distance', () => {
    expect(heroTargetRadius(0)).toBe(HERO_MIN_RADIUS);
    expect(heroTargetRadius(100)).toBe(HERO_MAX_RADIUS);
    expect(heroTargetRadius(6)).toBeCloseTo(4.7, 12);
    let prev = 0;
    for (let d = 0; d <= 60; d += 0.05) {
      const q = quantizeHeroRadius(heroTargetRadius(d));
      expect(q).toBeGreaterThanOrEqual(prev);
      expect(q).toBeGreaterThanOrEqual(heroTargetRadius(d) - 1e-9);
      const k = Math.log(q / HERO_MIN_RADIUS) / Math.log(HERO_STEP);
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      prev = q;
    }
  });

  it('keeps the texel-snapped centre invariant under sub-texel (and sub-margin) focus motion', () => {
    const fit = new HeroFit(2048);
    fit.update(3.3317, -7.1111, 17);
    const c0 = [fit.cx, fit.cy], r0 = fit.radius;
    expect(Math.abs(fit.cx / fit.texel - Math.round(fit.cx / fit.texel))).toBeLessThan(1e-6);
    for (let i = 0; i < 500; i++) {
      const moved = fit.update(3.3317 + (rnd() - 0.5) * fit.texel, -7.1111 + (rnd() - 0.5) * fit.texel, 17);
      expect(moved).toBe(false);
    }
    expect([fit.cx, fit.cy]).toEqual(c0);
    expect(fit.radius).toBe(r0);
    // Anything inside the margin also holds.
    expect(fit.update(c0[0] + fit.margin * 0.99, c0[1] - fit.margin * 0.99, 17)).toBe(false);
  });

  it('relocks only past the margin, by a damped half shift of whole texels', () => {
    const fit = new HeroFit(2048);
    fit.update(0, 0, 17);
    const t = fit.texel, m = fit.margin;
    const relocks = fit.relocks;
    expect(fit.update(m * 1.2, 0, 17)).toBe(true);
    expect(fit.relocks).toBe(relocks + 1);
    const shift = fit.cx;
    expect(Math.abs(shift / t - Math.round(shift / t))).toBeLessThan(1e-6);
    expect(shift).toBeCloseTo(Math.round((m * 1.2) / (2 * t)) * t, 9);
    expect(shift).toBeLessThan(m * 1.2);
    // A driving focus stays within the margin + one shift of the centre, and never moves the grid sub-texel.
    let x = 0;
    for (let i = 0; i < 400; i++) {
      x += 0.03;
      fit.update(x, 0.5 * x, 17);
      expect(Math.abs(x - fit.cx)).toBeLessThanOrEqual(fit.margin * 1.0001 + t);
      expect(Math.abs(fit.cx / t - Math.round(fit.cx / t))).toBeLessThan(1e-6);
    }
  });

  it('grows immediately, shrinks one 1.25× step at a time after the delay (never undersized)', () => {
    const fit = new HeroFit(2048, { shrinkDelay: 4 });
    fit.update(0, 0, 36);
    const big = fit.radius;
    expect(big).toBe(quantizeHeroRadius(heroTargetRadius(36)));
    fit.update(0, 0, 6); fit.update(0, 0, 6); fit.update(0, 0, 6);
    expect(fit.radius).toBe(big);
    fit.update(0, 0, 6);
    expect(fit.radius).toBeCloseTo(big / HERO_STEP, 12);
    const radii: number[] = [];
    for (let i = 0; i < 60; i++) { fit.update(0, 0, 6); radii.push(fit.radius); }
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeLessThanOrEqual(radii[i - 1] + 1e-12);
      expect(radii[i - 1] / radii[i]).toBeLessThanOrEqual(HERO_STEP + 1e-9);
    }
    expect(radii.at(-1)).toBe(quantizeHeroRadius(heroTargetRadius(6)));
    const before = fit.radius;
    fit.update(0, 0, 40);
    expect(fit.radius).toBe(quantizeHeroRadius(heroTargetRadius(40)));
    expect(fit.radius).toBeGreaterThan(before);
  });

  it('culls casters to the hero square in light space', () => {
    const b = lightBasis([0.2, 0.9, 0.1]);
    const c: V3 = [3, 17, 1];
    const l = toLight(b, c);
    expect(sphereInSquare(b, c, 0.5, l[0], l[1], 4)).toBe(true);
    expect(sphereInSquare(b, c, 0.5, l[0] + 4.4, l[1], 4)).toBe(true);
    expect(sphereInSquare(b, c, 0.5, l[0] + 4.6, l[1], 4)).toBe(false);
  });
});

describe('tiers, params layout and sampling rules', () => {
  it('follows the plan §4.17 tier table (Low folds PlanetDynamic into Hero)', () => {
    expect(SHADOW_TIERS.low).toMatchObject({ static: 1024, dynamic: 0, hero: 1024, grid: 2 });
    expect(SHADOW_TIERS.medium).toMatchObject({ static: 2048, dynamic: 512, hero: 1024, grid: 3 });
    expect(SHADOW_TIERS.high).toMatchObject({ static: 2048, dynamic: 1024, hero: 2048, grid: 4, contact: true });
    expect(SHADOW_TIERS.ultra).toMatchObject({ static: 4096, dynamic: 1024, hero: 4096, grid: 4, contact: true });
    expect(49 / SHADOW_TIERS.high.static).toBeCloseTo(0.024, 3);
  });

  it('fits the reserved params slot and pins the field offsets', () => {
    expect(SUN_SHADOW_PARAMS.size % 16).toBe(0);
    expect(SUN_SHADOW_PARAMS.size).toBeLessThanOrEqual(SUN_SHADOW_PARAMS_BYTES);
    expect(RESERVED_BINDING_LAYOUT.sunShadows.find(s => s.key === 'params')?.size).toBe(SUN_SHADOW_PARAMS_BYTES);
    expect(SUN_SHADOW_PARAMS.offsets).toMatchObject({ planet_view_proj: 0, hero_view_proj: 64, planet: 128, hero: 144, bias: 160, flags: 176, contact: 192, light: 208 });
    expect(CONTACT_SHADOW).toMatchObject({ length: 0.3, steps: 12, thickness: 0.05 });
  });

  it('offsets along the GEOMETRIC normal by (1 + tanθ ≤ 4) and blends the hero over its outer 15%', () => {
    const code = shadowSampleWgsl.code;
    expect(code).toMatch(/clamp\(sqrt\(max\(1\.0 - cos_t \* cos_t, 0\.0\)\) \/ max\(cos_t, 0\.01\), 0\.0, 4\.0\)/);
    expect(code).toContain('ng * (texel_world * sun_shadow_params.bias.x * (1.0 + slope))');
    expect(code).toContain('min(planet_vis');
    expect(HERO_BLEND_START).toBe(0.85);
    // CPU mirror of shadow_hero_weight.
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const w = (ndcX: number, ndcY: number) => 1 - smooth(HERO_BLEND_START, 1, Math.max(Math.abs(ndcX), Math.abs(ndcY)));
    expect(w(0, 0)).toBe(1);
    expect(w(0.84, -0.2)).toBe(1);
    expect(w(1, 0)).toBe(0);
    expect(w(0.925, 0)).toBeCloseTo(0.5, 12);
  });
});
