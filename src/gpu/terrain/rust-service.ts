/** Browser admission boundary for the resident Rust world. Geometry, connectivity,
 * body ownership, clipping, collider descriptors and BVHs remain in WASM. */
import { ResidentArrangement, sphereField, type ArrangementMark } from './arrangement';
import { residentLattice } from './lattice';
import { encodeRustCore, RustTerrainCore } from './rust-core';
import { RustTerrainPool, type RustWorkerSurface } from './rust-core-pool';
import { cutShells, ResidentFailure, sameCutShape, validCutShells, type BodyCandidate, type ColliderDescription, type SphereCut, type TerrainPreparationProgress } from './contracts';
import type { ResidentWorldInput } from './fixtures';
import type { TerrainRenderHost } from './render-host';
import type { GpuPage, PackedResidentPageBatch } from './page-batch';
import { candidateBox, emptyMetrics, FrameMonitor, raceAbort, type AcceptedEdit, type BodyPose, type FrameWatch, type OracleReport, type PrepareOptions, type ResidentService, type StagedEdit } from './service';
import { drainTerrainWork, framePacer, WorkBudget, yieldBackground } from './work-budget';
import { ResidentQueries, type ResidentQueryBody } from '../../game/resident-queries';
import { TerrainCollision, type CollisionChunk } from '../../game/terrain-collision';
import { NativeResidentQueries, NativeTerrainCollision, releaseNativeQuery, retainNativeQuery } from '../../game/native-queries';
import { StructuralPhysics, type StagedPhysics } from '../../game/structural-physics';
import type { V3 } from '../../game/contracts';
import { add, rotate, sub } from '../../game/math';
import type { Bounds } from '../../core/types';
import { residentOracleEnabled } from './diagnostics';
import { generatorHash } from './page-cache';

export interface RustPageBackend {
  packedBatch(host: TerrainRenderHost, metrics: ReturnType<typeof emptyMetrics>): PackedResidentPageBatch;
  invalidateUpload(count: number): void; dispose(): void;
}
interface Ticket { serial: number; legacy: boolean; signal?: AbortSignal }
interface BodyRow { id: number; count: number; volume: number; center: V3 }
interface RustStage extends StagedEdit {
  ticket: Ticket; mark: ArrangementMark; release(): void; at: number; frame?: FrameWatch;
  physics: StagedPhysics; pages: Map<string, GpuPage>; changed: number[]; candidates: BodyCandidate[];
  fixed: TerrainCollision; bodiesQuery: Map<number, ResidentQueryBody>; fences: BodyPose[]; dirty?: Bounds;
  seam: AcceptedEdit['seam'];
  queryLeases: object[];
  query?: NativeResidentQueries;
}
/** Independent WASM memories: favor bounded replication on small/unknown devices. */
const workerCount = () => {
  const cpu = globalThis.navigator?.hardwareConcurrency ?? 4, memory = (globalThis.navigator as Navigator & { deviceMemory?: number } | undefined)?.deviceMemory;
  return Math.max(1, Math.min(cpu - 1, memory !== undefined && memory <= 4 || cpu <= 4 ? 1 : memory !== undefined && memory <= 8 ? 2 : 4));
};
const grow = (box: Bounds, point: readonly number[]) => { for (let a = 0; a < 3; a++) { box.min[a] = Math.min(box.min[a], point[a]); box.max[a] = Math.max(box.max[a], point[a]); } };
function rows(words: Float64Array): BodyRow[] {
  if (words[0] !== 1) throw new Error('Unsupported resident body ABI');
  return Array.from({ length: words[1] }, (_, i) => ({ id: words[4 + i * 6], count: words[5 + i * 6], volume: words[6 + i * 6], center: Array.from(words.subarray(7 + i * 6, 10 + i * 6)) as V3 }));
}
/** Copy exactly once to the immutable host snapshot; never rebuild the Rust BVH. */
function queryChunk(id: string, view: ReturnType<RustTerrainCore['queryBvh']>, core: RustTerrainCore): CollisionChunk | undefined {
  if (!view.indices.length) return undefined;
  const box = view.box.slice(), mesh = { id, positions: view.positions.slice(), indices: view.indices.slice(), materials: view.materials.slice(), normals: new Float32Array(), colors: new Float32Array() };
  const chunk = { mesh, root: { min: Array.from(box.subarray(0, 3)) as V3, max: Array.from(box.subarray(3, 6)) as V3 }, box, skip: view.skip.slice(), leaf: view.leaf.slice(), faces: view.faces.slice() };
  if (view.nativeId !== undefined) retainNativeQuery(chunk, core, view.nativeId); return chunk;
}
const drawBounds = (chunk: CollisionChunk): Bounds => ({ min: chunk.root.min.map(v => v - 1e-3) as V3, max: chunk.root.max.map(v => v + 1e-3) as V3 });

