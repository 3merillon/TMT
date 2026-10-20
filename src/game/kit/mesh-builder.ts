/**
 * `buildKitMesh` v2 (W1-KIT): renderer-agnostic PartMesh data for an assembly and LOD. No three.
 *
 * One PartMesh per rigid group (hull, turret, hatch, cradle, barrel and the utility head) with matId per vertex,
 * and one per repeated running-gear part (links, wheels, hubs, sprockets, idlers, rollers, arms, bogies,
 * springs, tensioners) carrying rest-pose `instances` (CC-003 layout: 12 floats, rows of a 3×4 affine). Draws
 * per tank = parts ≤ 16 (budget 24).
 *
 * Attributes (plan §5.3): positions in the joint frame; `partLocal` = tank-local rest position for rigid parts
 * and mesh-local for repeated parts; `primAxis` = oct snorm16x2 of the turned axis (z ≤ 0, 0 = none);
 * `attrs` = edge | ao << 8 | matId << 16 | flags << 24 with the AO baked per assembly from the proxy boxes,
 * the running-gear envelope and the ground (cached with the mesh by key). LOD0/1/2 come from the part builders
 * at detail 1 / 0.5 / 0.25 (progressively fewer segments; LOD2 draws every other link at
 * double pitch, so its links PartMesh has half the instances and `kitInstanceSource` returns the leading slots).
 * Results are cached and shared: treat them as immutable. Pure (no clocks or randomness).
 */
import { kitRunningEnvelope } from './assembly';
import { kitContext, kitGeometry } from './build';
import { KIT_FLAG, MeshBuilder } from './geometry/mesh';
import { applyDir, applyPoint, fromQuat, mul, type Mat4, type Vec3 } from './geometry/math';
import type { GroupId, InstancedGroup, KitContext, RigidGroup } from './parts/types';
import { INSTANCED_GROUPS } from './parts/types';
import { createRigPose, poseRig, restState } from './rig';
import { gearRig, lod2LinkInstances } from './running';
import { GROUND_Y } from './sockets';
import type { KitAssembly, KitMeshData, PartMesh } from './types';

export { KIT_FLAG };
/** Floats per instance matrix (affine 3×4, row-major). */
export const INSTANCE_FLOATS = 12;

/** Oct-encode a direction as snorm16x2 (x low, y high). Axis sign is canonicalised to z ≤ 0; 0 = none. */
export function encodeAxis(x: number, y: number, z: number): number {
  if (x === 0 && y === 0 && z === 0) return 0;
  if (z > 0) { x = -x; y = -y; z = -z; }
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let u = x / l1, v = y / l1;
  if (z < 0) { const ou = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1), ov = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1); u = ou; v = ov; }
  const snorm = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 32767) & 0xffff;
  const packed = (snorm(u) | (snorm(v) << 16)) >>> 0;
  return packed === 0 ? 1 : packed; // never collide with "no axis"
}
/** Inverse of `encodeAxis` (the canonical z ≤ 0 direction), or null for 0. */
export function decodeAxis(packed: number): [number, number, number] | null {
  if (packed === 0) return null;
  const unsnorm = (bits: number) => Math.max(-1, ((bits << 16) >> 16) / 32767);
  let u = unsnorm(packed & 0xffff), v = unsnorm(packed >>> 16);
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) { const ou = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1), ov = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1); u = ou; v = ov; }
  const length = Math.hypot(u, v, z);
  return [u / length, v / length, z / length];
}

/** Write a column-major mat4 as a 3×4 instance row block. */
export function writeInstance(out: Float32Array, index: number, m: ArrayLike<number>): void {
  const o = index * INSTANCE_FLOATS;
  out[o] = m[0]; out[o + 1] = m[4]; out[o + 2] = m[8]; out[o + 3] = m[12];
  out[o + 4] = m[1]; out[o + 5] = m[5]; out[o + 6] = m[9]; out[o + 7] = m[13];
  out[o + 8] = m[2]; out[o + 9] = m[6]; out[o + 10] = m[10]; out[o + 11] = m[14];
}

/** Expand instance `index` of a 3×4 instance buffer into a column-major mat4. */
export function instanceMatrix(source: Float32Array, index: number, out: Float64Array = new Float64Array(16)): Float64Array {
  const o = index * INSTANCE_FLOATS;
  out[0] = source[o]; out[4] = source[o + 1]; out[8] = source[o + 2]; out[12] = source[o + 3];
  out[1] = source[o + 4]; out[5] = source[o + 5]; out[9] = source[o + 6]; out[13] = source[o + 7];
  out[2] = source[o + 8]; out[6] = source[o + 9]; out[10] = source[o + 10]; out[14] = source[o + 11];
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
  return out;
}

