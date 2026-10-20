/**
 * CPU side of the generic part-mesh path (pure; unit-tested in Node): mesh packing for vertex pulling, the instance table
 * (model / prevModel with the automatic per-frame prev copy) and draw-list building.
 *
 * Mesh data (one u32 array per mesh, bound as `array<u32>`):
 *   header (16 words): vertexCount, posOff, nrmOff, localOff, axisOff, attrOff, subOff, subCount, defaultAttrs, 0…
 *   positions f32×3, normals f32×3, partLocal f32×3 (or = positions), primAxis u32 (or NO_STREAM), attrs u32 (or
 *   NO_STREAM → defaultAttrs), sub-instances 12 × f32 each (row-major 3×4 affine).
 * Instance (160 B): model mat4, prevModel mat4, tint vec4, ids vec4u (objectId, flags, classId, veil bit 0 | presence << 8).
 * Draw list entry (8 B): (instance slot, sub-instance index); one instanced draw per mesh.
 */
import { MATERIAL_CLASS } from '../../contracts';
import type { InstanceInit, MeshDesc, TankSurface, TankSurfaceMark, Vec3 } from '../../contracts';

export const MESH_HEADER_WORDS = 16;
export const NO_STREAM = 0xffffffff;
export const INSTANCE_FLOATS = 40;
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
export const DRAW_ENTRY_WORDS = 2;
export const SUB_INSTANCE_FLOATS = 12;
const DEFAULT_TINT: Vec3 = [0.6, 0.6, 0.6];
const presenceByte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

export interface PackedMesh {
  words: Uint32Array;
  vertexCount: number;
  indexCount: number;
  subCount: number;
  bounds: { center: Vec3; radius: number };
}

export function meshBounds(positions: Float32Array, sub?: Float32Array): { center: Vec3; radius: number } {
  const n = positions.length / 3;
  if (n === 0) return { center: [0, 0, 0], radius: 0 };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = positions[i * 3 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - c[0], dy = positions[i * 3 + 1] - c[1], dz = positions[i * 3 + 2] - c[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  const r = Math.sqrt(r2);
  if (!sub || sub.length < SUB_INSTANCE_FLOATS) return { center: c, radius: r };
  // Union of the transformed spheres.
  const centers: Vec3[] = []; const radii: number[] = [];
  for (let s = 0; s + SUB_INSTANCE_FLOATS <= sub.length; s += SUB_INSTANCE_FLOATS) {
    const m = sub.subarray(s, s + SUB_INSTANCE_FLOATS);
    centers.push([
      m[0] * c[0] + m[1] * c[1] + m[2] * c[2] + m[3],
      m[4] * c[0] + m[5] * c[1] + m[6] * c[2] + m[7],
      m[8] * c[0] + m[9] * c[1] + m[10] * c[2] + m[11],
    ]);
    const scale = Math.max(Math.hypot(m[0], m[4], m[8]), Math.hypot(m[1], m[5], m[9]), Math.hypot(m[2], m[6], m[10]));
    radii.push(r * scale);
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  centers.forEach((cc, i) => { for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], cc[k] - radii[i]); hi[k] = Math.max(hi[k], cc[k] + radii[i]); } });
  const uc: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let ur = 0;
  centers.forEach((cc, i) => { ur = Math.max(ur, Math.hypot(cc[0] - uc[0], cc[1] - uc[1], cc[2] - uc[2]) + radii[i]); });
  return { center: uc, radius: ur };
}

