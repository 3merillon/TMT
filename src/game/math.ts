import type { Q4, V3 } from './contracts';
import { quatOf } from './kit/geometry/math';
export { quatOf as rotationFromMatrix } from './kit/geometry/math';

/** Quaternion product in the historical r180 operation order. */
export function multiplyRotations(a: Q4, b: Q4): Q4 {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

/** Shortest-arc unit-vector transport, including r180's antiparallel choice and normalization order. */
export function rotationBetweenUnitVectors(from: V3, to: V3): Q4 {
  const fx = from[0], fy = from[1], fz = from[2], ux = to[0], uy = to[1], uz = to[2];
  let r = fx * ux + fy * uy + fz * uz + 1, x: number, y: number, z: number;
  if (r < 1e-8) { r = 0; if (Math.abs(fx) > Math.abs(fz)) { x = -fy; y = fx; z = 0; } else { x = 0; y = -fz; z = fy; } }
  else { x = fy * uz - fz * uy; y = fz * ux - fx * uz; z = fx * uy - fy * ux; }
  let l = Math.sqrt(x * x + y * y + z * z + r * r);
  if (l === 0) return [0, 0, 0, 1];
  l = 1 / l;
  return [x * l, y * l, z * l, r * l];
}

/** Column-major TRS composition; callers retain f64 until the render upload when later arithmetic depends on it. */
export function composeTransform(out: Float32Array | Float64Array, position: V3, rotation: Q4, scale: V3): void {
  const x = rotation[0], y = rotation[1], z = rotation[2], w = rotation[3], x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scale[0], sy = scale[1], sz = scale[2];
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
}

/** Signed-scale decomposition with the historical determinant sign and sqrt-of-squares lengths. */
export function decomposeTransform(m: ArrayLike<number>): { position: V3; rotation: Q4; scale: V3 } {
  let sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
  const sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]), sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
  const n11 = m[0], n12 = m[4], n13 = m[8], n14 = m[12], n21 = m[1], n22 = m[5], n23 = m[9], n24 = m[13];
  const n31 = m[2], n32 = m[6], n33 = m[10], n34 = m[14], n41 = m[3], n42 = m[7], n43 = m[11], n44 = m[15];
  const determinant = n41 * (n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34)
    + n42 * (n11 * n23 * n34 - n11 * n24 * n33 + n14 * n21 * n33 - n13 * n21 * n34 + n13 * n24 * n31 - n14 * n23 * n31)
    + n43 * (n11 * n24 * n32 - n11 * n22 * n34 - n14 * n21 * n32 + n12 * n21 * n34 + n14 * n22 * n31 - n12 * n24 * n31)
    + n44 * (-n13 * n22 * n31 - n11 * n23 * n32 + n11 * n22 * n33 + n13 * n21 * n32 - n12 * n21 * n33 + n12 * n23 * n31);
  if (determinant < 0) sx = -sx;
  const normalized = Array.from(m), invSX = 1 / sx, invSY = 1 / sy, invSZ = 1 / sz;
  normalized[0] *= invSX; normalized[1] *= invSX; normalized[2] *= invSX;
  normalized[4] *= invSY; normalized[5] *= invSY; normalized[6] *= invSY;
  normalized[8] *= invSZ; normalized[9] *= invSZ; normalized[10] *= invSZ;
  return { position: [m[12], m[13], m[14]], rotation: quatOf(normalized), scale: [sx, sy, sz] };
}

/** Historical homogeneous point application (including divide), before any f32 vertex storage. */
export function transformPoint(m: ArrayLike<number>, point: V3): V3 {
  const x = point[0], y = point[1], z = point[2], w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) * w, (m[1] * x + m[5] * y + m[9] * z + m[13]) * w, (m[2] * x + m[6] * y + m[10] * z + m[14]) * w];
}

