/**
 * Kit v2 math (W1-KIT): column-major 4×4 affine matrices in Float64Array and small vector helpers.
 * Pure, allocation-light, no three. Tank-local frame: +Y up, +Z forward, +X driver-left.
 */
export type Vec3 = [number, number, number];
/** Column-major 4×4 matrix (three's `Matrix4.elements` layout). */
export type Mat4 = Float64Array;

export function mat4(): Mat4 { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function setIdentity(m: Mat4): Mat4 { m.fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function translate(x: number, y: number, z: number, out: Mat4 = new Float64Array(16)): Mat4 {
  setIdentity(out); out[12] = x; out[13] = y; out[14] = z; return out;
}
/** Rotation about +X by `a` (right-handed: +a turns +Y toward +Z). */
export function rotX(a: number, out: Mat4 = new Float64Array(16)): Mat4 {
  const c = Math.cos(a), s = Math.sin(a); setIdentity(out); out[5] = c; out[6] = s; out[9] = -s; out[10] = c; return out;
}
/** Rotation about +Y by `a` (+a turns +Z toward +X). */
export function rotY(a: number, out: Mat4 = new Float64Array(16)): Mat4 {
  const c = Math.cos(a), s = Math.sin(a); setIdentity(out); out[0] = c; out[2] = -s; out[8] = s; out[10] = c; return out;
}
/** Rotation about +Z by `a` (+a turns +X toward +Y). */
export function rotZ(a: number, out: Mat4 = new Float64Array(16)): Mat4 {
  const c = Math.cos(a), s = Math.sin(a); setIdentity(out); out[0] = c; out[1] = s; out[4] = -s; out[5] = c; return out;
}
/** Rotation by `a` about a unit axis. */
export function rotAxis(ax: number, ay: number, az: number, a: number, out: Mat4 = new Float64Array(16)): Mat4 {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  setIdentity(out);
  out[0] = t * ax * ax + c; out[1] = t * ax * ay + s * az; out[2] = t * ax * az - s * ay;
  out[4] = t * ax * ay - s * az; out[5] = t * ay * ay + c; out[6] = t * ay * az + s * ax;
  out[8] = t * ax * az + s * ay; out[9] = t * ay * az - s * ax; out[10] = t * az * az + c;
  return out;
}
export function scaleM(x: number, y: number, z: number, out: Mat4 = new Float64Array(16)): Mat4 {
  setIdentity(out); out[0] = x; out[5] = y; out[10] = z; return out;
}
/** out = a × b (b applied first). `out` may alias neither input. */
export function mul(a: Mat4, b: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}
/** Chain product m0 × m1 × … (the last is applied first). */
export function chain(...ms: Mat4[]): Mat4 {
  let acc: Mat4 = new Float64Array(ms[0]);
  for (let i = 1; i < ms.length; i++) acc = mul(acc, ms[i]);
  return acc;
}
/** Basis matrix: columns x, y, z and origin o. */
export function basis(x: Readonly<Vec3>, y: Readonly<Vec3>, z: Readonly<Vec3>, o: Readonly<Vec3>, out: Mat4 = new Float64Array(16)): Mat4 {
  out[0] = x[0]; out[1] = x[1]; out[2] = x[2]; out[3] = 0;
  out[4] = y[0]; out[5] = y[1]; out[6] = y[2]; out[7] = 0;
  out[8] = z[0]; out[9] = z[1]; out[10] = z[2]; out[11] = 0;
  out[12] = o[0]; out[13] = o[1]; out[14] = o[2]; out[15] = 1;
  return out;
}
/** A frame whose +Z points along `dir` (unit) at `o`; +Y is as close to `up` as possible. */
export function lookAlong(o: Readonly<Vec3>, dir: Readonly<Vec3>, up: Readonly<Vec3> = [0, 1, 0]): Mat4 {
  let x = cross(up, dir);
  if (len(x) < 1e-9) x = cross([1, 0, 0], dir);
  x = norm(x);
  const y = cross(dir, x);
  return basis(x, y, dir as Vec3, o);
}
export function applyPoint(m: Mat4, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
export function applyDir(m: Mat4, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}
/** Inverse of a rigid (rotation + translation) matrix. */
export function invertRigid(m: Mat4, out: Mat4 = new Float64Array(16)): Mat4 {
  const r00 = m[0], r01 = m[4], r02 = m[8], r10 = m[1], r11 = m[5], r12 = m[9], r20 = m[2], r21 = m[6], r22 = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  out[0] = r00; out[1] = r01; out[2] = r02; out[3] = 0;
  out[4] = r10; out[5] = r11; out[6] = r12; out[7] = 0;
  out[8] = r20; out[9] = r21; out[10] = r22; out[11] = 0;
  out[12] = -(r00 * tx + r10 * ty + r20 * tz);
  out[13] = -(r01 * tx + r11 * ty + r21 * tz);
  out[14] = -(r02 * tx + r12 * ty + r22 * tz);
  out[15] = 1;
  return out;
}
/** Quaternion [x, y, z, w] of the rotation part of a rigid matrix. */
export function quatOf(m: ArrayLike<number>): [number, number, number, number] {
  const m00 = m[0], m11 = m[5], m22 = m[10], trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m[6] - m[9]) * s, (m[8] - m[2]) * s, (m[1] - m[4]) * s, 0.25 / s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return [0.25 * s, (m[4] + m[1]) / s, (m[8] + m[2]) / s, (m[6] - m[9]) / s];
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return [(m[4] + m[1]) / s, 0.25 * s, (m[9] + m[6]) / s, (m[8] - m[2]) / s];
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return [(m[8] + m[2]) / s, (m[9] + m[6]) / s, 0.25 * s, (m[1] - m[4]) / s];
}
/** Rotation matrix from a quaternion [x, y, z, w] and a translation. */
export function fromQuat(q: readonly number[], t: readonly number[] = [0, 0, 0], out: Mat4 = new Float64Array(16)): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy + wz; out[2] = xz - wy; out[3] = 0;
  out[4] = xy - wz; out[5] = 1 - (xx + zz); out[6] = yz + wx; out[7] = 0;
  out[8] = xz + wy; out[9] = yz - wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

export const add = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Readonly<Vec3>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Readonly<Vec3>): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Readonly<Vec3>): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const DEG = Math.PI / 180;
