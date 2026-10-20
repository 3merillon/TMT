/**
 * Kit v2 geometry primitives (W1-KIT, plan §5.3 / brief step 1). No three.
 *
 * Every primitive writes render triangles into a `Shape` output (a MeshBuilder plus attributes) and, unless
 * the output is cosmetic, the convex pieces the validator uses. Pieces are exact for convex primitives
 * (boxes, prisms, lofts, lathe runs with a concave radius profile, frusta) and a per-segment decomposition
 * otherwise (bent tubes, stepped tubes, lathes with a convex-kinked profile).
 *
 * Primitives: chamfered box, chamfered prism / extrusion, loft, lathe (with per-segment smooth or flat
 * shading), cylinder / stepped tube along any axis, swept bent tube with flange and bore, louvre grille,
 * instanced-look bolts (merged), helical spring, toothed gear, spoked road wheel.
 */
import { convexFromFaces, loftFaces, transformConvex, type Convex } from './convex';
import { MeshBuilder } from './mesh';
import { add, applyDir, applyPoint, cross, dot, len, lookAlong, mat4, norm, scale, sub, type Mat4, type Vec3 } from './math';

export const EDGE = Object.freeze({ none: 0, soft: 96, rim: 170, chamfer: 255 });

/** Output of primitives for one part / rigid group. */
export class Shape {
  readonly mb = new MeshBuilder();
  readonly hulls: Convex[] = [];
  /** Geometry detail (1 = LOD0; 0.5 = LOD1; 0.25 = LOD2): scales segment counts. */
  detail = 1;
  tag = 'part';
  /** Emit render triangles only (no validation pieces). */
  noHull = false;
  /** Mark emitted pieces cosmetic (excluded from proxy containment). */
  cosmetic = false;
  material(mat: number, flags = 0): this { this.mb.material(mat, flags); return this; }
  segs(n: number, min = 4): number { return Math.max(min, Math.round(n * this.detail)); }
  get fine(): boolean { return this.detail >= 0.99; }
  /** LOD2 (detail 0.25): silhouettes only, used only below 14 projected tank pixels in the game. */
  get coarse(): boolean { return this.detail <= 0.3; }
  addHull(faces: Vec3[][], m?: Mat4, tag = this.tag): void {
    if (this.noHull) return;
    const c = convexFromFaces(tag, faces, this.cosmetic);
    this.hulls.push(m ? transformConvex(c, m) : c);
  }
  /** Run `fn` with temporary tag / cosmetic / noHull settings. */
  with(opts: { tag?: string; cosmetic?: boolean; noHull?: boolean }, fn: () => void): void {
    const saved = { tag: this.tag, cosmetic: this.cosmetic, noHull: this.noHull };
    if (opts.tag !== undefined) this.tag = opts.tag;
    if (opts.cosmetic !== undefined) this.cosmetic = opts.cosmetic;
    if (opts.noHull !== undefined) this.noHull = opts.noHull;
    try { fn(); } finally { Object.assign(this, saved); }
  }
}

const I = mat4();
const tp = (m: Mat4, p: Readonly<Vec3>): Vec3 => applyPoint(m, p[0], p[1], p[2]);
const td = (m: Mat4, p: Readonly<Vec3>): Vec3 => norm(applyDir(m, p[0], p[1], p[2]));

// ---------------------------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------------------------

