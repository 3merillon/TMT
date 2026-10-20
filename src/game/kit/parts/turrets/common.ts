/**
 * Shared turret pieces (W1-KIT): the bearing race on the ring plane, mantlets (solids of revolution about the
 * trunnion X axis, so no pitch can change the volume they occupy), a carved lathe for cast bodies that keeps
 * clear of the mantlet by a few millimetres, cupolas, periscope blocks and hatch lids.
 *
 * Turret frame: origin on the ring plane at the ring axis, +Y up, +Z forward. Cradle frame: origin at the
 * trunnion, +Z along the bore.
 */
import { clipSolid, type ClipFace } from '../../geometry/clip';
import { convexFromFaces } from '../../geometry/convex';
import { EDGE, alongX, bolts, box, cylinder, grabRail, lathe, mm, prism, ry, tr, type Profile, type Shape } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MeshBuilder } from '../../geometry/mesh';
import { MAT_ID } from '../../types';
import type { KitContext } from '../types';

/** Bearing race: a flat ring on the ring plane, 2 mm above the hull collar. */
export function bearingRace(s: Shape, ctx: KitContext): void {
  if (s.detail <= 0.3) return;
  s.tag = 'turret-ring';
  s.material(MAT_ID.darkSteel);
  const r = ctx.ringRadius + 0.025;
  lathe(s, null, [[r - 0.03, 0.002], [r, 0.002], [r, 0.02], [r - 0.008, 0.028], [r - 0.03, 0.028]], 24, { smooth: false, hullProfile: [[r, 0.002], [r, 0.02], [r - 0.008, 0.028]] });
}

/** Ball mantlet (cradle frame) with a collar where the sleeve leaves it. */
export function sphereMantlet(s: Shape, R: number): void {
  s.tag = 'mantlet';
  s.material(MAT_ID.paint);
  const n = s.segs(10, 5), profile: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const a = i / n * Math.PI; profile.push([Math.sin(a) * R, -Math.cos(a) * R]); }
  // Axis along cradle +Z so the collar reads as part of the ball; the ball is symmetric anyway.
  lathe(s, alongZ(), profile, 18, { hullProfile: profile });
}

/** Short journals bridge the spherical mantlet's working clearance to its
 * socket. A forward-set ball additionally needs cast bearing cheeks tied back
 * into the body; their inner faces remain outside the ball at every elevation. */
export function ballTrunnionSeats(s: Shape, ctx: KitContext, forwardCheeks = false): void {
  const [, y, z] = ctx.turret.trunnion, inner = ctx.mantletRadius + (forwardCheeks ? .009 : .007);
  s.tag = 'trunnion-housing'; s.material(MAT_ID.paint);
  for (const side of [-1, 1]) {
    if (forwardCheeks) {
      const x0 = side > 0 ? inner : -inner - .046, x1 = x0 + .046;
      const rear = z - ctx.mantletRadius - .035;
      prism(s, null, 'x', [[.10, rear], [.11, z - .04], [y - .035, z + .045], [y + .038, z + .04], [y + .05, z - .018], [y + .015, rear]], x0, x1);
    }
    if (!s.coarse) {
      s.material(MAT_ID.darkSteel);
      cylinder(s, null, [side * (ctx.mantletRadius + .003), y, z], [side * (inner + .004), y, z], .026, 8, { caps: [false, false] });
      s.material(MAT_ID.paint);
    }
  }
}

/** Drum mantlet (cradle frame): a cylinder along X with chamfered ends and a bolted face. */
export function drumMantlet(s: Shape, R: number, halfWidth: number): void {
  s.tag = 'mantlet';
  s.material(MAT_ID.paint);
  const c = 0.012;
  lathe(s, alongX(-halfWidth, 0, 0), [[R - c, 0], [R, c], [R, halfWidth * 2 - c], [R - c, halfWidth * 2]], 20, { hullProfile: [[R - c, 0], [R, c], [R, halfWidth * 2 - c], [R - c, halfWidth * 2]] });
  if (s.fine) {
    const pts: Vec3[] = [];
    for (let i = 0; i < 5; i++) { const x = -halfWidth * 0.8 + i * halfWidth * 0.4; pts.push([x, R * 0.55, R * 0.84], [x, -R * 0.55, R * 0.84]); }
    bolts(s, null, pts, [0, 0, 1], 0.007, 0.004);
  }
}

