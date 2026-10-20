// Rewrite-inspired by Pinionfall src/gpu/shadow-pipeline.ts (MIT, same owner): only the texel-snap, lock/relock,
// radius-slew and bias RULES are taken (the 471 KB pipeline is not ported).
/**
 * Pure shadow-fitting maths for the three fixed-basis sun maps (plan §4.8). No GPU; unit-tested.
 *
 * - `lightBasis(sun)`: a light basis that depends ONLY on the sun direction (never on the camera), so a camera orbit
 *   cannot rotate the texel grid (the classic CSM shimmer).
 * - `orthoLightViewProj`: reversed-Z orthographic light view-projection (depth 1 on the sun side, 0 on the far side),
 *   centred on light-space (cx, cy); the depth range is always the planet slab ±25 around the centre.
 * - `HeroFit`: the Hero map. Radius clamp(0.45·distance + 2, 4, 14) quantised to 1.25× steps; growth is immediate,
 *   shrink is slewed one step at a time after a delay (Pinionfall csmRadiusSlew: never rescale every edge at once, never
 *   undersize). The centre is locked to the texel grid and relocks only when the focus drifts past the margin
 *   radius·(1 − 1/bufferZone), with the damped half shift round(dx / 2·texel)·texel (Pinionfall's legacy relock).
 *   Every shift is a whole number of texels, so a relock never moves an edge by a sub-texel amount.
 */
import type { QualityTier } from '../../contracts';

export type V3 = readonly [number, number, number] | readonly number[];

/** PlanetStatic/PlanetDynamic half-extent (the whole planet fits one map, plan §4.8). */
export const PLANET_SHADOW_HALF_EXTENT = 24.5;
/** Depth slab half-range around the planet centre (every up-sun occluder is inside it). */
export const SHADOW_DEPTH_HALF = 25;
/** Tallest occluder arm on the planet (terrain relief 14.04–22.96, plan atmo-post §2.1). */
export const SHADOW_ARM_HEIGHT = 9;

export interface ShadowTier { static: number; dynamic: number; hero: number; grid: number; contact: boolean }
/** Plan §4.17 (Low folds PlanetDynamic into Hero: dynamic 0). */
export const SHADOW_TIERS: Readonly<Record<QualityTier, ShadowTier>> = {
  low: { static: 1024, dynamic: 0, hero: 1024, grid: 2, contact: false },
  medium: { static: 2048, dynamic: 512, hero: 1024, grid: 3, contact: false },
  high: { static: 2048, dynamic: 1024, hero: 2048, grid: 4, contact: true },
  ultra: { static: 4096, dynamic: 1024, hero: 4096, grid: 4, contact: true },
};

export interface LightBasis { x: [number, number, number]; y: [number, number, number]; z: [number, number, number] }

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** z = toward the sun; x, y span the map plane. The reference axis switches away from world Y only near the poles. */
export function lightBasis(sun: V3): LightBasis {
  const z = normalize([sun[0], sun[1], sun[2]]);
  const ref = Math.abs(z[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const x = normalize([ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]]);
  const y: [number, number, number] = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { x, y, z };
}

export function toLight(b: LightBasis, p: V3): [number, number, number] { return [dot(b.x, p), dot(b.y, p), dot(b.z, p)]; }

/**
 * Column-major reversed-Z ortho light view-projection: ndc.x = (lx − cx)/half, ndc.y = (ly − cy)/half,
 * depth = (lz + depthHalf)/(2·depthHalf) ∈ [0, 1] (1 = sun side). World origin = planet centre.
 */
export function orthoLightViewProj(b: LightBasis, cx: number, cy: number, half: number, depthHalf = SHADOW_DEPTH_HALF, out: Float32Array | Float64Array = new Float32Array(16)): typeof out {
  const ih = 1 / half, iz = 1 / (2 * depthHalf);
  out[0] = b.x[0] * ih; out[4] = b.x[1] * ih; out[8] = b.x[2] * ih; out[12] = -cx * ih;
  out[1] = b.y[0] * ih; out[5] = b.y[1] * ih; out[9] = b.y[2] * ih; out[13] = -cy * ih;
  out[2] = b.z[0] * iz; out[6] = b.z[1] * iz; out[10] = b.z[2] * iz; out[14] = 0.5;
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}

/** clip = m · (p, 1) for a column-major matrix. */
export function transform(m: ArrayLike<number>, p: V3): [number, number, number, number] {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]];
}

