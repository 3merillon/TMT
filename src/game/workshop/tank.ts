/** The production kit, separated by source component for inspection and physical servicing. */
import { GBUFFER_FLAG, type InstanceHandle, type MeshDesc, type MeshHandle, type SceneRegistry, type Vec3 } from '../../engine';
import type { TankState } from '../contracts';
import { assembleKit, buildKitMesh, createKitPose, kitInstanceSource, KIT_SLOTS, poseKit, validateKitLoadout, type KitAssembly, type KitLoadoutIdsLike, type SlotId } from '../kit';
import { kitContext, kitGeometry } from '../kit/build';
import { instanceMatrix } from '../kit/pose';
import { applyPoint, mul, rotX, rotY, rotZ, scaleM, translate, type Mat4 } from '../kit/geometry/math';
import type { TankAppearance } from '../meta/cosmetics';
import { tankSurface } from '../presentation/tank-surface';
import { paintedMesh } from '../presentation/paint-atlas';
import { VehicleLights } from '../presentation/vehicle-lights';
import { utilityIdle } from '../kit/utility-motion';
import { RailEnergy } from '../presentation/rail-energy';
import { reactiveArmorMeshes } from '../presentation/reactive-armor-mesh';
import { rayMeshDistance } from '../presentation/mesh-pick';
import type { PaintSurfaceHit } from './paint';
import type { GroupId } from '../kit/parts/types';
import type { SdfCasterHandle, SdfCasterInstance } from '../../engine/passes/sdf/sdf-casters';
import { add, IDENTITY } from './geometry';
import { WORKSHOP_TANK_ROOT, WORKSHOP_TANK_SCALE } from './dimensions';
import type { ServiceContact, PickupPole } from './gripper';

export interface ComponentBounds { min: Vec3; max: Vec3; center: Vec3 }
export interface ServiceGrip extends ServiceContact { anchor: Vec3; span: number }
export interface WorkshopMesh { slot: SlotId; group: string; joint: Float32Array; mesh: MeshDesc; paintPositions?: Float32Array }

/** Split production buffers at original builder boundaries; preserve geometry/pose and apply workshop tread finish. */
export function workshopKitMeshes(ids: KitLoadoutIdsLike, lod: 0 | 1 | 2 = 0): { assembly: KitAssembly; meshes: WorkshopMesh[] } {
  const assembly = assembleKit(validateKitLoadout(ids));
  const production = buildKitMesh(assembly, lod), source = kitGeometry(kitContext(assembly.loadout), lod);
  const pose = createKitPose(assembly);
  const state = { turretYaw: 0, barrelPitch: 0, recoil: 0, rotation: [0, 0, 0, 1], velocity: [0, 0, 0], yawVelocity: 0,
    trackPhases: [0, 0], trackSpeeds: [0, 0], wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-1.2), hatch: 0 };
  poseKit(assembly, state as unknown as TankState, pose);
  const meshes: WorkshopMesh[] = [];
  for (const part of production.parts) {
    const instanceSource = kitInstanceSource(assembly, part);
    const sourceInstances = instanceSource ? pose[instanceSource.buffer].slice(instanceSource.first * 12, (instanceSource.first + instanceSource.count) * 12) : part.instances;
    const instances = sourceInstances ? Float32Array.from(sourceInstances, (v, i) => i % 4 === 3 ? v * WORKSHOP_TANK_SCALE : v) : undefined;
    const joint = Float32Array.from(pose.joints.get(part.joint) ?? IDENTITY);
    for (const i of [12, 13, 14]) joint[i] *= WORKSHOP_TANK_SCALE;
    let vertices = 0, indices = 0;
    const batches = new Map<SlotId, { positions: number[]; normals: number[]; partLocal: number[]; attrs: number[]; primAxis: number[]; indices: number[] }>();
    for (const shape of source.groups.get(part.part as GroupId) ?? []) {
      const count = shape.mb.vertexCount, indexCount = shape.mb.idx.length, slot = source.owners.get(shape)!;
      if (count) {
        let batch = batches.get(slot); if (!batch) batches.set(slot, batch = { positions: [], normals: [], partLocal: [], attrs: [], primAxis: [], indices: [] });
        const base = batch.attrs.length;
        for (let i = vertices * 3; i < (vertices + count) * 3; i++) { batch.positions.push(part.positions[i] * WORKSHOP_TANK_SCALE); batch.normals.push(part.normals[i]); batch.partLocal.push(part.partLocal[i]); }
        for (let i = vertices; i < vertices + count; i++) {
          let attrs = part.attrs[i];
          // Service presentation: contact pads are rubber, shoe bodies dark oxidized steel. Production
          // kit data is immutable; only this copied presentation stream receives the material override.
          if (part.part === 'links') {
            const material = (attrs >>> 16) & 0xff;
            if (material === 1 || material === 3) attrs = (attrs & 0xff00ffff) | (material === 3 ? 2 : 20) << 16;
          }
          batch.attrs.push(attrs); batch.primAxis.push(part.primAxis[i]);
        }
        for (let i = indices; i < indices + indexCount; i++) batch.indices.push(part.indices[i] - vertices + base);
      }
      vertices += count; indices += indexCount;
    }
    for (const [slot, batch] of batches) meshes.push({ slot, group: part.part, joint, paintPositions: Float32Array.from(batch.positions, value => value / WORKSHOP_TANK_SCALE),
      mesh: { positions: Float32Array.from(batch.positions), normals: Float32Array.from(batch.normals), partLocal: Float32Array.from(batch.partLocal),
        attrs: Uint32Array.from(batch.attrs), primAxis: Uint32Array.from(batch.primAxis), indices: Uint32Array.from(batch.indices), instances, label: `workshop:tank:${slot}:${part.part}` } });
  }
  for (const { mesh: part } of reactiveArmorMeshes(assembly, lod)) {
    const joint = Float32Array.from(pose.joints.get('hull') ?? IDENTITY); for (const i of [12, 13, 14]) joint[i] *= WORKSHOP_TANK_SCALE;
    meshes.push({ slot: 'hull', group: part.part, joint, paintPositions: part.positions, mesh: { ...part, positions: Float32Array.from(part.positions, value => value * WORKSHOP_TANK_SCALE), label: `workshop:tank:hull:${part.part}` } });
  }
  return { assembly, meshes };
}

