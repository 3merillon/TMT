/**
 * CPU side of EngineTerrainHost (plan §4.7, §5.1): the page table and its record mirror, pure and Node-testable.
 *
 * - Every page gets a slot in the page-record storage array (PAGE_RECORD, 176 B): model, prevModel, rest origin (+ body
 *   flag), world bounding sphere, ids (objectId, flags, newUntilFrame).
 * - `commit({show, hide})` validates the WHOLE change before touching anything (unknown, disposed, duplicated, hiding an
 *   invisible page or showing a visible one all throw with nothing changed), then flips membership in one step and stamps
 *   `newUntilFrame = nextFrame + 3` on shown pages (the GB3 new-geometry flag: TAA rejects their history).
 * - `beginFrame(index)` performs the automatic prevModel copy (prevModel ← the model drawn last frame), so a static page
 *   has zero velocity from its second frame and a moving body gets true motion vectors.
 * - `dispose()` frees the slot and hands the page's buffers to the deferred destroyer (≥ 3 frames, N6); a page disposed
 *   while still visible is dropped from the visible set and counted (a published hole).
 */
import type { PageBuffers, PageDrawHandle, PageDrawInfo } from '../../gpu/terrain/render-host';
import { PAGE_RECORD_FLOATS } from '../materials/terrain/surface.wgsl';
import { boxSphere } from './culling';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** Frames a freshly committed page keeps the TAA-reject flag. */
export const NEW_GEOMETRY_FRAMES = 3;

export interface TerrainPage {
  readonly id: number;
  readonly slot: number;
  readonly buffers: PageBuffers;
  readonly info: PageDrawInfo;
  readonly isBody: boolean;
  visible: boolean;
  disposed: boolean;
  /** Column-major model (local page positions → world). */
  readonly model: Float64Array;
  /** Bounding sphere in the page's local (buffer) space. */
  readonly localSphere: { center: Vec3; radius: number };
  /** Bounding sphere in world space at the current pose. */
  readonly worldSphere: { center: Vec3; radius: number };
  newUntilFrame: number;
  objectId: number;
  readonly handle: PageDrawHandle;
}

export interface CommitRecord { show: number[]; hide: number[]; frame: number; dirty: { min: Vec3; max: Vec3 } | null }

/** model = T(position) · R(rotation) (column-major). */
export function poseMatrix(position: readonly number[], q: readonly number[], out: Float64Array = new Float64Array(16)): Float64Array {
  const [x, y, z, w] = q;
  const l = Math.hypot(x, y, z, w) || 1;
  const qx = x / l, qy = y / l, qz = z / l, qw = w / l;
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy); out[3] = 0;
  out[4] = 2 * (xy - wz); out[5] = 1 - 2 * (xx + zz); out[6] = 2 * (yz + wx); out[7] = 0;
  out[8] = 2 * (xz + wy); out[9] = 2 * (yz - wx); out[10] = 1 - 2 * (xx + yy); out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}

function transformPoint(m: ArrayLike<number>, p: readonly number[]): Vec3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/**
 * Local (position-buffer) bounds of a page. PageDrawInfo.bounds is the brick's WORLD AABB for a static page and the
 * body-local AABB (already relative to origin) for a body page; positions are relative to `info.origin` in both cases.
 */
export function localBounds(info: PageDrawInfo): { min: Vec3; max: Vec3 } {
  if (info.bodyId !== undefined) return { min: [...info.bounds.min] as Vec3, max: [...info.bounds.max] as Vec3 };
  const o = info.origin;
  return { min: [info.bounds.min[0] - o[0], info.bounds.min[1] - o[1], info.bounds.min[2] - o[2]], max: [info.bounds.max[0] - o[0], info.bounds.max[1] - o[1], info.bounds.max[2] - o[2]] };
}

export interface PageTableHooks {
  /** A page's buffers are released (the host defers their destruction ≥ 3 frames). */
  release(buffers: PageBuffers): void;
  /** Record data changed for [firstSlot, lastSlot]. */
  dirty?(firstSlot: number, lastSlot: number): void;
}

export class TerrainPageTable {
  private readonly pages = new Map<number, TerrainPage>();
  private readonly bySlot: (TerrainPage | null)[] = [];
  private readonly freeSlots: number[] = [];
  private nextId = 1;
  /** The page-record mirror (PAGE_RECORD layout per slot). */
  records: Float32Array;
  private recordsU32: Uint32Array;
  /** Model drawn last frame per slot (source of prevModel). */
  private drawn: Float32Array;
  private fresh: Uint8Array;
  capacity: number;
  /** Frame index of the next frame to be drawn. */
  nextFrame = 0;
  epoch = 0;
  disposedWhileVisible = 0;
  readonly commits: CommitRecord[] = [];
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  /** Set when the record buffer must be re-created (capacity grew). */
  grown = true;

