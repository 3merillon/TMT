/** Shared manufacturing vocabulary. Dimensions are metres in the tank frame (+Y up, +Z forward). */
import { Shape, axisFrame, box, cylinder, lathe, bolts, sweep } from '../kit/geometry/shapes';
import { translate, type Vec3 } from '../kit/geometry/math';
import { encodeAxis } from '../kit/mesh-builder';
import type { PartMesh } from '../kit/types';

export function shape(lod: 0 | 1 | 2): Shape {
  const s = new Shape(); s.noHull = true; s.detail = [1, .6, .3][lod]; return s;
}
export function finish(s: Shape, part: string, joint: string, lod: 0 | 1 | 2): PartMesh {
  const m = s.mb, attrs = new Uint32Array(m.vertexCount), primAxis = new Uint32Array(m.vertexCount);
  for (let i = 0; i < m.vertexCount; i++) {
    attrs[i] = m.edge[i] | (235 << 8) | (m.mat[i] << 16) | (m.flags[i] << 24);
    primAxis[i] = encodeAxis(m.axis[i * 3], m.axis[i * 3 + 1], m.axis[i * 3 + 2]);
  }
  return { part, joint, lod, positions: new Float32Array(m.p), normals: new Float32Array(m.n), partLocal: new Float32Array(m.p), primAxis, attrs, indices: new Uint32Array(m.idx) };
}
export function plate(s: Shape, p: Vec3, size: Vec3, material = 0, bevel = .012): void {
  s.material(material); box(s, translate(...p), size, bevel);
}
export function shaft(s: Shape, a: Vec3, b: Vec3, radius: number, material = 3, segments = 24): void {
  s.material(material); cylinder(s, null, a, b, radius, segments);
}
/** A machined annulus, with the bore retained at every LOD. Never a stack of solid discs. */
export function collar(s: Shape, a: Vec3, b: Vec3, outer: number, inner: number, material = 4, segments = 32): void {
  const f = axisFrame(a, b); s.material(material);
  lathe(s, f.m, [[outer, 0], [outer, f.length], [inner, f.length], [inner, 0], [outer, 0]], segments, { caps: [false, false], hullProfile: null });
}
export function fasteners(s: Shape, points: Vec3[], normal: Vec3, radius = .012, material = 3): void {
  if (s.coarse) return;
  s.material(material); bolts(s, null, points, normal, radius, radius * .6);
}
export function hose(s: Shape, path: Vec3[], radius = .014, material = 2): void {
  if (s.coarse) return;
  s.material(material); sweep(s, null, path, radius, 10, { bend: radius * 3 });
}