function emptyBounds(): ComponentBounds { return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], center: [0, 0, 0] }; }
function extend(bounds: ComponentBounds, p: Vec3): void { for (let i = 0; i < 3; i++) { bounds.min[i] = Math.min(bounds.min[i], p[i]); bounds.max[i] = Math.max(bounds.max[i], p[i]); } }
function triangleHit(origin: Vec3, dir: Vec3, data: Float32Array, offset: number): number {
  const ax = data[offset], ay = data[offset + 1], az = data[offset + 2];
  const e1x = data[offset + 3] - ax, e1y = data[offset + 4] - ay, e1z = data[offset + 5] - az;
  const e2x = data[offset + 6] - ax, e2y = data[offset + 7] - ay, e2z = data[offset + 8] - az;
  const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-9) return Infinity;
  const inv = 1 / det, tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 0 ? t : Infinity;
}
function hitsBounds(origin: Vec3, dir: Vec3, b: ComponentBounds): boolean {
  let near = 0, far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-10) { if (origin[i] < b.min[i] || origin[i] > b.max[i]) return false; continue; }
    const a = (b.min[i] - origin[i]) / dir[i], c = (b.max[i] - origin[i]) / dir[i];
    near = Math.max(near, Math.min(a, c)); far = Math.min(far, Math.max(a, c));
  }
  return near <= far;
}