/** Joint a rigid group is posed by (the head's joint is named after its utility). */
export function groupJoint(ctx: KitContext, group: RigidGroup): string {
  if (group !== 'head') return group;
  return ctx.utility.head === 'spring2' ? 'antenna' : ctx.utility.head === 'spin' ? 'radar' : ctx.utility.head === 'pitch' ? 'periscope' : 'turret';
}

/** Order of the non-link repeated parts inside KitPose.wheelInstances ('hubs' share the wheel slice). */
export const WHEEL_BUFFER_ORDER: readonly InstancedGroup[] = Object.freeze(['wheels', 'sprockets', 'idlers', 'rollers', 'arms', 'bogies', 'springs', 'tensioners']);

/** Slice of `wheelInstances` holding a group's instances. */
export function wheelSlice(ctx: KitContext, group: InstancedGroup): { first: number; count: number } {
  const counts = gearRig(ctx.gear).layout.counts;
  const g = group === 'hubs' ? 'wheels' : group;
  let first = 0;
  for (const k of WHEEL_BUFFER_ORDER) { if (k === g) return { first, count: counts[k] }; first += counts[k]; }
  return { first: 0, count: 0 };
}

// ---------------------------------------------------------------------------------------------
// Ambient occlusion (baked per assembly)
// ---------------------------------------------------------------------------------------------

interface Occluder { center: Vec3; half: Vec3; axes: Vec3[] }

