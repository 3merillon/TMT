/**
 * GJK distance between the convex hulls of two point sets (W1-KIT). Used as the fast path of the kit
 * validator and the pitch-limit solver: most piece pairs near each other are still separated, and GJK proves
 * it in a few support queries (the plane v·x = v·w gives a running lower bound), leaving SAT for real contacts.
 * Closest-point-on-simplex after Ericson, Real-Time Collision Detection §5.1.
 */

interface PtsLike { pts: Float64Array; box?: Float64Array }

function support(p: Float64Array, dx: number, dy: number, dz: number, out: Float64Array, o: number): void {
  let best = -Infinity, bi = 0;
  for (let i = 0; i < p.length; i += 3) { const d = p[i] * dx + p[i + 1] * dy + p[i + 2] * dz; if (d > best) { best = d; bi = i; } }
  out[o] = p[bi]; out[o + 1] = p[bi + 1]; out[o + 2] = p[bi + 2];
}

const FACES = [[0, 3, 6, 9], [0, 3, 9, 6], [0, 6, 9, 3], [3, 6, 9, 0]];
const SAVE = new Float64Array(12), BV = new Float64Array(3), BS = new Float64Array(12);
// Simplex storage: up to 4 Minkowski points (w = a − b).
const S = new Float64Array(12);
const W = new Float64Array(3), SA = new Float64Array(3), SB = new Float64Array(3);
const V = new Float64Array(3);

/** Closest point to the origin of the simplex S[0..n); reduces S to the supporting vertices. Returns the new n (0 = contains origin). */
function closest(n: number): number {
  if (n === 1) { V[0] = S[0]; V[1] = S[1]; V[2] = S[2]; return 1; }
  if (n === 2) {
    const ax = S[0], ay = S[1], az = S[2], bx = S[3], by = S[4], bz = S[5];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const t = -(ax * abx + ay * aby + az * abz) / (abx * abx + aby * aby + abz * abz || 1e-30);
    if (t <= 0) { V[0] = ax; V[1] = ay; V[2] = az; return 1; }
    if (t >= 1) { V[0] = bx; V[1] = by; V[2] = bz; S[0] = bx; S[1] = by; S[2] = bz; return 1; }
    V[0] = ax + abx * t; V[1] = ay + aby * t; V[2] = az + abz * t; return 2;
  }
  if (n === 3) return triangle(0, 3, 6, true);
  // Tetrahedron: test the origin against each face; keep the closest face region.
  let inside = true, bestD = Infinity, bestFace = -1;
  const save = SAVE; save.set(S);
  const bv = BV, bs = BS;
  let bn = 0;
  for (let f = 0; f < 4; f++) {
    const [ia, ib, ic, id] = FACES[f];
    // Outside test: origin and the fourth vertex on opposite sides of the face plane.
    const ax = save[ia], ay = save[ia + 1], az = save[ia + 2];
    const ux = save[ib] - ax, uy = save[ib + 1] - ay, uz = save[ib + 2] - az, wx = save[ic] - ax, wy = save[ic + 1] - ay, wz = save[ic + 2] - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const so = -(ax * nx + ay * ny + az * nz), sd = (save[id] - ax) * nx + (save[id + 1] - ay) * ny + (save[id + 2] - az) * nz;
    if (so * sd >= 0) continue; // origin on the inner side of this face
    inside = false;
    S.set(save.subarray(ia, ia + 3), 0); S.set(save.subarray(ib, ib + 3), 3); S.set(save.subarray(ic, ic + 3), 6);
    const m = triangle(0, 3, 6, false);
    const d = V[0] * V[0] + V[1] * V[1] + V[2] * V[2];
    if (d < bestD) { bestD = d; bestFace = f; bv.set(V); bs.set(S); bn = m; }
  }
  if (inside || bestFace < 0) return 0;
  V.set(bv); S.set(bs);
  return bn;
}

