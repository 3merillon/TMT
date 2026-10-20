/**
 * G-buffer encoding (plan §4.6, frozen): SurfaceSample, gbuffer_pack / gbuffer_unpack, plus the TS mirror used by tests
 * and CPU tools. 24 B/sample.
 *
 *   GB0 albedoAo  rgba8unorm   linear base colour, material AO
 *   GB1 normals   rgba16float  shading normal oct.xy, GEOMETRIC normal oct.zw (shadow normal offset uses the geometric one)
 *   GB2 material  rgba8unorm   roughness, metalness, class param, emissive (log2 intensity; radiance = albedo × intensity)
 *   GB3 ids       r32uint      class 4 bits | flags 6 | objectId 10 | aniso strength 4 | aniso angle 8   (low → high bits)
 *   velocity      rg16float    uv_prev − uv_current (unjittered)
 *   depth         depth32float reversed-Z
 * Cleared state: GB3 = CLASS_SKY (15), everything else 0.
 */
import { MATERIAL_CLASS } from '../../contracts';
import { makeModule, tsConstCode } from '../module';
import { gbufferFlagWgsl, materialClassWgsl, mathWgsl } from './constants.wgsl';
import { octDecode, octEncode, packingWgsl } from './packing.wgsl';

export const GB3 = {
  CLASS_BITS: 4, CLASS_SHIFT: 0,
  FLAGS_BITS: 6, FLAGS_SHIFT: 4,
  OBJECT_BITS: 10, OBJECT_SHIFT: 10,
  ANISO_STRENGTH_BITS: 4, ANISO_STRENGTH_SHIFT: 20,
  ANISO_ANGLE_BITS: 8, ANISO_ANGLE_SHIFT: 24,
} as const;
/** log2 emissive range: GB2.a = (log2(I) − EMISSIVE_LOG2_MIN) / EMISSIVE_LOG2_RANGE, 0 = not emissive. */
export const EMISSIVE_LOG2_MIN = -4;
export const EMISSIVE_LOG2_RANGE = 16;
export const GBUFFER_CLEAR_IDS = MATERIAL_CLASS.SKY;

const constCode = tsConstCode({
  GB3_CLASS_SHIFT: GB3.CLASS_SHIFT, GB3_CLASS_MASK: (1 << GB3.CLASS_BITS) - 1,
  GB3_FLAGS_SHIFT: GB3.FLAGS_SHIFT, GB3_FLAGS_MASK: (1 << GB3.FLAGS_BITS) - 1,
  GB3_OBJECT_SHIFT: GB3.OBJECT_SHIFT, GB3_OBJECT_MASK: (1 << GB3.OBJECT_BITS) - 1,
  GB3_ANISO_STRENGTH_SHIFT: GB3.ANISO_STRENGTH_SHIFT, GB3_ANISO_STRENGTH_MASK: (1 << GB3.ANISO_STRENGTH_BITS) - 1,
  GB3_ANISO_ANGLE_SHIFT: GB3.ANISO_ANGLE_SHIFT, GB3_ANISO_ANGLE_MASK: (1 << GB3.ANISO_ANGLE_BITS) - 1,
  EMISSIVE_LOG2_MIN: { value: EMISSIVE_LOG2_MIN, type: 'f32' }, EMISSIVE_LOG2_RANGE: { value: EMISSIVE_LOG2_RANGE, type: 'f32' },
});

