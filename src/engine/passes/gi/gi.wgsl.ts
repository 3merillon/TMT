/**
 * Diffuse GI probes (docs/visibility-architecture.md), as consumers see them: a sparse world grid of irradiance probes
 * traced against the planet SDF, stored in the reserved `gi` binding.
 *
 * Probes: G³ over the SDF domain (spacing = 2·half / G). Texture: rgba16float 2D array [G·5, G] × G layers. Per probe
 * (texel x = i·5 + k, y = j, layer = z):
 *   k 0–2  bounce irradiance, one colour channel each, as E(n) = a + b·n  (rgba = a, b.x, b.y, b.z)
 *   k 3    sky visibility (cosine-convolved escape fraction), V(n) = a + b·n
 *   k 4    state: xyz relocation offset (u), w 1 = active
 * `gi_sample` blends the 8 surrounding active probes trilinearly with a wrapped normal weight and an SDF occlusion test
 * on the segment to each probe, so walls and crater rims do not leak light.
 */
import { makeModule, wgslStruct } from '../../wgsl/module';

export const GI_TEXELS_PER_PROBE = 5;

export const GI_PARAMS = wgslStruct('GiParams', [
  ['grid', 'vec4f'],   // x G (probes per axis), y spacing (u), z domain half extent (u), w valid (1)
  ['shade', 'vec4f'],  // x bounce gain, y sky-visibility strength, z rays per probe, w frame
  ['tier', 'vec4f'],   // x probes updated per frame, y first probe this frame, z hysteresis, w unused
]);

export function giBindingsWgsl(group: number, b: { probes: number; params: number }) {
  return makeModule(`gi-bindings:${group}:${b.probes},${b.params}`, [
    `@group(${group}) @binding(${b.probes}) var gi_probes: texture_2d_array<f32>;`,
    `@group(${group}) @binding(${b.params}) var<uniform> gi_params: GiParams;`,
  ].join('\n'), [GI_PARAMS.module]);
}

/** Needs `gi_probes`, `gi_params` and the sdf library. */
export const giSampleWgsl = makeModule('gi-sample', /* wgsl */ `
struct GiSample { bounce: vec3f, sky: f32, confidence: f32 }

fn gi_valid() -> bool { return gi_params.grid.w > 0.5; }

fn gi_sample(p: vec3f, n: vec3f) -> GiSample {
  var out: GiSample;
  out.bounce = vec3f(0.0); out.sky = 1.0; out.confidence = 0.0;
  if (!gi_valid() || !sdf_valid()) { return out; }
  let g = i32(gi_params.grid.x);
  let sp = gi_params.grid.y;
  let h = gi_params.grid.z;
  let q = p + n * (0.25 * sp);
  let f = (q + h) / sp - 0.5;
  let base = vec3i(floor(f));
  let t = f - vec3f(base);
  var bounce = vec3f(0.0);
  var sky = 0.0;
  var wsum = 0.0;
  var tri_valid = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let o = vec3i(i32(k & 1u), i32((k >> 1u) & 1u), i32(k >> 2u));
    let c = clamp(base + o, vec3i(0), vec3i(g - 1));
    let st = textureLoad(gi_probes, vec2i(c.x * ${GI_TEXELS_PER_PROBE} + 4, c.y), c.z, 0);
    if (st.w < 0.5) { continue; }
    let pp = (vec3f(c) + 0.5) * sp - h + st.xyz;
    let tw = select(1.0 - t, t, o == vec3i(1));
    let tri = tw.x * tw.y * tw.z;
    let dir = (pp - p) / max(length(pp - p), 1e-4);
    let wrap = (dot(dir, n) + 1.0) * 0.5;
    var w = tri * (wrap * wrap + 0.05);
    // Four taps retain occlusion around thin surviving walls and fresh crater lips.
    var clearance = 1e4;
    for (var tap = 1u; tap <= 4u; tap++) { clearance = min(clearance, sdf_sample(mix(q, pp, f32(tap) * 0.2))); }
    w *= smoothstep(-0.05, 0.12, clearance);
    if (w < 1e-5) { continue; }
    let r = textureLoad(gi_probes, vec2i(c.x * ${GI_TEXELS_PER_PROBE}, c.y), c.z, 0);
    let gg = textureLoad(gi_probes, vec2i(c.x * ${GI_TEXELS_PER_PROBE} + 1, c.y), c.z, 0);
    let b = textureLoad(gi_probes, vec2i(c.x * ${GI_TEXELS_PER_PROBE} + 2, c.y), c.z, 0);
    let v = textureLoad(gi_probes, vec2i(c.x * ${GI_TEXELS_PER_PROBE} + 3, c.y), c.z, 0);
    bounce += w * max(vec3f(r.x + dot(r.yzw, n), gg.x + dot(gg.yzw, n), b.x + dot(b.yzw, n)), vec3f(0.0));
    sky += w * clamp(v.x + dot(v.yzw, n), 0.0, 1.0);
    wsum += w;
    tri_valid += tri;
  }
  if (wsum < 1e-5) { return out; }
  out.bounce = bounce / wsum;
  out.sky = sky / wsum;
  out.confidence = clamp(tri_valid * 1.5, 0.0, 1.0);
  return out;
}
`);