function set1(x: number, y: number, z: number): number { V[0] = x; V[1] = y; V[2] = z; S[0] = x; S[1] = y; S[2] = z; return 1; }
function set2(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number): number {
  V[0] = x0 + (x1 - x0) * t; V[1] = y0 + (y1 - y0) * t; V[2] = z0 + (z1 - z0) * t;
  S[0] = x0; S[1] = y0; S[2] = z0; S[3] = x1; S[4] = y1; S[5] = z1; return 2;
}

/** Closest point on triangle (S[a], S[b], S[c]) to the origin; compacts S. */
function triangle(ia: number, ib: number, ic: number, _top: boolean): number {
  const ax = S[ia], ay = S[ia + 1], az = S[ia + 2], bx = S[ib], by = S[ib + 1], bz = S[ib + 2], cx = S[ic], cy = S[ic + 1], cz = S[ic + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = -ax, apy = -ay, apz = -az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set1(ax, ay, az);
  const bpx = -bx, bpy = -by, bpz = -bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set1(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set2(ax, ay, az, bx, by, bz, d1 / (d1 - d3));
  const cpx = -cx, cpy = -cy, cpz = -cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set1(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set2(ax, ay, az, cx, cy, cz, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return set2(bx, by, bz, cx, cy, cz, (d4 - d3) / ((d4 - d3) + (d5 - d6)));
  const denom = 1 / (va + vb + vc || 1e-30), v = vb * denom, w = vc * denom;
  V[0] = ax + abx * v + acx * w; V[1] = ay + aby * v + acy * w; V[2] = az + abz * v + acz * w;
  S[0] = ax; S[1] = ay; S[2] = az; S[3] = bx; S[4] = by; S[5] = bz; S[6] = cx; S[7] = cy; S[8] = cz;
  return 3;
}

/**
 * Distance between the convex hulls of a.pts and b.pts, early-exiting with a value > `stopAbove` as soon as
 * the separation is proven to exceed it. Returns 0 for intersecting hulls.
 */
export function gjkDistance(a: PtsLike, b: PtsLike, stopAbove = Infinity): number {
  // A box-centre direction is stable across polygon tessellation and starts near
  // the separating axis for small gun parts against broad hull panels.
  const ab = a.box, bb = b.box;
  let dx = ab && bb ? ab[0] + ab[3] - bb[0] - bb[3] : a.pts[0] - b.pts[0];
  let dy = ab && bb ? ab[1] + ab[4] - bb[1] - bb[4] : a.pts[1] - b.pts[1];
  let dz = ab && bb ? ab[2] + ab[5] - bb[2] - bb[5] : a.pts[2] - b.pts[2];
  if (dx === 0 && dy === 0 && dz === 0) dx = 1;
  support(a.pts, -dx, -dy, -dz, SA, 0); support(b.pts, dx, dy, dz, SB, 0);
  S[0] = SA[0] - SB[0]; S[1] = SA[1] - SB[1]; S[2] = SA[2] - SB[2];
  let n = 1;
  V[0] = S[0]; V[1] = S[1]; V[2] = S[2];
  let prev = Infinity;
  for (let iter = 0; iter < 48; iter++) {
    const vv = V[0] * V[0] + V[1] * V[1] + V[2] * V[2];
    if (vv < 1e-20) return 0;
    support(a.pts, -V[0], -V[1], -V[2], SA, 0); support(b.pts, V[0], V[1], V[2], SB, 0);
    W[0] = SA[0] - SB[0]; W[1] = SA[1] - SB[1]; W[2] = SA[2] - SB[2];
    const vw = V[0] * W[0] + V[1] * W[1] + V[2] * W[2];
    const vlen = Math.sqrt(vv);
    // Lower bound on the distance from the supporting plane.
    if (vw / vlen > stopAbove) return vw / vlen;
    if (vv - vw <= 1e-12 * Math.max(1, vv) || vv >= prev - 1e-18) return vlen;
    prev = vv;
    S[n * 3] = W[0]; S[n * 3 + 1] = W[1]; S[n * 3 + 2] = W[2];
    n = closest(n + 1);
    if (n === 0) return 0;
  }
  return Math.sqrt(V[0] * V[0] + V[1] * V[1] + V[2] * V[2]);
}
