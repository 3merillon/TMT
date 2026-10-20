/** Kit admission and compact telemetry for the resident Rust wheel/traction model.
 * Native ticks read chassis/support poses and apply forces inside the physics module. */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { TankState } from '../contracts';
import type { KitAssembly } from '../kit/types';
import { kitWheelOffsets } from '../kit/assembly';
import { SUSPENSION_TRAVEL_SCALE } from '../modules';
import type { StructuralPhysics } from '../structural-physics';
import { GRAVITY_BODY } from '../world-constants';
import { WHEEL_PROBE_GROUPS, type ChassisFrame, type DriveCommand, type TankTouch, type WheelReport } from './drive-model';
import type { ShapedInput } from './input-shaping';
import type { RecoveryState } from './assists';
import { AIR_CONTROL, ASSIST_INERTIA_PER_MASS, CHASSIS_BODY, INPUT_SHAPING, RIGHTING_ASSIST, SELF_RIGHT } from './tuning';
import { ANTI_ROLL, BRAKE_ACCELERATION, chassisMassProps, DRIVE_ACCELERATION, GEAR_TRACTION, MISSING_COMPRESSION, mobility, PITCH_GUARD, STEERING, TANK_CONTACT, WHEELIE_GUARD, SUSPENSION, TRACTION_HEIGHT, TRACTION_SERVO, TURN_REFERENCE_MASS } from './tuning';
import { setVec, vec } from './vec';

