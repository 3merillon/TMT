/** Continuous camera clearance against triangle faces, edges and vertices. */
import type { V3 } from './contracts';

/** firstRoot()'s result (a typed slot: a double kept in a module variable is boxed on every write). */
const found = new Float64Array(1);
/** The first root t ≥ 0 of a·t² + 2b·t + c = 0 into found[0]; false when there is none. */
function firstRoot(a: number, b: number, c: number): boolean {
  if (a < 1e-16) return false;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return false;
  const t = (-b - Math.sqrt(discriminant)) / a;
  if (!(t >= 0)) return false;
  found[0] = t; return true;
}

/** Squared distance from point[0..2] to an indexed triangle. Three r180's closestPointToPoint and
 * distanceToSquared, operation for operation, including its degenerate-triangle behavior. */
export function pointTriangleDistanceSquared(point: ArrayLike<number>, p: ArrayLike<number>, ia: number, ib: number, ic: number): number {
  const ox = point[0], oy = point[1], oz = point[2];
  const ax = p[ia], ay = p[ia + 1], az = p[ia + 2], bx = p[ib], by = p[ib + 1], bz = p[ib + 2], cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  let qx: number, qy: number, qz: number;
  const apx = ox - ax, apy = oy - ay, apz = oz - az, d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = ox - bx, bpy = oy - by, bpz = oz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const vc = d1 * d4 - d3 * d2;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; }
    else {
      const cpx = ox - cx, cpy = oy - cy, cpz = oz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
      const vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
      if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
      else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; }
      else if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w; }
      else { const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom; qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w; }
    }
  }
  const ex = qx - ox, ey = qy - oy, ez = qz - oz;
  return ex * ex + ey * ey + ez * ez;
}

/** The first contact of a sphere swept along ray[0..2] + t·ray[3..5] (unit direction), t ≤ ray[6], radius ray[7], with
 * the triangle p[ia..ia+2], p[ib..], p[ic..], including an initial overlap: true with the distance in ray[8]. Scalar
 * form of the historical three r180 Triangle/Vector3 steps (closestPointToPoint, getNormal, containsPoint), operation
 * for operation, so every distance is bit-identical. */
export function sphereTriangle(ray: Float64Array, p: ArrayLike<number>, ia: number, ib: number, ic: number): boolean {
  const ox = ray[0], oy = ray[1], oz = ray[2], dx = ray[3], dy = ray[4], dz = ray[5], maximum = ray[6], radius = ray[7];
  const ax = p[ia], ay = p[ia + 1], az = p[ia + 2], bx = p[ib], by = p[ib + 1], bz = p[ib + 2], cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = ox - ax, apy = oy - ay, apz = oz - az;
  if (pointTriangleDistanceSquared(ray, p, ia, ib, ic) <= radius * radius) { ray[8] = 0; return true; }
  let best = maximum, hit = false;
  // getNormal: (c - b) × (a - b), scaled by 1 / sqrt(|n|²), or zero.
  const tx = cx - bx, ty = cy - by, tz = cz - bz, ux = ax - bx, uy = ay - by, uz = az - bz;
  let nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
  const squared = nx * nx + ny * ny + nz * nz;
  if (squared > 0) { const s = 1 / Math.sqrt(squared); nx *= s; ny *= s; nz *= s; } else { nx = 0; ny = 0; nz = 0; }
  const distance = apx * nx + apy * ny + apz * nz, rate = dx * nx + dy * ny + dz * nz;
  if (Math.abs(rate) > 1e-12) for (let side = -1; side <= 1; side += 2) {
    const t = (side * radius - distance) / rate;
    if (t < 0 || t > best) continue;
    const k = -side * radius, px = ox + dx * t + nx * k, py = oy + dy * t + ny * k, pz = oz + dz * t + nz * k;
    // containsPoint: barycentric (1 - u - v, v, u) of the contact point.
    const vx = px - ax, vy = py - ay, vz = pz - az;
    const dot00 = acx * acx + acy * acy + acz * acz, dot01 = acx * abx + acy * aby + acz * abz, dot02 = acx * vx + acy * vy + acz * vz;
    const dot11 = abx * abx + aby * aby + abz * abz, dot12 = abx * vx + aby * vy + abz * vz, denom = dot00 * dot11 - dot01 * dot01;
    if (denom === 0) continue;
    const inverse = 1 / denom, u = (dot11 * dot02 - dot01 * dot12) * inverse, v = (dot00 * dot12 - dot01 * dot02) * inverse, w = 1 - u - v;
    if (w >= 0 && v >= 0 && w + v <= 1 && t <= best) { best = t; hit = true; }
  }
  for (let i = 0; i < 3; i++) {
    const kx = i === 0 ? ax : i === 1 ? bx : cx, ky = i === 0 ? ay : i === 1 ? by : cy, kz = i === 0 ? az : i === 1 ? bz : cz;
    const jx = i === 0 ? bx : i === 1 ? cx : ax, jy = i === 0 ? by : i === 1 ? cy : ay, jz = i === 0 ? bz : i === 1 ? cz : az;
    const rx = ox - kx, ry = oy - ky, rz = oz - kz, reach = rx * rx + ry * ry + rz * rz - radius * radius;
    if (firstRoot(1, rx * dx + ry * dy + rz * dz, reach) && found[0] <= best) { best = found[0]; hit = true; }
    let gx = jx - kx, gy = jy - ky, gz = jz - kz;
    const length = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (length < 1e-12) continue;
    const scale = 1 / length; gx *= scale; gy *= scale; gz *= scale;
    const along = rx * gx + ry * gy + rz * gz, speed = dx * gx + dy * gy + dz * gz;
    const sx = rx + gx * -along, sy = ry + gy * -along, sz = rz + gz * -along, wx = dx + gx * -speed, wy = dy + gy * -speed, wz = dz + gz * -speed;
    if (firstRoot(wx * wx + wy * wy + wz * wz, sx * wx + sy * wy + sz * wz, sx * sx + sy * sy + sz * sz - radius * radius)
      && along + found[0] * speed >= 0 && along + found[0] * speed <= length && found[0] <= best) { best = found[0]; hit = true; }
  }
  if (!hit) return false;
  ray[8] = best; return true;
}

const corners = new Float64Array(9), sweep = new Float64Array(9);
/** Unit direction required. Returns first contact, including an initial overlap. */
export function sphereTriangleDistance(o: V3, d: V3, maximum: number, radius: number, a: V3, b: V3, c: V3): number | null {
  corners[0] = a[0]; corners[1] = a[1]; corners[2] = a[2]; corners[3] = b[0]; corners[4] = b[1]; corners[5] = b[2]; corners[6] = c[0]; corners[7] = c[1]; corners[8] = c[2];
  sweep[0] = o[0]; sweep[1] = o[1]; sweep[2] = o[2]; sweep[3] = d[0]; sweep[4] = d[1]; sweep[5] = d[2]; sweep[6] = maximum; sweep[7] = radius;
  return sphereTriangle(sweep, corners, 0, 3, 6) ? sweep[8] : null;
}
