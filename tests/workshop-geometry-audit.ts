/** Test-only exact triangle intersection BVH for checking authored service hardware through motion. */
import type { MeshDesc, Vec3 } from '../src/engine';
type Tri = [Vec3, Vec3, Vec3];
interface Bounds { min: Vec3; max: Vec3 }
interface Node extends Bounds { triangles?: Tri[]; left?: Node; right?: Node }
const triangleBounds = new WeakMap<Tri, Bounds>();
const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v, i) => v - b[i]) as Vec3;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function bounds(triangles: readonly (readonly Vec3[])[]): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) for (const p of t) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  return { min, max };
}
const overlap = (a: Bounds, b: Bounds) => a.min.every((v, i) => v <= b.max[i] + 1e-6 && a.max[i] >= b.min[i] - 1e-6);
function build(triangles: Tri[]): Node {
  const b = bounds(triangles);
  if (triangles.length <= 12) return { ...b, triangles };
  const span = b.max.map((v, i) => v - b.min[i]), axis = span.indexOf(Math.max(...span));
  triangles.sort((a, b) => a.reduce((n, p) => n + p[axis], 0) - b.reduce((n, p) => n + p[axis], 0));
  const mid = Math.floor(triangles.length / 2); return { ...b, left: build(triangles.slice(0, mid)), right: build(triangles.slice(mid)) };
}
function trianglesTouch(a: Tri, b: Tri): boolean {
  const ea = [sub(a[1], a[0]), sub(a[2], a[1]), sub(a[0], a[2])], eb = [sub(b[1], b[0]), sub(b[2], b[1]), sub(b[0], b[2])];
  const na = cross(ea[0], ea[1]), nb = cross(eb[0], eb[1]);
  const axes = [na, nb, ...ea.flatMap(x => eb.map(y => cross(x, y))), ...ea.map(x => cross(na, x)), ...eb.map(x => cross(nb, x))];
  for (const axis of axes) {
    const n = Math.hypot(...axis); if (n < 1e-11) continue;
    const aa = a.map(p => dot(p, axis) / n), bb = b.map(p => dot(p, axis) / n);
    if (Math.max(...aa) < Math.min(...bb) - 1e-6 || Math.max(...bb) < Math.min(...aa) - 1e-6) return false;
  }
  return true;
}
function query(node: Node, triangle: Tri, box: Bounds): boolean {
  if (!overlap(node, box)) return false;
  if (node.triangles) return node.triangles.some(t => overlap(triangleBounds.get(t)!, box) && trianglesTouch(triangle, t));
  return query(node.left!, triangle, box) || query(node.right!, triangle, box);
}
function meshTriangles(mesh: MeshDesc): Tri[] {
  const result: Tri[] = [], p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) result.push([0, 1, 2].map(j => { const v = mesh.indices[i + j] * 3; return [p[v], p[v + 1], p[v + 2]]; }) as Tri);
  return result;
}
const caches = new WeakMap<MeshDesc, { triangles: Tri[]; bvh: Node }>();
function cache(mesh: MeshDesc) {
  let c = caches.get(mesh);
  if (!c) {
    const triangles = meshTriangles(mesh);
    for (const triangle of triangles) triangleBounds.set(triangle, bounds([triangle]));
    caches.set(mesh, c = { triangles, bvh: build([...triangles]) });
  }
  return c;
}
/** All workshop transforms have orthogonal axes (possibly scaled); preserve precise local triangle geometry. */
export function meshesIntersect(a: MeshDesc, am: Float32Array, b: MeshDesc, bm: Float32Array): boolean {
  return intersect(a, am, b, bm, true);
}
/** Original unpruned triangle path, retained as the broadphase regression oracle. */
export function meshesIntersectWithoutBroadphase(a: MeshDesc, am: Float32Array, b: MeshDesc, bm: Float32Array): boolean {
  return intersect(a, am, b, bm, false);
}
function intersect(a: MeshDesc, am: Float32Array, b: MeshDesc, bm: Float32Array, broadphase: boolean): boolean {
  const aa = cache(a), bb = cache(b);
  const dx = bm[0] ** 2 + bm[1] ** 2 + bm[2] ** 2, dy = bm[4] ** 2 + bm[5] ** 2 + bm[6] ** 2, dz = bm[8] ** 2 + bm[9] ** 2 + bm[10] ** 2;
  const convert = (p: Vec3): Vec3 => {
    const x = am[0] * p[0] + am[4] * p[1] + am[8] * p[2] + am[12] - bm[12], y = am[1] * p[0] + am[5] * p[1] + am[9] * p[2] + am[13] - bm[13], z = am[2] * p[0] + am[6] * p[1] + am[10] * p[2] + am[14] - bm[14];
    return [(x * bm[0] + y * bm[1] + z * bm[2]) / dx, (x * bm[4] + y * bm[5] + z * bm[6]) / dy, (x * bm[8] + y * bm[9] + z * bm[10]) / dz];
  };
  if (broadphase) {
    // An affine transform of all eight local AABB corners encloses every exact
    // triangle below, including touching faces and scaled/rotated service parts.
    const corners: Vec3[] = [];
    for (const x of [aa.bvh.min[0], aa.bvh.max[0]]) for (const y of [aa.bvh.min[1], aa.bvh.max[1]]) for (const z of [aa.bvh.min[2], aa.bvh.max[2]]) corners.push(convert([x, y, z]));
    if (!overlap(bounds([corners]), bb.bvh)) return false;
  }
  const local = aa.triangles.map(t => t.map(convert) as Tri);
  if (!overlap(bounds(local), bb.bvh)) return false;
  return local.some(t => query(bb.bvh, t, bounds([t])));
}