  constructor(private readonly hooks: PageTableHooks, capacity = 256) {
    this.capacity = capacity;
    this.records = new Float32Array(capacity * PAGE_RECORD_FLOATS);
    this.recordsU32 = new Uint32Array(this.records.buffer);
    this.drawn = new Float32Array(capacity * 16);
    this.fresh = new Uint8Array(capacity);
  }

  get size(): number { return this.pages.size; }
  get visibleCount(): number { let n = 0; for (const p of this.pages.values()) if (p.visible) n++; return n; }
  get highWater(): number { return this.bySlot.length; }
  page(id: number): TerrainPage | undefined { return this.pages.get(id); }
  all(): IterableIterator<TerrainPage> { return this.pages.values(); }
  /** Pages by slot (null = free), for culling. */
  slots(): readonly (TerrainPage | null)[] { return this.bySlot; }

  private markDirty(slot: number): void {
    if (slot < this.dirtyLo) this.dirtyLo = slot;
    if (slot > this.dirtyHi) this.dirtyHi = slot;
  }

  /** The dirty slot range since the last call (null when clean). */
  takeDirty(): [number, number] | null {
    if (this.dirtyHi < 0) return null;
    const r: [number, number] = [this.dirtyLo, this.dirtyHi];
    this.dirtyLo = Infinity; this.dirtyHi = -1;
    return r;
  }

  private grow(): void {
    const cap = this.capacity * 2;
    const records = new Float32Array(cap * PAGE_RECORD_FLOATS); records.set(this.records);
    const drawn = new Float32Array(cap * 16); drawn.set(this.drawn);
    const fresh = new Uint8Array(cap); fresh.set(this.fresh);
    this.records = records; this.recordsU32 = new Uint32Array(records.buffer); this.drawn = drawn; this.fresh = fresh;
    this.capacity = cap;
    this.grown = true;
  }

