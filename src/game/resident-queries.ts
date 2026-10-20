import type { Q4, TerrainChunk, TerrainHit, TerrainQueryBounds, TerrainTriangleQuery, V3, WorldQuery } from './contracts';
import { NEAREST, TerrainCollision } from './terrain-collision';
import { TriangleSoup } from './triangle-soup';
import type { ResidentArrangement } from '../gpu/terrain/arrangement';
import type { BoundaryFace } from './terrain-connectivity';
import { rotateInto } from './math';
import { TERRAIN_BOUND, TERRAIN_RADIUS } from './terrain-config';

/** Bounded CPU collision descriptors reconstructed from accepted source recipes.
 * These arrays are never uploaded as rendering geometry or read back from GPU. */
export function residentQueryChunk(id: string, boundary: readonly BoundaryFace[], arrangement: ResidentArrangement, origin: V3 = [0, 0, 0]): TerrainChunk {
  const ids = new Map<number, number>(), positions: number[] = [], indices: number[] = [], materials: number[] = [];
  const vertex = (id: number) => { let local = ids.get(id); if (local === undefined) { local = ids.size; ids.set(id, local); const p = arrangement.vertices[id].position; positions.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]); } return local; };
  for (const { region, face } of boundary) for (let i = 1; i + 1 < face.vertices.length; i++) {
    indices.push(vertex(face.vertices[0]), vertex(face.vertices[i]), vertex(face.vertices[i + 1])); materials.push(region.material);
  }
  return { id, positions: new Float32Array(positions), indices: new Uint32Array(indices), materials: new Uint16Array(materials), normals: new Float32Array(), colors: new Float32Array() };
}
export interface ResidentQueryBody { collision: TerrainCollision; pose: () => { position: V3; rotation: Q4 } }
/** Includes remote support loss as well as the cutter: compare accepted query pages. */
export function residentFootprintBounds(before: TerrainCollision, after: TerrainCollision): TerrainQueryBounds[] {
  const bounds: TerrainQueryBounds[] = [];
  for (const id of new Set([...before.chunks.keys(), ...after.chunks.keys()])) {
    const old = before.chunks.get(id), next = after.chunks.get(id);
    if (old === next) continue;
    for (const chunk of [old, next]) if (chunk) bounds.push({ min: [...chunk.root.min], max: [...chunk.root.max] });
  }
  return bounds;
}
export function queryCollision(chunks: TerrainChunk[], version = 1): TerrainCollision {
  return new TerrainCollision().apply({ version, chunks, removed: [], triangles: 0, rebuilt: chunks.length, milliseconds: 0 });
}

// isSolid()'s probe direction as TerrainCollision normalizes it; only used to place a conservative bound.
const PROBE = Math.hypot(.8192319, .3721373, .4361951), PROBE_X = .8192319 / PROBE, PROBE_Y = .3721373 / PROBE, PROBE_Z = .4361951 / PROBE;
const scratch = new Float64Array(12), local: TerrainQueryBounds = { min: [0, 0, 0], max: [0, 0, 0] }, soup = new TriangleSoup();
/** Bounds below are conservative only for these poses and magnitudes (else every query takes the exact path). */
const SANE = 1e6;
/** One dynamic body: its collision, the ball around its local root boxes, and the pose the queries use. With the pose
 * finite and |q|² within 1e-5 of 1, the pose map and its conjugate stretch lengths by at most 1.00002 and differ by at
 * most 4.0002e-5·|v|; `reach` (ball radius ×1.0001, +1e-4·|centre|, +1e-5) covers both plus the 1e-7 query
 * tolerances, so a query clear of the world ball cannot pass the body's root test: skipping it is exact. */