/** Signed area of a 2D polygon (positive = counter-clockwise). */
export function area2(poly: readonly (readonly [number, number])[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
/** Inset a convex 2D polygon by `d` (outward if negative). */
export function inset2(poly: readonly (readonly [number, number])[], d: number): [number, number][] {
  const ccw = area2(poly) > 0 ? 1 : -1, n = poly.length, out: [number, number][] = [];
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    // Inward normal of a CCW polygon is (-dy, dx).
    const nx = -dy / l * ccw, ny = dx / l * ccw;
    return { px: p[0] + nx * d, py: p[1] + ny * d, dx, dy };
  });
  for (let i = 0; i < n; i++) {
    const a = lines[(i + n - 1) % n], b = lines[i];
    const den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-12) { out.push([b.px, b.py]); continue; }
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
    out.push([a.px + a.dx * t, a.py + a.dy * t]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Boxes, prisms, lofts
// ---------------------------------------------------------------------------------------------

/** A chamfered box of `size` centred at the origin of `m` (bevel 0 = plain box). */
export function box(s: Shape, m: Mat4 | null, size: Readonly<Vec3>, bevel = 0): void {
  const M = m ?? I, h: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  const b = s.fine ? Math.min(bevel, h[0] * 0.45, h[1] * 0.45, h[2] * 0.45) : 0;
  const faces: Vec3[][] = [];
  const emit = (pts: Vec3[], outward: Vec3, edge: number) => {
    const w = pts.map(p => tp(M, p));
    s.mb.poly(w, edge, td(M, outward));
    faces.push(w);
  };
  if (b <= 1e-6) {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => { const p: Vec3 = [0, 0, 0]; p[axis] = h[axis] * sign; p[u] = h[u] * su; p[v] = h[v] * sv; return p; });
      const n: Vec3 = [0, 0, 0]; n[axis] = sign; emit(pts, n, EDGE.none);
    }
  } else {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => { const p: Vec3 = [0, 0, 0]; p[axis] = h[axis] * sign; p[u] = (h[u] - b) * su; p[v] = (h[v] - b) * sv; return p; });
      const n: Vec3 = [0, 0, 0]; n[axis] = sign; emit(pts, n, EDGE.none);
    }
    for (let along = 0; along < 3; along++) {
      const u = (along + 1) % 3, v = (along + 2) % 3;
      for (const su of [-1, 1]) for (const sv of [-1, 1]) {
        const pts = [[-1, 0], [1, 0], [1, 1], [-1, 1]].map(([sa, side]) => { const p: Vec3 = [0, 0, 0]; p[along] = (h[along] - b) * sa; p[u] = (h[u] - (side ? b : 0)) * su; p[v] = (h[v] - (side ? 0 : b)) * sv; return p; });
        const n: Vec3 = [0, 0, 0]; n[u] = su; n[v] = sv; emit(pts, n, EDGE.chamfer);
      }
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const signs = [sx, sy, sz];
      emit([0, 1, 2].map(axis => h.map((e, i) => (e - (axis === i ? 0 : b)) * signs[i]) as Vec3), [sx, sy, sz], EDGE.chamfer);
    }
  }
  s.addHull(faces);
}

/**
 * A loft through convex rings (equal vertex counts) with flat quads. `edges[r]` is the edge value of the
 * band between ring r and r+1 (chamfer bands 255); caps get `capEdge`.
 */
export function loft(s: Shape, m: Mat4 | null, rings: readonly (readonly Readonly<Vec3>[])[], opts: { edges?: readonly number[]; capEdge?: number; caps?: [boolean, boolean]; hull?: boolean } = {}): void {
  const M = m ?? I, w = rings.map(ring => ring.map(p => tp(M, p)));
  const n = w[0].length;
  // Centroid for outward orientation.
  let c: Vec3 = [0, 0, 0], count = 0;
  for (const ring of w) for (const p of ring) { c = add(c, p); count++; }
  c = scale(c, 1 / count);
  for (let r = 0; r + 1 < w.length; r++) {
    const edge = opts.edges?.[r] ?? EDGE.none;
    // Orient against this band's centre, not the entire loft. A thin bent fender
    // can put the global centre on the wrong side of one of its underside panels.
    let bandCenter: Vec3 = [0, 0, 0];
    for (const p of [...w[r], ...w[r + 1]]) bandCenter = add(bandCenter, p);
    bandCenter = scale(bandCenter, 1 / (n * 2));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, quad = [w[r][i], w[r][j], w[r + 1][j], w[r + 1][i]];
      const mid = scale(add(add(quad[0], quad[1]), add(quad[2], quad[3])), 0.25);
      s.mb.poly(quad, edge, sub(mid, bandCenter));
    }
  }
  const caps = opts.caps ?? [true, true];
  for (const [index, on] of [[0, caps[0]], [w.length - 1, caps[1]]] as const) {
    if (!on) continue;
    const ring = w[index];
    let mid: Vec3 = [0, 0, 0]; for (const p of ring) mid = add(mid, p); mid = scale(mid, 1 / ring.length);
    s.mb.poly(ring, opts.capEdge ?? EDGE.none, sub(mid, c));
  }
  if (opts.hull !== false) s.addHull(loftFaces(w));
}

/**
 * Chamfered extrusion of a convex 2D profile. `axis` picks the extrusion direction: the profile's two
 * coordinates map to the other two axes in cyclic order (x: (y, z); y: (z, x); z: (x, y)).
 */