export function packMeshData(desc: MeshDesc): PackedMesh {
  const vertexCount = desc.positions.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount === 0) throw new Error('mesh: positions must be a non-empty multiple of 3');
  if (desc.normals.length !== desc.positions.length) throw new Error('mesh: normals must match positions');
  if (desc.partLocal && desc.partLocal.length !== desc.positions.length) throw new Error('mesh: partLocal must match positions');
  if (desc.primAxis && desc.primAxis.length !== vertexCount) throw new Error('mesh: primAxis must have one u32 per vertex');
  if (desc.attrs && desc.attrs.length !== vertexCount) throw new Error('mesh: attrs must have one u32 per vertex');
  if (desc.paintTexture && desc.paintTexture.uv.length !== vertexCount * 2) throw new Error('mesh: paint UVs must match positions');
  if (desc.indices.length % 3 !== 0 || desc.indices.length === 0) throw new Error('mesh: indices must be a non-empty multiple of 3');
  for (let i = 0; i < desc.indices.length; i++) if (desc.indices[i] >= vertexCount) throw new Error(`mesh: index ${desc.indices[i]} out of range`);
  const subCount = desc.instances ? Math.floor(desc.instances.length / SUB_INSTANCE_FLOATS) : 0;
  let off = MESH_HEADER_WORDS;
  const posOff = off; off += vertexCount * 3;
  const nrmOff = off; off += vertexCount * 3;
  const localOff = desc.partLocal ? off : posOff; if (desc.partLocal) off += vertexCount * 3;
  const axisOff = desc.primAxis ? off : NO_STREAM; if (desc.primAxis) off += vertexCount;
  const attrOff = desc.attrs ? off : NO_STREAM; if (desc.attrs) off += vertexCount;
  const subOff = subCount ? off : 0; off += subCount * SUB_INSTANCE_FLOATS;
  const paintOff = desc.paintTexture ? off : 0; if (desc.paintTexture) off += vertexCount * 2;
  // 16-float palette header, followed by at most 192 brush dabs + 24 combat scars.
  const surfaceOff = desc.tankSurface ? off : 0;
  const marks = tankSurfaceMarks(desc.tankSurface);
  if (surfaceOff) off += 16 + marks.length * 16;
  const words = new Uint32Array(off);
  const f32 = new Float32Array(words.buffer);
  const defaultAttrs = (0xff << 8) | ((desc.matId ?? 0) & 0xff) << 16; // edge 0, ao 255, matId
  words.set([vertexCount, posOff, nrmOff, localOff, axisOff, attrOff, subOff, subCount, defaultAttrs >>> 0], 0);
  words[9] = surfaceOff; words[10] = marks.length;
  words[11] = paintOff;
  f32.set(desc.positions, posOff);
  f32.set(desc.normals, nrmOff);
  if (desc.partLocal) f32.set(desc.partLocal, localOff);
  if (desc.primAxis) words.set(desc.primAxis, axisOff);
  if (desc.attrs) words.set(desc.attrs, attrOff);
  if (subCount) f32.set(desc.instances!.subarray(0, subCount * SUB_INSTANCE_FLOATS), subOff);
  if (desc.paintTexture) f32.set(desc.paintTexture.uv, paintOff);
  if (desc.tankSurface) packTankSurface(desc.tankSurface, marks, f32, surfaceOff);
  return { words, vertexCount, indexCount: desc.indices.length, subCount, bounds: meshBounds(desc.positions, desc.instances) };
}

/** The marks a tank surface block holds: the newest 216 (192 brush dabs + 24 combat scars). */
export function tankSurfaceMarks(s: TankSurface | undefined): TankSurfaceMark[] { return s?.marks?.slice(-216) ?? []; }

/** The surface block (16-float palette header, then 16 floats per mark) at `at`. */
export function packTankSurface(s: TankSurface, marks: readonly TankSurfaceMark[], f32: Float32Array, at: number): void {
  f32.set([...s.colors[0], s.pattern, ...s.colors[1], s.scale, ...s.colors[2], s.wear, s.lights === false ? 0 : 1, s.damage ?? 0, 0, 0], at);
  marks.forEach((m, i) => f32.set([...m.position, m.radius, ...m.normal, m.opacity, ...m.color, m.softness, m.damage ? 1 : 0, 0, 0, 0], at + 16 + i * 16));
}

export interface DrawRange { mesh: number; first: number; count: number }
export interface DrawLists { entries: Uint32Array<ArrayBuffer>; draws: DrawRange[] }

/**
 * Instance slots with model/prevModel; `beginFrame()` performs the automatic prev copy. Writes that change nothing are
 * dropped, the slots that did change bound the next upload (`dirtyFirst` … `dirtyEnd`), and `beginFrame` visits only
 * slots whose prevModel can still change: a slot whose model, prevModel and last drawn model agree stays that way until
 * it is written again.
 */
export class InstanceTable {
  data: Float32Array;
  private u32: Uint32Array;
  /** The model each slot was drawn with last frame (source of prevModel). */
  private drawn: Float32Array;
  private drawnBits: Uint32Array;
  private mesh: Int32Array;
  private shadow: Uint8Array;
  /** Added since the last beginFrame: its first drawn frame has prevModel = model (never drawn elsewhere). */
  private fresh: Uint8Array;
  /** Slots beginFrame must visit (`unsettled` flags them, `pending` lists them once). */
  private unsettled: Uint8Array;
  private pending: Int32Array;
  private pendingCount = 0;
  private readonly freeSlots: number[] = [];
  private high = 0;
  private live = 0;
  private first = 0;
  private end = 0;
  /** Set when membership (add/remove/mesh/castShadow) changed: draw lists must be rebuilt. */
  membershipDirty = true;

