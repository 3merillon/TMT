/**
 * Listener-local spatialisation, correct on a sphere. Pure math (no WebAudio), pinned by tests/audio-panning.
 *
 * Pinionfall's spatial-audio.ts is NOT ported: its `screenAlignedPos` flattens the camera forward onto world XZ, which
 * is wrong on TMT's planet where "up" is the local radial. Instead:
 * - the listener sits at lerp(camera, focus, 0.65): the player's tank is loud and centred and a long camera boom does
 *   not push everything into the distance;
 * - its orientation is the camera basis (forward = target − camera, up = camera up orthogonalised);
 * - every source is transformed on the CPU into listener-local coordinates (x = right, y = up, z = −forward), and the
 *   synth applies gain, stereo pan and an air low-pass itself (no PannerNode, no AudioListener quirks);
 * - the planet occludes: a chord that dives under the surface is muffled, and its path length (for gain and the
 *   speed-of-sound delay) is the arc around the planet, not the straight line through the rock.
 */

export type Vec3 = [number, number, number];
type V = readonly [number, number, number];

/** Listener position = lerp(camera, focus, 0.65). */
export const LISTENER_FOCUS_BLEND = 0.65;
/** Inverse-distance model (u). */
export const REF_DISTANCE = 2;
export const MAX_DISTANCE = 40;
export const ROLLOFF = 1;

const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;

/** Inverse distance gain: ref / (ref + rolloff·(clamp(d, ref, max) − ref)); 1 inside ref, constant beyond max. */
export function distanceGain(d: number, ref = REF_DISTANCE, max = MAX_DISTANCE, rolloff = ROLLOFF): number {
  if (!Number.isFinite(d)) return 0;
  const c = clamp(d, ref, max);
  return ref / (ref + rolloff * (c - ref));
}
/** Air absorption: 18 kHz · e^(−d/25), clamped to [1.2 kHz, 18 kHz]. */
export function airLowpassHz(d: number): number {
  if (!Number.isFinite(d)) return 1200;
  return clamp(18000 * Math.exp(-Math.max(0, d) / 25), 1200, 18000);
}

export interface SpatialParams {
  /** Straight-line listener → source distance (u). */
  distance: number;
  /** Sound path length (u): the chord, or the arc around the planet when the chord is occluded. */
  path: number;
  /** Linear gain (distance × occlusion). */
  gain: number;
  /** Stereo pan in [-1, 1]. */
  pan: number;
  /** Low-pass cutoff (Hz): air absorption, occlusion muffle and a slight rear darkening. */
  lowpass: number;
  /** 0 = clear line of sight, 1 = deep behind the planet. */
  occlusion: number;
  /** Listener-local position: x right, y up, z backward (−forward). */
  local: Vec3;
}
export function spatialParams(): SpatialParams {
  return { distance: 0, path: 0, gain: 1, pan: 0, lowpass: 18000, occlusion: 0, local: [0, 0, 0] };
}

function normalize(v: Vec3): boolean {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-9) || !Number.isFinite(l)) return false;
  v[0] /= l; v[1] /= l; v[2] /= l;
  return true;
}
function cross(a: V, b: V, out: Vec3): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}
const finite3 = (v: V) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

export interface CameraLike { position: V; target: V; up: V }

export class Listener {
  readonly position: Vec3 = [0, 0, 0];
  readonly right: Vec3 = [1, 0, 0];
  readonly up: Vec3 = [0, 1, 0];
  readonly forward: Vec3 = [0, 0, -1];
  /** Smoothed listener velocity (u/s), for doppler. */
  readonly velocity: Vec3 = [0, 0, 0];
  /** Radius of the occluding planet near the focus (u); 0 disables occlusion. */
  planetRadius = 0;
  private readonly prev: Vec3 = [0, 0, 0];
  private hasPrev = false;
  private readonly scratch: Vec3 = [0, 0, 0];
  private readonly hint: Vec3 = [0, 0, 0];

