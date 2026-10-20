import type { Vec3 } from '../../core/types';
export const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const mean = (p: readonly Vec3[]): Vec3 => [0, 1, 2].map(a => p.reduce((s, v) => s + v[a], 0) / p.length) as Vec3;
export const area = (p: readonly Vec3[]) => {
  let result = 0;
  for (let i = 1; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1], o = p[0], ax = a[0] - o[0], ay = a[1] - o[1], az = a[2] - o[2], bx = b[0] - o[0], by = b[1] - o[1], bz = b[2] - o[2];
    result += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
  }
  return result;
};
export const faceKey = (ids: readonly number[]) => [...ids].sort((a, b) => a - b).join(',');
