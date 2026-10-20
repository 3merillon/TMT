import * as RAPIER from '@dimforge/rapier3d-compat';
import { GameLiquids } from './liquids';
import type { DriveInput, Q4, TankState, TerrainQueryBounds, TerrainService, TerrainUpdate, V3, WorldQuery } from './contracts';
import { residentFootprintBounds } from './resident-queries';
import { ResidentTerrain, type ResidentService, type BodyPose, type StagedEdit } from '../gpu/terrain/service';
import { RustResidentTerrain } from '../gpu/terrain/rust-service';
import { residentPlanet, type ResidentGameProfile } from '../gpu/terrain/planet';
import { ResidentGpuPages } from '../gpu/terrain/gpu-pages';
import { ResidentFailure, sameCutShape, validCutShells, type BodyCandidate, type CutShell, type SphereCut } from '../gpu/terrain/contracts';
import { StructuralPhysics, type StructuralMotion } from './structural-physics';
import { TERRAIN_RADIUS } from './terrain-config';
import { validateTerrainEdit } from './terrain-checkpoint';
import { generatePlanetStructures, validateStructures, type TerrainStructure } from './terrain-structures';
import { ResidentTanks } from './resident-tanks';
import { NativeMatch } from './native-match';
import { NativeBallistics } from './native-ballistics';
import { NativeCombat } from './native-combat';
import { nativeBallisticQuery } from './native-queries';
import { replayResident, residentReplay, validateResidentCheckpoint, type ResidentGameCheckpoint } from './resident-checkpoint';
import { PLANET_GENERATOR, planetType, type PlanetType } from './planet-field';
import { ResidentPageWorkers } from '../gpu/terrain/page-workers';
import { loadTerrainModule } from '../gpu/terrain/rust-module';
import { generatorHash } from '../gpu/terrain/page-cache';
import type { TerrainRenderHost } from '../gpu/terrain/render-host';
import type { CommitResult, CutRequest, TerrainTicket, TerrainTransactions } from '../gpu/terrain/transactions';
import type { TriangleSoup } from './triangle-soup';
import { rotateInto } from './math';

type TicketStatus = ReturnType<TerrainTransactions['status']>;
interface TicketState {
  readonly cuts: readonly SphereCut[]; commitTick: number; speculative: boolean; status: TicketStatus;
  readonly controller: AbortController; readonly poses: readonly BodyPose[];
  staged?: StagedEdit | null; failure?: { code: string; message: string }; update?: TerrainUpdate;
}
interface Frozen { readonly body: RAPIER.RigidBody; until: number; deadline: number; readonly type: RAPIER.RigidBodyType; readonly linvel: V3; readonly angvel: V3; readonly sleeping: boolean }
/** Physics ticks after which a frozen body is released even if no commitReady call reached its untilTick. */
const FREEZE_TIMEOUT_TICKS = 600;
const MAX_CUTS = 32;
const KEEP_RESOLVED_TICKETS = 64;
const failed = (code: string, message: string): CommitResult => ({ status: 'failed', code, message });
const codeOf = (error: unknown) => error instanceof ResidentFailure ? error.code : error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'validation';
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Ball around a candidate's collider points (local frame); r is null for a candidate without points. */
const balls = new WeakMap<BodyCandidate, { x: number; y: number; z: number; r: number | null }>();
function ballOf(candidate: BodyCandidate) {
  let ball = balls.get(candidate);
  if (!ball) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const collider of candidate.colliders) {
      const offset = collider.offset ?? [0, 0, 0], v = collider.vertices;
      for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) { const x = v[i + a] + offset[a]; min[a] = Math.min(min[a], x); max[a] = Math.max(max[a], x); }
    }
    const x = (min[0] + max[0]) * .5, y = (min[1] + max[1]) * .5, z = (min[2] + max[2]) * .5;
    let r = 0;
    for (const collider of candidate.colliders) {
      const offset = collider.offset ?? [0, 0, 0], v = collider.vertices;
      for (let i = 0; i < v.length; i += 3) r = Math.max(r, Math.hypot(v[i] + offset[0] - x, v[i + 1] + offset[1] - y, v[i + 2] + offset[2] - z));
    }
    balls.set(candidate, ball = { x, y, z, r: Number.isFinite(r) && Math.abs(x) + Math.abs(y) + Math.abs(z) + r <= 1e6 ? r : null });
  }
  return ball;
}
const point = new Float64Array(3);
/** Whether a body candidate's world AABB at a pose (its collider points, rotated about the candidate centre) overlaps
 * `bounds`. A ball first: for a finite pose with |q|² within 1e-5 of 1 the pose map stretches by at most 1.00002, so a
 * ball of radius r·1.0001 + 1e-5 holds every point and a ball apart from the box leaves the exact answer false. */
