/** Queries against the exact same Float32 triangles uploaded by the terrain renderer. */
import type { TerrainHit, TerrainQueryBounds, TerrainTriangle, TerrainTriangleQuery, V3 } from './contracts';
import type { BuiltTerrainChunk, BuiltTerrainUpdate } from './terrain-config';
import { TERRAIN_BOUND, TERRAIN_RADIUS } from './terrain-config';
import { sphereTriangle } from './sphere-triangle';
import { TriangleSoup } from './triangle-soup';

interface Box { min: V3; max: V3 }
/** A chunk's median-split BVH, flattened in visiting (pre)order: node n spans box[6n..6n+5] (min xyz, max xyz), skip[n] is
 * the node after its subtree, and a leaf lists faces[leaf[2n]..leaf[2n+1]) (inner nodes hold -1). */
export interface CollisionChunk { readonly mesh: BuiltTerrainChunk; readonly root: Box; readonly box: Float64Array; readonly skip: Int32Array; readonly leaf: Int32Array; readonly faces: Int32Array }
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (mesh: BuiltTerrainChunk, vertex: number): V3 => {
  const i = mesh.indices[vertex] * 3;
  return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
};
/** Median-split BVH over triangle centroids (longest axis, stable sort by centroid): precomputed centroids and
 * bounds, no per-comparison allocation. The tree is identical to the historical build, stored flat. */
function makeChunk(mesh: BuiltTerrainChunk): CollisionChunk {
  const count = mesh.indices.length / 3, centroid = new Float64Array(count * 3), lo = new Float64Array(count * 3), hi = new Float64Array(count * 3);
  const { positions, indices } = mesh;
  for (let f = 0; f < count; f++) for (let a = 0; a < 3; a++) {
    const x = positions[indices[f * 3] * 3 + a], y = positions[indices[f * 3 + 1] * 3 + a], z = positions[indices[f * 3 + 2] * 3 + a];
    centroid[f * 3 + a] = x + y + z; lo[f * 3 + a] = Math.min(x, y, z); hi[f * 3 + a] = Math.max(x, y, z);
  }
  const boxes: number[] = [], skip: number[] = [], leaf: number[] = [], faces = new Int32Array(count);
  let filled = 0;
  const build = (list: number[]): void => {
    const node = skip.length, min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const face of list) for (let a = 0; a < 3; a++) { if (lo[face * 3 + a] < min[a]) min[a] = lo[face * 3 + a]; if (hi[face * 3 + a] > max[a]) max[a] = hi[face * 3 + a]; }
    boxes.push(min[0], min[1], min[2], max[0], max[1], max[2]); skip.push(0);
    if (list.length <= 10) { leaf.push(filled, filled + list.length); faces.set(list, filled); filled += list.length; }
    else {
      leaf.push(-1, -1);
      const axis = [0, 1, 2].sort((a, b) => (max[b] - min[b]) - (max[a] - min[a]))[0];
      list.sort((a, b) => centroid[a * 3 + axis] - centroid[b * 3 + axis]);
      const middle = Math.floor(list.length / 2);
      build(list.slice(0, middle)); build(list.slice(middle));
    }
    skip[node] = skip.length;
  };
  build(Array.from({ length: count }, (_, i) => i));
  return { mesh, root: { min: [boxes[0], boxes[1], boxes[2]], max: [boxes[3], boxes[4], boxes[5]] },
    box: Float64Array.from(boxes), skip: Int32Array.from(skip), leaf: Int32Array.from(leaf), faces };
}

/** The ray of the query in progress: origin, unit direction, current hit distance (FAR) and sphere radius, plus the
 * last accepted triangle distance. Hot helpers read it here: doubles passed to a call that is not inlined are boxed. */
const RAY = new Float64Array(9), FAR = 6, RADIUS = 7, DISTANCE = 8;
/** The historical slab test against box b[o..o+5], with the current hit distance as `far`. Containing boxes pass
 * whenever a contained box passes (rounded subtraction and division are monotone), which makes a box over several
 * chunk roots an exact pre-test for all of them. */
