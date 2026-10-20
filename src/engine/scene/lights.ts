// Ported from Pinionfall src/gpu/lighting-helpers.ts (MIT, same owner)
/**
 * Flat punctual light list (≤ 64, no clusters — TMT needs about 32: muzzle flashes, explosions, headlights).
 * Adapted from Pinionfall: the Light packing (cone cosines as two unorm16 over [−1, 1] in one u32), the Frostbite windowed
 * inverse-square attenuation and the spot smoothstep. Type/flags live in a u32 vector instead of a bitcast f32 (no
 * denormal hazards). The list is provided as the reserved binding 'lights' and uploaded in the 'upload' slot when dirty.
 */
import type { LightHandle, LightInit, Vec3 } from '../contracts';
import { BufferUsage } from '../gpu/flags';
import { makeModule } from '../wgsl/module';
import { brdfWgsl } from '../wgsl/common/brdf.wgsl';

export const MAX_LIGHTS = 64;
export const LIGHT_FLOATS = 16;          // 64 B per light
export const LIGHT_LIST_HEADER_BYTES = 16;
export const LIGHT_LIST_BYTES = LIGHT_LIST_HEADER_BYTES + MAX_LIGHTS * LIGHT_FLOATS * 4;
export const LIGHT_TYPE = { point: 0, spot: 1 } as const;
export const LIGHT_FLAG_ENABLED = 1;
export const LIGHT_FLAG_CAST_SHADOW = 2;

export const lightsWgsl = makeModule('lights', /* wgsl */ `
const LIGHT_TYPE_POINT: u32 = 0u;
const LIGHT_TYPE_SPOT: u32 = 1u;
const LIGHT_FLAG_CAST_SHADOW: u32 = 2u;
const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;

struct Light {
  position_range: vec4f,   // xyz world position, w range
  color_intensity: vec4f,  // rgb = colour * intensity
  direction: vec4f,        // xyz unit spot direction (the way the spot points)
  params: vec4u,           // x type, y flags, z cone cosines (inner << 16 | outer, unorm16 over [-1, 1]), w mounting caster id (0 none)
}
struct LightList {
  header: vec4u,           // x = count
  lights: array<Light, ${MAX_LIGHTS}>,
}

fn unpack_cone_cosines(bits: u32) -> vec2f {
  let inner = f32((bits >> 16u) & 0xFFFFu) * (2.0 / 65535.0) - 1.0;
  let outer = f32(bits & 0xFFFFu) * (2.0 / 65535.0) - 1.0;
  return vec2f(inner, outer);
}

// Smooth window over the light's range: roughly inverse-square with a soft cutoff (Frostbite).
fn light_attenuation(dist_sq: f32, range: f32) -> f32 {
  let r2 = range * range;
  let inv = 1.0 / max(dist_sq, 0.0001);
  let win = saturate(1.0 - dist_sq * dist_sq / (r2 * r2));
  return inv * win * win;
}

// 0 outside the outer cone, 1 inside the inner cone.
fn spot_falloff(light_to_frag: vec3f, spot_dir: vec3f, cos_inner: f32, cos_outer: f32) -> f32 {
  let cos_a = dot(spot_dir, light_to_frag);
  return saturate((cos_a - cos_outer) / max(cos_inner - cos_outer, 1e-4));
}

/** One light's direct contribution (GGX + Burley) at a surface point. */
fn eval_light(l: Light, p: vec3f, n: vec3f, v: vec3f, base_color: vec3f, metalness: f32, roughness: f32) -> vec3f {
  let to_light = l.position_range.xyz - p;
  let dist_sq = dot(to_light, to_light);
  let range = l.position_range.w;
  if (dist_sq > range * range) { return vec3f(0.0); }
  let dir = to_light * inverseSqrt(max(dist_sq, 1e-8));
  if (dot(n, dir) <= 0.0) { return vec3f(0.0); }
  var angular = 1.0;
  if (l.params.x == LIGHT_TYPE_SPOT) {
    let cones = unpack_cone_cosines(l.params.z);
    angular = spot_falloff(-dir, l.direction.xyz, cones.x, cones.y);
    if (angular <= 0.0) { return vec3f(0.0); }
  }
  let radiance = l.color_intensity.rgb * (light_attenuation(dist_sq, range) * angular);
  return brdf_direct(n, v, dir, base_color, metalness, roughness) * radiance;
}
`, [brdfWgsl]);

// ───────────────────────────── CPU packing (mirrors the WGSL) ─────────────────────────────
export function packConeCosines(cosInner: number, cosOuter: number): number {
  const q = (c: number) => Math.round((Math.min(1, Math.max(-1, c)) + 1) * 0.5 * 65535) & 0xffff;
  return ((q(cosInner) << 16) | q(cosOuter)) >>> 0;
}
export function unpackConeCosines(bits: number): [number, number] {
  return [((bits >>> 16) & 0xffff) * (2 / 65535) - 1, (bits & 0xffff) * (2 / 65535) - 1];
}
export function lightAttenuation(distSq: number, range: number): number {
  const r2 = range * range;
  const win = Math.min(1, Math.max(0, 1 - distSq * distSq / (r2 * r2)));
  return (1 / Math.max(distSq, 1e-4)) * win * win;
}

