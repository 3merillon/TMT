import * as RAPIER from '@dimforge/rapier3d-compat';
import type { DriveInput, TankState, V3 } from './contracts';
import { dot, frame, rotate } from './math';
import { COLLISION_GROUP, collisionGroups, type StructuralMotion, type StructuralPhysics } from './structural-physics';
import { assembleKit, tankKit, type KitAssembly } from './kit';
import { ArticulationPose, chassisReach, chassisShapes, type ChassisShape } from './vehicle/chassis';
import { DriveModel, type ChassisFrame, type DriveCommand, type TankTouch } from './vehicle/drive-model';
import { NativeDriveModel } from './vehicle/native-drive';
import { ChassisAssists, type RecoveryState } from './vehicle/assists';
import { shapeInput, type ShapedInput } from './vehicle/input-shaping';
import { FORCE_PROVIDERS, type ChassisForceContext, type ChassisForceProvider } from './vehicle/force-providers';
import { CHASSIS_BODY, chassisMassProps, TANK_CONTACT } from './vehicle/tuning';
import { addScaled, rotateInto, scale, setVec, vec, type Quat, type Vec } from './vehicle/vec';
import { vehicleCollisionGeometry } from './vehicle/wreck-geometry';
import type { LiquidQuery } from './liquids';
import { liquidResistance } from './vehicle/liquid-motion';

/** Drive state carried by the chassis checkpoint (additive over StructuralMotion). */
export interface ChassisDriveState { throttle: number; steer: number; common: number; righting: number; flipped: number }
export interface ChassisMotion extends StructuralMotion { drive?: ChassisDriveState }

/** Hull-frame chassis colliders: the tank group, colliding with everything. Articulated (turret, barrel) colliders never
 * touch static terrain; they still hit tanks, structures and debris. */
const HULL_GROUPS = collisionGroups(COLLISION_GROUP.tank, COLLISION_GROUP.all);
const ARTICULATED_GROUPS = collisionGroups(COLLISION_GROUP.articulated | COLLISION_GROUP.tank, COLLISION_GROUP.all & ~COLLISION_GROUP.terrain);

interface Chassis {
  wreck: boolean;
  body: RAPIER.RigidBody; kit: KitAssembly; colliders: RAPIER.Collider[];
  articulated: { collider: RAPIER.Collider; shape: ChassisShape }[]; pose: ArticulationPose; aim: [number, number];
  model: DriveModel | NativeDriveModel; assists: ChassisAssists; shaped: ShapedInput; recovery: RecoveryState;
  velocity: V3; angularDamping: number; frame: ChassisFrame;
  /** Bounding radius of every collider (any aim) plus TANK_CONTACT.reachMargin. */
  reach: number; touch: TankTouch;
}
function colliderDesc(shape: ChassisShape): RAPIER.ColliderDesc {
  const [x, y, z] = shape.half, b = shape.border;
  const desc = shape.kind === 'capsule' ? RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius)
    : b > 0 ? RAPIER.ColliderDesc.roundCuboid(x - b, y - b, z - b, b) : RAPIER.ColliderDesc.cuboid(x, y, z);
  return desc.setDensity(0).setFriction(CHASSIS_BODY.friction).setRestitution(CHASSIS_BODY.restitution);
}
const newFrame = (): ChassisFrame => ({ position: vec(), rotation: { x: 0, y: 0, z: 0, w: 1 }, com: vec(), linvel: vec(), angvel: vec(), right: vec(), up: vec(), forward: vec(), planetUp: vec() });

/** Scoped solver chassis (W1-PHY). Each tick: the tank-to-tank contacts of the last step (TankTouch, read from Rapier's
 * manifolds for pairs within reach); then per tank: input shaping, then the drive model (wheel ball casts,
 * suspension, anti-roll, belts, traction), then the righting assist or the self-right action, then every registered
 * ChassisForceProvider; all forces go through the StructuralPhysics queue. Mass properties, colliders and stations
 * come from `assembleKit(tankKit(t))` plus the vehicle tuning (a ballast keel lowers the COM). Rapier solves hull,
 * structure and tank contacts together; a moving slab can carry or push a tank and receives its weight. */
