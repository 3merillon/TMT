/**
 * `poseKit` v2 (W1-KIT): joint and instance matrices for one TankState. No three.
 *
 * - Joints (mat4, column-major, tank-local; the tank root's world pose is the caller's): hull, turret, cradle,
 *   barrel (the recoiling tube), hatch and the utility head ('antenna' | 'radar' | 'periscope'); see rig.ts.
 *   The displayed gun pitch is clamped to `pitchLimits(yaw)` (gun-over-deck auto elevation).
 * - Instances: 12 floats per instance, the rows of an affine 3×4 matrix. `linkInstances` = belt links in
 *   `linkSlot` order (every other link of the −X then the +X belt, then the remaining links; LOD2 draws the
 *   leading half at double pitch); `wheelInstances` = road wheels, sprockets, idlers, return rollers, arms, bogies /
 *   rockers, springs and tensioner arms, concatenated (`kitInstanceSource` maps a PartMesh to its slice).
 * - Running gear from `wheelSuspension` (kit v1 mapping: 0.4 per unit, droop 0.12, compression 0.085), lifted onto
 *   the coarse `treadContacts` when no detailed `treadTerrain` is given; the belt conforms to either.
 * - Presentation hints are read structurally (like `kit?`): `time` (s; radar spin), `hatch` (0..1) or `aiming`
 *   (hatch open); without them the hatch opens while the tank stands still. The whip antenna leans with the
 *   tank-local velocity and yaw rate and rings after a shot (recoil). Stateless: equal inputs, equal outputs.
 * - `KitPoser` keeps a KitPose with the inputs it was last posed with: since posing is stateless, joints or running
 *   gear whose inputs are bit-identical keep the matrices a new pose would write (a parked tank solves no belts).
 */
import type { Q4, TankState } from '../contracts';
import { kitContext } from './build';
import { clamp } from './geometry/math';
import { groupJoint, INSTANCE_FLOATS, instanceMatrix, WHEEL_BUFFER_ORDER, wheelSlice, writeInstance } from './mesh-builder';
import { PERISCOPE_RANGE } from './parts/utilities/periscope';
import { WHIP } from './parts/utilities/antenna';
import { antennaIdle, utilityIdle } from './utility-motion';
import type { InstancedGroup, KitContext, RigidGroup } from './parts/types';
import { createRigPose, poseJoints, type RigPose, type RigState } from './rig';
import { gearRig, lod2LinkInstances, memberSlabX, nativeGearWords, stationHeight, SUSPENSION, type SideInput } from './running';
import type { KitAssembly, KitPose, PartMesh } from './types';

export { INSTANCE_FLOATS, instanceMatrix };

/** Every joint name poseKit can produce, parents first. */
export const KIT_JOINTS = Object.freeze(['hull', 'turret', 'hatch', 'cradle', 'barrel', 'antenna', 'radar', 'periscope'] as const);
const RIGID: readonly RigidGroup[] = ['hull', 'turret', 'hatch', 'cradle', 'barrel', 'head'];

/** Optional presentation hints read from the tank state (structural; not part of TankState). */
export interface KitPresentationHints { time?: number; hatch?: number; aiming?: boolean }

/** The joints an assembly's meshes reference. */
export function kitJointNames(a: KitAssembly): string[] {
  const ctx = kitContext(a.loadout);
  const names = ['hull', 'turret', 'cradle', 'barrel'];
  if (ctx.turret.hatch) names.splice(2, 0, 'hatch');
  if (ctx.utility.head) names.push(groupJoint(ctx, 'head'));
  return names;
}

function linkCount(ctx: KitContext): number { return gearRig(ctx.gear).layout.counts.links; }
function wheelCount(ctx: KitContext): number { const c = gearRig(ctx.gear).layout.counts; return WHEEL_BUFFER_ORDER.reduce((s, g) => s + c[g], 0); }

