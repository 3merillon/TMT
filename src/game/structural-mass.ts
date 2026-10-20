import { rotationFromMatrix } from './math';
import type { Vec3 } from '../core/types';
import { cross, dot, mean, sub } from '../gpu/terrain/math';

/** Source-boundary mass integration in f64, before Rapier's nearly-coplanar
 * face merging. Tetrahedra from an interior point partition a convex region. */
export function convexMassProperties(vertices: Float32Array, indices: Uint32Array) {
  const points = Array.from({ length: vertices.length / 3 }, (_, i) => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]] as Vec3), origin = mean(points);
  const first = [0, 0, 0], second = Array.from({ length: 3 }, () => [0, 0, 0]); let mass = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const p = [indices[i], indices[i + 1], indices[i + 2]].map(id => sub(points[id], origin));
    const volume = dot(p[0], cross(p[1], p[2])) / 6;
    if (volume < -1e-12) throw new Error('Non-convex or inverted collider boundary');
    mass += volume;
    const sum = [0, 1, 2].map(a => p.reduce((v, x) => v + x[a], 0));
    for (let a = 0; a < 3; a++) {
      first[a] += volume * sum[a] / 4;
      for (let b = 0; b < 3; b++) second[a][b] += volume * (sum[a] * sum[b] + p.reduce((v, x) => v + x[a] * x[b], 0)) / 20;
    }
  }
  if (!(mass > 0)) throw new Error('Collider has no source volume');
  const center = first.map(v => v / mass), trace = second[0][0] + second[1][1] + second[2][2], distance = dot(center as Vec3, center as Vec3);
  const tensor = second.map((row, a) => row.map((v, b) => (a === b ? trace - mass * distance : 0) - v + mass * center[a] * center[b]));
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // Jacobi diagonalization of the symmetric inertia tensor, preserving a
  // right-handed orthonormal principal frame without a geometric approximation.
  for (let iteration = 0; iteration < 24; iteration++) {
    let p = 0, q = 1; for (const [a, b] of [[0, 2], [1, 2]]) if (Math.abs(tensor[a][b]) > Math.abs(tensor[p][q])) { p = a; q = b; }
    if (Math.abs(tensor[p][q]) < 1e-14 * Math.max(...tensor.map((row, i) => Math.abs(row[i])))) break;
    const angle = .5 * Math.atan2(2 * tensor[p][q], tensor[q][q] - tensor[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const a = tensor[p][p], b = tensor[q][q], v = tensor[p][q];
    tensor[p][p] = c * c * a - 2 * c * s * v + s * s * b; tensor[q][q] = s * s * a + 2 * c * s * v + c * c * b; tensor[p][q] = tensor[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) { const x = tensor[k][p], y = tensor[k][q]; tensor[k][p] = tensor[p][k] = c * x - s * y; tensor[k][q] = tensor[q][k] = s * x + c * y; }
      const x = axes[k][p], y = axes[k][q]; axes[k][p] = c * x - s * y; axes[k][q] = s * x + c * y;
    }
  }
  const q = rotationFromMatrix([axes[0][0], axes[1][0], axes[2][0], 0, axes[0][1], axes[1][1], axes[2][1], 0, axes[0][2], axes[1][2], axes[2][2], 0, 0, 0, 0, 1]);
  const inertia = tensor.map((row, i) => Math.max(0, row[i]));
  return { mass, centerOfMass: { x: center[0] + origin[0], y: center[1] + origin[1], z: center[2] + origin[2] },
    principalAngularInertia: { x: inertia[0], y: inertia[1], z: inertia[2] }, angularInertiaLocalFrame: { x: q[0], y: q[1], z: q[2], w: q[3] } };
}