export class ResidentTanks {
  private match?: import('./native-match').NativeMatch;
  bindMatch(match: import('./native-match').NativeMatch): void {
    if (!this.physics.nativeChassis) throw new Error('Resident match motion requires native chassis');
    this.match = match;
  }
  private readonly chassis = new Map<number, Chassis>();
  private readonly restored = new Map<number, ChassisMotion>();
  private readonly providers: readonly ChassisForceProvider[] = FORCE_PROVIDERS.map(create => create());
  private readonly command: DriveCommand = { throttle: 0, steer: 0, traction: 1, lateral: 1, yawRate: 0, touch: null };
  private readonly entries: Chassis[] = [];
  private readonly nativeIds: number[] = [];
  private nativeWords = new Float64Array(5 + 8 * 11);
  private readonly contactPoint = vec(); private readonly contactMean = vec(); private readonly contactNormal = vec(); private readonly forwardA = vec(); private readonly forwardB = vec();
  private pairA?: Chassis; private pairB?: Chassis;
  private pairCollider?: RAPIER.Collider;
  private readonly scratchPosition = vec(); private readonly scratchRotation: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private current?: Chassis;
  private readonly context: ChassisForceContext;
  constructor(private readonly physics: StructuralPhysics, private readonly liquid?: LiquidQuery) {
    const body = () => this.current!.body;
    this.context = {
      tank: undefined as unknown as TankState, kit: undefined as unknown as KitAssembly, dt: 0, tick: 0,
      pointVelocity: p => { const v = body().velocityAtPoint({ x: p[0], y: p[1], z: p[2] }); return [v.x, v.y, v.z]; },
      addForceAtPoint: (f, p) => physics.addContactForce(body(), f, p),
      addTorque: t => physics.addContactTorque(body(), t),
    };
  }

  /** Explicit editor relocation; resets the real solver body and drive history. */
  remove(id: number): void {
    const old = this.chassis.get(id);
    if (old) { this.physics.actors.delete(old.body); this.physics.world.removeRigidBody(old.body); this.chassis.delete(id); }
    this.restored.delete(id);
  }
  relocate(tank: TankState): void {
    this.match?.motion?.restore(tank);
    const old = this.chassis.get(tank.id);
    if (old) { this.physics.actors.delete(old.body); this.physics.world.removeRigidBody(old.body); this.chassis.delete(tank.id); }
    this.restored.delete(tank.id); const entry = this.prepare(tank);
    this.match?.motion?.bind(this.physics.native!.core, [tank.id, entry.body.handle]);
  }

