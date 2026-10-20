/**
 * The resident tank drive model (W1-PHY): wheel probes, suspension, anti-roll, belts and traction for one chassis per
 * tick, applied as forces through the StructuralPhysics queue. Deterministic (tick state, inputs and Rapier queries
 * only) and allocation-free apart from the Rapier binding's own return values.
 *
 * Per tick:
 * 1. Wheels: one ball cast (radius = the kit station radius) per station along −up; compression is measured from the
 *    kit's support plane. Load = m/n · (g + k · compression) when compressed, falling linearly to zero over the droop
 *    range, minus damping; then anti-roll transfer across each axle, then the per-wheel ceiling.
 * 2. Belts: the common speed ramps toward throttle × top speed at DRIVE_ACCELERATION (BRAKE_ACCELERATION when slowing
 *    or reversing) × mobility; steering commands a yaw rate ω, so the belts run at common ∓ ω · halfSpacing. The
 *    common speed yields so the outer belt never exceeds top speed. The pitch guard (walls), the wheelie guard
 *    (shoving or ramming, judged against this tick's contacts) and the tank-contact guard scale the drive target
 *    down; steering against a head-on tank contact blends the throttle toward a pivot (TANK_CONTACT).
 * 3. Traction per contact, in two passes: first a holding force cancels the tangential gravity share (no creep on
 *    slopes), a longitudinal servo drives the contact toward its belt speed (which also servos the yaw rate), and a
 *    lateral servo kills side slip; the friction ellipse gives the longitudinal demand priority, so steering is not
 *    smothered by lateral scrub. Normal forces act at the contact. Then the tangential forces act at TRACTION_HEIGHT
 *    of the COM height above it, the longitudinal part raised toward the tank contact height while pushing another
 *    tank (TANK_CONTACT). Dynamic supports receive the equal and opposite force at the contact.
 */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { TankState } from '../contracts';
import type { KitAssembly } from '../kit/types';
import { kitWheelOffsets } from '../kit/assembly';
import { SUSPENSION_TRAVEL_SCALE } from '../modules';
import { COLLISION_GROUP, collisionGroups, type StructuralPhysics } from '../structural-physics';
import { GRAVITY_BODY } from '../world-constants';
import { ANTI_ROLL, BRAKE_ACCELERATION, chassisMassProps, DRIVE_ACCELERATION, GEAR_TRACTION, MISSING_COMPRESSION, mobility, PITCH_GUARD, STEERING, TANK_CONTACT, WHEELIE_GUARD, SUSPENSION, TRACTION_HEIGHT, TRACTION_SERVO, TURN_REFERENCE_MASS } from './tuning';
import { addScaled, cross, dot, normalize, rotateInto, scale, setVec, tangentOf, vec, type Quat, type Vec } from './vec';

/** Wheel probes stand on terrain, structures and debris; other tanks (hull or articulated parts) are rigid contacts
 * for Rapier, never ground, so one tank cannot ride its suspension up another's glacis. */
export const WHEEL_PROBE_GROUPS = collisionGroups(0x8000, COLLISION_GROUP.all & ~(COLLISION_GROUP.articulated | COLLISION_GROUP.tank));

/** The frame of one chassis for this tick (filled by the caller from the Rapier body). */
export interface ChassisFrame {
  position: Vec; rotation: Quat; com: Vec; linvel: Vec; angvel: Vec;
  right: Vec; up: Vec; forward: Vec; planetUp: Vec;
}
/** This chassis's contacts with other tanks at the last step (filled by the caller from Rapier's contact manifolds). */
export interface TankTouch {
  /** Solver contacts with other tanks. */ count: number;
  /** Contact force from other tanks (N): Σ over manifolds of normal impulse / dt. */ total: number;
  /** Its head-on part (N): the same sum weighted by |n · forward| (a side scrape adds ~0). */ force: number;
  /** Σ of the head-on per-manifold forces × the manifold's mean solver contact point (world); point = moment / force. */ moment: Vec;
}
export interface DriveCommand { throttle: number; steer: number; traction: number; lateral: number; /** Set by updateBelts. */ yawRate: number; touch: TankTouch | null }
export interface WheelReport { contacts: number; normalSum: Vec; /** Ground contact at the front and rear axle. */ front: boolean; rear: boolean }

interface Wheel {
  hit: boolean; toi: number; load: number; side: 0 | 1;
  point: Vec; normal: Vec; relative: Vec; support: RAPIER.RigidBody | null;
  /** This tick's traction: contact-plane axes and the clamped longitudinal and lateral forces. */
  longitudinal: Vec; lateral: Vec; along: number; across: number;
  /** Station in the hull frame: x, ball-centre height at the start of the cast, z. */
  lx: number; ly: number; lz: number;
}