function alongZ(): Float64Array {
  const m = new Float64Array(16); m[0] = 1; m[6] = 1; m[9] = -1; m[15] = 1; return m;
}

/**
 * A cast lathe body about a vertical axis at (0, *, axisZ) with a gun slot cut in front: the solid minus
 * {|x| < halfWidth, z > back}. It decomposes exactly into three convex pieces (left and right cheeks, rear
 * body), used both for rendering (smooth lathe normals, flat slot walls) and as validation pieces, so the
 * mantlet and the tube's tail can move inside the slot without ever touching the casting.
 */
export function slottedLathe(s: Shape, axisZ: number, fullProfile: Profile, segments: number, slot: { halfWidth: number; back: number }, faceted = false): void {
  const profile = s.detail <= 0.3 ? fullProfile.filter((_, i) => i % 2 === 0 || i === fullProfile.length - 1) : fullProfile;
  const segs = s.segs(segments, faceted ? 8 : s.coarse ? 8 : 10), nP = profile.length;
  const rings: Vec3[][] = profile.map(([r, y]) => Array.from({ length: segs }, (_, i) => {
    const a = i / segs * Math.PI * 2;
    return [Math.sin(a) * r, y, axisZ + Math.cos(a) * r] as Vec3;
  }));
  const faces: ClipFace[] = [];
  for (let k = 0; k + 1 < nP; k++) for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs, a = rings[k][i], b = rings[k][j], c = rings[k + 1][j], d = rings[k + 1][i];
    const pts = profile[k + 1][0] < 1e-9 ? [a, b, c] : profile[k][0] < 1e-9 ? [a, c, d] : [a, b, c, d];
    faces.push({ pts, cap: false });
  }
  if (profile[0][0] > 1e-9) faces.push({ pts: [...rings[0]].reverse(), cap: true });
  if (profile[nP - 1][0] > 1e-9) faces.push({ pts: [...rings[nP - 1]], cap: true });
  const { halfWidth: w, back } = slot;
  const pieces = [
    clipSolid(faces, [1, 0, 0], -w),
    clipSolid(faces, [-1, 0, 0], -w),
    (() => { const a = clipSolid(faces, [1, 0, 0], w); const b = a && clipSolid(a, [-1, 0, 0], w); return b && clipSolid(b, [0, 0, 1], back); })(),
  ];
  // Smooth lathe normal at a surface point.
  const segN = profile.slice(0, -1).map((p, k) => { const q = profile[k + 1], dr = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dr, dy) || 1; return [dy / l, -dr / l] as [number, number]; });
  const vertexN = profile.map((_, k) => {
    const a = segN[Math.max(0, k - 1)], b = segN[Math.min(segN.length - 1, k)], x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
    return [x / l, y / l] as [number, number];
  });
  const normalAt = (p: Vec3): Vec3 => {
    const dx = p[0], dz = p[2] - axisZ, rho = Math.hypot(dx, dz);
    let k = 0;
    while (k < nP - 2 && p[1] > profile[k + 1][1]) k++;
    const t = Math.max(0, Math.min(1, (p[1] - profile[k][1]) / Math.max(1e-9, profile[k + 1][1] - profile[k][1])));
    const nr = vertexN[k][0] * (1 - t) + vertexN[k + 1][0] * t, ny = vertexN[k][1] * (1 - t) + vertexN[k + 1][1] * t;
    const ux = rho > 1e-9 ? dx / rho : 0, uz = rho > 1e-9 ? dz / rho : 0, l = Math.hypot(nr, ny) || 1;
    return [ux * nr / l, ny / l, uz * nr / l];
  };
  const mb = s.mb;
  for (const [pieceIndex, piece] of pieces.entries()) {
    if (!piece) continue;
    for (const face of piece) {
      if (face.cap) {
        let pts = face.pts;
        // The convex decomposition's x-plane walls are internal behind the slot.
        // Rendering both halves put invisible duplicate walls through the new hatch.
        if (pts.every(p => Math.abs(Math.abs(p[0]) - w) < 1e-8) && pts.every(p => Math.abs(p[0] - pts[0][0]) < 1e-8)) {
          if (pieceIndex === 2) continue;
          const clipped: Vec3[] = [];
          for (let j = 0; j < pts.length; j++) {
            const a = pts[j], b = pts[(j + 1) % pts.length], da = a[2] - back, db = b[2] - back;
            if (da >= -1e-9) clipped.push(a);
            if ((da < -1e-9 && db > 1e-9) || (da > 1e-9 && db < -1e-9)) { const t = da / (da - db); clipped.push(a.map((v, k) => v + (b[k] - v) * t) as Vec3); }
          }
          pts = clipped;
        }
        mb.poly(pts, EDGE.rim, capOutward(face.pts, piece)); continue;
      }
      if (faceted) {
        const center = face.pts.reduce((p, q) => p.map((v, i) => v + q[i] / face.pts.length) as Vec3, [0, 0, 0] as Vec3);
        mb.poly(face.pts, EDGE.chamfer, normalAt(center)); continue;
      }
      const base = mb.vertexCount;
      const save = mb.curAxis; mb.curAxis = [0, 1, 0];
      for (const p of face.pts) { const n = normalAt(p); mb.vertex(p[0], p[1], p[2], n[0], n[1], n[2], EDGE.none); }
      mb.curAxis = save;
      // Orient the fan so it faces along the analytic normal.
      const n0 = normalAt(face.pts[0]), e1 = sub3(face.pts[1], face.pts[0]), e2 = sub3(face.pts[2], face.pts[0]);
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const flip = fn[0] * n0[0] + fn[1] * n0[1] + fn[2] * n0[2] < 0;
      for (let i = 1; i + 1 < face.pts.length; i++) flip ? mb.tri(base, base + i + 1, base + i) : mb.tri(base, base + i, base + i + 1);
    }
    if (!s.noHull) s.hulls.push(convexFromFaces(s.tag, piece.map(f => f.pts), s.cosmetic));
  }
}