  private prepare(tank: TankState): Chassis {
    const kit = assembleKit(tankKit(tank)), existing = this.chassis.get(tank.id);
    const wreck = tank.health <= 0;
    if (existing?.kit === kit && existing.wreck === wreck) {
      const restored = this.restored.get(tank.id);
      if (restored) { this.applyMotion(existing, restored); this.restored.delete(tank.id); }
      return existing;
    }
    const spin = existing?.body.angvel();
    if (existing) { this.physics.actors.delete(existing.body); this.physics.world.removeRigidBody(existing.body); }
    const { mass, com, inertia } = chassisMassProps(kit), q = tank.rotation;
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...tank.position).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
      .setCcdEnabled(true).setLinearDamping(CHASSIS_BODY.linearDamping).setAngularDamping(CHASSIS_BODY.angularDamping)
      .setAdditionalMassProperties(mass, { x: com[0], y: com[1], z: com[2] }, { x: inertia[0], y: inertia[1], z: inertia[2] }, { x: 0, y: 0, z: 0, w: 1 }));
    body.setLinvel({ x: tank.velocity[0], y: tank.velocity[1], z: tank.velocity[2] }, true);
    if (spin) body.setAngvel(spin, true);
    const entry: Chassis = {
      body, kit, wreck, colliders: [], articulated: [], pose: new ArticulationPose(kit), aim: [tank.turretYaw, tank.barrelPitch],
      model: this.physics.nativeDrive ? new NativeDriveModel(this.physics, kit, body) : new DriveModel(this.physics, kit), assists: new ChassisAssists(this.physics, mass),
      shaped: existing ? existing.shaped : { throttle: 0, steer: 0 }, recovery: existing ? existing.recovery : { righting: -1, flipped: 0 },
      velocity: [...tank.velocity], angularDamping: CHASSIS_BODY.angularDamping, frame: newFrame(),
      reach: chassisReach(kit) + TANK_CONTACT.reachMargin, touch: { count: 0, total: 0, force: 0, moment: vec() },
    };
    if (existing) entry.model.common = existing.model.common;
    const restored = this.restored.get(tank.id);
    if (restored) {
      const p = restored.position, r = restored.rotation, v = restored.velocity, w = restored.angularVelocity, d = restored.drive;
      body.setTranslation({ x: p[0], y: p[1], z: p[2] }, false); body.setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] }, false);
      body.setLinvel({ x: v[0], y: v[1], z: v[2] }, false); body.setAngvel({ x: w[0], y: w[1], z: w[2] }, false);
      if (d) { entry.shaped.throttle = d.throttle; entry.shaped.steer = d.steer; entry.model.common = d.common; entry.recovery.righting = d.righting; entry.recovery.flipped = d.flipped; }
      if (restored.sleeping) body.sleep();
      this.restored.delete(tank.id);
    }
    entry.pose.update(tank.turretYaw, tank.barrelPitch);
    if (wreck) {
      // Use the remaining model, including the small swarm hull and aircraft fuselage.
      // Drive proxies and detached gun/track parts must never prop up the wreck.
      tank.wheelSuspension.fill(0);
      for (const vertices of vehicleCollisionGeometry(tank)) {
        const shape = RAPIER.ColliderDesc.convexHull(vertices);
        if (shape) entry.colliders.push(this.physics.world.createCollider(shape.setDensity(0).setFriction(.8).setRestitution(.05).setCollisionGroups(HULL_GROUPS), body));
      }
    }
    for (const shape of wreck ? [] : chassisShapes(kit)) {
      const desc = colliderDesc(shape);
      if (shape.parent === 'hull') desc.setTranslation(...shape.center).setRotation({ x: shape.rotation[0], y: shape.rotation[1], z: shape.rotation[2], w: shape.rotation[3] }).setCollisionGroups(HULL_GROUPS);
      else {
        entry.pose.place(shape, this.scratchPosition, this.scratchRotation);
        desc.setTranslation(this.scratchPosition.x, this.scratchPosition.y, this.scratchPosition.z).setRotation(this.scratchRotation).setCollisionGroups(ARTICULATED_GROUPS);
      }
      const collider = this.physics.world.createCollider(desc, body);
      entry.colliders.push(collider);
      if (shape.parent !== 'hull') entry.articulated.push({ collider, shape });
    }
    if (this.physics.nativeChassis) (entry.model as NativeDriveModel).configureControl(entry.reach, entry.shaped, entry.recovery);
    this.chassis.set(tank.id, entry); this.physics.actors.add(body);
    return entry;
  }

  beforeStep(tanks: readonly TankState[], inputs: readonly DriveInput[], dt: number): void {
    if (this.physics.nativeChassis) { this.beforeNative(tanks, inputs, dt); return; }
    const command = this.command, context = this.context;
    this.probeTankContacts(tanks);
    for (let index = 0; index < tanks.length; index++) {
      const tank = tanks[index], entry = this.entries[index], { body, model, assists, frame } = entry, input = inputs[tank.id];
      // Gameplay velocity changes (recoil, blasts) arrive through TankState.velocity.
      const ex = tank.velocity[0] - entry.velocity[0], ey = tank.velocity[1] - entry.velocity[1], ez = tank.velocity[2] - entry.velocity[2];
      if (Math.hypot(ex, ey, ez) > 1e-9) { const v = body.linvel(); body.setLinvel({ x: v.x + ex, y: v.y + ey, z: v.z + ez }, true); }
      if (entry.aim[0] !== tank.turretYaw || entry.aim[1] !== tank.barrelPitch) this.poseArticulated(entry, tank);
      const resistance = this.liquid && liquidResistance(tank, this.liquid, this.physics.planetCenter);
      const shaped = shapeInput(entry.shaped, resistance ? { ...input, throttle: (input?.throttle ?? 0) * resistance.speed, steer: (input?.steer ?? 0) * resistance.speed } : input, dt);
      command.throttle = shaped.throttle; command.steer = shaped.steer; command.traction = 1; command.lateral = 1; command.touch = entry.touch;
      let damping = CHASSIS_BODY.angularDamping + (resistance?.angularDrag ?? 0);
      if (resistance?.drag) this.liquidDrag(entry, tank, resistance.drag);
      for (const provider of this.providers) {
        const m = provider.modifiers?.(tank);
        if (m) { command.traction *= m.traction; command.lateral *= m.lateral; damping += m.angularDampingAdd; }
      }
      if (damping !== entry.angularDamping) { body.setAngularDamping(damping); entry.angularDamping = damping; }
      this.readFrame(body, frame);
      // A destroyed tank is a wreck: plain physics, no righting assist and no self-right.
      const alive = tank.health > 0;
      if (!alive) {
        entry.recovery.righting = -1; entry.recovery.flipped = 0;
        entry.shaped.throttle = entry.shaped.steer = model.common = 0;
        tank.trackSpeeds = [0, 0]; model.idle(tank);
      } else if (assists.recovery(entry.recovery, frame, input?.selfRight === true)) {
        command.throttle = command.steer = 0;
        model.updateBelts(tank, command, frame, dt); model.idle(tank);
        assists.selfRightStep(body, frame, entry.recovery, dt);
      } else {
        const wheels = model.apply(body, tank, frame, command, dt);
        if (alive) assists.righting(body, frame, wheels);
      }
      if (this.providers.length) {
        this.current = entry; context.tank = tank; context.kit = entry.kit; context.dt = dt; context.tick = this.physics.tick;
        for (const provider of this.providers) provider.apply(context);
        this.current = undefined;
      }
      // TankState.suspension: four representative stations (the axle ends) of the kit's wheelSuspension.
      const order = model.suspensionOrder;
      if (tank.suspension.length !== order.length) tank.suspension = [0, 0, 0, 0];
      for (let i = 0; i < order.length; i++) tank.suspension[i] = tank.wheelSuspension[order[i]];
    }
  }
  /** The bound match motion when a v19 solver leg replaces step + afterStep. */
  solverMotion(): import('./native-motion').NativeMotion | undefined { return this.match?.nativeSolverLeg && this.physics.nativeChassis ? this.match.motion : undefined; }
  afterStep(tanks: readonly TankState[], dt: number): void {
    if (this.match?.motion) { this.match.motion.afterPhysics(dt); return; }
    if (this.physics.nativeChassis) this.physics.native!.refreshBodies(tanks.map(t => this.chassis.get(t.id)!.body));
    for (const tank of tanks) {
      const entry = this.chassis.get(tank.id)!, body = entry.body, q = body.rotation(), p = body.translation(), v = body.linvel();
      tank.position = [p.x, p.y, p.z]; tank.rotation = [q.x, q.y, q.z, q.w]; tank.velocity = [v.x, v.y, v.z]; entry.velocity = [v.x, v.y, v.z];
      const up = rotate([0, 1, 0], tank.rotation), forward = rotate([0, 0, 1], tank.rotation), axes = frame(up, 0), w = body.angvel();
      tank.heading = Math.atan2(dot(forward, axes.right), dot(forward, axes.forward)); tank.yawVelocity = w.x * up[0] + w.y * up[1] + w.z * up[2];
      tank.recoil *= Math.exp(-6 * dt);
      for (let i = 0; i < 2; i++) tank.trackPhases[i] += tank.trackSpeeds[i] * dt;
      tank.trackPhase = (tank.trackPhases[0] + tank.trackPhases[1]) * .5;
    }
  }
  /** Contact aggregation and chassis control stay resident. Providers are an
   * explicit extension boundary; a provider runs after its chassis, as before. */
  private beforeNative(tanks: readonly TankState[], inputs: readonly DriveInput[], dt: number): void {
    const native = this.physics.native!, entries = this.entries, ids = this.nativeIds, motion = this.match?.motion;
    motion?.refresh();
    entries.length = ids.length = 0;
    for (const tank of tanks) { const entry = this.prepare(tank); entries.push(entry); ids.push(entry.body.handle); }
    const providers = this.providers.length > 0, leg = !!motion && !providers && !!this.match?.nativeChassisLeg, poses: number[] | undefined = leg ? [] : undefined;
    if (motion && !leg) { motion.bind(native.core, tanks.flatMap((t, i) => [t.id, ids[i]])); motion.contacts(); } else if (!motion) native.call(70, 0, ids);
    const stride = motion ? 7 : 11, length = 5 + tanks.length * stride;
    if (this.nativeWords.length < length) this.nativeWords = new Float64Array(length * 2);
    const words = this.nativeWords;
    words.set([dt, ...this.physics.planetCenter, providers ? 1 : tanks.length]);
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i], entry = entries[i], input = inputs[tank.id];
      if (entry.aim[0] !== tank.turretYaw || entry.aim[1] !== tank.barrelPitch) this.poseArticulated(entry, tank, poses);
      const resistance = this.liquid && liquidResistance(tank, this.liquid, this.physics.planetCenter), speed = resistance?.speed ?? 1;
      let traction = 1, lateral = 1, damping = CHASSIS_BODY.angularDamping + (resistance?.angularDrag ?? 0);
      if (resistance?.drag) this.liquidDrag(entry, tank, resistance.drag);
      for (const provider of this.providers) { const m = provider.modifiers?.(tank); if (m) { traction *= m.traction; lateral *= m.lateral; damping += m.angularDampingAdd; } }
      words.set([motion ? tank.id : entry.body.handle, Number.isFinite(input?.throttle) ? input.throttle * speed : 0, Number.isFinite(input?.steer) ? input.steer * speed : 0,
        +(input?.selfRight === true), ...(motion ? [] : [+(tank.health > 0)]), traction, lateral, damping,
        ...(motion ? [] : [tank.velocity[0] - entry.velocity[0], tank.velocity[1] - entry.velocity[1], tank.velocity[2] - entry.velocity[2]])], 5 + (providers ? 0 : i * stride));
      if (providers) {
        this.physics.flushNativeForces(); const packet = words.subarray(0, 5 + stride);
        const result = motion ? motion.chassisTick(packet) : native.call(71, 0, packet); native.revision++; this.readNativeTick(result, tanks, i);
        this.current = entry; const context = this.context; context.tank = tank; context.kit = entry.kit; context.dt = dt; context.tick = this.physics.tick;
        for (const provider of this.providers) provider.apply(context); this.current = undefined;
      }
    }
    if (leg) {
      // One engine call, the same operations in the same order as the branch below.
      const pairs = tanks.flatMap((t, i) => [t.id, ids[i]]), queue = this.physics.takeNativeForceWords();
      native.revision += poses!.length / 4; // each collider was a translation and a rotation call
      const result = motion!.chassisLeg([pairs.length / 2, ...pairs, poses!.length / 8, ...poses!, queue.length, ...queue, ...words.subarray(0, length)]);
      native.revision++; this.readNativeTick(result, tanks, 0);
    } else if (!providers) { this.physics.flushNativeForces(); const packet = words.subarray(0, length);
      const result = motion ? motion.chassisTick(packet) : native.call(71, 0, packet); native.revision++; this.readNativeTick(result, tanks, 0); }
  }
  private readNativeTick(words: Float64Array, tanks: readonly TankState[], start: number): void {
    let at = 1;
    for (let i = 0; i < words[0]; i++) {
      const tank = tanks[start + i], entry = this.entries[start + i], count = words[at + 1];
      if (words[at] !== entry.body.handle) throw new Error('Native chassis snapshot order');
      (entry.model as NativeDriveModel).readControl(words.subarray(at + 2, at + 28 + count), tank, entry.shaped, entry.recovery, entry.touch);
      const order = entry.model.suspensionOrder;
      if (tank.suspension.length !== order.length) tank.suspension = [0, 0, 0, 0];
      for (let j = 0; j < order.length; j++) tank.suspension[j] = tank.wheelSuspension[order[j]];
      at += 28 + count;
    }
  }
  private liquidDrag(entry: Chassis, tank: TankState, drag: number): void {
    // Apply at the COM: fluid resistance must not tip a tank or erase recoil/contact impulses.
    const com = entry.body.worldCom(), scale = -entry.kit.massProps.mass * drag;
    this.physics.addContactForce(entry.body, [tank.velocity[0] * scale, tank.velocity[1] * scale, tank.velocity[2] * scale], [com.x, com.y, com.z]);
  }
  /** The solver body of a tank's chassis (read-only use: diagnostics, tests, presentation probes). */
  bodyOf(tankId: number): RAPIER.RigidBody | undefined { return this.chassis.get(tankId)?.body; }
  /** Remove every chassis body from the physics world (static terrain and structures stay). */
  dispose(): void {
    for (const { body } of this.chassis.values()) { this.physics.actors.delete(body); this.physics.world.removeRigidBody(body); }
    this.chassis.clear(); this.restored.clear(); this.entries.length = 0;
  }
  motions(): ChassisMotion[] {
    return [...this.chassis].map(([id, { body, shaped, model, recovery }]) => {
      const p = body.translation(), q = body.rotation(), v = body.linvel(), w = body.angvel();
      return { id, position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w], velocity: [v.x, v.y, v.z], angularVelocity: [w.x, w.y, w.z], sleeping: body.isSleeping(),
        drive: { throttle: shaped.throttle, steer: shaped.steer, common: model.common, righting: recovery.righting, flipped: recovery.flipped } };
    });
  }
  /** Restore chassis motions (and their optional drive state) before the tanks' next beforeStep. */
  restore(motions: readonly ChassisMotion[]): void {
    for (const motion of motions) {
      const d = motion.drive;
      if (d !== undefined && !(d && [d.throttle, d.steer, d.common].every(Number.isFinite) && Math.abs(d.throttle) <= 1 && Math.abs(d.steer) <= 1
        && Number.isInteger(d.righting) && d.righting >= -1 && Number.isInteger(d.flipped) && d.flipped >= 0)) throw new Error('Invalid chassis drive state');
      this.restored.set(motion.id, structuredClone(motion));
      const entry = this.chassis.get(motion.id);
      if (entry) { this.applyMotion(entry, motion); this.restored.delete(motion.id); }
    }
  }
  private applyMotion(entry: Chassis, motion: ChassisMotion): void {
    const { body } = entry, p = motion.position, q = motion.rotation, v = motion.velocity, w = motion.angularVelocity, d = motion.drive;
    body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true); body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
    body.setLinvel({ x: v[0], y: v[1], z: v[2] }, true); body.setAngvel({ x: w[0], y: w[1], z: w[2] }, true);
    entry.velocity = [...v];
    if (d) { entry.shaped.throttle = d.throttle; entry.shaped.steer = d.steer; entry.model.common = d.common; entry.recovery.righting = d.righting; entry.recovery.flipped = d.flipped; }
    if (this.physics.nativeChassis) (entry.model as NativeDriveModel).restoreControl(entry.shaped, entry.recovery);
    if (motion.sleeping) body.sleep();
  }

  /** Solver contacts between tank chassis at the last step, accumulated per chassis (TankTouch): only pairs within
   * their summed reach are queried. Deterministic: tank order, then Rapier's contact-graph order. */
  private probeTankContacts(tanks: readonly TankState[]): void {
    const entries = this.entries;
    entries.length = 0;
    for (const tank of tanks) {
      const entry = this.prepare(tank);
      entry.touch.count = 0; entry.touch.total = entry.touch.force = 0; setVec(entry.touch.moment, 0, 0, 0);
      entries.push(entry);
    }
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j], pa = a.body.translation(), pb = b.body.translation();
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) > a.reach + b.reach) continue;
      const qa = a.body.rotation(), qb = b.body.rotation();
      rotateInto(this.forwardA, qa, 0, 0, 1); rotateInto(this.forwardB, qb, 0, 0, 1);
      this.pairA = a; this.pairB = b;
      for (const collider of a.colliders) { this.pairCollider = collider; this.physics.world.contactPairsWith(collider, this.onPair); }
      this.pairA = this.pairB = this.pairCollider = undefined;
    }
  }
  private readonly onPair = (other: RAPIER.Collider): void => {
    if (other.parent() !== this.pairB!.body) return;
    this.physics.world.contactPair(this.pairCollider!, other, this.onManifold);
  };
  private readonly onManifold = (manifold: RAPIER.TempContactManifold): void => {
    const n = manifold.numSolverContacts();
    if (n === 0) return;
    const mean = setVec(this.contactMean, 0, 0, 0);
    let points = 0, impulse = 0;
    for (let k = 0; k < n; k++) { const p = manifold.solverContactPoint(k, this.contactPoint) as Vec | null; if (p) { addScaled(mean, mean, p, 1); points++; } }
    for (let k = 0; k < manifold.numContacts(); k++) impulse += Math.max(0, manifold.contactImpulse(k));
    const a = this.pairA!.touch, b = this.pairB!.touch;
    a.count += n; b.count += n;
    if (points === 0 || impulse <= 0) return;
    scale(mean, mean, 1 / points);
    const normal = manifold.normal(this.contactNormal), force = impulse / this.physics.world.timestep;
    const fa = force * Math.abs(normal.x * this.forwardA.x + normal.y * this.forwardA.y + normal.z * this.forwardA.z);
    const fb = force * Math.abs(normal.x * this.forwardB.x + normal.y * this.forwardB.y + normal.z * this.forwardB.z);
    a.total += force; a.force += fa; addScaled(a.moment, a.moment, mean, fa);
    b.total += force; b.force += fb; addScaled(b.moment, b.moment, mean, fb);
  };

  /** With `batch`, appends [collider, translation3, rotation4] rows for a v18 chassis leg instead of calling. */
  private poseArticulated(entry: Chassis, tank: TankState, batch?: number[]): void {
    entry.aim[0] = tank.turretYaw; entry.aim[1] = tank.barrelPitch;
    entry.pose.update(tank.turretYaw, tank.barrelPitch);
    for (const { collider, shape } of entry.articulated) {
      const p = this.scratchPosition, q = this.scratchRotation;
      entry.pose.place(shape, p, q);
      if (batch) batch.push(collider.handle, p.x, p.y, p.z, q.x, q.y, q.z, q.w);
      else { collider.setTranslationWrtParent(p); collider.setRotationWrtParent(q); }
    }
  }
  private readFrame(body: RAPIER.RigidBody, f: ChassisFrame): void {
    const p = body.translation(), q = body.rotation(), c = body.worldCom(), v = body.linvel(), w = body.angvel(), center = this.physics.planetCenter;
    setVec(f.position, p.x, p.y, p.z); f.rotation.x = q.x; f.rotation.y = q.y; f.rotation.z = q.z; f.rotation.w = q.w;
    setVec(f.com, c.x, c.y, c.z); setVec(f.linvel, v.x, v.y, v.z); setVec(f.angvel, w.x, w.y, w.z);
    rotateInto(f.right, f.rotation, 1, 0, 0); rotateInto(f.up, f.rotation, 0, 1, 0); rotateInto(f.forward, f.rotation, 0, 0, 1);
    const dx = p.x - center[0], dy = p.y - center[1], dz = p.z - center[2], l = Math.hypot(dx, dy, dz) || 1;
    setVec(f.planetUp, dx / l, dy / l, dz / l);
  }
}
