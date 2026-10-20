/**
 * Convex pieces for kit interference validation (W1-KIT; a port of the scratch `interfere.ts` SAT).
 *
 * Every visual primitive also emits one or more convex pieces (the primitive itself when convex, or a
 * decomposition). A piece stores its unique vertices, unique face-normal directions and unique edge
 * directions, which is everything the separating-axis test needs for convex polytopes:
 * penetration depth = min over { face normals of A and B, edgeA × edgeB } of the projected overlap.
 * An axis whose overlap is ≤ the threshold proves the depth is ≤ the threshold (early out).
 */
import { gjkDistance } from './gjk';
import { applyDir, applyPoint, type Mat4, type Vec3 } from './math';

export interface Convex {
  /** Component tag (allowlists, diagnostics). */
  tag: string;
  pts: Float64Array;
  nrm: Float64Array;
  edg: Float64Array;
  /** AABB min xyz, max xyz. */
  box: Float64Array;
  /** Excluded from proxy containment (bolts, whips, decals). */
  cosmetic?: boolean;
}

const PARALLEL = 1 - 1e-7;

function pushUnique(list: number[], x: number, y: number, z: number): void {
  const l = Math.hypot(x, y, z);
  if (l < 1e-12) return;
  x /= l; y /= l; z /= l;
  for (let i = 0; i < list.length; i += 3) if (Math.abs(list[i] * x + list[i + 1] * y + list[i + 2] * z) > PARALLEL) return;
  list.push(x, y, z);
}

function aabb(pts: Float64Array, box: Float64Array = new Float64Array(6)): Float64Array {
  box[0] = box[1] = box[2] = Infinity; box[3] = box[4] = box[5] = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (z < box[2]) box[2] = z;
    if (x > box[3]) box[3] = x; if (y > box[4]) box[4] = y; if (z > box[5]) box[5] = z;
  }
  return box;
}

/** A convex piece from its polygonal faces (any winding). The faces must bound a convex solid. */
export function convexFromFaces(tag: string, faces: readonly (readonly Readonly<Vec3>[])[], cosmetic = false): Convex {
  const pts: number[] = [], nrm: number[] = [], edg: number[] = [];
  const keys = new Map<string, number>();
  for (const face of faces) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      pushUnique(edg, b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const key = `${Math.round(a[0] * 1e6)},${Math.round(a[1] * 1e6)},${Math.round(a[2] * 1e6)}`;
      if (!keys.has(key)) { keys.set(key, pts.length / 3); pts.push(a[0], a[1], a[2]); }
    }
    pushUnique(nrm, nx, ny, nz);
  }
  const p = Float64Array.from(pts);
  return { tag, pts: p, nrm: Float64Array.from(nrm), edg: Float64Array.from(edg), box: aabb(p), ...(cosmetic ? { cosmetic } : {}) };
}

/** Faces of a "loft": a stack of convex rings with equal vertex counts, plus both end caps. */
export function loftFaces(rings: readonly (readonly Readonly<Vec3>[])[]): Vec3[][] {
  const faces: Vec3[][] = [];
  const n = rings[0].length;
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = rings[r][i], b = rings[r][j], c = rings[r + 1][j], d = rings[r + 1][i];
      faces.push([a as Vec3, b as Vec3, c as Vec3, d as Vec3]);
    }
  }
  faces.push(rings[0].map(p => [...p] as Vec3));
  faces.push(rings[rings.length - 1].map(p => [...p] as Vec3));
  return faces;
}

/** A transformed copy of a piece (rigid transforms, or affine with the normals recomputed approximately). */
export function transformConvex(c: Convex, m: Mat4, tag = c.tag): Convex {
  const pts = new Float64Array(c.pts.length), nrm = new Float64Array(c.nrm.length), edg = new Float64Array(c.edg.length), v: Vec3 = [0, 0, 0];
  for (let i = 0; i < c.pts.length; i += 3) { applyPoint(m, c.pts[i], c.pts[i + 1], c.pts[i + 2], v); pts[i] = v[0]; pts[i + 1] = v[1]; pts[i + 2] = v[2]; }
  // Normals transform by the inverse transpose; for rigid or axis-scaled matrices the cofactor matrix is exact up to scale.
  const cof = cofactor(m);
  for (let i = 0; i < c.nrm.length; i += 3) {
    const x = c.nrm[i], y = c.nrm[i + 1], z = c.nrm[i + 2];
    const nx = cof[0] * x + cof[3] * y + cof[6] * z, ny = cof[1] * x + cof[4] * y + cof[7] * z, nz = cof[2] * x + cof[5] * y + cof[8] * z;
    const l = Math.hypot(nx, ny, nz) || 1; nrm[i] = nx / l; nrm[i + 1] = ny / l; nrm[i + 2] = nz / l;
  }
  for (let i = 0; i < c.edg.length; i += 3) {
    applyDir(m, c.edg[i], c.edg[i + 1], c.edg[i + 2], v);
    const l = Math.hypot(v[0], v[1], v[2]) || 1; edg[i] = v[0] / l; edg[i + 1] = v[1] / l; edg[i + 2] = v[2] / l;
  }
  return { tag, pts, nrm, edg, box: aabb(pts), ...(c.cosmetic ? { cosmetic: true } : {}) };
}