function boxHit(b: Float64Array, o: number): boolean {
  const ox = RAY[0], oy = RAY[1], oz = RAY[2], dx = RAY[3], dy = RAY[4], dz = RAY[5], radius = RAY[RADIUS];
  let near = 0, far = RAY[FAR], lo: number, hi: number, swap: number;
  if (Math.abs(dx) < 1e-15) { if (ox < b[o] - radius - 1e-7 || ox > b[o + 3] + radius + 1e-7) return false; }
  else {
    lo = (b[o] - radius - ox) / dx; hi = (b[o + 3] + radius - ox) / dx;
    if (lo > hi) { swap = lo; lo = hi; hi = swap; }
    near = Math.max(near, lo); far = Math.min(far, hi);
    if (near > far + 1e-7) return false;
  }
  if (Math.abs(dy) < 1e-15) { if (oy < b[o + 1] - radius - 1e-7 || oy > b[o + 4] + radius + 1e-7) return false; }
  else {
    lo = (b[o + 1] - radius - oy) / dy; hi = (b[o + 4] + radius - oy) / dy;
    if (lo > hi) { swap = lo; lo = hi; hi = swap; }
    near = Math.max(near, lo); far = Math.min(far, hi);
    if (near > far + 1e-7) return false;
  }
  if (Math.abs(dz) < 1e-15) { if (oz < b[o + 2] - radius - 1e-7 || oz > b[o + 5] + radius + 1e-7) return false; }
  else {
    lo = (b[o + 2] - radius - oz) / dz; hi = (b[o + 5] + radius - oz) / dz;
    if (lo > hi) { swap = lo; lo = hi; hi = swap; }
    near = Math.max(near, lo); far = Math.min(far, hi);
    if (near > far + 1e-7) return false;
  }
  return true;
}
/** Validate a ray and put its origin and normalized direction in RAY (the historical checks and normalization). */
function aim(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz) || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return false;
  const length = Math.hypot(dx, dy, dz); if (length < 1e-15) return false;
  RAY[0] = ox; RAY[1] = oy; RAY[2] = oz; RAY[3] = dx / length; RAY[4] = dy / length; RAY[5] = dz / length;
  return true;
}
const boxOverlaps = (b: Float64Array, o: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean =>
  b[o] <= maxX && b[o + 3] >= minX && b[o + 1] <= maxY && b[o + 4] >= minY && b[o + 2] <= maxZ && b[o + 5] >= minZ;

/** Moller-Trumbore in the historical operation order against RAY (limit RAY[FAR]); on success RAY[DISTANCE] holds the
 * unclamped distance. */
function rayTriangle(positions: ArrayLike<number>, indices: ArrayLike<number>, face: number): boolean {
  const ox = RAY[0], oy = RAY[1], oz = RAY[2], rx = RAY[3], ry = RAY[4], rz = RAY[5];
  const ia = indices[face * 3] * 3, ib = indices[face * 3 + 1] * 3, ic = indices[face * 3 + 2] * 3, ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
  const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az, e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;
  const px = ry * e2z - rz * e2y, py = rz * e2x - rx * e2z, pz = rx * e2y - ry * e2x, determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant, tx = ox - ax, ty = oy - ay, tz = oz - az, u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < -1e-8 || u > 1 + 1e-8) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (rx * qx + ry * qy + rz * qz) * inverse;
  if (v < -1e-8 || u + v > 1 + 1e-8) return false;
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  if (distance < -1e-7 || distance > RAY[FAR]) return false;
  if (!Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x)) return false;
  RAY[DISTANCE] = distance; return true;
}

/** The nearest hit of the last successful TerrainCollision.nearest() (valid until the next query of any collision). */
export const NEAREST = { distance: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, material: 0 };
const soup = new TriangleSoup();
const finite3 = (v: V3) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

