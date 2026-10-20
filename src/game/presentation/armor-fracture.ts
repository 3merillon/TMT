import type { MeshDesc, TankSurfaceMark } from '../../engine';
import type { PartMesh } from '../kit/types';
import { add, cross, dot, length, mul, normalize, sub } from '../math';
import type { V3 } from '../contracts';
import { pointTriangleDistanceSquared } from '../sphere-triangle';

/** Subdivide only struck triangles, then fold the steel inward and lift an irregular torn rim.
 * Never mutates shared kit geometry. The cap bounds both saved damage and generated geometry. */
type PaintedPart = PartMesh & Pick<MeshDesc, 'paintTexture'>;
export function fractureArmor(part: PaintedPart, marks: readonly TankSurfaceMark[]): PaintedPart {
  const scars = marks.filter(m => m.damage).slice(-8);
  if (!scars.length || part.instances) return part;
  const p: number[] = [], n: number[] = [], local: number[] = [], attrs: number[] = [], axes: number[] = [], uv: number[] = [];
  const triangle = new Float64Array(9);
  const deform = (v: V3): V3 => {
    let out: V3 = [...v];
    for (const m of scars) {
      const delta = sub(v, m.position), depth = dot(delta, m.normal);
      if (Math.abs(depth) > m.radius * .2) continue;
      const tangent = sub(delta, mul(m.normal, depth)), r = length(tangent) / m.radius;
      if (r >= 1) continue;
      const axis = normalize(cross(m.normal, Math.abs(m.normal[1]) > .85 ? [1, 0, 0] : [0, 1, 0]));
      const angle = Math.atan2(dot(tangent, cross(m.normal, axis)), dot(tangent, axis));
      const torn = 1 + .12 * Math.sin(angle * 7 + .5) + .07 * Math.sin(angle * 13);
      const q = r * torn, cavity = Math.max(0, 1 - q / .68);
      const lip = Math.max(0, 1 - Math.abs(q - .7) / .18);
      out = add(out, mul(m.normal, m.radius * (-.23 * cavity * cavity + .055 * lip) * m.opacity));
    }
    return out;
  };
  type Vertex = { p: V3; n: V3; local: V3; attr: number; axis: number; uv: [number, number] };
  const midpoint = (a: Vertex, b: Vertex): Vertex => ({ p: mul(add(a.p, b.p), .5), n: normalize(add(a.n, b.n)),
    local: mul(add(a.local, b.local), .5), attr: ((a.attr & 0xffff0000) | Math.round(((a.attr & 255) + (b.attr & 255)) * .5)
      | Math.round((((a.attr >>> 8) & 255) + ((b.attr >>> 8) & 255)) * .5) << 8) >>> 0, axis: a.axis, uv: [(a.uv[0] + b.uv[0]) * .5, (a.uv[1] + b.uv[1]) * .5] });
  const emit = (va: Vertex, vb: Vertex, vc: Vertex, normal: V3, depth: number): void => {
    const [a, b, c] = [va.p, vb.p, vc.p];
    triangle.set(a, 0); triangle.set(b, 3); triangle.set(c, 6);
    const affected = scars.find(m => dot(normal, m.normal) > .5 && pointTriangleDistanceSquared(m.position, triangle, 0, 3, 6) < m.radius ** 2);
    const extent = Math.max(length(sub(a, b)), length(sub(b, c)), length(sub(c, a)));
    if (affected && depth < 5 && extent > affected.radius * .4 && p.length < part.positions.length * 3 + 45_000) {
      const ab = midpoint(va, vb), bc = midpoint(vb, vc), ca = midpoint(vc, va);
      emit(va, ab, ca, normal, depth + 1); emit(ab, vb, bc, normal, depth + 1);
      emit(ca, bc, vc, normal, depth + 1); emit(ab, bc, ca, normal, depth + 1); return;
    }
    const vertices = affected ? [deform(a), deform(b), deform(c)] : [a, b, c];
    const norm = affected ? normalize(cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0]))) : null;
    for (let i = 0; i < 3; i++) {
      const source = [va, vb, vc][i];
      p.push(...vertices[i]); n.push(...(norm ?? source.n)); local.push(...source.local); attrs.push(source.attr); axes.push(source.axis); uv.push(...source.uv);
    }
  };
  for (let i = 0; i < part.indices.length; i += 3) {
    const ids = [part.indices[i], part.indices[i + 1], part.indices[i + 2]];
    const vec = (array: Float32Array, id: number): V3 => Array.from(array.subarray(id * 3, id * 3 + 3)) as V3;
    const vertices = ids.map(id => ({ p: vec(part.positions, id), n: vec(part.normals, id), local: vec(part.partLocal, id), attr: part.attrs[id], axis: part.primAxis[id], uv: [part.paintTexture?.uv[id * 2] ?? 0, part.paintTexture?.uv[id * 2 + 1] ?? 0] as [number, number] }));
    const normal = normalize(cross(sub(vertices[1].p, vertices[0].p), sub(vertices[2].p, vertices[0].p)));
    emit(vertices[0], vertices[1], vertices[2], normal, 0);
  }
  return { ...part, ...(part.paintTexture ? { paintTexture: { ...part.paintTexture, uv: new Float32Array(uv) } } : {}), positions: new Float32Array(p), normals: new Float32Array(n), partLocal: new Float32Array(local),
    attrs: new Uint32Array(attrs), primAxis: new Uint32Array(axes), indices: Uint32Array.from({ length: p.length / 3 }, (_, i) => i) };
}

/** Closed jagged steel splinters at the accepted skin contact, in that part's joint coordinates. */
export function armorSplinters(mark: TankSurfaceMark): MeshDesc[] {
  const up = mark.normal, x = normalize(cross(up, Math.abs(up[1]) > .85 ? [1, 0, 0] : [0, 1, 0])), y = cross(up, x);
  return Array.from({ length: 5 }, (_, i) => {
    const a = i * Math.PI * 2 / 5, radius = mark.radius * (.35 + .1 * Math.sin(i * 7));
    const at = (angle: number, r: number) => add(mark.position, add(mul(x, Math.cos(angle) * r), mul(y, Math.sin(angle) * r)));
    const front = [at(a, radius * .25), at(a + .25, radius), at(a + 1.0, radius * .8)];
    const corners = [...front, ...front.map(v => sub(v, mul(up, .018)))];
    const positions: number[] = [], normals: number[] = [];
    for (const face of [[0, 1, 2], [5, 4, 3], [0, 3, 4], [0, 4, 1], [1, 4, 5], [1, 5, 2], [2, 5, 3], [2, 3, 0]]) {
      const [a, b, c] = face.map(k => corners[k]), normal = normalize(cross(sub(b, a), sub(c, a)));
      positions.push(...a, ...b, ...c); normals.push(...normal, ...normal, ...normal);
    }
    return { positions: new Float32Array(positions), normals: new Float32Array(normals), matId: 3,
      indices: Uint32Array.from({ length: positions.length / 3 }, (_, k) => k), label: 'fractured-armor' };
  });
}