/** Cofactor (column-major 3×3) of the linear part of `m`. */
function cofactor(m: Mat4): Float64Array {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  // columns of M: c0=(a,b,c) c1=(d,e,f) c2=(g,h,i); cofactor columns = c1×c2, c2×c0, c0×c1
  return Float64Array.of(e * i - f * h, f * g - d * i, d * h - e * g, h * c - i * b, i * a - g * c, g * b - h * a, b * f - c * e, c * d - a * f, a * e - b * d);
}

/**
 * A reusable placed copy: `set(m)` rewrites the transformed buffers without allocating.
 */
export class Placed {
  readonly pts: Float64Array;
  readonly nrm: Float64Array;
  readonly edg: Float64Array;
  readonly box = new Float64Array(6);
  constructor(readonly src: Convex) {
    this.pts = new Float64Array(src.pts.length); this.nrm = new Float64Array(src.nrm.length); this.edg = new Float64Array(src.edg.length);
  }
  get tag(): string { return this.src.tag; }
  set(m: Mat4, directions = true): this {
    const s = this.src, p = this.pts;
    const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4], m5 = m[5], m6 = m[6], m8 = m[8], m9 = m[9], m10 = m[10], tx = m[12], ty = m[13], tz = m[14];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1], z = s.pts[i + 2];
      const px = m0 * x + m4 * y + m8 * z + tx, py = m1 * x + m5 * y + m9 * z + ty, pz = m2 * x + m6 * y + m10 * z + tz;
      p[i] = px; p[i + 1] = py; p[i + 2] = pz;
      if (px < x0) x0 = px; if (py < y0) y0 = py; if (pz < z0) z0 = pz; if (px > x1) x1 = px; if (py > y1) y1 = py; if (pz > z1) z1 = pz;
    }
    this.box[0] = x0; this.box[1] = y0; this.box[2] = z0; this.box[3] = x1; this.box[4] = y1; this.box[5] = z1;
    // GJK distance uses only vertices. Interval certificates do not need the
    // face/edge rotations that an exact SAT penetration query requires.
    if (!directions) return this;
    // Kit joints are rigid, so directions rotate with the matrix (no scaling in placed pieces).
    for (const [src, dst] of [[s.nrm, this.nrm], [s.edg, this.edg]] as const) {
      for (let i = 0; i < src.length; i += 3) {
        const x = src[i], y = src[i + 1], z = src[i + 2];
        dst[i] = m0 * x + m4 * y + m8 * z; dst[i + 1] = m1 * x + m5 * y + m9 * z; dst[i + 2] = m2 * x + m6 * y + m10 * z;
      }
    }
    return this;
  }
}

export interface ConvexLike { pts: Float64Array; nrm: Float64Array; edg: Float64Array; box: Float64Array }

function overlapOn(a: ConvexLike, b: ConvexLike, x: number, y: number, z: number): number {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  const pa = a.pts, pb = b.pts;
  for (let i = 0; i < pa.length; i += 3) { const d = pa[i] * x + pa[i + 1] * y + pa[i + 2] * z; if (d < a0) a0 = d; if (d > a1) a1 = d; }
  for (let i = 0; i < pb.length; i += 3) { const d = pb[i] * x + pb[i + 1] * y + pb[i + 2] * z; if (d < b0) b0 = d; if (d > b1) b1 = d; }
  return Math.min(a1 - b0, b1 - a0);
}

/** AABBs overlap by more than `margin` on every axis. */
export function boxesOverlap(a: Float64Array, b: Float64Array, margin = 0): boolean {
  return a[0] < b[3] - margin && b[0] < a[3] - margin && a[1] < b[4] - margin && b[1] < a[4] - margin && a[2] < b[5] - margin && b[2] < a[5] - margin;
}

/**
 * Penetration depth of two convex pieces, capped: returns a value ≤ `threshold` as soon as any axis
 * proves the depth is at most `threshold` (so separated pairs are cheap). Exact otherwise.
 */