/** Write one light (64 B) at `floatOffset` of the list's f32/u32 views. */
export function packLight(l: LightInit, f32: Float32Array, u32: Uint32Array, floatOffset: number): void {
  const o = floatOffset;
  f32[o] = l.position[0]; f32[o + 1] = l.position[1]; f32[o + 2] = l.position[2]; f32[o + 3] = Math.max(1e-3, l.range);
  f32[o + 4] = l.color[0] * l.intensity; f32[o + 5] = l.color[1] * l.intensity; f32[o + 6] = l.color[2] * l.intensity; f32[o + 7] = 0;
  const d: Vec3 = l.direction ?? [0, -1, 0];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  f32[o + 8] = d[0] / dl; f32[o + 9] = d[1] / dl; f32[o + 10] = d[2] / dl; f32[o + 11] = 0;
  const outer = l.outerAngle ?? Math.PI / 4;
  const inner = Math.min(l.innerAngle ?? outer * 0.8, outer);
  u32[o + 12] = LIGHT_TYPE[l.type]; u32[o + 13] = LIGHT_FLAG_ENABLED | (l.castShadow ? LIGHT_FLAG_CAST_SHADOW : 0);
  u32[o + 14] = packConeCosines(Math.cos(inner), Math.cos(outer)); u32[o + 15] = l.sourceCasterId ?? 0;
}

type LightDevice = Pick<GPUDevice, 'createBuffer'> & { queue: Pick<GPUQueue, 'writeBuffer'> };

export class LightSystem {
  readonly buffer: GPUBuffer;
  private readonly data = new ArrayBuffer(LIGHT_LIST_BYTES);
  private readonly f32 = new Float32Array(this.data);
  private readonly u32 = new Uint32Array(this.data);
  private readonly lights = new Map<number, LightInit>();
  private nextId = 1;
  private dirty = true;
  /** The words last uploaded: a repack that reproduces them is not uploaded again. */
  private readonly uploaded = new Uint32Array(LIGHT_LIST_BYTES / 4);
  private uploadedBytes = 0;

  constructor(private readonly device: LightDevice) {
    this.buffer = device.createBuffer({ label: 'lights:list', size: LIGHT_LIST_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST | BufferUsage.COPY_SRC });
  }

  get count(): number { return this.lights.size; }

  /** Current packed slot; GPU writers resolve it before the upload pass after all pool mutations. */
  indexOf(h: LightHandle): number {
    let index = 0;
    for (const id of this.lights.keys()) { if (id === h.id) return index; index++; }
    return -1;
  }

  /** Order matches pack() and the shader's LightList indices. */
  shadowCasters(): { index: number; light: Readonly<LightInit> }[] {
    const out: { index: number; light: Readonly<LightInit> }[] = [];
    let index = 0;
    for (const light of this.lights.values()) {
      if (light.castShadow) out.push({ index, light });
      index++;
    }
    return out;
  }

  add(l: LightInit): LightHandle {
    if (this.lights.size >= MAX_LIGHTS) throw new Error(`light list is full (${MAX_LIGHTS})`);
    const id = this.nextId++;
    this.lights.set(id, { ...l });
    this.dirty = true;
    return { id };
  }

  update(h: LightHandle, l: Partial<LightInit>): void {
    const cur = this.lights.get(h.id);
    if (!cur) throw new Error(`unknown light ${h.id}`);
    this.lights.set(h.id, { ...cur, ...l });
    this.dirty = true;
  }

  remove(h: LightHandle): void {
    if (this.lights.delete(h.id)) this.dirty = true;
  }

  /** Pack the list (header + lights) into the CPU mirror; returns the bytes to upload. */
  pack(): ArrayBuffer {
    this.u32.fill(0);
    let i = 0;
    for (const l of this.lights.values()) packLight(l, this.f32, this.u32, LIGHT_LIST_HEADER_BYTES / 4 + i++ * LIGHT_FLOATS);
    this.u32[0] = i;
    return this.data;
  }

  upload(): void {
    if (!this.dirty) return;
    this.pack();
    this.dirty = false;
    const bytes = Math.max(16, LIGHT_LIST_HEADER_BYTES + this.lights.size * LIGHT_FLOATS * 4), words = bytes / 4, packed = this.u32, last = this.uploaded;
    let same = bytes === this.uploadedBytes;
    for (let i = 0; same && i < words; i++) if (packed[i] !== last[i]) same = false;
    if (same) return;
    last.set(packed.subarray(0, words));
    this.uploadedBytes = bytes;
    this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, bytes);
  }
}

declare module '../contracts' { interface SceneFacets { lightSystem: LightSystem } }

/** Core module: scene.lights + the 'lights' reserved binding + the upload pass. */
export function lightsModule(): import('../contracts').RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'lights',
    install(s) {
      const system = new LightSystem(s.ctx.device);
      (s.scene as import('./scene-registry').Scene).attachLights(system);
      s.scene.provide('lightSystem', system);
      s.bindings.provide('lights', { list: { buffer: system.buffer } });
      disposers.push(s.graph.addPass({ name: 'lights.upload', slot: 'upload', order: 20, reads: [], writes: [], run: () => system.upload() }));
      disposers.push(() => s.ctx.deferDestroy(system.buffer));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