export function prism(s: Shape, m: Mat4 | null, axis: 'x' | 'y' | 'z', profile: readonly (readonly [number, number])[], a0: number, a1: number, chamfer = 0): void {
  const place = (p: readonly [number, number], t: number): Vec3 => axis === 'x' ? [t, p[0], p[1]] : axis === 'y' ? [p[1], t, p[0]] : [p[0], p[1], t];
  const c = s.fine ? Math.min(chamfer, (a1 - a0) * 0.45) : 0;
  const rings = c > 1e-6
    ? [inset2(profile, c).map(p => place(p, a0)), profile.map(p => place(p, a0 + c)), profile.map(p => place(p, a1 - c)), inset2(profile, c).map(p => place(p, a1))]
    : [profile.map(p => place(p, a0)), profile.map(p => place(p, a1))];
  loft(s, m, rings, { edges: c > 1e-6 ? [EDGE.chamfer, EDGE.none, EDGE.chamfer] : [EDGE.none] });
}

// ---------------------------------------------------------------------------------------------
// Lathes and tubes (axis = local +Y)
// ---------------------------------------------------------------------------------------------

export type Profile = readonly (readonly [number, number])[];

export interface LatheOptions {
  /** Smooth normals around (true) or faceted sides (false). Default true. */
  smooth?: boolean;
  /** Caps at the first / last profile point when r > 0. Default true. */
  caps?: [boolean, boolean];
  /** Outer y-monotone profile for the validation pieces (default: the render profile when y-monotone). */
  hullProfile?: Profile | null;
  /** Rotate the seam by this angle (radians). */
  phase?: number;
  /** Edge value for sharp profile corners. */
  rimEdge?: number;
}

