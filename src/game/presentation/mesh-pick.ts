import type { V3 } from '../contracts';

export interface PickMesh { positions: Float32Array; indices: Uint32Array | Uint16Array }
export interface MeshPickWork { parts: number; bounds: number; triangles: number }
const bounds = new WeakMap<Float32Array, Float64Array>();

/** Shared immutable local bounds for surface picking and selected-body framing. */
export function meshBounds(mesh: Pick<PickMesh, 'positions'>): Float64Array {
  let box = bounds.get(mesh.positions);
  if (!box) {
    box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < mesh.positions.length; i++) {
      const axis = i % 3, value = mesh.positions[i]; box[axis] = Math.min(box[axis], value); box[axis + 3] = Math.max(box[axis + 3], value);
    }
    bounds.set(mesh.positions, box);
  }
  return box;
}

/** Cached local AABBs reject almost every part before triangles are visited. Rays retain their world-distance
 * parameter through the affine inverse, including nonuniformly scaled wheels and repeated tread instances. */
export function rayMeshDistance(mesh: PickMesh, model: ArrayLike<number>, eye: V3, ray: V3, limit: number, work?: MeshPickWork,
  hit?: { triangle: number; position: V3; normal: V3 }): number | null {
  if (work) work.parts++;
  const box = meshBounds(mesh);
  const a = model[0], b = model[4], c = model[8], d = model[1], e = model[5], f = model[9], g = model[2], h = model[6], i = model[10];
  const x0 = e * i - f * h, x1 = c * h - b * i, x2 = b * f - c * e;
  const y0 = f * g - d * i, y1 = a * i - c * g, y2 = c * d - a * f;
  const z0 = d * h - e * g, z1 = b * g - a * h, z2 = a * e - b * d;
  const determinant = a * x0 + b * y0 + c * z0;
  if (Math.abs(determinant) < 1e-12) return null;
  const inverse = 1 / determinant, ex = eye[0] - model[12], ey = eye[1] - model[13], ez = eye[2] - model[14];
  const ox = (x0 * ex + x1 * ey + x2 * ez) * inverse, oy = (y0 * ex + y1 * ey + y2 * ez) * inverse, oz = (z0 * ex + z1 * ey + z2 * ez) * inverse;
  const dx = (x0 * ray[0] + x1 * ray[1] + x2 * ray[2]) * inverse;
  const dy = (y0 * ray[0] + y1 * ray[1] + y2 * ray[2]) * inverse;
  const dz = (z0 * ray[0] + z1 * ray[1] + z2 * ray[2]) * inverse;
  let near = 0, far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const origin = axis === 0 ? ox : axis === 1 ? oy : oz, direction = axis === 0 ? dx : axis === 1 ? dy : dz;
    if (Math.abs(direction) < 1e-12) { if (origin < box[axis] - 1e-8 || origin > box[axis + 3] + 1e-8) return null; }
    else {
      const start = (box[axis] - origin) / direction, end = (box[axis + 3] - origin) / direction;
      near = Math.max(near, Math.min(start, end)); far = Math.min(far, Math.max(start, end));
      if (near > far + 1e-8) return null;
    }
  }
  if (work) work.bounds++;
  const vertices = mesh.positions, indices = mesh.indices;
  let nearest = limit, found = false;
  for (let t = 0; t < indices.length; t += 3) {
    if (work) work.triangles++;
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
    const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
    const abx = vertices[ib] - ax, aby = vertices[ib + 1] - ay, abz = vertices[ib + 2] - az;
    const acx = vertices[ic] - ax, acy = vertices[ic + 1] - ay, acz = vertices[ic + 2] - az;
    const px = dy * acz - dz * acy, py = dz * acx - dx * acz, pz = dx * acy - dy * acx;
    const det = abx * px + aby * py + abz * pz;
    if (Math.abs(det) < 1e-10) continue;
    const tx = ox - ax, ty = oy - ay, tz = oz - az, inv = 1 / det;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-8 || u > 1 + 1e-8) continue;
    const qx = ty * abz - tz * aby, qy = tz * abx - tx * abz, qz = tx * aby - ty * abx;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-8 || u + v > 1 + 1e-8) continue;
    const distance = (acx * qx + acy * qy + acz * qz) * inv;
    if (distance >= 0 && distance <= nearest) {
      nearest = distance; found = true;
      if (hit) {
        hit.triangle = t;
        hit.position = [ox + dx * distance, oy + dy * distance, oz + dz * distance];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx, l = Math.hypot(nx, ny, nz) || 1;
        const sign = nx * dx + ny * dy + nz * dz > 0 ? -1 : 1;
        hit.normal = [nx / l * sign, ny / l * sign, nz / l * sign];
      }
    }
  }
  return found ? nearest : null;
}
