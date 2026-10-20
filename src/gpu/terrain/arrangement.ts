import type { Bounds, Vec3 } from '../../core/types';
import { add, sub as qsub, mul, div, fromNumber, toNumber, ZERO, ONE, type Rational } from '../../core/exact';
import { type CompiledRegionPage, type OccupiedRegion, type RegionFace, type RegionPage, type SampleField, type SourceBox, type SphereCut, type VertexRecipe, removesMaterial, ResidentFailure } from './contracts';
import { positionsInBox, brickBox, type ResidentLattice, type LatticeTet } from './lattice';
import { cross, dot, mean, sub } from './math';
import { WeightMap } from './page-packet';

const f = Math.fround;
export interface ResidentRecipe extends VertexRecipe { field?: number; planes?: readonly number[] }
type Recipe = ResidentRecipe;
export interface PreparedResidentField { field: Omit<SampleField, 'sample'>; samples: Float32Array; staticField: boolean; cut?: SphereCut }
export interface CompiledResidentPages { vertices: ResidentRecipe[]; pages: CompiledRegionPage[] }
interface Cell { faces: RegionFace[]; signs: number[] }
/** A cached face trace, identified (as the former `${source}/${sorted ids}` key) by its source and vertex set. */
interface FaceTrace { readonly hash: number; readonly source: string; readonly ids: Int32Array; readonly faces: RegionFace[]; reversed?: RegionFace[] }
const sameTrace = (t: FaceTrace, source: string, ids: ArrayLike<number>, n: number) => {
  if (t.source !== source || t.ids.length !== n) return false;
  for (let i = 0; i < n; i++) if (t.ids[i] !== ids[i]) return false;
  return true;
};
function traceHash(source: string, ids: ArrayLike<number>, n: number): number {
  let h1 = 0x811c9dc5 | 0, h2 = 0x2545f491 | 0;
  for (let i = 0; i < source.length; i++) { const c = source.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x5bd1e995); h2 ^= h2 >>> 13; }
  for (let i = 0; i < n; i++) { const v = ids[i] | 0; h1 = Math.imul(h1 ^ v, 0x01000193); h2 = Math.imul(h2 ^ (v + 0x7f4a7c15 + (h2 << 6) + (h2 >>> 2)), 0x85ebca6b); h2 ^= h2 >>> 15; }
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}
const NO_PLANES: readonly number[] = [];
const ascending = (a: number, b: number) => a - b;
/** Append a recipe's lattice support ids (iteration order) that `out` lacks. */
function supportKeys(weights: ReadonlyMap<number, number>, out: number[]): void {
  if (weights instanceof WeightMap) { const pairs = weights.pairs; for (let i = 0; i < pairs.length; i += 2) if (!out.includes(pairs[i])) out.push(pairs[i]); }
  else for (const k of weights.keys()) if (!out.includes(k)) out.push(k);
}
export interface OwnershipMask { readonly tet: string; readonly constraints: readonly number[]; readonly body: number }
/** One brick of a tet-granular compile: `tets` are the brick-local tet indices to recompile (null: all). */
export interface TetRequest { readonly brick: string; readonly tets: readonly number[] | null }
/** Rollback point for a staged transaction (see `mark`/`rollback`). */
export interface ArrangementMark { readonly fields: number; readonly cuts: number; readonly vertices: number; readonly traces: number; readonly physical: number; readonly physicalIds: number; readonly aliases: number }
/** Result of the sliced compaction; `applyCompaction` swaps it in synchronously. */
export interface CompactionPlan { readonly regions: Map<OccupiedRegion, OccupiedRegion>; readonly oldIds: Int32Array; readonly remap: Int32Array; readonly vertices: Recipe[];
  readonly intersections: Map<string, number>; readonly physicalVertices: Map<number, number>; readonly physicalOverflow: Map<string, number> }

/** Sample exactly within a supported field's box plus one cell diagonal (3·√3 ≈ 5.196): every vertex of a tet the
 * field can cross is then exact, and every remote word is a positive placeholder (see SampleField.support). */
export const SAMPLE_MARGIN = 6;
const PLACEHOLDER = 1;
const expand = (b: Bounds, m: number): Bounds => ({ min: b.min.map(v => v - m) as Vec3, max: b.max.map(v => v + m) as Vec3 });
const overlaps = (a: Bounds, b: Bounds) => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1] && a.min[2] <= b.max[2] && a.max[2] >= b.min[2];

/** CPU compiles the bounded clipping topology; the GPU executes this canonical
 * intersection DAG and constructs/validates occupied volume and surface pages.
 * All neighbors see ALL crossing source traces, including Boolean-inactive ones.
 * No final render vertices are uploaded. The independent exact kernel is untouched.
 *
 * Edits are O(dirty): a new field is sampled only inside its support, the recompiled set is the tets with a vertex
 * inside the cutter (clean tets reuse the previous page's output, bit-identically), face traces are invalidated only
 * for those tets, and each brick keeps the static fields that can be non-positive in it. */
