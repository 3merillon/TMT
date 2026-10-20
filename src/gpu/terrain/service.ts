import { ResidentArrangement, type ArrangementMark, type CompactionPlan, type OwnershipMask, type TetRequest } from './arrangement';
import { residentLattice } from './lattice';
import { type BodyCandidate, type OccupiedRegion, type Owner, type RegionFace, type RegionPage, type SliceMetrics, type SphereCut, type VolumeLedger, type TerrainPreparationProgress, ResidentFailure } from './contracts';
import type { ResidentWorldInput } from './fixtures';
import { auditBoundarySteps, ResidentConnectivity, terrainConnectivitySteps, type BoundaryFace, type ConnectivityDelta, type ConnectivityState, type OpenFace, type SeamAudit } from '../../game/terrain-connectivity';
import { structuralCandidate, structuralCandidateSteps } from '../../game/structural-colliders';
import type { StagedPhysics, StructuralMotion, StructuralPhysics } from '../../game/structural-physics';
import { pageBatch, type GpuPage, type ResidentPageBackend, type ResidentPageBatch } from './page-batch';
import { ResidentQueries, queryCollision, residentQueryChunk, type ResidentQueryBody } from '../../game/resident-queries';
import { add, rotate, sub } from '../../game/math';
import type { Q4, V3 } from '../../game/contracts';
import type { ResidentPageCompiler } from './page-workers';
import { drainTerrainWork, framePacer, WorkBudget, yieldBackground } from './work-budget';
import type { PageDrawHandle, TerrainRenderHost } from './render-host';
import { residentOracleEnabled } from './diagnostics';

export const emptyMetrics = (): SliceMetrics => ({ dirtyBricks: 0, cleanBricks: 0, regions: 0, activePlanes: 0, contractedNodes: 0, graphBytes: 0, graphMs: 0, topologyMs: 0, colliderMs: 0, colliderDescriptorBytes: 0, solverMs: 0, fallbackCount: 0, uploadBytes: 0, descriptorReadbackBytes: 0, submissions: 0, gpuMs: null, peakGpuBytes: 0, enqueueToCommitMs: 0, firstFallMs: null, readbacks: 0, compactions: 0 });
export interface AcceptedEdit {
  epoch: number; cut?: SphereCut; ledger: VolumeLedger; metrics: SliceMetrics; bodies: number[]; seam: SeamAudit; bodiesBefore: StructuralMotion[]; physicsTick: number;
  /** Every cut of a cutMany transaction, sorted by id (cut is the first). */
  cuts?: SphereCut[];
  /** The request-time bodies this edit recut. Replay restricts recuts to them: bodiesBefore holds commit-time poses, and
   * a body that moved into the cut between the request and the commit was not recut live, so it never is on replay. */
  eligible?: number[];
}
/** A body pose captured synchronously when the edit is requested: recuts use it, and commit refuses (stale) if
 * a recut body no longer sits exactly there (freezeBodies keeps it there deterministically). */
export interface BodyPose { readonly id: number; readonly candidate: BodyCandidate; readonly position: V3; readonly rotation: Q4 }
export interface PrepareOptions {
  signal?: AbortSignal;
  /** Recompile every tet of every brick (initialize, rebuild). */
  all?: boolean;
  /** Restrict recuts to these body ids (replay). */
  eligible?: readonly number[];
  /** Superseded by any later legacy edit (cut/initialize/rebuild), as before transactions. */
  legacy?: boolean;
  /** The recut pose snapshot, when the caller took it at request time (defaults to now). */
  poses?: readonly BodyPose[];
}
/** A fully prepared edit holding the staging slot until commit() or abort(). */
export interface StagedEdit {
  readonly serial: number; readonly cuts: readonly SphereCut[]; readonly metrics: SliceMetrics; readonly ledger: VolumeLedger;
  readonly bodies: readonly number[]; readonly replaced: readonly number[]; state: 'staged' | 'committed' | 'aborted';
}
interface Ticket { readonly serial: number; readonly legacy: boolean; readonly signal?: AbortSignal }
interface Stage extends StagedEdit {
  readonly ticket: Ticket; readonly mark: ArrangementMark; readonly delta: ConnectivityDelta; readonly next: Map<string, RegionPage>;
  readonly physicsStage: StagedPhysics; readonly gpuPages: Map<string, GpuPage>; readonly candidates: readonly BodyCandidate[];
  readonly removedRegionIds: readonly string[]; readonly fixedQueries: ResidentQueries['fixed']; readonly bodyQueries: Map<number, ResidentQueryBody>;
  readonly fences: readonly BodyPose[]; readonly pageBricks: readonly string[]; readonly seq: number; readonly at: number; readonly seam: SeamAudit;
  readonly eligible: readonly number[]; readonly verified: readonly OccupiedRegion[]; readonly release: () => void; readonly frame?: FrameWatch;
  /** World box of every static change (undefined: the shown and hidden pages bound it). */
  readonly dirty?: Box;
}
interface CompactionResult { plan: CompactionPlan; pages: Map<string, RegionPage>; connectivity: ConnectivityState }
export interface OracleReport { epoch: number; checked: number; failures: string[]; pending: boolean; milliseconds: number }
const pageVolumes = new WeakMap<RegionPage, number>();
/** Per-page cached occupied volume: the ledger sums 512 numbers, not every region. */
export function pageVolume(page: RegionPage): number {
  let volume = pageVolumes.get(page);
  if (volume === undefined) { volume = 0; for (const region of page.regions) volume += region.volume; pageVolumes.set(page, volume); }
  return volume;
}
const candidateBoxes = new WeakMap<BodyCandidate, { min: V3; max: V3 }>();
export function candidateBox(candidate: BodyCandidate): { min: V3; max: V3 } {
  let box = candidateBoxes.get(candidate);
  if (!box) {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const c of candidate.colliders) { const o = add(candidate.center, c.offset ?? [0, 0, 0]); for (let i = 0; i < c.vertices.length; i += 3) for (let a = 0; a < 3; a++) { const v = o[a] + c.vertices[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; } }
    candidateBoxes.set(candidate, box = { min, max });
  }
  return box;
}
type Box = { min: V3; max: V3 };
const DIRTY_SLACK = 1e-3;
const growBox = (box: Box, p: readonly number[]) => { for (let a = 0; a < 3; a++) { if (p[a] < box.min[a]) box.min[a] = p[a]; if (p[a] > box.max[a]) box.max[a] = p[a]; } };
/** Grow `box` by every fan triangle (what a page draws) that one of a brick's two boundaries has and the other lacks,
 * matched by vertex ids from the smallest (winding kept), region material and face source: what the pages, the
 * shadow map and the SDF read. Faces kept as objects are skipped; a re-meshed tet that reproduces a triangle adds
 * nothing, a retriangulated polygon adds all of it. */