  create(buffers: PageBuffers, info: PageDrawInfo, objectId = 1): PageDrawHandle {
    if (!(buffers.indexCount >= 0) || buffers.indexCount % 3 !== 0) throw new Error(`terrain page: index count ${buffers.indexCount} is not a triangle list`);
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      slot = this.bySlot.length;
      if (slot >= this.capacity) this.grow();
      this.bySlot.push(null);
    }
    const id = this.nextId++;
    const isBody = info.bodyId !== undefined;
    const lb = localBounds(info);
    const localSphere = boxSphere(lb.min, lb.max);
    const model = poseMatrix(info.origin, [0, 0, 0, 1]);
    const handle: PageDrawHandle = {
      id,
      setPose: (position, rotation) => this.setPose(id, position, rotation),
      dispose: () => this.dispose(id),
    };
    const page: TerrainPage = {
      id, slot, buffers, info: { ...info, origin: [...info.origin] as Vec3 }, isBody, visible: false, disposed: false, model, localSphere,
      worldSphere: { center: [0, 0, 0], radius: localSphere.radius }, newUntilFrame: 0, objectId: objectId & 0x3ff, handle,
    };
    this.pages.set(id, page);
    this.bySlot[slot] = page;
    this.fresh[slot] = 1;
    this.writeRecord(page);
    return handle;
  }

  private writeRecord(p: TerrainPage): void {
    const o = p.slot * PAGE_RECORD_FLOATS;
    const f = this.records, u = this.recordsU32;
    for (let k = 0; k < 16; k++) f[o + k] = p.model[k];
    // prevModel (o + 16) is maintained by beginFrame; a fresh page starts with prev = model.
    if (this.fresh[p.slot]) for (let k = 0; k < 16; k++) f[o + 16 + k] = p.model[k];
    f[o + 32] = p.info.origin[0]; f[o + 33] = p.info.origin[1]; f[o + 34] = p.info.origin[2]; f[o + 35] = p.isBody ? 1 : 0;
    const c = transformPoint(p.model, p.localSphere.center);
    p.worldSphere.center[0] = c[0]; p.worldSphere.center[1] = c[1]; p.worldSphere.center[2] = c[2];
    f[o + 36] = c[0]; f[o + 37] = c[1]; f[o + 38] = c[2]; f[o + 39] = p.worldSphere.radius;
    u[o + 40] = p.objectId; u[o + 41] = 0; u[o + 42] = p.newUntilFrame >>> 0; u[o + 43] = 0;
    this.markDirty(p.slot);
    this.hooks.dirty?.(p.slot, p.slot);
  }

  private live(id: number): TerrainPage {
    const p = this.pages.get(id);
    if (!p || p.disposed) throw new Error(`Terrain page ${id} is disposed or belongs to another host`);
    return p;
  }

  setPose(id: number, position: readonly number[], rotation: readonly number[]): void {
    const p = this.live(id);
    if (position.length !== 3 || rotation.length !== 4 || ![...position, ...rotation].every(Number.isFinite)) throw new Error(`Terrain page ${id}: invalid pose`);
    poseMatrix(position, rotation, p.model);
    this.writeRecord(p);
  }

  /** Atomic membership change; see the file comment. Returns the dirty world AABB of every shown and hidden page, or
   * the caller's tighter `dirty` box (clipped to them) when it knows which triangles changed. */
  commit(change: { show: readonly PageDrawHandle[]; hide: readonly PageDrawHandle[]; dirty?: { min: readonly number[]; max: readonly number[] } }): CommitRecord {
    const resolve = (h: PageDrawHandle) => {
      const p = this.pages.get(h.id);
      if (!p || p.disposed || p.handle !== h) throw new Error(`Terrain page ${h.id} is disposed or belongs to another host`);
      return p;
    };
    const hide = change.hide.map(resolve), show = change.show.map(resolve);
    if (new Set([...hide, ...show]).size !== hide.length + show.length) throw new Error('A terrain commit lists a page twice');
    if (hide.some(p => !p.visible)) throw new Error('A terrain commit hides a page that is not visible');
    if (show.some(p => p.visible)) throw new Error('A terrain commit shows a page that is already visible');
    // Nothing has changed so far; from here on the flip cannot fail.
    let dirty: { min: Vec3; max: Vec3 } | null = null;
    const grow = (p: TerrainPage) => {
      const { center: c, radius: r } = p.worldSphere;
      if (!dirty) dirty = { min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r] };
      else for (let k = 0; k < 3; k++) { dirty.min[k] = Math.min(dirty.min[k], c[k] - r); dirty.max[k] = Math.max(dirty.max[k], c[k] + r); }
    };
    for (const p of hide) { p.visible = false; grow(p); }
    const until = this.nextFrame + NEW_GEOMETRY_FRAMES;
    for (const p of show) { p.visible = true; p.newUntilFrame = until; this.writeRecord(p); grow(p); }
    const pages = dirty as { min: Vec3; max: Vec3 } | null, tight = change.dirty;
    if (pages && tight && [0, 1, 2].every(k => Math.max(pages.min[k], tight.min[k]) <= Math.min(pages.max[k], tight.max[k])))
      for (let k = 0; k < 3; k++) { pages.min[k] = Math.max(pages.min[k], tight.min[k]); pages.max[k] = Math.min(pages.max[k], tight.max[k]); }
    this.epoch++;
    const record: CommitRecord = { show: show.map(p => p.id), hide: hide.map(p => p.id), frame: this.nextFrame, dirty };
    this.commits.push(record);
    if (this.commits.length > 64) this.commits.shift();
    return record;
  }

  dispose(id: number): void {
    const p = this.pages.get(id);
    if (!p || p.disposed) return;
    if (p.visible) { this.disposedWhileVisible++; p.visible = false; }
    p.disposed = true;
    this.pages.delete(id);
    this.bySlot[p.slot] = null;
    this.freeSlots.push(p.slot);
    // Zero the record so a stale slot can never draw anything meaningful.
    this.records.fill(0, p.slot * PAGE_RECORD_FLOATS, (p.slot + 1) * PAGE_RECORD_FLOATS);
    this.markDirty(p.slot);
    this.hooks.release(p.buffers);
  }

  /** Start of frame `index`: prevModel ← model drawn last frame; remember this frame's model. */
  beginFrame(index: number): void {
    this.nextFrame = index + 1;
    for (let s = 0; s < this.bySlot.length; s++) {
      const p = this.bySlot[s];
      if (!p) continue;
      const o = s * PAGE_RECORD_FLOATS, d = s * 16;
      if (this.fresh[s]) {
        this.fresh[s] = 0;
        for (let k = 0; k < 16; k++) { this.records[o + 16 + k] = this.records[o + k]; this.drawn[d + k] = this.records[o + k]; }
        this.markDirty(s);
        continue;
      }
      let moved = false;
      for (let k = 0; k < 16; k++) {
        const prev = this.drawn[d + k];
        if (this.records[o + 16 + k] !== prev) { this.records[o + 16 + k] = prev; moved = true; }
        const cur = this.records[o + k];
        if (cur !== prev) { this.drawn[d + k] = cur; moved = true; }
      }
      if (moved) this.markDirty(s);
    }
  }

  /** Visible pages (optionally only static or only bodies). */
  visible(filter?: 'static' | 'body'): TerrainPage[] {
    const out: TerrainPage[] = [];
    for (const p of this.pages.values()) if (p.visible && (!filter || (filter === 'body') === p.isBody)) out.push(p);
    return out;
  }
}