/** Split a y-monotone (increasing y) profile into runs whose solid is convex (r(y) concave). */
function convexRuns(profile: Profile): Profile[] {
  const runs: (readonly [number, number])[][] = [];
  let run: (readonly [number, number])[] = [profile[0]];
  for (let i = 1; i < profile.length; i++) {
    run.push(profile[i]);
    if (i + 1 < profile.length && run.length >= 2) {
      const a = profile[i - 1], b = profile[i], c = profile[i + 1];
      // slope dr/dy must be non-increasing for a concave radius function (convex solid).
      const s1 = (b[0] - a[0]) / Math.max(1e-9, b[1] - a[1]), s2 = (c[0] - b[0]) / Math.max(1e-9, c[1] - b[1]);
      if (s2 > s1 + 1e-6) { runs.push(run); run = [profile[i]]; }
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function ringPoints(r: number, y: number, segs: number, phase: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < segs; i++) { const a = phase + i / segs * Math.PI * 2; out.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
  return out;
}

/** Solid-of-revolution validation pieces for a y-monotone outer profile, in the lathe's local frame. */
export function latheHullFaces(profile: Profile, segs: number, phase = 0): Vec3[][][] {
  const pieces: Vec3[][][] = [];
  for (const run of convexRuns(profile)) {
    const rings = run.map(([r, y]) => (r < 1e-7 ? ringPoints(1e-5, y, segs, phase) : ringPoints(r, y, segs, phase)));
    pieces.push(loftFaces(rings));
  }
  return pieces;
}

/**
 * Lathe of a profile [(r, y)…] about local +Y. Each profile segment is one band; bands meeting at an angle
 * sharper than ~35° are shaded flat on each side (a crease) and get the rim edge value.
 */
export function lathe(s: Shape, m: Mat4 | null, profile: Profile, segments: number, opts: LatheOptions = {}): void {
  const M = m ?? I, segs = s.segs(segments, 6), smooth = opts.smooth ?? true, phase = opts.phase ?? 0;
  const axisW = td(M, [0, 1, 0]);
  const mb = s.mb;
  const saveAxis = mb.curAxis;
  mb.curAxis = axisW;
  const nP = profile.length;
  // Profile tangents per segment.
  const segDir = profile.slice(0, -1).map((p, i) => { const q = profile[i + 1]; const dr = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dr, dy) || 1; return [dr / l, dy / l] as const; });
  const crease = (i: number) => {
    if (i <= 0 || i >= nP - 1) return true;
    const a = segDir[i - 1], b = segDir[i];
    return a[0] * b[0] + a[1] * b[1] < Math.cos(35 * Math.PI / 180);
  };
  for (let k = 0; k < nP - 1; k++) {
    const [r0, y0] = profile[k], [r1, y1] = profile[k + 1];
    if (Math.abs(r0) < 1e-9 && Math.abs(r1) < 1e-9) continue;
    const [dr, dy] = segDir[k];
    // Outward normal of the profile segment in (r, y): (dy, -dr) when the profile runs bottom→top outside.
    const segN = [dy, -dr];
    const nAt = (i: number, other: number): [number, number] => {
      if (!smooth || crease(i)) return [segN[0], segN[1]];
      const d = segDir[other];
      const n2 = [d[1], -d[0]];
      const x = segN[0] + n2[0], y = segN[1] + n2[1], l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    const n0 = nAt(k, k - 1), n1 = nAt(k + 1, k + 1);
    const e0 = crease(k) ? (opts.rimEdge ?? EDGE.rim) : EDGE.none, e1 = crease(k + 1) ? (opts.rimEdge ?? EDGE.rim) : EDGE.none;
    if (smooth) {
      const base = mb.vertexCount;
      for (let i = 0; i <= segs; i++) {
        const a = phase + i / segs * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        for (const [r, y, n, e] of [[r0, y0, n0, e0], [r1, y1, n1, e1]] as const) {
          const p = tp(M, [c * r, y, sn * r]);
          const nn = td(M, [c * n[0], n[1], sn * n[0]]);
          mb.vertex(p[0], p[1], p[2], nn[0], nn[1], nn[2], e);
        }
      }
      for (let i = 0; i < segs; i++) {
        const a = base + i * 2, b = a + 2;
        // Winding: counter-clockwise seen from outside. A band ending on the axis is a fan: skip its
        // degenerate half.
        if (Math.abs(r1) >= 1e-9) mb.tri(a, a + 1, b + 1);
        if (Math.abs(r0) >= 1e-9) mb.tri(a, b + 1, b);
      }
    } else {
      // Faceted: one flat quad per facet.
      for (let i = 0; i < segs; i++) {
        const a0 = phase + i / segs * Math.PI * 2, a1 = phase + (i + 1) / segs * Math.PI * 2, am = (a0 + a1) / 2;
        const quad = [tp(M, [Math.cos(a0) * r0, y0, Math.sin(a0) * r0]), tp(M, [Math.cos(a0) * r1, y1, Math.sin(a0) * r1]),
          tp(M, [Math.cos(a1) * r1, y1, Math.sin(a1) * r1]), tp(M, [Math.cos(a1) * r0, y0, Math.sin(a1) * r0])];
        const nn = td(M, [Math.cos(am) * segN[0], segN[1], Math.sin(am) * segN[0]]);
        const q0 = mb.vertexCount;
        for (const q of quad) mb.vertex(q[0], q[1], q[2], nn[0], nn[1], nn[2], Math.max(e0, e1) ? EDGE.soft : EDGE.none);
        if (Math.abs(r1) >= 1e-9) mb.tri(q0, q0 + 1, q0 + 2);
        if (Math.abs(r0) >= 1e-9) mb.tri(q0, q0 + 2, q0 + 3);
      }
    }
  }
  const caps = opts.caps ?? [true, true];
  for (const [index, on, sign] of [[0, caps[0], -1], [nP - 1, caps[1], 1]] as const) {
    const [r, y] = profile[index];
    if (!on || r < 1e-7) continue;
    // Cap normal: along -Y at the start when the profile goes up, +Y at the end (or reversed for a descending profile).
    const dir = index === 0 ? -(Math.sign(segDir[0][1]) || 1) : Math.sign(segDir[nP - 2][1]) || 1;
    void sign;
    const ring = ringPoints(r, y, segs, phase).map(p => tp(M, p));
    mb.curAxis = axisW;
    const n = td(M, [0, dir, 0]);
    mb.poly(ring, opts.rimEdge ?? EDGE.rim, n);
  }
  mb.curAxis = saveAxis;
  // Validation pieces.
  const hullProfile = opts.hullProfile === undefined ? (profile.every((p, i) => i === 0 || p[1] >= profile[i - 1][1] - 1e-9) ? profile : null) : opts.hullProfile;
  if (hullProfile && !s.noHull) for (const faces of latheHullFaces(hullProfile, segs, phase)) s.addHull(faces, M);
}

/** Douglas–Peucker on a lathe profile: drop points within `tolerance` of the simplified outline (LOD2). */
export function simplifyProfile(profile: Profile, tolerance: number): Profile {
  if (profile.length <= 2) return profile;
  const keep = new Array<boolean>(profile.length).fill(false);
  keep[0] = keep[profile.length - 1] = true;
  const stack: [number, number][] = [[0, profile.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!, a = profile[i0], b = profile[i1];
    const dr = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dr, dy) || 1;
    let worst = -1, index = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs((profile[i][0] - a[0]) * dy - (profile[i][1] - a[1]) * dr) / l;
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > tolerance) { keep[index] = true; stack.push([i0, index], [index, i1]); }
  }
  return profile.filter((_, i) => keep[i]);
}

/** A frame whose local +Y runs from `a` to `b` (for lathes along arbitrary axes). */
export function axisFrame(a: Readonly<Vec3>, b: Readonly<Vec3>): { m: Mat4; length: number } {
  const d = sub(b, a), l = len(d), y = scale(d, 1 / l);
  let x = cross(y, [0, 0, 1]);
  if (len(x) < 1e-6) x = cross(y, [1, 0, 0]);
  x = norm(x);
  const z = cross(x, y);
  const m = new Float64Array(16);
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2]; m[4] = y[0]; m[5] = y[1]; m[6] = y[2]; m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
  m[12] = a[0]; m[13] = a[1]; m[14] = a[2]; m[15] = 1;
  return { m, length: l };
}

/** A cylinder (or stepped tube with `profile` radii along the axis) from `a` to `b` in `m`'s frame. */
export function cylinder(s: Shape, m: Mat4 | null, a: Readonly<Vec3>, b: Readonly<Vec3>, radius: number, segments: number, opts: LatheOptions = {}): void {
  const { m: f, length } = axisFrame(a, b);
  lathe(s, m ? mulM(m, f) : f, [[radius, 0], [radius, length]], segments, opts);
}
/** Stepped tube: `steps` = [(r, t)…] with t the distance along a→b. */
export function steppedTube(s: Shape, m: Mat4 | null, a: Readonly<Vec3>, b: Readonly<Vec3>, steps: Profile, segments: number, opts: LatheOptions = {}): void {
  const { m: f } = axisFrame(a, b);
  lathe(s, m ? mulM(m, f) : f, steps, segments, opts);
}

function mulM(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Swept bent tube (exhausts, rails, grab handles)
// ---------------------------------------------------------------------------------------------

/**
 * A tube swept along a polyline with parallel-transport frames. `bends` rounds each interior corner with an
 * arc of that radius. The start gets an optional flange (radius, thickness); the end an optional bore
 * (inner radius, depth) with a dark recessed floor (matId `boreMat`).
 */
export function sweep(s: Shape, m: Mat4 | null, path: readonly Readonly<Vec3>[], radius: number, segments: number,
  opts: { bend?: number; flange?: { radius: number; thickness: number }; bore?: { radius: number; depth: number; mat: number }; hullSegments?: number } = {}): void {
  const M = m ?? I, segs = s.segs(segments, 6);
  // Round the corners.
  const pts: Vec3[] = [];
  const bend = opts.bend ?? 0;
  pts.push([...path[0]] as Vec3);
  for (let i = 1; i < path.length - 1; i++) {
    const p = path[i], a = norm(sub(path[i - 1], p)), b = norm(sub(path[i + 1], p));
    const cosT = dot(a, b), theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
    if (bend <= 0 || theta > Math.PI - 1e-3) { pts.push([...p] as Vec3); continue; }
    const t = bend / Math.tan(theta / 2);
    const p0 = add(p, scale(a, t)), p1 = add(p, scale(b, t));
    const steps = Math.max(2, Math.round(s.segs(6, 2) * (Math.PI - theta) / (Math.PI / 2)));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      // Quadratic Bézier approximates the arc closely enough for pipes.
      const q = add(add(scale(p0, (1 - u) * (1 - u)), scale(p as Vec3, 2 * u * (1 - u))), scale(p1, u * u));
      pts.push(q);
    }
  }
  pts.push([...path[path.length - 1]] as Vec3);
  // Frames.
  const tangents = pts.map((p, i) => norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)])));
  let normal = cross(tangents[0], [0, 1, 0]);
  if (len(normal) < 1e-6) normal = cross(tangents[0], [1, 0, 0]);
  normal = norm(normal);
  const rings: Vec3[][] = [], ringN: Vec3[][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      // Parallel transport: remove the component along the new tangent.
      normal = norm(sub(normal, scale(tangents[i], dot(normal, tangents[i]))));
    }
    const binormal = cross(tangents[i], normal);
    const ring: Vec3[] = [], rn: Vec3[] = [];
    for (let k = 0; k < segs; k++) {
      const a = k / segs * Math.PI * 2, dir = add(scale(normal, Math.cos(a)), scale(binormal, Math.sin(a)));
      ring.push(add(pts[i], scale(dir, radius))); rn.push(dir);
    }
    rings.push(ring); ringN.push(rn);
  }
  const mb = s.mb, base = mb.vertexCount;
  for (let i = 0; i < rings.length; i++) for (let k = 0; k <= segs; k++) {
    const p = tp(M, rings[i][k % segs]), n = td(M, ringN[i][k % segs]);
    mb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], EDGE.none, td(M, tangents[i]));
  }
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < segs; k++) {
    const a = base + i * (segs + 1) + k, b = a + segs + 1;
    mb.tri(a, a + 1, b + 1); mb.tri(a, b + 1, b);
  }
  // Start: flange disc (or plain cap).
  const t0 = tangents[0], tN = tangents[tangents.length - 1];
  const f0 = lookAlong(pts[0], t0);
  if (opts.flange) {
    const { radius: fr, thickness } = opts.flange;
    lathe(s, mulM(M, mulM(f0, rotXY())), [[radius * 0.6, -thickness * 0.5], [fr, -thickness * 0.5], [fr, thickness * 0.5], [radius * 0.6, thickness * 0.5]], segments, { smooth: false, hullProfile: [[fr, -thickness * 0.5], [fr, thickness * 0.5]] });
  } else {
    mb.poly(rings[0].map(p => tp(M, p)), EDGE.rim, td(M, scale(t0, -1)));
  }
  // End: bore (rim ring + recessed dark floor) or cap.
  const endRing = rings[rings.length - 1];
  if (opts.bore) {
    const { radius: br, depth, mat } = opts.bore;
      // Preserve the transported radial frame. An independently constructed lookAlong frame can
      // rotate the inner polygon relative to the outer one, producing crossed cap quads and
      // the flickering triangular fragments visible on the upright exhaust outlet.
      const end = pts[pts.length - 1];
      const rimPts = endRing.map(p => add(end, scale(sub(p, end), br / radius)));
      const backPts = rimPts.map(p => sub(p, scale(tN, depth)));
    // Annular rim face.
    for (let k = 0; k < segs; k++) {
      const j = (k + 1) % segs;
      const outerA = endRing[k], outerB = endRing[j];
        const innerA = rimPts[k], innerB = rimPts[j];
      mb.poly([outerA, outerB, innerB, innerA].map(p => tp(M, p)), EDGE.rim, td(M, tN));
    }
    // Bore wall.
    const saveMat = mb.curMat; mb.curMat = mat;
    for (let k = 0; k < segs; k++) {
      const j = (k + 1) % segs;
        const a0 = rimPts[k], b0 = rimPts[j], a1 = backPts[k], b1 = backPts[j];
        const mid = sub(end, scale(tN, depth / 2));
      const center = scale(add(add(a0, b0), add(a1, b1)), 0.25);
      mb.poly([a0, b0, b1, a1].map(p => tp(M, p)), EDGE.none, td(M, sub(mid, center)));
    }
      mb.poly(backPts.map(p => tp(M, p)), EDGE.none, td(M, tN));
    mb.curMat = saveMat;
  } else {
    mb.poly(endRing.map(p => tp(M, p)), EDGE.rim, td(M, tN));
  }
  // Validation: convex hull of consecutive ring pairs (merged every `hullSegments` rings).
  if (!s.noHull) {
    const every = Math.max(1, opts.hullSegments ?? 1);
    for (let i = 0; i + 1 < rings.length; i += every) {
      const j = Math.min(rings.length - 1, i + every);
      const chunk = rings.slice(i, j + 1).map(ring => ring.map(p => tp(M, p)));
      s.addHull(loftFaces(chunk));
    }
  }
}
/** Rotation taking the lathe's +Y axis onto +Z (for lookAlong frames). */
function rotXY(): Mat4 {
  const m = mat4(); m[5] = 0; m[6] = 1; m[9] = -1; m[10] = 0; return m;
}