export class NativeDriveModel {
  private commonValue = 0;
  readonly mass: number;
  readonly suspensionOrder: readonly [number, number, number, number];
  readonly report: WheelReport = { contacts: 0, normalSum: vec(), front: false, rear: false };
  private readonly words = new Float64Array(14);
  constructor(private readonly physics: StructuralPhysics, readonly kit: KitAssembly, private readonly body: RAPIER.RigidBody) {
    if (!physics.native) throw new Error('Native drive requires native physics');
    const running = kit.running, offsets = kitWheelOffsets(kit), stations = running.stations, n = stations.length, half = n / 2;
    if (stations.some((s, i) => (s.side > 0 ? 0 : 1) !== (i < half ? 0 : 1))) throw new Error(`Kit ${kit.key}: invalid wheel order`);
    const extreme = (from: number, sign: number) => { let best = from; for (let i = from; i < from + half; i++) if (sign * stations[i].z > sign * stations[best].z) best = i; return best; };
    this.suspensionOrder = [extreme(half, -1), extreme(0, -1), extreme(half, 1), extreme(0, 1)];
    this.mass = chassisMassProps(kit).mass;
    const gear = GEAR_TRACTION[kit.loadout.runningGear];
    physics.native.call(60, body.handle, [1, this.mass, stations[0].radius, running.halfSpacing, mobility(kit), Math.sqrt(TURN_REFERENCE_MASS / kit.massProps.mass), kit.stats.speed,
      gear.longitudinal, gear.lateral, GRAVITY_BODY, SUSPENSION.castAbove, SUSPENSION.castLength, SUSPENSION.stiffness, SUSPENSION.damping, SUSPENSION.droopToZero, SUSPENSION.maxLoad, SUSPENSION.minNormalUp,
      SUSPENSION_TRAVEL_SCALE, ANTI_ROLL, MISSING_COMPRESSION, TRACTION_HEIGHT, TRACTION_SERVO.longitudinal, TRACTION_SERVO.lateral, DRIVE_ACCELERATION, BRAKE_ACCELERATION, STEERING.pivot, STEERING.turn,
      PITCH_GUARD.soft, PITCH_GUARD.hard, WHEELIE_GUARD.soft, WHEELIE_GUARD.hard, WHEELIE_GUARD.stall, WHEELIE_GUARD.liftedSoft, WHEELIE_GUARD.liftedHard, TANK_CONTACT.soft, TANK_CONTACT.hard, WHEEL_PROBE_GROUPS, n,
      ...stations.flatMap((s, i) => [s.side > 0 ? 0 : 1, s.side * running.halfSpacing, offsets[i][1] + s.radius + SUSPENSION.castAbove, s.z])]);
  }
  get common(): number { return this.commonValue; }
  set common(value: number) { this.physics.native!.call(64, this.body.handle, [value]); this.commonValue = value; }
  configureControl(reach: number, shaped: ShapedInput, recovery: RecoveryState): void {
    const r = RIGHTING_ASSIST, s = SELF_RIGHT;
    this.physics.native!.call(65, this.body.handle, [1, reach, INPUT_SHAPING.throttle, INPUT_SHAPING.steer, ASSIST_INERTIA_PER_MASS * this.mass,
      r.stiffness, r.damping, r.deadband, r.pitchScale, r.minContacts, r.airborneDamping, r.proppedPitchScale, r.proppedDamping, AIR_CONTROL,
      s.ticks, s.rotateFrom, s.rotateTo, s.hopSpeed, s.maxRate, s.manualBelowUp, s.flippedBelowUp, s.flippedSpeed, s.autoAfterTicks, CHASSIS_BODY.angularDamping]);
    this.restoreControl(shaped, recovery);
  }
  restoreControl(shaped: ShapedInput, recovery: RecoveryState): void {
    this.physics.native!.call(66, this.body.handle, [shaped.throttle, shaped.steer, this.commonValue, recovery.righting, recovery.flipped]);
  }
  /** These host fields are checkpoint/presentation mirrors, never native tick inputs. */
  readControl(d: Float64Array, tank: TankState, shaped: ShapedInput, recovery: RecoveryState, touch: TankTouch): void {
    shaped.throttle = d[0]; shaped.steer = d[1]; recovery.righting = d[2]; recovery.flipped = d[3];
    touch.count = d[4]; touch.total = d[5]; touch.force = d[6]; setVec(touch.moment, d[7], d[8], d[9]);
    this.read(d.subarray(10), tank);
  }
  private input(command: DriveCommand, dt: number): Float64Array {
    const t = command.touch, m = t?.moment;
    this.words.set([dt, command.throttle, command.steer, command.traction, command.lateral, ...this.physics.planetCenter, t?.count ?? 0, t?.total ?? 0, t?.force ?? 0, m?.x ?? 0, m?.y ?? 0, m?.z ?? 0]); return this.words;
  }
  private read(d: Float64Array, tank: TankState, command?: DriveCommand): WheelReport {
    this.commonValue = d[0]; if (command) command.yawRate = d[1];
    for (let i = 0; i < 2; i++) { tank.trackSpeeds[i] = d[2 + i]; tank.trackContact[i] = d[4 + i]; tank.trackGroundSpeeds[i] = d[6 + i]; tank.trackSlip[i] = d[8 + i]; }
    const r = this.report; r.contacts = d[10]; setVec(r.normalSum, d[11], d[12], d[13]); r.front = !!d[14]; r.rear = !!d[15];
    for (let i = 16; i < d.length; i++) tank.wheelSuspension[i - 16] = d[i]; return r;
  }
  apply(body: RAPIER.RigidBody, tank: TankState, _frame: ChassisFrame, command: DriveCommand, dt: number): WheelReport {
    if (body !== this.body) throw new Error('Native drive chassis mismatch');
    this.physics.flushNativeForces();
    return this.read(this.physics.native!.call(61, body.handle, this.input(command, dt)), tank, command);
  }
  updateBelts(tank: TankState, command: DriveCommand, _frame: ChassisFrame, dt: number): number {
    this.read(this.physics.native!.call(62, this.body.handle, this.input(command, dt)), tank, command); return command.yawRate;
  }
  idle(tank: TankState): WheelReport { return this.read(this.physics.native!.call(63, this.body.handle), tank); }
}