function* changedTriangles(before: readonly BoundaryFace[], after: readonly BoundaryFace[], arrangement: ResidentArrangement, box: Box): Generator<void, void> {
  const old = new Set<RegionFace>(), fresh = new Set<RegionFace>(), sources = new Map<string, number>();
  for (const { face } of before) old.add(face); for (const { face } of after) fresh.add(face);
  const extend = (id: number) => growBox(box, arrangement.vertices[id].position);
  // A triangle is two exact keys, a·2^26+b and (c·8+material)·2^20+source, or (-1, i) when it does not fit them.
  const collect = (faces: readonly BoundaryFace[], skip: ReadonlySet<RegionFace>) => {
    const keys: number[] = [];
    for (const { region, face } of faces) {
      if (skip.has(face)) continue;
      let source = sources.get(face.source); if (source === undefined) { source = sources.size; sources.set(face.source, source); }
      const v = face.vertices;
      for (let i = 1; i + 1 < v.length; i++) {
        let a = v[0], b = v[i], c = v[i + 1];
        if (b < a && b < c) { const t = a; a = b; b = c; c = t; } else if (c < a && c < b) { const t = c; c = b; b = a; a = t; }
        if (Math.max(a, b, c) < 67108864 && region.material >= 0 && region.material < 8 && source < 1048576) keys.push(a * 67108864 + b, (c * 8 + region.material) * 1048576 + source);
        else { extend(a); extend(b); extend(c); }
      }
    }
    const order = new Int32Array(keys.length / 2); for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((x, y) => keys[x * 2] - keys[y * 2] || keys[x * 2 + 1] - keys[y * 2 + 1]);
    return { keys, order };
  };
  const removed = collect(before, fresh); yield;
  const added = collect(after, old); yield;
  // Merge the two sorted multisets: every triangle without a partner changed.
  const vertices = (keys: number[], i: number) => { const ab = keys[i * 2], c = Math.floor(keys[i * 2 + 1] / 8388608); extend(Math.floor(ab / 67108864)); extend(ab % 67108864); extend(c); };
  let i = 0, j = 0;
  while (i < removed.order.length || j < added.order.length) {
    const r = removed.order[i], s = added.order[j];
    const order = i >= removed.order.length ? 1 : j >= added.order.length ? -1 : removed.keys[r * 2] - added.keys[s * 2] || removed.keys[r * 2 + 1] - added.keys[s * 2 + 1];
    if (order === 0) { i++; j++; } else if (order < 0) { vertices(removed.keys, r); i++; } else { vertices(added.keys, s); j++; }
    if ((i + j) % 4096 === 0) yield;
  }
}
/** One edit's in-flight frame record (FrameMonitor). */
export interface FrameWatch { worst: number; last: number; tail: number; done?: (worst: number) => void }
/** Diagnostics: the worst animation frame while each edit is in flight (request to two frames after its commit).
 * Every edit has its own record, so back-to-back and queued edits are all measured. */