const sub3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Outward direction for a cap face of a convex piece: away from the piece's centroid. */
function capOutward(pts: readonly Vec3[], piece: readonly ClipFace[]): Vec3 {
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const f of piece) for (const p of f.pts) { cx += p[0]; cy += p[1]; cz += p[2]; n++; }
  let fx = 0, fy = 0, fz = 0;
  for (const p of pts) { fx += p[0] / pts.length; fy += p[1] / pts.length; fz += p[2] / pts.length; }
  return [fx - cx / n, fy - cy / n, fz - cz / n];
}

/** A commander cupola (lathe) with vision blocks. Returns the top height. */
export function cupola(s: Shape, x: number, z: number, y0: number, r: number, h: number, surface?: (x: number, z: number) => number): number {
  if (s.detail <= 0.3) return y0 + h;
  s.tag = 'cupola';
  s.material(MAT_ID.paint);
  // The machined cupola neck reaches the lowest host point around its rim;
  // portions inside a curved/faceted roof are buried instead of floating.
  const base = surface ? Math.min(y0, ...Array.from({ length: 20 }, (_, i) => surface(x + Math.sin(i * Math.PI / 10) * r, z + Math.cos(i * Math.PI / 10) * r))) - .003 : y0;
  lathe(s, tr(x, 0, z), [[r, base], [r, y0 + h - 0.012], [r - 0.008, y0 + h], [r * 0.66, y0 + h]], 20, { smooth: false, caps: [false, false] });
  s.material(MAT_ID.darkSteel);
  lathe(s, tr(x, 0, z), [[r * .66, y0 + h], [r * .66, y0 - .07], [0, y0 - .07]], 20, { smooth: false, caps: [false, false] });
  if (s.detail >= 0.5) {
    s.material(MAT_ID.glass);
    const n = s.fine ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) / n * Math.PI * 2 + Math.PI / 6;
      box(s, mm(tr(x + Math.sin(a) * (r + 0.003), y0 + h * 0.6, z + Math.cos(a) * (r + 0.003)), ry(a)), [0.026, 0.018, 0.009], 0);
    }
  }
  s.material(MAT_ID.paint);
  hatchSeat(s, x, z, y0 + h, r * .8, r * .66);
  return y0 + h;
}