function occluders(a: KitAssembly): Occluder[] {
  const ctx = kitContext(a.loadout), pose = createRigPose();
  poseRig(ctx, restState(ctx), pose);
  const out: Occluder[] = [];
  for (const { box, parent } of a.proxies) {
    const m = parent === 'hull' ? pose.joints.hull : parent === 'turret' ? pose.joints.turret : pose.joints.cradle;
    const local = mul(m, fromQuat(box.rotation ?? [0, 0, 0, 1], box.center));
    out.push({ center: [local[12], local[13], local[14]], half: [...box.half] as Vec3, axes: [applyDir(local, 1, 0, 0), applyDir(local, 0, 1, 0), applyDir(local, 0, 0, 1)] });
  }
  for (const b of kitRunningEnvelope(a, restState(ctx).wheelY)) out.push({ center: [...b.center] as Vec3, half: [...b.half] as Vec3, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
  return out;
}

/** 0..1 visibility of a surface point from nearby occluder boxes and the ground. */
function visibility(p: Vec3, n: Vec3, occ: readonly Occluder[]): number {
  let o = 0;
  for (const b of occ) {
    const dx = p[0] - b.center[0], dy = p[1] - b.center[1], dz = p[2] - b.center[2];
    let qx = b.center[0], qy = b.center[1], qz = b.center[2], inside = true;
    for (let k = 0; k < 3; k++) {
      const ax = b.axes[k], t = dx * ax[0] + dy * ax[1] + dz * ax[2], c = Math.max(-b.half[k], Math.min(b.half[k], t));
      if (c !== t) inside = false;
      qx += ax[0] * c; qy += ax[1] * c; qz += ax[2] * c;
    }
    if (inside) continue; // the point's own part
    const vx = qx - p[0], vy = qy - p[1], vz = qz - p[2], dist = Math.hypot(vx, vy, vz);
    if (dist < 0.003 || dist > 0.3) continue;
    const facing = (vx * n[0] + vy * n[1] + vz * n[2]) / dist;
    if (facing <= 0.05) continue;
    const size = Math.min(1, (b.half[0] + b.half[1] + b.half[2]) * 1.5);
    o += facing * size * 0.5 / (1 + (dist / 0.05) ** 2);
  }
  // Ground contact shadowing for low, downward-facing surfaces.
  const h = p[1] - GROUND_Y;
  if (h < 0.35) o += Math.max(0, -n[1]) * 0.55 * (1 - h / 0.35);
  return Math.max(0.2, 1 - Math.min(0.8, o));
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function toPartMesh(part: string, joint: string, lod: 0 | 1 | 2, mb: MeshBuilder, rest: Mat4 | null, ao: (p: Vec3, n: Vec3) => number, instances?: Float32Array): PartMesh {
  const count = mb.vertexCount;
  const positions = Float32Array.from(mb.p), normals = Float32Array.from(mb.n);
  const partLocal = new Float32Array(count * 3), primAxis = new Uint32Array(count), attrs = new Uint32Array(count);
  const p: Vec3 = [0, 0, 0], n: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    if (rest) { applyPoint(rest, mb.p[o], mb.p[o + 1], mb.p[o + 2], p); applyDir(rest, mb.n[o], mb.n[o + 1], mb.n[o + 2], n); }
    else { p[0] = mb.p[o]; p[1] = mb.p[o + 1]; p[2] = mb.p[o + 2]; n[0] = mb.n[o]; n[1] = mb.n[o + 1]; n[2] = mb.n[o + 2]; }
    partLocal[o] = p[0]; partLocal[o + 1] = p[1]; partLocal[o + 2] = p[2];
    primAxis[i] = encodeAxis(mb.axis[o], mb.axis[o + 1], mb.axis[o + 2]);
    const aoByte = Math.round(Math.max(0, Math.min(1, ao(p, n))) * 255);
    const flags = mb.flags[i] | (primAxis[i] ? KIT_FLAG.turned : 0);
    attrs[i] = ((mb.edge[i] & 255) | (aoByte & 255) << 8 | (mb.mat[i] & 255) << 16 | (flags & 255) << 24) >>> 0;
  }
  return { part, joint, lod, positions, normals, partLocal, primAxis, attrs, indices: Uint32Array.from(mb.idx), ...(instances ? { instances } : {}) };
}

const cache = new Map<string, KitMeshData>();

/** Renderer-agnostic kit geometry for an assembly (cached per key and LOD). */
export function buildKitMesh(a: KitAssembly, lod: 0 | 1 | 2): KitMeshData {
  const cacheKey = `${a.key}#${lod}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const ctx = kitContext(a.loadout), geo = kitGeometry(ctx, lod);
  const pose = createRigPose();
  poseRig(ctx, restState(ctx), pose);
  const occ = occluders(a);
  const ao = (p: Vec3, n: Vec3) => visibility(p, n, occ);
  const parts: PartMesh[] = [];
  const merged = (group: GroupId): MeshBuilder | null => {
    const shapes = geo.groups.get(group);
    if (!shapes?.length) return null;
    const mb = new MeshBuilder();
    for (const s of shapes) mb.append(s.mb);
    return mb.vertexCount ? mb : null;
  };
  for (const group of ['hull', 'turret', 'hatch', 'cradle', 'barrel', 'head'] as RigidGroup[]) {
    const mb = merged(group);
    if (mb) parts.push(toPartMesh(group, groupJoint(ctx, group), lod, mb, pose.joints[group], ao));
  }
  for (const group of INSTANCED_GROUPS) {
    const mb = merged(group);
    if (!mb) continue;
    const all = pose.instances[group === 'hubs' ? 'wheels' : group];
    // LOD2 links: the leading even-link slots, drawn at double pitch (running.ts linkSlot).
    const list = group === 'links' && lod === 2 ? all.slice(0, lod2LinkInstances(gearRig(ctx.gear).layout.linkCount)) : all;
    const instances = new Float32Array(list.length * INSTANCE_FLOATS);
    list.forEach((m, i) => writeInstance(instances, i, m));
    // Repeated parts share one mesh: a mesh-local AO (faces toward the hull and the belt's inner face darker).
    const localAo = (_p: Vec3, n: Vec3) => Math.max(0.35, 1 - (group === 'links' ? Math.max(0, -n[1]) * 0.45 : Math.max(0, -n[0]) * 0.4) - Math.max(0, -n[1]) * 0.15);
    parts.push(toPartMesh(group, 'hull', lod, mb, null, localAo, instances));
  }
  const data: KitMeshData = { key: a.key, parts };
  cache.set(cacheKey, data);
  return data;
}

/** Triangles one tank renders at a LOD (instances included) and its draw count (one draw per part). */
export function kitMeshBudget(mesh: KitMeshData): { triangles: number; draws: number } {
  let triangles = 0;
  for (const p of mesh.parts) triangles += p.indices.length / 3 * (p.instances ? p.instances.length / INSTANCE_FLOATS : 1);
  return { triangles, draws: mesh.parts.length };
}
