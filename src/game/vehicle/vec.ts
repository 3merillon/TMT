/** Allocation-free vector helpers for the per-tick chassis model (W1-PHY). `Vec` is structurally a Rapier Vector, so
 * scratch objects pass straight into Rapier calls. Every function writes into an explicit output. */
export interface Vec { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export const vec = (x = 0, y = 0, z = 0): Vec => ({ x, y, z });
export function setVec(o: Vec, x: number, y: number, z: number): Vec { o.x = x; o.y = y; o.z = z; return o; }
export function copyVec(o: Vec, a: Vec): Vec { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: Vec): number => Math.hypot(a.x, a.y, a.z);
export function cross(o: Vec, a: Vec, b: Vec): Vec {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z; return o;
}
/** o = a + b·s */
export function addScaled(o: Vec, a: Vec, b: Vec, s: number): Vec { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; }
export function scale(o: Vec, a: Vec, s: number): Vec { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
/** o = a − n·(a·n): the part of a orthogonal to the unit vector n. */
export function tangentOf(o: Vec, a: Vec, n: Vec): Vec { const d = dot(a, n); o.x = a.x - n.x * d; o.y = a.y - n.y * d; o.z = a.z - n.z * d; return o; }
/** Normalise in place; returns the original length (a zero vector is left unchanged). */
export function normalize(o: Vec): number { const l = len(o); if (l > 1e-12) { o.x /= l; o.y /= l; o.z /= l; } return l; }
/** o = q · (x, y, z) */
export function rotateInto(o: Vec, q: Quat, x: number, y: number, z: number): Vec {
  const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z;
  o.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  o.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  o.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
  return o;
}
/** o = a · b (Hamilton product; apply b first). */
export function quatMul(o: Quat, a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  o.x = x; o.y = y; o.z = z; o.w = w; return o;
}
/** o = rotation of `angle` about the unit `axis`. */
export function quatAxisAngle(o: Quat, axis: Vec, angle: number): Quat {
  const s = Math.sin(angle / 2); o.x = axis.x * s; o.y = axis.y * s; o.z = axis.z * s; o.w = Math.cos(angle / 2); return o;
}