// ---------------------------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------------------------

/** A louvre grille: a frame of `size` (x width, z depth) with `count` slanted slats, top at y = 0 of `m`. */
export function louvres(s: Shape, m: Mat4 | null, size: [number, number], count: number, opts: { frame?: number; slat?: number; height?: number; mat?: number; slatMat?: number } = {}): void {
  const M = m ?? I, frame = opts.frame ?? 0.018, height = opts.height ?? 0.03, [w, d] = size;
  const saveMat = s.mb.curMat;
  // Validation: one box for the whole grille.
  if (s.detail > 0.3) s.with({ noHull: true }, () => {
    for (const x of [-1, 1]) box(s, mulM(M, tr(x * (w / 2 - frame / 2), -height / 2, 0)), [frame, height, d], 0);
    for (const z of [-1, 1]) box(s, mulM(M, tr(0, -height / 2, z * (d / 2 - frame / 2))), [w - frame * 2, height, frame], 0);
    if (opts.slatMat !== undefined) s.mb.curMat = opts.slatMat;
    const n = s.fine ? count : Math.max(2, Math.round(count / 2));
    const pitch = (d - frame * 2) / n, slat = opts.slat ?? pitch * 1.05;
    for (let i = 0; i < n; i++) {
      const z = -d / 2 + frame + pitch * (i + 0.5);
      const rot = mulM(tr(0, -height * 0.55, z), rx(-0.55));
      box(s, mulM(M, rot), [w - frame * 2, height * 0.22, slat], 0);
    }
    // Dark floor under the slats.
    s.mb.curMat = opts.mat ?? saveMat;
    box(s, mulM(M, tr(0, -height + 0.004, 0)), [w - frame * 2, 0.006, d - frame * 2], 0);
  });
  s.mb.curMat = saveMat;
  if (!s.noHull) {
    const tmp = new Shape(); tmp.tag = s.tag;
    box(tmp, mulM(M, tr(0, -height / 2, 0)), [w, height, d], 0);
    s.hulls.push(...tmp.hulls.map(h => ({ ...h, cosmetic: s.cosmetic || undefined }) as Convex));
  }
}