/** Direction application and sqrt-of-squares normalization used by detached mesh normals. */
export function transformDirection(m: ArrayLike<number>, direction: V3): V3 {
  const x = direction[0], y = direction[1], z = direction[2];
  const a = m[0] * x + m[4] * y + m[8] * z, b = m[1] * x + m[5] * y + m[9] * z, c = m[2] * x + m[6] * y + m[10] * z;
  const inverse = 1 / (Math.sqrt(a * a + b * b + c * c) || 1);
  return [a * inverse, b * inverse, c * inverse];
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Math.hypot, never sqrt of squares: the two differ in the last bit and every stored result depends on this one.
export const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const normalize = (a: V3, fallback?: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (!(l > 1e-10)) return fallback === undefined ? [0, 1, 0] : [...fallback];
  const s = 1 / l;
  return [a[0] * s, a[1] * s, a[2] * s];
};
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const tangent = (v: V3, up: V3): V3 => { const d = v[0] * up[0] + v[1] * up[1] + v[2] * up[2]; return [v[0] - up[0] * d, v[1] - up[1] * d, v[2] - up[2] * d]; };
export const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Construction basis: the historical `right` property is local +X; with a
 * +Z-facing model in Three, the driver's screen-right direction is local -X. */
export function frame(up: V3, heading: number): { right: V3; up: V3; forward: V3 } {
  up = normalize(up);
  const reference: V3 = Math.abs(up[2]) < 0.96 ? [0, 0, 1] : [1, 0, 0];
  const base = normalize(tangent(reference, up));
  const right = normalize(cross(up, base));
  const forward = add(mul(base, Math.cos(heading)), mul(right, Math.sin(heading)));
  return { right: normalize(cross(up, forward)), up, forward };
}

/** three r180 Quaternion.setFromRotationMatrix(Matrix4.makeBasis(right, up, forward)), operation for operation. */
export function rotation(up: V3, heading: number): Q4 {
  const axes = frame(up, heading), r = axes.right, u = axes.up, f = axes.forward;
  const m11 = r[0], m12 = u[0], m13 = f[0], m21 = r[1], m22 = u[1], m23 = f[1], m31 = r[2], m32 = u[2], m33 = f[2], trace = m11 + m22 + m33;
  if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1.0); return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  if (m11 > m22 && m11 > m33) { const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33); return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  if (m22 > m33) { const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33); return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** three r180 Quaternion.slerp, operation for operation. */
export function interpolateRotation(from: Q4, to: Q4, fraction: number): Q4 {
  const x = from[0], y = from[1], z = from[2], w = from[3], t = fraction;
  if (t === 0) return [x, y, z, w];
  if (t === 1) return [to[0], to[1], to[2], to[3]];
  let cosHalfTheta = w * to[3] + x * to[0] + y * to[1] + z * to[2], bx = to[0], by = to[1], bz = to[2], bw = to[3];
  if (cosHalfTheta < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; cosHalfTheta = -cosHalfTheta; }
  if (cosHalfTheta >= 1.0) return [x, y, z, w];
  const sqrSinHalfTheta = 1.0 - cosHalfTheta * cosHalfTheta;
  if (sqrSinHalfTheta <= Number.EPSILON) {
    const s = 1 - t, rw = s * w + t * bw, rx = s * x + t * bx, ry = s * y + t * by, rz = s * z + t * bz;
    let l = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    if (l === 0) return [0, 0, 0, 1];
    l = 1 / l;
    return [rx * l, ry * l, rz * l, rw * l];
  }
  const sinHalfTheta = Math.sqrt(sqrSinHalfTheta), halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta, ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
  return [x * ratioA + bx * ratioB, y * ratioA + by * ratioB, z * ratioA + bz * ratioB, w * ratioA + bw * ratioB];
}

/** three r180 Vector3.applyQuaternion (q assumed unit), operation for operation. */
export function rotate(v: V3, q: Q4): V3 {
  const vx = v[0], vy = v[1], vz = v[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx];
}
/** rotate() of (vx, vy, vz) by (qx, qy, qz, qw) into out[o..o+2], without allocating. */
export function rotateInto(out: { [index: number]: number }, o: number, vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number): void {
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  out[o] = vx + qw * tx + qy * tz - qz * ty; out[o + 1] = vy + qw * ty + qz * tx - qx * tz; out[o + 2] = vz + qw * tz + qx * ty - qy * tx;
}

/** Keep an aimed world direction fixed to the planet while the physics chassis settles or tilts. The three r180
 * Vector3/Quaternion steps (normalize, applyQuaternion, setFromUnitVectors, invert), operation for operation. */
export function holdPlanetBearing(before: Pick<{ position: V3; rotation: Q4 }, 'position' | 'rotation'>,
  after: Pick<{ position: V3; rotation: Q4 }, 'position' | 'rotation'>, yaw: number): number {
  const a = before.position, b = after.position, la = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1, lb = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) || 1;
  const sa = 1 / la, sb = 1 / lb, fx = a[0] * sa, fy = a[1] * sa, fz = a[2] * sa, ux = b[0] * sb, uy = b[1] * sb, uz = b[2] * sb;
  let aim = rotate([Math.sin(yaw), 0, Math.cos(yaw)], before.rotation);
  let r = fx * ux + fy * uy + fz * uz + 1, x: number, y: number, z: number;
  if (r < 1e-8) { r = 0; if (Math.abs(fx) > Math.abs(fz)) { x = -fy; y = fx; z = 0; } else { x = 0; y = -fz; z = fy; } }
  else { x = fy * uz - fz * uy; y = fz * ux - fx * uz; z = fx * uy - fy * ux; }
  let l = Math.sqrt(x * x + y * y + z * z + r * r);
  if (l === 0) { x = 0; y = 0; z = 0; r = 1; } else { l = 1 / l; x = x * l; y = y * l; z = z * l; r = r * l; }
  aim = rotate(aim, [x, y, z, r]);
  const q = after.rotation;
  aim = rotate(aim, [q[0] * -1, q[1] * -1, q[2] * -1, q[3]]);
  return Math.atan2(aim[0], aim[2]);
}

/** First finite-segment intersection with a sphere, in distance units. */
export function segmentSphere(origin: V3, direction: V3, extent: number, center: V3, radius: number): number | null {
  const ox = origin[0] - center[0], oy = origin[1] - center[1], oz = origin[2] - center[2];
  const b = ox * direction[0] + oy * direction[1] + oz * direction[2];
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const at = -b - Math.sqrt(discriminant);
  return at >= 0 && at <= extent ? at : null;
}

export function segmentDistance(point: V3, a: V3, b: V3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy + (point[2] - a[2]) * dz) / Math.max(1e-10, dx * dx + dy * dy + dz * dz), 0, 1);
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t), point[2] - (a[2] + dz * t));
}
