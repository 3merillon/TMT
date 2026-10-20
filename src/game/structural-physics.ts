import * as RAPIER from '@dimforge/rapier3d-compat';
import type { BodyCandidate, ColliderDescription } from '../gpu/terrain/contracts';
import { ResidentFailure } from '../gpu/terrain/contracts';
import type { Vec3 } from '../core/types';
import { convexMassProperties } from './structural-mass';
import { GRAVITY_BODY } from './world-constants';
import { NativeEvents, NativePhysicsWorld } from './native-physics';
import type { RustTerrainCore } from '../gpu/terrain/rust-core';

let initialization: Promise<void> | undefined;
export interface StructuralBody { readonly candidate: BodyCandidate; readonly body: RAPIER.RigidBody; readonly committedTick: number }
export interface StagedPhysics { commit(): void; cancel(): void; readonly createdBodies?: ReadonlyMap<number, number> }
export interface StructuralMotion { id: number; position: Vec3; rotation: [number, number, number, number]; velocity: Vec3; angularVelocity: Vec3; sleeping: boolean }
/** A cooked Rapier shape (wasm-bindgen handle). */
type RawShape = { free(): void };
/** Dynamic colliders cooked between two yields of stageSteps. */
const COOKS_PER_STEP = 8;
/** Rapier collision-group bits (membership << 16 | filter). Static terrain is its own group so articulated tank parts
 * (turret, barrel) can ignore it while still hitting tanks, structures and debris; tank chassis colliders are a group
 * so wheel probes can treat other tanks as rigid bodies rather than ground (W1-PHY). */
export const COLLISION_GROUP = { terrain: 0x0001, articulated: 0x0002, tank: 0x0004, all: 0xffff } as const;
export const collisionGroups = (membership: number, filter: number): number => ((membership & 0xffff) << 16 | (filter & 0xffff)) >>> 0;
/** Static terrain pages: smooth contacts across internal triangle edges (no ghost bumps where triangles meet); the
 * flag includes MERGE_DUPLICATE_VERTICES. Collision queries never read collider vertex buffers back. */
