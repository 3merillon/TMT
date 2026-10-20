/** Small owned mesh collection. Uses the kit's CAD primitives and procedural metal attributes. */
import { GBUFFER_FLAG, type InstanceHandle, type MeshDesc, type MeshHandle, type SceneRegistry, type Vec3 } from '../../engine';
import { box, cylinder, Shape } from '../kit/geometry/shapes';
import { basis, chain, lookAlong, norm, rotX, rotY, rotZ, scaleM, translate } from '../kit/geometry/math';
import { encodeAxis } from '../kit/mesh-builder';

export const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function transform(position: Vec3, size: Vec3 = [1, 1, 1], rotation: Vec3 = [0, 0, 0]): Float32Array {
  return Float32Array.from(chain(translate(...position), rotY(rotation[1]), rotX(rotation[0]), rotZ(rotation[2]), scaleM(...size)));
}
export function cylinderTransform(a: Vec3, b: Vec3, radius: number): Float32Array {
  const d = sub(b, a), length = Math.max(.00001, Math.hypot(...d));
  return Float32Array.from(chain(lookAlong(a, norm(d)), scaleM(radius, radius, length)));
}
export function shapeMesh(s: Shape, label: string): MeshDesc {
  const m = s.mb;
  return { positions: Float32Array.from(m.p), normals: Float32Array.from(m.n), indices: Uint32Array.from(m.idx),
    partLocal: Float32Array.from(m.p), attrs: Uint32Array.from(m.mat, (mat, i) => (m.edge[i] | 235 << 8 | (mat === 0 ? 18 : mat === 4 ? 19 : mat) << 16 | m.flags[i] << 24) >>> 0),
    primAxis: Uint32Array.from(m.mat, (_, i) => encodeAxis(m.axis[i * 3], m.axis[i * 3 + 1], m.axis[i * 3 + 2])), label };
}