export class DriveModel {
  /** Common belt speed (u/s), persistent chassis state. */
  common = 0;
  readonly mass: number;
  private readonly wheelMass: number;
  private readonly wheels: Wheel[];
  private readonly ball: RAPIER.Ball;
  private readonly radius: number;
  private readonly halfSpacing: number;
  private readonly mobility: number;
  private readonly turnMobility: number;
  private readonly topSpeed: number;
  private readonly gear: { longitudinal: number; lateral: number };
  /** Station indices of the front and rear axle (largest / smallest z on each side). */
  private readonly frontAxle: [number, number]; private readonly rearAxle: [number, number];
  /** TankState.suspension's four representative stations: driver-right rear, driver-left rear, driver-right front,
   * driver-left front ([4, 0, 7, 3] for eight stations). */
  readonly suspensionOrder: readonly [number, number, number, number];
  // Scratch.
  private readonly origin = vec(); private readonly down = vec(); private readonly identity: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly hold = vec(); private readonly gravity = vec();
  private readonly supportGravity = vec(); private readonly force = vec(); private readonly at = vec(); private readonly tmp = vec(); private readonly support = vec();
  private readonly touchPoint = vec();
  private readonly f3: [number, number, number] = [0, 0, 0]; private readonly p3: [number, number, number] = [0, 0, 0];
  private readonly loads: [number, number] = [0, 0]; private readonly speeds: [number, number] = [0, 0]; private readonly counts: [number, number] = [0, 0];
  readonly report: WheelReport = { contacts: 0, normalSum: vec(), front: false, rear: false };
  /** This tick's tank contact: the head-on contact force (N) and how much of the throttle turns into a pivot while
   * steering against it (0…1). */
  private touchForce = 0; private blocked = 0;

  constructor(private readonly physics: StructuralPhysics, readonly kit: KitAssembly) {
    const running = kit.running, offsets = kitWheelOffsets(kit);
    this.mass = chassisMassProps(kit).mass;
    this.wheelMass = this.mass / running.stations.length;
    const radius = this.radius = running.stations[0].radius;
    this.ball = new RAPIER.Ball(radius);
    this.wheels = running.stations.map((station, i): Wheel => ({
      hit: false, toi: 0, load: 0, side: station.side > 0 ? 0 : 1, point: vec(), normal: vec(), relative: vec(), support: null,
      longitudinal: vec(), lateral: vec(), along: 0, across: 0,
      lx: station.side * running.halfSpacing, ly: offsets[i][1] + station.radius + SUSPENSION.castAbove, lz: station.z,
    }));
    const half = this.wheels.length / 2;
    if (this.wheels.some((w, i) => w.side !== (i < half ? 0 : 1))) throw new Error(`Kit ${kit.key}: stations must list driver-left before driver-right`);
    const extreme = (from: number, sign: number) => { let best = from; for (let i = from; i < from + half; i++) if (sign * this.wheels[i].lz > sign * this.wheels[best].lz) best = i; return best; };
    this.frontAxle = [extreme(0, 1), extreme(half, 1)]; this.rearAxle = [extreme(0, -1), extreme(half, -1)];
    this.suspensionOrder = [this.rearAxle[1], this.rearAxle[0], this.frontAxle[1], this.frontAxle[0]];
    this.halfSpacing = running.halfSpacing;
    this.mobility = mobility(kit);
    this.turnMobility = Math.sqrt(TURN_REFERENCE_MASS / kit.massProps.mass);
    this.topSpeed = kit.stats.speed;
    this.gear = GEAR_TRACTION[kit.loadout.runningGear];
    if (!this.gear) throw new Error(`No solver traction for running gear ${kit.loadout.runningGear}`);
  }

  /** Commanded yaw rate (rad/s about up, positive counter-clockwise; right steer turns clockwise). */
  yawCommand(throttle: number, steer: number): number {
    const t = Math.min(1, Math.abs(throttle));
    // Inertia and equipped mass also matter while moving; previously full-throttle steering discarded mobility.
    return -steer * (STEERING.pivot * this.mobility * (1 - t) + STEERING.turn * this.turnMobility * t);
  }