/** What posing needs of an assembly, resolved once (assemblies are cached and frozen). */
interface Derived { ctx: KitContext; links: number; wheels: number; rigid: readonly (readonly [RigidGroup, string])[] }
const derivedCache = new WeakMap<KitAssembly, Derived>();
function derived(a: KitAssembly): Derived {
  let d = derivedCache.get(a);
  if (!d) {
    const ctx = kitContext(a.loadout);
    const rigid = RIGID.filter(group => !(group === 'hatch' && !ctx.turret.hatch) && !(group === 'head' && !ctx.utility.head)).map(group => [group, groupJoint(ctx, group)] as const);
    derivedCache.set(a, d = { ctx, links: linkCount(ctx), wheels: wheelCount(ctx), rigid });
  }
  return d;
}

/** A KitPose sized for `a` (identity joints, zeroed instances). */
export function createKitPose(a: KitAssembly): KitPose {
  const ctx = kitContext(a.loadout);
  const identity = () => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  return {
    joints: new Map(kitJointNames(a).map(name => [name, identity()])),
    linkInstances: new Float32Array(linkCount(ctx) * INSTANCE_FLOATS),
    wheelInstances: new Float32Array(wheelCount(ctx) * INSTANCE_FLOATS),
  };
}

/** Which KitPose instance buffer, and which slice of it, drives a repeated PartMesh (null for rigid parts). */
export function kitInstanceSource(a: KitAssembly, part: PartMesh | string): { buffer: 'linkInstances' | 'wheelInstances'; first: number; count: number } | null {
  const ctx = kitContext(a.loadout), name = typeof part === 'string' ? part : part.part;
  // LOD2 links: the leading even-link slots (drawn at double pitch; running.ts linkSlot).
  if (name === 'links') return { buffer: 'linkInstances', first: 0, count: typeof part !== 'string' && part.lod === 2 ? lod2LinkInstances(gearRig(ctx.gear).layout.linkCount) : linkCount(ctx) };
  if ((WHEEL_BUFFER_ORDER as readonly string[]).includes(name) || name === 'hubs') {
    const s = wheelSlice(ctx, name as InstancedGroup);
    return s.count ? { buffer: 'wheelInstances', first: s.first, count: s.count } : null;
  }
  return null;
}

const NO_GROUND = 0, TERRAIN = 1, COARSE = 2;

/**
 * Piecewise-linear ground under one belt, refilled per pose and read through `at` (bound once): the detailed
 * terrain sorted by z, else the coarse tread contacts at the tread stations.
 */
class GroundProfile {
  mode = NO_GROUND;
  private pts: readonly (readonly [number, number])[] = [];
  private stations: readonly number[] = [];
  private h = new Float64Array(9);
  readonly at = (z: number): number => this.mode === TERRAIN ? this.terrainAt(z) : this.coarseAt(z);

  /**
   * Whether there is ground. `borrow` keeps an already sorted terrain array by reference (valid until the pose
   * returns); otherwise the points are copied, as a state handed out must not change with its source.
   */
  set(stations: readonly number[], contacts: readonly number[] | undefined, side: number, terrain: readonly (readonly [number, number])[] | undefined, borrow: boolean): boolean {
    if (terrain?.length) {
      let sorted = borrow;
      for (let i = 1; sorted && i < terrain.length; i++) if (!(terrain[i - 1][0] <= terrain[i][0])) sorted = false;
      // A stable sort leaves a non-decreasing sequence as it is.
      this.pts = sorted ? terrain : [...terrain].sort((p, q) => p[0] - q[0]);
      this.mode = TERRAIN;
      return true;
    }
    this.mode = NO_GROUND;
    if (!contacts) return false;
    if (this.h.length !== stations.length) this.h = new Float64Array(stations.length);
    let any = false;
    for (let i = 0; i < stations.length; i++) { const v = contacts[side * 9 + i] ?? -1.2; this.h[i] = v; if (!(v <= -1.1)) any = true; }
    if (!any) return false;
    this.stations = stations;
    this.mode = COARSE;
    return true;
  }