export const gbufferWgsl = makeModule('gbuffer', /* wgsl */ `
${constCode}

struct SurfaceSample {
  base_color: vec3f,
  ao: f32,
  n_shading: vec3f,
  roughness: f32,
  n_geom: vec3f,
  metalness: f32,
  emissive: f32,          // intensity (radiance = base_color * emissive)
  param: f32,             // class parameter: METAL clearcoat, GRASS/FOLIAGE translucency, TERRAIN wetness
  aniso_strength: f32,    // 0..1
  aniso_angle: f32,       // radians in [0, pi) around a Frisvad basis of n_shading
  class_id: u32,
  flags: u32,
  object_id: u32,
  _pad: u32,
}

struct GBufferOut {
  @location(0) albedo_ao: vec4f,
  @location(1) normals: vec4f,
  @location(2) material: vec4f,
  @location(3) ids: u32,
  @location(4) velocity: vec2f,
}

fn surface_default() -> SurfaceSample {
  var s: SurfaceSample;
  s.base_color = vec3f(0.5); s.ao = 1.0;
  s.n_shading = vec3f(0.0, 1.0, 0.0); s.roughness = 0.5;
  s.n_geom = vec3f(0.0, 1.0, 0.0); s.metalness = 0.0;
  s.emissive = 0.0; s.param = 0.0; s.aniso_strength = 0.0; s.aniso_angle = 0.0;
  s.class_id = CLASS_METAL; s.flags = 0u; s.object_id = 0u; s._pad = 0u;
  return s;
}

fn gbuffer_encode_ids(class_id: u32, flags: u32, object_id: u32, aniso_strength: f32, aniso_angle: f32) -> u32 {
  let st = u32(round(clamp(aniso_strength, 0.0, 1.0) * f32(GB3_ANISO_STRENGTH_MASK)));
  let a = fract(aniso_angle / PI);
  let an = min(u32(floor(a * f32(GB3_ANISO_ANGLE_MASK + 1u))), GB3_ANISO_ANGLE_MASK);
  return ((class_id & GB3_CLASS_MASK) << GB3_CLASS_SHIFT)
       | ((flags & GB3_FLAGS_MASK) << GB3_FLAGS_SHIFT)
       | ((object_id & GB3_OBJECT_MASK) << GB3_OBJECT_SHIFT)
       | (st << GB3_ANISO_STRENGTH_SHIFT)
       | (an << GB3_ANISO_ANGLE_SHIFT);
}
fn gbuffer_class(ids: u32) -> u32 { return (ids >> GB3_CLASS_SHIFT) & GB3_CLASS_MASK; }
fn gbuffer_flags(ids: u32) -> u32 { return (ids >> GB3_FLAGS_SHIFT) & GB3_FLAGS_MASK; }
fn gbuffer_object_id(ids: u32) -> u32 { return (ids >> GB3_OBJECT_SHIFT) & GB3_OBJECT_MASK; }

fn gbuffer_emissive_encode(intensity: f32) -> f32 {
  if (intensity <= 0.0) { return 0.0; }
  return clamp((log2(intensity) - EMISSIVE_LOG2_MIN) / EMISSIVE_LOG2_RANGE, 1.0 / 255.0, 1.0);
}
fn gbuffer_emissive_decode(e: f32) -> f32 {
  if (e < 0.5 / 255.0) { return 0.0; }
  return exp2(e * EMISSIVE_LOG2_RANGE + EMISSIVE_LOG2_MIN);
}

/** uv_prev − uv_current from the unjittered current clip position and the previous clip position. */
fn gbuffer_velocity(clip_nojitter: vec4f, clip_prev: vec4f) -> vec2f {
  let a = clip_nojitter.xy / clip_nojitter.w;
  let b = clip_prev.xy / clip_prev.w;
  return (b - a) * vec2f(0.5, -0.5);
}

fn gbuffer_pack(s: SurfaceSample, velocity: vec2f) -> GBufferOut {
  var o: GBufferOut;
  o.albedo_ao = vec4f(clamp(s.base_color, vec3f(0.0), vec3f(1.0)), clamp(s.ao, 0.0, 1.0));
  o.normals = vec4f(oct_encode(s.n_shading), oct_encode(s.n_geom));
  o.material = vec4f(clamp(s.roughness, 0.0, 1.0), clamp(s.metalness, 0.0, 1.0), clamp(s.param, 0.0, 1.0), gbuffer_emissive_encode(s.emissive));
  o.ids = gbuffer_encode_ids(s.class_id, s.flags, s.object_id, s.aniso_strength, s.aniso_angle);
  o.velocity = velocity;
  return o;
}

fn gbuffer_unpack(albedo_ao: vec4f, normals: vec4f, material: vec4f, ids: u32) -> SurfaceSample {
  var s: SurfaceSample;
  s.base_color = albedo_ao.rgb; s.ao = albedo_ao.a;
  s.n_shading = oct_decode(normals.xy); s.n_geom = oct_decode(normals.zw);
  s.roughness = material.r; s.metalness = material.g; s.param = material.b;
  s.emissive = gbuffer_emissive_decode(material.a);
  s.class_id = gbuffer_class(ids); s.flags = gbuffer_flags(ids); s.object_id = gbuffer_object_id(ids);
  s.aniso_strength = f32((ids >> GB3_ANISO_STRENGTH_SHIFT) & GB3_ANISO_STRENGTH_MASK) / f32(GB3_ANISO_STRENGTH_MASK);
  s.aniso_angle = (f32((ids >> GB3_ANISO_ANGLE_SHIFT) & GB3_ANISO_ANGLE_MASK) + 0.5) / f32(GB3_ANISO_ANGLE_MASK + 1u) * PI;
  s._pad = 0u;
  return s;
}
`, [packingWgsl, materialClassWgsl, gbufferFlagWgsl, mathWgsl]);

