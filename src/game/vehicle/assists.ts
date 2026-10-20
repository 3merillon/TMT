/**
 * Chassis assists and recovery (W1-PHY). Deterministic: tick counters and physics state only (plan §6 N4).
 *
 * - Righting assist: a roll-biased torque toward the mean wheel normal (planet up when fewer than 3 wheels touch)
 *   beyond a 20° deadband, with only a quarter of its pitch component so hill-climb pitch stays free. Airborne it has
 *   no deadband and runs at AIR_CONTROL, so a tossed tank lands wheels-down. Torques go through
 *   StructuralPhysics.addContactTorque (applied after the step's torque reset).
 * - Self-right action: SELF_RIGHT.ticks of scripted recovery, started by DriveInput.selfRight while tipped or by
 *   itself after the tank has lain flipped for SELF_RIGHT.autoAfterTicks. A hop along planet up, then a closed-loop
 *   minimal rotation to upright (the heading is kept), velocity-driven so Rapier still resolves every contact.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { StructuralPhysics } from '../structural-physics';
import type { ChassisFrame, WheelReport } from './drive-model';
import { AIR_CONTROL, ASSIST_INERTIA_PER_MASS, RIGHTING_ASSIST, SELF_RIGHT } from './tuning';
import { addScaled, copyVec, cross, dot, len, normalize, scale, setVec, vec } from './vec';

/** Recovery state kept in the chassis motions (never in TankState). */
export interface RecoveryState {
  /** Tick of the running self-right action, or −1. */
  righting: number;
  /** Consecutive ticks the tank has lain flipped and nearly still. */
  flipped: number;
}

export class ChassisAssists {
  private readonly ref = vec(); private readonly axis = vec(); private readonly tilt = vec(); private readonly torque = vec(); private readonly out = vec();
  private readonly t3: [number, number, number] = [0, 0, 0];
  private readonly inertia: number;
  constructor(private readonly physics: StructuralPhysics, mass: number) { this.inertia = ASSIST_INERTIA_PER_MASS * mass; }

  /** Queue this tick's righting torque. */
  righting(body: RAPIER.RigidBody, frame: ChassisFrame, wheels: WheelReport): void {
    const { up, forward, right, angvel } = frame, airborne = wheels.contacts === 0;
    if (wheels.contacts >= RIGHTING_ASSIST.minContacts) { copyVec(this.ref, wheels.normalSum); if (normalize(this.ref) < 1e-9) copyVec(this.ref, frame.planetUp); }
    else copyVec(this.ref, frame.planetUp);
    cross(this.axis, up, this.ref);
    const s = len(this.axis), angle = Math.atan2(s, dot(up, this.ref));
    const excess = Math.max(0, angle - (airborne ? 0 : RIGHTING_ASSIST.deadband));
    if (excess <= 0 && !airborne) return;
    const I = this.inertia, propped = wheels.front !== wheels.rear;
    addScaled(this.tilt, angvel, up, -dot(angvel, up));
    scale(this.torque, this.tilt, -RIGHTING_ASSIST.damping * I * (airborne ? RIGHTING_ASSIST.airborneDamping : propped ? RIGHTING_ASSIST.proppedDamping : 1));
    if (s > 1e-9) addScaled(this.torque, this.torque, this.axis, RIGHTING_ASSIST.stiffness * I * excess / s);
    // Keep the roll component (about forward); a quarter of the pitch component (about right); no yaw.
    scale(this.out, forward, dot(this.torque, forward));
    addScaled(this.out, this.out, right, dot(this.torque, right) * (propped ? RIGHTING_ASSIST.proppedPitchScale : RIGHTING_ASSIST.pitchScale));
    if (airborne) scale(this.out, this.out, AIR_CONTROL);
    const t = this.t3; t[0] = this.out.x; t[1] = this.out.y; t[2] = this.out.z;
    this.physics.addContactTorque(body, t);
  }

  /** Advance the flip counter and start the action when due; true while the action runs. */
  recovery(state: RecoveryState, frame: ChassisFrame, selfRight: boolean): boolean {
    const upright = dot(frame.up, frame.planetUp);
    state.flipped = upright < SELF_RIGHT.flippedBelowUp && len(frame.linvel) < SELF_RIGHT.flippedSpeed ? state.flipped + 1 : 0;
    if (state.righting < 0 && (state.flipped >= SELF_RIGHT.autoAfterTicks || (selfRight && upright < SELF_RIGHT.manualBelowUp))) state.righting = 0;
    return state.righting >= 0;
  }

  /** One tick of the self-right action (drive forces are off meanwhile). */
  selfRightStep(body: RAPIER.RigidBody, frame: ChassisFrame, state: RecoveryState, dt: number): void {
    const k = state.righting, { up, planetUp } = frame;
    if (k === 0) { scale(this.out, planetUp, SELF_RIGHT.hopSpeed); body.setLinvel(this.out, true); }
    // The minimal rotation taking up onto planet up keeps the heading; upside down, roll about forward.
    cross(this.axis, up, planetUp);
    const s = len(this.axis), c = dot(up, planetUp);
    let angle = Math.atan2(s, c);
    if (s > 1e-6) scale(this.axis, this.axis, 1 / s);
    else if (c < 0) { copyVec(this.axis, frame.forward); angle = Math.PI; }
    else angle = 0;
    let rate = 0;
    if (k >= SELF_RIGHT.rotateFrom) rate = Math.min(SELF_RIGHT.maxRate, angle / (Math.max(1, SELF_RIGHT.rotateTo - k + 1) * dt));
    setVec(this.out, this.axis.x * rate, this.axis.y * rate, this.axis.z * rate);
    body.setAngvel(this.out, true);
    state.righting = k + 1 >= SELF_RIGHT.ticks ? -1 : k + 1;
    if (state.righting < 0) state.flipped = 0;
  }
}