export class WorkshopTank {
  readonly assembly: KitAssembly;
  readonly loadout: KitLoadoutIdsLike;
  private root: Vec3;
  private readonly entries: { slot: SlotId; group: string; data: MeshDesc; paintSource: MeshDesc; mesh: MeshHandle; instance: InstanceHandle; joint: Mat4; restJoint: Mat4; surfaceKey?: string }[] = [];
  private tint: Vec3;
  private appearanceKey = '';
  private readonly lights: VehicleLights;
  private readonly energy: RailEnergy;
  private animationTime = 0;
  private lightsOn = true;
  private readonly bounds = new Map<SlotId, ComponentBounds>();
  private readonly triangles = new Map<SlotId, Float32Array>();
  private readonly overheadSections = new Map<string, PickupPole[]>();
  private readonly supportSections = new Map<string, { point: Vec3; scale: number }>();
  private readonly offsets = new Map<SlotId, Vec3>();
  private readonly visible = new Set<SlotId>();
  private highlighted: SlotId | null = null;
  private readonly casters = new Map<SlotId, { brick: SdfCasterHandle; instance: SdfCasterInstance | null }>();
  constructor(private readonly scene: SceneRegistry, ids: KitLoadoutIdsLike, root: Vec3 = WORKSHOP_TANK_ROOT, slots: readonly SlotId[] = KIT_SLOTS, tint: Vec3 = [.25, .39, .3]) {
    const data = workshopKitMeshes(ids); this.assembly = data.assembly; this.loadout = { ...ids }; this.root = [...root]; this.tint = [...tint];
    this.lights = new VehicleLights(scene, this.assembly);
    this.energy = new RailEnergy(scene, this.assembly.loadout.weapon);
    const triangles = new Map<SlotId, number[]>();
    for (const slot of KIT_SLOTS) { this.bounds.set(slot, emptyBounds()); this.offsets.set(slot, [0, 0, 0]); triangles.set(slot, []); }
    for (const part of data.meshes) {
      // Bounds for every category remain available on a component-only trolley preview.
      const joint = Float64Array.from(part.joint), n = part.mesh.instances ? part.mesh.instances.length / 12 : 1;
      for (let i = 0; i < n; i++) {
        const matrix = part.mesh.instances ? mul(joint, instanceMatrix(part.mesh.instances, i)) : joint;
        const positions: Vec3[] = [];
        for (let v = 0; v < part.mesh.positions.length; v += 3) {
          const p = applyPoint(matrix, part.mesh.positions[v], part.mesh.positions[v + 1], part.mesh.positions[v + 2]);
          positions.push(p); extend(this.bounds.get(part.slot)!, p);
        }
        if (slots.includes(part.slot)) for (const index of part.mesh.indices) triangles.get(part.slot)!.push(...positions[index]);
      }
      if (!slots.includes(part.slot)) continue;
      const mesh = scene.meshes.create(part.mesh), instance = scene.instances.add(mesh, { model: IDENTITY, objectId: 100 + KIT_SLOTS.indexOf(part.slot), tint });
      this.entries.push({ slot: part.slot, group: part.group, data: part.mesh, paintSource: { ...part.mesh, positions: part.paintPositions ?? Float32Array.from(part.mesh.positions, value => value / WORKSHOP_TANK_SCALE) }, mesh, instance, joint, restJoint: joint.slice() }); this.visible.add(part.slot);
    }
    for (const slot of KIT_SLOTS) {
      const b = this.bounds.get(slot)!;
      b.center = b.min.map((v, i) => Number.isFinite(v) ? (v + b.max[i]) / 2 : 0) as Vec3;
      this.triangles.set(slot, Float32Array.from(triangles.get(slot)!));
    }
    const sdf = scene.get('sdfCasters');
    if (sdf) {
      const soups = new Map<SlotId, { positions: number[]; indices: number[] }>();
      for (const part of workshopKitMeshes(ids, 2).meshes) {
        if (!slots.includes(part.slot)) continue;
        let soup = soups.get(part.slot); if (!soup) soups.set(part.slot, soup = { positions: [], indices: [] });
        const count = part.mesh.instances ? part.mesh.instances.length / 12 : 1;
        for (let i = 0; i < count; i++) {
          const joint = Float64Array.from(part.joint), matrix = part.mesh.instances ? mul(joint, instanceMatrix(part.mesh.instances, i)) : joint, base = soup.positions.length / 3;
          for (let v = 0; v < part.mesh.positions.length; v += 3) soup.positions.push(...applyPoint(matrix, part.mesh.positions[v], part.mesh.positions[v + 1], part.mesh.positions[v + 2]));
          for (const index of part.mesh.indices) soup.indices.push(base + index);
        }
      }
      for (const [slot, soup] of soups) {
        const brick = sdf.create({ positions: Float32Array.from(soup.positions), indices: Uint32Array.from(soup.indices), label: `workshop:${slot}` });
        if (brick) this.casters.set(slot, { brick, instance: sdf.add(brick, IDENTITY) });
      }
    }
    this.update();
  }
  categoryBounds(slot: SlotId): ComponentBounds { const b = this.bounds.get(slot)!; return { min: [...b.min], max: [...b.max], center: [...b.center] }; }
  /** A rubber-pad contact section through the actual posed triangles, in kit coordinates.
   * Bounding-box extrema can belong to a different feature (a rear engine housing or a dome's equator).
   * Clip the pickup slice first, then place the fingers against its real upper shoulder surfaces. */
  serviceGrip(slot: SlotId): ServiceGrip {
    const b = this.bounds.get(slot)!, z = b.center[2], soup = this.triangles.get(slot)!;
    const clip = (poly: Vec3[], axis: number, limit: number, sign: number): Vec3[] => {
      const result: Vec3[] = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length], a = (p[axis] - limit) * sign, c = (q[axis] - limit) * sign;
        if (a <= 0) result.push(p);
        if ((a <= 0) !== (c <= 0)) { const t = a / (a - c); result.push(p.map((v, j) => v + (q[j] - v) * t) as Vec3); }
      }
      return result;
    };
    const slices: Vec3[][] = []; let top = -Infinity;
    for (let i = 0; i < soup.length; i += 9) {
      let poly = [0, 3, 6].map(j => [soup[i + j], soup[i + j + 1], soup[i + j + 2]] as Vec3);
      poly = clip(clip(poly, 2, z - .07, -1), 2, z + .07, 1);
      if (poly.length) { slices.push(poly); for (const p of poly) top = Math.max(top, p[1]); }
    }
    let left = Infinity, right = -Infinity;
    for (const slice of slices) for (const p of clip(slice, 1, top - .10, -1)) { left = Math.min(left, p[0]); right = Math.max(right, p[0]); }
    if (!Number.isFinite(top + left + right)) throw new Error(`No physical grip section for ${slot}/${this.loadout[slot]}`);
    const surface = (x: number, zz: number): { point: Vec3; normal: Vec3 } | null => {
      const origin: Vec3 = [x, b.max[1] + 1, zz]; let distance = Infinity, normal: Vec3 = [0, 1, 0];
      for (let i = 0; i < soup.length; i += 9) {
        const hit = triangleHit(origin, [0, -1, 0], soup, i);
        if (hit < distance) {
          distance = hit;
          const a: Vec3 = [soup[i + 3] - soup[i], soup[i + 4] - soup[i + 1], soup[i + 5] - soup[i + 2]], c: Vec3 = [soup[i + 6] - soup[i], soup[i + 7] - soup[i + 1], soup[i + 8] - soup[i + 2]];
          const n: Vec3 = [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]], length = Math.hypot(...n);
          normal = n.map(v => v / length * (n[1] < 0 ? -1 : 1)) as Vec3;
        }
      }
      return Number.isFinite(distance) ? { point: [x, origin[1] - distance, zz], normal } : null;
    };
    // A shoe must fit an actual patch, not merely hit the surface at its centre.
    // Test its circular footprint along the surface normal, then shrink/reseat on
    // tread ridges or curved armour until every sample is within spring compliance.
    const fitPole = (x: number, zz: number, maxRadius: number, travel: number) => {
      const candidates = [[0, 0], [travel, 0], [-travel, 0], [0, travel], [0, -travel], [travel, travel], [-travel, travel], [travel, -travel], [-travel, -travel]]
        .map(([dx, dz]) => surface(x + dx, zz + dz)).filter((p): p is { point: Vec3; normal: Vec3 } => !!p && p.normal[1] > .20);
      for (const factor of [1, .75, .5, .3, .18]) for (const candidate of candidates) {
        const radius = Math.max(.004, maxRadius * factor), n = candidate.normal;
        const xx: Vec3 = Math.abs(n[1]) < .9 ? [-n[2], 0, n[0]] : [0, n[2], -n[1]], len = Math.hypot(...xx);
        const u = xx.map(v => v / len) as Vec3, v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        let fits = true;
        for (let j = -1; j < 64 && fits; j++) {
          const a = j * Math.PI / 32, r = j < 0 ? 0 : radius * .94, origin = candidate.point.map((p, i) => p + n[i] * .05 + (u[i] * Math.cos(a) + v[i] * Math.sin(a)) * r) as Vec3;
          let hit = Infinity; const direction = n.map(p => -p) as Vec3;
          for (let i = 0; i < soup.length; i += 9) hit = Math.min(hit, triangleHit(origin, direction, soup, i));
          fits = Math.abs(hit - .05) <= .002;
        }
        if (fits) return { ...candidate, radius };
      }
      throw new Error(`No supported magnetic footprint for ${slot}/${this.loadout[slot]}`);
    };
    const center = (left + right) / 2, span = right - left + .094;
    if (slot === 'runningGear') {
      const contacts = [-1, 1].map(sign => fitPole(sign * Math.max(Math.abs(b.min[0]), b.max[0]) * .82, z, .043, .035));
      const anchor: Vec3 = [0, Math.max(...contacts.map(p => p.point[1])) + .055, z];
      return { anchor, span, mode: 'tracks', poles: contacts.map(p => ({ offset: p.point.map((v, i) => v - anchor[i]) as Vec3, normal: p.normal, radius: p.radius })) };
    }
    if (right - left < .10) return { anchor: [center, top + .055, z], span, mode: 'fingers', poles: [] };
    let spread = Math.min(.065, (right - left) * .22), contacts: ({ point: Vec3; normal: Vec3 } | null)[] = [];
    for (let tries = 0; tries < 5; tries++, spread *= .75) {
      contacts = [[-spread, 0], [spread, 0], [0, spread]].map(([x, zz]) => surface(center + x, z + zz));
      if (contacts.every(Boolean)) break;
    }
    if (contacts.some(p => !p)) return { anchor: [center, top + .055, z], span, mode: 'fingers', poles: [] };
    let fitted: { point: Vec3; normal: Vec3; radius: number }[] | undefined;
    // Compact accessory covers are legitimate pickup surfaces, but need a tighter shoe triangle
    // than a turret roof. Fit the complete triangle at each spread before accepting it.
    for (let attempt = 0; attempt < (slot === 'utility' ? 6 : 1); attempt++, spread *= .72) {
      try {
        fitted = [[-spread, 0], [spread, 0], [0, spread]].map(([x, zz]) => fitPole(center + x, z + zz, Math.min(.023, spread * (slot === 'utility' ? .30 : .36)), .012));
        if (slot !== 'utility' || fitted.every((pole, i) => fitted!.every((other, j) => i === j || Math.hypot(...pole.point.map((v, axis) => v - other.point[axis])) > (pole.radius + other.radius) * 1.4))) break;
        fitted = undefined;
      } catch (error) { if (slot !== 'utility') throw error; }
    }
    if (!fitted) throw new Error(`No supported magnetic footprint for ${slot}/${this.loadout[slot]}`);
    const anchor: Vec3 = [center, Math.max(...fitted.map(p => p.point[1])) + .055, z];
    const poles: PickupPole[] = fitted.map(p => ({ offset: p.point.map((v, i) => v - anchor[i]) as Vec3, normal: p.normal, radius: p.radius }));
    return { anchor, span, mode: 'magnet', poles };
  }
  /** Exposed top-surface lifting shoes. The full footprint and the upward access
   * corridor must clear every other installed category; underside suspension cannot
   * be threaded through fenders or an already occupied mounting interface. */
  overheadContacts(slot: SlotId, count: 2 | 4): PickupPole[] {
    const key = `${slot}:${count}`, cached = this.overheadSections.get(key); if (cached) return cached;
    const b = this.bounds.get(slot)!, soup = this.triangles.get(slot)!;
    const ray = (origin: Vec3, direction: Vec3, data: Float32Array) => {
      let best = Infinity; for (let i = 0; i < data.length; i += 9) best = Math.min(best, triangleHit(origin, direction, data, i)); return best;
    };
    const points: Vec3[] = [], seen = new Set<string>();
    const sample = (x: number, z: number) => { const k = `${Math.round(x * 2000)}:${Math.round(z * 2000)}`; if (!seen.has(k)) { seen.add(k); points.push([x, 0, z]); } };
    for (let iz = 1; iz < 14; iz++) for (let ix = 1; ix < 12; ix++) sample(b.min[0] + (b.max[0] - b.min[0]) * ix / 12, b.min[2] + (b.max[2] - b.min[2]) * iz / 14);
    // Mesh face centres find small disconnected components such as smoke-tube clusters.
    for (let i = 0; i < soup.length; i += 9) sample((soup[i] + soup[i + 3] + soup[i + 6]) / 3, (soup[i + 2] + soup[i + 5] + soup[i + 8]) / 3);
    const selected: PickupPole[] = [], surfaces = new Map<Vec3, { point: Vec3; normal: Vec3 } | null>();
    const surface = (sample: Vec3) => {
      if (surfaces.has(sample)) return surfaces.get(sample)!;
      const origin: Vec3 = [sample[0], b.max[1] + 1, sample[2]]; let distance = Infinity, normal: Vec3 = [0, 1, 0];
      for (let i = 0; i < soup.length; i += 9) {
        const hit = triangleHit(origin, [0, -1, 0], soup, i); if (hit >= distance) continue;
        distance = hit;
        const a: Vec3 = [soup[i + 3] - soup[i], soup[i + 4] - soup[i + 1], soup[i + 5] - soup[i + 2]], c: Vec3 = [soup[i + 6] - soup[i], soup[i + 7] - soup[i + 1], soup[i + 8] - soup[i + 2]];
        const n: Vec3 = [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]], length = Math.hypot(...n);
        normal = n.map(v => v / length * (n[1] < 0 ? -1 : 1)) as Vec3;
      }
      const result = Number.isFinite(distance) && normal[1] >= .20 ? { point: [origin[0], origin[1] - distance, origin[2]] as Vec3, normal } : null;
      surfaces.set(sample, result); return result;
    };
    const fit = (point: Vec3, normal: Vec3): PickupPole | null => {
      const n = normal;
      const u0: Vec3 = [n[1], -n[0], 0], length = Math.hypot(...u0), u = u0.map(v => v / length) as Vec3;
      const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
      for (const radius of (slot === 'utility' ? [.012, .007, .004] : [.045, .030, .020, .012, .007, .004])) {
        if (!selected.every(s => Math.hypot(point[0] - s.offset[0], point[2] - s.offset[2]) > (radius + s.radius) * 1.7 + .016)) continue;
        let fits = true;
        for (let j = -1; j < 16 && fits; j++) {
          const angle = j * Math.PI / 8, r = j < 0 ? 0 : radius * .94;
          const sample = point.map((p, i) => p + (u[i] * Math.cos(angle) + v[i] * Math.sin(angle)) * r) as Vec3;
          const start = sample.map((p, i) => p + n[i] * .05) as Vec3;
          fits = Math.abs(ray(start, n.map(p => -p) as Vec3, soup) - .05) <= .002;
          if (fits) for (const other of KIT_SLOTS) {
            const data = this.triangles.get(other)!;
            // Include a clearance margin around the 1.28-radius housing, not just the contact shoe.
            // Raised hinge/bolt faces can sit between radial samples on a sloped turret crown.
            const bodyStart = point.map((p, i) => p + n[i] * .008 + (u[i] * Math.cos(angle) + v[i] * Math.sin(angle)) * r * 1.65) as Vec3;
            const bodyTop = point.map((p, i) => p + n[i] * .105 + (u[i] * Math.cos(angle) + v[i] * Math.sin(angle)) * Math.min(.015, radius * .6)) as Vec3;
            if ((other !== slot && ray(start, n.map(v => -v) as Vec3, data) < .052) || Number.isFinite(ray([sample[0], sample[1] + .003, sample[2]], [0, 1, 0], data)) || Number.isFinite(ray(start, [0, 1, 0], data)) || Number.isFinite(ray(bodyStart, [0, 1, 0], data)) || Number.isFinite(ray(bodyTop, [0, 1, 0], data))) { fits = false; break; }
          }
        }
        if (fits) return { offset: point, normal, radius };
      }
          return null;
    };
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1, end = count === 2 ? 0 : i < 2 ? 1 : -1;
      const target: Vec3 = [b.center[0] + side * (b.max[0] - b.min[0]) * .26, 0, b.center[2] + end * (b.max[2] - b.min[2]) * .26];
      points.sort((a, c) => Math.hypot(a[0] - target[0], a[2] - target[2]) - Math.hypot(c[0] - target[0], c[2] - target[2]));
      let result: PickupPole | null = null;
      for (const candidate of points) {
        const actual = surface(candidate); if (!actual) continue;
        result = fit(actual.point, actual.normal); if (result) break;
      }
      if (!result) throw new Error(`No exposed lifting footprint for ${slot}/${this.loadout[slot]}`);
      selected.push(result);
    }
    this.overheadSections.set(key, selected); return selected;
  }
  /** Transform a kit-local attachment by its category's current service pose. */
  attachmentPoint(slot: SlotId, point: Vec3): Vec3 { return add(add(this.root, this.offsets.get(slot)!), point); }
  /** Under-surface saddle contact at a particular longitudinal station, in world space. */
  supportContact(slot: SlotId, z: number, side: -1 | 1, hookScale: number): { point: Vec3; scale: number } {
    const key = `${slot}:${z}:${side}:${hookScale}`, cached = this.supportSections.get(key);
    if (cached) return { point: add(add(this.root, this.offsets.get(slot)!), cached.point), scale: cached.scale };
    const soup = this.triangles.get(slot)!, b = this.bounds.get(slot)!;
    const clip = (poly: Vec3[], axis: number, limit: number, sign: number): Vec3[] => {
      const out: Vec3[] = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length], a = (p[axis] - limit) * sign, c = (q[axis] - limit) * sign;
        if (a <= 0) out.push(p);
        if ((a <= 0) !== (c <= 0)) { const t = a / (a - c); out.push(p.map((v, j) => v + (q[j] - v) * t) as Vec3); }
      }
      return out;
    };
    const slices: Vec3[][] = []; let bottom = Infinity;
    for (let i = 0; i < soup.length; i += 9) {
      let poly = [0, 3, 6].map(j => [soup[i + j], soup[i + j + 1], soup[i + j + 2]] as Vec3);
      poly = clip(clip(poly, 2, z - .008, -1), 2, z + .008, 1);
      if (poly.length) { slices.push(poly); for (const point of poly) bottom = Math.min(bottom, point[1]); }
    }
    let left = Infinity, right = -Infinity;
    for (const slice of slices) for (const point of clip(slice, 1, bottom + .028 * hookScale, 1)) {
      left = Math.min(left, point[0]); right = Math.max(right, point[0]);
    }
    if (!Number.isFinite(left + right)) throw new Error(`No underside support section for ${slot}`);
    hookScale = Math.min(hookScale, Math.max(.06, (right - left) / .34));
    const x = side < 0 ? left + Math.min(.045 * hookScale, (right - left) * .2) : right - Math.min(.045 * hookScale, (right - left) * .2);
    const origin: Vec3 = [x, b.min[1] - 1, z]; let hit = Infinity;
    for (let i = 0; i < soup.length; i += 9) hit = Math.min(hit, triangleHit(origin, [0, 1, 0], soup, i));
    if (!Number.isFinite(hit)) throw new Error(`No underside contact for ${slot}`);
    const local: Vec3 = [x, origin[1] + hit, z]; this.supportSections.set(key, { point: local, scale: hookScale });
    return { point: add(add(this.root, this.offsets.get(slot)!), local), scale: hookScale };
  }
  categoryCenter(slot: SlotId): Vec3 { return add(add(this.root, this.offsets.get(slot)!), this.bounds.get(slot)!.center); }
  /** Top attachment centre. The robot uses a spreading clamp across the component's actual bounds. */
  serviceAnchor(slot: SlotId): Vec3 { const b = this.bounds.get(slot)!; return add(add(this.root, this.offsets.get(slot)!), [b.center[0], b.max[1] + .035, b.center[2]]); }
  setRoot(root: Vec3): void { this.root = [...root]; this.update(); }
  setOffset(slot: SlotId, offset: Vec3): void { this.offsets.set(slot, [...offset]); this.update(slot); }
  setVisible(slot: SlotId, visible: boolean): void {
    if (visible) this.visible.add(slot); else this.visible.delete(slot);
    for (const e of this.entries) if (e.slot === slot) this.scene.instances.setVisibility(e.instance, visible ? 1 : 0);
    const caster = this.casters.get(slot), sdf = this.scene.get('sdfCasters');
    if (caster && sdf) { if (!visible && caster.instance) { sdf.remove(caster.instance); caster.instance = null; } else if (visible && !caster.instance) { caster.instance = sdf.add(caster.brick, translate(...add(this.root, this.offsets.get(slot)!))); } }
    this.update(slot);
  }
  highlight(slot: SlotId | null): void { if (slot !== this.highlighted) { this.highlighted = slot; this.update(); } }
  /** Appearance is instance data only: neither part IDs nor derived gameplay stats change. */
  setTint(tint: Vec3): void {
    this.tint = [...tint];
    for (const e of this.entries) {
      this.scene.instances.remove(e.instance);
      e.instance = this.scene.instances.add(e.mesh, { model: IDENTITY, objectId: 100 + KIT_SLOTS.indexOf(e.slot), tint });
      this.scene.instances.setVisibility(e.instance, this.visible.has(e.slot) ? 1 : 0);
    }
    this.update();
  }
  setAppearance(appearance: TankAppearance): void {
    const key = JSON.stringify(appearance); if (key === this.appearanceKey) return; this.appearanceKey = key;
    this.lightsOn = appearance.lights !== false;
    for (const entry of this.entries) {
      const surface = tankSurface(appearance, this.loadout, entry.slot, entry.group);
      if (surface.marks) surface.marks = surface.marks.map(mark => ({ ...mark, position: mark.position.map(v => v * WORKSHOP_TANK_SCALE) as Vec3, radius: mark.radius * WORKSHOP_TANK_SCALE }));
      const layers = appearance.paintTextures?.filter(layer => layer.slot === entry.slot && layer.partId === this.loadout[entry.slot] && layer.group === entry.group && layer.lod === 0);
      const legacy = appearance.paint?.filter(dab => dab.slot === entry.slot && dab.partId === this.loadout[entry.slot] && dab.group === entry.group);
      const surfaceKey = JSON.stringify([surface, layers, legacy]); if (entry.surfaceKey === surfaceKey) continue; entry.surfaceKey = surfaceKey;
      this.scene.instances.remove(entry.instance); this.scene.meshes.destroy(entry.mesh);
      const painted = paintedMesh(entry.data, appearance, this.loadout, entry.group, 0, entry.slot, 1, entry.paintSource);
      entry.mesh = this.scene.meshes.create({ ...painted, tankSurface: surface });
      entry.instance = this.scene.instances.add(entry.mesh, { model: IDENTITY, objectId: 100 + KIT_SLOTS.indexOf(entry.slot), tint: this.tint });
      this.scene.instances.setVisibility(entry.instance, this.visible.has(entry.slot) ? 1 : 0);
    }
    this.update();
  }
  /** Resolve the nearest real surface first. Glass, tracks, hardware and back surfaces block paint. */
  paintRaycast(origin: Vec3, direction: Vec3): (PaintSurfaceHit & { distance: number }) | null {
    let nearest = Infinity, selected: (PaintSurfaceHit & { distance: number }) | null = null;
    for (const entry of this.entries) {
      if (!this.visible.has(entry.slot)) continue;
      const offset = add(this.root, this.offsets.get(entry.slot)!), localOrigin = origin.map((v, i) => v - offset[i]) as Vec3;
      const mesh = entry.data, instances = mesh.instances?.length ? mesh.instances.length / 12 : 1;
      for (let instance = 0; instance < instances; instance++) {
        const matrix = mesh.instances ? mul(entry.joint, instanceMatrix(mesh.instances, instance)) : entry.joint;
        const hit = { triangle: 0, position: [0, 0, 0] as Vec3, normal: [0, 1, 0] as Vec3 };
        const distance = rayMeshDistance(mesh, matrix, localOrigin, direction, nearest, undefined, hit); if (distance === null || distance >= nearest) continue;
        nearest = distance; selected = null;
        const vertex = mesh.indices[hit.triangle], material = ((mesh.attrs?.[vertex] ?? 0) >>> 16) & 255;
        if (material !== 0 || mesh.instances || entry.slot === 'runningGear') continue;
        selected = { slot: entry.slot, partId: this.loadout[entry.slot], group: entry.group, distance,
          position: hit.position.map(v => v / WORKSHOP_TANK_SCALE) as Vec3, normal: hit.normal };
      }
    }
    return selected;
  }
  /** Rigid accessories keep their proper mount frame; paint raycasts use the same moving matrix. */
  parkAccessories(): void {
    for (const entry of this.entries) if (entry.slot === 'utility') entry.joint = entry.restJoint;
    this.update('utility');
  }
  animate(time: number, paused: boolean): void {
    const dt = Math.max(0, Math.min(.1, time - this.animationTime)); this.animationTime = time;
    if (paused) { this.energy.hide(); return; }
    const head = utilityIdle(this.loadout.utility, time), kind = kitContext(this.assembly.loadout).utility.head;
    for (const entry of this.entries) if (entry.slot === 'utility' && entry.group === 'head') {
      const rotation = kind === 'spin' ? rotY(head[0]) : kind === 'spring2' ? mul(rotZ(head[0]), rotX(head[1])) : rotX(-head[0]);
      entry.joint = mul(entry.restJoint, rotation);
    }
    this.update('utility');
    const barrel = this.entries.find(e => e.slot === 'weapon' && e.group === 'barrel');
    if (barrel) {
      const root = translate(...add(this.root, this.offsets.get('weapon')!));
      const model = mul(mul(root, barrel.joint), scaleM(WORKSHOP_TANK_SCALE, WORKSHOP_TANK_SCALE, WORKSHOP_TANK_SCALE));
      this.energy.update(Float32Array.from(model), dt, true, this.visible.has('weapon'), 103);
    }
  }
  private update(slot?: SlotId): void {
    this.lights.update(mul(translate(...add(this.root, this.offsets.get('hull')!)), scaleM(WORKSHOP_TANK_SCALE, WORKSHOP_TANK_SCALE, WORKSHOP_TANK_SCALE)), this.lightsOn && this.visible.has('hull'), WORKSHOP_TANK_SCALE);
    for (const e of this.entries) {
      if (slot && e.slot !== slot) continue;
      const offset = add(this.root, this.offsets.get(e.slot)!);
      this.scene.instances.set(e.instance, Float32Array.from(mul(translate(...offset), e.joint)), e.slot === this.highlighted ? GBUFFER_FLAG.SELECTED | GBUFFER_FLAG.HERO : GBUFFER_FLAG.HERO);
    }
    for (const [category, caster] of this.casters) if ((!slot || slot === category) && caster.instance) this.scene.get('sdfCasters')?.set(caster.instance, translate(...add(this.root, this.offsets.get(category)!)));
  }
  raycast(origin: Vec3, direction: Vec3): { slot: SlotId; distance: number } | null {
    let best = Infinity, selected: SlotId | null = null;
    for (const entry of this.entries) {
      if (!this.visible.has(entry.slot)) continue;
      const offset = add(this.root, this.offsets.get(entry.slot)!), local = origin.map((v, i) => v - offset[i]) as Vec3, mesh = entry.data;
      const count = mesh.instances?.length ? mesh.instances.length / 12 : 1;
      for (let i = 0; i < count; i++) {
        const matrix = mesh.instances ? mul(entry.joint, instanceMatrix(mesh.instances, i)) : entry.joint;
        const distance = rayMeshDistance(mesh, matrix, local, direction, best);
        if (distance !== null && distance < best) { best = distance; selected = entry.slot; }
      }
    }
    return selected ? { slot: selected, distance: best } : null;
  }
  dispose(): void {
    this.lights.dispose();
    this.energy.dispose();
    for (const e of this.entries) { this.scene.instances.remove(e.instance); this.scene.meshes.destroy(e.mesh); }
    const sdf = this.scene.get('sdfCasters'); for (const caster of this.casters.values()) { if (caster.instance) sdf?.remove(caster.instance); sdf?.destroy(caster.brick); }
    this.casters.clear(); this.entries.length = 0; this.triangles.clear(); this.supportSections.clear(); this.overheadSections.clear();
  }
}
