/** A small immutable spatial grid prevents selecting a tank through authored room geometry. */
import type { MeshDesc, Vec3 } from '../../engine';

function triangleDistance(mesh: MeshDesc, index: number, origin: Vec3, dir: Vec3): number {
  const p = mesh.positions, ids = mesh.indices, a = ids[index] * 3, b = ids[index + 1] * 3, c = ids[index + 2] * 3;
  const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
  const h = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-9) return Infinity;
  const inv = 1 / det, s = [origin[0] - p[a], origin[1] - p[a + 1], origin[2] - p[a + 2]], u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return distance > .001 ? distance : Infinity;
}

export class RoomPickingGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly references: Uint32Array;
  constructor(private readonly meshes: readonly MeshDesc[]) {
    this.references = new Uint32Array(meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0) * 2);
    let face = 0;
    meshes.forEach((mesh, mi) => {
      const p = mesh.positions;
      for (let i = 0; i < mesh.indices.length; i += 3, face++) {
        this.references[face * 2] = mi; this.references[face * 2 + 1] = i;
        const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3;
        const lo = [0, 1, 2].map(k => Math.floor(Math.min(p[a + k], p[b + k], p[c + k]) - .00001));
        const hi = [0, 1, 2].map(k => Math.floor(Math.max(p[a + k], p[b + k], p[c + k]) + .00001));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
          const key = `${x},${y},${z}`, list = this.cells.get(key);
          if (list) list.push(face); else this.cells.set(key, [face]);
        }
      }
    });
  }
  occludes(origin: Vec3, direction: Vec3, distance: number): boolean {
    return this.distance(origin, direction, distance - .004) !== null;
  }
  /** First real room triangle along a camera boom or picking ray. */
  distance(origin: Vec3, direction: Vec3, distance: number): number | null {
    if (!Number.isFinite(distance) || distance <= 0) return null;
    const cell = origin.map(Math.floor), step = direction.map(v => v >= 0 ? 1 : -1);
    const delta = direction.map(v => Math.abs(v) > 1e-10 ? 1 / Math.abs(v) : Infinity);
    const next = direction.map((v, i) => Math.abs(v) > 1e-10 ? (cell[i] + (step[i] > 0 ? 1 : 0) - origin[i]) / v : Infinity);
    const seen = new Set<number>();
    let closest = distance;
    for (let walked = 0, count = 0; walked < closest && count < 128; count++) {
      for (const face of this.cells.get(cell.join(',')) ?? []) {
        if (seen.has(face)) continue; seen.add(face);
        const hit = triangleDistance(this.meshes[this.references[face * 2]], this.references[face * 2 + 1], origin, direction);
        if (hit < closest) closest = hit;
      }
      const axis = next[0] < next[1] ? next[0] < next[2] ? 0 : 2 : next[1] < next[2] ? 1 : 2;
      walked = next[axis]; cell[axis] += step[axis]; next[axis] += delta[axis];
    }
    return closest < distance ? closest : null;
  }
}