/** Bolt heads (hex) at `points` on a surface with normal `n` (all in `m`'s frame). Cosmetic. */
export function bolts(s: Shape, m: Mat4 | null, points: readonly Readonly<Vec3>[], n: Readonly<Vec3>, r = 0.009, h = 0.006): void {
  if (s.detail < 0.99) return;
  const M = m ?? I;
  s.with({ cosmetic: true, noHull: true }, () => {
    for (const p of points) {
      const { m: f } = axisFrame(p, add(p, scale(norm(n), h)));
      lathe(s, mulM(M, f), [[r, 0], [r * 0.8, h]], 5, { smooth: false, caps: [false, true], hullProfile: null });
    }
  });
}

/** A helical coil spring along local +Y from y = 0 to `height` (radius, wire radius, turns). */
export function spring(s: Shape, m: Mat4 | null, radius: number, wire: number, height: number, turns: number): void {
  const M = m ?? I, steps = Math.max(12, Math.round(turns * s.segs(8, 6)));
  const path: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, a = t * turns * Math.PI * 2;
    path.push([Math.cos(a) * radius, wire + t * (height - wire * 2), Math.sin(a) * radius]);
  }
  s.with({ noHull: true }, () => sweep(s, M, path, wire, 6));
  if (!s.noHull) {
    const tmp = new Shape(); tmp.tag = s.tag;
    lathe(tmp, M, [[radius + wire, 0], [radius + wire, height]], 12, {});
    s.hulls.push(...tmp.hulls);
  }
}