export class FrameMonitor {
  private readonly watches = new Set<FrameWatch>(); private running = false;
  start(): FrameWatch | undefined {
    const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number }).requestAnimationFrame;
    if (!raf) return undefined;
    const watch: FrameWatch = { worst: 0, last: 0, tail: -1 }; this.watches.add(watch);
    if (this.running) return watch; this.running = true;
    const frame = (time: number) => {
      for (const w of [...this.watches]) {
        if (w.last) w.worst = Math.max(w.worst, time - w.last); w.last = time;
        if (w.tail === 0) { this.watches.delete(w); w.done?.(w.worst); } else if (w.tail > 0) w.tail--;
      }
      if (this.watches.size) raf(frame); else this.running = false;
    };
    raf(frame); return watch;
  }
  /** Keep sampling two more frames (the commit's first rendered frames), then report the worst. */
  finish(watch: FrameWatch | undefined, done: (worst: number) => void = () => {}): void { if (!watch || !this.watches.has(watch) || watch.tail >= 0) return; watch.done = done; watch.tail = 2; }
}
const sameShape = (a: SphereCut, b: SphereCut) => a.radius === b.radius && a.center.every((x, i) => x === b.center[i]);
/** Await work that cannot itself be interrupted (a GPU readback) without letting it hold a cancelled edit. */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new ResidentFailure('cancelled', 'Resident edit cancelled'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ResidentFailure('cancelled', 'Resident edit cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Resident terrain transactions. An edit is prepared asynchronously (topology, connectivity, colliders, GPU pages,
 * queries: all staged, nothing visible) and committed synchronously in one JS block (physics + host.commit + query
 * swap, I4). One transaction holds the staging slot at a time; later requests queue behind it, and a cancelled one
 * releases it at its next checkpoint. Every per-edit pass is O(dirty); compaction runs only in maintenance(). */
export class ResidentTerrain {
  readonly engine = 'compatibility-v1' as const;
  onProgress?: (progress: TerrainPreparationProgress) => void;
  readonly arrangement: ResidentArrangement;
  /** Body owners only: every region of a static page is implicitly static. */
  readonly ownership = new Map<string, Owner>();
  readonly masks: OwnershipMask[] = [];
  readonly history: AcceptedEdit[] = [];
  pages = new Map<string, RegionPage>();
  epoch = 0;
  queries = new ResidentQueries(0, queryCollision([]), new Map());
  get triangles(): number { let sum = 0; for (const chunk of this.queries.fixed.chunks.values()) sum += chunk.mesh.indices.length / 3; return sum; }
  lastFailure: { code: string; message: string } | null = null;
  /** Idle compactions run by maintenance() (never inside an edit). */
  compactions = 0;
  lastCompactionMs = 0;
  readonly oracle: OracleReport = { epoch: 0, checked: 0, failures: [], pending: false, milliseconds: 0 };
  private supersede = 0;
  private serial = 0;
  private bodySequence = 0;
  private slot: Promise<void> = Promise.resolve();
  private waiting = 0;
  private staged?: Stage;
  private maintaining = false;
  private readonly cutHistory = new Map<string, SphereCut>();
  private readonly verified = new WeakSet<OccupiedRegion>();
  private staticDraw = new Map<string, GpuPage>();
  private dynamicDraw = new Map<number, GpuPage>();
  private fallPending = new Map<number, { at: number; distance: number; edit: AcceptedEdit }>();
  /** syncPoses: each body's last synced pose, and the pose revision at which it was asleep then (-1: awake). */
  private readonly synced = new Map<number, { pose: Float64Array; sleptAt: number }>();
  private disposed = false;
  private readonly connectivity = new ResidentConnectivity();
  private compactedSize = 0;
  private staticIds?: Map<string, number>;
  private readonly frames = new FrameMonitor();
  /** Worst frame while each of the last edits was in flight (diagnostics; empty without requestAnimationFrame). */
  readonly frameLog: number[] = [];
  private idle?: ReturnType<typeof setTimeout>;
  /** Schedule maintenance() shortly after each commit (game use; tests call maintenance() themselves). */
  autoMaintenance = false;
  /** Compaction is due when live+dead recipes exceed max(ratio × last compacted size, last compacted size + slack). */
  compactionPolicy = { ratio: 1.5, slack: 32768 };
  constructor(readonly fixture: ResidentWorldInput, readonly gpu: ResidentPageBackend, readonly physics: StructuralPhysics, readonly host: TerrainRenderHost, private readonly compiler?: ResidentPageCompiler) {
    this.arrangement = new ResidentArrangement(residentLattice(fixture.bounds), fixture.sources, fixture.staticSurface ? 2048 : 512, fixture.localConstruction, fixture.uniformRegions, !!compiler);
  }
  initialize(signal?: AbortSignal): Promise<AcceptedEdit | null> { return this.run([], { all: true, legacy: true, signal }); }
  cut(cut: SphereCut, signal?: AbortSignal): Promise<AcceptedEdit | null> { return this.run([cut], { legacy: true, signal }); }
  /** Several cuts in ONE transaction: the union dirty set, cuts applied in id order. */
  cutMany(cuts: readonly SphereCut[], signal?: AbortSignal): Promise<AcceptedEdit | null> { return this.run(cuts, { signal }); }
  rebuild(signal?: AbortSignal): Promise<AcceptedEdit | null> { return this.run([], { all: true, legacy: true, signal }); }
  /** Supersede in-flight legacy edits (cut/initialize/rebuild); transactions are cancelled through their signal. */
  cancel(): void { this.supersede++; }
  /** True while a prepared transaction holds the slot, or requests are queued behind one. */
  get busy(): boolean { return !!this.staged || this.waiting > 0; }
  get stagedEdit(): StagedEdit | undefined { return this.staged; }
  private async run(cuts: readonly SphereCut[], options: PrepareOptions): Promise<AcceptedEdit | null> {
    const staged = await this.prepare(cuts, options); return staged ? this.commit(staged) : null;
  }
  /** The recut pose snapshot, taken synchronously at request time (deterministic in sim ticks). */
  poses(): BodyPose[] {
    return [...this.physics.bodies].map(([id, { body, candidate }]) => { const p = body.translation(), q = body.rotation(); return { id, candidate, position: [p.x, p.y, p.z] as V3, rotation: [q.x, q.y, q.z, q.w] as Q4 }; });
  }
  private acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), acquired = this.slot.then(() => release);
    this.slot = this.slot.then(() => held); return acquired;
  }
  private assert(ticket: Ticket): void {
    if (this.disposed || ticket.signal?.aborted) throw new ResidentFailure('cancelled', 'Resident edit cancelled');
    if (ticket.legacy && ticket.serial !== this.supersede) throw new ResidentFailure('stale', 'Resident edit superseded');
  }
  /** Stage an edit without publishing anything. Resolves to null when it changes nothing. */
  prepare(cuts: readonly SphereCut[], options: PrepareOptions = {}): Promise<StagedEdit | null> {
    const frame = options.all ? undefined : this.frames.start();
    const at = performance.now(), poses = options.poses ?? this.poses(), ticket: Ticket = { serial: options.legacy ? ++this.supersede : ++this.serial, legacy: !!options.legacy, signal: options.signal };
    this.waiting++;
    return this.acquire().then(release => { this.waiting--; return this.stage(ticket, cuts, options, at, poses, release, frame); });
  }
  private async stage(ticket: Ticket, requested: readonly SphereCut[], options: PrepareOptions, at: number, poses: readonly BodyPose[], release: () => void, frame?: FrameWatch): Promise<StagedEdit | null> {
    const metrics = emptyMetrics(), stages: Record<string, number> = {}, arrangement = this.arrangement; metrics.stageMs = stages;
    const stageAt: Record<string, number> = {}; metrics.stageAt = stageAt;
    let clock = performance.now(); const lap = (name: string) => { const now = performance.now(); stages[name] = (stages[name] ?? 0) + now - clock; stageAt[name] ??= clock; clock = now; budget.label = `after ${name}`; };
    const budget = new WorkBudget(this.epoch === 0 ? 20 : 4, () => this.assert(ticket));
    let paced = !options.all; if (paced) framePacer.acquire(); const stalls = framePacer.stalls;
    const unpace = () => { if (paced) { paced = false; framePacer.release(); metrics.frameStalls = framePacer.stalls - stalls; } };
    let mark: ArrangementMark | undefined, physicsStage: StagedPhysics | undefined, batch: ResidentPageBatch | undefined, gpuPages: Map<string, GpuPage> | undefined, submitted: Promise<Map<string, GpuPage>> | undefined;
    this.lastFailure = null;
    const progress = (stage: string, completed?: number, total?: number) => { if (options.all) this.onProgress?.({ stage, completed, total }); };
    try {
      this.assert(ticket);
      progress('sample');
      mark = arrangement.beginStage();
      const cuts = [...requested].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), accepted: SphereCut[] = [], fields: number[] = [];
      for (const cut of cuts) {
        if (cut.shells || cut.materials !== undefined) throw new ResidentFailure('validation', 'Material crater shells require rust-engine-v22');
        const previous = this.cutHistory.get(cut.id) ?? accepted.find(c => c.id === cut.id);
        if (previous) { if (sameShape(cut, previous)) continue; throw new ResidentFailure('validation', 'Cut identity was reused for a different shape'); }
        // Authored/replayed cutters are shape-idempotent. Distinct gameplay impact
        // events may hit a body that has since moved into an existing crater.
        const repeatedStatic = arrangement.cuts.some(c => sameShape(c, cut));
        if (repeatedStatic && cut.repeat !== 'impact') continue;
        accepted.push(cut);
        if (!repeatedStatic) fields.push(arrangement.addCut(cut));
      }
      if (!accepted.length && !options.all) { arrangement.rollback(mark); release(); unpace(); this.frames.finish(frame); return null; }
      lap('sample');
      const begin = performance.now(), all = !!options.all;
      const requests: TetRequest[] = all ? arrangement.lattice.brickOrder.map(brick => ({ brick, tets: null })) : arrangement.tetRequests(fields.flatMap(field => arrangement.dirtyTets(field)));
      metrics.dirtyTets = all ? arrangement.lattice.tets.length : requests.reduce((sum, r) => sum + r.tets!.length, 0);
      lap('dirty');
      const next = new Map(this.pages), revision = this.epoch + 1, changed = new Map<string, RegionPage>();
      progress('topology', 0, requests.length);
      if (this.compiler && requests.length) {
        budget.pause(); const compiled = await this.compiler.compile(arrangement, requests, revision, this.masks, ticket.signal, p => progress(p.stage, p.completed, p.total)); this.assert(ticket); budget.reset(); metrics.compiler = this.compiler.metrics;
        if ((this.compiler.metrics?.longestSliceMs ?? 0) > budget.longest) { budget.longest = this.compiler.metrics!.longestSliceMs!; budget.longestLabel = 'worker merge'; }
        for (const page of compiled) { const assembled = arrangement.assemble(page, this.pages.get(page.brick)); next.set(page.brick, assembled); changed.set(page.brick, assembled); await budget.tick(); }
      } else for (const { brick, tets } of requests) {
        const page = arrangement.rebuildTets(brick, tets ? new Set(tets) : null, this.pages.get(brick), revision, this.masks);
        next.set(brick, page); changed.set(brick, page); progress('topology', changed.size, requests.length); await budget.tick();
      }
      if (!this.compactedSize) this.compactedSize = arrangement.vertices.length;
      metrics.dirtyBricks = changed.size; metrics.cleanBricks = next.size - changed.size; metrics.topologyMs = performance.now() - begin;
      lap('topology');
      // O(dirty) connectivity: local topology of the changed bricks, persistent portal map, contracted components.
      progress('connectivity');
      const delta = this.connectivity.begin(arrangement);
      for (const page of changed.values()) for (const _ of delta.prepareSteps(page)) await budget.tick();
      await budget.tick(); for (const _ of delta.updateSteps(changed)) await budget.tick();
      const { groups, nodes } = delta.components();
      lap('connectivity');
      let seq = this.bodySequence;
      const candidateStart = performance.now(), candidates: BodyCandidate[] = [], boundaries = new Map<number, readonly BoundaryFace[]>();
      const check = () => this.assert(ticket);
      for (const group of groups) {
        const candidate = await drainTerrainWork(structuralCandidateSteps(++seq, group.flatMap(node => node.regions), arrangement), check, budget);
        candidates.push(candidate); boundaries.set(candidate.id, delta.groupBoundary(group)); await budget.tick();
      }
      metrics.colliderMs = performance.now() - candidateStart;
      lap('candidates'); await budget.tick();
      // Recut bodies against the request-time poses; intermediate children of a cutMany never install.
      const replaced: number[] = [], removedRegionIds: string[] = [], fences: BodyPose[] = []; let bodyRemoved = 0, bodyBefore = 0;
      const eligibleSet = options.eligible ? new Set(options.eligible) : undefined;
      const eligible = poses.filter(p => this.physics.bodies.get(p.id)?.candidate === p.candidate && (!eligibleSet || eligibleSet.has(p.id)));
      interface Live { id: number; root: number; candidate: BodyCandidate; position: V3; rotation: Q4; pose?: BodyPose }
      const live: Live[] = eligible.map(p => ({ id: p.id, root: p.id, candidate: p.candidate, position: p.position, rotation: p.rotation, pose: p }));
      for (const cut of accepted) for (const body of [...live]) {
        const parent = body.candidate, q = body.rotation, position = body.position;
        const center = add(parent.center, rotate(sub(cut.center, position), [-q[0], -q[1], -q[2], q[3]]));
        const box = candidateBox(parent), distance2 = [0, 1, 2].reduce((sum, a) => sum + Math.max(box.min[a] - center[a], 0, center[a] - box.max[a]) ** 2, 0);
        if (distance2 > cut.radius ** 2) continue;
        const clipping = performance.now(), inner = arrangement.mark(), clipped = await drainTerrainWork(arrangement.clipRegionsSteps(parent.regions, { id: `body-${body.id}-${cut.id}`, center, radius: cut.radius }), check, budget);
        metrics.topologyMs += performance.now() - clipping;
        if (!clipped.removed) { arrangement.rollback(inner, false); await budget.tick(); continue; }
        const bodyGraph = await drainTerrainWork(terrainConnectivitySteps(clipped.regions, arrangement), check, budget), bodySeam = await drainTerrainWork(auditBoundarySteps(bodyGraph.boundary), check, budget);
        metrics.graphMs += bodyGraph.milliseconds;
        if (bodySeam.unpaired || bodySeam.orientationErrors) throw new ResidentFailure('validation', 'Recut body boundary did not close');
        live.splice(live.indexOf(body), 1);
        if (body.pose) { replaced.push(body.id); fences.push(body.pose); removedRegionIds.push(...parent.regions.map(r => r.id)); bodyBefore += parent.regions.reduce((v, r) => v + r.volume, 0); }
        else { candidates.splice(candidates.indexOf(parent), 1); boundaries.delete(parent.id); }
        bodyRemoved += clipped.removed;
        for (const group of bodyGraph.detached) {
          const cooking = performance.now(), child = await drainTerrainWork(structuralCandidateSteps(++seq, group, arrangement), check, budget), ids = new Set(group.map(r => r.id));
          metrics.colliderMs += performance.now() - cooking;
          const placed: BodyCandidate = { ...child, pose: { position: add(position, rotate(sub(child.center, parent.center), q)), rotation: q, parent: body.root } };
          candidates.push(placed); boundaries.set(placed.id, bodyGraph.boundary.filter(face => ids.has(face.region.id)));
          live.push({ id: placed.id, root: body.root, candidate: placed, position: placed.pose!.position, rotation: q });
        }
        await budget.tick();
      }
      if (!fields.length && !replaced.length && !all) { arrangement.rollback(mark); release(); unpace(); this.frames.finish(frame); return null; }
      metrics.activePlanes = arrangement.fields.length; metrics.fallbackCount = arrangement.fallbackCount;
      lap('recut'); await budget.tick();
      // Static regions of a detached group leave their pages (they become bodies in this commit).
      const pageBricks = new Set(changed.keys());
      const detachedIds = new Set<string>(), detachedBricks = new Set<string>();
      for (const group of groups) for (const node of group) { detachedBricks.add(node.brick); for (const region of node.regions) detachedIds.add(region.id); }
      if (detachedIds.size) {
        const filtered = new Map<string, RegionPage>();
        for (const brick of detachedBricks) { const page = next.get(brick)!, left = { ...page, revision, regions: page.regions.filter(r => !detachedIds.has(r.id)) }; next.set(brick, left); filtered.set(brick, left); pageBricks.add(brick); }
        for (const _ of delta.updateSteps(filtered)) await budget.tick();
      }
      for (const brick of delta.reboundaried) pageBricks.add(brick);
      const seam = delta.finish();
      if (seam.unpaired || seam.orientationErrors) throw new ResidentFailure('validation', `Shared boundary audit failed: ${JSON.stringify(seam)}`);
      let regionCount = 0; for (const page of next.values()) regionCount += page.regions.length;
      metrics.graphMs += delta.milliseconds; metrics.contractedNodes = nodes; metrics.regions = regionCount; metrics.graphBytes = seam.edges * 16 + nodes * 8;
      lap('audit'); await budget.tick();
      // ONE encoder, ONE submit, ONE readback: new recipes, volume acceptance of unverified regions, every page.
      progress('gpu-encode');
      const verify: OccupiedRegion[] = [];
      for (const page of changed.values()) for (const region of page.regions) if (!this.verified.has(region)) verify.push(region);
      for (const candidate of candidates) if (candidate.pose) for (const region of candidate.regions) if (!this.verified.has(region)) verify.push(region);
      batch = pageBatch(this.gpu, this.host, metrics);
      batch.construct(arrangement, verify); await budget.tick();
      const bricks = [...pageBricks].sort((a, b) => arrangement.lattice.brickIndex.get(a)! - arrangement.lattice.brickIndex.get(b)!);
      const brickBoundaries = new Map<string, OpenFace[]>();
      for (const brick of bricks) { const boundary = delta.boundary(brick); brickBoundaries.set(brick, boundary); batch.page(brick, boundary, { brick, origin: [0, 0, 0] }, arrangement); await budget.tick(); }
      for (const candidate of candidates) { batch.page(`body:${candidate.id}`, boundaries.get(candidate.id)!, { bodyId: candidate.id, origin: candidate.center }, arrangement); await budget.tick(); }
      lap('encode');
      // The GPU round trip overlaps the query, collider and ledger work below; nothing is published before both finish.
      submitted = batch.submit(); batch = undefined; submitted.catch(() => {});
      progress('collision');
      // The commit's dirty box: every static triangle the edit adds or removes, the cuts (body recuts change only
      // inside them) and the newly detached groups. A full build keeps the pages' bounds.
      let dirty: Box | undefined;
      if (!all) {
        dirty = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        for (const cut of accepted) { growBox(dirty, cut.center.map(v => v - cut.radius)); growBox(dirty, cut.center.map(v => v + cut.radius)); }
        for (const candidate of candidates) if (!candidate.pose) { const box = candidateBox(candidate); growBox(dirty, box.min); growBox(dirty, box.max); }
        for (const brick of bricks) for (const _ of changedTriangles(delta.previousBoundary(brick), brickBoundaries.get(brick)!, arrangement, dirty)) await budget.tick();
        for (let a = 0; a < 3; a++) { dirty.min[a] -= DIRTY_SLACK; dirty.max[a] += DIRTY_SLACK; }
      }
      const chunks: ReturnType<typeof residentQueryChunk>[] = [];
      for (const brick of bricks) { chunks.push(residentQueryChunk(brick, brickBoundaries.get(brick)!, arrangement)); await budget.tick(); }
      const fixedQueries = await drainTerrainWork(this.queries.fixed.applySteps({ version: revision, chunks, removed: [], milliseconds: 0, triangles: 0, rebuilt: chunks.length }), check, budget);
      const bodyQueries = new Map(this.queries.bodies);
      replaced.forEach(id => bodyQueries.delete(id));
      for (const candidate of candidates) {
        bodyQueries.set(candidate.id, { collision: queryCollision([residentQueryChunk(`body-${candidate.id}`, boundaries.get(candidate.id)!, arrangement, candidate.center)]), pose: () => {
          const body = this.physics.bodies.get(candidate.id)!.body, p = body.translation(), q = body.rotation(); return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
        } });
        await budget.tick();
      }
      lap('queries'); await budget.tick();
      const cook = performance.now();
      // Unchanged query pages keep their typed arrays, so the solver reuses their static bodies (no recooking).
      const staticIds = this.staticIds ??= new Map(arrangement.lattice.brickOrder.map((brick, i) => [brick, -i - 1]));
      let staticCandidates: BodyCandidate[];
      if (this.fixture.staticSurface) staticCandidates = [...fixedQueries.chunks.values()].map(({ mesh }) => ({ id: staticIds.get(mesh.id)!, regions: [], center: [0, 0, 0], colliders: [{ kind: 'trimesh', regionIds: [], vertices: mesh.positions, indices: mesh.indices, volume: 0 }] }));
      else { const anchored = [...next.values()].flatMap(page => [...page.regions]); staticCandidates = anchored.length ? [structuralCandidate(0, anchored, arrangement)] : []; }
      metrics.colliderDescriptorBytes = candidates.flatMap(c => [...c.colliders]).reduce((s, c) => s + c.vertices.byteLength + c.indices.byteLength, 0)
        + chunks.reduce((s, c) => s + c.positions.byteLength + c.indices.byteLength, 0);
      // Shapes cook in slices; the bodies are created in one block at the end (stageSteps), as stage() did.
      physicsStage = await drainTerrainWork(this.physics.stageSteps(staticCandidates, candidates, replaced), check, budget); metrics.colliderMs += performance.now() - cook;
      lap('physics'); await budget.tick();
      progress('gpu-validation');
      budget.pause(); gpuPages = await raceAbort(submitted, ticket.signal); this.assert(ticket); budget.reset();
      for (const candidate of candidates) if (!gpuPages.has(`body:${candidate.id}`)) throw new ResidentFailure('validation', 'Detached occupied body has no exterior');
      lap('gpu');
      // Ledger from cached page volumes: independently integrated removed cells, never a residual.
      let anchored = 0, afterRemoved = 0, beforeVolume = bodyBefore, beforeRemoved = 0;
      for (const page of next.values()) { anchored += pageVolume(page); afterRemoved += page.removedVolume; }
      for (const page of this.pages.values()) { beforeVolume += pageVolume(page); beforeRemoved += page.removedVolume; }
      const volume = candidates.reduce((s, c) => s + c.regions.reduce((v, r) => v + r.volume, 0), 0);
      const before = this.pages.size ? beforeVolume : anchored + volume, removed = bodyRemoved + afterRemoved - beforeRemoved;
      if (removed < -Math.max(1e-5, before * 1e-4)) throw new ResidentFailure('validation', 'Rebuild created new occupied volume');
      const ledger = { before, anchored, detached: volume, removed, error: before - anchored - volume - removed };
      if (Math.abs(ledger.error) > Math.max(1e-5, before * 1e-4)) throw new ResidentFailure('validation', `Occupied volume ledger mismatch: ${ledger.error}`);
      lap('ledger');
      this.assert(ticket); budget.pause(); metrics.longestSliceMs = budget.longest; metrics.longestSliceAt = budget.longestLabel; unpace();
      metrics.enqueueToReadyMs = performance.now() - at;
      const stage: Stage = { serial: ticket.serial, cuts: accepted, metrics, ledger, bodies: candidates.map(c => c.id), replaced, state: 'staged',
        ticket, mark, delta, next, physicsStage, gpuPages, candidates, removedRegionIds, fixedQueries, bodyQueries, fences, pageBricks: bricks, seq, at, seam,
        eligible: [...replaced], verified: verify, release, frame, dirty };
      this.staged = stage;
      progress('ready');
      return stage;
    } catch (error) {
      unpace();
      physicsStage?.cancel(); batch?.cancel(); gpuPages?.forEach(p => p.dispose());
      if (submitted && !gpuPages) void submitted.then(pages => pages.forEach(p => p.dispose()), () => {});
      if (mark) arrangement.rollback(mark);
      release(); this.frames.finish(frame);
      this.lastFailure = { code: error instanceof ResidentFailure ? error.code : 'validation', message: error instanceof Error ? error.message : String(error) }; throw error;
    }
  }
  /** Publish a staged edit: one synchronous block (host.commit + physics commit + ownership/query swap). */
  commit(edit: StagedEdit): AcceptedEdit {
    const staged = edit as Stage;
    if (staged !== this.staged || staged.state !== 'staged') throw new ResidentFailure('stale', 'Resident edit is not the staged transaction');
    try {
      this.assert(staged.ticket);
      if (!this.fenceHolds(staged)) throw new ResidentFailure('stale', 'Moving body advanced during recut');
    } catch (error) { this.abortStage(staged, error); throw error; }
    const clock = performance.now(), bodiesBefore = this.physics.motions(), physicsTick = this.physics.tick;
    // Build the draw change first; maps change only after host.commit succeeds.
    const show: PageDrawHandle[] = [], hide: PageDrawHandle[] = [], retired: GpuPage[] = [], shown: GpuPage[] = [];
    for (const brick of staged.pageBricks) {
      const old = this.staticDraw.get(brick); if (old) { hide.push(old.handle); retired.push(old); }
      const page = staged.gpuPages.get(brick); if (page) { show.push(page.handle); shown.push(page); }
    }
    for (const id of staged.replaced) { const old = this.dynamicDraw.get(id); if (old) { hide.push(old.handle); retired.push(old); } }
    for (const candidate of staged.candidates) {
      const page = staged.gpuPages.get(`body:${candidate.id}`)!, p = candidate.pose?.position ?? candidate.center, q = candidate.pose?.rotation ?? [0, 0, 0, 1];
      page.handle.setPose(p.map(Math.fround) as V3, q.map(Math.fround) as Q4); show.push(page.handle); shown.push(page);
    }
    // No await from here through publication: solver, ownership/query snapshot,
    // and renderer draw membership change at this single JS/physics boundary.
    try { this.host.commit({ show, hide, dirty: staged.dirty }); } catch (error) { this.abortStage(staged, error); throw error; }
    try { staged.physicsStage.commit(); } catch (error) { try { this.host.commit({ show: hide, hide: show }); } finally { this.abortStage(staged, error); } throw error; }
    for (const page of retired) for (const a of page.attachments ?? []) a.onHide();
    for (const page of shown) for (const a of page.attachments ?? []) a.onShow();
    for (const brick of staged.pageBricks) { const page = staged.gpuPages.get(brick); if (page) this.staticDraw.set(brick, page); else this.staticDraw.delete(brick); }
    for (const id of staged.replaced) { this.dynamicDraw.delete(id); this.fallPending.delete(id); this.synced.delete(id); }
    staged.removedRegionIds.forEach(id => this.ownership.delete(id));
    const accepted: AcceptedEdit = { epoch: this.epoch + 1, cut: staged.cuts[0] ? structuredClone(staged.cuts[0]) : undefined, ledger: staged.ledger, metrics: staged.metrics,
      bodies: [...staged.bodies], seam: staged.seam, bodiesBefore, physicsTick, ...(staged.cuts.length > 1 ? { cuts: structuredClone([...staged.cuts]) } : {}), eligible: [...staged.eligible] };
    for (const candidate of staged.candidates) {
      const page = staged.gpuPages.get(`body:${candidate.id}`)!, body = this.physics.bodies.get(candidate.id)!.body, p = body.translation(), q = body.rotation();
      page.handle.setPose([p.x, p.y, p.z], [q.x, q.y, q.z, q.w]); this.dynamicDraw.set(candidate.id, page);
      for (const region of candidate.regions) { if (!candidate.pose) this.masks.push({ tet: region.tet, constraints: region.constraints, body: candidate.id }); this.ownership.set(region.id, { kind: 'body', id: candidate.id }); }
      this.fallPending.set(candidate.id, { at: performance.now(), distance: Math.hypot(...sub([p.x, p.y, p.z], this.fixture.planetCenter)), edit: accepted });
    }
    this.queries = new ResidentQueries(this.epoch + 1, staged.fixedQueries, staged.bodyQueries);
    this.connectivity.apply(staged.delta); this.arrangement.commitStage();
    this.pages = staged.next; this.bodySequence = staged.seq; this.epoch++;
    for (const region of staged.verified) this.verified.add(region);
    for (const cut of staged.cuts) this.cutHistory.set(cut.id, cut);
    staged.state = 'committed'; this.staged = undefined;
    // One atomic draw-membership change (I4); replaced pages are disposed only after it.
    for (const page of retired) { try { page.dispose(); } catch (error) { console.error(error); } }
    staged.metrics.stageMs!.commit = performance.now() - clock; staged.metrics.longestSliceMs = Math.max(staged.metrics.longestSliceMs ?? 0, staged.metrics.stageMs!.commit);
    staged.metrics.enqueueToCommitMs = performance.now() - staged.at; this.history.push(accepted);
    staged.release();
    this.frames.finish(staged.frame, worst => { accepted.metrics.worstFrameMs = worst; this.frameLog.push(worst); if (this.frameLog.length > 64) this.frameLog.shift(); });
    if (residentOracleEnabled()) this.oracle.pending = true;
    if (this.autoMaintenance) this.scheduleMaintenance();
    return accepted;
  }
  /** True while every body the staged edit recuts still sits exactly at its request-time pose. */
  fenceHolds(edit: StagedEdit): boolean {
    const staged = edit as Stage;
    return staged.fences.every(fence => { const entry = this.physics.bodies.get(fence.id), p = entry?.body.translation(), q = entry?.body.rotation();
      return !!entry && entry.candidate === fence.candidate && !!p && !!q && p.x === fence.position[0] && p.y === fence.position[1] && p.z === fence.position[2] && q.x === fence.rotation[0] && q.y === fence.rotation[1] && q.z === fence.rotation[2] && q.w === fence.rotation[3]; });
  }
  /** Drop a staged edit: the world is exactly as before it was prepared. */
  abort(edit: StagedEdit): void { const staged = edit as Stage; if (staged === this.staged && staged.state === 'staged') this.abortStage(staged); }
  private abortStage(staged: Stage, error?: unknown): void {
    if (staged.state !== 'staged') return;
    staged.state = 'aborted'; if (this.staged === staged) this.staged = undefined;
    this.frames.finish(staged.frame);
    try { staged.physicsStage.cancel(); staged.gpuPages.forEach(page => page.dispose()); this.arrangement.rollback(staged.mark); }
    finally {
      if (error !== undefined) this.lastFailure = { code: error instanceof ResidentFailure ? error.code : 'validation', message: error instanceof Error ? error.message : String(error) };
      staged.release();
    }
  }
  /** Idle trigger: maintenance() once nothing has been requested for a moment (preempted by any new request). */
  scheduleMaintenance(delayMs = 400): void {
    if (this.idle !== undefined || this.disposed || (!this.compactionDue && !this.oracle.pending)) return;
    this.idle = setTimeout(() => { this.idle = undefined; if (this.busy) { this.scheduleMaintenance(delayMs); return; }
      void this.maintenance().then(() => { if (this.compactionDue || this.oracle.pending) this.scheduleMaintenance(delayMs); }).catch(error => console.error(error)); }, delayMs);
  }
  /** Compaction is due: dead construction work outweighs the last compacted size. */
  get compactionDue(): boolean { const { ratio, slack } = this.compactionPolicy; return this.epoch > 0 && this.arrangement.vertices.length > Math.max(this.compactedSize * ratio, this.compactedSize + slack); }
  private * compactionSteps(): Generator<void, CompactionResult> {
    const regions: OccupiedRegion[] = [];
    for (const page of this.pages.values()) for (const region of page.regions) regions.push(region);
    for (const { candidate } of this.physics.bodies.values()) for (const region of candidate.regions) regions.push(region);
    yield;
    const plan = yield* this.arrangement.compactSteps(regions);
    const pages = new Map<string, RegionPage>(); let visited = 0;
    for (const [brick, page] of this.pages) { pages.set(brick, { ...page, regions: page.regions.map(region => plan.regions.get(region)!) }); if (++visited % 32 === 0) yield; }
    const connectivity = yield* this.connectivity.remapSteps(pages, plan.regions, plan.remap);
    return { plan, pages, connectivity };
  }
  private applyCompaction({ plan, pages, connectivity }: CompactionResult): void {
    this.arrangement.applyCompaction(plan); this.pages = pages; this.connectivity.adopt(connectivity);
    for (const [id, entry] of this.physics.bodies) this.physics.bodies.set(id, { ...entry, candidate: { ...entry.candidate, regions: entry.candidate.regions.map(region => plan.regions.get(region)!) } });
    if (this.gpu.gather) this.gpu.gather(plan.oldIds); else this.gpu.invalidateUpload(0);
    this.compactedSize = this.arrangement.vertices.length; this.compactions++;
  }
  /** Synchronous compaction (tests and the structural check); never while an edit is staged. */
  compact(): void {
    if (this.staged) throw new ResidentFailure('stale', 'Cannot compact while an edit is staged');
    const start = performance.now(), steps = this.compactionSteps(); let next = steps.next(); while (!next.done) next = steps.next();
    this.applyCompaction(next.value); this.lastCompactionMs = performance.now() - start;
  }
  /** Idle maintenance, triggered by the host app when no transaction is pending: sliced compaction (preempted by any
   * new request), then the ?residentCheck oracle. Returns true when it compacted. */
  async maintenance(budgetMs = 4): Promise<boolean> {
    if (this.disposed || this.maintaining || this.busy) return false;
    let compacted = false;
    if (this.compactionDue) {
      this.maintaining = true; const release = await this.acquire();
      try {
        if (this.waiting || this.disposed || !this.compactionDue) return false;
        const start = performance.now(), steps = this.compactionSteps(); let slice = performance.now();
        for (;;) {
          const next = steps.next();
          if (next.done) { this.applyCompaction(next.value); this.lastCompactionMs = performance.now() - start; compacted = true; break; }
          if (performance.now() - slice >= budgetMs) { await yieldBackground(); if (this.waiting || this.disposed) return false; slice = performance.now(); }
        }
      } finally { this.maintaining = false; release(); }
    }
    if (this.oracle.pending && !this.busy && !this.disposed) await this.runOracle(budgetMs);
    return compacted;
  }
  /** The global oracle over the committed world: fine-graph connectivity (nothing static may be detached), the full
   * seam audit, and the incremental boundary compared face by face. Idle-only, fully sliced, preempted by any request. */
  private async runOracle(budgetMs: number): Promise<void> {
    const epoch = this.epoch, pages = this.pages, start = performance.now(), steps = this.oracleSteps(); let slice = performance.now(), failures: string[];
    try {
      for (;;) { const next = steps.next(); if (next.done) { failures = next.value; break; } if (performance.now() - slice >= budgetMs) { await yieldBackground(); if (this.busy || this.disposed || this.epoch !== epoch || this.pages !== pages) return; slice = performance.now(); } }
    } catch (error) { failures = [error instanceof Error ? error.message : String(error)]; }
    this.oracle.failures.push(...failures.map(f => `epoch ${epoch}: ${f}`));
    this.oracle.epoch = epoch; this.oracle.checked++; this.oracle.pending = false; this.oracle.milliseconds = performance.now() - start;
  }
  private * oracleSteps(): Generator<void, string[]> {
    const regions: OccupiedRegion[] = [], failures: string[] = []; let visited = 0;
    for (const page of this.pages.values()) { for (const region of page.regions) regions.push(region); if (++visited % 64 === 0) yield; }
    const graph = yield* terrainConnectivitySteps(regions, this.arrangement);
    if (graph.detached.length) failures.push(`${graph.detached.length} static group(s) are detached`);
    const audit = yield* auditBoundarySteps(graph.boundary); if (audit.unpaired || audit.orientationErrors) failures.push(`global seam audit ${JSON.stringify(audit)}`);
    const key = (face: BoundaryFace) => `${face.region.id}|${[...face.face.vertices].sort((a, b) => a - b).join(',')}`, oracle = new Set<string>();
    for (const face of graph.boundary) { oracle.add(key(face)); if (++visited % 4096 === 0) yield; }
    const incremental = yield* this.connectivity.boundarySteps(); let missing = 0;
    for (const face of incremental) { if (!oracle.has(key(face))) missing++; if (++visited % 4096 === 0) yield; }
    if (incremental.length !== oracle.size || missing) failures.push(`incremental boundary ${incremental.length} faces (${missing} unknown) differs from the oracle's ${oracle.size}`);
    let volume = 0, anchored = 0;
    for (const region of regions) { volume += region.volume; if (++visited % 8192 === 0) yield; }
    for (const region of graph.anchored) anchored += region.volume;
    if (Math.abs(anchored - volume) > Math.max(1e-5, volume * 1e-9)) failures.push(`anchored volume ${anchored} vs pages ${volume}`);
    return failures;
  }
  /** Run the oracle synchronously now (tests). */
  verifyOracle(): string[] {
    const steps = this.oracleSteps(); let next = steps.next(); while (!next.done) next = steps.next();
    this.oracle.epoch = this.epoch; this.oracle.checked++; this.oracle.pending = false; this.oracle.failures.push(...next.value); return next.value;
  }
  step(): void {
    this.physics.step();
    this.syncPoses();
    const last = this.history.at(-1); if (last) last.metrics.solverMs = this.physics.lastStepMs;
  }
  syncPoses(): void {
    const revision = this.physics.poseRevision;
    for (const [id, { body }] of this.physics.bodies) {
      // A body asleep since its last sync has not moved (only a restore teleports one): its page and fall check stand.
      const sleeping = body.isSleeping(), synced = this.synced.get(id);
      if (sleeping && synced?.sleptAt === revision) continue;
      const page = this.dynamicDraw.get(id), p = body.translation(), q = body.rotation();
      if (page) {
        // An unchanged pose would rewrite identical page records.
        const pose = synced?.pose;
        if (!pose || pose[0] !== p.x || pose[1] !== p.y || pose[2] !== p.z || pose[3] !== q.x || pose[4] !== q.y || pose[5] !== q.z || pose[6] !== q.w) page.handle.setPose([p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
      }
      const entry = synced ?? { pose: new Float64Array(7), sleptAt: -1 };
      entry.pose[0] = p.x; entry.pose[1] = p.y; entry.pose[2] = p.z; entry.pose[3] = q.x; entry.pose[4] = q.y; entry.pose[5] = q.z; entry.pose[6] = q.w;
      entry.sleptAt = sleeping ? revision : -1; if (!synced) this.synced.set(id, entry);
      const pending = this.fallPending.get(id); if (pending && Math.hypot(...sub([p.x, p.y, p.z], this.fixture.planetCenter)) < pending.distance - 1e-5) { pending.edit.metrics.firstFallMs = performance.now() - pending.at; this.fallPending.delete(id); }
    }
  }
  snapshot() { return { epoch: this.epoch, staticRegions: [...this.pages.values()].reduce((s, p) => s + p.regions.length, 0), bodyRegions: [...this.ownership.values()].filter(o => o.kind === 'body').length,
    bodies: this.physics.snapshot(), contacts: this.physics.contacts, bodyContacts: this.physics.bodyContacts, history: this.history, failure: this.lastFailure, compactions: this.compactions, oracle: this.oracle, frames: this.frameLog }; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.cancel(); if (this.idle !== undefined) clearTimeout(this.idle);
    const staged = this.staged; if (staged) this.abortStage(staged);
    this.compiler?.dispose();
    const pages = [...this.staticDraw.values(), ...this.dynamicDraw.values()];
    try { this.host.commit({ show: [], hide: pages.map(page => page.handle) }); }
    finally {
      for (const page of pages) { try { for (const a of page.attachments ?? []) a.onHide(); page.dispose(); } catch (error) { console.error(error); } }
      this.staticDraw.clear(); this.dynamicDraw.clear();
      this.physics.dispose(); this.gpu.dispose();
    }
  }
}

/** Game-facing ownership contract. Geometry objects belong only to the TS oracle. */
export type ResidentService = Pick<ResidentTerrain, 'onProgress' | 'physics' | 'epoch' | 'queries' | 'triangles' | 'lastFailure' | 'history' | 'compactions' | 'lastCompactionMs' | 'oracle' | 'autoMaintenance' | 'busy' | 'initialize' | 'cut' | 'cutMany' | 'rebuild' | 'cancel' | 'prepare' | 'commit' | 'abort' | 'poses' | 'fenceHolds' | 'maintenance' | 'step' | 'syncPoses' | 'dispose'> & { readonly engine: 'compatibility-v1' | 'rust-resident-v1' | 'rust-engine-v1' | 'rust-engine-v2' | 'rust-engine-v3' | 'rust-engine-v4' | 'rust-engine-v5' | 'rust-engine-v6' | 'rust-engine-v7' | 'rust-engine-v8' | 'rust-engine-v9' | 'rust-engine-v10' | 'rust-engine-v11' | 'rust-engine-v12' | 'rust-engine-v13' | 'rust-engine-v14' | 'rust-engine-v15' | 'rust-engine-v16' | 'rust-engine-v17' | 'rust-engine-v18' | 'rust-engine-v19' | 'rust-engine-v20' | 'rust-engine-v21' | 'rust-engine-v22' };