class BodyRecord {
  readonly cx: number; readonly cy: number; readonly cz: number; readonly min: V3; readonly max: V3; readonly radius: number;
  /** No chunk at all, or too many to rule out the 8192-visit overflow from the bound alone. */
  readonly empty: boolean; readonly bounded: boolean;
  px = 0; py = 0; pz = 0; qx = 0; qy = 0; qz = 0; qw = 1; read = false;
  /** The pose admits the bound; then (wx, wy, wz) is the ball's world centre and (sx, sy, sz) isSolid()'s world probe. */
  near = false; wx = 0; wy = 0; wz = 0; reach = 0; sx = 0; sy = 0; sz = 0;
  constructor(readonly collision: TerrainCollision, readonly pose: () => { position: V3; rotation: Q4 }) {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const { root } of collision.chunks.values()) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], root.min[a]); max[a] = Math.max(max[a], root.max[a]); }
    this.empty = !collision.chunks.size; this.bounded = collision.chunks.size <= 8192 && [...min, ...max].every(v => Math.abs(v) <= SANE);
    this.min = min; this.max = max;
    this.cx = this.empty ? 0 : (min[0] + max[0]) * .5; this.cy = this.empty ? 0 : (min[1] + max[1]) * .5; this.cz = this.empty ? 0 : (min[2] + max[2]) * .5;
    this.radius = this.empty ? 0 : Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * .5;
  }
  /** Read the live pose; true unless it is identical (Object.is) to the previous read. */
  load(): boolean {
    const { position, rotation } = this.pose(), px = position[0], py = position[1], pz = position[2], qx = rotation[0], qy = rotation[1], qz = rotation[2], qw = rotation[3];
    const changed = !this.read || !Object.is(px, this.px) || !Object.is(py, this.py) || !Object.is(pz, this.pz) || !Object.is(qx, this.qx) || !Object.is(qy, this.qy) || !Object.is(qz, this.qz) || !Object.is(qw, this.qw);
    this.px = px; this.py = py; this.pz = pz; this.qx = qx; this.qy = qy; this.qz = qz; this.qw = qw; this.read = true;
    const n2 = qx * qx + qy * qy + qz * qz + qw * qw;
    this.near = this.bounded && Math.abs(n2 - 1) <= 1e-5 && Math.abs(px) <= SANE && Math.abs(py) <= SANE && Math.abs(pz) <= SANE;
    if (this.near) {
      rotateInto(scratch, 0, this.cx, this.cy, this.cz, qx, qy, qz, qw); this.wx = px + scratch[0]; this.wy = py + scratch[1]; this.wz = pz + scratch[2];
      this.reach = this.radius * 1.0001 + 1e-4 * Math.hypot(this.cx, this.cy, this.cz) + 1e-5;
      rotateInto(scratch, 0, PROBE_X, PROBE_Y, PROBE_Z, qx, qy, qz, qw); this.sx = scratch[0]; this.sy = scratch[1]; this.sz = scratch[2];
    }
    return changed;
  }
  /** The segment o + t·u (u unit, t ∈ [0, length]) keeps farther than reach + extra from the ball's centre. */
  clear(ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, length: number, extra: number): boolean {
    if (this.empty) return true;
    const wx = this.wx - ox, wy = this.wy - oy, wz = this.wz - oz, along = wx * ux + wy * uy + wz * uz, t = along < 0 ? 0 : along > length ? length : along;
    const ex = wx - ux * t, ey = wy - uy * t, ez = wz - uz * t, reach = this.reach + extra;
    return ex * ex + ey * ey + ez * ez > reach * reach;
  }
  /** The local AABB of a world box (centre m, half diagonal rho) cannot overlap the local root boxes. */
  apart(mx: number, my: number, mz: number, rho: number): boolean {
    if (this.empty) return true;
    rotateInto(scratch, 0, mx - this.px, my - this.py, mz - this.pz, -this.qx, -this.qy, -this.qz, this.qw);
    const h = rho * 1.0001 + 1e-5, min = this.min, max = this.max;
    return min[0] > scratch[0] + h || max[0] < scratch[0] - h || min[1] > scratch[1] + h || max[1] < scratch[1] - h || min[2] > scratch[2] + h || max[2] < scratch[2] - h;
  }
}
export class ResidentQueries implements WorldQuery {
  readonly radius = TERRAIN_RADIUS;
  /** Body records in Map order (the tie-break order). */
  private readonly records: BodyRecord[];
  /** Poses come from the last syncPoses() instead of a live read per query. */
  private held = false;
  private distance = 0; private material = 0; private readonly point = new Float64Array(6);
  constructor(readonly version: number, readonly fixed: TerrainCollision, readonly bodies: ReadonlyMap<number, ResidentQueryBody>, captureBodies = true) {
    this.records = captureBodies ? [...bodies.values()].map(({ collision, pose }) => new BodyRecord(collision, pose)) : [];
  }
  /** Read every body pose once (after a physics step); queries then use these poses instead of reading the live ones,
   * until the next sync. The owner calls it wherever the poses can change. True when any pose differs from the
   * previous sync (or there was none), i.e. when a query result can differ from the last tick's. */
  syncPoses(): boolean {
    let changed = false;
    for (const record of this.records) if (record.load()) changed = true;
    this.held = true; return changed;
  }
  private nearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): boolean {
    let found = this.fixed.nearest(ox, oy, oz, dx, dy, dz, maxDistance);
    const out = this.point;
    if (found) { out[0] = NEAREST.px; out[1] = NEAREST.py; out[2] = NEAREST.pz; out[3] = NEAREST.nx; out[4] = NEAREST.ny; out[5] = NEAREST.nz; this.distance = NEAREST.distance; this.material = NEAREST.material; }
    const records = this.records; if (!records.length) return found;
    const length = Math.hypot(dx, dy, dz), usable = length >= 1e-12 && length <= SANE && Math.abs(ox) <= SANE && Math.abs(oy) <= SANE && Math.abs(oz) <= SANE && maxDistance <= SANE;
    const ux = dx / length, uy = dy / length, uz = dz / length;
    for (const r of records) {
      if (!this.held) r.load();
      const limit = found ? this.distance : maxDistance;
      if (usable && r.near && r.clear(ox, oy, oz, ux, uy, uz, limit * 1.0001 + 1e-5, 0)) continue;
      const qx = -r.qx, qy = -r.qy, qz = -r.qz, qw = r.qw;
      rotateInto(scratch, 0, ox - r.px, oy - r.py, oz - r.pz, qx, qy, qz, qw); rotateInto(scratch, 3, dx, dy, dz, qx, qy, qz, qw);
      if (!r.collision.nearest(scratch[0], scratch[1], scratch[2], scratch[3], scratch[4], scratch[5], limit)) continue;
      found = true; this.distance = NEAREST.distance; this.material = NEAREST.material;
      rotateInto(scratch, 6, NEAREST.px, NEAREST.py, NEAREST.pz, r.qx, r.qy, r.qz, r.qw); rotateInto(out, 3, NEAREST.nx, NEAREST.ny, NEAREST.nz, r.qx, r.qy, r.qz, r.qw);
      out[0] = r.px + scratch[6]; out[1] = r.py + scratch[7]; out[2] = r.pz + scratch[8];
    }
    return found;
  }
  private hit(): TerrainHit {
    const p = this.point;
    return { point: [p[0], p[1], p[2]], normal: [p[3], p[4], p[5]], distance: this.distance, material: this.material };
  }
  raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    return this.nearest(origin[0], origin[1], origin[2], direction[0], direction[1], direction[2], maxDistance) ? this.hit() : null;
  }
  /** raycast() !== null, stopping at the first accepted triangle. */
  blocked(origin: V3, direction: V3, maxDistance: number): boolean {
    const ox = origin[0], oy = origin[1], oz = origin[2], dx = direction[0], dy = direction[1], dz = direction[2];
    if (this.fixed.any(ox, oy, oz, dx, dy, dz, maxDistance)) return true;
    const records = this.records; if (!records.length) return false;
    const length = Math.hypot(dx, dy, dz), usable = length >= 1e-12 && length <= SANE && Math.abs(ox) <= SANE && Math.abs(oy) <= SANE && Math.abs(oz) <= SANE && maxDistance <= SANE;
    const ux = dx / length, uy = dy / length, uz = dz / length, reach = maxDistance * 1.0001 + 1e-5;
    for (const r of records) {
      if (!this.held) r.load();
      if (usable && r.near && r.clear(ox, oy, oz, ux, uy, uz, reach, 0)) continue;
      const qx = -r.qx, qy = -r.qy, qz = -r.qz, qw = r.qw;
      rotateInto(scratch, 0, ox - r.px, oy - r.py, oz - r.pz, qx, qy, qz, qw); rotateInto(scratch, 3, dx, dy, dz, qx, qy, qz, qw);
      if (r.collision.any(scratch[0], scratch[1], scratch[2], scratch[3], scratch[4], scratch[5], maxDistance)) return true;
    }
    return false;
  }
  surface(direction: V3): TerrainHit | null {
    const length = Math.hypot(direction[0], direction[1], direction[2]), distance = TERRAIN_BOUND * Math.sqrt(3) + 1;
    if (!length || !Number.isFinite(length)) return null;
    return this.nearest(direction[0] * distance / length, direction[1] * distance / length, direction[2] * distance / length, -direction[0], -direction[1], -direction[2], 2 * distance) ? this.hit() : null;
  }
  sweepSphere(origin: V3, direction: V3, maxDistance: number, radius: number): number | null {
    const ox = origin[0], oy = origin[1], oz = origin[2], dx = direction[0], dy = direction[1], dz = direction[2];
    let hit = this.fixed.sweep(ox, oy, oz, dx, dy, dz, maxDistance, radius);
    const records = this.records; if (!records.length) return hit;
    const length = Math.hypot(dx, dy, dz), usable = length >= 1e-12 && length <= SANE && Math.abs(ox) <= SANE && Math.abs(oy) <= SANE && Math.abs(oz) <= SANE && maxDistance <= SANE && radius <= SANE;
    const ux = dx / length, uy = dy / length, uz = dz / length;
    for (const r of records) {
      if (!this.held) r.load();
      const limit = hit ?? maxDistance;
      if (usable && r.near && r.clear(ox, oy, oz, ux, uy, uz, limit * 1.0001 + 1e-5, radius * 1.0001)) continue;
      const qx = -r.qx, qy = -r.qy, qz = -r.qz, qw = r.qw;
      rotateInto(scratch, 0, ox - r.px, oy - r.py, oz - r.pz, qx, qy, qz, qw); rotateInto(scratch, 3, dx, dy, dz, qx, qy, qz, qw);
      const candidate = r.collision.sweep(scratch[0], scratch[1], scratch[2], scratch[3], scratch[4], scratch[5], limit, radius);
      if (candidate !== null) hit = candidate;
    }
    return hit;
  }
  isSolid(point: V3): boolean {
    const x = point[0], y = point[1], z = point[2];
    if (this.fixed.solid(x, y, z)) return true;
    const usable = Math.abs(x) <= SANE && Math.abs(y) <= SANE && Math.abs(z) <= SANE, reach = TERRAIN_BOUND * 4 * 1.0001 + 1e-5;
    for (const r of this.records) {
      if (!this.held) r.load();
      // The probe's world direction is only known to 4e-5 of its 96 u length; the extra 1e-2 covers it.
      if (usable && r.near && r.clear(x, y, z, r.sx, r.sy, r.sz, reach, 1e-2)) continue;
      rotateInto(scratch, 0, x - r.px, y - r.py, z - r.pz, -r.qx, -r.qy, -r.qz, r.qw);
      if (r.collision.solid(scratch[0], scratch[1], scratch[2])) return true;
    }
    return false;
  }
  /** Append queryTriangles()' triangles to `out`; true when that result overflows. Throws like queryTriangles(). */
  collect(bounds: TerrainQueryBounds, maxTriangles: number, out: TriangleSoup): boolean {
    const base = out.count;
    let overflow = this.fixed.collect(bounds, maxTriangles, out);
    const records = this.records; if (!records.length) return overflow;
    const lo = bounds.min, hi = bounds.max, mx = (lo[0] + hi[0]) * .5, my = (lo[1] + hi[1]) * .5, mz = (lo[2] + hi[2]) * .5, rho = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * .5;
    const usable = Math.abs(mx) <= SANE && Math.abs(my) <= SANE && Math.abs(mz) <= SANE && rho <= SANE;
    for (const r of records) {
      if (overflow) return true;
      if (!this.held) r.load();
      if (usable && r.near && r.apart(mx, my, mz, rho)) continue;
      const qx = -r.qx, qy = -r.qy, qz = -r.qz, qw = r.qw, min = local.min, max = local.max;
      min[0] = min[1] = min[2] = Infinity; max[0] = max[1] = max[2] = -Infinity;
      for (let mask = 0; mask < 8; mask++) {
        rotateInto(scratch, 0, (mask & 1 ? hi[0] : lo[0]) - r.px, (mask & 2 ? hi[1] : lo[1]) - r.py, (mask & 4 ? hi[2] : lo[2]) - r.pz, qx, qy, qz, qw);
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], scratch[a]); max[a] = Math.max(max[a], scratch[a]); }
      }
      const remaining = maxTriangles - (out.count - base), start = out.count;
      const dynamic = r.collision.collect(local, Math.max(1, remaining), out);
      if (!remaining && out.count > start) { out.count = start; return true; }
      overflow ||= dynamic;
      const d = out.data;
      for (let i = start; i < out.count; i++) {
        const o = i * 13;
        for (let k = 0; k < 9; k += 3) { rotateInto(scratch, 0, d[o + k], d[o + k + 1], d[o + k + 2], r.qx, r.qy, r.qz, r.qw); d[o + k] = r.px + scratch[0]; d[o + k + 1] = r.py + scratch[1]; d[o + k + 2] = r.pz + scratch[2]; }
        rotateInto(d, o + 9, d[o + 9], d[o + 10], d[o + 11], r.qx, r.qy, r.qz, r.qw);
      }
    }
    return overflow;
  }
  queryTriangles(bounds: TerrainQueryBounds, maxTriangles = 512): TerrainTriangleQuery {
    const overflow = this.collect(bounds, maxTriangles, soup.clear());
    return { triangles: soup.triangles(), overflow };
  }
}
