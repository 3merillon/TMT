// Ported from Pinionfall src/gpu/shadow-sun-hold.ts (MIT, same owner)
/**
 * Sun hold — the pure maths (no GPU, no pipeline state). Drop-in port; only the comments are trimmed to TMT's use.
 *
 * A shadow map can only be CACHED while its projection is held still. Holding it while the sun moves trades cost for
 * error: between two relocks a shadow edge lags the true sun by (held sun ^ true sun) × occluder→receiver ARM.
 *
 * 1. `sunHoldToleranceRad` sizes the hold so ONE relock moves a static edge by at most `stepTexels` of the map, for the
 *    longest arm the planet can produce (TMT: PlanetStatic, texel 49/2048 u, terrain relief ≈ 9 u).
 * 2. A mover drawn into a held projection would lag and then snap at each relock; `heldProjectionShear` is the affine map
 *    that slides a caster sideways by exactly (its arm) × (true sun − held sun), so its shadow lands where the TRUE sun
 *    puts it while the map and every receiver lookup stay on the one held matrix (TMT: PlanetDynamic casters).
 *
 * The shear assumes the receivers lie on a plane through `planePoint` perpendicular to the held sun; a receiver off that
 * plane by ds keeps an error of ds × angle, bounded by the same rule as (1).
 */

/** Column-major 4x4. */
export type Mat4Like = Float32Array | Float64Array | number[];
export type Vec3Like = ArrayLike<number>;

/**
 * Squared chord between two UNIT vectors: 2(1 − cos t) ≈ t². Deliberately not `dot >= cos(tol)`: at 0.03° 1 − cos is
 * about one f32 epsilon, while the difference of nearly equal components is exact (Sterbenz).
 */
export function chordSq(a: Vec3Like, b: Vec3Like): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export interface SunHoldInputs {
  /** Base tolerance (radians). ≤ 0 means a CONTINUOUS sun was asked for, and that wins: the result is 0. */
  baseRad: number;
  /** World size of one texel of this map. ≤ 0 (never fitted) ⇒ base. */
  texelM: number;
  /** |sun · local up|. Shadows lengthen as 1/sin(elevation), so the hold shrinks toward dawn and dusk. */
  sinElev: number;
  /** Tallest occluder above its receiver the planet can produce. */
  armHeightM: number;
  /** How many texels one relock may move a static edge. */
  stepTexels: number;
  /** Ceiling (radians): bounds how stale a held map can get. */
  maxRad: number;
}

/** Per-map sun-hold tolerance in radians. Never below the base, so the ladder can only LENGTHEN a hold. */
export function sunHoldToleranceRad(o: SunHoldInputs): number {
  if (!(o.baseRad > 0)) return 0;
  if (!(o.texelM > 0) || !(o.armHeightM > 0) || !(o.stepTexels > 0)) return o.baseRad;
  const s = Math.min(1, Math.max(0.05, Math.abs(o.sinElev)));
  const ladder = o.stepTexels * o.texelM * s / o.armHeightM;
  return Math.min(Math.max(o.maxRad, o.baseRad), Math.max(o.baseRad, ladder));
}

/**
 * Affine shear S such that (heldProjView × S) draws a caster where the TRUE sun would put its shadow on the receiver
 * plane. A caster P shadows Q = P + s·t under the true light direction t; along the held direction h the point that
 * shadows Q is P' = P + s·(t − h). With the receivers on the plane through C with normal h, s = ((C − P)·h)/(t·h), which
 * is linear in P: P' = (I − d hᵀ) P + (C·h) d with d = (t − h)/(t·h). Returns the identity when the directions coincide
 * or are implausibly far apart (a guard, not a mode).
 */
export function heldProjectionShear(out: Mat4Like, held: Vec3Like, tru: Vec3Like, planePoint: Vec3Like): Mat4Like {
  const hx = held[0], hy = held[1], hz = held[2];
  const tn = tru[0] * hx + tru[1] * hy + tru[2] * hz;
  for (let i = 0; i < 16; i++) out[i] = 0;
  out[0] = 1; out[5] = 1; out[10] = 1; out[15] = 1;
  if (!(tn > 0.5)) return out;
  const dx = (tru[0] - hx) / tn, dy = (tru[1] - hy) / tn, dz = (tru[2] - hz) / tn;
  if (dx === 0 && dy === 0 && dz === 0) return out;
  const k = planePoint[0] * hx + planePoint[1] * hy + planePoint[2] * hz;
  out[0] = 1 - dx * hx; out[1] = -dy * hx; out[2] = -dz * hx;
  out[4] = -dx * hy; out[5] = 1 - dy * hy; out[6] = -dz * hy;
  out[8] = -dx * hz; out[9] = -dy * hz; out[10] = 1 - dz * hz;
  out[12] = k * dx; out[13] = k * dy; out[14] = k * dz;
  return out;
}