export class ResidentArrangement {
  /** Swapped wholesale by applyCompaction: read it through the arrangement, never keep the array. */
  vertices: Recipe[] = [];
  readonly fields: SampleField[] = [];
  readonly boxes: readonly SourceBox[];
  readonly cuts: SphereCut[] = [];
  readonly cutFields: number[] = [];
  private readonly cutFieldSet = new Set<number>();
  private readonly staticFlags: boolean[] = [];
  /** Static fields per brick that can be non-positive there (all others are +1 on every tet), ascending. */
  private readonly brickStatic = new Map<string, number[]>();
  /** vertices.length when each field was appended (worker rollback). */
  private readonly fieldVertexMark: number[] = [];
  readonly boxFields: number[][] = [];
  /** Supports of each source's supported fields (a region needs every field non-positive somewhere). */
  private readonly boxSupports: Bounds[][] = [];
  readonly samples: (readonly number[] | Float32Array)[] = [];
  fallbackCount = 0;
  private intersections = new Map<string, number>();
  /** v2: (field, a, b) -> vertex. Its canonical key is a pure function of those operands, so a hit skips the
   * weight/plane/key reconstruction. Logged while staging; cleared by cold rollback and compaction. */
  private readonly edgeAlias = new Map<number, Map<number, number>>();
  private aliasLog: number[] = [];
  private readonly values = new Map<number, Map<number, number>>();
  private readonly exactWeights = new Map<number, Map<number, Rational>>();
  /** Physical identity: exactly equal f32 positions (-0 == 0) share one id, the first registered. Keyed by a 53-bit
   * hash of the coordinate bits; a (confirmed) hash collision falls back to the overflow map keyed by text. */
  private physicalVertices = new Map<number, number>();
  private physicalOverflow = new Map<string, number>();
  private readonly physicalIds: number[] = [];
  /** Face traces by traceHash; a bucket holds the rare colliding traces. Lookups build no key strings. */
  private readonly faceTraces = new Map<number, FaceTrace | FaceTrace[]>();
  private readonly traceKeysByTet = new Map<number, FaceTrace[]>();
  private readonly sourceCandidates = new Map<string, number[]>();
  /** Insertion logs of the open stage (main thread): rollback deletes exactly these entries. */
  private traceLog: FaceTrace[] = [];
  private physicalLog: (number | string)[] = [];
  private physicalIdLog: number[] = [];
  private staging = false;
  private maskIndex = new WeakMap<readonly OwnershipMask[], { length: number; byTet: Map<string, OwnershipMask[]> }>();
  // A tet is compiled synchronously; none of its output retains these global-field scratch tables.
  // Reuse them across 98,304 planet tets instead of allocating ~130 MB of short-lived arrays per full planet.
  private tetSigns = new Int8Array(0);
  private tetSlots = new Int32Array(0);
  // Compile scratch, never retained by any output (workers compile ~10^5 cells per edit; per-cell Sets, Maps, spread
  // arrays and string keys were most of their garbage). Vertex-indexed stamp tables: an entry belongs to the current
  // pass when it holds that pass's mark.
  private marks = 0;
  private seenMark = new Int32Array(0); private capMark = new Int32Array(0); private linkMark = new Int32Array(0);
  private valueOf = new Float64Array(0); private linkTo = new Int32Array(0);
  private fieldMark = new Int32Array(0);
  private points = new Int32Array(64); private distinctIds = new Int32Array(64); private linkOrder = new Int32Array(64);
  private traceValues = new Float64Array(64); private stack = new Int32Array(256);
  private liveIds = new Int32Array(1024);
  /** Mark `id` and its construction ancestors live (ids below `base` are lattice positions); returns the live count. */
  private visitLive(id: number, base: number, live: number, found: number): number {
    let top = 0; this.stack[top++] = id;
    while (top) {
      const next = this.stack[--top]; if (next < base || this.seenMark[next] === live) continue;
      this.seenMark[next] = live; this.liveIds = ResidentArrangement.grown(this.liveIds, found + 1); this.liveIds[found++] = next;
      const edge = this.vertices[next].edge;
      if (edge) { this.stack = ResidentArrangement.grown(this.stack, top + 2); this.stack[top++] = edge[0]; this.stack[top++] = edge[1]; }
    }
    return found;
  }
  private readonly supportScratch: number[] = []; private readonly sortedScratch: number[] = []; private readonly planeScratch: number[] = [];
  private readonly ownPlanes: [number[], number[]] = [[0], [0]];
  /** A recipe's own field as a one-plane list (endpoint 0 or 1 of the intersection being built). */
  private ownPlane(endpoint: 0 | 1, field: number): readonly number[] { const list = this.ownPlanes[endpoint]; list[0] = field; return list; }
  private nextMark(): number {
    if (this.marks >= 0x3fffffff) { this.marks = 0; this.seenMark.fill(0); this.capMark.fill(0); this.linkMark.fill(0); this.fieldMark.fill(0); }
    return ++this.marks;
  }
  /** Grow the vertex-indexed tables to hold id `n - 1`. */
  private reserve(n: number): void {
    if (n <= this.seenMark.length) return;
    const size = Math.max(n, this.seenMark.length * 2, 1024);
    const grow = <T extends Int32Array | Float64Array>(old: T, next: T): T => { next.set(old); return next; };
    this.seenMark = grow(this.seenMark, new Int32Array(size)); this.capMark = grow(this.capMark, new Int32Array(size)); this.linkMark = grow(this.linkMark, new Int32Array(size));
    this.valueOf = grow(this.valueOf, new Float64Array(size)); this.linkTo = grow(this.linkTo, new Int32Array(size));
  }
  private static grown<T extends Int32Array | Float64Array>(array: T, n: number): T {
    if (n <= array.length) return array;
    const next = new(array.constructor as { new(size: number): T })(Math.max(n, array.length * 2)); next.set(array); return next;
  }
  /** distinctIds[0, n) as a plain array (face vertex lists are number[]). */
  private distinctList(n: number): number[] { const ids = this.distinctIds, out: number[] = []; for (let i = 0; i < n; i++) out.push(ids[i]); return out; }
  /** Distinct ids of points[0, count) in first-occurrence order (as [...new Set(...)]) into distinctIds; returns their count. */
  private distinct(count: number): number {
    const points = this.points, out = this.distinctIds = ResidentArrangement.grown(this.distinctIds, count); let n = 0;
    outer: for (let i = 0; i < count; i++) { const id = points[i]; for (let j = 0; j < n; j++) if (out[j] === id) continue outer; out[n++] = id; }
    return n;
  }
  /** math.ts area() over vertex ids, term for term. */
  private areaOf(ids: ArrayLike<number>, n: number): number {
    let result = 0; const o = this.vertices[ids[0]].position;
    for (let i = 1; i + 1 < n; i++) {
      const a = this.vertices[ids[i]].position, b = this.vertices[ids[i + 1]].position, ax = a[0] - o[0], ay = a[1] - o[1], az = a[2] - o[2], bx = b[0] - o[0], by = b[1] - o[1], bz = b[2] - o[2];
      result += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
    }
    return result;
  }
  private candidates(tet: LatticeTet): number[] {
    let candidates = this.sourceCandidates.get(tet.id);
    if (!candidates) {
      candidates = [];
      let box: Bounds | undefined;
      this.boxFields.forEach((fields, i) => {
        const supports = this.boxSupports[i];
        if (supports.length) {
          if (!box) { const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
            for (const v of tet.vertices) { const p = this.lattice.positions[v]; for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); } } box = { min: lo, max: hi }; }
          // A field of this source is strictly positive on the whole tet: it cannot own a region here.
          if (supports.some(support => !overlaps(support, box!))) return;
        }
        const v = tet.vertices;
        if (fields.every(field => { const s = this.samples[field], a = s[v[0]], b = s[v[1]], c = s[v[2]], d = s[v[3]];
          return a < 0 || b < 0 || c < 0 || d < 0 || (a === 0 && b === 0 && c === 0 && d === 0); })) candidates!.push(i);
      });
      this.sourceCandidates.set(tet.id, candidates);
    }
    return candidates;
  }
  private physicalId(id: number): number {
    const cached = this.physicalIds[id]; if (cached !== undefined) return cached;
    const p = this.vertices[id].position, key = positionKey(p);
    if (this.staging) this.physicalIdLog.push(id);
    let existing = this.physicalVertices.get(key);
    if (existing === undefined) { this.physicalVertices.set(key, id); if (this.staging) this.physicalLog.push(key); return this.physicalIds[id] = id; }
    const q = this.vertices[existing].position;
    if (q[0] === p[0] && q[1] === p[1] && q[2] === p[2]) return this.physicalIds[id] = existing;
    const text = p.join(','); existing = this.physicalOverflow.get(text);
    if (existing !== undefined) return this.physicalIds[id] = existing;
    this.physicalOverflow.set(text, id); if (this.staging) this.physicalLog.push(text); return this.physicalIds[id] = id;
  }
  private physicalFaces(faces: readonly RegionFace[]): RegionFace[] {
    const output: RegionFace[] = []; let collapsed: Set<number> | undefined;
    for (const face of faces) {
      const v = face.vertices; let points = this.points;
      if (v.length > points.length) points = this.points = ResidentArrangement.grown(points, v.length);
      let same = true;
      for (let i = 0; i < v.length; i++) { const id = this.physicalId(v[i]); points[i] = id; if (id !== v[i]) same = false; }
      const n = this.distinct(v.length), ids = this.distinctIds;
      if (n < 3) continue;
      // A face whose physical ids are its own ids is kept as is (faces are immutable): no copy per face.
      if (this.areaOf(ids, n) > 0) output.push(same && n === v.length ? face : { ...face, vertices: this.distinctList(n) });
      else { collapsed ??= new Set<number>(); for (let i = 0; i < n; i++) collapsed.add(ids[i]); }
    }
    if (!collapsed) return output;
    // A rounded-flat trace has no surface area, but its intermediate edge vertices still subdivide the adjoining
    // polygons. Retain those exact f32 subdivisions when removing the flat patch; otherwise one long edge faces
    // two short edges (seed 27), breaking the closed boundary. No positions are welded, moved or newly sampled.
    return output.map(face => {
      const vertices: number[] = [];
      for (let i = 0; i < face.vertices.length; i++) {
        const a = face.vertices[i], b = face.vertices[(i + 1) % face.vertices.length], p = this.vertices[a].position, q = this.vertices[b].position;
        vertices.push(a);
        const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], axis = Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) >= Math.abs(dz) ? 0 : Math.abs(dy) >= Math.abs(dz) ? 1 : 2;
        const inside: { id: number; t: number }[] = [];
        for (const id of collapsed) {
          if (id === a || id === b) continue;
          const r = this.vertices[id].position, t = (r[axis] - p[axis]) / (q[axis] - p[axis]);
          if (!(t > 0 && t < 1)) continue;
          const rx = r[0] - p[0], ry = r[1] - p[1], rz = r[2] - p[2];
          if (dy * rz - dz * ry === 0 && dz * rx - dx * rz === 0 && dx * ry - dy * rx === 0) inside.push({ id, t });
        }
        inside.sort((a, b) => a.t - b.t); for (const point of inside) vertices.push(point.id);
      }
      return vertices.length === face.vertices.length ? face : { ...face, vertices };
    });
  }
  constructor(readonly lattice: ResidentLattice, boxes: readonly SourceBox[], readonly maxRegionsPerTet = 512, readonly localConstruction = false, readonly uniformRegions = false, private readonly deferSamples = false) {
    if (new Set(boxes.map(b => b.id)).size !== boxes.length || boxes.some(b => !b.id || !Number.isSafeInteger(b.material) || b.material < 1 ||
      b.bounds.min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(b.bounds.max[i]) || v >= b.bounds.max[i]))) throw new ResidentFailure('validation', 'Invalid source box identity, material or bounds');
    this.boxes = boxes.map(b => ({ ...b, bounds: structuredClone(b.bounds), ...(b.fields ? { fields: Object.freeze(b.fields.map(field => Object.freeze({ ...field }))) } : {}) }));
    this.boxes.forEach(b => { Object.freeze(b.bounds.min); Object.freeze(b.bounds.max); Object.freeze(b.bounds); Object.freeze(b); });
    Object.freeze(this.boxes);
    for (const brick of lattice.brickOrder) this.brickStatic.set(brick, []);
    lattice.positions.forEach((p, id) => this.vertices.push({ id, key: `v:${lattice.keys[id]}`, level: 0, position: [...p], base: [...p], weights: new WeightMap([id, 1]) }));
    const planes = new Map<string, number>();
    this.boxFields = this.boxes.map(box => box.fields ? box.fields.map(field => this.addField(field)) : [0, 1, 2].flatMap(axis => [-1, 1].map(sign => {
      const edge = f(sign < 0 ? box.bounds.min[axis] : box.bounds.max[axis]);
      const key = `${axis}/${sign}/${edge}`;
      let index = planes.get(key);
      if (index === undefined) { index = this.addField({ id: `plane:${key}`, sample: p => f(sign * f(p[axis] - edge)) }); planes.set(key, index); }
      return index;
    })));
    this.boxSupports = this.boxFields.map(fields => fields.flatMap(field => this.fields[field].support ? [this.fields[field].support!] : []));
  }
  /** Lattice words of a field: exact inside its support (plus SAMPLE_MARGIN), a positive placeholder elsewhere. */
  private sample(field: SampleField): Float32Array {
    const positions = this.lattice.positions, out = new Float32Array(positions.length);
    const put = (id: number) => { const value = f(field.sample(positions[id])); if (!Number.isFinite(value)) throw new ResidentFailure('validation', 'Non-finite source sample'); out[id] = value; };
    if (field.support) { out.fill(PLACEHOLDER); positionsInBox(this.lattice, expand(field.support, SAMPLE_MARGIN), put); }
    else for (let id = 0; id < positions.length; id++) put(id);
    return out;
  }
  private registerStatic(i: number): void {
    const support = this.fields[i].support;
    const { brickOrder, brickBoxes } = this.lattice;
    for (let b = 0; b < brickOrder.length; b++) if (!support || overlaps(brickBoxes[b], support)) this.brickStatic.get(brickOrder[b])!.push(i);
  }
  addField(field: SampleField, body = false): number {
    const i = this.fields.length; this.fields.push(Object.freeze(field)); this.fieldVertexMark[i] = this.vertices.length; this.staticFlags[i] = !body;
    if (this.deferSamples) Object.defineProperty(this.samples, i, { configurable: true, enumerable: true, get: () => { const value = this.sample(field); Object.defineProperty(this.samples, i, { value, writable: true, configurable: true, enumerable: true }); return value; } });
    else this.samples.push(this.sample(field));
    if (!body) { this.registerStatic(i); if (this.faceTraces.size) this.invalidateTraces(i); }
    return i;
  }
  acceptPreparedSamples(samples: Float32Array[]): void {
    if (samples.length !== this.fields.length || samples.some(s => s.length !== this.lattice.positions.length)) throw new ResidentFailure('validation', 'Invalid prepared lattice samples');
    samples.forEach((value, i) => Object.defineProperty(this.samples, i, { value, writable: true, configurable: true, enumerable: true }));
  }
  addCut(cut: SphereCut): number {
    if (!cut.center.every(Number.isFinite) || !(cut.radius > 0) || !Number.isFinite(cut.radius) || cut.shells || (cut.materials !== undefined && !(Number.isInteger(cut.materials) && cut.materials > 0 && cut.materials <= 0xffffffff))) throw new ResidentFailure('validation', 'Invalid sphere cut');
    const duplicate = this.cuts.findIndex(c => c.radius === cut.radius && c.materials === cut.materials && c.center.every((x, i) => x === cut.center[i]));
    if (duplicate >= 0) return this.cutFields[duplicate];
    if (!cut.id || this.fields.some(field => field.id === cut.id)) throw new ResidentFailure('validation', 'Cut source identity is already in use');
    const accepted = structuredClone(cut); Object.freeze(accepted.center); Object.freeze(accepted); this.cuts.push(accepted);
    const index = this.addField(sphereField(accepted.id, accepted.center, accepted.radius, accepted.materials)); this.cutFields.push(index); this.cutFieldSet.add(index); return index;
  }
  /** Tets with a vertex whose sample is <= 0 (the only tets a new field can change), ascending by lattice index. */
  dirtyTets(field: number): number[] {
    const s = this.samples[field], support = this.fields[field].support, { tetStart, tetIndex } = this.lattice, marked = new Set<number>();
    const visit = (id: number) => { if (s[id] <= 0) for (let k = tetStart[id]; k < tetStart[id + 1]; k++) marked.add(tetIndex[k]); };
    if (support) positionsInBox(this.lattice, expand(support, SAMPLE_MARGIN), visit); else for (let id = 0; id < s.length; id++) visit(id);
    return [...marked].sort((a, b) => a - b);
  }
  dirtyBricks(field: number): Set<string> { return new Set(this.dirtyTets(field).map(t => this.lattice.tets[t].brick)); }
  /** Group lattice tet indices into per-brick requests (bricks in order of first tet, brick-local indices ascending). */
  tetRequests(tets: Iterable<number>): TetRequest[] {
    const byBrick = new Map<string, number[]>();
    for (const index of [...new Set(tets)].sort((a, b) => a - b)) { const tet = this.lattice.tets[index], list = byBrick.get(tet.brick); if (list) list.push(tet.local); else byBrick.set(tet.brick, [tet.local]); }
    return [...byBrick].map(([brick, tets]) => ({ brick, tets }));
  }
  private invalidateTraces(field: number): void {
    for (const tet of this.dirtyTets(field)) { const traces = this.traceKeysByTet.get(tet); if (!traces) continue; for (const trace of traces) this.deleteTrace(trace); this.traceKeysByTet.delete(tet); }
  }
  private findTrace(hash: number, source: string, ids: ArrayLike<number>, n: number): FaceTrace | undefined {
    const bucket = this.faceTraces.get(hash);
    if (!bucket) return undefined;
    if (!Array.isArray(bucket)) return sameTrace(bucket, source, ids, n) ? bucket : undefined;
    return bucket.find(trace => sameTrace(trace, source, ids, n));
  }
  private storeTrace(trace: FaceTrace): void {
    const bucket = this.faceTraces.get(trace.hash);
    if (!bucket) this.faceTraces.set(trace.hash, trace); else if (Array.isArray(bucket)) bucket.push(trace); else this.faceTraces.set(trace.hash, [bucket, trace]);
  }
  /** Delete whatever trace has this one's key (the former string-keyed delete), not only this object. */
  private deleteTrace(trace: FaceTrace): void {
    const bucket = this.faceTraces.get(trace.hash);
    if (!bucket) return;
    if (!Array.isArray(bucket)) { if (sameTrace(bucket, trace.source, trace.ids, trace.ids.length)) this.faceTraces.delete(trace.hash); return; }
    const at = bucket.findIndex(entry => sameTrace(entry, trace.source, trace.ids, trace.ids.length));
    if (at < 0) return;
    bucket.splice(at, 1);
    if (bucket.length === 1) this.faceTraces.set(trace.hash, bucket[0]);
  }
  private exact(id: number): Map<number, Rational> {
    const cached = this.exactWeights.get(id); if (cached) return cached;
    const v = this.vertices[id]; let result: Map<number, Rational>;
    if (v.base) result = new Map([[id, ONE]]);
    else {
      const [a, b] = v.edge!, wa = this.exact(a), wb = this.exact(b);
      const fa = this.exactValue(a, v.field!), fb = this.exactValue(b, v.field!), t = div(fa, qsub(fa, fb));
      result = new Map();
      for (const key of new Set([...wa.keys(), ...wb.keys()])) result.set(key, add(mul(wa.get(key) ?? ZERO, qsub(ONE, t)), mul(wb.get(key) ?? ZERO, t)));
    }
    this.exactWeights.set(id, result); return result;
  }
  private exactValue(id: number, field: number): Rational {
    let sum = ZERO; for (const [key, weight] of this.exact(id)) sum = add(sum, mul(weight, fromNumber(this.samples[field][key]))); return sum;
  }
  private value(id: number, field: number): number {
    const v = this.vertices[id]; let value = 0;
    if (v.field === field || v.planes?.includes(field)) return 0;
    if (v.base) return this.samples[field][id];
    let cache = this.values.get(field);
    const cached = cache?.get(id); if (cached !== undefined) return cached;
    {
      let scale = 0; const samples = this.samples[field], weights = v.weights;
      if (weights instanceof WeightMap) { const pairs = weights.pairs; for (let i = 0; i < pairs.length; i += 2) { const term = pairs[i + 1] * samples[pairs[i]]; value += term; scale += Math.abs(term); } }
      else for (const [base, weight] of weights) { const term = weight * samples[base]; value += term; scale += Math.abs(term); }
      if (Math.abs(value) < 1e-12 * Math.max(1, scale)) {
        // A construction edge whose endpoints are both on this plane is
        // identically zero; no big-integer reconstruction is needed to prove it.
        if (v.edge && this.value(v.edge[0], field) === 0 && this.value(v.edge[1], field) === 0) value = 0;
        else {
          this.fallbackCount++;
          const q = this.exactValue(id, field); value = toNumber(q);
          if (!Number.isFinite(value) || (value === 0 && q.n !== 0n)) throw new ResidentFailure('validation', `Unresolved local predicate ${id}/${field}`);
        }
      }
    }
    if (!cache) { cache = new Map(); this.values.set(field, cache); } cache.set(id, value); return value;
  }
  private alias(field: number, pair: number, id: number): number {
    let map = this.edgeAlias.get(field); if (!map) { map = new Map(); this.edgeAlias.set(field, map); }
    map.set(pair, id); if (this.staging) this.aliasLog.push(field, pair); return id;
  }
  private intersection(a: number, b: number, field: number): number {
    if (a > b) { const swap = a; a = b; b = swap; }
    const pair = a * 67108864 + b;
    if (this.uniformRegions) { const hit = this.edgeAlias.get(field)?.get(pair); if (hit !== undefined) return hit; }
    // Uniform arrangements key every intersection canonically (here, in merges and in compaction), so the edge key can
    // only ever be found in the legacy profile: building it there alone changes no lookup.
    let key = '';
    if (!this.uniformRegions) { key = `${field}:${a}:${b}`; const cached = this.intersections.get(key); if (cached !== undefined) return cached; }
    const fa = this.value(a, field), fb = this.value(b, field), t = fa / (fa - fb);
    const va = this.vertices[a], vb = this.vertices[b];
    // Scratch lists until a new recipe keeps them: the union of both supports (first occurrence) and incident planes.
    const scratch = this.supportScratch; scratch.length = 0;
    supportKeys(va.weights, scratch); supportKeys(vb.weights, scratch);
    let planes: number[] | undefined;
    if (this.uniformRegions) {
      const incident = this.planeScratch; incident.length = 0; incident.push(field);
      const pa = va.planes ?? (va.field === undefined ? NO_PLANES : this.ownPlane(0, va.field)), pb = vb.planes ?? (vb.field === undefined ? NO_PLANES : this.ownPlane(1, vb.field));
      for (let i = 0; i < pa.length + pb.length; i++) {
        const plane = i < pa.length ? pa[i] : pb[i - pa.length];
        // The distinct planes of both endpoints in first-occurrence order (the former Set), each tested once.
        if (i < pa.length ? pa.indexOf(plane) !== i : (pa.includes(plane) || pb.indexOf(plane) !== i - pa.length)) continue;
        if (plane !== field && this.value(a, plane) === 0 && this.value(b, plane) === 0) incident.push(plane);
      }
      incident.sort(ascending);
      // The original simplex support and incident source planes identify a
      // vertex independently of the order in which inactive traces are applied.
      const sorted = this.sortedScratch; sorted.length = 0; for (const k of scratch) sorted.push(k); sorted.sort(ascending);
      key = `source:${sorted.join(',')}/${incident.join(',')}`;
      const canonical = this.intersections.get(key); if (canonical !== undefined) return this.alias(field, pair, canonical);
      planes = [...incident];
    }
    // Alternate construction edges can resolve to an existing canonical source vertex.
    // Its cached recipe already owns these weights, so allocate/interpolate only for a new recipe.
    const support = [...scratch], pairs: number[] = new Array(support.length * 2);
    for (let i = 0; i < support.length; i++) { const k = support[i]; pairs[i * 2] = k; pairs[i * 2 + 1] = (va.weights.get(k) ?? 0) * (1 - t) + (vb.weights.get(k) ?? 0) * t; }
    const weights = new WeightMap(pairs);
    const ta = f(fa), tb = f(fb), ratio = f(ta / f(ta - tb));
    const basis = this.localConstruction ? support : undefined, barycentric = basis?.map((_, i) => f(pairs[i * 2 + 1]));
    let position: Vec3;
    if (basis) {
      const origin = this.lattice.positions[basis[0]];
      position = origin.map((v, a) => {
        let delta = 0; for (let i = 1; i < basis.length; i++) delta = f(delta + f(f(this.lattice.positions[basis[i]][a] - v) * barycentric![i]));
        return f(v + delta);
      }) as Vec3;
    }
    // Match the shader's explicit f32 edge-local construction. Only source operands are uploaded.
    else position = va.position.map((v, i) => f(v + f(f(vb.position[i] - v) * ratio))) as Vec3;
    const id = this.vertices.length;
    this.vertices.push({ id, key, level: basis ? 1 : Math.max(va.level, vb.level) + 1, position, weights, edge: [a, b], values: [ta, tb], field, basis, barycentric, planes });
    this.intersections.set(key, id); return this.uniformRegions ? this.alias(field, pair, id) : id;
  }
  private split(cell: Cell, field: number, slot = 0): Cell[] {
    // Every distinct vertex of the cell is evaluated once, in first-occurrence order (the former Set/Map pass).
    const seen = this.nextMark(); let negative = false, positive = false;
    for (const face of cell.faces) for (const id of face.vertices) {
      if (id >= this.seenMark.length) this.reserve(id + 1);
      if (this.seenMark[id] === seen) continue;
      this.seenMark[id] = seen; const value = this.value(id, field); this.valueOf[id] = value;
      if (value < 0) negative = true; else if (value > 0) positive = true;
    }
    if (!negative || !positive) { cell.signs[slot] = positive ? field + 1 : -(field + 1); return [cell]; }
    const caps = this.nextMark(), below = [...cell.signs], above = [...cell.signs]; below[slot] = -(field + 1); above[slot] = field + 1;
    const sides: Cell[] = [{ faces: [], signs: below }, { faces: [], signs: above }];
    for (const face of cell.faces) for (let side = 0; side < 2; side++) {
      const v = face.vertices, n = v.length, sign = side ? 1 : -1; let count = 0, points = this.points;
      if (points.length < 2 * n) points = this.points = ResidentArrangement.grown(points, 2 * n);
      for (let i = 0; i < n; i++) {
        const a = v[i], b = v[(i + 1) % n], fa = this.valueOf[a], fb = this.valueOf[b];
        if (fa * sign >= 0) points[count++] = a;
        if (fa === 0) this.capMark[a] = caps;
        if (fa * fb < 0) { const id = this.intersection(a, b, field); points[count++] = id; if (id >= this.capMark.length) this.reserve(id + 1); this.capMark[id] = caps; }
      }
      const unique = this.distinct(count), ids = this.distinctIds;
      if (unique >= 3 && this.areaOf(ids, unique) > 0) sides[side].faces.push({ vertices: this.distinctList(unique), source: face.source });
    }
    // Recover orientation from the clipped face cycles, never from a nearly
    // coplanar rounded positive point. Each cap edge opposes its side-face edge.
    // Links b -> a keep the former Map's semantics: the last write wins, keys stay in first-insertion order.
    const linked = this.nextMark(); let links = 0;
    for (const face of sides[0].faces) for (let i = 0; i < face.vertices.length; i++) {
      const a = face.vertices[i], b = face.vertices[(i + 1) % face.vertices.length];
      if (this.capMark[a] === caps && this.capMark[b] === caps) {
        if (this.linkMark[b] !== linked) { this.linkMark[b] = linked; if (links >= this.linkOrder.length) this.linkOrder = ResidentArrangement.grown(this.linkOrder, links + 1); this.linkOrder[links++] = b; }
        this.linkTo[b] = a;
      }
    }
    const first = links ? this.linkOrder[0] : undefined, ring: number[] = [];
    if (first !== undefined) { let current: number | undefined = first; do { ring.push(current); current = this.linkMark[current] === linked ? this.linkTo[current] : undefined; } while (current !== undefined && current !== first && ring.length <= links); }
    const last = ring[ring.length - 1];
    if (ring.length < 3 || ring.length !== links || (this.linkMark[last] === linked ? this.linkTo[last] : undefined) !== ring[0]) throw new ResidentFailure('validation', 'Unresolved canonical cap cycle');
    sides[0].faces.push({ vertices: ring, source: this.fields[field].id });
    sides[1].faces.push({ vertices: [...ring].reverse(), source: this.fields[field].id });
    return sides;
  }
  /** A uniform convex tet needs its shared face traces, not an internal 3D
   * arrangement of Boolean-inactive planes. The 2D clipping uses the same
   * canonical edge recipes and field order as ordinary region construction. */
  private tracedFace(face: RegionFace, crossing: readonly number[], tet: number): readonly RegionFace[] {
    const v = face.vertices, n = v.length;
    let start = 0; for (let i = 1; i < n; i++) if (v[i] < v[start]) start = i;
    // The canonical cycle starts at the smallest id, oriented so that its second id is below its last.
    const same = v[(start + 1) % n] < v[(start + n - 1) % n];
    let key = this.distinctIds; if (key.length < n) key = this.distinctIds = ResidentArrangement.grown(key, n);
    for (let i = 0; i < n; i++) { const id = v[i]; let j = i; while (j > 0 && key[j - 1] > id) { key[j] = key[j - 1]; j--; } key[j] = id; }
    const hash = traceHash(face.source, key, n);
    let trace = this.findTrace(hash, face.source, key, n);
    if (!trace) {
      const ids = key.slice(0, n), sorted: number[] = new Array(n);
      for (let i = 0; i < n; i++) sorted[i] = v[(start + (same ? i : n - i)) % n];
      let polygons: number[][] = [sorted];
      for (const field of crossing) {
        let negative = false, positive = false;
        for (let i = 0; i < n; i++) if (this.value(sorted[i], field) < 0) { negative = true; break; }
        if (negative) for (let i = 0; i < n; i++) if (this.value(sorted[i], field) > 0) { positive = true; break; }
        if (!negative || !positive) continue;
        const next: number[][] = [];
        for (const polygon of polygons) {
          const m = polygon.length, values = this.traceValues = ResidentArrangement.grown(this.traceValues, m); let below = false, above = false;
          for (let i = 0; i < m; i++) { const value = this.value(polygon[i], field); values[i] = value; if (value < 0) below = true; else if (value > 0) above = true; }
          if (!below || !above) { next.push(polygon); continue; }
          for (let sign = -1; sign <= 1; sign += 2) {
            let count = 0, points = this.points; if (points.length < 2 * m) points = this.points = ResidentArrangement.grown(points, 2 * m);
            for (let i = 0; i < m; i++) {
              const j = (i + 1) % m, a = polygon[i], b = polygon[j], fa = this.traceValues[i], fb = this.traceValues[j];
              if (fa * sign >= 0) points[count++] = a;
              if (fa * fb < 0) points[count++] = this.intersection(a, b, field);
            }
            const unique = this.distinct(count);
            // Keep rounded-flat patches until physicalFaces: their edge subdivisions still close neighboring
            // polygons even when the patch itself has no f32 surface area.
            if (unique >= 3) next.push(this.distinctList(unique));
          }
        }
        polygons = next;
      }
      trace = { hash, source: face.source, ids, faces: polygons.map(vertices => ({ vertices, source: face.source })) }; this.storeTrace(trace);
      const traces = this.traceKeysByTet.get(tet); if (traces) traces.push(trace); else this.traceKeysByTet.set(tet, [trace]);
      if (this.staging) this.traceLog.push(trace);
    }
    // Faces are immutable: the reversed copies are made once per trace, not once per request.
    return same ? trace.faces : trace.reversed ??= trace.faces.map(face => ({ ...face, vertices: [...face.vertices].reverse() }));
  }
  private masksFor(masks: readonly OwnershipMask[], tet: string): readonly OwnershipMask[] {
    if (!masks.length) return masks;
    let index = this.maskIndex.get(masks);
    if (!index) { index = { length: 0, byTet: new Map() }; this.maskIndex.set(masks, index); }
    for (; index.length < masks.length; index.length++) { const mask = masks[index.length], list = index.byTet.get(mask.tet); if (list) list.push(mask); else index.byTet.set(mask.tet, [mask]); }
    return index.byTet.get(tet) ?? [];
  }
  /** A cell's sign of `field` (the tet's constant sign, or the cell's own sign of a crossing field). */
  private sign(cell: readonly number[], field: number): number { const slot = this.tetSlots[field]; return slot < 0 ? this.tetSigns[field] * (field + 1) : cell[slot]; }
  private tet(tet: LatticeTet, masks: readonly OwnershipMask[]): { regions: OccupiedRegion[]; removedVolume: number } {
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (const id of tet.vertices) { const point = this.vertices[id].position; lx = Math.min(lx, point[0]); hx = Math.max(hx, point[0]); ly = Math.min(ly, point[1]); hy = Math.max(hy, point[1]); lz = Math.min(lz, point[2]); hz = Math.max(hz, point[2]); }
    // Safe authored-volume rejection, independent of cutter and rounded output geometry.
    let inside = false;
    for (const { bounds: b } of this.boxes) if (lx < b.max[0] && hx > b.min[0] && ly < b.max[1] && hy > b.min[1] && lz < b.max[2] && hz > b.min[2]) { inside = true; break; }
    if (!inside) return { regions: [], removedVolume: 0 };
    // Fields outside this brick's list are strictly positive on it: sign +1, never crossing.
    const listed = this.brickStatic.get(tet.brick)!;
    if (this.tetSigns.length < this.fields.length) { this.tetSigns = new Int8Array(this.fields.length); this.tetSlots = new Int32Array(this.fields.length); }
    const signs = this.tetSigns.fill(1), slots = this.tetSlots.fill(-1), crossing: number[] = [], cutsHere: number[] = [];
    for (const field of listed) {
      // A constant sign on the original tet is constant on every convex subcell.
      // Most prepared fields have finite support; do not revisit all fragments.
      const samples = this.samples[field], v0 = samples[tet.vertices[0]], v1 = samples[tet.vertices[1]], v2 = samples[tet.vertices[2]], v3 = samples[tet.vertices[3]];
      const negative = v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0, positive = v0 > 0 || v1 > 0 || v2 > 0 || v3 > 0;
      if (!negative || !positive) signs[field] = positive ? 1 : -1;
      else { slots[field] = crossing.length; crossing.push(field); }
      if (this.cutFieldSet.has(field)) cutsHere.push(field);
    }
    const possibleSources = this.candidates(tet);
    if (!possibleSources.length) return { regions: [], removedVolume: 0 };
    const faces = tet.faces ??= tet.vertices.map((_, opposite) => {
      const vertices = tet.vertices.filter((_, i) => i !== opposite), q = vertices.map(id => this.vertices[id].position);
      if (dot(cross(sub(q[1], q[0]), sub(q[2], q[0])), sub(this.vertices[tet.vertices[opposite]].position, q[0])) > 0) vertices.reverse();
      return { vertices, source: `face:${[...vertices].sort((a, b) => a - b).join(',')}` };
    });
    const localMasks = this.masksFor(masks, tet.id);
    let active: number[];
    if (this.uniformRegions) {
      const relevant = this.nextMark();
      if (this.fieldMark.length < this.fields.length) this.fieldMark = ResidentArrangement.grown(this.fieldMark, this.fields.length);
      for (const i of possibleSources) for (const field of this.boxFields[i]) this.fieldMark[field] = relevant;
      for (const mask of localMasks) for (const sign of mask.constraints) this.fieldMark[Math.abs(sign) - 1] = relevant;
      // A material cutter (rust-engine-v22) removes only cells owned by its materials: where no candidate has one it is as
      // irrelevant as a remote source's plane and does not subdivide (core.rs compile_tet).
      active = crossing.filter(field => { if (this.fieldMark[field] === relevant) return true; if (!this.cutFieldSet.has(field)) return false; const mask = this.fields[field].materials; return mask === undefined || possibleSources.some(i => removesMaterial(mask, this.boxes[i].material)); });
    } else active = crossing;
    for (let slot = 0; slot < active.length; slot++) slots[active[slot]] = slot;
    // Subcells carry only crossing signs. Copying all 261 global signs at every
    // split used most of preparation's allocation/GC budget.
    let cells: Cell[] = [{ faces, signs: [] }];
    for (let slot = 0; slot < active.length; slot++) {
      const field = active[slot];
      try { const next: Cell[] = []; for (const cell of cells) for (const part of this.split(cell, field, slot)) next.push(part); cells = next; }
      catch (error) { if (error instanceof ResidentFailure) throw new ResidentFailure(error.code, `${error.message} (tet ${tet.id}, field ${this.fields[field].id})`); throw error; }
      if (cells.length > this.maxRegionsPerTet) throw new ResidentFailure('capacity', `Tet ${tet.id} exceeds ${this.maxRegionsPerTet} arrangement cells`);
    }
    const output: OccupiedRegion[] = []; let removedVolume = 0;
    for (const cell of cells) {
      const cellSigns = cell.signs;
      let source = -1;
      for (const i of possibleSources) { let all = true; for (const field of this.boxFields[i]) if (!(this.sign(cellSigns, field) < 0)) { all = false; break; } if (all) { source = i; break; } }
      if (source < 0) continue;
      const box = this.boxes[source];
      let masked = false;
      for (const mask of localMasks) { let all = true; for (const constraint of mask.constraints) if (this.sign(cellSigns, Math.abs(constraint) - 1) !== constraint) { all = false; break; } if (all) { masked = true; break; } }
      if (masked) continue;
      if (this.uniformRegions) { const traced: RegionFace[] = []; for (const face of cell.faces) for (const part of this.tracedFace(face, crossing, tet.index)) traced.push(part); cell.faces = traced; }
      // Mean of the distinct vertices in first-occurrence order, summed as math.ts mean() sums them.
      const seen = this.nextMark(); let sx = 0, sy = 0, sz = 0, count = 0;
      for (const face of cell.faces) for (const id of face.vertices) {
        if (id >= this.seenMark.length) this.reserve(id + 1);
        if (this.seenMark[id] === seen) continue;
        this.seenMark[id] = seen; const p = this.vertices[id].position; sx += p[0]; sy += p[1]; sz += p[2]; count++;
      }
      const ox = sx / count, oy = sy / count, oz = sz / count;
      let volume = 0;
      for (const face of cell.faces) for (let i = 1; i + 1 < face.vertices.length; i++) {
        const a = this.vertices[face.vertices[0]].position, b = this.vertices[face.vertices[i]].position, c = this.vertices[face.vertices[i + 1]].position;
        const ax = a[0] - ox, ay = a[1] - oy, az = a[2] - oz, bx = b[0] - ox, by = b[1] - oy, bz = b[2] - oz, cx = c[0] - ox, cy = c[1] - oy, cz = c[2] - oz;
        volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      }
      if (volume === 0) continue; // A source sliver can collapse exactly in the f32 profile.
      if (!(volume > 0)) throw new ResidentFailure('validation', `Invalid occupied volume ${tet.id}: ${volume}`);
      let removed = false;
      if (!box.anchor) for (const field of cutsHere) if (removesMaterial(this.fields[field].materials, box.material) && this.sign(cellSigns, field) < 0) { removed = true; break; }
      if (removed) { removedVolume += volume; continue; }
      const constraints = cell.signs;
      output.push({ id: `${tet.id}:${constraints.join('.')}`, tet: tet.id, brick: tet.brick, material: box.material, source: box.id, anchor: box.anchor,
        faces: this.physicalFaces(cell.faces), sourceFaces: cell.faces, constraints, volume });
    }
    return { regions: output, removedVolume };
  }
  /** Full recompile of one brick (every tet). */
  rebuild(brick: string, revision: number, masks: readonly OwnershipMask[] = []): RegionPage {
    return this.rebuildTets(brick, null, undefined, revision, masks);
  }
  /** Tet-granular recompile: tets in `dirty` (brick-local indices) are recompiled, every other tet reuses
   * `previous`'s output. Bit-identical to a full rebuild: a clean tet sees no crossing change, its vertices hit the
   * intersection cache, and its masked cells were already dropped from `previous` when they detached. */
  rebuildTets(brick: string, dirty: ReadonlySet<number> | null, previous: RegionPage | undefined, revision: number, masks: readonly OwnershipMask[] = []): RegionPage {
    const tets = this.lattice.bricks.get(brick); if (!tets) throw new Error(`Unknown brick ${brick}`);
    const cached = dirty && previous?.tetRemoved?.length === tets.length ? this.groupByTet(previous) : undefined;
    const regions: OccupiedRegion[] = [], tetRemoved = new Float64Array(tets.length); let removedVolume = 0;
    for (const tet of tets) {
      let out: { regions: readonly OccupiedRegion[]; removedVolume: number };
      if (!cached || dirty!.has(tet.local)) out = this.tet(tet, masks);
      else out = { regions: cached.get(tet.local) ?? [], removedVolume: previous!.tetRemoved![tet.local] };
      for (const region of out.regions) regions.push(region);
      tetRemoved[tet.local] = out.removedVolume; removedVolume += out.removedVolume;
    }
    return { brick, revision, regions, removedVolume, tetRemoved };
  }
  /** A page's regions grouped by brick-local tet index (pages list regions in tet order). */
  groupByTet(page: RegionPage): Map<number, OccupiedRegion[]> {
    const groups = new Map<number, OccupiedRegion[]>();
    for (const region of page.regions) { const local = this.lattice.tetById.get(region.tet)!.local, list = groups.get(local); if (list) list.push(region); else groups.set(local, [region]); }
    return groups;
  }
  /** Assemble a compiler result with the previous page's clean tets (identity for full results). */
  assemble(page: CompiledRegionPage, previous: RegionPage | undefined): RegionPage {
    const tets = this.lattice.bricks.get(page.brick); if (!tets) throw new Error(`Unknown brick ${page.brick}`);
    if (!page.tets) { const { brick, revision, regions, removedVolume, tetRemoved } = page; return { brick, revision, regions, removedVolume, tetRemoved }; }
    if (!previous?.tetRemoved || previous.tetRemoved.length !== tets.length) throw new ResidentFailure('validation', `Partial page ${page.brick} has no previous tet outputs`);
    const fresh = this.groupByTet(page), computed = new Map(page.tets.map((local, i) => [local, page.tetRemoved![i]])), cached = this.groupByTet(previous);
    const regions: OccupiedRegion[] = [], tetRemoved = new Float64Array(tets.length); let removedVolume = 0;
    for (const tet of tets) {
      const own = computed.get(tet.local), list = own === undefined ? cached.get(tet.local) : fresh.get(tet.local), removed = own === undefined ? previous.tetRemoved[tet.local] : own;
      if (list) for (const region of list) regions.push(region);
      tetRemoved[tet.local] = removed; removedVolume += removed;
    }
    return { brick: page.brick, revision: page.revision, regions, removedVolume, tetRemoved };
  }
  preparedFields(start: number): PreparedResidentField[] {
    return this.fields.slice(start).map((field, j) => { const i = start + j, cut = this.cutFields.indexOf(i); return {
      field: { id: field.id, surface: field.surface, support: field.support, ...(field.materials !== undefined ? { materials: field.materials } : {}) }, samples: Float32Array.from(this.samples[i]), staticField: this.staticFlags[i], cut: cut < 0 ? undefined : this.cuts[cut],
    }; });
  }
  appendPreparedField(record: PreparedResidentField): void {
    const id = this.fields.length;
    this.fields.push(Object.freeze({ ...record.field, sample: () => { throw new Error('Prepared field is evaluated through original sample words'); } }));
    this.fieldVertexMark[id] = this.vertices.length; this.staticFlags[id] = record.staticField;
    this.samples.push(record.samples);
    if (record.staticField) { this.registerStatic(id); if (this.faceTraces.size) this.invalidateTraces(id); }
    if (record.cut) { this.cuts.push(record.cut); this.cutFields.push(id); this.cutFieldSet.add(id); }
  }
  compilePages(bricks: readonly string[], revision: number, masks: readonly OwnershipMask[]): CompiledResidentPages {
    return this.compileTets(bricks.map(brick => ({ brick, tets: null })), revision, masks);
  }
  /** Worker compile: only the requested tets (their regions in tet order, removed volume aligned with `tets`). */
  compileTets(requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[]): CompiledResidentPages {
    const pages: CompiledRegionPage[] = requests.map(({ brick, tets }) => {
      if (!tets) return this.rebuild(brick, revision, masks);
      const all = this.lattice.bricks.get(brick); if (!all) throw new Error(`Unknown brick ${brick}`);
      const regions: OccupiedRegion[] = [], tetRemoved = new Float64Array(tets.length); let removedVolume = 0;
      for (let i = 0; i < tets.length; i++) { const out = this.tet(all[tets[i]], masks); for (const region of out.regions) regions.push(region); tetRemoved[i] = out.removedVolume; removedVolume += out.removedVolume; }
      return { brick, revision, regions, removedVolume, tetRemoved, tets: [...tets] };
    });
    // Live recipes: every face vertex and its construction ancestors (a stamped set and a typed stack).
    const base = this.lattice.positions.length, live = this.nextMark();
    this.reserve(this.vertices.length);
    let found = 0;
    for (const page of pages) for (const region of page.regions) {
      for (const face of region.faces) for (const id of face.vertices) found = this.visitLive(id, base, live, found);
      if (region.sourceFaces) for (const face of region.sourceFaces) for (const id of face.vertices) found = this.visitLive(id, base, live, found);
    }
    const sorted = this.liveIds.subarray(0, found).sort(), vertices: ResidentRecipe[] = [];
    for (let i = 0; i < found; i++) vertices.push(this.vertices[sorted[i]]);
    return { pages, vertices };
  }
  /** Merge deterministic source identities, never worker-local vertex indices. The packet is consumed: its new
   * vertex objects are adopted in place. Imported recipes still execute on the renderer's GPU device before commit. */
  acceptCompiled(packet: CompiledResidentPages): CompiledRegionPage[] {
    const steps = this.acceptCompiledSteps(packet); for (;;) { const next = steps.next(); if (next.done) return next.value; }
  }
  * acceptCompiledSteps(packet: CompiledResidentPages): Generator<void, CompiledRegionPage[]> {
    const remap = new Map<number, number>(), changed = new Set<number>();
    const mapped = (id: number) => id < this.lattice.positions.length ? id : remap.get(id)!;
    let visited = 0;
    for (const vertex of packet.vertices) {
      const own = vertex.id; let id = this.intersections.get(vertex.key);
      if (id === undefined) {
        id = this.vertices.length; const adopted = vertex as { id: number; edge?: readonly [number, number] };
        adopted.id = id; if (vertex.edge) adopted.edge = [mapped(vertex.edge[0]), mapped(vertex.edge[1])];
        this.vertices.push(vertex); this.intersections.set(vertex.key, id);
      } else { const p = this.vertices[id].position; if (vertex.position[0] !== p[0] || vertex.position[1] !== p[1] || vertex.position[2] !== p[2]) changed.add(own); }
      remap.set(own, id); if (++visited % 256 === 0) yield;
    }
    // Regions whose construction changed (their worker words differ): decided on worker ids, before any remap.
    const recompute = new Set<OccupiedRegion>();
    if (changed.size) for (const page of packet.pages) for (const region of page.regions) if ((region.sourceFaces ?? region.faces).some(face => face.vertices.some(id => changed.has(id)))) recompute.add(region);
    // Faces are remapped in place (the packet is consumed); a face shared by several regions is remapped once, and
    // its physical variant is the same object unless a vertex collapses onto another physical id.
    const sourceDone = new Set<RegionFace>(), physicalOf = new Map<RegionFace, RegionFace>();
    const source = (face: RegionFace) => {
      if (!sourceDone.has(face)) { const v = face.vertices as number[]; for (let i = 0; i < v.length; i++) v[i] = mapped(v[i]); sourceDone.add(face); }
      return face;
    };
    const physical = (face: RegionFace) => {
      source(face); let result = physicalOf.get(face); if (result) return result;
      const v = face.vertices, ids: number[] = new Array(v.length); let same = true;
      for (let i = 0; i < v.length; i++) { ids[i] = this.physicalId(v[i]); if (ids[i] !== v[i]) same = false; }
      result = same ? face : { vertices: ids, source: face.source }; physicalOf.set(face, result); return result;
    };
    const pages: CompiledRegionPage[] = [];
    for (const page of packet.pages) {
      let regions = 0;
      for (const region of page.regions) {
        if (++regions % 64 === 0) yield;
        const mutable = region as { sourceFaces?: readonly RegionFace[]; faces: readonly RegionFace[]; volume: number };
        const sourceFaces = (mutable.sourceFaces ??= [...region.faces]) as RegionFace[];
        for (let i = 0; i < sourceFaces.length; i++) sourceFaces[i] = source(sourceFaces[i]);
        // Identical f32 words retain the already integrated worker volume and
        // physical face qualification. Only a changed canonical construction needs
        // to be integrated again; the GPU independently checks every region.
        if (!recompute.has(region)) { const faces = region.faces as RegionFace[]; for (let i = 0; i < faces.length; i++) faces[i] = physical(faces[i]); continue; }
        const faces = this.physicalFaces(sourceFaces), center = mean([...new Set(faces.flatMap(face => [...face.vertices]))].map(id => this.vertices[id].position)); let volume = 0;
        for (const face of faces) for (let i = 1; i + 1 < face.vertices.length; i++) {
          const [a, b, c] = [face.vertices[0], face.vertices[i], face.vertices[i + 1]].map(id => sub(this.vertices[id].position, center)); volume += dot(a, cross(b, c)) / 6;
        }
        if (!(volume > 0)) throw new ResidentFailure('validation', `Worker region collapsed during canonical merge: ${region.id}`);
        mutable.faces = faces; mutable.volume = volume;
      }
      pages.push(page); yield;
    }
    return pages;
  }
  /** Collect obsolete construction work, preserving every live recipe and its original operands. Sliced (yields)
   * and side-effect free: nothing changes until applyCompaction swaps the plan in, so an edit can preempt it. */
  * compactSteps(regions: readonly OccupiedRegion[]): Generator<void, CompactionPlan> {
    const n = this.vertices.length, live = new Uint8Array(n), base = this.lattice.positions.length;
    live.fill(1, 0, base);
    const pending: number[] = []; let visited = 0;
    for (const region of regions) {
      for (const face of region.faces) for (const id of face.vertices) pending.push(id);
      if (region.sourceFaces) for (const face of region.sourceFaces) for (const id of face.vertices) pending.push(id);
      while (pending.length) { const id = pending.pop()!; if (live[id]) continue; live[id] = 1; const edge = this.vertices[id].edge; if (edge) pending.push(edge[0], edge[1]); }
      if (++visited % 2048 === 0) yield;
    }
    let count = 0; for (let i = 0; i < n; i++) count += live[i];
    const oldIds = new Int32Array(count), remap = new Int32Array(n).fill(-1);
    for (let i = 0, j = 0; i < n; i++) if (live[i]) { oldIds[j] = i; remap[i] = j++; }
    yield;
    const vertices: Recipe[] = new Array(count);
    for (let j = 0; j < count; j++) {
      const v = this.vertices[oldIds[j]], edge = v.edge ? [remap[v.edge[0]], remap[v.edge[1]]] as [number, number] : undefined;
      vertices[j] = { ...v, id: j, edge, key: this.uniformRegions ? v.key : edge ? `${v.field}:${edge[0]}:${edge[1]}` : v.key };
      if (j % 4096 === 4095) yield;
    }
    const map = new Map<OccupiedRegion, OccupiedRegion>(), faces = (input: readonly RegionFace[]) => input.map(face => ({ ...face, vertices: face.vertices.map(id => remap[id]) }));
    visited = 0;
    for (const region of regions) { map.set(region, { ...region, faces: faces(region.faces), sourceFaces: region.sourceFaces ? faces(region.sourceFaces) : undefined }); if (++visited % 1024 === 0) yield; }
    // The swapped-in caches are built here too, so applyCompaction is O(1) (no long frame at idle).
    const intersections = new Map<string, number>();
    for (let j = 0; j < count; j++) { if (vertices[j].edge) intersections.set(vertices[j].key, j); if (j % 8192 === 8191) yield; }
    const physicalVertices = new Map<number, number>(), physicalOverflow = new Map<string, number>(); visited = 0;
    for (const [key, id] of this.physicalVertices) { if (remap[id] >= 0) physicalVertices.set(key, remap[id]); if (++visited % 8192 === 0) yield; }
    for (const [key, id] of this.physicalOverflow) if (remap[id] >= 0) physicalOverflow.set(key, remap[id]);
    return { regions: map, oldIds, remap, vertices, intersections, physicalVertices, physicalOverflow };
  }
  /** Synchronous swap of a compaction plan (vertex ids renumbered monotonically: every order-dependent choice,
   * such as a face cycle's start at its smallest id, is preserved). */
  applyCompaction(plan: CompactionPlan): void {
    if (this.staging) throw new ResidentFailure('stale', 'Compaction during a staged transaction');
    if (plan.remap.length !== this.vertices.length) throw new ResidentFailure('stale', 'Compaction plan is out of date');
    this.vertices = plan.vertices; this.intersections = plan.intersections;
    this.physicalVertices = plan.physicalVertices; this.physicalOverflow = plan.physicalOverflow;
    this.values.clear(); this.exactWeights.clear();
    this.physicalIds.length = 0; this.faceTraces.clear(); this.traceKeysByTet.clear(); this.edgeAlias.clear();
    // A field's vertex mark becomes the number of surviving vertices created before it.
    for (let i = 0; i < this.fieldVertexMark.length; i++) {
      const mark = this.fieldVertexMark[i]; let lo = 0, hi = plan.oldIds.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (plan.oldIds[mid] < mark) lo = mid + 1; else hi = mid; }
      this.fieldVertexMark[i] = lo;
    }
  }
  compact(regions: readonly OccupiedRegion[]): Map<OccupiedRegion, OccupiedRegion> {
    const steps = this.compactSteps(regions); let next = steps.next(); while (!next.done) next = steps.next();
    this.applyCompaction(next.value); return next.value.regions;
  }
  /** Recut accepted occupied cells in their immutable source frame. Body-only
   * fields never enter static CSG, so later rebuilds cannot move their cutters. */
  clipRegions(regions: readonly OccupiedRegion[], cut: SphereCut): { regions: OccupiedRegion[]; removed: number } {
    const steps = this.clipRegionsSteps(regions, cut); for (;;) { const next = steps.next(); if (next.done) return next.value; }
  }
  /** clipRegions(), yielding every few dozen regions (a recut of a large body runs on the main thread). */
  * clipRegionsSteps(regions: readonly OccupiedRegion[], cut: SphereCut): Generator<void, { regions: OccupiedRegion[]; removed: number }> {
    const field = this.addField(sphereField(cut.id, [...cut.center] as Vec3, cut.radius, cut.materials), true), survivors: OccupiedRegion[] = [];
    let removed = 0, visited = 0;
    for (const region of regions) {
      if (++visited % 64 === 0) yield;
      if (!removesMaterial(cut.materials, region.material)) { survivors.push(region); continue; }
      const sourceFaces = region.sourceFaces ?? region.faces, ids = [...new Set(sourceFaces.flatMap(face => [...face.vertices]))];
      if (ids.every(id => this.value(id, field) >= 0)) { survivors.push(region); continue; }
      if (ids.every(id => this.value(id, field) <= 0)) { removed += region.volume; continue; }
      const cells = this.split({ faces: [...sourceFaces], signs: [] }, field);
      for (const cell of cells) {
        const center = mean([...new Set(cell.faces.flatMap(face => [...face.vertices]))].map(id => this.vertices[id].position)); let volume = 0;
        for (const face of cell.faces) for (let i = 1; i + 1 < face.vertices.length; i++) {
          const [a, b, c] = [face.vertices[0], face.vertices[i], face.vertices[i + 1]].map(id => sub(this.vertices[id].position, center)); volume += dot(a, cross(b, c)) / 6;
        }
        if (volume === 0) continue;
        if (!(volume > 0)) throw new ResidentFailure('validation', 'Invalid recut occupied volume');
        if (cell.signs[0] < 0) removed += volume;
        else survivors.push({ ...region, id: `${region.id}/body-cut-${field}`, faces: this.physicalFaces(cell.faces), sourceFaces: cell.faces, volume, constraints: [...region.constraints, field + 1] });
      }
    }
    return { regions: survivors, removed };
  }
  /** Drop the memo caches (face traces, predicate values): pure functions of the recipes, rebuilt on demand with the
   * same results (recipes and their canonical identities stay). A worker calls this after compiling whole bricks: its
   * startup partition leaves ~10^4 traces, half its heap, that only edits nearby would ever read again, and every
   * major collection of the worker marks and moves them. */
  releaseCaches(): void {
    if (this.staging) throw new ResidentFailure('stale', 'Caches released during a staged transaction');
    this.faceTraces.clear(); this.traceKeysByTet.clear(); this.values.clear(); this.exactWeights.clear();
  }
  /** Open a staged transaction: cache insertions are logged so `rollback` can undo exactly them. */
  beginStage(): ArrangementMark {
    if (this.staging) throw new ResidentFailure('stale', 'A resident transaction is already staged');
    this.staging = true; this.traceLog = []; this.physicalLog = []; this.physicalIdLog = []; this.aliasLog = []; return this.mark();
  }
  mark(): ArrangementMark {
    return { fields: this.fields.length, cuts: this.cuts.length, vertices: this.vertices.length, traces: this.traceLog.length, physical: this.physicalLog.length, physicalIds: this.physicalIdLog.length, aliases: this.aliasLog.length };
  }
  /** Keep everything the stage created. */
  commitStage(): void { this.staging = false; this.traceLog = []; this.physicalLog = []; this.physicalIdLog = []; this.aliasLog = []; }
  /** Undo a stage (or a nested mark inside it) without rebuilding any cache: vertices created since the mark stay
   * in the array but lose their canonical keys (dead until the next compaction, never reused), so every later
   * vertex keeps the relative order it would have had without the rolled-back work. */
  rollback(mark: ArrangementMark, end = true): void {
    this.truncateFields(mark.fields, mark.cuts);
    for (let id = mark.vertices; id < this.vertices.length; id++) { const key = this.vertices[id].key; if (this.intersections.get(key) === id) this.intersections.delete(key); }
    for (const trace of this.traceLog.splice(mark.traces)) this.deleteTrace(trace);
    for (const key of this.physicalLog.splice(mark.physical)) if (typeof key === 'number') this.physicalVertices.delete(key); else this.physicalOverflow.delete(key);
    for (const id of this.physicalIdLog.splice(mark.physicalIds)) delete this.physicalIds[id];
    const aliases = this.aliasLog.splice(mark.aliases); for (let i = 0; i < aliases.length; i += 2) this.edgeAlias.get(aliases[i])?.delete(aliases[i + 1]);
    if (end) this.commitStage();
  }
  private truncateFields(count: number, cuts: number): void {
    if (count >= this.fields.length) return;
    for (let field = count; field < this.fields.length; field++) { this.values.delete(field); this.cutFieldSet.delete(field); this.edgeAlias.delete(field); }
    this.fields.length = count; this.samples.length = count; this.staticFlags.length = count; this.fieldVertexMark.length = count;
    this.cuts.length = cuts; this.cutFields.length = cuts;
    for (const list of this.brickStatic.values()) while (list.length && list[list.length - 1] >= count) list.pop();
  }
  /** Roll back only staged fields; accepted recipes/cache remain immutable and reusable (worker replicas, which
   * keep no insertion logs: every vertex created since the first removed field is invalidated). */
  rollbackFields(count: number, cuts: number): void {
    if (count >= this.fields.length) return;
    const vertices = this.fieldVertexMark[count] ?? this.vertices.length;
    this.truncateFields(count, cuts);
    for (let id = vertices; id < this.vertices.length; id++) { const key = this.vertices[id].key; if (this.intersections.get(key) === id) this.intersections.delete(key); }
    this.physicalIds.length = 0;
    for (const [key, id] of this.physicalVertices) if (id >= vertices) this.physicalVertices.delete(key);
    for (const [key, id] of this.physicalOverflow) if (id >= vertices) this.physicalOverflow.delete(key);
    this.faceTraces.clear(); this.traceKeysByTet.clear(); this.edgeAlias.clear();
  }
}
const keyScratch = new Float32Array(3), keyBits = new Uint32Array(keyScratch.buffer);
/** 53-bit hash of a position's f32 coordinate bits (-0 normalized to 0, matching join(',') identity). */
export function positionKey(p: readonly number[]): number {
  keyScratch[0] = p[0] + 0; keyScratch[1] = p[1] + 0; keyScratch[2] = p[2] + 0;
  let h1 = Math.imul(keyBits[0] ^ 0x9e3779b9, 0x85ebca6b), h2 = Math.imul(keyBits[0] ^ 0x7f4a7c15, 0xc2b2ae35);
  h1 = Math.imul(h1 ^ (h1 >>> 13) ^ keyBits[1], 0xcc9e2d51); h2 = Math.imul(h2 ^ (h2 >>> 15) ^ keyBits[1], 0x1b873593);
  h1 = Math.imul(h1 ^ (h1 >>> 16) ^ keyBits[2], 0x85ebca6b); h2 = Math.imul(h2 ^ (h2 >>> 13) ^ keyBits[2], 0xc2b2ae35);
  h1 ^= h1 >>> 16; h2 ^= h2 >>> 16;
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}
/** A sphere cutter's signed distance, with its finite support (the sphere's AABB). */
export function sphereField(id: string, center: Vec3, radius: number, materials?: number): SampleField {
  return { id, surface: { kind: 'sphere', center }, support: { min: center.map(v => v - radius) as Vec3, max: center.map(v => v + radius) as Vec3 }, ...(materials !== undefined ? { materials } : {}),
    sample: p => f(Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - radius) };
}
export { brickBox };