/** a · b (column-major). */
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>, out: Float32Array | Float64Array = new Float32Array(16)): typeof out {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  }
  out.set(r);
  return out;
}

// ───────────────────────────── Hero ─────────────────────────────
export const HERO_MIN_RADIUS = 4;
export const HERO_MAX_RADIUS = 14;
export const HERO_STEP = 1.25;

/** clamp(0.45·distance + 2, 4, 14) (plan §4.8). */
export function heroTargetRadius(distance: number): number {
  return Math.min(HERO_MAX_RADIUS, Math.max(HERO_MIN_RADIUS, 0.45 * distance + 2));
}

/** The smallest ladder value 4·1.25^k ≥ r. */
export function quantizeHeroRadius(r: number): number {
  const k = Math.max(0, Math.ceil(Math.log(Math.max(r, HERO_MIN_RADIUS) / HERO_MIN_RADIUS) / Math.log(HERO_STEP) - 1e-9));
  return HERO_MIN_RADIUS * HERO_STEP ** k;
}

export interface HeroFitOptions { bufferZone?: number; shrinkDelay?: number }

export class HeroFit {
  /** Locked map half-extent (world units); 0 before the first update. */
  radius = 0;
  /** Locked centre in light space (a whole number of texels). */
  cx = NaN;
  cy = NaN;
  texel = 0;
  relocks = 0;
  resizes = 0;
  private shrinkFrames = 0;
  readonly bufferZone: number;
  readonly shrinkDelay: number;

  constructor(public size: number, o: HeroFitOptions = {}) {
    this.bufferZone = o.bufferZone ?? 1.25;
    this.shrinkDelay = o.shrinkDelay ?? 8;
  }

  get margin(): number { return this.radius * (1 - 1 / this.bufferZone); }

  reset(): void { this.radius = 0; this.cx = NaN; this.cy = NaN; this.shrinkFrames = 0; }

  /** Feed the focus in light space and the camera distance; returns true when the map moved or resized. */
  update(fx: number, fy: number, distance: number): boolean {
    const target = quantizeHeroRadius(heroTargetRadius(distance));
    let resized = false;
    if (this.radius <= 0 || target > this.radius * (1 + 1e-9)) {
      this.radius = target; resized = true; this.shrinkFrames = 0;
    } else if (target < this.radius * (1 - 1e-9)) {
      if (++this.shrinkFrames >= this.shrinkDelay) {
        this.radius = Math.max(target, this.radius / HERO_STEP); resized = true; this.shrinkFrames = 0;
      }
    } else this.shrinkFrames = 0;
    this.texel = (2 * this.radius) / this.size;
    const t = this.texel;
    if (resized || Number.isNaN(this.cx)) {
      this.cx = Math.round(fx / t) * t;
      this.cy = Math.round(fy / t) * t;
      if (resized) this.resizes++;
      this.relocks++;
      return true;
    }
    const dx = fx - this.cx, dy = fy - this.cy, m = this.margin;
    if (Math.abs(dx) <= m && Math.abs(dy) <= m) return false;
    // Damped half shift, whole texels (a near-still focus rounds to zero: no jitter).
    this.cx += Math.round(dx / (2 * t)) * t;
    this.cy += Math.round(dy / (2 * t)) * t;
    this.relocks++;
    return true;
  }
}

/** Light-space bounding-sphere vs square test (hero caster culling). */
export function sphereInSquare(b: LightBasis, center: V3, radius: number, cx: number, cy: number, half: number): boolean {
  return Math.abs(dot(b.x, center) - cx) <= half + radius && Math.abs(dot(b.y, center) - cy) <= half + radius;
}

/** Texel rect { x, y, w, h } of an AABB in a map (for the scissored static re-render), padded, clamped; null if empty. */
export function aabbTexelRect(viewProj: ArrayLike<number>, min: V3, max: V3, size: number, padTexels: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const c = transform(viewProj, p);
    const u = (c[0] * 0.5 + 0.5) * size, v = (0.5 - c[1] * 0.5) * size;
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  const ax = Math.max(0, Math.floor(x0 - padTexels)), ay = Math.max(0, Math.floor(y0 - padTexels));
  const bx = Math.min(size, Math.ceil(x1 + padTexels)), by = Math.min(size, Math.ceil(y1 + padTexels));
  if (bx <= ax || by <= ay) return null;
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

export function unionRect(a: { x: number; y: number; w: number; h: number } | null, b: { x: number; y: number; w: number; h: number } | null) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