function bodyOverlaps(candidate: BodyCandidate, position: V3, rotation: Q4, bounds: TerrainQueryBounds): boolean {
  const px = position[0], py = position[1], pz = position[2], qx = rotation[0], qy = rotation[1], qz = rotation[2], qw = rotation[3], ball = ballOf(candidate);
  if (ball.r !== null && Math.abs(qx * qx + qy * qy + qz * qz + qw * qw - 1) <= 1e-5 && Math.abs(px) <= 1e6 && Math.abs(py) <= 1e6 && Math.abs(pz) <= 1e6) {
    rotateInto(point, 0, ball.x, ball.y, ball.z, qx, qy, qz, qw);
    const r = ball.r * 1.0001 + 1e-5, x = px + point[0], y = py + point[1], z = pz + point[2];
    if (x - r > bounds.max[0] || x + r < bounds.min[0] || y - r > bounds.max[1] || y + r < bounds.min[1] || z - r > bounds.max[2] || z + r < bounds.min[2]) return false;
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const collider of candidate.colliders) {
    const offset = collider.offset ?? [0, 0, 0], v = collider.vertices;
    for (let i = 0; i < v.length; i += 3) {
      rotateInto(point, 0, v[i] + offset[0], v[i + 1] + offset[1], v[i + 2] + offset[2], qx, qy, qz, qw);
      const x = px + point[0], y = py + point[1], z = pz + point[2];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  return minX <= bounds.max[0] && maxX >= bounds.min[0] && minY <= bounds.max[1] && maxY >= bounds.min[1] && minZ <= bounds.max[2] && maxZ >= bounds.min[2];
}
const cutBounds = (cuts: readonly SphereCut[]): TerrainQueryBounds => ({
  min: [0, 1, 2].map(a => Math.min(...cuts.map(c => c.center[a] - c.radius))) as V3,
  max: [0, 1, 2].map(a => Math.max(...cuts.map(c => c.center[a] + c.radius))) as V3,
});

/** Non-blocking terrain edits on the resident terrain (plan §5.1): prepare stages an edit asynchronously; commitReady
 * publishes it synchronously at a fixed tick (and only then); a speculative ticket is promoted when the real impact
 * matches it exactly (a newer non-speculative prepare cancels every unpromoted speculation, so a missed guess never
 * stalls the queue); cancel releases the serial slot at the next checkpoint; freezeBodies makes the recut fence
 * deterministic by holding the bodies of the cut AABB still (kinematic) until the commit tick. */
export class ResidentTransactions implements TerrainTransactions {
  private readonly tickets = new Map<number, TicketState>();
  private readonly frozen = new Map<number, Frozen>();
  private sequence = 0;
  constructor(private readonly owner: ResidentGameTerrain) {}
  private get resident(): ResidentService { return this.owner.resident; }
  prepare(cuts: readonly CutRequest[], commitTick: number, options?: { speculative?: boolean }): TerrainTicket {
    const id = ++this.sequence, controller = new AbortController();
    const state: TicketState = { cuts: [], commitTick, speculative: !!options?.speculative, status: 'preparing', controller, poses: this.resident.poses() };
    this.tickets.set(id, state); this.prune();
    let sphereCuts: SphereCut[];
    try {
      if (!this.owner.initialized) throw new ResidentFailure('validation', 'Resident game terrain is not initialized');
      if (!Number.isSafeInteger(commitTick) || commitTick < 0) throw new ResidentFailure('validation', `Invalid commit tick ${commitTick}`);
      if (!Array.isArray(cuts) || cuts.length < 1 || cuts.length > MAX_CUTS) throw new ResidentFailure('validation', `A transaction takes 1-${MAX_CUTS} cuts`);
      if (new Set(cuts.map(c => c.id)).size !== cuts.length) throw new ResidentFailure('validation', 'Cut ids must be unique within a transaction');
      sphereCuts = cuts.map(cut => {
        if (typeof cut.id !== 'string' || !cut.id || cut.id.length > 100) throw new ResidentFailure('validation', 'Invalid cut id');
        const edit = validateTerrainEdit(cut.center, cut.radius);
        if (cut.shells !== undefined && (!this.owner.materialCraters || !validCutShells({ ...edit, shells: cut.shells }))) throw new ResidentFailure('validation', 'Invalid material crater shells');
        return { id: cut.id, center: edit.center, radius: edit.radius, repeat: 'impact' as const, ...(cut.shells ? { shells: structuredClone(cut.shells) } : {}) };
      }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    } catch (error) { state.status = 'failed'; state.failure = { code: codeOf(error), message: messageOf(error) }; return id; }
    (state as { cuts: readonly SphereCut[] }).cuts = sphereCuts;
    // A real impact supersedes every unpromoted speculation: a missed guess the caller never cancelled cannot hold the
    // serial slot (promote then returns false and the caller prepares that impact afresh).
    if (!state.speculative) for (const [other, pending] of this.tickets) if (other !== id && pending.speculative) this.cancel(other);
    this.resident.prepare(sphereCuts, { signal: controller.signal, poses: state.poses }).then(staged => {
      if (state.status === 'cancelled') { if (staged) this.resident.abort(staged); return; }
      state.staged = staged; state.status = 'ready';
    }, error => {
      if (state.status === 'cancelled') return;
      state.status = 'failed'; state.failure = { code: codeOf(error), message: messageOf(error) };
    });
    return id;
  }
  promote(ticket: TerrainTicket, cuts: readonly CutRequest[], commitTick: number): boolean {
    const state = this.tickets.get(ticket);
    if (!state || !state.speculative || (state.status !== 'preparing' && state.status !== 'ready')) return false;
    if (!Number.isSafeInteger(commitTick) || commitTick < 0 || cuts.length !== state.cuts.length) return false;
    const sorted = [...cuts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!sorted.every((cut, i) => cut.id === state.cuts[i].id && sameCutShape(cut, state.cuts[i]))) return false;
    // A body near the cut moved since the speculative snapshot: its recut would be stale. Prepare afresh.
    const bounds = cutBounds(state.cuts);
    for (const pose of state.poses) {
      const entry = this.resident.physics.bodies.get(pose.id); if (!entry) continue;
      const p = entry.body.translation(), q = entry.body.rotation(), now: V3 = [p.x, p.y, p.z], rotation: Q4 = [q.x, q.y, q.z, q.w];
      if (!bodyOverlaps(pose.candidate, pose.position, pose.rotation, bounds) && !bodyOverlaps(entry.candidate, now, rotation, bounds)) continue;
      if (entry.candidate !== pose.candidate || now.some((v, a) => v !== pose.position[a]) || rotation.some((v, a) => v !== pose.rotation[a])) return false;
    }
    if (state.status === 'ready' && state.staged && !this.resident.fenceHolds(state.staged)) return false;
    state.speculative = false; state.commitTick = commitTick; return true;
  }
  commitReady(ticket: TerrainTicket, tick: number): CommitResult {
    const state = this.tickets.get(ticket);
    if (!state) return failed('unknown-ticket', `Unknown terrain ticket ${ticket}`);
    switch (state.status) {
      case 'cancelled': return failed('cancelled', 'Terrain ticket was cancelled');
      case 'failed': this.release(tick); return failed(state.failure!.code, state.failure!.message);
      case 'committed': return { status: 'committed', update: state.update! };
      case 'preparing': return { status: 'not-ready' };
    }
    if (state.speculative) return failed('speculative', 'A speculative terrain ticket must be promoted before it commits');
    if (tick < state.commitTick) return { status: 'not-ready' };
    const before = this.resident.queries.fixed;
    try {
      if (state.staged) { this.resident.commit(state.staged); this.owner.bump(); }
      state.update = { ...this.owner.currentUpdate(), footprintBounds: residentFootprintBounds(before, this.resident.queries.fixed) };
      state.status = 'committed'; state.staged = undefined;
      this.release(tick);
      return { status: 'committed', update: state.update };
    } catch (error) {
      state.status = 'failed'; state.staged = undefined; state.failure = { code: codeOf(error), message: messageOf(error) };
      this.release(tick);
      return failed(state.failure.code, state.failure.message);
    }
  }
  cancel(ticket: TerrainTicket): void {
    const state = this.tickets.get(ticket);
    if (!state || (state.status !== 'preparing' && state.status !== 'ready')) return;
    const staged = state.staged;
    state.status = 'cancelled'; state.staged = undefined;
    // A preparing edit unwinds at its next checkpoint (worker requests reject immediately); a ready one rolls back now.
    state.controller.abort();
    if (staged) this.resident.abort(staged);
  }
  freezeBodies(bounds: TerrainQueryBounds, untilTick: number): void {
    const physics = this.resident.physics;
    for (const [id, { body, candidate }] of physics.bodies) {
      const p = body.translation(), q = body.rotation();
      if (!bodyOverlaps(candidate, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w], bounds)) continue;
      const held = this.frozen.get(id);
      if (held && held.body === body) { held.until = Math.max(held.until, untilTick); held.deadline = physics.tick + FREEZE_TIMEOUT_TICKS; continue; }
      const v = body.linvel(), w = body.angvel();
      this.frozen.set(id, { body, until: untilTick, deadline: physics.tick + FREEZE_TIMEOUT_TICKS, type: body.bodyType(), linvel: [v.x, v.y, v.z], angvel: [w.x, w.y, w.z], sleeping: body.isSleeping() });
      // Kinematic without a target: the body keeps its exact pose until released.
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false); body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    }
  }
  status(ticket: TerrainTicket): TicketStatus { return this.tickets.get(ticket)?.status ?? 'failed'; }
  /** Bodies frozen now (diagnostics and tests). */
  get frozenBodies(): number[] { return [...this.frozen.keys()]; }
  /** Checkpoint motions with every frozen body's held velocities and sleep state (the motion it resumes with), not the
   * zero velocities of its temporary kinematic hold; the pose is the held pose either way. */
  thawedMotions(motions: readonly StructuralMotion[]): StructuralMotion[] {
    return motions.map(motion => {
      const held = this.frozen.get(motion.id);
      if (!held || this.resident.physics.bodies.get(motion.id)?.body !== held.body) return motion;
      return { ...motion, velocity: [...held.linvel], angularVelocity: [...held.angvel], sleeping: held.sleeping };
    });
  }
  /** Release frozen bodies whose untilTick has passed (commitReady), or whose safety deadline has (fixedStep). */
  release(tick?: number): void {
    const physics = this.resident.physics;
    for (const [id, held] of this.frozen) {
      if (tick !== undefined ? held.until > tick : held.deadline > physics.tick) continue;
      this.frozen.delete(id);
      if (physics.bodies.get(id)?.body !== held.body) continue; // replaced by a recut: nothing to restore
      held.body.setBodyType(held.type, true);
      held.body.setLinvel({ x: held.linvel[0], y: held.linvel[1], z: held.linvel[2] }, true);
      held.body.setAngvel({ x: held.angvel[0], y: held.angvel[1], z: held.angvel[2] }, true);
      if (held.sleeping) held.body.sleep();
    }
  }
  private prune(): void {
    if (this.tickets.size <= KEEP_RESOLVED_TICKETS * 2) return;
    for (const [id, state] of this.tickets) {
      if (this.tickets.size <= KEEP_RESOLVED_TICKETS) break;
      if (state.status === 'committed' || state.status === 'failed' || state.status === 'cancelled') this.tickets.delete(id);
    }
  }
  dispose(): void { for (const id of [...this.tickets.keys()]) this.cancel(id); this.frozen.clear(); }
}

/** Game adapter: GPU pages, query snapshots and Rapier share one edit commit.
 * Content epochs and moving-query revisions are deliberately separate. */
export class ResidentGameTerrain implements TerrainService {
  private readonly liquids: import('./liquids').GameLiquids;
  configureLiquids(spawns: readonly V3[]): void { this.liquids.configure(spawns); }
  liquidBasins() { return this.liquids.solution; }
  readonly radius = TERRAIN_RADIUS;
  createPresentationPhysics(): RAPIER.World | undefined { return this.resident.physics.native?.createPresentationWorld(); }
  /** The engine module when this world's physics is native: the debris worker instantiates its own copy. */
  presentationEngine(): WebAssembly.Module | undefined {
    return this.resident.physics.native ? (this.resident as ResidentService & { engineModule?: WebAssembly.Module }).engineModule : undefined;
  }
  createMatchLifecycle(setup: import('./api/match').MatchSetup, state: import('./contracts').GameSnapshot): NativeMatch | undefined {
    const match = ['rust-engine-v4', 'rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine) ? new NativeMatch(this.resident.physics.native!.core, setup, state, ['rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine), ['rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine)) : undefined;
    if (match?.nativeMotion) this.tanks.bindMatch(match);
    return match;
  }
  createBallistics(setup: import('./api/match').MatchSetup, gravity: number): NativeBallistics | undefined {
    return ['rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine) ? new NativeBallistics(this.resident.physics.native!.core, setup, gravity, this.radius) : undefined;
  }
  createCombat: NonNullable<WorldQuery['createCombat']> = (setup, state, kit) => ['rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(this.resident.engine) ? new NativeCombat(this.resident.physics.native!.core, setup, state, kit) : undefined;
  ballisticQuery() { return nativeBallisticQuery(this.resident.queries); }
  /** raycast()/surface() forward to these same resident queries. */
  botQuery() { const q = this.ballisticQuery(); return q?.kind === 2 ? q : undefined; }
  /** rust-engine-v22: impacts cut each terrain material by its own shell (rules/material-craters.ts). */
  get materialCraters(): boolean { return this.resident.engine === 'rust-engine-v22'; }
  /** Engine playground relocates the chassis along with its displayed state. */
  relocateTank(tank: TankState): void { this.tanks.relocate(tank); }
  removeTank(id: number): void { this.tanks.remove(id); }
  private revision = 0;
  initialized = false;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tanks: ResidentTanks;
  readonly footprintSurface: WorldQuery;
  /** Non-blocking edits (WorldQuery.transactions, plan §5.1). */
  readonly transactions: ResidentTransactions;
  private constructor(readonly seed: number, readonly resident: ResidentService, readonly structures: readonly TerrainStructure[], readonly profile: ResidentGameProfile, readonly kind: PlanetType = planetType(seed)) {
    this.transactions = new ResidentTransactions(this);
    // Static pigment cannot remain at a body's old pose. Invalidate transferred
    // pages on commit and project subsequent marks only onto anchored terrain.
    this.footprintSurface = { radius: this.radius, get version() { return resident.epoch; },
      ballisticQuery: () => nativeBallisticQuery(resident.queries.fixed),
      raycast: (o, d, n) => resident.queries.fixed.raycast(o, d, n), surface: d => resident.queries.fixed.surface(d),
      isSolid: p => resident.queries.fixed.isSolid(p), queryTriangles: (bounds, max) => resident.queries.fixed.queryTriangles(bounds, max),
      visibilityTriangles: () => resident.queries.fixed.visibilityTriangles(), fixedChunks: () => resident.queries.fixed.chunks };
    this.liquids = new GameLiquids(this.footprintSurface, kind);
    this.tanks = new ResidentTanks(resident.physics, this.liquids.sample);
  }
  /** Pages are emitted on `host.device` and published through `host.commit` (plan §5.1). */
  static async create(seed: number, host: TerrainRenderHost, structures?: readonly TerrainStructure[], profile: ResidentGameProfile = 'resident-f32-game-v3', kind: PlanetType = planetType(seed), lap: (stage: string) => void = () => {}, engine?: ResidentService['engine']): Promise<ResidentGameTerrain> {
    const accepted = validateStructures(structures ?? generatePlanetStructures(seed, undefined, profile === 'resident-f32-game-v3', kind)), input = residentPlanet(seed, accepted, profile, kind);
    lap('planet-input');
    const override = new URLSearchParams(globalThis.location?.search ?? '').get('terrainCore');
    const selected = engine ?? (profile !== 'resident-f32-game-v1' && override !== 'ts' && override !== 'compatibility' ? (override === 'resident' ? 'rust-resident-v1' : override === 'engine-v1' ? 'rust-engine-v1' : override === 'engine-v2' ? 'rust-engine-v2' : override === 'engine-v3' ? 'rust-engine-v3' : override === 'engine-v4' ? 'rust-engine-v4' : override === 'engine-v5' ? 'rust-engine-v5' : override === 'engine-v6' ? 'rust-engine-v6' : override === 'engine-v7' ? 'rust-engine-v7' : override === 'engine-v8' ? 'rust-engine-v8' : override === 'engine-v9' ? 'rust-engine-v9' : override === 'engine-v10' ? 'rust-engine-v10' : override === 'engine-v11' ? 'rust-engine-v11' : override === 'engine-v12' ? 'rust-engine-v12' : override === 'engine-v13' ? 'rust-engine-v13' : override === 'engine-v14' ? 'rust-engine-v14' : override === 'engine-v15' ? 'rust-engine-v15' : override === 'engine-v16' ? 'rust-engine-v16' : override === 'engine-v17' ? 'rust-engine-v17' : override === 'engine-v18' ? 'rust-engine-v18' : override === 'engine-v19' ? 'rust-engine-v19' : override === 'engine-v20' ? 'rust-engine-v20' : override === 'engine-v21' ? 'rust-engine-v21' : 'rust-engine-v22') : 'compatibility-v1');
    const native = ['rust-engine-v1', 'rust-engine-v2', 'rust-engine-v3', 'rust-engine-v4', 'rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected);
    const physics = native ? undefined : await StructuralPhysics.create(input.planetCenter, { contactEvents: false });
    lap('rapier-initialize');
    try {
      const gpu = await ResidentGpuPages.create(host.device, 1048576);
      lap('terrain-pipelines');
      let compiler: ResidentPageWorkers | undefined;
      try {
        if (selected === 'rust-resident-v1' || native) {
          const resident = await RustResidentTerrain.create(input, gpu, physics, host, await loadTerrainModule(), undefined, undefined, selected !== 'rust-engine-v1', ['rust-engine-v3', 'rust-engine-v4', 'rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v4', 'rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(selected), ['rust-engine-v21', 'rust-engine-v22'].includes(selected), selected === 'rust-engine-v22'); resident.autoMaintenance = true;
          lap('resident-rust-world'); return new ResidentGameTerrain(seed, resident, accepted, profile, kind);
        }
        if (profile !== 'resident-f32-game-v1') {
          let rust: { module: WebAssembly.Module; generator: string } | undefined;
          // Explicit TS override for comparison/recovery. Runtime edit errors never switch implementations.
          if (new URLSearchParams(globalThis.location?.search ?? '').get('terrainCore') !== 'ts') {
            try { rust = { module: await loadTerrainModule(), generator: generatorHash(input) }; }
            catch (error) { console.warn('Terrain WASM unavailable; using TypeScript compiler.', error); }
          }
          compiler = new ResidentPageWorkers(seed, accepted, profile, true, undefined, kind, rust);
        }
        lap('worker-spawn');
        const resident = new ResidentTerrain(input, gpu, physics!, host, compiler); resident.autoMaintenance = true;
        lap('main-lattice-and-arrangement');
        return new ResidentGameTerrain(seed, resident, accepted, profile, kind);
      } catch (error) { compiler?.dispose(); gpu.dispose(); throw error; }
    } catch (error) { physics?.dispose(); throw error; }
  }
  /** Wrap an existing resident terrain (tests and benches: any page backend, e.g. the headless GeometryGate). */
  static adopt(resident: ResidentService, seed = 0, structures: readonly TerrainStructure[] = [], profile: ResidentGameProfile = 'resident-f32-game-v2', kind: PlanetType = planetType(seed)): ResidentGameTerrain {
    return new ResidentGameTerrain(seed, resident, structures, profile, kind);
  }
  static async restore(input: unknown, host: TerrainRenderHost): Promise<{ service: ResidentGameTerrain; update: TerrainUpdate }> {
    const checkpoint = validateResidentCheckpoint(input), service = await this.create(checkpoint.seed, host, checkpoint.structures, checkpoint.profile, checkpoint.kind, undefined, checkpoint.engine ?? 'compatibility-v1');
    try {
      await replayResident(service.resident, checkpoint.edits, checkpoint.bodies, checkpoint.tick);
      service.tanks.restore(checkpoint.chassis); if (checkpoint.liquids) service.liquids.restore(checkpoint.liquids); service.initialized = true; service.revision = checkpoint.revision;
      return { service, update: service.update() };
    } catch (error) { service.dispose(); throw error; }
  }
  saveCheckpoint(): Promise<ResidentGameCheckpoint> { return this.schedule(async () => validateResidentCheckpoint({
    format: 'tmt-resident-terrain', schemaVersion: 1, profile: this.profile, generator: PLANET_GENERATOR, engine: this.resident.engine, seed: this.seed, kind: this.kind, revision: this.revision,
    structures: this.structures, edits: residentReplay(this.resident), tick: this.resident.physics.tick, bodies: this.transactions.thawedMotions(this.resident.physics.motions()), chassis: this.tanks.motions(), liquids: this.liquids.checkpoint(),
  })); }
  networkWorld(from: number, initial = false): import('./online/state').WorldDelta {
    const edits = residentReplay(this.resident);
    return structuredClone({ from, count: edits.length, edits: edits.slice(from), tick: this.resident.physics.tick,
      bodies: this.transactions.thawedMotions(this.resident.physics.motions()), chassis: this.tanks.motions(), ...(initial ? { liquids: this.liquids.checkpoint() } : {}) });
  }
  /** The replica replays the host's exact cut/ownership log, including moving-body poses at each commit. */
  applyNetworkWorld(delta: import('./online/state').WorldDelta): Promise<TerrainUpdate> {
    return this.schedule(async () => {
      const count = this.resident.history.length - 1;
      if (delta.from > count || delta.count < count || delta.edits.length !== delta.count - delta.from) throw new Error('World replication sequence mismatch.');
      for (const edit of delta.edits.slice(Math.max(0, count - delta.from))) {
        this.resident.physics.restoreMotions(edit.bodies, edit.tick);
        const cuts = edit.cuts ?? (edit.cut ? [edit.cut] : []);
        if (!cuts.length) await this.resident.rebuild();
        else { const staged = await this.resident.prepare(cuts, { eligible: edit.eligible }); if (staged) this.resident.commit(staged); }
        this.revision++;
      }
      this.resident.physics.restoreMotions(delta.bodies, delta.tick); this.resident.syncPoses();
      this.revision++; // moving structures invalidate cached aim/collision queries even without a new cut
      this.tanks.restore(delta.chassis);
      if (delta.liquids) this.liquids.restore(delta.liquids);
      return this.update();
    });
  }
  get version(): number { return this.revision; }
  /** @internal transactions: a committed edit is a new content revision. */
  bump(): void { this.revision++; }
  /** @internal transactions: the update describing the committed world. */
  currentUpdate(): TerrainUpdate { return this.update(); }
  initialize(): Promise<TerrainUpdate> { return this.schedule(async () => { if (!this.initialized) { await this.resident.initialize(); this.initialized = true; this.revision++; } return this.update(); }); }
  /** Serial edit (prepare and commit at once); the transactions API is the non-blocking path. */
  carve(center: V3, radius: number, _fragments?: boolean, shells?: readonly CutShell[]): Promise<TerrainUpdate> {
    const edit = validateTerrainEdit(center, radius);
    if (shells !== undefined && (!this.materialCraters || !validCutShells({ ...edit, shells }))) return Promise.reject(new ResidentFailure('validation', 'Invalid material crater shells'));
    return this.schedule(async () => {
      if (!this.initialized) throw new Error('Resident game terrain is not initialized');
      const before = this.resident.queries.fixed;
      const accepted = await this.resident.cut({ id: `blast-${this.resident.epoch}`, center: edit.center, radius: edit.radius, repeat: 'impact', ...(shells ? { shells: structuredClone(shells) } : {}) });
      if (accepted) this.revision++;
      return { ...this.update(), footprintBounds: residentFootprintBounds(before, this.resident.queries.fixed) };
    });
  }
  /** Idle maintenance (compaction, ?residentCheck oracle); call when no transaction is pending. */
  maintenance(): Promise<boolean> { return this.resident.maintenance(); }
  private update(): TerrainUpdate {
    const edit = this.resident.history.at(-1);
    return { version: this.version, footprintVersion: this.resident.epoch, chunks: [], removed: [], seed: this.seed, planetKind: this.kind, sphericalNoise: this.profile === 'resident-f32-game-v3', triangles: this.resident.triangles,
      milliseconds: edit?.metrics.enqueueToCommitMs ?? 0, rebuilt: edit?.metrics.dirtyBricks ?? 0 };
  }
  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => { if (this.disposed) throw new Error('Resident game terrain disposed'); return operation(); });
    this.queue = run.catch(() => {}); return run;
  }
  /** A new query revision only for a step that moved a structural body: query results depend on body poses, never on
   * sleep state, so every cache keyed on the version stays exact while bodies rest awake. The queries keep the poses
   * read here until the next step (or commit), instead of reading them back from the solver for every query. */
  fixedStep(): void {
    this.resident.step(); this.transactions.release();
    if (this.resident.queries.syncPoses()) this.revision++;
  }
  stepTanks(tanks: TankState[], inputs: readonly DriveInput[], dt: number): void {
    this.tanks.beforeStep(tanks, inputs, dt);
    const motion = this.tanks.solverMotion(), synced = motion && this.resident instanceof RustResidentTerrain ? this.resident.stepSolverLeg(motion, dt) : undefined;
    // Release changes no pose: after the engine's query sync it leaves the same poses and revision as before it.
    if (synced !== undefined) { this.transactions.release(); if (synced) this.revision++; return; }
    this.fixedStep(); this.tanks.afterStep(tanks, dt);
  }
  raycast(origin: V3, direction: V3, maxDistance: number) { return this.resident.queries.raycast(origin, direction, maxDistance); }
  /** raycast() !== null, stopping at the first hit. */
  blocked(origin: V3, direction: V3, maxDistance: number) { return this.resident.queries.blocked(origin, direction, maxDistance); }
  sweepSphere(origin: V3, direction: V3, maxDistance: number, radius: number) { return this.resident.queries.sweepSphere(origin, direction, maxDistance, radius); }
  surface(direction: V3) { return this.resident.queries.surface(direction); }
  isSolid(point: V3) { return this.resident.queries.isSolid(point); }
  queryTriangles(bounds: TerrainQueryBounds, maxTriangles?: number) { return this.resident.queries.queryTriangles(bounds, maxTriangles); }
  /** queryTriangles() appended to a flat soup; true on overflow. */
  collect(bounds: TerrainQueryBounds, maxTriangles: number, out: TriangleSoup) { return this.resident.queries.collect(bounds, maxTriangles, out); }
  collisionBodies() { return [...this.resident.physics.bodies].map(([id, { body, candidate }]) => {
    const p = body.translation(), q = body.rotation();
    return { id, position: [p.x, p.y, p.z] as V3, rotation: [q.x, q.y, q.z, q.w] as [number, number, number, number], shapes: candidate.colliders };
  }); }
  diagnostics() { return { profile: this.profile, engine: this.resident.engine, kind: this.kind, epoch: this.resident.epoch, history: this.resident.history,
    bodies: this.resident.physics.snapshot(), contacts: this.resident.physics.contacts, failure: this.resident.lastFailure,
    compactions: this.resident.compactions, lastCompactionMs: this.resident.lastCompactionMs, oracle: this.resident.oracle, frozen: this.transactions.frozenBodies }; }
  /** window.__tmtMemory(): resident memory, when the engine service reports it. */
  memory() { const r = this.resident as ResidentService & { memory?(): unknown }; return { engine: this.resident.engine, frozen: this.transactions.frozenBodies.length, ...(r.memory?.() as object | undefined) }; }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.transactions.dispose(); this.resident.dispose(); }
}