  private terrainAt(z: number): number {
    const pts = this.pts;
    if (z <= pts[0][0]) return pts[0][1];
    if (z >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    let i = 0; while (i + 1 < pts.length - 1 && pts[i + 1][0] < z) i++;
    const t = (z - pts[i][0]) / Math.max(1e-9, pts[i + 1][0] - pts[i][0]);
    return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
  }

  private coarseAt(z: number): number {
    const stations = this.stations, h = this.h;
    if (z <= stations[0]) return h[0];
    if (z >= stations[8]) return h[8];
    let i = 0; while (i < 7 && z > stations[i + 1]) i++;
    const t = (z - stations[i]) / (stations[i + 1] - stations[i]);
    return h[i] + (h[i + 1] - h[i]) * t;
  }

  /** The profile as engine rig words (rig.rs `pose`): 0 none; 1 terrain: n, (z, y)*n; 2 coarse: n, heights, stations. */
  words(out: number[]): void {
    if (this.mode === TERRAIN) { out.push(TERRAIN, this.pts.length); for (const p of this.pts) out.push(p[0], p[1]); }
    else if (this.mode === COARSE) { out.push(COARSE, this.h.length); for (let i = 0; i < this.h.length; i++) out.push(this.h[i]); out.push(...this.stations); }
    else out.push(NO_GROUND);
  }

  /** The profile's shape into a pose key at `at`; returns the next free index (the key grows as needed). */
  key(key: Keys, at: number): number {
    if (this.mode === TERRAIN) {
      const pts = this.pts;
      at = key.reserve(at, 2 + pts.length * 2);
      key.next[at++] = TERRAIN; key.next[at++] = pts.length;
      for (let i = 0; i < pts.length; i++) { key.next[at++] = pts[i][0]; key.next[at++] = pts[i][1]; }
    } else if (this.mode === COARSE) {
      at = key.reserve(at, 2 + this.h.length);
      key.next[at++] = COARSE; key.next[at++] = this.h.length;
      for (let i = 0; i < this.h.length; i++) key.next[at++] = this.h[i];
    } else { at = key.reserve(at, 1); key.next[at++] = NO_GROUND; }
    return at;
  }
}

/** A mutable rig state and its ground profiles. */
class StateWork {
  readonly wheelY: [number[], number[]] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  readonly phase: [number, number] = [0, 0];
  readonly head: [number, number] = [0, 0];
  readonly profiles: [GroundProfile, GroundProfile] = [new GroundProfile(), new GroundProfile()];
  readonly ground: [((z: number) => number) | null, ((z: number) => number) | null] = [null, null];
  readonly sides: [SideInput, SideInput] = [{ y: this.wheelY[0], phase: 0, ground: null }, { y: this.wheelY[1], phase: 0, ground: null }];
  readonly state: RigState = { yaw: 0, pitch: 0, recoil: 0, wheelY: this.wheelY, phase: this.phase, hatch: 0, head: this.head, ground: this.ground };
}

/** Fill `w` with the rig state a TankState implies. */
function stateInto(a: KitAssembly, ctx: KitContext, t: TankState & KitPresentationHints, w: StateWork, borrow: boolean): RigState {
  const g = ctx.gear;
  const yaw = t.turretYaw, lim = a.pitchLimits(yaw);
  const pitch = clamp(t.barrelPitch, lim.min, lim.max);
  const stations = a.running.treadStations, z = gearRig(g).layout.stationZ;
  for (let side = 0; side < 2; side++) {
    const terrain = t.health <= 0 ? undefined : t.treadTerrain?.[side];
    const ground = w.ground[side] = w.profiles[side].set(stations, t.health <= 0 ? undefined : t.treadContacts, side, terrain, borrow) ? w.profiles[side].at : null;
    const coarse = !terrain?.length ? ground : null;
    for (let i = 0; i < 4; i++) {
      let y = stationHeight(g, t.health <= 0 ? 0 : t.wheelSuspension?.[side * 4 + i] ?? 0.5);
      // Lift wheels onto the coarse contact profile (the physics' wheels ride the same ground).
      if (coarse) y = Math.max(y, Math.min(g.wheelY0 + SUSPENSION.compression, coarse(z[i]) + g.wheelRadius + 0.05));
      w.wheelY[side][i] = y;
    }
  }
  const speed = Math.max(Math.abs(t.trackSpeeds?.[0] ?? 0), Math.abs(t.trackSpeeds?.[1] ?? 0));
  const hatch = t.hatch ?? (t.aiming === undefined ? clamp(1 - (speed - 0.05) / 0.4, 0, 1) : t.aiming ? 1 : 0);
  const recoil = clamp(t.recoil, 0, 1);
  let h0 = 0, h1 = 0;
  if (ctx.utility.head === 'spring2') {
    // The tank-local velocity: v rotated by the conjugate of the tank's rotation.
    const v = t.velocity ?? ZERO3, q = t.rotation ?? IDENTITY_Q, w = q[3], qx = -q[0], qy = -q[1], qz = -q[2];
    const ix = w * v[0] + qy * v[2] - qz * v[1], iy = w * v[1] + qz * v[0] - qx * v[2], iz = w * v[2] + qx * v[1] - qy * v[0], iw = -qx * v[0] - qy * v[1] - qz * v[2];
    const localX = ix * w + iw * -qx + iy * -qz - iz * -qy, localZ = iz * w + iw * -qz + ix * -qy - iy * -qx;
    const ring = recoil * 0.9 * Math.sin(recoil * 18);
    const idle = antennaIdle(t.time ?? 0, ctx.utility.id === 'whip_short', ctx.utility.id === 'yagi');
    const limit = ctx.utility.id === 'yagi' ? .08 : WHIP.maxTilt;
    h0 = clamp(idle[0] - (t.yawVelocity ?? 0) * 0.08 - localX * 0.05, -limit, limit);
    h1 = clamp(idle[1] - localZ * 0.06 + ring * WHIP.maxTilt * 0.5, -limit, limit);
  } else if (ctx.utility.head === 'spin' || ctx.utility.id === 'point_defense' || ctx.utility.id === 'steam_sentinel') {
    const idle = utilityIdle(ctx.utility.id, t.time ?? 0); h0 = idle[0]; h1 = idle[1];
  } else if (ctx.utility.head === 'pitch') h0 = clamp(pitch, PERISCOPE_RANGE[0], PERISCOPE_RANGE[1]);
  w.head[0] = h0; w.head[1] = h1;
  w.phase[0] = t.trackPhases?.[0] ?? 0; w.phase[1] = t.trackPhases?.[1] ?? 0;
  const s = w.state;
  s.yaw = yaw; s.pitch = pitch; s.recoil = recoil; s.hatch = hatch;
  return s;
}
const ZERO3: readonly number[] = [0, 0, 0];
const IDENTITY_Q: Q4 = [0, 0, 0, 1];

/** The rig state a TankState implies (exported for the sandbox and tests); every call returns a new state. */
export function kitStateFromTank(a: KitAssembly, t: TankState & KitPresentationHints): RigState {
  const w = new StateWork(), s = stateInto(a, derived(a).ctx, t, w, false);
  return { yaw: s.yaw, pitch: s.pitch, recoil: s.recoil, wheelY: w.wheelY, phase: w.phase, hatch: s.hatch, head: w.head, ground: w.ground };
}

const scratch = new Map<string, RigPose>();
function rigScratch(ctx: KitContext): RigPose {
  let pose = scratch.get(ctx.gear.id);
  if (!pose) { pose = createRigPose(); scratch.set(ctx.gear.id, pose); }
  return pose;
}
const work = new StateWork();

function jointOut(out: KitPose, name: string): Float32Array {
  let m = out.joints.get(name);
  if (!m || m.length !== 16) { m = new Float32Array(16); out.joints.set(name, m); }
  return m;
}

/** Size `out` for `d` (arrays are replaced only when their size is wrong). */
function sizeOut(d: Derived, out: KitPose): void {
  if (out.linkInstances?.length !== d.links * INSTANCE_FLOATS) out.linkInstances = new Float32Array(d.links * INSTANCE_FLOATS);
  if (out.wheelInstances?.length !== d.wheels * INSTANCE_FLOATS) out.wheelInstances = new Float32Array(d.wheels * INSTANCE_FLOATS);
  if (!(out.joints instanceof Map)) out.joints = new Map();
}
function writeJoints(d: Derived, pose: RigPose, out: KitPose): void {
  for (let i = 0; i < d.rigid.length; i++) jointOut(out, d.rigid[i][1]).set(pose.joints[d.rigid[i][0]]);
}
function writeInstances(d: Derived, pose: RigPose, out: KitPose): void {
  // Index loops: no per-call array copies.
  for (let i = 0; i < d.links; i++) writeInstance(out.linkInstances, i, pose.instances.links[i]);
  const counts = gearRig(d.ctx.gear).layout.counts;
  let k = 0;
  for (const g of WHEEL_BUFFER_ORDER) { const list = pose.instances[g]; for (let i = 0; i < counts[g]; i++) writeInstance(out.wheelInstances, k++, list[i]); }
}

/** Write a rig pose into a KitPose (joints and both instance buffers). */
export function writeKitPose(a: KitAssembly, pose: RigPose, out: KitPose): void {
  const d = derived(a);
  sizeOut(d, out);
  writeJoints(d, pose, out);
  writeInstances(d, pose, out);
}

function sidesOf(w: StateWork): [SideInput, SideInput] {
  for (let side = 0; side < 2; side++) { const s = w.sides[side]; s.phase = w.phase[side]; s.ground = w.ground[side]; }
  return w.sides;
}

/** Pose `a` for tank state `t` into `out` (arrays are reused, or replaced when their size is wrong). */
export function poseKit(a: KitAssembly, t: TankState, out: KitPose): void {
  const d = derived(a), ctx = d.ctx, pose = rigScratch(ctx);
  const s = stateInto(a, ctx, t as TankState & KitPresentationHints, work, true);
  poseJoints(ctx, s, pose.joints);
  gearRig(ctx.gear).pose(ctx, sidesOf(work), pose.instances);
  writeKitPose(a, pose, out);
}

/** A pose key being built (`next`) and the last one; `same` compares their bits, so ±0 and NaNs never pass as equal. */
class Keys {
  next = new Float64Array(64);
  private next32 = new Uint32Array(this.next.buffer);
  private last32 = new Uint32Array(128);
  private lastLength = -1;
  reserve(at: number, n: number): number {
    if (at + n > this.next.length) {
      const grown = new Float64Array((at + n) * 2);
      grown.set(this.next.subarray(0, at));
      this.next = grown; this.next32 = new Uint32Array(grown.buffer);
    }
    return at;
  }
  /** Whether next[0..n) equals the last key; the next key becomes the last either way. */
  same(n: number): boolean {
    const a = this.next32, words = n * 2;
    let same = n === this.lastLength;
    for (let i = 0; same && i < words; i++) if (a[i] !== this.last32[i]) same = false;
    if (!same) {
      if (this.last32.length < words) this.last32 = new Uint32Array(a.length);
      const b = this.last32;
      for (let i = 0; i < words; i++) b[i] = a[i];
      this.lastLength = n;
    }
    return same;
  }
}

/** Running gear posed by the engine (rust/terrain-core/src/rig.rs) into the same instance buffers. */
export interface NativeGear {
  /** A rig for gear words (`nativeGearWords`), or 0 when the engine refuses them. */
  create(words: readonly number[]): number;
  pose(rig: number, words: readonly number[], links: Float32Array, wheels: Float32Array): void;
}
let nativeGear: NativeGear | undefined;
const nativeRigs = new Map<string, number>();
/** Pose running gear in this engine (undefined: in TypeScript). Rigs are per engine, so a new engine starts afresh. */
export function setNativeGear(gear: NativeGear | undefined): void { nativeGear = gear; nativeRigs.clear(); }
/** Who poses running gear now: 'engine' or 'typescript' (telemetry). */
export const runningGearPoser = (): 'engine' | 'typescript' => nativeGear ? 'engine' : 'typescript';
const gearInput: number[] = [];
/** The running gear of `work` posed by the engine into `out`; false when there is no engine rig for it. */
function poseNativeGear(ctx: KitContext, d: Derived, out: KitPose): boolean {
  const gear = nativeGear;
  if (!gear) return false;
  let rig = nativeRigs.get(ctx.gear.id);
  if (rig === undefined) {
    try { rig = gear.create(nativeGearWords(ctx.gear)); } catch { rig = 0; }
    nativeRigs.set(ctx.gear.id, rig);
  }
  if (!rig) return false;
  const { armX, rockX } = memberSlabX(ctx), w = gearInput;
  w.length = 0; w.push(armX, rockX);
  for (let side = 0; side < 2; side++) { const y = work.wheelY[side]; w.push(y[0], y[1], y[2], y[3], work.phase[side]); work.profiles[side].words(w); }
  sizeOut(d, out);
  try { gear.pose(rig, w, out.linkInstances, out.wheelInstances); return true; }
  catch (error) { console.error('[kit] engine running gear failed; posing in TypeScript', error); setNativeGear(undefined); return false; }
}

/** `KitPoser.update` result bits. */
export const POSED_JOINTS = 1, POSED_GEAR = 2;

/** A KitPose with the inputs it was last posed with. */
export class KitPoser {
  readonly pose: KitPose;
  private readonly joints = new Keys();
  private readonly gear = new Keys();

