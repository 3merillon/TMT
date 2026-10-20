/**
 * W1-ENG-LOOK post: TAA jitter/velocity consistency (the velocity target is jitter-independent and reprojects a static
 * point onto its previous unjittered position), the history reset rules, the NaN/Inf scrubs of TAA / bloom / composite
 * (CPU mirror + WGSL), the blue-noise tile, the bloom mip chain, the per-planet grade table and the params layouts.
 */
import { describe, expect, it } from 'vitest';
import { Camera } from '../src/engine/frame/camera';
import { blueNoise, blueNoiseRgba8 } from '../src/engine/passes/post/blue-noise';
import { BLOOM, bloomMipCount, bloomShaders } from '../src/engine/passes/post/bloom';
import { COMPOSITE_PARAMS, compositeShaderLinked, exposureShaderLinked, tonemapWgsl } from '../src/engine/passes/post/composite';
import { applyCdl, AUTO_EXPOSURE, COMPOSITE_LENS, PLANET_GRADES } from '../src/engine/passes/post/grade';
import { TAA_BLEND, TAA_PARAMS, taaReset, taaWgsl, velocityOf } from '../src/engine/passes/post/taa';

type V3 = [number, number, number];

function rig(position: V3, target: V3) { return { position, target, up: [0, 1, 0] as V3, fovY: 47 * Math.PI / 180 }; }
function uvOf(m: ArrayLike<number>, p: readonly number[]): [number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [(x / w) * 0.5 + 0.5, 0.5 - (y / w) * 0.5];
}

describe('TAA: jitter / velocity consistency', () => {
  it('writes a jitter-independent velocity that reprojects a static point onto its previous unjittered uv', () => {
    const size: [number, number] = [1920, 1080];
    const jittered = new Camera(), clean = new Camera();
    const points: V3[] = [[0, 18.2, 0], [1.5, 18, -2], [-3, 17.5, 4], [0, 30, -40]];
    for (let f = 0; f < 24; f++) {
      const eye: V3 = [Math.sin(f * 0.05) * 12, 28 + f * 0.02, Math.cos(f * 0.05) * 12];
      jittered.update(rig(eye, [0, 18, 0]), size, size, true, f);
      clean.update(rig(eye, [0, 18, 0]), size, size, false, f);
      if (f === 0) continue;
      expect(Math.hypot(...jittered.jitter)).toBeGreaterThan(0);
      for (const p of points) {
        const vj = velocityOf(jittered.prevViewProj, jittered.viewProjNoJitter, p);
        const vc = velocityOf(clean.prevViewProj, clean.viewProjNoJitter, p);
        expect(vj[0]).toBeCloseTo(vc[0], 6);
        expect(vj[1]).toBeCloseTo(vc[1], 6);
        const cur = uvOf(clean.viewProjNoJitter, p), prev = uvOf(clean.prevViewProj, p);
        expect(cur[0] + vj[0]).toBeCloseTo(prev[0], 6);
        expect(cur[1] + vj[1]).toBeCloseTo(prev[1], 6);
      }
    }
  });

  it('jitters the raster by less than a pixel around the unjittered projection', () => {
    const size: [number, number] = [1280, 720];
    const cam = new Camera();
    for (let f = 1; f < 17; f++) {
      cam.update(rig([0, 30, 20], [0, 18, 0]), size, size, true, f);
      const a = uvOf(cam.viewProj, [0.3, 18.1, 0.2]), b = uvOf(cam.viewProjNoJitter, [0.3, 18.1, 0.2]);
      expect(Math.abs(a[0] - b[0]) * size[0]).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(a[1] - b[1]) * size[1]).toBeLessThanOrEqual(0.5 + 1e-6);
    }
  });

  it('drops the history on a camera snap, an invalidation request and the first frame', () => {
    expect(taaReset({ snap: true, index: 10 }, false)).toBe(true);
    expect(taaReset({ snap: false, index: 10 }, true)).toBe(true);
    expect(taaReset({ snap: false, index: 0 }, false)).toBe(true);
    expect(taaReset({ snap: false, index: 10 }, false)).toBe(false);
    expect(TAA_BLEND).toBeGreaterThan(0);
    expect(TAA_BLEND).toBeLessThanOrEqual(0.25);
    expect(TAA_PARAMS.size).toBe(16);
  });

  it('rejects history on the GB3 new-geometry flag, off-screen and reactive pixels, and reprojects the sky by direction', () => {
    const code = taaWgsl.code;
    expect(code).toContain('(gbuffer_flags(ids) & GB_FLAG_NEW_GEOMETRY) != 0u');
    expect(code).toContain('if (!in_screen) { alpha = 1.0; }');
    expect(code).toContain('alpha = max(alpha, reactive);');
    expect(code).toContain('if (depth <= 0.0) { prev_uv = reproject_sky(uv); }');
    expect(code).toContain('frame.prev_view_proj * vec4f(dir, 0.0)');
    expect(code).toContain('rgb_to_ycocg');
  });
});