  /** Places the listener for this frame. Invalid input keeps the previous pose (and returns false). */
  update(camera: CameraLike, focus: V, dt: number): boolean {
    if (!finite3(camera.position) || !finite3(camera.target) || !finite3(focus)) return false;
    const a = LISTENER_FOCUS_BLEND;
    const px = camera.position[0] + (focus[0] - camera.position[0]) * a;
    const py = camera.position[1] + (focus[1] - camera.position[1]) * a;
    const pz = camera.position[2] + (focus[2] - camera.position[2]) * a;
    const f = this.scratch;
    f[0] = camera.target[0] - camera.position[0]; f[1] = camera.target[1] - camera.position[1]; f[2] = camera.target[2] - camera.position[2];
    if (!normalize(f)) { f[0] = focus[0] - px; f[1] = focus[1] - py; f[2] = focus[2] - pz; if (!normalize(f)) return false; }
    // Up hint: the camera up, else the local radial (on a sphere, "up" is normalize(p)).
    const hint = this.hint, upOk = finite3(camera.up);
    hint[0] = upOk ? camera.up[0] : 0; hint[1] = upOk ? camera.up[1] : 0; hint[2] = upOk ? camera.up[2] : 0;
    const r = this.right;
    cross(f, hint, r);
    if (!normalize(r)) {
      hint[0] = px; hint[1] = py; hint[2] = pz;
      cross(f, hint, r);
      if (!normalize(r)) { hint[0] = Math.abs(f[1]) < 0.9 ? 0 : 1; hint[1] = Math.abs(f[1]) < 0.9 ? 1 : 0; hint[2] = 0; cross(f, hint, r); normalize(r); }
    }
    cross(r, f, this.up);
    this.forward[0] = f[0]; this.forward[1] = f[1]; this.forward[2] = f[2];
    // Velocity: exponential smoothing so camera jitter does not warble the doppler; camera cuts reset it.
    if (this.hasPrev && dt > 1e-4) {
      const vx = (px - this.prev[0]) / dt, vy = (py - this.prev[1]) / dt, vz = (pz - this.prev[2]) / dt;
      if (Math.hypot(vx, vy, vz) > 120) { this.velocity[0] = this.velocity[1] = this.velocity[2] = 0; }
      else {
        const k = 1 - Math.exp(-dt / 0.12);
        this.velocity[0] += (vx - this.velocity[0]) * k; this.velocity[1] += (vy - this.velocity[1]) * k; this.velocity[2] += (vz - this.velocity[2]) * k;
      }
    }
    this.position[0] = this.prev[0] = px; this.position[1] = this.prev[1] = py; this.position[2] = this.prev[2] = pz;
    this.hasPrev = true;
    const fr = Math.hypot(focus[0], focus[1], focus[2]);
    this.planetRadius = fr > 1 ? fr - 0.3 : 0;
    return true;
  }

  /** Forgets the previous position (a new match or a camera cut): the next update has zero velocity. */
  reset(): void { this.hasPrev = false; this.velocity[0] = this.velocity[1] = this.velocity[2] = 0; }

  /** Listener-local coordinates of a world point: x = right, y = up, z = −forward. */
  toLocal(p: V, out: Vec3 = [0, 0, 0]): Vec3 {
    const rx = p[0] - this.position[0], ry = p[1] - this.position[1], rz = p[2] - this.position[2];
    out[0] = rx * this.right[0] + ry * this.right[1] + rz * this.right[2];
    out[1] = rx * this.up[0] + ry * this.up[1] + rz * this.up[2];
    out[2] = -(rx * this.forward[0] + ry * this.forward[1] + rz * this.forward[2]);
    return out;
  }

  /** Gain, pan, low-pass and occlusion for a world point. Writes into `out` (no allocation). Non-finite input gives a
   * silent result (gain 0) rather than NaN reaching an AudioParam. */
  spatialize(p: V, out: SpatialParams): SpatialParams {
    if (!finite3(p)) { out.distance = out.path = Infinity; out.gain = 0; out.pan = 0; out.lowpass = 1200; out.occlusion = 1; return out; }
    const l = this.toLocal(p, out.local);
    const x = l[0], y = l[1], z = l[2];
    const d = Math.hypot(x, y, z);
    const occ = this.occlusion(p);
    out.distance = d;
    out.occlusion = occ;
    out.path = occ > 0 ? Math.max(d, this.arcLength(p)) : d;
    out.gain = distanceGain(out.path) * (1 - 0.6 * occ);
    // Softened by ref² so sources at or right above the listener never hard-pan; y (up/down) is included, so a source
    // straight below (the far side of the planet) stays centred instead of being panned as if it were in front.
    out.pan = clamp(x / Math.sqrt(x * x + y * y + z * z + REF_DISTANCE * REF_DISTANCE), -1, 1) * (1 - 0.5 * occ);
    const behind = d > 1e-6 ? clamp(z / d, 0, 1) : 0;
    out.lowpass = Math.max(350, airLowpassHz(out.path) * (1 - 0.8 * occ) * (1 - 0.3 * behind));
    return out;
  }

  /** How deep the listener → p chord dives under the planet surface, normalised to [0, 1] (3 u = fully occluded). */
  occlusion(p: V): number {
    const R0 = this.planetRadius;
    if (!(R0 > 0)) return 0;
    const L = this.position;
    const sx = p[0] - L[0], sy = p[1] - L[1], sz = p[2] - L[2];
    const len2 = sx * sx + sy * sy + sz * sz;
    if (!(len2 > 1e-9)) return 0;
    const t = clamp(-(L[0] * sx + L[1] * sy + L[2] * sz) / len2, 0, 1);
    const cx = L[0] + sx * t, cy = L[1] + sy * t, cz = L[2] + sz * t;
    const closest = Math.hypot(cx, cy, cz);
    // The occluder sits a little under the lower endpoint, so sources lying on the terrain are not self-occluded.
    const R = Math.min(R0, Math.hypot(L[0], L[1], L[2]), Math.hypot(p[0], p[1], p[2])) - 0.6;
    return clamp((R - closest) / 3, 0, 1);
  }

  /** Arc length around the planet between the listener and p (u), at their mean radius. */
  arcLength(p: V): number {
    const L = this.position;
    const rl = Math.hypot(L[0], L[1], L[2]), rp = Math.hypot(p[0], p[1], p[2]);
    if (!(rl > 1e-6) || !(rp > 1e-6)) return 0;
    const cos = clamp((L[0] * p[0] + L[1] * p[1] + L[2] * p[2]) / (rl * rp), -1, 1);
    return Math.acos(cos) * (rl + rp) * 0.5;
  }
}
