// Ported from Pinionfall src/gpu/occlusion-culling-system.ts (MIT, same owner) — extractFrustumPlanes only
/**
 * CPU page culling (plan §4.7): sphere vs frustum, a horizon occluder sphere, then a front-to-back sort.
 *
 * Frustum planes come from the column-major (jitter-free) view-projection with WebGPU NDC z ∈ [0, 1]. With the engine's
 * reversed-Z INFINITE projection (clip.z = near, clip.w = −z_view) the extraction degenerates gracefully:
 *   - Pinionfall's "near" plane (row 2 = [0, 0, 0, near]) has a zero normal → normalised to (0, 0, 0, 0) → accepts all
 *     (it is the plane at infinity);
 *   - Pinionfall's "far" plane (row 3 − row 2) is the real near plane (depth ≤ 1).
 * So the same six-plane test is correct and conservative for reversed-Z.
 *
 * Horizon test: a caller-proven solid interior below `occluderRadius` hides a page whose bounding
 * sphere is (a) entirely inside the eye's tangent cone to the occluder and (b) entirely beyond the plane of the tangent
 * circle. Any point in that region lies behind the occluder's near surface, so the test never culls a visible page.
 */
export type Plane = [number, number, number, number];
export type Vec3 = [number, number, number];

/** Destructible terrain has no assumed solid interior. Opt in only with a proven inscribed, immutable sphere. */
export const HORIZON_OCCLUDER_RADIUS = 0;

/** Extract 6 frustum planes from a column-major proj·view matrix (WebGPU NDC z ∈ [0, 1]); plane·P ≥ 0 inside. */
export function extractFrustumPlanes(m: ArrayLike<number>): Plane[] {
  const row = (r: number): Plane => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a: Plane, b: Plane): Plane => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a: Plane, b: Plane): Plane => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  const planes = [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1), r2, sub(r3, r2)];
  return planes.map(p => {
    const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    const inv = len > 1e-6 ? 1 / len : 0;
    return [p[0] * inv, p[1] * inv, p[2] * inv, p[3] * inv] as Plane;
  });
}

/** True when the sphere intersects or lies inside every plane (conservative: never culls a visible sphere). */
export function sphereInFrustum(planes: readonly Plane[], c: readonly number[], r: number): boolean {
  for (const p of planes) if (p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) return false;
  return true;
}

/**
 * True when the sphere (c, r) is completely hidden behind an occluder sphere of radius `R` at the origin, seen from `eye`.
 * Conservative (false when unsure), exact for the cone ∩ beyond-tangent-plane region.
 */
export function sphereBehindHorizon(eye: readonly number[], c: readonly number[], r: number, R = HORIZON_OCCLUDER_RADIUS): boolean {
  if (!(R > 0) || !Number.isFinite(R)) return false;
  const D2 = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2];
  if (D2 <= R * R) return false;
  const D = Math.sqrt(D2);
  // Unit axis from the eye to the occluder centre.
  const wx = -eye[0] / D, wy = -eye[1] / D, wz = -eye[2] / D;
  const vx = c[0] - eye[0], vy = c[1] - eye[1], vz = c[2] - eye[2];
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (dist <= r) return false;
  const along = vx * wx + vy * wy + vz * wz;
  // (b) beyond the tangent-circle plane at distance (D² − R²)/D along the axis.
  if (along - r < (D2 - R * R) / D) return false;
  // (a) inside the tangent cone of half-angle α = asin(R/D), shrunk by the sphere's angular radius.
  const cosTheta = Math.min(1, Math.max(-1, along / dist));
  const theta = Math.acos(cosTheta);
  const alpha = Math.asin(Math.min(1, R / D));
  const spread = Math.asin(Math.min(1, r / dist));
  return theta + spread < alpha;
}

export interface CullItem { readonly center: readonly number[]; readonly radius: number }
export interface CullResult { visible: number[]; frustumCulled: number; horizonCulled: number }

export interface CullOptions { occluderRadius?: number; horizon?: boolean }

/**
 * Indices of the visible items, sorted front to back (by the nearest point of the bounding sphere to the eye).
 * `items[i]` may be null for free slots.
 */
export function cullAndSort(items: readonly (CullItem | null)[], viewProj: ArrayLike<number>, eye: readonly number[], options: CullOptions = {}): CullResult {
  const planes = extractFrustumPlanes(viewProj);
  const R = options.occluderRadius ?? HORIZON_OCCLUDER_RADIUS;
  const keys: number[] = [];
  const visible: number[] = [];
  let frustumCulled = 0, horizonCulled = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (!sphereInFrustum(planes, it.center, it.radius)) { frustumCulled++; continue; }
    if (options.horizon !== false && sphereBehindHorizon(eye, it.center, it.radius, R)) { horizonCulled++; continue; }
    visible.push(i);
    keys[i] = Math.hypot(it.center[0] - eye[0], it.center[1] - eye[1], it.center[2] - eye[2]) - it.radius;
  }
  visible.sort((a, b) => keys[a] - keys[b] || a - b);
  return { visible, frustumCulled, horizonCulled };
}

/** Bounding sphere of an axis-aligned box. */
export function boxSphere(min: readonly number[], max: readonly number[]): { center: Vec3; radius: number } {
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return { center, radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 };
}