  /** Ramp the belts toward the command; writes tank.trackSpeeds (driver-left, driver-right). `support` is the mean
   * wheel normal this tick (null with fewer than three contacts). */
  updateBelts(tank: TankState, command: DriveCommand, frame: ChassisFrame, dt: number, support: Vec | null = null): number {
    // Nose (or tail) pressed flat against another tank, a differential-steered hull cannot yaw while both belts drive
    // into it: steering blends the throttle out toward a pivot so the inner belt pulls back and the tank turns away.
    const throttle = command.throttle * (1 - Math.min(1, Math.abs(command.steer)) * this.blocked);
    const omega = this.yawCommand(throttle, command.steer), differential = omega * this.halfSpacing;
    const room = Math.max(0, this.topSpeed - Math.abs(differential)), sign = Math.sign(throttle);
    const wanted = Math.min(Math.abs(throttle) * this.topSpeed, room);
    // Pitch guard: no drive further up a wall than PITCH_GUARD.soft…hard (nose-up forward, nose-down in reverse).
    const climb = Math.asin(Math.max(-1, Math.min(1, dot(frame.forward, frame.planetUp) * sign)));
    let guard = Math.max(0, Math.min(1, (PITCH_GUARD.hard - climb) / (PITCH_GUARD.hard - PITCH_GUARD.soft)));
    // Wheelie guard: shoving or ramming must not rear the hull up off its own contacts.
    if (support && sign !== 0) {
      const rear = Math.asin(Math.max(-1, Math.min(1, dot(frame.forward, support) * sign)));
      if (dot(frame.linvel, frame.forward) * sign < WHEELIE_GUARD.stall * wanted)
        guard = Math.min(guard, Math.max(0, Math.min(1, (WHEELIE_GUARD.hard - rear) / (WHEELIE_GUARD.hard - WHEELIE_GUARD.soft))));
      if (!(sign > 0 ? this.report.front : this.report.rear))
        guard = Math.min(guard, Math.max(0, Math.min(1, (WHEELIE_GUARD.liftedHard - rear) / (WHEELIE_GUARD.liftedHard - WHEELIE_GUARD.liftedSoft))));
      // Pushing another tank: no drive that rears the hull up against its support.
      if (command.touch && command.touch.count > 0)
        guard = Math.min(guard, Math.max(0, Math.min(1, (TANK_CONTACT.hard - rear) / (TANK_CONTACT.hard - TANK_CONTACT.soft))));
    }
    const target = sign * wanted * guard;
    const braking = Math.abs(target) < Math.abs(this.common) || target * this.common < 0;
    const rate = (braking ? BRAKE_ACCELERATION : DRIVE_ACCELERATION) * this.mobility * dt;
    this.common += Math.max(-rate, Math.min(rate, target - this.common));
    // A wheel at +x moves at −ω·x along forward: the driver-left belt slows for a left (positive) turn.
    tank.trackSpeeds[0] = this.common - differential;
    tank.trackSpeeds[1] = this.common + differential;
    command.yawRate = omega;
    return omega;
  }