export class WorkshopGeometry {
  private readonly meshes = new Map<string, MeshHandle>();
  private readonly instances = new Set<InstanceHandle>();
  private readonly meshData = new Map<number, { desc: MeshDesc; min: Vec3; max: Vec3 }>();
  private readonly picking = new Map<InstanceHandle, { mesh: number; model: Float32Array; visible: boolean }>();
  private remember(mesh: MeshHandle, desc: MeshDesc): void {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < desc.positions.length; i++) { const a = i % 3; min[a] = Math.min(min[a], desc.positions[i]); max[a] = Math.max(max[a], desc.positions[i]); }
    this.meshData.set(mesh.id, { desc, min, max });
  }
  constructor(private readonly scene: SceneRegistry, private readonly origin: Vec3 = [0, 0, 0]) {}
  private worldModel(model: Float32Array): Float32Array {
    const world = new Float32Array(model);
    for (let axis = 0; axis < 3; axis++) world[12 + axis] += this.origin[axis];
    return world;
  }
  private mesh(kind: 'box' | 'cylinder', mat: number): MeshHandle {
    const key = `${kind}:${mat}`;
    let mesh = this.meshes.get(key);
    if (!mesh) {
      const shape = new Shape().material(mat); shape.noHull = true;
      if (kind === 'box') box(shape, null, [1, 1, 1], .045);
      else cylinder(shape, null, [0, 0, 0], [0, 0, 1], 1, 20);
      const desc = shapeMesh(shape, `workshop:${key}`);
      mesh = this.scene.meshes.create(desc); this.meshes.set(key, mesh); this.remember(mesh, desc);
    }
    return mesh;
  }
  addMesh(desc: MeshDesc, model: Float32Array = IDENTITY, tint: Vec3 = [.22, .3, .28]): InstanceHandle {
    const mesh = this.scene.meshes.create(desc); this.meshes.set(`custom:${mesh.id}`, mesh); this.remember(mesh, desc);
    return this.instance(mesh, model, tint);
  }
  private instance(mesh: MeshHandle, model: Float32Array, tint: Vec3): InstanceHandle {
    const world = this.worldModel(model);
    const handle = this.scene.instances.add(mesh, { model: world, tint, objectId: 80 }); this.instances.add(handle);
    this.picking.set(handle, { mesh: mesh.id, model: world, visible: true }); return handle;
  }
  box(position: Vec3, size: Vec3, mat = 1, tint: Vec3 = [.25, .32, .28]): InstanceHandle {
    return this.instance(this.mesh('box', mat), transform(position, size), tint);
  }
  cylinder(a: Vec3, b: Vec3, radius: number, mat = 4, tint: Vec3 = [.25, .32, .28]): InstanceHandle {
    return this.instance(this.mesh('cylinder', mat), cylinderTransform(a, b, radius), tint);
  }
  torus(position: Vec3, radius: number, tube: number, mat = 4, rotation: Vec3 = [0, 0, 0]): InstanceHandle {
    const s = new Shape().material(mat); s.noHull = true;
    const major = 32, minor = 8;
    for (let i = 0; i <= major; i++) for (let j = 0; j <= minor; j++) {
      const u = i / major * Math.PI * 2, v = j / minor * Math.PI * 2, cv = Math.cos(v), sv = Math.sin(v);
      s.mb.vertex((radius + tube * cv) * Math.cos(u), (radius + tube * cv) * Math.sin(u), tube * sv, cv * Math.cos(u), cv * Math.sin(u), sv, 80);
      if (i < major && j < minor) { const a = i * (minor + 1) + j; s.mb.quad(a, a + minor + 1, a + minor + 2, a + 1); }
    }
    return this.addMesh(shapeMesh(s, 'workshop:torus'), transform(position, [1, 1, 1], rotation));
  }
  setBox(handle: InstanceHandle, position: Vec3, size: Vec3, rotation: Vec3 = [0, 0, 0]): void {
    this.setTransform(handle, transform(position, size, rotation));
  }
  setTransform(handle: InstanceHandle, model: Float32Array): void {
    const world = this.worldModel(model);
    this.scene.instances.set(handle, world); const entry = this.picking.get(handle); if (entry) entry.model = world;
  }
  highlight(handle: InstanceHandle, selected: boolean): void {
    const entry = this.picking.get(handle);
    if (entry) this.scene.instances.set(handle, entry.model, selected ? GBUFFER_FLAG.SELECTED : 0);
  }
  /** A copy for mechanisms that preserve the shape's authored dimensions while moving its parent frame. */
  modelOf(handle: InstanceHandle): Float32Array {
    const item = this.picking.get(handle);
    if (!item) throw new Error('Unknown workshop instance.');
    const local = new Float32Array(item.model);
    for (let axis = 0; axis < 3; axis++) local[12 + axis] -= this.origin[axis];
    return local;
  }
  setCylinder(handle: InstanceHandle, a: Vec3, b: Vec3, radius: number): void { this.setTransform(handle, cylinderTransform(a, b, radius)); }
  /** A rectangular beam between two fixed attachment centres. */
  setBeam(handle: InstanceHandle, a: Vec3, b: Vec3, width: number, depth: number, lateral?: Vec3): void {
    const z = norm(sub(b, a));
    const m = lateral ? basis(lateral, norm([z[1] * lateral[2] - z[2] * lateral[1], z[2] * lateral[0] - z[0] * lateral[2], z[0] * lateral[1] - z[1] * lateral[0]]), z, lerp(a, b, .5)) : lookAlong(lerp(a, b, .5), z);
    this.setTransform(handle, Float32Array.from(chain(m, scaleM(width, depth, Math.hypot(...sub(b, a))))));
  }
  visibility(handle: InstanceHandle, visible: boolean): void {
    this.scene.instances.setVisibility(handle, visible ? 1 : 0); const entry = this.picking.get(handle); if (entry) entry.visible = visible;
  }
  /** Broad-phase local box followed by exact rendered triangles; holes between robot forks remain pickable. */
  occludes(origin: Vec3, direction: Vec3, distance: number): boolean {
    for (const entry of this.picking.values()) {
      if (!entry.visible) continue;
      const data = this.meshData.get(entry.mesh)!, m = entry.model, delta = sub(origin, [m[12], m[13], m[14]]);
      const o: Vec3 = [0, 0, 0], d: Vec3 = [0, 0, 0];
      for (let a = 0; a < 3; a++) { const i = a * 4, length2 = m[i] ** 2 + m[i + 1] ** 2 + m[i + 2] ** 2;
        o[a] = (delta[0] * m[i] + delta[1] * m[i + 1] + delta[2] * m[i + 2]) / length2;
        d[a] = (direction[0] * m[i] + direction[1] * m[i + 1] + direction[2] * m[i + 2]) / length2;
      }
      let near = 0, far = distance;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(d[a]) < 1e-12) { if (o[a] < data.min[a] || o[a] > data.max[a]) { far = -1; break; } }
        else { const t0 = (data.min[a] - o[a]) / d[a], t1 = (data.max[a] - o[a]) / d[a]; near = Math.max(near, Math.min(t0, t1)); far = Math.min(far, Math.max(t0, t1)); }
      }
      if (far < near) continue;
      const { positions: p, indices } = data.desc;
      for (let i = 0; i < indices.length; i += 3) {
        const ai = indices[i] * 3, bi = indices[i + 1] * 3, ci = indices[i + 2] * 3;
        const ex = p[bi] - p[ai], ey = p[bi + 1] - p[ai + 1], ez = p[bi + 2] - p[ai + 2];
        const fx = p[ci] - p[ai], fy = p[ci + 1] - p[ai + 1], fz = p[ci + 2] - p[ai + 2];
        const px = d[1] * fz - d[2] * fy, py = d[2] * fx - d[0] * fz, pz = d[0] * fy - d[1] * fx;
        const det = ex * px + ey * py + ez * pz; if (Math.abs(det) < 1e-10) continue;
        const tx = o[0] - p[ai], ty = o[1] - p[ai + 1], tz = o[2] - p[ai + 2];
        const u = (tx * px + ty * py + tz * pz) / det; if (u < 0 || u > 1) continue;
        const qx = ty * ez - tz * ey, qy = tz * ex - tx * ez, qz = tx * ey - ty * ex;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det; if (v < 0 || u + v > 1) continue;
        const t = (fx * qx + fy * qy + fz * qz) / det; if (t > 0 && t < distance - .002) return true;
      }
    }
    return false;
  }
  dispose(): void {
    for (const h of this.instances) this.scene.instances.remove(h);
    for (const h of this.meshes.values()) this.scene.meshes.destroy(h);
    this.instances.clear(); this.meshes.clear(); this.picking.clear(); this.meshData.clear();
  }
}