export class RustResidentTerrain implements ResidentService {
  get engine(): ResidentService['engine'] { return this.physics.native ? this.physics.nativeChassis ? this.nativeSimulation ? this.nativeBallistics ? this.nativeCombat ? this.nativeAI ? this.nativeProfiles ? this.nativeActions ? this.nativeObservations ? this.nativeJournal ? this.nativeMotion ? this.nativeBotInputs ? this.nativeShots ? this.nativeCanonical ? this.nativeQueries ? this.nativeTick ? this.nativeChassisLeg ? this.nativeSolverLeg ? this.nativeTail ? this.nativeTreads ? this.materialCraters ? 'rust-engine-v22' : 'rust-engine-v21' : 'rust-engine-v20' : 'rust-engine-v19' : 'rust-engine-v18' : 'rust-engine-v17' : 'rust-engine-v16' : 'rust-engine-v15' : 'rust-engine-v14' : 'rust-engine-v13' : 'rust-engine-v12' : 'rust-engine-v11' : 'rust-engine-v10' : 'rust-engine-v9' : 'rust-engine-v8' : 'rust-engine-v7' : 'rust-engine-v6' : 'rust-engine-v5' : 'rust-engine-v4' : 'rust-engine-v3' : this.physics.nativeDrive ? 'rust-engine-v2' : 'rust-engine-v1' : 'rust-resident-v1'; }
  physics!: StructuralPhysics;
  onProgress?: (progress: TerrainPreparationProgress) => void;
  readonly history: AcceptedEdit[] = [];
  epoch = 0; queries = new ResidentQueries(0, new TerrainCollision(), new Map());
  lastFailure: { code: string; message: string } | null = null;
  compactions = 0; lastCompactionMs = 0; autoMaintenance = false;
  readonly oracle: OracleReport = { epoch: 0, checked: 0, failures: [], pending: false, milliseconds: 0 };
  private readonly samples: ResidentArrangement;
  private readonly initial: Uint8Array; private readonly initialFields: ReturnType<ResidentArrangement['preparedFields']>;
  private prepared: ReturnType<ResidentArrangement['preparedFields']> = [];
  private readonly cache: string;
  private fields: number; private pool?: RustTerrainPool; private world!: RustTerrainCore;
  private readonly cuts = new Map<string, SphereCut>(); private readonly draws = new Map<string, GpuPage>();
  private readonly frames = new FrameMonitor(); private readonly synced = new Map<number, number[]>();
  private readonly falls = new Map<number, { at: number; distance: number; edit: AcceptedEdit }>();
  private slot = Promise.resolve(); private waiting = 0; private serial = 0; private supersede = 0;
  private staged?: RustStage; private disposed = false; private idle?: ReturnType<typeof setTimeout>; private compactedFaces = 0;
  private constructor(readonly fixture: ResidentWorldInput, readonly gpu: RustPageBackend, readonly host: TerrainRenderHost,
    private readonly module: WebAssembly.Module, private readonly workers: number, private readonly createWorker?: () => RustWorkerSurface, private readonly nativeSimulation = true, private readonly nativeBallistics = true, private readonly nativeCombat = true, private readonly nativeAI = true, private readonly nativeProfiles = true, private readonly nativeActions = true, private readonly nativeObservations = true, private readonly nativeJournal = true, private readonly nativeMotion = true, private readonly nativeBotInputs = true, private readonly nativeShots = true, private readonly nativeCanonical = true, private readonly nativeQueries = true, private readonly nativeTick = true, private readonly nativeChassisLeg = true, private readonly nativeSolverLeg = true, private readonly nativeTail = true, private readonly nativeTreads = true, private readonly materialCraters = true) {
    this.samples = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, 2048, true, true, true);
    this.initialFields = this.samples.preparedFields(0); this.prepared = [...this.initialFields]; this.fields = this.initialFields.length;
    this.initial = encodeRustCore({ lattice: this.samples.lattice, fields: this.initialFields, sources: this.samples.boxes, sourceFields: this.samples.boxFields, canonicalConstruction: true });
    this.cache = `rust-resident-v1:${generatorHash(fixture)}`;
  }
  static async create(fixture: ResidentWorldInput, gpu: RustPageBackend, physics: StructuralPhysics | undefined, host: TerrainRenderHost, module: WebAssembly.Module,
    workers = workerCount(), createWorker?: () => RustWorkerSurface, nativeDrive = true, nativeChassis = true, nativeSimulation = true, nativeBallistics = true, nativeCombat = true, nativeAI = true, nativeProfiles = true, nativeActions = true, nativeObservations = true, nativeJournal = true, nativeMotion = true, nativeBotInputs = true, nativeShots = true, nativeCanonical = true, nativeQueries = true, nativeTick = true, nativeChassisLeg = true, nativeSolverLeg = true, nativeTail = true, nativeTreads = true, materialCraters = true): Promise<RustResidentTerrain> {
    const service = new RustResidentTerrain(fixture, gpu, host, module, workers, createWorker, nativeSimulation, nativeBallistics, nativeCombat, nativeAI, nativeProfiles, nativeActions, nativeObservations, nativeJournal, nativeMotion, nativeBotInputs, nativeShots, nativeCanonical, nativeQueries, nativeTick, nativeChassisLeg, nativeSolverLeg, nativeTail, nativeTreads, materialCraters);
    service.world = await RustTerrainCore.createWorld(module, service.initial, service.fields);
    try { service.physics = physics ?? StructuralPhysics.createNative(service.world, fixture.planetCenter, { contactEvents: false, nativeDrive, nativeChassis }); return service; }
    catch (error) { service.world.dispose(); throw error; }
  }
  get busy(): boolean { return !!this.staged || this.waiting > 0; }
  /** The compiled engine, for presentation worlds in their own instances (the debris worker). */
  get engineModule(): WebAssembly.Module { return this.module; }
  /** Long-session diagnostics: linear memories and the sizes of retained host state. */
  memory() {
    return { wasmBytes: this.world.memoryBytes, workerBytes: this.pool?.memory ?? [], history: this.history.length, fields: this.samples.fields.length, cuts: this.cuts.size,
      draws: this.draws.size, chunks: this.queries.fixed.chunks.size, bodyQueries: this.queries.bodies.size, bodies: this.physics.bodies.size, synced: this.synced.size, falls: this.falls.size };
  }
  get triangles(): number { let sum = 0; for (const c of this.queries.fixed.chunks.values()) sum += c.mesh.indices.length / 3; return sum; }
  initialize(signal?: AbortSignal) { return this.run([], { all: true, legacy: true, signal }); }
  rebuild(signal?: AbortSignal) { return this.run([], { all: true, legacy: true, signal }); }
  cut(cut: SphereCut, signal?: AbortSignal) { return this.run([cut], { legacy: true, signal }); }
  cutMany(cuts: readonly SphereCut[], signal?: AbortSignal) { return this.run(cuts, { signal }); }
  private async run(cuts: readonly SphereCut[], options: PrepareOptions) { const stage = await this.prepare(cuts, options); return stage ? this.commit(stage) : null; }
  cancel(): void { this.supersede++; }
  poses(): BodyPose[] { return [...this.physics.bodies].map(([id, { body, candidate }]) => { const p = body.translation(), q = body.rotation(); return { id, candidate, position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] }; }); }
  private acquire(): Promise<() => void> { let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }), ready = this.slot.then(() => release); this.slot = this.slot.then(() => held); return ready; }
  private assert(ticket: Ticket): void {
    if (this.disposed || ticket.signal?.aborted) throw new ResidentFailure('cancelled', 'Resident edit cancelled');
    if (ticket.legacy && ticket.serial !== this.supersede) throw new ResidentFailure('stale', 'Resident edit superseded');
  }
  prepare(cuts: readonly SphereCut[], options: PrepareOptions = {}): Promise<StagedEdit | null> {
    const at = performance.now(), frame = options.all ? undefined : this.frames.start(), poses = options.poses ?? this.poses();
    const ticket = { serial: options.legacy ? ++this.supersede : ++this.serial, legacy: !!options.legacy, signal: options.signal };
    this.waiting++; return this.acquire().then(release => this.stage(cuts, options, ticket, poses, at, frame, () => { this.waiting--; release(); }));
  }
  private candidate(row: BodyRow, pose?: BodyCandidate['pose']): BodyCandidate {
    const feed = this.world.bodyColliders(row.id, true), colliders: ColliderDescription[] = [];
    for (let i = 0; i < feed.mass.length / 4; i++) {
      const d = feed.descriptors.subarray(i * 8, i * 8 + 8), m = feed.mass.subarray(i * 4, i * 4 + 4);
      colliders.push({ regionIds: [], vertices: feed.positions.slice(d[0] * 3, (d[0] + d[1]) * 3), indices: feed.indices.slice(d[2], d[2] + d[3]), volume: m[0], ...(d[6] ? { offset: Array.from(m.subarray(1)) as V3 } : {}) });
    }
    return { id: row.id, regions: [], regionCount: row.count, center: row.center, colliders, ...(pose ? { pose } : {}) };
  }
  private fieldRecords(start = 0) {
    this.prepared.push(...this.samples.preparedFields(this.prepared.length)); return this.prepared.slice(start);
  }
  private rollback(mark: ArrangementMark): void { this.samples.rollback(mark); this.prepared.length = this.samples.fields.length; }
  private async stage(requested: readonly SphereCut[], options: PrepareOptions, ticket: Ticket, poses: readonly BodyPose[], at: number, frame: FrameWatch | undefined, release: () => void): Promise<StagedEdit | null> {
    const queryLeases: object[] = [], native = !!this.physics.native;
    const collision = (revision: number, chunks: ReadonlyMap<string, CollisionChunk>) => { const c = native ? new NativeTerrainCollision(this.world, revision, chunks) : new TerrainCollision(revision, chunks); queryLeases.push(c); return c; };
    const metrics = emptyMetrics(), budget = new WorkBudget(this.epoch ? 4 : 20, () => this.assert(ticket));
    let mark: ArrangementMark | undefined, batch: PackedResidentPageBatch | undefined, submitted: Promise<Map<string, GpuPage>> | undefined, pages: Map<string, GpuPage> | undefined, physics: StagedPhysics | undefined;
    let paced = !options.all; if (paced) framePacer.acquire(); const unpace = () => { if (paced) { paced = false; framePacer.release(); } };
    const stages: Record<string, number> = {}; metrics.stageMs = stages; let clock = performance.now();
    const lap = (name: string) => { const now = performance.now(); stages[name] = now - clock; clock = now; };
    const progress = (stage: string) => { if (options.all) this.onProgress?.({ stage }); };
    this.lastFailure = null;
    try {
      this.assert(ticket); mark = this.samples.beginStage(); progress('sample');
      const accepted: SphereCut[] = [], fields: number[] = [];
      for (const cut of [...requested].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
        const old = this.cuts.get(cut.id) ?? accepted.find(c => c.id === cut.id);
        if (old) { if (sameCutShape(old, cut)) continue; throw new ResidentFailure('validation', 'Cut identity was reused for a different shape'); }
        // Material craters (v22) cut with one material cutter per shell; older engines never accept shells.
        if (cut.materials !== undefined || (cut.shells && (!this.materialCraters || !validCutShells(cut)))) throw new ResidentFailure('validation', 'Invalid material crater shells');
        const shells = cutShells(cut), repeated = shells.map(s => this.samples.cuts.some(c => sameCutShape(c, s))); if (repeated.every(Boolean) && cut.repeat !== 'impact') continue;
        accepted.push(cut); shells.forEach((s, i) => { if (!repeated[i]) fields.push(this.samples.addCut(s)); });
      }
      if (!accepted.length && !options.all) { this.rollback(mark); release(); unpace(); this.frames.finish(frame); return null; }
      const lattice = this.samples.lattice, revision = this.epoch + 1, requests = options.all ? lattice.brickOrder.map(brick => ({ brick, tets: null })) : this.samples.tetRequests(fields.flatMap(f => this.samples.dirtyTets(f)));
      metrics.dirtyTets = options.all ? lattice.tets.length : requests.reduce((n, r) => n + r.tets!.length, 0); lap('sample');
      this.world.begin(revision, this.fieldRecords(this.fields)); progress('topology');
      const masks = this.world.ownershipMasks().slice();
      if (requests.length) {
        this.pool ??= new RustTerrainPool(this.workers, this.module, this.initial, lattice, this.initialFields, this.createWorker);
        const compiler = metrics.compiler = { backend: 'rust-wasm' as const, workerMs: [] as number[], packetBytes: 0, mergeMs: 0, cacheHits: 0, workers: this.workers };
        budget.pause();
        for await (const result of this.pool.compile(requests, revision, masks, this.fieldRecords(), ticket.signal, 8, this.epoch === 0 ? this.cache : undefined)) {
          budget.reset();
          this.assert(ticket); const start = performance.now(); this.world.ingest(result.packet); compiler.mergeMs += performance.now() - start;
          compiler.workerMs.push(result.milliseconds); compiler.cacheHits += result.cacheHit ? 1 : 0; compiler.packetBytes += result.packet.words.byteLength + result.packet.values.byteLength; await budget.tick(); budget.pause();
        }
        budget.reset();
      }
      lap('topology'); metrics.topologyMs = stages.topology; progress('connectivity');
      while (!this.world.connectStep()) await budget.tick();
      this.world.detach(); await budget.tick(); lap('connectivity');
      const candidatesById = new Map<number, BodyCandidate>(), fences: BodyPose[] = [];
      const live = poses.filter(p => this.physics.bodies.get(p.id)?.candidate === p.candidate && (!options.eligible || options.eligible.includes(p.id)))
        .map(p => ({ id: p.id, root: p.id, candidate: p.candidate, position: p.position, rotation: p.rotation, original: p as BodyPose | undefined }));
      for (const cut of accepted.flatMap(cutShells)) for (const body of [...live]) {
        const q = body.rotation, parent = body.candidate, center = add(parent.center, rotate(sub(cut.center, body.position), [-q[0], -q[1], -q[2], q[3]]));
        const bounds = candidateBox(parent), distance = [0, 1, 2].reduce((s, a) => s + Math.max(bounds.min[a] - center[a], 0, center[a] - bounds.max[a]) ** 2, 0);
        if (distance > cut.radius ** 2) continue;
        const before = new Set(rows(this.world.bodyWords(true)).map(b => b.id)), field = this.samples.addField(sphereField(`body-${body.id}-${cut.id}`, center, cut.radius, cut.materials), true);
        this.world.appendBodyFields(this.fieldRecords(field)); this.world.recutBody(body.id, field);
        const after = rows(this.world.bodyWords(true)); if (after.some(b => b.id === body.id)) { await budget.tick(); continue; }
        live.splice(live.indexOf(body), 1); candidatesById.delete(body.id); if (body.original) fences.push(body.original);
        for (const row of after) if (!before.has(row.id)) {
          const pose = { position: add(body.position, rotate(sub(row.center, parent.center), q)), rotation: q, parent: body.root }, candidate = this.candidate(row, pose);
          candidatesById.set(row.id, candidate); live.push({ id: row.id, root: body.root, candidate, position: pose.position, rotation: q, original: undefined });
        }
        await budget.tick();
      }
      lap('recut'); const publication = this.world.publication().slice();
      const changed = Array.from(publication.subarray(22, 22 + publication[12])), newIds = Array.from(publication.subarray(22 + publication[12], 22 + publication[12] + publication[13])), replaced = Array.from(publication.subarray(22 + publication[12] + publication[13]));
      if (!fields.length && !replaced.length && !options.all) { this.world.abort(); this.rollback(mark); release(); unpace(); this.frames.finish(frame); return null; }
      const bodyRows = new Map(rows(this.world.bodyWords(true)).map(b => [b.id, b]));
      const candidates = newIds.map(id => candidatesById.get(id) ?? this.candidate(bodyRows.get(id)!));
      const fixedChunks = new Map(this.queries.fixed.chunks), bodyQueries = new Map(this.queries.bodies); replaced.forEach(id => bodyQueries.delete(id));
      const dirty: Bounds = { min: Array.from(publication.subarray(16, 19)) as V3, max: Array.from(publication.subarray(19, 22)) as V3 };
      for (const cut of accepted) { grow(dirty, cut.center.map(v => v - cut.radius)); grow(dirty, cut.center.map(v => v + cut.radius)); }
      progress('gpu-encode'); batch = this.gpu.packedBatch(this.host, metrics);
      batch.constructPacked({ vertexCount: publication[10], recipes: from => this.world.gpuRecipes(from), volumes: () => this.world.transactionVolumes() });
      for (const brick of changed) {
        const key = lattice.brickOrder[brick], chunk = queryChunk(key, this.world.queryBvh({ brick, preview: true }, [0, 0, 0], native), this.world);
        if (chunk) { queryLeases.push(chunk); fixedChunks.set(key, chunk); batch.pagePacked(key, this.world.gpuSurface({ brick, preview: true }), { brick: key, origin: [0, 0, 0] }, drawBounds(chunk)); }
        else fixedChunks.delete(key); await budget.tick();
      }
      for (const candidate of candidates) {
        const key = `body:${candidate.id}`, chunk = queryChunk(key, this.world.bodyQueryBvh(candidate.id, true, native), this.world);
        if (!chunk) throw new ResidentFailure('validation', 'Detached occupied body has no exterior');
        queryLeases.push(chunk);
        batch.pagePacked(key, this.world.bodySurface(candidate.id, true), { bodyId: candidate.id, origin: candidate.center }, drawBounds(chunk));
        bodyQueries.set(candidate.id, { collision: collision(revision, new Map([[key, chunk]])), pose: () => { const body = this.physics.bodies.get(candidate.id)!.body, p = body.translation(), q = body.rotation(); return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] }; } });
        await budget.tick();
      }
      submitted = batch.submit(); batch = undefined; void submitted.catch(() => {}); lap('encode');
      const fixed = collision(revision, fixedChunks), staticCandidates: BodyCandidate[] = [...fixed.chunks.values()].map(({ mesh }) => ({ id: -lattice.brickIndex.get(mesh.id)! - 1, regions: [], center: [0, 0, 0], colliders: [{ kind: 'trimesh', regionIds: [], vertices: mesh.positions, indices: mesh.indices, volume: 0 }] }));
      progress('physics'); physics = await drainTerrainWork(this.physics.stageSteps(staticCandidates, candidates, replaced), () => this.assert(ticket), budget); lap('physics');
      let query: NativeResidentQueries | undefined;
      if (native) {
        const handles = new Map([...this.physics.bodies].map(([id, entry]) => [id, entry.body.handle])); for (const [id, handle] of physics.createdBodies ?? []) handles.set(id, handle);
        query = new NativeResidentQueries(this.world, revision, fixed, bodyQueries, handles); queryLeases.push(query);
      }
      progress('gpu-validation'); pages = await raceAbort(submitted, ticket.signal); this.assert(ticket); lap('gpu');
      for (const brick of changed) { const key = lattice.brickOrder[brick]; if (fixedChunks.has(key) && !pages.has(key)) throw new ResidentFailure('validation', 'Static draw page is missing'); }
      for (const candidate of candidates) if (!pages.has(`body:${candidate.id}`)) throw new ResidentFailure('validation', 'Detached body draw page is missing');
      metrics.activePlanes = publication[9]; metrics.regions = publication[11]; metrics.dirtyBricks = changed.length; metrics.cleanBricks = lattice.brickOrder.length - changed.length;
      metrics.graphMs = stages.connectivity; metrics.colliderMs = stages.physics; metrics.longestSliceMs = budget.longest; metrics.enqueueToReadyMs = performance.now() - at;
      const ledger = { before: publication[1], anchored: publication[2], detached: publication[3], removed: publication[4], error: publication[5] };
      const seam = { edges: publication[6], unpaired: publication[7], orientationErrors: publication[8] };
      if (Number.isFinite(dirty.min[0])) for (let a = 0; a < 3; a++) { dirty.min[a] -= 1e-3; dirty.max[a] += 1e-3; }
      const stage: RustStage = { serial: ticket.serial, ticket, mark, release, at, frame, physics, pages, changed, candidates, fixed, bodiesQuery: bodyQueries, fences, seam, queryLeases, query,
        dirty: options.all || !Number.isFinite(dirty.min[0]) ? undefined : dirty, cuts: accepted, metrics, ledger, bodies: newIds, replaced, state: 'staged' };
      this.staged = stage; unpace(); progress('ready'); return stage;
    } catch (error) {
      queryLeases.forEach(releaseNativeQuery);
      physics?.cancel(); batch?.cancel(); pages?.forEach(p => p.dispose()); if (submitted && !pages) void submitted.then(p => p.forEach(page => page.dispose()), () => {});
      this.world.abort(); this.gpu.invalidateUpload(this.world.worldStats.vertices); if (mark) this.rollback(mark);
      this.pool?.dispose(); this.pool = undefined; release(); unpace(); this.frames.finish(frame);
      this.lastFailure = { code: error instanceof ResidentFailure ? error.code : 'validation', message: error instanceof Error ? error.message : String(error) }; throw error;
    }
  }
  fenceHolds(edit: StagedEdit): boolean { return (edit as RustStage).fences.every(pose => { const entry = this.physics.bodies.get(pose.id), p = entry?.body.translation(), q = entry?.body.rotation(); return entry?.candidate === pose.candidate && !!p && !!q && p.x === pose.position[0] && p.y === pose.position[1] && p.z === pose.position[2] && q.x === pose.rotation[0] && q.y === pose.rotation[1] && q.z === pose.rotation[2] && q.w === pose.rotation[3]; }); }
  commit(edit: StagedEdit): AcceptedEdit {
    const s = edit as RustStage; if (s !== this.staged || s.state !== 'staged') throw new ResidentFailure('stale', 'Resident edit is not staged');
    try { this.assert(s.ticket); if (!this.fenceHolds(s)) throw new ResidentFailure('stale', 'Moving body advanced during recut'); } catch (error) { this.abort(s); throw error; }
    const bodiesBefore = this.physics.motions(), physicsTick = this.physics.tick, keys = [...s.changed.map(i => this.samples.lattice.brickOrder[i]), ...s.replaced.map(id => `body:${id}`)];
    const retired = keys.flatMap(key => { const p = this.draws.get(key); return p ? [p] : []; }), shown = [...s.pages.values()];
    try {
      for (const candidate of s.candidates) s.pages.get(`body:${candidate.id}`)!.handle.setPose(candidate.pose?.position ?? candidate.center, candidate.pose?.rotation ?? [0, 0, 0, 1]);
      this.host.commit({ show: shown.map(p => p.handle), hide: retired.map(p => p.handle), dirty: s.dirty });
    } catch (error) { this.abort(s); throw error; }
    try { s.physics.commit(); } catch (error) { try { this.host.commit({ show: retired.map(p => p.handle), hide: shown.map(p => p.handle) }); } finally { this.abort(s); } throw error; }
    this.world.commit(); this.samples.commitStage(); this.fields = this.samples.fields.length;
    keys.forEach(key => this.draws.delete(key)); s.pages.forEach((p, key) => this.draws.set(key, p));
    for (const p of retired) for (const a of p.attachments ?? []) a.onHide(); for (const p of shown) for (const a of p.attachments ?? []) a.onShow();
    this.epoch++; this.queries = s.query ?? new ResidentQueries(this.epoch, s.fixed, s.bodiesQuery); for (const cut of s.cuts) this.cuts.set(cut.id, structuredClone(cut));
    const accepted: AcceptedEdit = { epoch: this.epoch, cut: s.cuts[0] ? structuredClone(s.cuts[0]) : undefined, ...(s.cuts.length > 1 ? { cuts: structuredClone([...s.cuts]) } : {}), ledger: s.ledger, metrics: s.metrics, bodies: [...s.bodies], seam: s.seam, bodiesBefore, physicsTick, eligible: [...s.replaced] };
    s.replaced.forEach(id => { this.synced.delete(id); this.falls.delete(id); });
    for (const candidate of s.candidates) { const p = this.physics.bodies.get(candidate.id)!.body.translation(); this.falls.set(candidate.id, { at: performance.now(), distance: Math.hypot(...sub([p.x, p.y, p.z], this.fixture.planetCenter)), edit: accepted }); }
    s.state = 'committed'; this.staged = undefined; s.metrics.enqueueToCommitMs = performance.now() - s.at; this.history.push(accepted); s.release();
    this.frames.finish(s.frame, worst => { s.metrics.worstFrameMs = worst; }); this.syncPoses();
    if (residentOracleEnabled()) this.oracle.pending = true;
    for (const p of retired) { try { p.dispose(); } catch (error) { console.error(error); } }
    if (this.autoMaintenance) { if (this.idle !== undefined) clearTimeout(this.idle); this.idle = setTimeout(() => { void this.maintenance().catch(console.error); }, 400); }
    return accepted;
  }
  abort(edit: StagedEdit): void {
    const s = edit as RustStage; if (s !== this.staged || s.state !== 'staged') return;
    s.physics.cancel(); s.queryLeases.forEach(releaseNativeQuery); s.pages.forEach(p => p.dispose()); this.world.abort(); this.gpu.invalidateUpload(this.world.worldStats.vertices); this.rollback(s.mark);
    s.state = 'aborted'; this.staged = undefined; s.release(); this.frames.finish(s.frame);
  }
  step(): void { this.physics.step(); this.syncPoses(); const last = this.history.at(-1); if (last) last.metrics.solverMs = this.physics.lastStepMs; }
  /** v19: step() plus the composed query sync and chassis after-physics in one engine call; the structural bodies'
   * poses arrive as one snapshot instead of a read per body. Returns whether the query poses changed. */
  stepSolverLeg(motion: import('../../game/native-motion').NativeMotion, dt: number): boolean | undefined {
    if (!(this.queries instanceof NativeResidentQueries)) return undefined;
    const world = this.queries.worldId, ids = [...this.physics.bodies.values()].map(({ body }) => body.handle);
    let rest: Float64Array = new Float64Array();
    this.physics.nativeStepWith(packet => {
      const w = motion.solverLeg([packet.length, ...packet, ids.length, ...ids, world, dt]);
      rest = w.subarray(1 + w[0]); return w.subarray(1, 1 + w[0]);
    });
    const n = rest[0]; this.physics.native!.acceptSnapshots(ids, rest.subarray(1, 1 + n));
    motion.publishPhysics(rest.subarray(2 + n));
    this.syncPoses(); const last = this.history.at(-1); if (last) last.metrics.solverMs = this.physics.lastStepMs;
    return !!rest[1 + n];
  }
  syncPoses(): void {
    for (const [id, { body }] of this.physics.bodies) {
      const p = body.translation(), q = body.rotation(), pose = [p.x, p.y, p.z, q.x, q.y, q.z, q.w], old = this.synced.get(id);
      if (!old || pose.some((x, i) => x !== old[i])) { this.draws.get(`body:${id}`)?.handle.setPose([p.x, p.y, p.z], [q.x, q.y, q.z, q.w]); this.synced.set(id, pose); }
      const fall = this.falls.get(id); if (fall && Math.hypot(...sub([p.x, p.y, p.z], this.fixture.planetCenter)) < fall.distance - 1e-5) { fall.edit.metrics.firstFallMs = performance.now() - fall.at; this.falls.delete(id); }
    }
  }
  async maintenance(): Promise<boolean> {
    if (this.busy || this.disposed) return false; const release = await this.acquire();
    try { if (this.disposed) return false;
      if (this.oracle.pending) {
        const at = performance.now(); let slice = at; const failures: string[] = [];
        try { while (!this.world.auditStep()) {
          if (performance.now() - slice >= 4) { await yieldBackground(); if (this.waiting || this.disposed) return false; slice = performance.now(); }
        } } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
        this.oracle.epoch = this.epoch; this.oracle.checked++; this.oracle.pending = false; this.oracle.milliseconds = performance.now() - at;
        this.oracle.failures.push(...failures.map(f => `epoch ${this.epoch}: ${f}`));
      }
      const stats = this.world.worldStats; if (stats.faces < Math.max(this.compactedFaces * 1.5, this.compactedFaces + 32768)) return false;
      const at = performance.now(); this.world.compactPages(); this.compactedFaces = this.world.worldStats.faces; this.lastCompactionMs = performance.now() - at; this.compactions++; return true;
    } finally { release(); }
  }
  verifyOracle(): string[] {
    const at = performance.now(), failures: string[] = [];
    try { this.world.audit(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    this.oracle.epoch = this.epoch; this.oracle.checked++; this.oracle.pending = false; this.oracle.milliseconds = performance.now() - at;
    this.oracle.failures.push(...failures.map(f => `epoch ${this.epoch}: ${f}`)); return failures;
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cancel(); if (this.idle !== undefined) clearTimeout(this.idle); if (this.staged) this.abort(this.staged);
    this.pool?.dispose();
    const cleanup = () => { const pages = [...this.draws.values()];
      try { this.host.commit({ show: [], hide: pages.map(p => p.handle) }); } finally { pages.forEach(p => p.dispose()); this.draws.clear(); this.physics.dispose(); this.gpu.dispose(); this.world.dispose(); }
    };
    // An in-flight prepare owns the arenas until its rollback completes.
    if (this.waiting) void this.slot.then(cleanup); else cleanup();
  }
}
