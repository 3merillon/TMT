/** Combined terrain/native-physics ABI. The live game owns resident topology and
 * interacting Rapier bodies here; compatibility replay remains explicitly selectable. */
import type { Bounds } from '../../core/types';
import type { CompiledRegionPage, OccupiedRegion, RegionFace, SourceBox } from './contracts';
import type { ResidentLattice } from './lattice';
import type { CompiledResidentPages, OwnershipMask, PreparedResidentField, ResidentRecipe, TetRequest } from './arrangement';
import { WeightMap, type PackedResidentPages } from './page-packet';

export interface RustCoreInput {
  canonicalConstruction?: boolean;
  lattice: ResidentLattice; fields: readonly PreparedResidentField[];
  sources: readonly SourceBox[]; sourceFields: readonly (readonly number[])[];
}
interface CoreExports extends WebAssembly.Exports {
  terrain_query_retain(handle: number): number; terrain_query_scene(handle: number): number;
  terrain_query_release(handle: number, id: number, scene: number): void;
  terrain_query_run(handle: number, id: number, op: number): number;
  terrain_query_world(handle: number): number; terrain_query_world_sync(handle: number, id: number): number;
  terrain_query_world_run(handle: number, id: number, op: number): number;
  engine_physics_input(handle: number, length: number): number;
  engine_physics_enable(handle: number): number; engine_physics_destroy(handle: number): void;
  engine_physics_command(handle: number, op: number, id: number): number;
  engine_match_create(handle: number): number; engine_match_destroy(handle: number, id: number): void;
  engine_rig_create(handle: number): number; engine_rig_pose(handle: number, id: number): number;
  engine_match_command(handle: number, id: number, op: number): number;
  engine_combat_create(handle: number): number; engine_combat_destroy(handle: number, id: number): void;
  engine_combat_command(handle: number, id: number, op: number): number;
  engine_ai_create(handle: number): number; engine_ai_destroy(handle: number, id: number): void;
  engine_ai_command(handle: number, id: number, op: number): number;
  engine_profile_create(handle: number): number; engine_profile_destroy(handle: number, id: number): void;
  engine_profile_command(handle: number, id: number, op: number): number;
  engine_flight_create(handle: number): number; engine_flight_destroy(handle: number, id: number): void;
  engine_flight_command(handle: number, context: number, op: number, id: number): number;
  memory: WebAssembly.Memory;
  terrain_create(): number; terrain_destroy(handle: number): void;
  terrain_input(handle: number, length: number): number;
  terrain_initialize(handle: number): number; terrain_compile(handle: number): number;
  terrain_pack(handle: number): void;
  terrain_pack_flat(handle: number): void; terrain_reset_construction(handle: number): number;
  terrain_output(handle: number): number; terrain_output_len(handle: number): number;
  terrain_error(handle: number): number; terrain_error_len(handle: number): number;
  terrain_panic(): number; terrain_panic_len(): number;
  terrain_fallbacks(handle: number): number;
  terrain_world_enable(handle: number): number; terrain_world_ingest(handle: number): number; terrain_world_connect(handle: number): number; terrain_world_connect_step(handle: number): number;
  terrain_world_begin(handle: number, revision: number): number; terrain_world_commit(handle: number): number; terrain_world_abort(handle: number): void;
  terrain_world_compact_pages(handle: number): number;
  terrain_world_detach(handle: number): number; terrain_world_recut_body(handle: number, body: number, field: number): number;
  terrain_world_body_words(handle: number, preview: number): number; terrain_world_masks(handle: number, preview: number): number;
  terrain_world_export_body(handle: number, body: number, preview: number): number;
  terrain_world_body_surface(handle: number, body: number, preview: number): number;
  terrain_world_body_query(handle: number, body: number, preview: number): number;
  terrain_world_body_volumes(handle: number, body: number, preview: number): number;
  terrain_world_transaction_volumes(handle: number): number;
  terrain_world_append_body_fields(handle: number): number; terrain_world_publication(handle: number): number; terrain_world_audit(handle: number): number; terrain_world_audit_step(handle: number): number;
  terrain_world_body_colliders(handle: number, body: number, preview: number): number;
  terrain_world_gpu_recipes(handle: number, from: number): number; terrain_world_export(handle: number): number; terrain_world_stat(handle: number, index: number): number;
  terrain_world_gpu_surface(handle: number, brick: number, component: number, anchored: number, preview: number): number;
  terrain_world_query_chunk(handle: number, brick: number, component: number, anchored: number, preview: number, x: number, y: number, z: number): number;
  terrain_world_query_bvh(handle: number, brick: number, component: number, anchored: number, preview: number, x: number, y: number, z: number): number;
  terrain_world_gpu_volumes(handle: number, preview: number, changedOnly: number): number;
  terrain_world_components(handle: number, preview: number): number;
}
export interface RustSelection { brick?: number; component?: number; anchored?: boolean; preview?: boolean }
const encoder = new TextEncoder(), decoder = new TextDecoder();
class Writer {
  private data = new Uint8Array(4096); private view = new DataView(this.data.buffer); private length = 0;
  private reserve(count: number): number {
    const at = this.length; this.length += count;
    if (this.length > this.data.length) { const next = new Uint8Array(Math.max(this.length, this.data.length * 2)); next.set(this.data); this.data = next; this.view = new DataView(next.buffer); }
    return at;
  }
  u32(v: number): void { const at = this.reserve(4); this.view.setUint32(at, v, true); }
  f64(v: number): void { const at = this.reserve(8); this.view.setFloat64(at, v, true); }
  bytes(v: Uint8Array): void { const at = this.reserve(v.byteLength); this.data.set(v, at); }
  text(v: string): void { const bytes = encoder.encode(v); this.u32(bytes.length); this.bytes(bytes); }
  bounds(v: Bounds): void { for (const n of v.min) this.f64(n); for (const n of v.max) this.f64(n); }
  ids(ids: readonly number[]): void { this.u32(ids.length); for (const id of ids) this.u32(id); }
  field(record: PreparedResidentField, positions: number): void {
    if (record.samples.length !== positions) throw new Error('Invalid WASM field sample count');
    const blocks = new Int32Array(Math.ceil(positions / 64)).fill(-1); let stored = 0;
    for (let block = 0; block < blocks.length; block++) {
      for (let i = block * 64; i < Math.min(positions, (block + 1) * 64); i++) if (record.samples[i] !== 1) { blocks[block] = stored++; break; }
    }
    const sparse = stored * 64 * 4 + blocks.byteLength + 4 < positions * 4;
    this.text(record.field.id); this.u32(Number(record.staticField) | (record.cut ? 2 : 0) | (record.field.support ? 4 : 0) | (sparse ? 8 : 0) | (record.field.surface?.kind === 'planet' ? 16 : record.field.surface?.kind === 'sphere' ? 32 : 0) | (record.field.materials !== undefined ? 64 : 0));
    if (record.field.support) this.bounds(record.field.support);
    if (record.field.surface?.kind === 'sphere') for (const v of record.field.surface.center) this.f64(v);
    if (record.field.materials !== undefined) this.u32(record.field.materials);
    if (sparse) {
      this.u32(stored); this.bytes(new Uint8Array(blocks.buffer));
      for (let i = 0; i < blocks.length; i++) if (blocks[i] !== -1) {
        const count = Math.min(64, positions - i * 64); this.bytes(new Uint8Array(record.samples.buffer, record.samples.byteOffset + i * 256, count * 4));
        for (let pad = count; pad < 64; pad++) this.u32(0x3f800000);
      }
    } else this.bytes(new Uint8Array(record.samples.buffer, record.samples.byteOffset, record.samples.byteLength));
  }
  done(): Uint8Array { return this.data.subarray(0, this.length); }
}
export function encodeRustCore(input: RustCoreInput): Uint8Array {
  const w = new Writer(), { lattice, fields, sources, sourceFields } = input;
  if (sourceFields.length !== sources.length) throw new Error('Invalid WASM source field table');
  w.u32(2); w.u32(Number(input.canonicalConstruction ?? false)); w.u32(lattice.positions.length); for (const p of lattice.positions) for (const v of p) w.f64(v);
  w.u32(lattice.brickOrder.length); lattice.brickOrder.forEach((brick, i) => { w.text(brick); w.bounds(lattice.brickBoxes[i]); });
  w.u32(lattice.tets.length); for (const t of lattice.tets) { w.text(t.id); w.u32(lattice.brickIndex.get(t.brick)!); w.u32(t.local); for (const v of t.vertices) w.u32(v); }
  w.u32(fields.length); for (const field of fields) w.field(field, lattice.positions.length);
  w.u32(sources.length); sources.forEach((source, i) => { w.text(source.id); w.u32(source.anchor === undefined ? 0 : 1); if (source.anchor !== undefined) w.text(source.anchor); w.u32(source.material); w.bounds(source.bounds); w.ids(sourceFields[i]); });
  return w.done();
}
export function encodeRustCompile(lattice: ResidentLattice, requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[] | Uint32Array, truncate: number, fields: readonly PreparedResidentField[]): Uint8Array {
  const w = new Writer(); w.u32(1); w.u32(truncate); w.u32(fields.length); for (const field of fields) w.field(field, lattice.positions.length);
  w.u32(revision); w.u32(requests.length);
  for (const request of requests) { const brick = lattice.brickIndex.get(request.brick); if (brick === undefined) throw new Error('Unknown terrain brick'); w.u32(brick); w.u32(request.tets ? 1 : 0); if (request.tets) w.ids(request.tets); }
  if (masks instanceof Uint32Array) w.bytes(new Uint8Array(masks.buffer, masks.byteOffset, masks.byteLength));
  else { w.u32(masks.length); for (const mask of masks) { const tet = lattice.tetById.get(mask.tet); if (!tet) throw new Error('Unknown ownership tet'); w.u32(tet.index); w.ids(mask.constraints); } }
  return w.done();
}
/** A WASM trap (panic = "abort") surfaces as the engine's recorded panic message and location. */
function guarded(exports: CoreExports): CoreExports {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== 'function' || name.startsWith('terrain_panic')) { result[name] = value; continue; }
    const call = value as (...args: number[]) => unknown;
    result[name] = (...args: number[]) => {
      try { return call(...args); } catch (error) {
        const length = error instanceof WebAssembly.RuntimeError ? exports.terrain_panic_len() : 0;
        if (!length) throw error;
        throw new Error(`Terrain engine panic: ${decoder.decode(new Uint8Array(exports.memory.buffer, exports.terrain_panic(), length))}`, { cause: error });
      }
    };
  }
  return result as unknown as CoreExports;
}
export class RustTerrainCore {
  private handle: number;
  private world = false; private readonly baseCount: number; private fieldCount: number; private stagedFieldCount?: number;
  constructor(private readonly exports: CoreExports, private readonly lattice: ResidentLattice | undefined, initial?: Uint8Array) {
    this.baseCount = initial ? new DataView(initial.buffer, initial.byteOffset, initial.byteLength).getUint32(8, true) : 0;
    this.fieldCount = 0;
    this.handle = exports.terrain_create();
    try { if (initial) { this.input(initial); this.check(exports.terrain_initialize(this.handle)); } } catch (error) { this.dispose(); throw error; }
  }
  static async create(module: WebAssembly.Module, lattice: ResidentLattice | undefined, initial: Uint8Array): Promise<RustTerrainCore> {
    const instance = await WebAssembly.instantiate(module, {});
    return new RustTerrainCore(guarded(instance.exports as unknown as CoreExports), lattice, initial);
  }
  /** A bare engine instance (no terrain), e.g. for a presentation physics world in a worker. */
  static async createEngine(module: WebAssembly.Module): Promise<RustTerrainCore> {
    const instance = await WebAssembly.instantiate(module, {});
    return new RustTerrainCore(guarded(instance.exports as unknown as CoreExports), undefined);
  }
  static async createWorld(module: WebAssembly.Module, initial: Uint8Array, fields: number): Promise<RustTerrainCore> {
    const core = await RustTerrainCore.create(module, undefined, initial);
    try { core.check(core.exports.terrain_world_enable(core.handle)); core.world = true; core.fieldCount = fields; return core; } catch (error) { core.dispose(); throw error; }
  }
  private input(bytes: Uint8Array): void {
    if (!this.handle) throw new Error('Terrain core is closed');
    const pointer = this.exports.terrain_input(this.handle, bytes.byteLength);
    // terrain_input may grow memory, so refresh the view after it returns.
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
  }
  private check(code: number): void {
    if (code) throw new Error(decoder.decode(new Uint8Array(this.exports.memory.buffer, this.exports.terrain_error(this.handle), this.exports.terrain_error_len(this.handle))));
  }
  compile(requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[] | Uint32Array, truncate: number, fields: readonly PreparedResidentField[] = [], lap: (stage: string) => void = () => {}, flat = false): PackedResidentPages {
    if (!this.lattice) throw new Error('Raw terrain handle requires an encoded command');
    return this.compileEncoded(encodeRustCompile(this.lattice, requests, revision, masks, truncate, fields), lap, flat);
  }
  compileEncoded(input: Uint8Array, lap: (stage: string) => void = () => {}, flat = true): PackedResidentPages {
    this.requireMode(false);
    this.input(input); lap('input'); this.check(this.exports.terrain_compile(this.handle)); lap('topology');
    if (flat) this.exports.terrain_pack_flat(this.handle); else this.exports.terrain_pack(this.handle);
    lap('pack'); const packet = this.packet(flat); lap('copyDecode'); return packet;
  }
  private requireMode(world: boolean): void { if (!this.handle) throw new Error('Terrain core is closed'); if (this.world !== world) throw new Error(world ? 'A resident world handle is required' : 'A compiler handle is required'); }
  resetConstruction(): void { this.requireMode(false); this.check(this.exports.terrain_reset_construction(this.handle)); }
  begin(revision: number, fields: readonly PreparedResidentField[] = []): void {
    this.requireMode(true); if (!Number.isInteger(revision) || revision <= 0 || revision > 0xffffffff) throw new Error('Invalid terrain revision');
    const w = new Writer(); w.u32(1); w.u32(this.fieldCount); w.u32(fields.length); for (const field of fields) w.field(field, this.baseCount);
    this.input(w.done()); this.check(this.exports.terrain_world_begin(this.handle, revision)); this.stagedFieldCount = this.fieldCount + fields.length;
  }
  commit(): void { this.requireMode(true); this.check(this.exports.terrain_world_commit(this.handle)); this.fieldCount = this.stagedFieldCount!; this.stagedFieldCount = undefined; }
  appendBodyFields(fields: readonly PreparedResidentField[]): void {
    this.requireMode(true); if (this.stagedFieldCount === undefined) throw new Error('No resident transaction');
    const w = new Writer(); w.u32(1); w.u32(this.stagedFieldCount); w.u32(fields.length); for (const field of fields) w.field(field, this.baseCount);
    this.input(w.done()); this.check(this.exports.terrain_world_append_body_fields(this.handle)); this.stagedFieldCount += fields.length;
  }
  publication(): Float64Array {
    this.requireMode(true); this.check(this.exports.terrain_world_publication(this.handle)); const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8);
  }
  audit(): void { this.requireMode(true); this.check(this.exports.terrain_world_audit(this.handle)); }
  auditStep(): boolean { this.requireMode(true); const code = this.exports.terrain_world_audit_step(this.handle); if (code !== 2) this.check(code); return code === 0; }
  abort(): void { this.requireMode(true); this.exports.terrain_world_abort(this.handle); this.stagedFieldCount = undefined; }
  compactPages(): void { this.requireMode(true); this.check(this.exports.terrain_world_compact_pages(this.handle)); }
  detach(): void { this.requireMode(true); this.check(this.exports.terrain_world_detach(this.handle)); }
  recutBody(body: number, field: number): void {
    this.requireMode(true);
    if (!Number.isInteger(body) || body <= 0 || body > 0xffffffff || !Number.isInteger(field) || field < 0 || field >= 0x7fffffff) throw new Error('Invalid body recut');
    this.check(this.exports.terrain_world_recut_body(this.handle, body, field));
  }
  /** Ephemeral body ABI v1: header [version, count, removed, reserved], then six f64s
   * per body: id, region count, occupied volume, source center xyz. */
  bodyWords(preview = false): Float64Array {
    this.requireMode(true); this.check(this.exports.terrain_world_body_words(this.handle, Number(preview)));
    const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8);
  }
  /** Copy before calling any allocating world method. Pass directly to compile(). */
  ownershipMasks(preview = false): Uint32Array {
    this.requireMode(true); this.check(this.exports.terrain_world_masks(this.handle, Number(preview)));
    const { buffer, offset, bytes } = this.outputView(); return new Uint32Array(buffer, offset, bytes / 4);
  }
  /** Qualification only; production must consume flat body feeds. */
  exportBody(body: number, preview = false): PackedResidentPages {
    this.requireMode(true); this.check(this.exports.terrain_world_export_body(this.handle, body, Number(preview))); return this.packet(true);
  }
  ingest(packet: Pick<PackedResidentPages, 'words' | 'values'>): void {
    this.requireMode(true);
    const startValues = Math.ceil((16 + packet.words.byteLength) / 8) * 8, length = startValues + packet.values.byteLength;
    const pointer = this.exports.terrain_input(this.handle, length), buffer = this.exports.memory.buffer;
    new Uint32Array(buffer, pointer, 4).set([0x32544d54, 0, packet.words.length, packet.values.length]);
    new Uint8Array(buffer, pointer + 16, packet.words.byteLength).set(new Uint8Array(packet.words.buffer, packet.words.byteOffset, packet.words.byteLength));
    new Uint8Array(buffer, pointer + startValues, packet.values.byteLength).set(new Uint8Array(packet.values.buffer, packet.values.byteOffset, packet.values.byteLength));
    this.check(this.exports.terrain_world_ingest(this.handle));
  }
  connect(): void { this.requireMode(true); this.check(this.exports.terrain_world_connect(this.handle)); }
  connectStep(): boolean { this.requireMode(true); const code = this.exports.terrain_world_connect_step(this.handle); if (code !== 2) this.check(code); return code === 0; }
  exportWorld(): PackedResidentPages { this.requireMode(true); this.check(this.exports.terrain_world_export(this.handle)); return this.packet(true); }
  /** Ephemeral WASM view: submit to queue.writeBuffer before another allocating core call. */
  gpuRecipes(from = 0): Uint32Array<ArrayBuffer> {
    this.requireMode(true); if (!Number.isInteger(from) || from < 0) throw new Error('Invalid GPU recipe cursor');
    this.check(this.exports.terrain_world_gpu_recipes(this.handle, from));
    return new Uint32Array(this.exports.memory.buffer, this.exports.terrain_output(this.handle), this.exports.terrain_output_len(this.handle) / 4);
  }
  private outputView(): { buffer: ArrayBuffer; offset: number; bytes: number } { return { buffer: this.exports.memory.buffer as ArrayBuffer, offset: this.exports.terrain_output(this.handle), bytes: this.exports.terrain_output_len(this.handle) }; }
  private selection(s: RustSelection): [number, number, number, number] {
    for (const id of [s.brick, s.component]) if (id !== undefined && (!Number.isInteger(id) || id < 0 || id >= 0xffffffff)) throw new Error('Invalid resident selection');
    return [s.brick ?? 0xffffffff, s.component ?? 0xffffffff, Number(!!s.anchored), Number(!!s.preview)];
  }
  /** All returned arrays are ephemeral views; upload/copy before another core call. */
  gpuSurface(selection: RustSelection = {}): { triangles: Uint32Array<ArrayBuffer>; references: Uint32Array<ArrayBuffer> } {
    this.requireMode(true); this.check(this.exports.terrain_world_gpu_surface(this.handle, ...this.selection(selection)));
    return this.readSurface();
  }
  bodySurface(body: number, preview = false) {
    this.requireMode(true); this.check(this.exports.terrain_world_body_surface(this.handle, body, Number(preview))); return this.readSurface();
  }
  private readSurface() {
    const { buffer, offset } = this.outputView(), header = new Uint32Array(buffer, offset, 2);
    return { triangles: new Uint32Array(buffer, offset + 8, header[0] * 8), references: new Uint32Array(buffer, offset + 8 + header[0] * 32, header[1] * 8) };
  }
  queryChunk(selection: RustSelection = {}, origin: readonly [number, number, number] = [0, 0, 0]): { positions: Float32Array; indices: Uint32Array; materials: Uint16Array } {
    this.requireMode(true); this.check(this.exports.terrain_world_query_chunk(this.handle, ...this.selection(selection), ...origin));
    const { buffer, offset } = this.outputView(), header = new Uint32Array(buffer, offset, 4), positions = new Float32Array(buffer, offset + 16, header[0] * 3), indices = new Uint32Array(buffer, offset + 16 + positions.byteLength, header[1]);
    return { positions, indices, materials: new Uint16Array(buffer, indices.byteOffset + indices.byteLength, header[2]) };
  }
  queryBvh(selection: RustSelection = {}, origin: readonly [number, number, number] = [0, 0, 0], retain = false) {
    this.requireMode(true); this.check(this.exports.terrain_world_query_bvh(this.handle, ...this.selection(selection), ...origin));
    return this.readQueryBvh(retain);
  }
  bodyQueryBvh(body: number, preview = false, retain = false) {
    this.requireMode(true); this.check(this.exports.terrain_world_body_query(this.handle, body, Number(preview))); return this.readQueryBvh(retain);
  }
  private readQueryBvh(retain = false) {
    let nativeId: number | undefined;
    if (retain) { const v = this.outputView(); if (new Uint32Array(v.buffer, v.offset, 4)[3]) nativeId = this.retainQueryOutput(); }
    const { buffer, offset } = this.outputView(), header = new Uint32Array(buffer, offset, 4), positions = new Float32Array(buffer, offset + 16, header[0] * 3), indices = new Uint32Array(buffer, positions.byteOffset + positions.byteLength, header[1]), materials = new Uint16Array(buffer, indices.byteOffset + indices.byteLength, header[2]);
    const box = new Float64Array(buffer, Math.ceil((materials.byteOffset + materials.byteLength) / 8) * 8, header[3] * 6), skip = new Int32Array(buffer, box.byteOffset + box.byteLength, header[3]), leaf = new Int32Array(buffer, skip.byteOffset + skip.byteLength, header[3] * 2), faces = new Int32Array(buffer, leaf.byteOffset + leaf.byteLength, header[2]);
    return { positions, indices, materials, box, skip, leaf, faces, nativeId };
  }
  gpuVolumes(preview = false, changedOnly = false): { descriptors: Uint32Array<ArrayBuffer>; triangles: Uint32Array<ArrayBuffer>; volumes: Float64Array<ArrayBuffer> } {
    this.requireMode(true); this.check(this.exports.terrain_world_gpu_volumes(this.handle, Number(preview), Number(changedOnly)));
    return this.readVolumes();
  }
  bodyVolumes(body: number, preview = false) {
    this.requireMode(true); this.check(this.exports.terrain_world_body_volumes(this.handle, body, Number(preview))); return this.readVolumes();
  }
  transactionVolumes() {
    this.requireMode(true); this.check(this.exports.terrain_world_transaction_volumes(this.handle)); return this.readVolumes();
  }
  private readVolumes() {
    const { buffer, offset } = this.outputView(), header = new Uint32Array(buffer, offset, 2), descriptors = new Uint32Array(buffer, offset + 8, header[0] * 4), triangles = new Uint32Array(buffer, offset + 8 + descriptors.byteLength, header[1] * 4);
    return { descriptors, triangles, volumes: new Float64Array(buffer, triangles.byteOffset + triangles.byteLength, header[0]) };
  }
  /** Ephemeral collider ABI v1. Descriptors contain vertex/index/region start+count,
   * shape kind (0 hull, 1 convex mesh), reserved; mass contains volume and offset xyz. */
  bodyColliders(body: number, preview = false) {
    this.requireMode(true); this.check(this.exports.terrain_world_body_colliders(this.handle, body, Number(preview)));
    const { buffer, offset } = this.outputView(), header = new Uint32Array(buffer, offset, 8);
    if (header[0] !== 1) throw new Error('Unsupported resident collider ABI');
    const descriptors = new Uint32Array(buffer, offset + 32, header[1] * 8), mass = new Float64Array(buffer, descriptors.byteOffset + descriptors.byteLength, header[1] * 4);
    const positions = new Float32Array(buffer, mass.byteOffset + mass.byteLength, header[2]), indices = new Uint32Array(buffer, positions.byteOffset + positions.byteLength, header[3]);
    return { descriptors, mass, positions, indices, regions: new Uint32Array(buffer, indices.byteOffset + indices.byteLength, header[4]) };
  }
  components(preview = false): Uint32Array { this.requireMode(true); this.check(this.exports.terrain_world_components(this.handle, Number(preview))); const { buffer, offset, bytes } = this.outputView(); return new Uint32Array(buffer, offset, bytes / 4); }
  get worldStats(): Record<string, number> {
    this.requireMode(true);
    return Object.fromEntries(['vertices', 'regions', 'components', 'portals', 'boundaryFaces', 'edges', 'unpaired', 'orientationErrors', 'anchoredRegions', 'detachedGroups', 'faces', 'faceVertices', 'regionLinks', 'regionSigns', 'planes'].map((name, i) => [name, this.exports.terrain_world_stat(this.handle, i)]));
  }
  private packet(flat: boolean): PackedResidentPages {
    const offset = this.exports.terrain_output(this.handle), length = this.exports.terrain_output_len(this.handle);
    const buffer = this.exports.memory.buffer, view = new DataView(buffer, offset, length); let cursor = 0;
    const read = () => { const v = view.getUint32(cursor, true); cursor += 4; return v; };
    if (read() !== (flat ? 0x32544d54 : 0x31544d54)) throw new Error('Invalid terrain packet ABI');
    const count = read(), wordCount = read(), valueCount = read(), strings: string[] = [];
    for (let i = 0; i < count; i++) { const n = read(); strings.push(decoder.decode(new Uint8Array(buffer, offset + cursor, n))); cursor += n; }
    cursor = Math.ceil(cursor / 4) * 4;
    // Detached worker transfer must own its buffers. The resident WASM arenas stay in place.
    const words = new Int32Array(buffer, offset + cursor, wordCount).slice(); cursor += wordCount * 4; cursor = Math.ceil(cursor / 8) * 8;
    const values = new Float64Array(buffer, offset + cursor, valueCount).slice(); cursor += valueCount * 8;
    if (cursor !== length) throw new Error('Invalid terrain packet length');
    return { strings, words, values };
  }
  get memoryBytes(): number { return this.exports.memory.buffer.byteLength; }
  enablePhysics(): void { this.check(this.exports.engine_physics_enable(this.handle)); }
  queryScene(ids: ArrayLike<number>): number { this.numericInput(ids); const id = this.exports.terrain_query_scene(this.handle); if (!id) this.check(1); return id; }
  retainQueryOutput(): number { this.requireMode(true); const id = this.exports.terrain_query_retain(this.handle); if (!id) this.check(1); return id; }
  releaseQuery(id: number, scene: boolean | number): void { if (this.handle) this.exports.terrain_query_release(this.handle, id, +scene); }
  queryWorld(data: ArrayLike<number>): number { this.numericInput(data); const id = this.exports.terrain_query_world(this.handle); if (!id) this.check(1); return id; }
  queryWorldSync(id: number): boolean { this.requireMode(true); const code = this.exports.terrain_query_world_sync(this.handle, id); if (code !== 2) this.check(code); return code === 2; }
  queryWorldRun(id: number, op: number, data: ArrayLike<number>): Float64Array {
    this.numericInput(data); this.check(this.exports.terrain_query_world_run(this.handle, id, op)); const v = this.outputView(); return new Float64Array(v.buffer, v.offset, v.bytes / 8);
  }
  queryRun(id: number, op: number, data: ArrayLike<number>): Float64Array {
    this.numericInput(data); this.check(this.exports.terrain_query_run(this.handle, id, op)); const v = this.outputView(); return new Float64Array(v.buffer, v.offset, v.bytes / 8);
  }
  /** Running-gear rigs (rig.rs), when this module has them: create returns 0 when the words are refused. */
  get rigs(): { create(words: readonly number[]): number; pose(rig: number, words: readonly number[], links: Float32Array, wheels: Float32Array): void } | undefined {
    const create = this.exports.engine_rig_create, pose = this.exports.engine_rig_pose;
    if (typeof create !== 'function' || typeof pose !== 'function') return undefined;
    return {
      create: words => { this.numericInput(words); return create(this.handle); },
      pose: (rig, words, links, wheels) => {
        this.numericInput(words); this.check(pose(this.handle, rig));
        const v = this.outputView(), w = new Float64Array(v.buffer, v.offset, v.bytes / 8);
        if (w.length !== links.length + wheels.length) throw new Error('Engine rig instance count mismatch');
        links.set(w.subarray(0, links.length)); wheels.set(w.subarray(links.length));
      },
    };
  }
  private numericInput(data: ArrayLike<number>): void {
    if (!this.handle) throw new Error('Engine core is closed');
    const pointer = this.exports.engine_physics_input(this.handle, data.length); new Float64Array(this.exports.memory.buffer, pointer, data.length).set(data);
  }
  /** Cosmetic physics preserves its independent clock without loading another WASM
   * instance or copying terrain arenas. Its caller owns and frees the new handle. */
  physicsPeer(): RustTerrainCore { if (!this.handle) throw new Error('Engine core is closed'); return new RustTerrainCore(this.exports, undefined); }
  disposePhysics(): void { if (this.handle) this.exports.engine_physics_destroy(this.handle); }
  createFlights(data: ArrayLike<number>): number {
    this.numericInput(data); const id = this.exports.engine_flight_create(this.handle); if (!id) this.check(1); return id;
  }
  disposeFlights(id: number): void { if (this.handle) this.exports.engine_flight_destroy(this.handle, id); }
  flightCommand(context: number, op: number, id = 0, data: ArrayLike<number> = []): Float64Array {
    this.numericInput(data); this.check(this.exports.engine_flight_command(this.handle, context, op, id));
    const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8).slice();
  }
  createMatch(data: ArrayLike<number>): number {
    this.numericInput(data); const id = this.exports.engine_match_create(this.handle); if (!id) this.check(1); return id;
  }
  createCombat(data: ArrayLike<number>): number {
    this.numericInput(data); const id = this.exports.engine_combat_create(this.handle); if (!id) this.check(1); return id;
  }
  createAI(data: ArrayLike<number>): number {
    this.numericInput(data); const id = this.exports.engine_ai_create(this.handle); if (!id) this.check(1); return id;
  }
  createProfile(data: ArrayLike<number>): number {
    this.numericInput(data); const id = this.exports.engine_profile_create(this.handle); if (!id) this.check(1); return id;
  }
  disposeProfile(id: number): void { if (this.handle) this.exports.engine_profile_destroy(this.handle, id); }
  profileCommand(id: number, op: number, data: ArrayLike<number> = []): Float64Array {
    this.numericInput(data); this.check(this.exports.engine_profile_command(this.handle, id, op));
    const bytes = this.outputView(); return new Float64Array(bytes.buffer.slice(bytes.offset, bytes.offset + bytes.bytes));
  }
  disposeAI(id: number): void { if (this.handle) this.exports.engine_ai_destroy(this.handle, id); }
  aiCommand(id: number, op: number, data: ArrayLike<number> = []): Float64Array {
    this.numericInput(data); this.check(this.exports.engine_ai_command(this.handle, id, op));
    const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8).slice();
  }
  disposeCombat(id: number): void { if (this.handle) this.exports.engine_combat_destroy(this.handle, id); }
  combatCommand(id: number, op: number, data: ArrayLike<number> = []): Float64Array {
    this.numericInput(data); this.check(this.exports.engine_combat_command(this.handle, id, op));
    const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8).slice();
  }
  disposeMatch(id: number): void { if (this.handle) this.exports.engine_match_destroy(this.handle, id); }
  matchCommand(id: number, op: number, data: ArrayLike<number> = []): Float64Array {
    this.numericInput(data); this.check(this.exports.engine_match_command(this.handle, id, op));
    const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8).slice();
  }
  /** Copied command result: callbacks may allocate in the same terrain/physics memory. */
  physicsCommand(op: number, id = 0, data: ArrayLike<number> = []): Float64Array {
    if (!this.handle) throw new Error('Engine core is closed');
    const pointer = this.exports.engine_physics_input(this.handle, data.length);
    new Float64Array(this.exports.memory.buffer, pointer, data.length).set(data);
    this.check(this.exports.engine_physics_command(this.handle, op, id));
    const { buffer, offset, bytes } = this.outputView(); return new Float64Array(buffer, offset, bytes / 8).slice();
  }
  get fallbackCount(): number { return this.exports.terrain_fallbacks(this.handle); }
  dispose(): void { if (this.handle) { this.exports.terrain_destroy(this.handle); this.handle = 0; } }
}

