// Ported from Pinionfall src/gpu/grass-lattice.ts (MIT, same owner)
/**
 * Equi-angular cube-sphere mapping (plan §4.1 `src/world/cube-sphere.ts`): the ONE body-fixed parametrisation of planet
 * directions shared by the Surface Memory Cube (W1-ENG-SCENE), grass sites (W2-VEG) and the water grids (W2-WATER).
 * Pure, deterministic and Node-testable; the WGSL mirror (`CUBE_SPHERE_WGSL`, wrapped by
 * `src/engine/wgsl/common/cube-sphere.wgsl.ts`) is generated from the constants below (N3) and is a MATCHED PAIR with the
 * TypeScript functions: same face order, same warp, same hash. Change one, change both (tests/world-cube-sphere.test.ts).
 *
 * FACE CONVENTION (planet centre at the origin, directions are unit vectors):
 *
 *   face | owns the directions whose dominant axis is | (u, v) before the warp       | u axis | v axis
 *   -----+--------------------------------------------+------------------------------+--------+-------
 *    0   | +X                                         | (-z,  y) / x                 |  -Z    |  +Y
 *    1   | -X                                         | ( z,  y) / -x                |  +Z    |  +Y
 *    2   | +Y                                         | ( x, -z) / y                 |  +X    |  -Z
 *    3   | -Y                                         | ( x,  z) / -y                |  +X    |  +Z
 *    4   | +Z                                         | ( x,  y) / z                 |  +X    |  +Y
 *    5   | -Z                                         | (-x,  y) / -z                |  -X    |  +Y
 *
 * - Ownership ties (|x| = |y| = |z| edges and corners) resolve X before Y before Z, so every direction has exactly one face.
 * - Face coordinates (u, v) ∈ [-1, 1]² are EQUI-ANGULAR: uv = atan(gnomonic) / (π/4), so one unit of uv subtends a constant
 *   angle (areal density varies < 20 % across a face instead of the raw cube's 1.73× stretch).
 * - Texture convention (SMC and every per-face texture): layer = face, texel x = (u + 1) / 2 · size,
 *   texel y = (v + 1) / 2 · size (row 0 at v = -1). A render pass that rasterises into a face therefore uses
 *   NDC (x, y) = (u, -v); sampling uses uv01 = ((u + 1) / 2, (v + 1) / 2).
 * - Seams: neighbouring faces meet at u or v = ±1; a footprint near an edge must be written into every face whose
 *   hemisphere contains it (see `facesTouching`).
 */

export type V3 = [number, number, number];

