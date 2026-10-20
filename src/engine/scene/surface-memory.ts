/**
 * Surface Memory Cube (plan §4.13): an rgba8unorm 6-layer equi-angular cube (1024² per face on High/Ultra, 512² on
 * Low/Medium; 24 MB at High) that remembers what happened to the ground:
 *   R track compression · G scorch/burn · B trample (W2-VEG) · A wetness (W2-WATER).
 * Face/texel convention: src/world/cube-sphere.ts (layer = face, texel = ((u, v) + 1) / 2 · size).
 *
 * Writes are RENDER passes into single-layer views (a read-modify-write on rgba8 storage is not core WebGPU, but blending
 * is): every op is a quad rasterised in face space.
 * - `stamp(channel, stamps)`: oriented rectangles (track contact patches, with an optional grouser bar pattern along the
 *   tread) or discs (blast scorch: dense at the blast, thinning out to a ragged, rayed edge with mottled breakup, seeded
 *   per blast), blended with MAX into the one channel (write mask) — overlapping passes never darken more.
 *   A footprint near a seam is written into every face it reaches (`facesTouching`), so either side samples it.
 * - `clearSphere(center, radius)`: zeroes every channel but scorch inside the angular radius of the sphere (a fresh crater
 *   surface has no tracks, but keeps the scorch of the blast that made it); coverage is exactly 0 outside the angle
 *   (`smcDiscCoverage`, mirrored in WGSL).
 * - Decay at 4 Hz: a fullscreen reverse-subtract draw per layer removes whole 1/255 steps per channel from a CPU
 *   accumulator (tracks fade over 300 s, scorch 480 s, trample 30 s, wetness 60 s).
 * Order inside a frame: decay → clears → stamps. The pass runs in 'compute.pre' (order 10) only when there is work.
 * The texture is the reserved binding `surfaceMemory` (key `cube`, a 2d-array view) and the scene facet `surfaceMemory`.
 */
import type { EngineServices, QualityTier, RenderModule } from '../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../gpu/flags';
import { cubeSphereWgsl } from '../wgsl/common/cube-sphere.wgsl';
import { materialNoiseWgsl } from '../wgsl/common/noise.wgsl';
import { link, makeModule } from '../wgsl/module';
import { cubeFaceOf, cubeUv, CUBE_FACE_AXES, facesTouching, type V3 } from '../../world/cube-sphere';
import './facets';

export type SmcChannel = 'tracks' | 'scorch' | 'trample' | 'wet';
export const SMC_CHANNELS: readonly SmcChannel[] = ['tracks', 'scorch', 'trample', 'wet'];
export const SMC_CHANNEL_INDEX: Readonly<Record<SmcChannel, number>> = { tracks: 0, scorch: 1, trample: 2, wet: 3 };
/** Seconds for a full-strength mark to fade to zero, per channel. */
export const SMC_FADE_SECONDS: Readonly<Record<SmcChannel, number>> = { tracks: 300, scorch: 480, trample: 30, wet: 60 };
export const SMC_DECAY_HZ = 4;
export const SMC_FORMAT: GPUTextureFormat = 'rgba8unorm';
export const SMC_SIZE: Readonly<Record<QualityTier, number>> = { low: 512, medium: 512, high: 1024, ultra: 1024 };

export interface SmcStamp {
  /** World-space centre of the footprint (it is projected radially onto the cube). */
  center: V3;
  /** Rectangle: the footprint's forward direction (world, any length). Omit for a disc of radius `halfWidth`. */
  forward?: V3;
  /** Rectangle half length along `forward` (default = halfWidth). */
  halfLength?: number;
  /** Rectangle half width across `forward`, or the disc radius (world units at the footprint's radius). */
  halfWidth: number;
  /** Channel value in [0, 1], MAX-blended. */
  strength: number;
  /** Grouser pattern: tread coordinate at the back and front edge (bars at integer + 0.5); omit for a flat patch. */
  tread?: [number, number];
  /** Sideways slip smears the grouser relief into a continuous scuff. */
  scrub?: number;
  /** Soft edge fraction in (0, 1]; default 0.3. */
  soft?: number;
  /** Rectangle only: soft fraction at the two ends along `forward` (default soft / 2; 0 = hard ends, for swept strips). */
  endSoft?: number;
}