// ───────────────────────────── TS mirror ─────────────────────────────
export interface SurfaceSampleTs {
  baseColor: [number, number, number]; ao: number;
  nShading: [number, number, number]; nGeom: [number, number, number];
  roughness: number; metalness: number; emissive: number; param: number;
  anisoStrength: number; anisoAngle: number;
  classId: number; flags: number; objectId: number;
}
export interface GBufferTexels { albedoAo: number[]; normals: number[]; material: number[]; ids: number }

const mask = (bits: number) => (1 << bits) - 1;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** rgba8unorm storage rounding. */
export const unorm8 = (v: number) => Math.round(clamp01(v) * 255) / 255;
/** rgba16float storage rounding (IEEE half). */
export function half(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v;
  const s = Math.sign(v); const a = Math.abs(v);
  const e = Math.max(-14, Math.floor(Math.log2(a)));
  const step = 2 ** (e - 10);
  return s * Math.round(a / step) * step;
}

export function encodeIds(classId: number, flags: number, objectId: number, anisoStrength = 0, anisoAngle = 0): number {
  const st = Math.round(clamp01(anisoStrength) * mask(GB3.ANISO_STRENGTH_BITS));
  const a = ((anisoAngle / Math.PI) % 1 + 1) % 1;
  const an = Math.min(Math.floor(a * (1 << GB3.ANISO_ANGLE_BITS)), mask(GB3.ANISO_ANGLE_BITS));
  return (((classId & mask(GB3.CLASS_BITS)) << GB3.CLASS_SHIFT)
    | ((flags & mask(GB3.FLAGS_BITS)) << GB3.FLAGS_SHIFT)
    | ((objectId & mask(GB3.OBJECT_BITS)) << GB3.OBJECT_SHIFT)
    | (st << GB3.ANISO_STRENGTH_SHIFT)
    | (an << GB3.ANISO_ANGLE_SHIFT)) >>> 0;
}

export function decodeIds(ids: number): { classId: number; flags: number; objectId: number; anisoStrength: number; anisoAngle: number } {
  return {
    classId: (ids >>> GB3.CLASS_SHIFT) & mask(GB3.CLASS_BITS),
    flags: (ids >>> GB3.FLAGS_SHIFT) & mask(GB3.FLAGS_BITS),
    objectId: (ids >>> GB3.OBJECT_SHIFT) & mask(GB3.OBJECT_BITS),
    anisoStrength: ((ids >>> GB3.ANISO_STRENGTH_SHIFT) & mask(GB3.ANISO_STRENGTH_BITS)) / mask(GB3.ANISO_STRENGTH_BITS),
    anisoAngle: ((((ids >>> GB3.ANISO_ANGLE_SHIFT) & mask(GB3.ANISO_ANGLE_BITS)) + 0.5) / (1 << GB3.ANISO_ANGLE_BITS)) * Math.PI,
  };
}

export function emissiveEncode(intensity: number): number {
  if (intensity <= 0) return 0;
  return Math.min(1, Math.max(1 / 255, (Math.log2(intensity) - EMISSIVE_LOG2_MIN) / EMISSIVE_LOG2_RANGE));
}
export function emissiveDecode(e: number): number {
  return e < 0.5 / 255 ? 0 : 2 ** (e * EMISSIVE_LOG2_RANGE + EMISSIVE_LOG2_MIN);
}

/** Mirror of gbuffer_pack including render-target quantisation. */
export function gbufferPackTs(s: SurfaceSampleTs): GBufferTexels {
  const ns = octEncode(s.nShading), ng = octEncode(s.nGeom);
  return {
    albedoAo: [...s.baseColor.map(unorm8), unorm8(s.ao)],
    normals: [half(ns[0]), half(ns[1]), half(ng[0]), half(ng[1])],
    material: [unorm8(s.roughness), unorm8(s.metalness), unorm8(s.param), unorm8(emissiveEncode(s.emissive))],
    ids: encodeIds(s.classId, s.flags, s.objectId, s.anisoStrength, s.anisoAngle),
  };
}

export function gbufferUnpackTs(t: GBufferTexels): SurfaceSampleTs {
  const ids = decodeIds(t.ids);
  return {
    baseColor: [t.albedoAo[0], t.albedoAo[1], t.albedoAo[2]], ao: t.albedoAo[3],
    nShading: octDecode([t.normals[0], t.normals[1]]), nGeom: octDecode([t.normals[2], t.normals[3]]),
    roughness: t.material[0], metalness: t.material[1], param: t.material[2], emissive: emissiveDecode(t.material[3]),
    ...ids,
  };
}