describe('NaN / Inf scrubs (one NaN poisons history forever)', () => {
  // CPU mirrors of taa_scrub and nan_scrub.
  const taaScrub = (c: number[]) => c.map(v => (Number.isNaN(v) ? 0 : Math.min(Math.max(v, 0), 65504)));
  const nanScrub = (c: number[]) => (c.some(v => Number.isNaN(v) || Math.abs(v) > 65504) ? [0, 0, 0] : c);

  it('zeroes NaN and clamps Inf in history, zeroes the whole pixel in the composite', () => {
    expect(taaScrub([NaN, 1, Infinity])).toEqual([0, 1, 65504]);
    expect(taaScrub([-2, 0.5, -Infinity])).toEqual([0, 0.5, 0]);
    expect(nanScrub([NaN, 1, 1])).toEqual([0, 0, 0]);
    expect(nanScrub([1, Infinity, 1])).toEqual([0, 0, 0]);
    expect(nanScrub([0.2, 3, 7])).toEqual([0.2, 3, 7]);
  });

  it('scrubs with a self-inequality test in every post stage (WGSL min/max do not guarantee NaN semantics)', () => {
    expect(taaWgsl.code).toContain('select(c, vec3f(0.0), c != c)');
    expect(bloomShaders().downFirst.code).toContain('select(c, vec3f(0.0), c != c)');
    expect(tonemapWgsl.code).toContain('any(c != c) || any(abs(c) > vec3f(65504.0))');
    const comp = compositeShaderLinked().code;
    expect(comp).toContain('nan_scrub(textureLoad(scene_tex');
    expect(comp).toContain('nan_scrub(bloom_src)');
    expect(exposureShaderLinked().code).toContain('select(c, vec3f(0.0), c != c)');
  });
});

describe('composite: grade, lens and film', () => {
  it('grades each planet kind with saturation 1.15–1.25 and a warm-highlight / cool-shadow CDL', () => {
    for (const [kind, g] of Object.entries(PLANET_GRADES)) {
      expect(g.cdl.saturation, kind).toBeGreaterThanOrEqual(1.15);
      expect(g.cdl.saturation, kind).toBeLessThanOrEqual(1.25);
      expect(g.cdl.slope[0], kind).toBeGreaterThanOrEqual(g.cdl.slope[2] - 0.08);
      expect(Math.abs(g.exposureEv)).toBeLessThanOrEqual(1);
    }
    const kinds = Object.values(PLANET_GRADES).map(g => JSON.stringify(g.cdl));
    expect(new Set(kinds).size).toBe(4);
  });

  it('mirrors the CDL: identity leaves colour alone, saturation pushes chroma out around luma', () => {
    const id = { slope: [1, 1, 1] as V3, offset: [0, 0, 0] as V3, power: [1, 1, 1] as V3, saturation: 1 };
    expect(applyCdl([0.2, 0.5, 0.7], id).map(v => +v.toFixed(12))).toEqual([0.2, 0.5, 0.7]);
    const sat = applyCdl([0.2, 0.5, 0.7], { ...id, saturation: 1.2 });
    const l = 0.2126 * 0.2 + 0.7152 * 0.5 + 0.0722 * 0.7;
    expect(Math.abs(sat[2] - l)).toBeGreaterThan(Math.abs(0.7 - l));
  });

  it('packs the composite params and uses AgX with Neutral selectable, cos⁴ vignette, grain then dither', () => {
    expect(COMPOSITE_PARAMS.size % 16).toBe(0);
    const code = compositeShaderLinked().code;
    expect(code).toContain('agx_display(v)');
    expect(code).toContain('pbr_neutral(c)');
    expect(code).toContain('mix(1.0, c2 * c2, cp.power.w)');
    expect(code.indexOf('bn * cp.grain.x')).toBeLessThan(code.indexOf('n * cp.grain.y / 255.0'));
    expect(COMPOSITE_LENS).toMatchObject({ vignette: 0.25, cos4: 0.5 });
    expect(AUTO_EXPOSURE.range).toBe(1);
    expect(exposureShaderLinked().code).toContain('clamp(ep.p.x - avg, -1.0, 1.0)');
  });
});

describe('bloom and blue noise', () => {
  it('builds up to 6 mips from half resolution, never a zero-size mip', () => {
    expect(BLOOM).toMatchObject({ mips: 6, threshold: 0.9, knee: 0.5, intensity: 0.05 });
    expect(bloomMipCount(960, 540)).toBe(6);
    expect(bloomMipCount(40, 30)).toBe(5);
    expect(bloomMipCount(1, 1)).toBe(1);
    for (const [w, h] of [[960, 540], [100, 7], [3, 3]]) expect(Math.min(w, h) >> (bloomMipCount(w, h) - 1)).toBeGreaterThanOrEqual(1);
  });

  it('generates a deterministic 64² blue-noise permutation with little low-frequency energy', () => {
    const size = 64;
    const t = blueNoise(size);
    expect(blueNoise(size)).toEqual(t);
    const ranks = new Set(Array.from(t, v => Math.round(v * size * size - 0.5)));
    expect(ranks.size).toBe(size * size);
    // Box-filtered 8×8 means stay close to 0.5 (white noise of the same size varies ~4× more).
    const means: number[] = [];
    for (let by = 0; by < size; by += 8) for (let bx = 0; bx < size; bx += 8) {
      let s = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += t[(by + y) * size + bx + x];
      means.push(s / 64);
    }
    const sd = Math.sqrt(means.reduce((a, m) => a + (m - 0.5) ** 2, 0) / means.length);
    expect(sd).toBeLessThan(0.018); // white noise: σ ≈ 0.29 / 8 = 0.036
    const rgba = blueNoiseRgba8(t, size);
    expect(rgba.length).toBe(size * size * 4);
    expect(rgba[0]).toBe(Math.floor(t[0] * 256));
  });
});