/** Temporary TS oracle/renderer bridge. The numeric ABI is intended to feed the resident
 * coordinator directly; this allocation-heavy conversion is measured separately. */
export function unpackRustPages(packet: Pick<PackedResidentPages, 'words' | 'values'>, lattice: ResidentLattice, sources: readonly SourceBox[], fields: readonly { id: string }[]): CompiledResidentPages {
  const { words, values } = packet; let cursor = 0, operand = 0;
  const read = () => words[cursor++], value = () => values[operand++];
  const list = () => { const n = read(); const out = Array.from(words.subarray(cursor, cursor + n)); cursor += n; return out; };
  const faces: RegionFace[] = [], vertices: ResidentRecipe[] = [], pages: CompiledRegionPage[] = [];
  for (let n = read(); n > 0; n--) {
    const kind = read(), a = read(), b = read(), c = read();
    if (kind !== 0 && kind !== 1) throw new Error('Invalid numeric face source');
    faces.push({ source: kind ? `face:${a},${b},${c}` : fields[a].id, vertices: list() });
  }
  for (let n = read(); n > 0; n--) {
    const id = read(), field = read(), edge: [number, number] = [read(), read()], count = read();
    const position: [number, number, number] = [value(), value(), value()], operands: [number, number] = [value(), value()], pairs: number[] = [], basis: number[] = [], barycentric: number[] = [];
    for (let i = 0; i < count; i++) { const base = read(), weight = value(); pairs.push(base, weight); basis.push(base); barycentric.push(Math.fround(weight)); }
    const planes = list(), key = `source:${[...basis].sort((a, b) => a - b).join(',')}/${planes.join(',')}`;
    vertices.push({ id, key, field, edge, level: 1, position, values: operands, weights: new WeightMap(pairs), basis, barycentric, planes });
  }
  for (let n = read(); n > 0; n--) {
    const brick = lattice.brickOrder[read()], revision = read(), count = read(), removedVolume = value(), tetCount = read();
    const tets = tetCount < 0 ? undefined : Array.from(words.subarray(cursor, cursor + tetCount)); if (tets) cursor += tets.length;
    const removedCount = read(), tetRemoved = values.slice(operand, operand + removedCount); operand += removedCount;
    const regions: OccupiedRegion[] = [];
    for (let i = 0; i < count; i++) {
      const tet = lattice.tets[read()].id, source = sources[read()], volume = value(), constraints = list();
      regions.push({ id: `${tet}:${constraints.join('.')}`, tet, brick, source: source.id, material: source.material, anchor: source.anchor, volume, constraints, sourceFaces: list().map(i => faces[i]), faces: list().map(i => faces[i]) });
    }
    pages.push({ brick, revision, regions, removedVolume, tetRemoved, ...(tets ? { tets } : {}) });
  }
  if (cursor !== words.length || operand !== values.length) throw new Error('Invalid numeric terrain packet length');
  return { vertices, pages };
}