/** Fixed seal, hinge bearings and dog-latch seats. The circular bore remains completely open. */
export function hatchSeat(s: Shape, x: number, z: number, y: number, lidRadius: number, boreRadius: number): void {
  if (s.coarse) return;
  s.material(MAT_ID.rubber);
  lathe(s, tr(x, y, z), [[lidRadius * .96, .0015], [boreRadius + .002, .0015]], 16, { caps: [false, false], hullProfile: null });
  if (!s.fine) return;
  s.material(MAT_ID.darkSteel);
  const hingeZ = z - lidRadius;
  for (const side of [-1, 1]) {
    box(s, tr(x + side * lidRadius * .64, y - .005, hingeZ + .002), [.016, .019, .029], 0);
    cylinder(s, null, [x + side * lidRadius * .64 - .006, y, hingeZ], [x + side * lidRadius * .64 + .006, y, hingeZ], .008, 8);
  }
  s.material(MAT_ID.brass);
  bolts(s, null, [[x - lidRadius * .65, y + .001, z + lidRadius * .67], [x + lidRadius * .65, y + .001, z + lidRadius * .67]], [0, 1, 0], .0045, .004);
  box(s, tr(x, y - .003, z + lidRadius * .98), [.024, .015, .012], 0);
}

/** Hatch lid in the hatch frame: hinge at the origin, the lid extends toward +z. */
export function hatchLid(s: Shape, r: number): void {
  s.tag = 'hatch';
  s.material(MAT_ID.paint);
  lathe(s, tr(0, 0, r), [[r * .96, .002], [r, .006], [r, .013], [r * .87, .020], [0, .022]], s.fine ? 16 : 12, { smooth: false });
  s.material(MAT_ID.darkSteel);
  cylinder(s, null, [-r * .82, 0, 0], [r * .82, 0, 0], .006, 10);
  if (s.fine) {
    for (const side of [-1, 1]) box(s, tr(side * r * .42, .007, .015), [.014, .012, .03], 0);
    const handle = r * .28;
    grabRail(s, [[-handle, .039, r], [handle, .039, r]], [[[-handle, .020, r], [-handle, .039, r]], [[handle, .020, r], [handle, .039, r]]], .004);
    s.material(MAT_ID.brass);
    cylinder(s, null, [0, .020, r * 1.68], [0, .028, r * 1.68], .007, 10);
    cylinder(s, null, [0, .030, r * 1.68], [r * .32, .030, r * 1.82], .004, 8);
    const points: Vec3[] = [];
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; points.push([Math.sin(a) * r * .76, .021, r + Math.cos(a) * r * .76]); }
    bolts(s, null, points, [0, 1, 0], .003, .002);
  }
}

/** Cut a polygonal vertical hatch opening through the existing roof triangles.
 * Interpolated normals/material attributes preserve the curved roof shading; the
 * inner well is supplied by cupola/hatchRing. Validation solids remain conservative.
 */
