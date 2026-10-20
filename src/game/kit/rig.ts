/**
 * Kit v2 joint rig (W1-KIT, brief step 4): joint state → tank-local transforms of every rigid group and every
 * repeated running-gear part. Shared by poseKit, the validator, the rest-pose mesh builder and the sandbox.
 *
 * Joints (all tank-local, column-major):
 *   hull   = identity
 *   turret = T(ring) · Ry(yaw)
 *   cradle = turret · T(trunnion) · Rx(−pitch)          (+pitch elevates)
 *   barrel = cradle · T(0, 0, −recoil · travel)          (only the tube recoils)
 *   hatch  = turret · T(hinge) · Rx(−open · hatch)       (hatch ∈ [0, 1])
 *   head   = turret · T(utility + headOrigin) · joint    (spring2: Rz(−a)·Rx(b); spin: Ry(a); pitch: Rx(−a))
 */
import type { KitContext, InstancedGroup, RigidGroup } from './parts/types';
import { gearRig, type SideInput } from './running';
import { RING_FRAME } from './sockets';
import { mat4, mul, rotX, rotY, rotZ, translate, type Mat4 } from './geometry/math';

export interface RigState {
  yaw: number;
  pitch: number;
  /** 0..1 of the weapon's recoil travel. */
  recoil: number;
  /** Station wheel-centre heights per TankState side (0 = driver-left +X), rear → front. */
  wheelY: readonly [ArrayLike<number>, ArrayLike<number>];
  /** Belt phase per TankState side. */
  phase: readonly [number, number];
  /** Hatch opening 0..1. */
  hatch: number;
  /** Utility head joint values (spring2: lateral, fore-aft tilt; spin: angle; pitch: angle). */
  head: readonly [number, number];
  /** Terrain height under each TankState side's belt (local y at z), or null. */
  ground?: readonly [((z: number) => number) | null, ((z: number) => number) | null];
}

export interface RigPose {
  joints: Record<RigidGroup, Mat4>;
  instances: Record<InstancedGroup, Mat4[]>;
}

export function createRigPose(): RigPose {
  return {
    joints: { hull: mat4(), turret: mat4(), hatch: mat4(), cradle: mat4(), barrel: mat4(), head: mat4() },
    instances: { links: [], wheels: [], hubs: [], sprockets: [], idlers: [], rollers: [], arms: [], bogies: [], springs: [], tensioners: [] },
  };
}

const scratch = { a: new Float64Array(16), b: new Float64Array(16), c: new Float64Array(16) };

/** Rigid joints only (no running gear). */
export function poseJoints(ctx: KitContext, s: Pick<RigState, 'yaw' | 'pitch' | 'recoil' | 'hatch' | 'head'>, out: Record<RigidGroup, Mat4>): void {
  const t = ctx.turret, w = ctx.weapon, { a, b } = scratch;
  out.hull.set(mat4());
  mul(translate(RING_FRAME[0], RING_FRAME[1], RING_FRAME[2], a), rotY(s.yaw, b), out.turret);
  mul(out.turret, mul(translate(t.trunnion[0], t.trunnion[1], t.trunnion[2], a), rotX(-s.pitch, b), scratch.c), out.cradle);
  mul(out.cradle, translate(0, 0, -Math.max(0, Math.min(1, s.recoil)) * w.recoilTravel, a), out.barrel);
  if (t.hatch) {
    const h = t.hatch.hinge;
    mul(out.turret, mul(translate(h[0], h[1], h[2], a), rotX(-t.hatch.open * Math.max(0, Math.min(1, s.hatch)), b), scratch.c), out.hatch);
  } else out.hatch.set(out.turret);
  const u = t.utility, o = ctx.utility.headOrigin;
  let joint: Mat4;
  switch (ctx.utility.head) {
    case 'spring2': joint = mul(rotZ(-s.head[0], a), rotX(s.head[1], b), new Float64Array(16)); break;
    case 'spin': joint = rotY(s.head[0], a); break;
    case 'pitch': joint = rotX(-s.head[0], a); break;
    default: joint = mat4();
  }
  mul(out.turret, mul(translate(u[0] + o[0], u[1] + o[1], u[2] + o[2], b), joint, scratch.c), out.head);
}

/** Full pose: rigid joints and the running gear. */
export function poseRig(ctx: KitContext, s: RigState, out: RigPose): RigPose {
  poseJoints(ctx, s, out.joints);
  const sides: [SideInput, SideInput] = [
    { y: s.wheelY[0], phase: s.phase[0], ground: s.ground?.[0] ?? null },
    { y: s.wheelY[1], phase: s.phase[1], ground: s.ground?.[1] ?? null },
  ];
  gearRig(ctx.gear).pose(ctx, sides, out.instances);
  return out;
}

/** The rest state: turret forward, gun level, nominal suspension, phase 0, hatch shut. */
export function restState(ctx: KitContext): RigState {
  const y0 = ctx.gear.wheelY0, rest = [y0, y0, y0, y0];
  return { yaw: 0, pitch: 0, recoil: 0, wheelY: [rest, rest], phase: [0, 0], hatch: 0, head: [0, 0] };
}