export interface SurfaceMemoryFacet {
  /** `held`: stamps submitted again every frame while they stay put (track contacts); repeats are skipped (SmcHeldQuads). */
  stamp(channel: SmcChannel, stamps: readonly SmcStamp[], held?: boolean): void;
  clearSphere(center: V3, radius: number): void;
  /** W1 additive: zero the whole cube (a new world). */
  clearAll(): void;
  stats(): { size: number; bytes: number; stamps: number; clears: number; decayTicks: number; draws: number };
  /** Decay owed to a channel but not yet drawn (SmcDecay.pending), for readers that want a continuous fade. */
  pendingDecay(channel: SmcChannel): number;
}

// ───────────────────────────── CPU planning (pure, tested) ─────────────────────────────

/** Floats per instance: 4 corners (face uv, 8), params (strength, soft, v0, v1), disc (centre dir xyz, cos angle; rect: (endSoft, 0, 0, -2)). */
export const SMC_INSTANCE_FLOATS = 16;

export interface SmcQuad { face: number; corners: [number, number][]; strength: number; soft: number; tread: [number, number]; disc: [number, number, number, number] }

const norm = (a: readonly number[]): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The face-space quads of one stamp: one per face it reaches. Corner order: (−along, −across), (+along, −across),
 * (+along, +across), (−along, +across). A face is skipped when a corner falls behind its hemisphere (never for footprints
 * smaller than ~40°).
 */
export function planSmcStamp(s: SmcStamp, discOverride?: { cosAngle: number }): SmcQuad[] {
  const r = Math.hypot(s.center[0], s.center[1], s.center[2]);
  if (!(r > 1e-6) || !(s.halfWidth > 0) || !Number.isFinite(s.strength)) return [];
  const up = norm(s.center);
  const isDisc = !s.forward;
  let fwd: V3 = s.forward ? s.forward : Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  fwd = norm([fwd[0] - up[0] * dot(fwd, up), fwd[1] - up[1] * dot(fwd, up), fwd[2] - up[2] * dot(fwd, up)]);
  const right = norm(cross(up, fwd));
  const hl = isDisc ? s.halfWidth : (s.halfLength ?? s.halfWidth), hw = s.halfWidth;
  // Corners on the tangent plane; they are only used as directions.
  const pad = isDisc ? 1.05 : 1;
  const corner = (a: number, b: number): V3 => norm([
    s.center[0] + (fwd[0] * a * hl + right[0] * b * hw) * pad, s.center[1] + (fwd[1] * a * hl + right[1] * b * hw) * pad, s.center[2] + (fwd[2] * a * hl + right[2] * b * hw) * pad]);
  const dirs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const angle = Math.atan(Math.hypot(hl, hw) * pad / r);
  const cosAngle = discOverride?.cosAngle ?? (isDisc ? Math.cos(Math.atan(hw / r)) : -2);
  const out: SmcQuad[] = [];
  for (const face of facesTouching(up, angle)) {
    const axis = CUBE_FACE_AXES[face];
    let corners: [number, number][];
    if (isDisc) {
      // A disc is tested exactly per fragment (its direction and angle): its quad only has to bound it on this face.
      // Skipping a face whenever one tangent corner fell behind it lost most of a large scorch near a cube corner, or
      // cut it along a seam; bound the projected rim instead, and cover the whole face when the rim wraps behind it.
      const bound = discFaceBounds(up, fwd, right, Math.atan(hw * pad / r), face);
      if (!bound) continue;
      corners = [[bound[0], bound[1]], [bound[2], bound[1]], [bound[2], bound[3]], [bound[0], bound[3]]];
    } else {
      if (dirs.some(d => dot(d, axis) < 0.05)) continue;
      corners = dirs.map(d => cubeUv(d, face));
    }
    out.push({
      face, corners, strength: Math.min(1, Math.max(0, s.strength)), soft: Math.min(1, Math.max(0.02, s.soft ?? 0.3)),
      tread: s.tread ?? [0, 0],
      // Rectangles reuse the disc slot: x = end soft fraction, w = -2 (rect flag).
      disc: isDisc ? [up[0], up[1], up[2], cosAngle] : [Math.min(1, Math.max(0, s.endSoft ?? (s.soft ?? 0.3) * 0.5)), Math.min(1, Math.max(0, s.scrub ?? 0)), 0, -2],
    });
  }
  return out;
}