export function cutRoofOpening(s: Shape, x: number, z: number, radius: number, floor: number): void {
  if (s.coarse) return;
  const old = s.mb, result = new MeshBuilder(), sides = s.segs(18, 6);
  type Vertex = { p: Vec3; n: Vec3; axis: Vec3; edge: number; mat: number; flags: number };
  const vertex = (i: number): Vertex => ({ p: old.p.slice(i * 3, i * 3 + 3) as Vec3, n: old.n.slice(i * 3, i * 3 + 3) as Vec3, axis: old.axis.slice(i * 3, i * 3 + 3) as Vec3, edge: old.edge[i], mat: old.mat[i], flags: old.flags[i] });
  const blend = (a: Vertex, b: Vertex, t: number): Vertex => ({ ...a, p: a.p.map((v, i) => v + (b.p[i] - v) * t) as Vec3, n: a.n.map((v, i) => v + (b.n[i] - v) * t) as Vec3, edge: a.edge + (b.edge - a.edge) * t });
  const emit = (poly: Vertex[]) => {
    if (poly.length < 3) return;
    const start = result.vertexCount;
    for (const v of poly) { result.material(v.mat, v.flags); result.vertex(...v.p, ...v.n, v.edge, v.axis); }
    for (let i = 1; i + 1 < poly.length; i++) {
      // Clipping a roof through an existing gun-slot edge can leave coincident
      // float32 vertices. Do not emit zero-area triangles into the shadow mesh.
      const a = poly[0].p.map(Math.fround), b = poly[i].p.map(Math.fround), c = poly[i + 1].p.map(Math.fround);
      const u = b.map((v, k) => v - a[k]), v = c.map((q, k) => q - a[k]);
      if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) > 1e-12) result.tri(start, start + i, start + i + 1);
    }
  };
  const planes = Array.from({ length: sides }, (_, i) => {
    const a = (i + 0.5) / sides * Math.PI * 2, nx = Math.cos(a), nz = Math.sin(a);
    return (p: Vec3) => nx * (p[0] - x) + nz * (p[2] - z) - radius * Math.cos(Math.PI / sides);
  });
  planes.push(p => floor - p[1]);
  for (let j = 0; j < old.idx.length; j += 3) {
    let poly = [vertex(old.idx[j]), vertex(old.idx[j + 1]), vertex(old.idx[j + 2])];
    if (poly.every(v => v.p[1] < floor) || poly.every(v => v.p[0] < x - radius) || poly.every(v => v.p[0] > x + radius) || poly.every(v => v.p[2] < z - radius) || poly.every(v => v.p[2] > z + radius)) { emit(poly); continue; }
    for (const distance of planes) {
      const inside: Vertex[] = [], outside: Vertex[] = [];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length], da = distance(a.p), db = distance(b.p);
        (da <= 0 ? inside : outside).push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const v = blend(a, b, da / (da - db)); inside.push(v); outside.push(v); }
      }
      emit(outside); poly = inside;
      if (poly.length < 3) break;
    }
  }
  old.p = result.p; old.n = result.n; old.axis = result.axis; old.edge = result.edge; old.mat = result.mat; old.flags = result.flags; old.idx = result.idx;
}

/** Welded pad that joins the utility socket to its actual host roof. */
export function utilityPad(s: Shape, ctx: KitContext, surface: (x: number, z: number) => number): void {
  const [x, y, z] = ctx.turret.utility, r = 0.044;
  s.tag = 'utility-pad'; s.material(MAT_ID.paint);
  // Four corner heights follow a cast roof, while the top is machined level.
  const points = [[-r, -r], [r, -r], [r, r], [-r, r]];
  const top = points.map(([dx, dz]) => [x + dx, y, z + dz] as Vec3);
  const bottom = points.map(([dx, dz]) => [x + dx, Math.min(y - 0.005, surface(x + dx, z + dz)) - 0.002, z + dz] as Vec3);
  // Reuse the polygon primitive so every side is closed and correctly wound.
  for (let i = 0; i < 4; i++) s.mb.poly([bottom[i], bottom[(i + 1) % 4], top[(i + 1) % 4], top[i]], EDGE.chamfer, [points[i][0] + points[(i + 1) % 4][0], 0, points[i][1] + points[(i + 1) % 4][1]]);
  s.mb.poly(top, EDGE.rim, [0, 1, 0]); s.mb.poly(bottom, EDGE.none, [0, -1, 0]);
}

/** Small periscope blocks on a roof. */
export function periscopeBlocks(s: Shape, points: readonly Vec3[]): void {
  if (s.detail < 0.5) return;
  s.tag = 'vision';
  for (const p of points) {
    s.material(MAT_ID.darkSteel);
    box(s, tr(p[0], p[1] + 0.012, p[2]), [0.05, 0.024, 0.036], 0.004);
    s.material(MAT_ID.glass);
    box(s, tr(p[0], p[1] + 0.014, p[2] + 0.019), [0.04, 0.012, 0.004], 0);
  }
  s.material(MAT_ID.paint);
}
