/** Narrow transport adapter for the game API. Every shape, body, query and solver
 * operation lives in the resident terrain WASM instance; no Rapier JS initialization. */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { Vec3 } from '../core/types';
type Vector = RAPIER.Vector;
type Rotation = RAPIER.Rotation;
const xyz = (v: Vector) => [v.x, v.y, v.z ?? 0];
const xyzw = (q: Rotation) => [q.x, q.y, q.z, q.w];
function vector(d: ArrayLike<number>, i: number, target: Vector = { x: 0, y: 0, z: 0 }): Vector { target.x = d[i]; target.y = d[i + 1]; target.z = d[i + 2]; return target; }
const mass = (m: number, c: Vector, inertia: Vector, frame: Rotation) => [m, ...xyz(c), ...xyz(inertia), ...xyzw(frame)];

export class NativeEvents {
  words: Float64Array = new Float64Array();
  drainCollisionEvents(callback: (a: number, b: number, started: boolean) => void): void {
    const words = this.words; this.words = new Float64Array();
    for (let i = 0; i < words.length; i += 3) callback(words[i], words[i + 1], words[i + 2] !== 0);
  }
  free(): void { this.words = new Float64Array(); }
}
class NativeBody {
  private revision = -1; private state: Float64Array = new Float64Array();
  readonly colliders: NativeCollider[] = [];
  constructor(readonly owner: NativePhysicsWorld, readonly handle: number) {}
  /** Only the explicitly implemented game subset crosses this temporary API seam. */
  get api(): RAPIER.RigidBody { return this as unknown as RAPIER.RigidBody; }
  private read(): Float64Array { if (this.revision !== this.owner.revision) { this.state = this.owner.call(12, this.handle); this.revision = this.owner.revision; } return this.state; }
  acceptSnapshot(words: Float64Array): void { this.state = words; this.revision = this.owner.revision; }
  private change(op: number, data: number[]): void { this.owner.call(op, this.handle, data); this.owner.revision++; }
  translation(target?: Vector): Vector { return vector(this.read(), 0, target); }
  rotation(target: Rotation = { x: 0, y: 0, z: 0, w: 1 }): Rotation { const d = this.read(); target.x = d[3]; target.y = d[4]; target.z = d[5]; target.w = d[6]; return target; }
  linvel(target?: Vector): Vector { return vector(this.read(), 7, target); }
  angvel(target?: Vector): Vector { return vector(this.read(), 10, target); }
  worldCom(target?: Vector): Vector { return vector(this.read(), 13, target); }
  mass(): number { return this.read()[16]; }
  angularDamping(): number { return this.owner.call(43, this.handle)[1]; }
  linearDamping(): number { return this.owner.call(43, this.handle)[0]; }
  isSleeping(): boolean { return this.read()[17] !== 0; }
  bodyType(): RAPIER.RigidBodyType { return this.read()[18]; }
  isDynamic(): boolean { return this.bodyType() === 0; }
  isFixed(): boolean { return this.bodyType() === 1; }
  isEnabled(): boolean { return this.read()[19] !== 0; }
  numColliders(): number { return this.read()[20]; }
  collider(i: number): RAPIER.Collider { return this.colliders[i].api; }
  velocityAtPoint(p: Vector, target?: Vector): Vector { return vector(this.owner.call(13, this.handle, xyz(p)), 0, target); }
  recomputeMassPropertiesFromColliders(): void { this.change(14, []); }
  setTranslation(v: Vector, wake: boolean): void { this.change(15, [+wake, ...xyz(v)]); }
  setRotation(q: Rotation, wake: boolean): void { this.change(16, [+wake, ...xyzw(q)]); }
  setLinvel(v: Vector, wake: boolean): void { this.change(17, [+wake, ...xyz(v)]); }
  setAngvel(v: Vector, wake: boolean): void { this.change(18, [+wake, ...xyz(v)]); }
  setBodyType(kind: RAPIER.RigidBodyType, wake: boolean): void { this.change(19, [+wake, kind]); }
  setEnabled(enabled: boolean): void { this.change(20, [0, +enabled]); }
  setAngularDamping(value: number): void { this.change(21, [0, value]); }
  sleep(): void { this.change(22, [0]); }
  wakeUp(): void { this.change(23, [1]); }
  addForce(v: Vector, wake: boolean): void { this.change(24, [+wake, ...xyz(v)]); }
  addTorque(v: Vector, wake: boolean): void { this.change(25, [+wake, ...xyz(v)]); }
  applyImpulse(v: Vector, wake: boolean): void { this.change(26, [+wake, ...xyz(v)]); }
  applyTorqueImpulse(v: Vector, wake: boolean): void { this.change(27, [+wake, ...xyz(v)]); }
  addForceAtPoint(v: Vector, p: Vector, wake: boolean): void { this.change(28, [+wake, ...xyz(v), ...xyz(p)]); }
  resetForces(wake: boolean): void { this.change(29, [+wake, 0]); }
  resetTorques(wake: boolean): void { this.change(29, [+wake, 1]); }
  setNextKinematicTranslation(v: Vector): void { this.change(36, xyz(v)); }
  setNextKinematicRotation(q: Rotation): void { this.change(37, xyzw(q)); }
}
class NativeCollider {
  constructor(readonly owner: NativePhysicsWorld, readonly handle: number, readonly body?: NativeBody) {}
  get api(): RAPIER.Collider { return this as unknown as RAPIER.Collider; }
  parent(): RAPIER.RigidBody | null { return this.body?.api ?? null; }
  volume(): number { return this.owner.call(31, this.handle)[0]; }
  castRay(ray: RAPIER.Ray, maxTime: number, solid: boolean): number { return this.owner.call(35, this.handle, [...xyz(ray.origin), ...xyz(ray.dir), maxTime, +solid])[0]; }
  setMassProperties(m: number, c: Vector, inertia: Vector, frame: Rotation): void { this.owner.call(32, this.handle, mass(m, c, inertia, frame)); this.owner.revision++; }
  setTranslationWrtParent(v: Vector): void { this.owner.call(33, this.handle, xyz(v)); this.owner.revision++; }
  setRotationWrtParent(q: Rotation): void { this.owner.call(34, this.handle, xyzw(q)); this.owner.revision++; }
}
interface Cook { id: number; consumed: boolean; taken(): void; free(): void }
export class NativePhysicsWorld {
  revision = 0;
  get timestep(): number { return 1 / 60; }
  set timestep(value: number) { if (value !== 1 / 60) throw new Error('Native physics uses a fixed 60 Hz clock'); }
  readonly integrationParameters = {
    get numSolverIterations() { return 8; }, set numSolverIterations(n: number) { if (n !== 8) throw new Error('Unsupported solver iterations'); },
    get maxCcdSubsteps() { return 4; }, set maxCcdSubsteps(n: number) { if (n !== 4) throw new Error('Unsupported CCD substeps'); },
  };
  private closed = false;
  private readonly bodyMap = new Map<number, NativeBody>(); private readonly colliderMap = new Map<number, NativeCollider>();
  private readonly cooked = new WeakMap<RAPIER.ColliderDesc, Cook>();
  private stepWords = new Float64Array(7 + 64 * 7 + 16 * 4);
  readonly bodies = { getAll: (): RAPIER.RigidBody[] => [...this.bodyMap.values()].map(b => b.api), len: (): number => this.bodyMap.size };
  constructor(readonly core: RustTerrainCore) { core.enablePhysics(); }
  createPresentationWorld(): RAPIER.World {
    const core = this.core.physicsPeer();
    try { const world = new NativePhysicsWorld(core), free = world.free.bind(world); world.free = () => { free(); core.dispose(); }; return world.api; }
    catch (error) { core.dispose(); throw error; }
  }
  /** Adapter is deliberately not a general-purpose replacement for the JS bindings. */
  get api(): RAPIER.World { return this as unknown as RAPIER.World; }
  call(op: number, id = 0, data: ArrayLike<number> = []): Float64Array { if (this.closed) throw new Error('Native physics world is closed'); return this.core.physicsCommand(op, id, data); }
  /** One post-step crossing for all chassis; wrappers lend views of this owned result. */
  refreshBodies(bodies: readonly RAPIER.RigidBody[]): void {
    const ids = bodies.map(b => { if (this.bodyMap.get(b.handle)?.api !== b) throw new Error('Native body is absent'); return b.handle; });
    this.acceptSnapshots(ids, this.call(52, 0, ids));
  }
  /** Lend physics op 52 rows (for these body handles, in order) to the wrappers at the current revision. */
  acceptSnapshots(ids: readonly number[], words: Float64Array): void {
    for (let i = 0; i < ids.length; i++) this.bodyMap.get(ids[i])!.acceptSnapshot(words.subarray(i * 22 + 1, i * 22 + 22));
  }
  cook(desc: RAPIER.ColliderDesc, taken: () => void): Cook {
    const s = desc.shape; let data: number[] | Float64Array;
    switch (s.type) {
      case 0: data = [0, (s as RAPIER.Ball).radius]; break;
      case 1: data = [1, ...xyz((s as RAPIER.Cuboid).halfExtents)]; break;
      case 12: { const c = s as RAPIER.RoundCuboid; data = [2, ...xyz(c.halfExtents), c.borderRadius]; break; }
      case 2: { const c = s as RAPIER.Capsule; data = [3, c.halfHeight, c.radius]; break; }
      case 6: case 9: {
        const mesh = s as RAPIER.TriMesh | RAPIER.ConvexPolyhedron, indices = mesh.indices ?? new Uint32Array();
        data = new Float64Array(4 + mesh.vertices.length + indices.length);
        data.set([s.type === 6 ? 4 : indices.length ? 5 : 6, s.type === 6 ? (s as RAPIER.TriMesh).flags : 0, mesh.vertices.length / 3, indices.length / 3]);
        data.set(mesh.vertices, 4); data.set(indices, 4 + mesh.vertices.length); break;
      }
      default: throw new Error(`Unsupported native physics shape ${s.type}`);
    }
    const id = this.call(1, 0, data)[0];
    const entry: Cook = { id, consumed: false, taken, free: () => { if (!entry.consumed) { entry.consumed = true; this.call(2, id); this.cooked.delete(desc); } } };
    this.cooked.set(desc, entry); return entry;
  }
  createRigidBody(d: RAPIER.RigidBodyDesc): RAPIER.RigidBody {
    if (!d.translationsEnabledX || !d.translationsEnabledY || !d.translationsEnabledZ || !d.rotationsEnabledX || !d.rotationsEnabledY || !d.rotationsEnabledZ || d.softCcdPrediction || d.dominanceGroup || d.additionalSolverIterations || d.massOnly && d.mass !== 0) throw new Error('Unsupported native body options');
    const id = this.call(10, 0, [d.status, ...xyz(d.translation), ...xyzw(d.rotation), ...xyz(d.linvel), ...xyz(d.angvel), +d.enabled, +d.ccdEnabled, +d.sleeping, d.linearDamping, d.angularDamping, d.gravityScale, ...mass(d.mass, d.centerOfMass, d.principalAngularInertia, d.angularInertiaLocalFrame), +d.canSleep])[0];
    const body = new NativeBody(this, id); this.bodyMap.set(id, body); this.revision++; return body.api;
  }
  createCollider(d: RAPIER.ColliderDesc, body?: RAPIER.RigidBody): RAPIER.Collider {
    const b = body ? this.bodyMap.get(body.handle) : undefined; if (body && (!b || b.api !== body)) throw new Error('Native collider parent is absent');
    if (d.massPropsMode !== 0 || d.frictionCombineRule !== 0 || d.restitutionCombineRule !== 0 || d.activeHooks || d.activeCollisionTypes !== 15) throw new Error('Unsupported native collider options');
    const shape = this.cooked.get(d) ?? this.cook(d, () => {});
    try {
      const id = this.call(30, b?.handle ?? 0xffffffff, [shape.id, ...xyz(d.translation), ...xyzw(d.rotation), d.density, d.friction, d.restitution, d.collisionGroups, d.solverGroups, d.activeEvents, +d.isSensor, +d.enabled, d.contactSkin])[0];
      shape.consumed = true; this.cooked.delete(d); shape.taken();
      const collider = new NativeCollider(this, id, b); b?.colliders.push(collider); this.colliderMap.set(id, collider); this.revision++; return collider.api;
    } catch (error) { shape.free(); throw error; }
  }
  removeRigidBody(body: RAPIER.RigidBody): void {
    const b = this.bodyMap.get(body.handle); if (!b || b.api !== body) throw new Error('Native body is absent');
    this.call(11, b.handle); this.bodyMap.delete(b.handle); for (const c of b.colliders) this.colliderMap.delete(c.handle); this.revision++;
  }
  removeCollider(collider: RAPIER.Collider, _wake: boolean): void {
    const c = this.colliderMap.get(collider.handle); if (!c || c.api !== collider) throw new Error('Native collider is absent');
    this.call(38, c.handle); this.colliderMap.delete(c.handle); if (c.body) c.body.colliders.splice(c.body.colliders.indexOf(c), 1); this.revision++;
  }
  getCollider(id: number): RAPIER.Collider | null { return this.colliderMap.get(id)?.api ?? null; }
  getRigidBody(id: number): RAPIER.RigidBody | null { return this.bodyMap.get(id)?.api ?? null; }
  castShape(p: Vector, q: Rotation, velocity: Vector, shape: RAPIER.Shape, target: number, maxTime: number, stop: boolean, flags?: number, groups = 0xffffffff, excludeCollider?: RAPIER.Collider, excludeBody?: RAPIER.RigidBody, predicate?: unknown): RAPIER.ColliderShapeCastHit | null {
    if (shape.type !== 0 || flags || excludeCollider || predicate) throw new Error('Unsupported native cast options');
    const d = this.call(40, 0, [...xyz(p), ...xyzw(q), ...xyz(velocity), (shape as RAPIER.Ball).radius, target, maxTime, +stop, groups, excludeBody?.handle ?? -1]);
    return d.length ? { collider: this.getCollider(d[0])!, time_of_impact: d[1], witness1: vector(d, 2), witness2: vector(d, 5), normal1: vector(d, 8), normal2: vector(d, 11) } as RAPIER.ColliderShapeCastHit : null;
  }
  contactPairsWith(c: RAPIER.Collider, callback: (other: RAPIER.Collider) => void): void { for (const id of this.call(41, c.handle)) { const other = this.getCollider(id); if (other) callback(other); } }
  contactPair(a: RAPIER.Collider, b: RAPIER.Collider, callback: (m: RAPIER.TempContactManifold, flipped: boolean) => void): void {
    const words = this.call(42, a.handle, [b.handle]); let at = 1;
    for (let i = 0; i < words[0]; i++) {
      const start = at, ns = words[at + 3], nc = words[at + 4]; at += 5 + ns * 3 + nc * 2;
      const manifold = { normal: (target?: Vector) => vector(words, start, target), numSolverContacts: () => ns, numContacts: () => nc,
        solverContactPoint: (j: number, target?: Vector) => j >= 0 && j < ns ? vector(words, start + 5 + j * 3, target) : null,
        contactImpulse: (j: number) => words[start + 5 + ns * 3 + j * 2], contactDist: (j: number) => words[start + 6 + ns * 3 + j * 2] };
      callback(manifold as RAPIER.TempContactManifold, false);
    }
  }
  step(events?: NativeEvents): void { const words = this.call(50, 0, [0, 0, 0, 0, 0, 0, 0]); if (events) events.words = words; this.revision++; }
  radialStep(center: Vec3, gravity: number, forceBodies: readonly (RAPIER.RigidBody | undefined)[], forces: Float64Array, nf: number, torqueBodies: readonly (RAPIER.RigidBody | undefined)[], torques: Float64Array, nt: number, events?: NativeEvents, queueOnly = false): void {
    const words = this.call(queueOnly ? 51 : 50, 0, this.stepPacket(center, gravity, forceBodies, forces, nf, torqueBodies, torques, nt)); if (events) events.words = words; if (!queueOnly) this.revision++;
  }
  /** Physics op 50/51 words; a view of a reused buffer, valid until the next packet. */
  stepPacket(center: Vec3, gravity: number, forceBodies: readonly (RAPIER.RigidBody | undefined)[], forces: Float64Array, nf: number, torqueBodies: readonly (RAPIER.RigidBody | undefined)[], torques: Float64Array, nt: number): Float64Array {
    const length = 7 + nf * 7 + nt * 4; if (this.stepWords.length < length) this.stepWords = new Float64Array(length * 2);
    const d = this.stepWords; d.set([1, ...center, gravity, nf, nt]);
    for (let i = 0; i < nf; i++) { const at = 7 + i * 7; d[at] = forceBodies[i]!.handle; d.set(forces.subarray(i * 6, i * 6 + 6), at + 1); }
    for (let i = 0; i < nt; i++) { const at = 7 + nf * 7 + i * 4; d[at] = torqueBodies[i]!.handle; d.set(torques.subarray(i * 3, i * 3 + 3), at + 1); }
    return d.subarray(0, length);
  }
  free(): void { if (this.closed) return; this.core.disposePhysics(); this.closed = true; this.bodyMap.clear(); this.colliderMap.clear(); }
}