/**
 * Face-uv bounds (u0, v0, u1, v1) of a disc of angular radius `angle` around `up` on `face`: its centre and two rims,
 * padded and clamped to the face; the whole face when part of the rim wraps behind it, null when none of it lands there.
 */
function discFaceBounds(up: V3, fwd: V3, right: V3, angle: number, face: number): [number, number, number, number] | null {
  const axis = CUBE_FACE_AXES[face], limit = 1.02;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity, behind = false, inside = false;
  const add = (d: V3) => {
    if (dot(d, axis) < 0.05) { behind = true; return; }
    const [u, v] = cubeUv(d, face);
    if (Math.abs(u) <= limit && Math.abs(v) <= limit) inside = true;
    u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v);
  };
  add(up);
  for (const a of [angle * 0.5, angle]) {
    const c = Math.cos(a), sn = Math.sin(a);
    for (let k = 0; k < 32; k++) {
      const phi = k / 32 * Math.PI * 2, x = Math.cos(phi) * sn, y = Math.sin(phi) * sn;
      add(norm([up[0] * c + fwd[0] * x + right[0] * y, up[1] * c + fwd[1] * x + right[1] * y, up[2] * c + fwd[2] * x + right[2] * y]));
    }
  }
  if (behind) return [-limit, -limit, limit, limit];
  if (!inside && (u1 < -limit || u0 > limit || v1 < -limit || v0 > limit)) return null;
  // The rim between samples bulges out by at most 1 - cos(π/32) of the span: pad by 2 %.
  const pu = (u1 - u0) * 0.02 + 0.002, pv = (v1 - v0) * 0.02 + 0.002;
  const clamp = (x: number) => Math.min(limit, Math.max(-limit, x));
  return [clamp(u0 - pu), clamp(v0 - pv), clamp(u1 + pu), clamp(v1 + pv)];
}

/** Faces of a clearSphere: the disc of every point within the sphere's angular radius (as seen from the planet centre). */
export function planSmcClear(center: V3, radius: number): SmcQuad[] {
  const r = Math.hypot(center[0], center[1], center[2]);
  if (!(r > radius) || !(radius > 0)) {
    // A sphere containing the planet centre (never in play) clears nothing rather than everything.
    return [];
  }
  const angle = Math.asin(Math.min(1, radius / r));
  const tangentRadius = Math.tan(angle) * r;
  return planSmcStamp({ center, halfWidth: tangentRadius, strength: 1, soft: 0.02 }, { cosAngle: Math.cos(angle) });
}