  constructor(readonly assembly: KitAssembly) { this.pose = createKitPose(assembly); }

  /**
   * Pose for `t` exactly as `poseKit`; joints and running gear whose inputs equal the last pose's keep their matrices.
   * Returns POSED_JOINTS | POSED_GEAR for what was rewritten.
   */
  update(t: TankState & KitPresentationHints): number {
    const a = this.assembly, d = derived(a), ctx = d.ctx, out = this.pose;
    const s = stateInto(a, ctx, t, work, true);
    let posed = 0;
    const jk = this.joints, jn = jk.reserve(0, 6);
    jk.next[jn] = s.yaw; jk.next[jn + 1] = s.pitch; jk.next[jn + 2] = s.recoil; jk.next[jn + 3] = s.hatch; jk.next[jn + 4] = work.head[0]; jk.next[jn + 5] = work.head[1];
    const gk = this.gear;
    let at = gk.reserve(0, 10);
    for (let side = 0; side < 2; side++) for (let i = 0; i < 4; i++) gk.next[at++] = work.wheelY[side][i];
    gk.next[at++] = work.phase[0]; gk.next[at++] = work.phase[1];
    at = work.profiles[0].key(gk, at);
    at = work.profiles[1].key(gk, at);
    const pose = rigScratch(ctx);
    if (!jk.same(6)) {
      poseJoints(ctx, s, pose.joints);
      writeJoints(d, pose, out);
      posed |= POSED_JOINTS;
    }
    if (!gk.same(at)) {
      if (!poseNativeGear(ctx, d, out)) {
        gearRig(ctx.gear).pose(ctx, sidesOf(work), pose.instances);
        writeInstances(d, pose, out);
      }
      posed |= POSED_GEAR;
    }
    return posed;
  }
}