  constructor(private capacity = 64) {
    this.data = new Float32Array(capacity * INSTANCE_FLOATS);
    this.u32 = new Uint32Array(this.data.buffer);
    this.drawn = new Float32Array(capacity * 16);
    this.drawnBits = new Uint32Array(this.drawn.buffer);
    this.mesh = new Int32Array(capacity).fill(-1);
    this.shadow = new Uint8Array(capacity);
    this.fresh = new Uint8Array(capacity);
    this.unsettled = new Uint8Array(capacity);
    this.pending = new Int32Array(capacity);
  }

  get count(): number { return this.live; }
  /** One past the highest slot ever used (upload range). */
  get highWater(): number { return this.high; }
  get slotCapacity(): number { return this.capacity; }
  /** Whether any instance data changed since the last upload; setting false marks it uploaded, true marks every slot. */
  get dataDirty(): boolean { return this.end > this.first; }
  set dataDirty(dirty: boolean) { if (dirty) { this.first = 0; this.end = this.high; } else this.first = this.end = 0; }
  /** The slots changed since the last upload: [dirtyFirst, dirtyEnd). */
  get dirtyFirst(): number { return this.first; }
  get dirtyEnd(): number { return this.end; }

  private touch(slot: number): void {
    if (this.end <= this.first) { this.first = slot; this.end = slot + 1; return; }
    if (slot < this.first) this.first = slot;
    if (slot >= this.end) this.end = slot + 1;
  }

  private unsettle(slot: number): void {
    if (this.unsettled[slot]) return;
    this.unsettled[slot] = 1;
    this.pending[this.pendingCount++] = slot;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const data = new Float32Array(cap * INSTANCE_FLOATS); data.set(this.data);
    const drawn = new Float32Array(cap * 16); drawn.set(this.drawn);
    const mesh = new Int32Array(cap).fill(-1); mesh.set(this.mesh);
    const shadow = new Uint8Array(cap); shadow.set(this.shadow);
    const fresh = new Uint8Array(cap); fresh.set(this.fresh);
    const unsettled = new Uint8Array(cap); unsettled.set(this.unsettled);
    const pending = new Int32Array(cap); pending.set(this.pending);
    this.data = data; this.u32 = new Uint32Array(data.buffer); this.drawn = drawn; this.drawnBits = new Uint32Array(drawn.buffer);
    this.mesh = mesh; this.shadow = shadow; this.fresh = fresh;
    this.unsettled = unsettled; this.pending = pending;
    this.capacity = cap;
  }

  add(meshId: number, init: InstanceInit): number {
    if (init.model.length < 16) throw new Error('instance: model must be a mat4 (16 floats)');
    let slot = this.freeSlots.pop();
    if (slot === undefined) { if (this.high >= this.capacity) this.grow(); slot = this.high++; }
    const o = slot * INSTANCE_FLOATS;
    this.data.set(init.model.subarray(0, 16), o);
    this.data.set(init.model.subarray(0, 16), o + 16);
    this.drawn.set(init.model.subarray(0, 16), slot * 16);
    const t = init.tint ?? DEFAULT_TINT;
    this.data[o + 32] = t[0]; this.data[o + 33] = t[1]; this.data[o + 34] = t[2]; this.data[o + 35] = 1;
    this.u32[o + 36] = (init.objectId ?? 0) & 0x3ff;
    this.u32[o + 37] = (init.flags ?? 0) & 0x3f;
    this.u32[o + 38] = init.classId ?? MATERIAL_CLASS.METAL;
    this.u32[o + 39] = (init.fogged ? 1 : 0) | (presenceByte(init.visibility ?? 1) << 8);
    this.mesh[slot] = meshId;
    this.shadow[slot] = init.castShadow === false ? 0 : 1;
    this.fresh[slot] = 1;
    this.unsettle(slot);
    this.live++;
    this.membershipDirty = true; this.touch(slot);
    return slot;
  }

  set(slot: number, model: Float32Array, flags?: number): void {
    this.check(slot);
    const o = slot * INSTANCE_FLOATS, data = this.data, n = Math.min(16, model.length);
    let changed = false;
    for (let k = 0; k < n; k++) { const v = Math.fround(model[k]); if (!Object.is(data[o + k], v)) { data[o + k] = v; changed = true; } }
    if (changed) { this.touch(slot); this.unsettle(slot); }
    if (flags !== undefined && this.u32[o + 37] !== (flags & 0x3f)) { this.u32[o + 37] = flags & 0x3f; this.touch(slot); }
  }