/** A grab rail with explicitly seated standoffs. All coordinates share the host frame. */
export function grabRail(s: Shape, path: readonly Vec3[], posts: readonly (readonly [Vec3, Vec3])[], radius = 0.006): void {
  sweep(s, null, path, radius, 8, { bend: radius * 2 });
  for (const [surface, rail] of posts) cylinder(s, null, surface, rail, radius * 0.9, 8);
}

export const tr = (x: number, y: number, z: number): Mat4 => { const m = mat4(); m[12] = x; m[13] = y; m[14] = z; return m; };
export const rx = (a: number): Mat4 => { const m = mat4(), c = Math.cos(a), sn = Math.sin(a); m[5] = c; m[6] = sn; m[9] = -sn; m[10] = c; return m; };
export const ry = (a: number): Mat4 => { const m = mat4(), c = Math.cos(a), sn = Math.sin(a); m[0] = c; m[2] = -sn; m[8] = sn; m[10] = c; return m; };
export const rz = (a: number): Mat4 => { const m = mat4(), c = Math.cos(a), sn = Math.sin(a); m[0] = c; m[1] = sn; m[4] = -sn; m[5] = c; return m; };
export const mm = (...ms: Mat4[]): Mat4 => ms.reduce((acc, x) => mulM(acc, x));
/** Lathe frame whose +Y axis is the local X axis (wheels, trunnions, rollers). */
export const alongX = (x: number, y: number, z: number): Mat4 => mm(tr(x, y, z), rz(-Math.PI / 2));
/** Lathe frame whose +Y axis is the local Z axis (barrels, pipes). */
export const alongZ = (x: number, y: number, z: number): Mat4 => mm(tr(x, y, z), rx(Math.PI / 2));

