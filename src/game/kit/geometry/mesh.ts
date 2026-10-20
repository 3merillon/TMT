/**
 * Kit v2 mesh accumulation (W1-KIT). A `MeshBuilder` collects indexed triangles with the per-vertex kit
 * attributes the procedural metals need (plan §5.3 PartMesh):
 * - `edge` (0..255): chamfer and silhouette strength, for edge wear;
 * - `axis`: the axis of a turned (lathe) primitive, zero for flat ones (becomes `primAxis`);
 * - `mat` (MatId) and `flags` (KIT_FLAG bits).
 * Positions are authored in the part's joint frame. Pure, no three.
 */
import { applyDir, applyPoint, type Mat4, type Vec3 } from './math';

export const KIT_FLAG = Object.freeze({ highlight: 1, turned: 2, headlight: 4 });

export class MeshBuilder {
  p: number[] = [];
  n: number[] = [];
  edge: number[] = [];
  axis: number[] = [];
  mat: number[] = [];
  flags: number[] = [];
  idx: number[] = [];
  /** Current attribute state applied to new vertices. */
  curMat = 0;
  curFlags = 0;
  curEdge = 0;
  curAxis: Vec3 = [0, 0, 0];

  get vertexCount(): number { return this.p.length / 3; }
  get triangleCount(): number { return this.idx.length / 3; }

  /** Set the material (and optional flags) for subsequent vertices; returns this for chaining. */
  material(mat: number, flags = 0): this { this.curMat = mat; this.curFlags = flags; return this; }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, edge = this.curEdge, axis: Readonly<Vec3> = this.curAxis): number {
    this.p.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.n.push(nx / l, ny / l, nz / l);
    this.edge.push(edge);
    this.axis.push(axis[0], axis[1], axis[2]);
    this.mat.push(this.curMat);
    this.flags.push(this.curFlags | (axis[0] || axis[1] || axis[2] ? KIT_FLAG.turned : 0));
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }

  /**
   * A flat convex polygon (counter-clockwise seen from outside), with its own vertices and face normal.
   * `outward`, when given, flips the winding if needed so the normal points along it.
   */
  poly(points: readonly Readonly<Vec3>[], edge = this.curEdge, outward?: Readonly<Vec3>): void {
    if (points.length < 3) return;
    let nx = 0, ny = 0, nz = 0;
    // Newell's method: robust for slightly non-planar polygons.
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    let pts = points;
    if (outward && nx * outward[0] + ny * outward[1] + nz * outward[2] < 0) { pts = [...points].reverse(); nx = -nx; ny = -ny; nz = -nz; }
    if (Math.hypot(nx, ny, nz) < 1e-14) return;
    const first = this.vertexCount;
    for (const q of pts) this.vertex(q[0], q[1], q[2], nx, ny, nz, edge, [0, 0, 0]);
    for (let i = 1; i < pts.length - 1; i++) this.tri(first, first + i, first + i + 1);
  }

  /** Append another builder, optionally transformed. */
  append(other: MeshBuilder, m?: Mat4): void {
    const base = this.vertexCount, v: Vec3 = [0, 0, 0], d: Vec3 = [0, 0, 0];
    for (let i = 0; i < other.vertexCount; i++) {
      const o = i * 3;
      if (m) {
        applyPoint(m, other.p[o], other.p[o + 1], other.p[o + 2], v); this.p.push(v[0], v[1], v[2]);
        applyDir(m, other.n[o], other.n[o + 1], other.n[o + 2], d);
        const l = Math.hypot(d[0], d[1], d[2]) || 1; this.n.push(d[0] / l, d[1] / l, d[2] / l);
        applyDir(m, other.axis[o], other.axis[o + 1], other.axis[o + 2], d);
        const la = Math.hypot(d[0], d[1], d[2]); this.axis.push(la ? d[0] / la : 0, la ? d[1] / la : 0, la ? d[2] / la : 0);
      } else {
        this.p.push(other.p[o], other.p[o + 1], other.p[o + 2]);
        this.n.push(other.n[o], other.n[o + 1], other.n[o + 2]);
        this.axis.push(other.axis[o], other.axis[o + 1], other.axis[o + 2]);
      }
      this.edge.push(other.edge[i]); this.mat.push(other.mat[i]); this.flags.push(other.flags[i]);
    }
    for (const index of other.idx) this.idx.push(index + base);
  }

  /** Transform vertices [from, end) in place. */
  transform(m: Mat4, from = 0): void {
    const v: Vec3 = [0, 0, 0];
    for (let i = from; i < this.vertexCount; i++) {
      const o = i * 3;
      applyPoint(m, this.p[o], this.p[o + 1], this.p[o + 2], v); this.p[o] = v[0]; this.p[o + 1] = v[1]; this.p[o + 2] = v[2];
      applyDir(m, this.n[o], this.n[o + 1], this.n[o + 2], v);
      let l = Math.hypot(v[0], v[1], v[2]) || 1; this.n[o] = v[0] / l; this.n[o + 1] = v[1] / l; this.n[o + 2] = v[2] / l;
      applyDir(m, this.axis[o], this.axis[o + 1], this.axis[o + 2], v);
      l = Math.hypot(v[0], v[1], v[2]); this.axis[o] = l ? v[0] / l : 0; this.axis[o + 1] = l ? v[1] / l : 0; this.axis[o + 2] = l ? v[2] / l : 0;
    }
  }

  /** Mirror a range across x = 0 (normals and winding fixed up). */
  mirrorX(from = 0): void {
    for (let i = from; i < this.vertexCount; i++) { this.p[i * 3] = -this.p[i * 3]; this.n[i * 3] = -this.n[i * 3]; this.axis[i * 3] = -this.axis[i * 3]; }
    const firstTri = this.idx.findIndex(index => index >= from);
    if (firstTri < 0) return;
    for (let t = Math.floor(firstTri / 3) * 3; t < this.idx.length; t += 3) {
      if (this.idx[t] < from) continue;
      const tmp = this.idx[t + 1]; this.idx[t + 1] = this.idx[t + 2]; this.idx[t + 2] = tmp;
    }
  }

  clone(): MeshBuilder {
    const c = new MeshBuilder();
    c.append(this);
    return c;
  }
}