const finite = (values: ArrayLike<number>) => { for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false; return true; };
const inRange = (values: ArrayLike<number>, count: number) => { for (let i = 0; i < values.length; i++) if (values[i] >= count) return false; return true; };
export class TerrainCollision {
  readonly radius = TERRAIN_RADIUS;
  readonly chunks: ReadonlyMap<string, CollisionChunk>;
  /** Chunks in Map order (the tie-break order of every query) and a balanced tree over that order: node n holds the
   * union of its chunks' roots in top[6n..], skips to topSkip[n], and is a leaf for chunk topChunk[n] >= 0. A query
   * still visits the surviving chunks in Map order, so equal distances resolve exactly as a scan of every root. */
  private readonly list: CollisionChunk[];
  private readonly top: Float64Array;
  private readonly topSkip: Int32Array;
  private readonly topChunk: Int32Array;
  private readonly topCount: Int32Array;
  constructor(readonly version = 0, chunks: ReadonlyMap<string, CollisionChunk> = new Map(), buildTraversal = true) {
    this.chunks = chunks;
    const list = this.list = buildTraversal ? [...chunks.values()] : [], nodes = Math.max(0, list.length * 2 - 1);
    const top = this.top = new Float64Array(nodes * 6), skip = this.topSkip = new Int32Array(nodes), chunk = this.topChunk = new Int32Array(nodes), count = this.topCount = new Int32Array(nodes);
    let next = 0;
    const build = (from: number, to: number): void => {
      const node = next++, o = node * 6;
      count[node] = to - from;
      if (to - from === 1) { chunk[node] = from; top.set(list[from].box.subarray(0, 6), o); }
      else {
        const middle = (from + to) >> 1, left = next * 6; build(from, middle); const right = next * 6; build(middle, to);
        chunk[node] = -1;
        for (let a = 0; a < 3; a++) { top[o + a] = Math.min(top[left + a], top[right + a]); top[o + 3 + a] = Math.max(top[left + 3 + a], top[right + 3 + a]); }
      }
      skip[node] = next;
    };
    if (list.length) build(0, list.length);
  }
  /** Build all changed BVHs first; caller swaps this immutable world only on success. */
  apply(update: BuiltTerrainUpdate): TerrainCollision {
    const steps = this.applySteps(update); for (;;) { const next = steps.next(); if (next.done) return next.value; }
  }
  /** Same immutable snapshot, with a checkpoint after each chunk for responsive initial preparation. */
  * applySteps(update: BuiltTerrainUpdate): Generator<void, TerrainCollision> {
    const chunks = new Map(this.chunks);
    for (const id of update.removed) chunks.delete(id);
    for (const mesh of update.chunks) {
      if (mesh.indices.length % 3 || mesh.positions.length % 3 || mesh.materials.length !== mesh.indices.length / 3
        || !finite(mesh.positions) || !inRange(mesh.indices, mesh.positions.length / 3)) throw new Error('Invalid terrain mesh payload.');
      if (mesh.indices.length) chunks.set(mesh.id, makeChunk(mesh));
      else chunks.delete(mesh.id);
      yield;
    }
    return new TerrainCollision(update.version, chunks);
  }
  /** Nearest hit along (dx, dy, dz) into NEAREST; the scalar core of raycast(), with its validation. */
  nearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): boolean {
    if (!aim(ox, oy, oz, dx, dy, dz) || !(maxDistance >= 0) || !Number.isFinite(maxDistance)) return false;
    RAY[FAR] = maxDistance; RAY[RADIUS] = 0;
    const list = this.list, top = this.top, topSkip = this.topSkip, topChunk = this.topChunk, nodes = topSkip.length;
    let best: CollisionChunk | null = null, bestFace = 0;
    for (let node = 0; node < nodes;) {
      const index = topChunk[node];
      if (index < 0) { node = boxHit(top, node * 6) ? node + 1 : topSkip[node]; continue; }
      node++;
      const chunk = list[index], { box, skip, leaf, faces } = chunk, positions = chunk.mesh.positions, indices = chunk.mesh.indices, count = skip.length;
      for (let n = 0; n < count;) {
        if (!boxHit(box, n * 6)) { n = skip[n]; continue; }
        const first = leaf[n * 2];
        if (first < 0) { n++; continue; }
        for (let k = first, end = leaf[n * 2 + 1]; k < end; k++) {
          if (!rayTriangle(positions, indices, faces[k])) continue;
          RAY[FAR] = Math.max(0, RAY[DISTANCE]); best = chunk; bestFace = faces[k];
        }
        n = skip[n];
      }
    }
    if (!best) return false;
    const { positions, indices } = best.mesh, ia = indices[bestFace * 3] * 3, ib = indices[bestFace * 3 + 1] * 3, ic = indices[bestFace * 3 + 2] * 3;
    const e1x = positions[ib] - positions[ia], e1y = positions[ib + 1] - positions[ia + 1], e1z = positions[ib + 2] - positions[ia + 2];
    const e2x = positions[ic] - positions[ia], e2y = positions[ic + 1] - positions[ia + 1], e2z = positions[ic + 2] - positions[ia + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, length = Math.hypot(nx, ny, nz), limit = RAY[FAR];
    NEAREST.distance = limit; NEAREST.px = ox + RAY[3] * limit; NEAREST.py = oy + RAY[4] * limit; NEAREST.pz = oz + RAY[5] * limit;
    NEAREST.nx = nx / length; NEAREST.ny = ny / length; NEAREST.nz = nz / length; NEAREST.material = best.mesh.materials[bestFace];
    return true;
  }
  /** Whether raycast() would return a hit, stopping at the first triangle it would accept. */
  any(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): boolean {
    if (!aim(ox, oy, oz, dx, dy, dz) || !(maxDistance >= 0) || !Number.isFinite(maxDistance)) return false;
    RAY[FAR] = maxDistance; RAY[RADIUS] = 0;
    const list = this.list, top = this.top, topSkip = this.topSkip, topChunk = this.topChunk, nodes = topSkip.length;
    for (let node = 0; node < nodes;) {
      const index = topChunk[node];
      if (index < 0) { node = boxHit(top, node * 6) ? node + 1 : topSkip[node]; continue; }
      node++;
      const chunk = list[index], { box, skip, leaf, faces } = chunk, positions = chunk.mesh.positions, indices = chunk.mesh.indices, count = skip.length;
      for (let n = 0; n < count;) {
        if (!boxHit(box, n * 6)) { n = skip[n]; continue; }
        const first = leaf[n * 2];
        if (first < 0) { n++; continue; }
        for (let k = first, end = leaf[n * 2 + 1]; k < end; k++) if (rayTriangle(positions, indices, faces[k])) return true;
        n = skip[n];
      }
    }
    return false;
  }
  raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    if (!this.nearest(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], maxDistance)) return null;
    const h = NEAREST;
    return { point: [h.px, h.py, h.pz], normal: [h.nx, h.ny, h.nz], distance: h.distance, material: h.material };
  }
  /** raycast() !== null, without building the hit. */
  blocked(origin: V3, direction: V3, maxDistance: number): boolean { return this.any(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], maxDistance); }
  /** Append the triangles queryTriangles() would return to `out`; true when that result overflows. Throws like it. */
  collect(bounds: TerrainQueryBounds, maxTriangles: number, out: TriangleSoup): boolean {
    const lo = bounds.min, hi = bounds.max;
    if (!finite3(lo) || !finite3(hi) || lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]
      || !Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > 2048) throw new Error('Invalid bounded terrain triangle query.');
    const minX = lo[0] - 1e-7, minY = lo[1] - 1e-7, minZ = lo[2] - 1e-7, maxX = hi[0] + 1e-7, maxY = hi[1] + 1e-7, maxZ = hi[2] + 1e-7;
    const list = this.list, top = this.top, topSkip = this.topSkip, topChunk = this.topChunk, topCount = this.topCount, nodes = topSkip.length, base = out.count;
    // Every node visit counts, a skipped chunk root included (its own visit in a scan of all roots).
    let visited = 0;
    for (let node = 0; node < nodes;) {
      const index = topChunk[node];
      if (index < 0) {
        if (boxOverlaps(top, node * 6, minX, minY, minZ, maxX, maxY, maxZ)) node++;
        else { visited += topCount[node]; if (visited > 8192) return true; node = topSkip[node]; }
        continue;
      }
      node++;
      const chunk = list[index], { box, skip, leaf, faces } = chunk, { positions, indices, materials } = chunk.mesh, count = skip.length;
      for (let n = 0; n < count;) {
        if (++visited > 8192) return true;
        if (!boxOverlaps(box, n * 6, minX, minY, minZ, maxX, maxY, maxZ)) { n = skip[n]; continue; }
        const first = leaf[n * 2];
        if (first < 0) { n++; continue; }
        for (let k = first, end = leaf[n * 2 + 1]; k < end; k++) {
          const face = faces[k], ia = indices[face * 3] * 3, ib = indices[face * 3 + 1] * 3, ic = indices[face * 3 + 2] * 3;
          const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2], bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
          const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
          if (Math.min(ax, bx, cx) > maxX || Math.max(ax, bx, cx) < minX || Math.min(ay, by, cy) > maxY || Math.max(ay, by, cy) < minY
            || Math.min(az, bz, cz) > maxZ || Math.max(az, bz, cz) < minZ) continue;
          if (out.count - base >= maxTriangles) return true;
          const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
          const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, length = Math.hypot(nx, ny, nz);
          if (!(length > 1e-12)) continue;
          const o = out.append(), d = out.data;
          d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = bx; d[o + 4] = by; d[o + 5] = bz; d[o + 6] = cx; d[o + 7] = cy; d[o + 8] = cz;
          d[o + 9] = nx / length; d[o + 10] = ny / length; d[o + 11] = nz / length; d[o + 12] = materials[face];
        }
        n = skip[n];
      }
    }
    return false;
  }
  queryTriangles(bounds: TerrainQueryBounds, maxTriangles = 512): TerrainTriangleQuery {
    const overflow = this.collect(bounds, maxTriangles, soup.clear());
    return { triangles: soup.triangles(), overflow };
  }
  * visibilityTriangles(): Iterable<TerrainTriangle> {
    for (const { mesh } of this.chunks.values()) for (let face = 0; face < mesh.indices.length / 3; face++) {
      const a = point(mesh, face * 3), b = point(mesh, face * 3 + 1), c = point(mesh, face * 3 + 2);
      const normal = cross(sub(b, a), sub(c, a)), length = Math.hypot(...normal);
      if (length > 1e-12) yield { a, b, c, normal: normal.map(value => value / length) as V3, material: mesh.materials[face] };
    }
  }
  /** First contact distance of a swept sphere; the scalar core of sweepSphere(), with its validation. */
  sweep(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number, radius: number): number | null {
    if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz) || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)
      || !Number.isFinite(maxDistance) || maxDistance < 0 || !Number.isFinite(radius) || radius <= 0 || !aim(ox, oy, oz, dx, dy, dz)) return null;
    RAY[FAR] = maxDistance; RAY[RADIUS] = radius;
    const list = this.list, top = this.top, topSkip = this.topSkip, topChunk = this.topChunk, nodes = topSkip.length;
    let found = false;
    for (let node = 0; node < nodes;) {
      const index = topChunk[node];
      if (index < 0) { node = boxHit(top, node * 6) ? node + 1 : topSkip[node]; continue; }
      node++;
      const chunk = list[index], { box, skip, leaf, faces } = chunk, positions = chunk.mesh.positions, indices = chunk.mesh.indices, count = skip.length;
      for (let n = 0; n < count;) {
        if (!boxHit(box, n * 6)) { n = skip[n]; continue; }
        const first = leaf[n * 2];
        if (first < 0) { n++; continue; }
        for (let k = first, end = leaf[n * 2 + 1]; k < end; k++) {
          const face = faces[k];
          if (sphereTriangle(RAY, positions, indices[face * 3] * 3, indices[face * 3 + 1] * 3, indices[face * 3 + 2] * 3)) { RAY[FAR] = RAY[DISTANCE]; found = true; }
        }
        n = skip[n];
      }
    }
    return found ? RAY[FAR] : null;
  }
  sweepSphere(origin: V3, direction: V3, maxDistance: number, radius: number): number | null {
    return this.sweep(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], maxDistance, radius);
  }
  surface(direction: V3): TerrainHit | null {
    const length = Math.hypot(direction[0], direction[1], direction[2]); if (!length || !Number.isFinite(length)) return null;
    const distance = TERRAIN_BOUND * Math.sqrt(3) + 1;
    return this.raycast([direction[0] * distance / length, direction[1] * distance / length, direction[2] * distance / length], [-direction[0], -direction[1], -direction[2]], distance * 2);
  }
  /** isSolid() at a point given as scalars. */
  solid(x: number, y: number, z: number): boolean {
    // For a consistently oriented closed mesh, the first outward crossing is an exit iff inside.
    if (!this.nearest(x, y, z, .8192319, .3721373, .4361951, TERRAIN_BOUND * 4)) return false;
    return NEAREST.distance < 1e-6 || NEAREST.nx * .8192319 + NEAREST.ny * .3721373 + NEAREST.nz * .4361951 > 0;
  }
  isSolid(position: V3): boolean { return this.solid(position[0], position[1], position[2]); }
}