/**
 * A toothed gear (sprocket / idler) about local +Y: hub disc of `radius`, `teeth` trapezoid teeth to
 * `radius + toothHeight`, width `width` centred on y = 0.
 */
export function gear(s: Shape, m: Mat4 | null, radius: number, toothHeight: number, teeth: number, width: number, opts: { hubMat?: number; lightening?: number } = {}): void {
  const M = m ?? I, hw = width / 2;
  if (s.detail <= 0.3) {
    // LOD2: a hexagonal drum with the outboard (+y local) face only.
    lathe(s, M, [[radius + toothHeight, -hw], [radius + toothHeight, hw]], 6, { smooth: false, caps: [false, true], hullProfile: null });
  } else {
    // A toothed rim on each face with a recessed hub between them (the sprocket look).
    const disc = width * 0.34;
    lathe(s, M, [[radius * 0.3, -hw], [radius, -hw], [radius, -hw + disc], [radius * 0.55, -hw + disc], [radius * 0.55, hw - disc], [radius, hw - disc], [radius, hw], [radius * 0.3, hw]], 12, { smooth: false, hullProfile: null });
    const n = s.fine ? teeth : 0;
    for (const side of [-1, 1]) {
      const y0 = side < 0 ? -hw : hw - disc, y1 = y0 + disc;
      for (let i = 0; i < n; i++) {
        const a = (i + (side > 0 ? 0.5 : 0)) / n * Math.PI * 2;
        const r0 = radius - 0.004, r1 = radius + toothHeight, wBase = Math.PI * 2 * radius / n * 0.45, wTip = wBase * 0.5;
        const ring0 = [[-wBase / 2, y0, r0], [wBase / 2, y0, r0], [wTip / 2, y0, r1], [-wTip / 2, y0, r1]] as Vec3[];
        const ring1 = ring0.map(p => [p[0], y1, p[2]] as Vec3);
          // The first edge is the tooth root, embedded in the continuous rim. Emit the other three sides
          // and both exposed ends directly; a hidden root quad on every tooth wastes repeated triangles.
          const frame = mulM(M, ry(a)), center: Vec3 = [0, (y0 + y1) / 2, (r0 + r1) / 2];
          for (let edge = 1; edge < 4; edge++) {
            const next = (edge + 1) % 4, quad = [ring0[edge], ring0[next], ring1[next], ring1[edge]];
            const mid = scale(quad.reduce((sum, p) => add(sum, p), [0, 0, 0] as Vec3), .25);
            s.mb.poly(quad.map(p => tp(frame, p)), EDGE.rim, td(frame, sub(mid, center)));
          }
          s.mb.poly(ring0.map(p => tp(frame, p)), EDGE.chamfer, td(frame, [0, -1, 0]));
          s.mb.poly(ring1.map(p => tp(frame, p)), EDGE.chamfer, td(frame, [0, 1, 0]));
      }
    }
    if (s.fine) {
      const saveMat = s.mb.curMat;
      if (opts.hubMat !== undefined) s.mb.curMat = opts.hubMat;
      lathe(s, M, [[radius * 0.22, -hw - 0.008], [radius * 0.22, hw + 0.008]], 10, { hullProfile: null });
      s.mb.curMat = saveMat;
    }
  }
  if (!s.noHull) for (const faces of latheHullFaces([[radius + toothHeight, -hw], [radius + toothHeight, hw]], s.segs(16, 6))) s.addHull(faces, M);
}