  /** Probe the wheels, update the belts, and apply suspension and traction forces for this tick. */
  apply(body: RAPIER.RigidBody, tank: TankState, frame: ChassisFrame, command: DriveCommand, dt: number): WheelReport {
    const { physics, wheels, wheelMass, mass } = this, { up, forward } = frame;
    const n = wheels.length, half = n / 2, report = this.report;
    scale(this.down, up, -1);
    // Wheel probes.
    for (let i = 0; i < n; i++) {
      const w = wheels[i];
      w.hit = false; w.load = 0; w.support = null; tank.wheelSuspension[i] = 0;
      rotateInto(this.origin, frame.rotation, w.lx, w.ly, w.lz);
      this.origin.x += frame.position.x; this.origin.y += frame.position.y; this.origin.z += frame.position.z;
      const hit = physics.world.castShape(this.origin, this.identity, this.down, this.ball, 0, SUSPENSION.castLength, true, undefined, WHEEL_PROBE_GROUPS, undefined, body);
      if (!hit) continue;
      // Contact geometry comes from the ball's side of the hit: its local normal and the ball centre at the time of
      // impact. (The terrain-side witness point is unreliable on trimeshes near internal edges: it can report a vertex
      // metres away, and a wheel force applied there spins the hull.)
      const nrm = hit.normal2;
      setVec(w.normal, -nrm.x, -nrm.y, -nrm.z);
      if (normalize(w.normal) < 1e-9 || dot(w.normal, up) < SUSPENSION.minNormalUp) continue;
      w.hit = true; w.toi = hit.time_of_impact;
      addScaled(w.point, this.origin, this.down, w.toi); addScaled(w.point, w.point, w.normal, -this.radius);
      // Slip is measured against a moving support; only a dynamic one takes reaction forces and falls with gravity.
      const parent = hit.collider.parent(), own = body.velocityAtPoint(w.point);
      w.support = parent?.isDynamic() ? parent : null;
      if (parent && !parent.isFixed()) { const other = parent.velocityAtPoint(w.point); setVec(w.relative, own.x - other.x, own.y - other.y, own.z - other.z); }
      else setVec(w.relative, own.x, own.y, own.z);
      const compression = SUSPENSION.castAbove - w.toi;
      const spring = compression >= 0 ? GRAVITY_BODY + SUSPENSION.stiffness * compression : GRAVITY_BODY * Math.max(0, 1 + compression / SUSPENSION.droopToZero);
      w.load = wheelMass * (spring - SUSPENSION.damping * dot(w.relative, w.normal));
      tank.wheelSuspension[i] = Math.max(0, Math.min(1, .5 + compression / SUSPENSION_TRAVEL_SCALE));
    }
    // Anti-roll: couple each axle's driver-left and driver-right wheel (stations pair by index across the sides).
    for (let a = 0; a < half; a++) {
      const l = wheels[a], r = wheels[a + half];
      if (!l.hit && !r.hit) continue;
      const cl = l.hit ? SUSPENSION.castAbove - l.toi : MISSING_COMPRESSION, cr = r.hit ? SUSPENSION.castAbove - r.toi : MISSING_COMPRESSION;
      const transfer = ANTI_ROLL * wheelMass * (cl - cr);
      if (l.hit) l.load += transfer; if (r.hit) r.load -= transfer;
    }
    const loads = this.loads, speeds = this.speeds, counts = this.counts, ceiling = SUSPENSION.maxLoad * mass * GRAVITY_BODY;
    loads[0] = loads[1] = speeds[0] = speeds[1] = counts[0] = counts[1] = 0;
    report.contacts = 0; setVec(report.normalSum, 0, 0, 0);
    report.front = wheels[this.frontAxle[0]].hit || wheels[this.frontAxle[1]].hit; report.rear = wheels[this.rearAxle[0]].hit || wheels[this.rearAxle[1]].hit;
    for (const w of wheels) if (w.hit) {
      w.load = Math.max(0, Math.min(ceiling, w.load)); loads[w.side] += w.load;
      report.contacts++; addScaled(report.normalSum, report.normalSum, w.normal, 1);
    }
    // Tank contact: a head-on contact ahead of the COM in the throttle direction blocks the drive by its head-on share.
    const touch = command.touch;
    this.touchForce = this.blocked = 0;
    if (touch && touch.count > 0 && touch.force > 1e-9) {
      this.touchForce = touch.force;
      scale(this.touchPoint, touch.moment, 1 / touch.force);
      setVec(this.tmp, this.touchPoint.x - frame.com.x, this.touchPoint.y - frame.com.y, this.touchPoint.z - frame.com.z);
      if (dot(this.tmp, forward) * command.throttle > 0) this.blocked = Math.min(1, touch.force / touch.total);
    }
    // Belts, knowing this tick's support.
    let support: Vec | null = null;
    if (report.contacts >= 3) { support = setVec(this.support, report.normalSum.x, report.normalSum.y, report.normalSum.z); if (normalize(support) < 1e-9) support = null; }
    this.updateBelts(tank, command, frame, dt, support);
    // Traction.
    const total = loads[0] + loads[1];
    scale(this.gravity, frame.planetUp, -GRAVITY_BODY);
    const muLong = this.gear.longitudinal * command.traction, muLat = this.gear.lateral * command.lateral;
    // Pass 1: traction demand per contact (normal forces go on now).
    let netLong = 0;
    for (const w of wheels) {
      w.along = w.across = 0;
      if (!w.hit) continue;
      const long = w.longitudinal, lat = w.lateral;
      tangentOf(long, forward, w.normal); normalize(long);
      cross(lat, w.normal, long);
      const vLong = dot(w.relative, long), vLat = dot(w.relative, lat);
      // The lateral servo targets the commanded rigid-body yaw about the COM (zero when not steering), so grip steers
      // the hull through the turn instead of scrubbing against it.
      setVec(this.tmp, w.point.x - frame.com.x, w.point.y - frame.com.y, w.point.z - frame.com.z); cross(this.tmp, up, this.tmp);
      const yawLat = command.yawRate * dot(this.tmp, lat);
      speeds[w.side] += vLong; counts[w.side]++;
      if (w.load <= 0) continue;
      // Hold: the contact's share of the tangential gravity (relative to an accelerating support's own gravity).
      if (w.support) {
        const c = w.support.worldCom(), cx = physics.planetCenter[0] - c.x, cy = physics.planetCenter[1] - c.y, cz = physics.planetCenter[2] - c.z, l = Math.hypot(cx, cy, cz) || 1;
        setVec(this.supportGravity, cx / l * GRAVITY_BODY, cy / l * GRAVITY_BODY, cz / l * GRAVITY_BODY);
      } else setVec(this.supportGravity, 0, 0, 0);
      setVec(this.tmp, this.gravity.x - this.supportGravity.x, this.gravity.y - this.supportGravity.y, this.gravity.z - this.supportGravity.z);
      tangentOf(this.hold, this.tmp, w.normal); scale(this.hold, this.hold, -mass * w.load / Math.max(1e-9, total));
      const along = dot(this.hold, long) + wheelMass * TRACTION_SERVO.longitudinal * (tank.trackSpeeds[w.side] - vLong);
      const across = dot(this.hold, lat) - wheelMass * TRACTION_SERVO.lateral * (vLat - yawLat);
      // Friction ellipse, longitudinal first.
      const maxLong = w.load * muLong;
      w.along = Math.max(-maxLong, Math.min(maxLong, along));
      const share = maxLong > 0 ? w.along / maxLong : 0, maxLat = w.load * muLat * Math.sqrt(Math.max(0, 1 - share * share));
      w.across = Math.max(-maxLat, Math.min(maxLat, across));
      netLong += w.along;
      // Normal at the contact.
      scale(this.force, w.normal, w.load); this.push(body, w, this.force, w.point);
    }
    // Pushing another tank: the longitudinal traction moves up to the contact height by the share of it that the
    // head-on contact force balances, so its couple never exceeds the contact's own (a full push raises all of it; a
    // light touch while cruising changes little).
    const raise = this.touchForce > 0 ? Math.min(1, this.touchForce / Math.max(1e-9, Math.abs(netLong))) : 0;
    // Pass 2: tangential forces at the raised point (longitudinal at the tank contact's height while pushing a tank).
    for (const w of wheels) {
      if (!w.hit || w.load <= 0) continue;
      setVec(this.tmp, frame.com.x - w.point.x, frame.com.y - w.point.y, frame.com.z - w.point.z);
      const height = TRACTION_HEIGHT * dot(this.tmp, up);
      addScaled(this.at, w.point, up, height);
      if (raise > 0) {
        scale(this.force, w.lateral, w.across); this.push(body, w, this.force, this.at);
        setVec(this.tmp, this.touchPoint.x - w.point.x, this.touchPoint.y - w.point.y, this.touchPoint.z - w.point.z);
        addScaled(this.at, w.point, up, height + raise * (dot(this.tmp, up) - height));
        scale(this.force, w.longitudinal, w.along); this.push(body, w, this.force, this.at);
      } else {
        const long = w.longitudinal, lat = w.lateral;
        setVec(this.force, long.x * w.along + lat.x * w.across, long.y * w.along + lat.y * w.across, long.z * w.along + lat.z * w.across);
        this.push(body, w, this.force, this.at);
      }
    }
    const supported = Math.max(mass * GRAVITY_BODY, total);
    tank.trackContact[0] = loads[0] / supported; tank.trackContact[1] = loads[1] / supported;
    tank.trackGroundSpeeds[0] = speeds[0] / Math.max(1, counts[0]); tank.trackGroundSpeeds[1] = speeds[1] / Math.max(1, counts[1]);
    tank.trackSlip[0] = tank.trackSpeeds[0] - tank.trackGroundSpeeds[0]; tank.trackSlip[1] = tank.trackSpeeds[1] - tank.trackGroundSpeeds[1];
    return report;
  }
  /** Clear per-wheel telemetry for a tick without wheel forces (the self-right action). */
  idle(tank: TankState): WheelReport {
    this.touchForce = this.blocked = 0;
    for (let i = 0; i < this.wheels.length; i++) { this.wheels[i].hit = false; tank.wheelSuspension[i] = 0; }
    tank.trackContact[0] = tank.trackContact[1] = 0;
    this.report.contacts = 0; setVec(this.report.normalSum, 0, 0, 0); this.report.front = this.report.rear = false;
    return this.report;
  }
  /** Queue a force on the chassis at `point`; the dynamic support gets the reaction at the contact itself. */
  private push(body: RAPIER.RigidBody, w: Wheel, force: Vec, point: Vec): void {
    const f = this.f3, p = this.p3;
    f[0] = force.x; f[1] = force.y; f[2] = force.z; p[0] = point.x; p[1] = point.y; p[2] = point.z;
    this.physics.addContactForce(body, f, p);
    if (w.support) {
      f[0] = -force.x; f[1] = -force.y; f[2] = -force.z; p[0] = w.point.x; p[1] = w.point.y; p[2] = w.point.z;
      this.physics.addContactForce(w.support, f, p);
    }
  }
}