  /** Presence 0 … 1 (dithered dissolve below 1). */
  setVisibility(slot: number, visibility: number): void {
    this.check(slot);
    const o = slot * INSTANCE_FLOATS + 39;
    const next = (this.u32[o] & 0xff) | (presenceByte(visibility) << 8);
    if (next !== this.u32[o]) { this.u32[o] = next; this.touch(slot); }
  }

  setTint(slot: number, tint: Vec3): void {
    this.check(slot);
    const o = slot * INSTANCE_FLOATS + 32, data = this.data;
    for (let k = 0; k < 3; k++) { const v = Math.fround(tint[k]); if (!Object.is(data[o + k], v)) { data[o + k] = v; this.touch(slot); } }
  }

  /** Start the slot's motion history afresh: its next drawn frame has prevModel = model, as a new instance has. */
  restart(slot: number): void {
    this.check(slot);
    this.fresh[slot] = 1;
    this.unsettle(slot);
  }

  remove(slot: number): void {
    this.check(slot);
    this.mesh[slot] = -1;
    this.shadow[slot] = 0;
    this.freeSlots.push(slot);
    this.live--;
    this.membershipDirty = true;
  }

  meshOf(slot: number): number { return this.mesh[slot]; }
  model(slot: number): Float32Array { return this.data.subarray(slot * INSTANCE_FLOATS, slot * INSTANCE_FLOATS + 16); }
  prevModel(slot: number): Float32Array { return this.data.subarray(slot * INSTANCE_FLOATS + 16, slot * INSTANCE_FLOATS + 32); }
  slotsOf(meshId: number): number[] { const out: number[] = []; for (let s = 0; s < this.high; s++) if (this.mesh[s] === meshId) out.push(s); return out; }

  private check(slot: number): void {
    if (!(slot >= 0 && slot < this.high) || this.mesh[slot] < 0) throw new Error(`instance: unknown slot ${slot}`);
  }

  /**
   * Start of a frame: prevModel ← the model drawn last frame; remember this frame's model. A model that did not change
   * since last frame therefore gets prevModel == model (zero velocity) from the second frame on.
   */
  beginFrame(): void {
    // On the bits the GPU receives: integer compares and copies, and no signed-zero or NaN cases.
    const data = this.u32, drawn = this.drawnBits, pending = this.pending;
    let kept = 0;
    for (let i = 0; i < this.pendingCount; i++) {
      const s = pending[i];
      if (this.mesh[s] < 0) { this.unsettled[s] = 0; continue; }
      const o = s * INSTANCE_FLOATS, d = s * 16;
      if (this.fresh[s]) {
        this.fresh[s] = 0;
        for (let k = 0; k < 16; k++) { const v = data[o + k]; data[o + 16 + k] = v; drawn[d + k] = v; }
        this.touch(s);
        // model = prevModel = drawn: settled until written again.
        this.unsettled[s] = 0;
        continue;
      }
      let moved = false;
      for (let k = 0; k < 16; k++) {
        const prev = drawn[d + k];
        if (data[o + 16 + k] !== prev) { data[o + 16 + k] = prev; moved = true; }
        const cur = data[o + k];
        if (cur !== prev) { drawn[d + k] = cur; moved = true; }
      }
      if (moved) { this.touch(s); pending[kept++] = s; } else this.unsettled[s] = 0;
    }
    this.pendingCount = kept;
  }

  /** One instanced draw per mesh (ascending mesh id); `subCounts` gives each mesh's repeated sub-parts (0 = none). */
  buildDrawLists(subCounts: ReadonlyMap<number, number>, shadowOnly = false): DrawLists {
    const byMesh = new Map<number, number[]>();
    for (let s = 0; s < this.high; s++) {
      const m = this.mesh[s];
      if (m < 0 || (shadowOnly && !this.shadow[s])) continue;
      let list = byMesh.get(m);
      if (!list) { list = []; byMesh.set(m, list); }
      list.push(s);
    }
    const meshes = [...byMesh.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const m of meshes) total += byMesh.get(m)!.length * Math.max(1, subCounts.get(m) ?? 0);
    const entries = new Uint32Array(Math.max(1, total) * DRAW_ENTRY_WORDS);
    const draws: DrawRange[] = [];
    let e = 0;
    for (const m of meshes) {
      const subs = Math.max(1, subCounts.get(m) ?? 0);
      const first = e;
      for (const slot of byMesh.get(m)!) for (let k = 0; k < subs; k++) { entries[e * 2] = slot; entries[e * 2 + 1] = k; e++; }
      draws.push({ mesh: m, first, count: e - first });
    }
    return { entries, draws };
  }
}
