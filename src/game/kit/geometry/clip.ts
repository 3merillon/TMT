/**
 * Convex polytope clipping (W1-KIT): a convex solid given by its faces, cut by half-spaces n·p ≤ d. Each face
 * is clipped (Sutherland–Hodgman) and the cut is closed with a cap polygon on the plane. The result stays
 * convex, so the pieces serve both as render geometry and as exact validation pieces (turret gun slots).
 */
import type { Vec3 } from './math';

export interface ClipFace { pts: Vec3[]; cap: boolean }

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Keep the part of a convex solid with n·p ≤ d. Returns null when nothing remains. */
export function clipSolid(faces: readonly ClipFace[], n: Readonly<Vec3>, d: number, eps = 1e-9): ClipFace[] | null {
  const out: ClipFace[] = [];
  const cut: Vec3[] = [];
  for (const face of faces) {
    const pts = face.pts, res: Vec3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const da = dot(n, a) - d, db = dot(n, b) - d;
      if (da <= eps) res.push(a);
      if ((da < -eps && db > eps) || (da > eps && db < -eps)) {
        const t = da / (da - db), p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        res.push(p); cut.push(p);
      } else if (Math.abs(da) <= eps) cut.push(a);
    }
    // Drop degenerate slivers.
    const clean = res.filter((p, i) => { const q = res[(i + 1) % res.length]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 1e-9; });
    if (clean.length >= 3) out.push({ pts: clean, cap: face.cap });
  }
  if (!out.length) return null;
  if (cut.length >= 3) {
    // Order the cap points around their centroid in the plane.
    const c: Vec3 = [0, 0, 0];
    for (const p of cut) { c[0] += p[0] / cut.length; c[1] += p[1] / cut.length; c[2] += p[2] / cut.length; }
    const u = Math.abs(n[0]) < 0.9 ? norm(cross(n, [1, 0, 0])) : norm(cross(n, [0, 1, 0])), v = cross(n, u);
    const ring = cut.map(p => ({ p, a: Math.atan2(dot(sub(p, c), v), dot(sub(p, c), u)) })).sort((x, y) => x.a - y.a);
    const uniq: Vec3[] = [];
    for (const { p } of ring) if (!uniq.length || Math.hypot(p[0] - uniq[uniq.length - 1][0], p[1] - uniq[uniq.length - 1][1], p[2] - uniq[uniq.length - 1][2]) > 1e-7) uniq.push(p);
    if (uniq.length >= 3 && Math.hypot(uniq[0][0] - uniq[uniq.length - 1][0], uniq[0][1] - uniq[uniq.length - 1][1], uniq[0][2] - uniq[uniq.length - 1][2]) <= 1e-7) uniq.pop();
    // Outward winding: counter-clockwise seen along +n (the removed side).
    if (uniq.length >= 3) out.push({ pts: uniq, cap: true });
  }
  return out;
}

const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Readonly<Vec3>): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