/** Mirror of the disc coverage in the WGSL (`smc_disc_coverage`): 0 outside the angle, ramping to 1 inside. */
export function smcDiscCoverage(dir: readonly number[], centre: readonly number[], cosAngle: number, soft: number): number {
  const c = dot(norm(dir), centre);
  if (c < cosAngle) return 0;
  const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle)));
  const d = Math.acos(Math.min(1, Math.max(-1, c)));
  const t = Math.min(1, Math.max(0, (angle - d) / Math.max(angle * soft, 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Pack quads into the instance layout. */
export function packSmcQuads(quads: readonly SmcQuad[], out: Float32Array, first = 0): number {
  for (let i = 0; i < quads.length; i++) packSmcQuad(quads[i], out, (first + i) * SMC_INSTANCE_FLOATS);
  return quads.length;
}
function packSmcQuad(q: SmcQuad, out: Float32Array, o: number): void {
  for (let k = 0; k < 4; k++) { out[o + k * 2] = q.corners[k][0]; out[o + k * 2 + 1] = q.corners[k][1]; }
  out[o + 8] = q.strength; out[o + 9] = q.soft; out[o + 10] = q.tread[0]; out[o + 11] = q.tread[1];
  out[o + 12] = q.disc[0]; out[o + 13] = q.disc[1]; out[o + 14] = q.disc[2]; out[o + 15] = q.disc[3];
}

/**
 * Stamps that are submitted again every frame while nothing moves (a parked tank's track contacts). A MAX-blended stamp
 * drawn over a texel it already raised changes nothing, and only decay, crater clears and wipes ever lower a texel, so a
 * held quad identical (face and packed floats) to one of the previous frame's held quads of its channel is skipped in a
 * frame without any of those. The previous frame's quad was drawn, or skipped by the same rule, after the last lowering.
 */
export class SmcHeldQuads {
  private last: { face: number; data: Float32Array }[] = [];
  private next: { face: number; data: Float32Array }[] = [];
  private lastCount = 0;
  private nextCount = 0;
  private readonly packed = new Float32Array(SMC_INSTANCE_FLOATS);

  /** Add the quads of this frame that must be drawn to `keep`; every quad is remembered for the next frame. */
  filter(quads: readonly SmcQuad[], lowered: boolean, keep: SmcQuad[]): void {
    for (const q of quads) {
      packSmcQuad(q, this.packed, 0);
      if (lowered || !this.seen(q.face)) keep.push(q);
      let slot = this.next[this.nextCount];
      if (!slot) this.next[this.nextCount] = slot = { face: 0, data: new Float32Array(SMC_INSTANCE_FLOATS) };
      slot.face = q.face; slot.data.set(this.packed); this.nextCount++;
    }
  }

  /** End of a frame (a frame without held quads forgets the previous ones). */
  flip(): void {
    const last = this.last;
    this.last = this.next; this.lastCount = this.nextCount;
    this.next = last; this.nextCount = 0;
  }

  private seen(face: number): boolean {
    for (let i = 0; i < this.lastCount; i++) {
      const q = this.last[i];
      if (q.face !== face) continue;
      let same = true;
      for (let k = 0; same && k < SMC_INSTANCE_FLOATS; k++) if (!Object.is(q.data[k], this.packed[k])) same = false;
      if (same) return true;
    }
    return false;
  }
}

/** Decay accumulator: whole 1/255 steps to subtract per channel this tick. */
export class SmcDecay {
  private readonly acc = [0, 0, 0, 0];
  ticks = 0;
  private time = 0;
  /** Advance by dt seconds; returns the per-channel steps (in 1/255 units) for each 4 Hz tick that elapsed, summed. */
  advance(dt: number): [number, number, number, number] | null {
    this.time += Math.max(0, Math.min(dt, 1));
    const period = 1 / SMC_DECAY_HZ;
    if (this.time < period) return null;
    const ticks = Math.floor(this.time / period);
    this.time -= ticks * period;
    this.ticks += ticks;
    const steps: [number, number, number, number] = [0, 0, 0, 0];
    SMC_CHANNELS.forEach((ch, i) => {
      this.acc[i] += (255 * period * ticks) / SMC_FADE_SECONDS[ch];
      steps[i] = Math.floor(this.acc[i]);
      this.acc[i] -= steps[i];
    });
    return steps.some(v => v > 0) ? steps : null;
  }
  /** Decay owed to a channel but not yet drawn (the 4 Hz ticks remove whole 1/255 steps), as a texel value: readers
   *  subtracting it see the channel fade continuously instead of in steps. */
  pending(channel: SmcChannel): number {
    const i = SMC_CHANNELS.indexOf(channel);
    return (this.acc[i] + 255 * this.time / SMC_FADE_SECONDS[channel]) / 255;
  }
}

// ───────────────────────────── GPU ─────────────────────────────

const smcShader = makeModule('smc', /* wgsl */ `
struct SmcIn {
  @location(0) c0: vec2f, @location(1) c1: vec2f, @location(2) c2: vec2f, @location(3) c3: vec2f,
  @location(4) params: vec4f,
  @location(5) disc: vec4f,
}
struct SmcOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) params: vec4f,
  @location(2) @interpolate(flat) disc: vec4f,
}
struct SmcFace { face: vec4u, decay: vec4f }
@group(0) @binding(0) var<uniform> smc_face: SmcFace;

@vertex
fn vs_smc(in: SmcIn, @builtin(vertex_index) vi: u32) -> SmcOut {
  // Two triangles over corners 0-1-2 / 0-2-3.
  var idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  let k = idx[vi];
  var corners = array<vec2f, 4>(in.c0, in.c1, in.c2, in.c3);
  var locals = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let uv = corners[k];
  var out: SmcOut;
  out.position = vec4f(uv.x, -uv.y, 0.0, 1.0);
  out.local = locals[k];
  out.params = in.params;
  out.disc = in.disc;
  return out;
}

/** 0 outside the angular radius (cos_angle = disc.w), smooth ramp over the inner soft fraction. */
fn smc_disc_coverage(dir: vec3f, disc: vec4f, soft: f32) -> f32 {
  let c = dot(dir, disc.xyz);
  if (c < disc.w) { return 0.0; }
  let angle = acos(clamp(disc.w, -1.0, 1.0));
  let d = acos(clamp(c, -1.0, 1.0));
  return smoothstep(0.0, 1.0, clamp((angle - d) / max(angle * soft, 1e-6), 0.0, 1.0));
}

/** Periodic value noise over an azimuth a in [0, 1): cells lattice points around the circle. */
fn smc_ring_noise(a: f32, cells: i32, salt: u32) -> f32 {
  let x = a * f32(cells);
  let i = i32(floor(x)) % cells;
  let f = fract(x);
  return mix(mn_hash3(i, 0, 0, salt), mn_hash3((i + 1) % cells, 0, 0, salt), f * f * (3.0 - 2.0 * f));
}

/**
 * Blast scorch, in units of the stamp radius (the crater rim sits near 0.5): dense soot for the inner (1 − soft) of each
 * direction's reach, thinning out to a ragged edge. The reach varies around the blast (broad lobes plus narrower tongues,
 * always inside the stamp), streak gaps open up past the rim and the soot breaks into flecks toward the edge, so it
 * never reads as a clean disc or ring. Seeded by the centre, so every blast differs.
 */
fn smc_scorch_coverage(dir: vec3f, disc: vec4f, soft: f32) -> f32 {
  if (dot(dir, disc.xyz) < disc.w) { return 0.0; }
  let angle = max(acos(clamp(disc.w, -1.0, 1.0)), 1e-6);
  let side = normalize(cross(disc.xyz, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(disc.x) > 0.9)));
  let q = vec2f(dot(dir, side), dot(dir, cross(disc.xyz, side))) / angle;
  let d = length(q);
  let salt = bitcast<u32>(disc.x) ^ (bitcast<u32>(disc.y) * 0x9E3779B1u) ^ (bitcast<u32>(disc.z) * 0x85EBCA6Bu);
  let az = atan2(q.y, q.x) * 0.15915494 + 0.5;
  let tongue = smc_ring_noise(az, 17, salt ^ 0x5BD1E995u);
  let reach = min(0.74 + 0.1 * smc_ring_noise(az, 5, salt) + 0.16 * tongue * tongue, 1.0);
  let fall = 1.0 - smoothstep(reach * (1.0 - soft), reach, d);
  let streak = smoothstep(0.35, 0.75, smc_ring_noise(az, 17, salt ^ 0x27D4EB2Du));
  let rays = 1.0 - 0.8 * (1.0 - streak) * smoothstep(0.52, 0.8, d);
  let flecks = 0.6 * mn_value3(vec3f(q * 5.0, 0.0), salt ^ 0x68E31DA4u) + 0.4 * mn_value3(vec3f(q * 14.0, 3.0), salt ^ 0x1B873593u);
  return fall * rays * (1.0 - 0.3 * (1.0 - flecks) * smoothstep(0.4, 1.0, d / reach));
}

fn smc_face_dir(frag: vec4f) -> vec3f {
  let size = f32(smc_face.face.y);
  let uv = frag.xy / size * 2.0 - vec2f(1.0);
  return cs_dir(smc_face.face.x, uv);
}

fn smc_value(in: SmcOut) -> f32 {
  let soft = in.params.y;
  var cover: f32;
  if (in.disc.w > -1.5) {
    cover = smc_scorch_coverage(smc_face_dir(in.position), in.disc, soft);
  } else {
    let a = abs(in.local);
    let end_soft = in.disc.x;
    let along = select(1.0, 1.0 - smoothstep(1.0 - end_soft, 1.0, a.x), end_soft > 0.001);
    cover = (1.0 - smoothstep(1.0 - soft, 1.0, a.y)) * along;
    let span = in.params.w - in.params.z;
    if (abs(span) > 1e-5) {
      let v = in.params.z + span * (in.local.x * 0.5 + 0.5);
      let bar = 1.0 - smoothstep(0.11, 0.23, abs(fract(v) - 0.5));
      cover = cover * mix(0.22 + 0.78 * bar, 0.45, in.disc.y * 0.85);
    }
  }
  return cover * in.params.x;
}

@fragment
fn fs_smc_stamp(in: SmcOut) -> @location(0) vec4f {
  let v = smc_value(in);
  if (v <= 0.0) { discard; }
  return vec4f(v);
}

@fragment
fn fs_smc_clear(in: SmcOut) -> @location(0) vec4f {
  let cover = smc_disc_coverage(smc_face_dir(in.position), in.disc, in.params.y);
  if (cover <= 0.0) { discard; }
  return vec4f(0.0, 0.0, 0.0, cover);
}

@vertex
fn vs_smc_full(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs_smc_decay() -> @location(0) vec4f { return smc_face.decay; }
`, [cubeSphereWgsl, materialNoiseWgsl]);

export function smcShaderLinked() { return link(smcShader); }

const SMC_INSTANCE_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SMC_INSTANCE_FLOATS * 4, stepMode: 'instance',
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' },
    { shaderLocation: 2, offset: 16, format: 'float32x2' }, { shaderLocation: 3, offset: 24, format: 'float32x2' },
    { shaderLocation: 4, offset: 32, format: 'float32x4' }, { shaderLocation: 5, offset: 48, format: 'float32x4' },
  ],
};

type Op = { kind: 'stamp'; channel: SmcChannel; quads: SmcQuad[]; held: boolean } | { kind: 'clear'; quads: SmcQuad[] };

export interface SurfaceMemoryModule extends RenderModule { readonly facet: SurfaceMemoryFacet | null }

export function surfaceMemoryModule(options: { size?: number } = {}): SurfaceMemoryModule {
  const disposers: (() => void)[] = [];
  let facet: SurfaceMemoryFacet | null = null;
  return {
    name: 'scene.surface-memory',
    get facet() { return facet; },
    async install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const size = options.size ?? SMC_SIZE[s.settings.tier];
      const texture = device.createTexture({
        label: 'smc:cube', size: [size, size, 6], format: SMC_FORMAT, dimension: '2d',
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_DST,
      });
      // Zero-initialised by WebGPU; provide as the reserved binding.
      s.bindings.provide('surfaceMemory', { cube: texture.createView({ dimension: '2d-array' }) });
      const faceViews = Array.from({ length: 6 }, (_, f) => texture.createView({ dimension: '2d', baseArrayLayer: f, arrayLayerCount: 1 }));
      const faceUniforms = Array.from({ length: 6 }, (_, f) => device.createBuffer({ label: `smc:face-${f}`, size: 32, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }));
      faceUniforms.forEach((b, f) => queue.writeBuffer(b, 0, new Uint32Array([f, size, 0, 0, 0, 0, 0, 0])));
      disposers.push(() => { s.ctx.deferDestroy(texture); faceUniforms.forEach(b => s.ctx.deferDestroy(b)); });
      const layout = device.createBindGroupLayout({ label: 'layout:smc', entries: [{ binding: 0, visibility: ShaderStage.VERTEX | ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
      const groups = faceUniforms.map((buffer, f) => device.createBindGroup({ label: `smc:face-${f}`, layout, entries: [{ binding: 0, resource: { buffer } }] }));
      const pipelineLayout = device.createPipelineLayout({ label: 'smc', bindGroupLayouts: [layout] });
      const cache = s.ctx.pipelines;
      const shader = () => cache.shaderModule(smcShaderLinked(), 'smc');
      const MASKS = [0x1, 0x2, 0x4, 0x8];
      const stampKey = (c: number) => `smc:stamp:${c}`;
      SMC_CHANNELS.forEach((_, c) => cache.register(stampKey(c), 'render', () => ({
        label: stampKey(c), layout: pipelineLayout,
        vertex: { module: shader(), entryPoint: 'vs_smc', buffers: [SMC_INSTANCE_LAYOUT] },
        fragment: { module: shader(), entryPoint: 'fs_smc_stamp', targets: [{ format: SMC_FORMAT, writeMask: MASKS[c],
          blend: { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } } }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      })));
      cache.register('smc:clear', 'render', () => ({
        label: 'smc:clear', layout: pipelineLayout,
        vertex: { module: shader(), entryPoint: 'vs_smc', buffers: [SMC_INSTANCE_LAYOUT] },
        // Every channel but G: a fresh crater keeps the scorch of the blast that carved it.
        fragment: { module: shader(), entryPoint: 'fs_smc_clear', targets: [{ format: SMC_FORMAT, writeMask: MASKS[0] | MASKS[2] | MASKS[3],
          blend: { color: { operation: 'add', srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      }));
      cache.register('smc:decay', 'render', () => ({
        label: 'smc:decay', layout: pipelineLayout,
        vertex: { module: shader(), entryPoint: 'vs_smc_full' },
        fragment: { module: shader(), entryPoint: 'fs_smc_decay', targets: [{ format: SMC_FORMAT,
          blend: { color: { operation: 'reverse-subtract', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'reverse-subtract', srcFactor: 'one', dstFactor: 'one' } } }] },
        primitive: { topology: 'triangle-list' },
      }));
      await Promise.all([...SMC_CHANNELS.map((_, c) => cache.compile(stampKey(c))), cache.compile('smc:clear'), cache.compile('smc:decay')]);

      const ops: Op[] = [];
      let wipe = false;
      const decay = new SmcDecay();
      let stamps = 0, clears = 0, draws = 0;
      let instanceBuffer: GPUBuffer | null = null, instanceCapacity = 0;
      let staging = new Float32Array(SMC_INSTANCE_FLOATS * 64);
      const held = SMC_CHANNELS.map(() => new SmcHeldQuads());
      disposers.push(() => s.ctx.deferDestroy(instanceBuffer));
      facet = {
        stamp(channel, list, hold = false) {
          if (!(channel in SMC_CHANNEL_INDEX)) throw new Error(`unknown SMC channel ${channel}`);
          const quads = list.flatMap(st => planSmcStamp(st));
          if (quads.length) { ops.push({ kind: 'stamp', channel, quads, held: hold }); stamps += list.length; }
        },
        clearSphere(center, radius) {
          const quads = planSmcClear(center, radius);
          if (quads.length) { ops.push({ kind: 'clear', quads }); clears++; }
        },
        clearAll() { ops.length = 0; wipe = true; stamps = 0; clears = 0; },
        stats: () => ({ size, bytes: size * size * 6 * 4, stamps, clears, decayTicks: decay.ticks, draws }),
        pendingDecay: channel => decay.pending(channel),
      };
      s.scene.provide('surfaceMemory', facet);

      disposers.push(s.graph.addPass({
        name: 'smc', slot: 'compute.pre', order: 10, reads: [], writes: [],
        run(c) {
          const steps = decay.advance(c.frame.dt);
          // Held quads already drawn since the last decay, clear or wipe are dropped (SmcHeldQuads).
          const lowered = !!steps || wipe || ops.some(op => op.kind === 'clear');
          let work = 0;
          for (const op of ops) {
            if (op.kind === 'stamp' && op.held) {
              const keep: SmcQuad[] = [];
              held[SMC_CHANNEL_INDEX[op.channel]].filter(op.quads, lowered, keep);
              op.quads = keep;
            }
            work += op.quads.length;
          }
          for (const h of held) h.flip();
          if (!work) ops.length = 0;
          if (!steps && !ops.length && !wipe) { draws = 0; return; }
          if (wipe) {
            wipe = false;
            for (let face = 0; face < 6; face++) {
              c.encoder.beginRenderPass({ label: `smc:wipe-${face}`, colorAttachments: [{ view: faceViews[face], loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] }).end();
            }
          }
          // Gather quads per face: clears first, then stamps grouped by channel (op order inside each group is kept).
          const perFace: { clear: SmcQuad[]; stamp: SmcQuad[][] }[] = Array.from({ length: 6 }, () => ({ clear: [], stamp: [[], [], [], []] }));
          for (const op of ops) for (const q of op.quads) {
            if (op.kind === 'clear') perFace[q.face].clear.push(q);
            else perFace[q.face].stamp[SMC_CHANNEL_INDEX[op.channel]].push(q);
          }
          ops.length = 0;
          const total = perFace.reduce((n, f) => n + f.clear.length + f.stamp.reduce((m, l) => m + l.length, 0), 0);
          if (total * SMC_INSTANCE_FLOATS > staging.length) staging = new Float32Array(Math.max(total, staging.length / SMC_INSTANCE_FLOATS * 2) * SMC_INSTANCE_FLOATS);
          const ranges: { face: number; kind: 'clear' | number; first: number; count: number }[] = [];
          let n = 0;
          perFace.forEach((f, face) => {
            if (f.clear.length) { ranges.push({ face, kind: 'clear', first: n, count: f.clear.length }); n += packSmcQuads(f.clear, staging, n); }
            f.stamp.forEach((list, ch) => { if (list.length) { ranges.push({ face, kind: ch, first: n, count: list.length }); n += packSmcQuads(list, staging, n); } });
          });
          if (n > 0) {
            const bytes = n * SMC_INSTANCE_FLOATS * 4;
            if (!instanceBuffer || instanceCapacity < bytes) {
              if (instanceBuffer) s.ctx.deferDestroy(instanceBuffer);
              instanceCapacity = Math.max(4096, 1 << Math.ceil(Math.log2(bytes)));
              instanceBuffer = device.createBuffer({ label: 'smc:instances', size: instanceCapacity, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
            }
            queue.writeBuffer(instanceBuffer, 0, staging.buffer, 0, bytes);
          }
          if (steps) for (let f = 0; f < 6; f++) queue.writeBuffer(faceUniforms[f], 16, new Float32Array(steps.map(v => v / 255)));
          draws = 0;
          const decayPipeline = cache.get<GPURenderPipeline>('smc:decay'), clearPipeline = cache.get<GPURenderPipeline>('smc:clear');
          for (let face = 0; face < 6; face++) {
            const faceRanges = ranges.filter(r => r.face === face);
            if (!steps && !faceRanges.length) continue;
            const ts = c.timestampWrites(`smc`) as GPURenderPassTimestampWrites | undefined;
            const pass = c.encoder.beginRenderPass({
              label: `smc:face-${face}`, colorAttachments: [{ view: faceViews[face], loadOp: 'load', storeOp: 'store' }],
              ...(ts ? { timestampWrites: ts } : {}),
            });
            pass.setBindGroup(0, groups[face]);
            if (steps && decayPipeline) { pass.setPipeline(decayPipeline); pass.draw(3); draws++; }
            if (instanceBuffer) pass.setVertexBuffer(0, instanceBuffer);
            for (const r of faceRanges) {
              const pipeline = r.kind === 'clear' ? clearPipeline : cache.get<GPURenderPipeline>(stampKey(r.kind));
              if (!pipeline) continue;
              pass.setPipeline(pipeline);
              pass.draw(6, r.count, 0, r.first);
              draws++;
            }
            pass.end();
          }
          s.telemetry.gauge('smcDraws', draws);
        },
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); facet = null; },
  };
}

/** Where on the cube a world point lands (face and texel), for tools and tests. */
export function smcTexel(p: readonly number[], size: number): { face: number; x: number; y: number } {
  const face = cubeFaceOf(p);
  const uv = cubeUv(p, face);
  return { face, x: Math.floor((uv[0] + 1) * 0.5 * size), y: Math.floor((uv[1] + 1) * 0.5 * size) };
}