/** Radians of arc per unit of face coordinate (a face spans [-1, 1] = 90°). */
export const CUBE_FACE_ARC = Math.PI / 4;
export const CUBE_FACES = 6;
/** Face axes: the outward normal of each face, in face order. */
export const CUBE_FACE_AXES: readonly V3[] = Object.freeze([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as V3[]);

const u32 = (x: number): number => x >>> 0;

/** The face that owns direction `d` (its dominant axis; ties X before Y before Z). */
export function cubeFaceOf(d: readonly number[]): number {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  if (ax >= ay && ax >= az) return d[0] > 0 ? 0 : 1;
  if (ay >= az) return d[1] > 0 ? 2 : 3;
  return d[2] > 0 ? 4 : 5;
}

/** Gnomonic (un-warped) face coordinates of `d` on `face`; only meaningful where dot(d, faceAxis) > 0. */
export function cubeGnomonic(d: readonly number[], face: number): [number, number] {
  switch (face) {
    case 0: return [-d[2] / d[0], d[1] / d[0]];
    case 1: return [d[2] / -d[0], d[1] / -d[0]];
    case 2: return [d[0] / d[1], -d[2] / d[1]];
    case 3: return [d[0] / -d[1], d[2] / -d[1]];
    case 4: return [d[0] / d[2], d[1] / d[2]];
    default: return [-d[0] / -d[2], d[1] / -d[2]];
  }
}

/** Equi-angular face coordinates in [-1, 1]² (for the owning face; outside the square for a neighbouring face). */
export function cubeUv(d: readonly number[], face: number): [number, number] {
  const [gu, gv] = cubeGnomonic(d, face);
  return [Math.atan(gu) / CUBE_FACE_ARC, Math.atan(gv) / CUBE_FACE_ARC];
}

/** Unit direction of equi-angular face coordinates. Exact inverse of `cubeUv`. */
export function cubeDir(face: number, uv: readonly number[]): V3 {
  const tx = Math.tan(uv[0] * CUBE_FACE_ARC), ty = Math.tan(uv[1] * CUBE_FACE_ARC);
  let d: V3;
  switch (face) {
    case 0: d = [1, ty, -tx]; break;
    case 1: d = [-1, ty, tx]; break;
    case 2: d = [tx, 1, -ty]; break;
    case 3: d = [tx, -1, ty]; break;
    case 4: d = [tx, ty, 1]; break;
    default: d = [-tx, ty, -1]; break;
  }
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** (face, uv) of a direction or of any non-zero point (normalised internally). */
export function cubeLocate(p: readonly number[]): { face: number; uv: [number, number] } {
  const face = cubeFaceOf(p);
  return { face, uv: cubeUv(p, face) };
}

/** Texture coordinates in [0, 1]² for the texel convention above. */
export function cubeUv01(uv: readonly number[]): [number, number] { return [(uv[0] + 1) * 0.5, (uv[1] + 1) * 0.5]; }

/**
 * Faces whose texture must receive a footprint centred on direction `d` with angular radius `angle` (radians): the owning
 * face plus every neighbour the footprint reaches past a seam (a seam stamp is written into BOTH faces, so bilinear
 * sampling on either side of the edge sees it). The footprint is sampled on its centre, two rims (angle/2, angle) and,
 * for footprints wider than a face, a coarse interior grid; a face region is 90° wide, so a small footprint that overlaps
 * it always has a rim sample inside it.
 */
export function facesTouching(d: readonly number[], angle: number): number[] {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const n: V3 = [d[0] / l, d[1] / l, d[2] / l];
  const hit = new Set<number>([cubeFaceOf(n)]);
  const helper: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let e1: V3 = [n[1] * helper[2] - n[2] * helper[1], n[2] * helper[0] - n[0] * helper[2], n[0] * helper[1] - n[1] * helper[0]];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]); e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const e2: V3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  const a = Math.min(Math.PI, Math.max(0, angle));
  const rings = a > Math.PI / 8 ? 8 : 2;
  for (let r = 1; r <= rings; r++) {
    const theta = (a * r) / rings, cs = Math.cos(theta), sn = Math.sin(theta);
    for (let k = 0; k < 32; k++) {
      const phi = (k / 32) * Math.PI * 2, c = Math.cos(phi), s = Math.sin(phi);
      hit.add(cubeFaceOf([n[0] * cs + (e1[0] * c + e2[0] * s) * sn, n[1] * cs + (e1[1] * c + e2[1] * s) * sn, n[2] * cs + (e1[2] * c + e2[2] * s) * sn]));
    }
  }
  return [...hit].sort((x, y) => x - y);
}

/** Areal Jacobian proxy: the edge length (in radians) of one texel of a `size`² face at face coordinates uv. */
export function cubeTexelArc(size: number, uv: readonly number[]): number {
  const step = 2 / size;
  const p = cubeDir(4, uv), q = cubeDir(4, [uv[0] + step, uv[1]]);
  return Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
}

// ───────────────────────────── Stable site lattice (grass-lattice port, for W2-VEG) ─────────────────────────────