export const STATIC_TERRAIN_FLAGS = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES;
export class StructuralPhysics {
  readonly bodies = new Map<number, StructuralBody>();
  readonly actors = new Set<RAPIER.RigidBody>();
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue | NativeEvents;
  readonly native?: NativePhysicsWorld;
  /** Versioned separately from the solver so prior native checkpoints keep their drive rules. */
  nativeDrive = false;
  nativeChassis = false;
  tick = 0; contacts = 0; bodyContacts = 0; lastStepMs = 0;
  massFallbacks = 0;
  /** Started-contact counting (contacts, bodyContacts), read only by diagnostics: the game turns it off, since the
   * solver never reads events and in a collapse every started contact resolves both collider parents through WASM. */
  readonly contactEvents: boolean;
  /** Incremented whenever bodies are teleported (restoreMotions): a sleeping body moves only then. */
  poseRevision = 0;
  private fixed = new Map<number, { candidate: BodyCandidate; body: RAPIER.RigidBody }>();
  lastStaticCooked = 0;
  /** Optional wall clock for the `lastStepMs` diagnostic, injected by non-simulation code (N4: simulation code never
   * reads the clock itself). Without one, lastStepMs stays 0. */
  clock: (() => number) | undefined;
  // Forces and torques queued for the next step and applied after its reset. Pooled: no per-call allocation.
  private forceBodies: (RAPIER.RigidBody | undefined)[] = []; private forceData = new Float64Array(6 * 64); private forceCount = 0;
  private torqueBodies: (RAPIER.RigidBody | undefined)[] = []; private torqueData = new Float64Array(3 * 16); private torqueCount = 0;
  private readonly scratchA = { x: 0, y: 0, z: 0 }; private readonly scratchB = { x: 0, y: 0, z: 0 };
  /** Queue a force at a world point for the next step (body.addForce before step() would be erased by its reset). */
  addContactForce(body: RAPIER.RigidBody, force: Readonly<Vec3>, point: Readonly<Vec3>): void {
    const i = this.forceCount++; if (i * 6 + 6 > this.forceData.length) { const grown = new Float64Array(this.forceData.length * 2); grown.set(this.forceData); this.forceData = grown; }
    const d = this.forceData, k = i * 6; this.forceBodies[i] = body; d[k] = force[0]; d[k + 1] = force[1]; d[k + 2] = force[2]; d[k + 3] = point[0]; d[k + 4] = point[1]; d[k + 5] = point[2];
  }
  /** Queue a world-frame torque for the next step, applied after step()'s resetTorques (a plain body.addTorque
   * before step() is erased). */
  addContactTorque(body: RAPIER.RigidBody, torque: Readonly<Vec3>): void {
    const i = this.torqueCount++; if (i * 3 + 3 > this.torqueData.length) { const grown = new Float64Array(this.torqueData.length * 2); grown.set(this.torqueData); this.torqueData = grown; }
    const d = this.torqueData, k = i * 3; this.torqueBodies[i] = body; d[k] = torque[0]; d[k + 1] = torque[1]; d[k + 2] = torque[2];
  }
  private constructor(readonly planetCenter: Vec3, clock?: () => number, contactEvents = true, core?: RustTerrainCore) {
    this.clock = clock; this.contactEvents = contactEvents;
    if (core) { this.native = new NativePhysicsWorld(core); this.world = this.native.api; this.events = new NativeEvents(); return; }
    this.events = new RAPIER.EventQueue(true);
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 }); this.world.timestep = 1 / 60;
    this.world.integrationParameters.numSolverIterations = 8;
    this.world.integrationParameters.maxCcdSubsteps = 4;
  }
  static async create(planetCenter: Vec3, options: { clock?: () => number; contactEvents?: boolean } = {}): Promise<StructuralPhysics> {
    initialization ??= RAPIER.init(); await initialization; return new StructuralPhysics(planetCenter, options.clock, options.contactEvents);
  }
  static createNative(core: RustTerrainCore, planetCenter: Vec3, options: { clock?: () => number; contactEvents?: boolean; nativeDrive?: boolean; nativeChassis?: boolean } = {}): StructuralPhysics {
    const physics = new StructuralPhysics(planetCenter, options.clock, options.contactEvents, core); physics.nativeDrive = options.nativeDrive ?? true; physics.nativeChassis = physics.nativeDrive && (options.nativeChassis ?? true); return physics;
  }
  /** Preserve insertion order when host forces precede a resident vehicle tick. */
  /** v18 chassis legs: the queued-force flush as physics op 51 words for the engine to apply in order (empty when
   * nothing is queued, exactly when flushNativeForces() would not call). Clears the queue like the flush. */
  takeNativeForceWords(): number[] {
    if (!this.native || !this.forceCount && !this.torqueCount) return [];
    const words = [...this.native.stepPacket(this.planetCenter, GRAVITY_BODY, this.forceBodies, this.forceData, this.forceCount, this.torqueBodies, this.torqueData, this.torqueCount)];
    this.forceBodies.fill(undefined, 0, this.forceCount); this.torqueBodies.fill(undefined, 0, this.torqueCount); this.forceCount = this.torqueCount = 0; return words;
  }
  flushNativeForces(): void {
    if (!this.native || !this.forceCount && !this.torqueCount) return;
    this.native.radialStep(this.planetCenter, GRAVITY_BODY, this.forceBodies, this.forceData, this.forceCount, this.torqueBodies, this.torqueData, this.torqueCount, undefined, true);
    this.forceBodies.fill(undefined, 0, this.forceCount); this.torqueBodies.fill(undefined, 0, this.torqueCount); this.forceCount = this.torqueCount = 0;
  }
  /** A collider's description; Rapier cooks its shape when the collider is inserted (or earlier through cook()). */
  private static describe(collider: ColliderDescription, dynamic: boolean): RAPIER.ColliderDesc {
    // The individual regions are convex and volume-disjoint. Rapier derives
    // coherent COM and inertia from density, including offsets within the compound.
    if (dynamic && collider.kind === 'trimesh') throw new ResidentFailure('validation', 'Dynamic structures require volume colliders');
    // The clipper already supplies a closed convex boundary. Running another
    // approximate hull reduction can discard thin, valid occupied fragments.
    const shape = collider.kind === 'trimesh' ? RAPIER.ColliderDesc.trimesh(collider.vertices, collider.indices, STATIC_TERRAIN_FLAGS)
      : collider.indices.length ? RAPIER.ColliderDesc.convexMesh(collider.vertices, collider.indices) : RAPIER.ColliderDesc.convexHull(collider.vertices);
    if (!shape) throw new ResidentFailure('validation', 'Rapier rejected a convex occupied region');
    return shape;
  }
  /** Cook a description's shape now (the costly part of an insertion: a trimesh's BVH and edge topology, a convex
   * polyhedron). ColliderSet.createCollider asks the shape for its raw form and frees it after inserting: the shape
   * hands over this one, once (later calls cook as usual), and `taken` records that Rapier owns it from then on.
   * Undefined when Rapier rejects the shape. */
  private cook(desc: RAPIER.ColliderDesc, taken: () => void): RawShape | undefined {
    if (this.native) return this.native.cook(desc, taken);
    const shape = desc.shape as RAPIER.Shape & { intoRaw(): RawShape | undefined }, raw = shape.intoRaw();
    if (raw) Object.defineProperty(shape, 'intoRaw', { configurable: true, writable: true, value: () => { delete (shape as { intoRaw?: unknown }).intoRaw; taken(); return raw; } });
    return raw;
  }
  private install(candidate: BodyCandidate, dynamic: boolean, cooked?: readonly RAPIER.ColliderDesc[]): RAPIER.RigidBody {
    const desc = (dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed())
      .setTranslation(...(candidate.pose?.position ?? candidate.center)).setEnabled(false);
    if (candidate.pose) { const q = candidate.pose.rotation; desc.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }); }
    if (dynamic) desc.setCcdEnabled(true).setCanSleep(true).setLinearDamping(.15).setAngularDamping(.25);
    const body = this.world.createRigidBody(desc);
    try {
      for (let i = 0; i < candidate.colliders.length; i++) {
        const collider = candidate.colliders[i], precooked = cooked?.[i], shape = precooked ?? StructuralPhysics.describe(collider, dynamic);
        if (collider.offset) shape.setTranslation(...collider.offset);
        if (!dynamic) shape.setCollisionGroups(collisionGroups(COLLISION_GROUP.terrain, COLLISION_GROUP.all));
        const created = this.world.createCollider(shape.setDensity(1).setFriction(.85).setRestitution(.05).setActiveEvents(this.contactEvents ? RAPIER.ActiveEvents.COLLISION_EVENTS : RAPIER.ActiveEvents.NONE), body);
        if (collider.kind !== 'trimesh' && Math.abs(created.volume() - collider.volume) > Math.max(1e-5, collider.volume * 1e-4)) {
          if (!collider.indices.length) throw new ResidentFailure('validation', `Collider volume mismatch ${created.volume()} vs ${collider.volume}`);
          // ConvexMesh retains all supplied support vertices, but Parry merges
          // nearly parallel faces before computing its mass. Integrate the
          // original closed boundary instead; collision geometry stays intact.
          const properties = convexMassProperties(collider.vertices, collider.indices);
          if (Math.abs(properties.mass - collider.volume) > Math.max(1e-7, collider.volume * 1e-4)) throw new ResidentFailure('validation', 'Collider source volume mismatch');
          created.setMassProperties(properties.mass, properties.centerOfMass, properties.principalAngularInertia, properties.angularInertiaLocalFrame); this.massFallbacks++;
        }
      }
      body.recomputeMassPropertiesFromColliders();
      if (candidate.pose) { const parent = this.bodies.get(candidate.pose.parent)?.body; if (!parent) throw new ResidentFailure('stale', 'Recut parent is absent');
        body.setLinvel(parent.velocityAtPoint(body.worldCom()), false); body.setAngvel(parent.angvel(), false); }
      return body;
    } catch (error) { this.world.removeRigidBody(body); throw error; }
  }
  /** Unchanged query pages retain their immutable typed arrays. Reuse their
   * solver bodies too: a local crater must not recook the entire planet. */
  private reusable(candidate: BodyCandidate): RAPIER.RigidBody | undefined {
    const previous = this.fixed.get(candidate.id), old = previous?.candidate;
    const same = old && !old.pose && !candidate.pose && old.center.every((v, i) => v === candidate.center[i]) && old.colliders.length === candidate.colliders.length
      && old.colliders.every((c, i) => { const next = candidate.colliders[i]; return c.kind === next.kind && c.vertices === next.vertices && c.indices === next.indices && c.volume === next.volume && c.offset === next.offset; });
    return same ? previous!.body : undefined;
  }
  /** Stage disabled bodies on the same world. No stepping can expose them. The
   * synchronous commit swaps all collision ownership at one fixed-step boundary. */
  stage(staticCandidates: readonly BodyCandidate[], candidates: readonly BodyCandidate[], removed: readonly number[] = []): StagedPhysics {
    const steps = this.stageSteps(staticCandidates, candidates, removed);
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
  }
  /** stage(), resumable. The shapes are cooked between yields (after each static page, every few dynamic colliders),
   * then the bodies and colliders are created in one block, in stage()'s order and with its checks, so the world
   * never holds a partial stage and no step can tell the two apart. Abandoning the generator frees what it cooked. */
  * stageSteps(staticCandidates: readonly BodyCandidate[], candidates: readonly BodyCandidate[], removed: readonly number[] = []): Generator<void, StagedPhysics> {
    const cooked = new Map<BodyCandidate, RAPIER.ColliderDesc[]>(), pending = new Map<RAPIER.ColliderDesc, RawShape>();
    try {
      // Best effort: anything that fails to describe or cook is left to the install below, which fails at stage()'s point.
      let rejected = false, count = 0;
      for (const candidate of staticCandidates) {
        if (rejected) break;
        if (this.reusable(candidate)) continue;
        const shapes: RAPIER.ColliderDesc[] = [];
        for (const collider of candidate.colliders) { const shape = StructuralPhysics.describe(collider, false), raw = this.cook(shape, () => pending.delete(shape)); if (!raw) { rejected = true; break; } pending.set(shape, raw); shapes.push(shape); }
        cooked.set(candidate, shapes); yield;
      }
      for (const candidate of candidates) {
        if (rejected) break;
        const shapes: RAPIER.ColliderDesc[] = []; cooked.set(candidate, shapes);
        for (const collider of candidate.colliders) {
          if (collider.kind === 'trimesh') { rejected = true; break; }
          const shape = StructuralPhysics.describe(collider, true), raw = this.cook(shape, () => pending.delete(shape)); if (!raw) { rejected = true; break; }
          pending.set(shape, raw); shapes.push(shape); if (++count % COOKS_PER_STEP === 0) yield;
        }
      }
      const fixed = new Map<number, { candidate: BodyCandidate; body: RAPIER.RigidBody }>(), created: RAPIER.RigidBody[] = [], dynamic: { candidate: BodyCandidate; body: RAPIER.RigidBody }[] = [];
      let finished = false;
      const cancel = () => { if (finished) return; finished = true; [...created, ...dynamic.map(d => d.body)].forEach(b => this.world.removeRigidBody(b)); };
      try {
        for (const candidate of staticCandidates) {
          if (fixed.has(candidate.id)) throw new ResidentFailure('validation', 'Duplicate static body ID');
          const reused = this.reusable(candidate), body = reused ?? this.install(candidate, false, cooked.get(candidate));
          if (!reused) created.push(body); fixed.set(candidate.id, { candidate, body });
        }
        for (const candidate of candidates) { if (this.bodies.has(candidate.id)) throw new ResidentFailure('validation', 'Duplicate structural body ID'); dynamic.push({ candidate, body: this.install(candidate, true, cooked.get(candidate)) }); }
      } catch (error) { cancel(); throw error; }
      return { cancel, createdBodies: this.native ? new Map(dynamic.map(({ candidate, body }) => [candidate.id, body.handle])) : undefined, commit: () => {
        if (finished) throw new ResidentFailure('stale', 'Physics stage already consumed'); finished = true;
        for (const [id, { body }] of this.fixed) if (fixed.get(id)?.body !== body) this.world.removeRigidBody(body);
        this.fixed = fixed; created.forEach(b => b.setEnabled(true)); this.lastStaticCooked = created.length;
        for (const id of removed) { const old = this.bodies.get(id); if (old) { this.world.removeRigidBody(old.body); this.bodies.delete(id); } }
        for (const { candidate, body } of dynamic) { body.setEnabled(true); body.wakeUp(); this.bodies.set(candidate.id, { candidate, body, committedTick: this.tick }); }
        // A removed support can affect an already sleeping structural body.
        for (const { body } of this.bodies.values()) body.wakeUp();
        for (const body of this.actors) body.wakeUp();
      } };
    } finally { for (const [shape, raw] of pending) { delete (shape.shape as { intoRaw?: unknown }).intoRaw; raw.free(); } }
  }
  /** v19 solver legs: the native step() with the engine call supplied by the caller (`run` sends the op 50 packet
   * and returns the step's event words); every host-side effect of step() is kept, in order. */
  nativeStepWith(run: (packet: Float64Array) => Float64Array): void {
    const start = this.clock?.(), native = this.native!;
    const words = run(native.stepPacket(this.planetCenter, GRAVITY_BODY, this.forceBodies, this.forceData, this.forceCount, this.torqueBodies, this.torqueData, this.torqueCount));
    if (this.contactEvents) (this.events as NativeEvents).words = words; native.revision++;
    this.forceBodies.fill(undefined, 0, this.forceCount); this.torqueBodies.fill(undefined, 0, this.torqueCount);
    this.forceCount = 0; this.torqueCount = 0; this.tick++;
    if (this.contactEvents) this.events.drainCollisionEvents(this.onCollision);
    if (start !== undefined) this.lastStepMs = this.clock!() - start;
  }
  step(): void {
    const start = this.clock?.();
    if (this.native) {
      this.native.radialStep(this.planetCenter, GRAVITY_BODY, this.forceBodies, this.forceData, this.forceCount, this.torqueBodies, this.torqueData, this.torqueCount, this.contactEvents ? this.events as NativeEvents : undefined);
      this.forceBodies.fill(undefined, 0, this.forceCount); this.torqueBodies.fill(undefined, 0, this.torqueCount);
    } else {
    for (const { body } of this.bodies.values()) this.applyGravity(body);
    for (const body of this.actors) this.applyGravity(body);
    // Queued forces and torques go on after the reset, so they reach this step.
    const a = this.scratchA, b = this.scratchB, f = this.forceData, t = this.torqueData;
    for (let i = 0; i < this.forceCount; i++) { const k = i * 6; a.x = f[k]; a.y = f[k + 1]; a.z = f[k + 2]; b.x = f[k + 3]; b.y = f[k + 4]; b.z = f[k + 5]; this.forceBodies[i]!.addForceAtPoint(a, b, true); this.forceBodies[i] = undefined; }
    for (let i = 0; i < this.torqueCount; i++) { const k = i * 3; a.x = t[k]; a.y = t[k + 1]; a.z = t[k + 2]; this.torqueBodies[i]!.addTorque(a, true); this.torqueBodies[i] = undefined; }
    // Events only report; the step itself is the same with or without a queue.
    this.world.step(this.contactEvents ? this.events as RAPIER.EventQueue : undefined);
    }
    this.forceCount = 0; this.torqueCount = 0; this.tick++;
    if (this.contactEvents) this.events.drainCollisionEvents(this.onCollision);
    if (start !== undefined) this.lastStepMs = this.clock!() - start;
  }
  private readonly onCollision = (a: number, b: number, started: boolean): void => {
    if (!started) return; this.contacts++;
    const ca = this.world.getCollider(a)?.parent(), cb = this.world.getCollider(b)?.parent();
    if (ca?.isDynamic() && cb?.isDynamic()) this.bodyContacts++;
  };
  /** Reset an awake body's accumulated user forces and torques, then add radial gravity at its world COM. */
  private applyGravity(body: RAPIER.RigidBody): void {
    if (body.isSleeping()) return;
    const c = body.worldCom(), dx = this.planetCenter[0] - c.x, dy = this.planetCenter[1] - c.y, dz = this.planetCenter[2] - c.z, length = Math.hypot(dx, dy, dz);
    body.resetForces(false); body.resetTorques(false); const scale = GRAVITY_BODY * body.mass() / Math.max(length, 1e-6), g = this.scratchA;
    g.x = dx * scale; g.y = dy * scale; g.z = dz * scale; body.addForce(g, false);
  }
  snapshot() { return [...this.bodies].map(([id, { body, candidate, committedTick }]) => ({ id, position: body.translation(), rotation: body.rotation(), velocity: body.linvel(), sleeping: body.isSleeping(), mass: body.mass(), regions: candidate.regionCount ?? candidate.regions.length, colliders: body.numColliders(), age: (this.tick - committedTick) / 60 })); }
  motions(): StructuralMotion[] { return [...this.bodies].map(([id, { body }]) => {
    const p = body.translation(), q = body.rotation(), v = body.linvel(), w = body.angvel(); return { id, position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], velocity: [v.x, v.y, v.z], angularVelocity: [w.x, w.y, w.z], sleeping: body.isSleeping() };
  }); }
  restoreMotions(motions: readonly StructuralMotion[], tick: number): void {
    if (motions.length !== this.bodies.size || motions.some(m => !this.bodies.has(m.id))) throw new ResidentFailure('validation', 'Checkpoint body ownership does not match replay');
    for (const motion of motions) { const body = this.bodies.get(motion.id)!.body, p = motion.position, q = motion.rotation, v = motion.velocity, w = motion.angularVelocity;
      body.setTranslation({ x: p[0], y: p[1], z: p[2] }, false); body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, false);
      body.setLinvel({ x: v[0], y: v[1], z: v[2] }, false); body.setAngvel({ x: w[0], y: w[1], z: w[2] }, false); if (motion.sleeping) body.sleep(); else body.wakeUp();
    }
    this.tick = tick; this.poseRevision++;
  }
  dispose(): void { this.events.free(); this.world.free(); this.bodies.clear(); this.actors.clear(); }
}
