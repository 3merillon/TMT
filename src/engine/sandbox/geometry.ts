/** Sandbox geometry helpers (dev only): noise, icosphere planet, box, plate, planet-surface frames and model matrices. */
import type { MeshDesc, Vec3 } from '../contracts';

type V3 = [number, number, number];
export const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: readonly number[]): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Tangent frame at a planet-surface point: u = radial up, t/b tangents with t × u = b (right-handed). */
export function surfaceFrame(p: readonly number[]): { u: V3; t: V3; b: V3 } {
  const u = norm(p);
  const ref: V3 = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = norm(cross(ref, u));
  return { u, t, b: cross(t, u) };
}

/** Column-major model matrix: local x → t·sx, y → u·sy, z → b·sz, rotated by `yaw` around u, translated to p. */
export function surfaceModel(p: readonly number[], frameAt: readonly number[], yaw: number, size: readonly number[], out = new Float32Array(16)): Float32Array {
  const { u, t, b } = surfaceFrame(frameAt);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const x: V3 = [t[0] * c + b[0] * s, t[1] * c + b[1] * s, t[2] * c + b[2] * s];
  const z = cross(x, u);
  out.set([x[0] * size[0], x[1] * size[0], x[2] * size[0], 0, u[0] * size[1], u[1] * size[1], u[2] * size[1], 0,
    z[0] * size[2], z[1] * size[2], z[2] * size[2], 0, p[0], p[1], p[2], 1]);
  return out;
}

/** out = a · b (column-major 4×4). */
export function mul4(a: Float32Array, b: Float32Array, out = new Float32Array(16)): Float32Array {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
    r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
  }
  out.set(r);
  return out;
}

export function translation(x: number, y: number, z: number): Float32Array {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}
export function scaling(x: number, y: number, z: number): Float32Array {
  return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
}
export function rotationY(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

// ───────────────────────────── Noise ─────────────────────────────
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647 & 1274126177) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), sx), l(c(0, 1, 0), c(1, 1, 0), sx), sy), l(l(c(0, 0, 1), c(1, 0, 1), sx), l(c(0, 1, 1), c(1, 1, 1), sx), sy), sz) * 2 - 1;
}
/** Fractal noise in [-1, 1] on the unit sphere direction d. */
export function fbm(d: readonly number[], seed: number, octaves = 5, frequency = 1.6): number {
  let sum = 0, amp = 0.5, f = frequency, norm = 0;
  for (let o = 0; o < octaves; o++) { sum += amp * valueNoise(d[0] * f + 17.1 * o, d[1] * f - 9.3 * o, d[2] * f + 3.7 * o, seed + o); norm += amp; amp *= 0.5; f *= 2.03; }
  return sum / norm;
}

// ───────────────────────────── Meshes ─────────────────────────────
/** Icosphere directions (unit vectors) and triangle indices, CCW seen from outside. */
export function icosphere(subdivisions: number): { dirs: number[][]; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const dirs: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let i = cache.get(key);
      if (i === undefined) { i = dirs.length; dirs.push(norm([(dirs[a][0] + dirs[b][0]) / 2, (dirs[a][1] + dirs[b][1]) / 2, (dirs[a][2] + dirs[b][2]) / 2])); cache.set(key, i); }
      return i;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [faces[f], faces[f + 1], faces[f + 2]];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }
  return { dirs, indices: faces };
}

/** A displaced sphere with smooth vertex normals. */
export function planetMesh(subdivisions: number, radiusAt: (d: readonly number[]) => number): MeshDesc {
  const { dirs, indices } = icosphere(subdivisions);
  const positions = new Float32Array(dirs.length * 3);
  dirs.forEach((d, i) => { const r = radiusAt(d); positions.set([d[0] * r, d[1] * r, d[2] * r], i * 3); });
  const acc = new Float64Array(dirs.length * 3);
  for (let f = 0; f < indices.length; f += 3) {
    const [a, b, c] = [indices[f], indices[f + 1], indices[f + 2]];
    const pa = positions.subarray(a * 3, a * 3 + 3), pb = positions.subarray(b * 3, b * 3 + 3), pc = positions.subarray(c * 3, c * 3 + 3);
    const n = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
    for (const v of [a, b, c]) { acc[v * 3] += n[0]; acc[v * 3 + 1] += n[1]; acc[v * 3 + 2] += n[2]; }
  }
  const normals = new Float32Array(dirs.length * 3);
  for (let i = 0; i < dirs.length; i++) normals.set(norm([acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]]), i * 3);
  return { positions, normals, indices: new Uint32Array(indices), matId: 0, label: 'planet' };
}

/** Unit cube [-0.5, 0.5]³, flat normals, CCW outside; partLocal = position. */
export function boxMesh(matId: number, label = `box-${matId}`): MeshDesc {
  const faces: [V3, V3, V3][] = [ // normal, u axis, v axis (u × v = normal)
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  faces.forEach(([n, u, v], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(0.5 * (n[0] + a * u[0] + b * v[0]), 0.5 * (n[1] + a * u[1] + b * v[1]), 0.5 * (n[2] + a * u[2] + b * v[2]));
      normals.push(...n);
    }
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  const p = new Float32Array(positions);
  return { positions: p, normals: new Float32Array(normals), partLocal: p, indices: new Uint32Array(indices), matId, label };
}

/** Local up-facing square plate (y = 0), side 1, n = +y. */
export function plateMesh(matId: number, segments = 8): MeshDesc {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let j = 0; j <= segments; j++) for (let i = 0; i <= segments; i++) { positions.push(i / segments - 0.5, 0, j / segments - 0.5); normals.push(0, 1, 0); }
  for (let j = 0; j < segments; j++) for (let i = 0; i < segments; i++) {
    const a = j * (segments + 1) + i, b = a + 1, c = a + segments + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), matId, label: 'plate' };
}

export function add3(a: readonly number[], b: readonly number[]): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale3(a: readonly number[], s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