/** Mirror of `cs_hash` (Pinionfall gl_hash). */
export function cubeHash(a: number, b: number): number {
  let x = u32(u32(a) ^ u32(Math.imul(u32(b), 2654435761)));
  x = u32(x ^ (x >>> 16));
  x = u32(Math.imul(x, 0x45d9f3b));
  x = u32(x ^ (x >>> 16));
  return x;
}
/** Mirror of `cs_hash01`. */
export function cubeHash01(a: number, b: number): number { return (cubeHash(a, b) & 0xffffff) / 0xffffff; }
/** Mirror of `cs_site_hash`: the identity of lattice site (face, i, j) — independent of any LOD or chunk. */
export function cubeSiteHash(face: number, i: number, j: number, seed: number): number {
  const ui = u32(i + 1048576), uj = u32(j + 1048576);
  return cubeHash(cubeHash(ui, u32(Math.imul(uj, 2246822519))), u32(seed ^ u32(Math.imul(face, 0x9E3779B9 | 0))));
}
/** Lattice step in face coordinates for a world spacing on a planet of `radius`. */
export function cubeLatticeStep(spacing: number, radius: number): number {
  return spacing / Math.max(1e-6, radius * CUBE_FACE_ARC);
}

// ───────────────────────────── WGSL mirror (generated from the constants above) ─────────────────────────────

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * WGSL mirror. Functions: `cs_face_of(d) -> u32`, `cs_uv(d, face) -> vec2f`, `cs_dir(face, uv) -> vec3f`,
 * `cs_locate(p) -> vec3f` (xy = uv, z = face as f32), `cs_uv01(uv)`, `cs_hash`, `cs_hash01`, `cs_site_hash`.
 */
export const CUBE_SPHERE_WGSL = /* wgsl */ `
const CS_FACE_ARC: f32 = ${f(CUBE_FACE_ARC)};

fn cs_face_of(d: vec3f) -> u32 {
  let a = abs(d);
  if (a.x >= a.y && a.x >= a.z) { return select(1u, 0u, d.x > 0.0); }
  if (a.y >= a.z) { return select(3u, 2u, d.y > 0.0); }
  return select(5u, 4u, d.z > 0.0);
}

fn cs_gnomonic(d: vec3f, face: u32) -> vec2f {
  switch (face) {
    case 0u: { return vec2f(-d.z, d.y) / d.x; }
    case 1u: { return vec2f(d.z, d.y) / -d.x; }
    case 2u: { return vec2f(d.x, -d.z) / d.y; }
    case 3u: { return vec2f(d.x, d.z) / -d.y; }
    case 4u: { return vec2f(d.x, d.y) / d.z; }
    default: { return vec2f(-d.x, d.y) / -d.z; }
  }
}

fn cs_uv(d: vec3f, face: u32) -> vec2f { return atan(cs_gnomonic(d, face)) * (1.0 / CS_FACE_ARC); }

fn cs_dir(face: u32, uv: vec2f) -> vec3f {
  let t = tan(uv * CS_FACE_ARC);
  var d: vec3f;
  switch (face) {
    case 0u: { d = vec3f(1.0, t.y, -t.x); }
    case 1u: { d = vec3f(-1.0, t.y, t.x); }
    case 2u: { d = vec3f(t.x, 1.0, -t.y); }
    case 3u: { d = vec3f(t.x, -1.0, t.y); }
    case 4u: { d = vec3f(t.x, t.y, 1.0); }
    default: { d = vec3f(-t.x, t.y, -1.0); }
  }
  return normalize(d);
}

/** xy = equi-angular uv of the owning face, z = face index. */
fn cs_locate(p: vec3f) -> vec3f {
  let face = cs_face_of(p);
  return vec3f(cs_uv(p, face), f32(face));
}

fn cs_uv01(uv: vec2f) -> vec2f { return uv * 0.5 + vec2f(0.5); }

fn cs_hash(a: u32, b: u32) -> u32 {
  var x = a ^ (b * 2654435761u);
  x = x ^ (x >> 16u);
  x = x * 0x45d9f3bu;
  x = x ^ (x >> 16u);
  return x;
}
fn cs_hash01(a: u32, b: u32) -> f32 { return f32(cs_hash(a, b) & 0xFFFFFFu) / f32(0xFFFFFFu); }
fn cs_site_hash(face: u32, i: i32, j: i32, seed: u32) -> u32 {
  let ui = u32(i + 1048576);
  let uj = u32(j + 1048576);
  return cs_hash(cs_hash(ui, uj * 2246822519u), seed ^ (face * 0x9E3779B9u));
}
`;