export function penetration(a: ConvexLike, b: ConvexLike, threshold = 0): number {
  if (!boxesOverlap(a.box, b.box, threshold)) return threshold - 1e-9;
  // Fast path: GJK proves most near pairs separated by more than −threshold in a few support queries.
  const gap = Math.max(0, -threshold);
  const d = gjkDistance(a, b, gap + 1e-9);
  if (d > gap + 1e-9) return -d;
  let best = Infinity;
  for (const src of [a.nrm, b.nrm]) {
    for (let i = 0; i < src.length; i += 3) {
      const o = overlapOn(a, b, src[i], src[i + 1], src[i + 2]);
      if (o <= threshold) return o;
      if (o < best) best = o;
    }
  }
  const ea = a.edg, eb = b.edg;
  for (let i = 0; i < ea.length; i += 3) {
    const ax = ea[i], ay = ea[i + 1], az = ea[i + 2];
    for (let j = 0; j < eb.length; j += 3) {
      const bx = eb[j], by = eb[j + 1], bz = eb[j + 2];
      let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx;
      const l = Math.hypot(x, y, z);
      if (l < 1e-6) continue;
      x /= l; y /= l; z /= l;
      const o = overlapOn(a, b, x, y, z);
      if (o <= threshold) return o;
      if (o < best) best = o;
    }
  }
  return best;
}

/** Signed distance from a point to an oriented box (negative inside). */
export function boxDistance(p: Readonly<Vec3>, center: Readonly<Vec3>, half: Readonly<Vec3>, axes: readonly Readonly<Vec3>[]): number {
  const dx = p[0] - center[0], dy = p[1] - center[1], dz = p[2] - center[2];
  let outside = 0, inside = -Infinity;
  for (let k = 0; k < 3; k++) {
    const a = axes[k], d = Math.abs(dx * a[0] + dy * a[1] + dz * a[2]) - half[k];
    if (d > 0) outside += d * d;
    inside = Math.max(inside, d);
  }
  return outside > 0 ? Math.sqrt(outside) : inside;
}

/** Distance from a point to an AABB (0 inside). */
export function pointBoxDistance(x: number, y: number, z: number, b: Float64Array): number {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dy = Math.max(b[1] - y, 0, y - b[4]), dz = Math.max(b[2] - z, 0, z - b[5]);
  return Math.hypot(dx, dy, dz);
}

const SEGMENT_CUTS = new Float64Array(8);

/** Exact segment/AABB distance, rounded down slightly for conservative capsule rejection. */
export function segmentBoxDistance(a: ArrayLike<number>, b: ArrayLike<number>, box: Float64Array): number {
  const ax = a[0], ay = a[1], az = a[2], dx = b[0] - ax, dy = b[1] - ay, dz = b[2] - az;
  // Squared point/box distance is a convex quadratic between crossings of the
  // box's six face planes. Find those at most seven intervals, then solve their
  // derivative exactly instead of iterating a numerical distance search.
  const cuts = SEGMENT_CUTS;
  cuts[0] = 0; cuts[1] = 1;
  let count = 2;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-30) continue;
    for (let side = 0; side < 2; side++) {
      const t = (box[k + side * 3] - a[k]) / d;
      if (t <= 0 || t >= 1) continue;
      let at = count++;
      while (at > 0 && cuts[at - 1] > t) { cuts[at] = cuts[at - 1]; at--; }
      cuts[at] = t;
    }
  }
  let t = 0;
  for (let i = 1; i < count; i++) {
    const lo = cuts[i - 1], hi = cuts[i], mid = (lo + hi) / 2;
    let quadratic = 0, linear = 0;
    for (let k = 0; k < 3; k++) {
      const d = b[k] - a[k], p = a[k] + d * mid;
      const delta = p < box[k] ? a[k] - box[k] : p > box[k + 3] ? a[k] - box[k + 3] : 0;
      if (p < box[k] || p > box[k + 3]) { quadratic += d * d; linear += delta * d; }
    }
    if (quadratic === 0) { t = lo; break; }
    const root = -linear / quadratic;
    t = Math.max(lo, Math.min(hi, root));
    if (root <= hi) break;
  }
  const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
  const ex = Math.max(box[0] - x, 0, x - box[3]), ey = Math.max(box[1] - y, 0, y - box[4]), ez = Math.max(box[2] - z, 0, z - box[5]);
  return Math.max(0, Math.sqrt(ex * ex + ey * ey + ez * ez) - 1e-12 * (1 + Math.abs(ax) + Math.abs(ay) + Math.abs(az) + Math.abs(dx) + Math.abs(dy) + Math.abs(dz)));
}

/**
 * A capsule bound of a piece around a local axis (the cradle bore, +Z): the piece lies inside the cylinder of
 * radius `r` around z ∈ [z0, z1]. Cheap distance pre-tests for the rotating gun.
 */
export interface AxisBound { z0: number; z1: number; r: number }
export function axisBound(c: Convex): AxisBound {
  let r = 0;
  for (let i = 0; i < c.pts.length; i += 3) r = Math.max(r, Math.hypot(c.pts[i], c.pts[i + 1]));
  return { z0: c.box[2], z1: c.box[5], r };
}
