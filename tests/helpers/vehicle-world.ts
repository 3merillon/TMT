/** Headless vehicle scenarios on the real resident chassis (W1-PHY): planes, ramps and trimesh craters are staged
 * as static terrain through `StructuralPhysics.stage` (the game's static-terrain path, so they carry the terrain
 * collider flags and collision group), and tanks run through `ResidentTanks` exactly as `ResidentGameTerrain.stepTanks`
 * does: beforeStep → physics.step → afterStep. Every dimension a scenario needs comes from the kit assembly
 * (`assembleKit(tankKit(t))`), so the suite runs unchanged against later kit versions. W2-WATER reuses it. */
import type { DriveInput, Loadout, Q4, TankState, V3 } from '../../src/game/contracts';
import { ResidentTanks } from '../../src/game/resident-tanks';
import { StructuralPhysics } from '../../src/game/structural-physics';
import { testPhysics } from './native-physics';
import { craterProfile } from '../../src/game/rules/crater';
import { assembleKit, tankKit, type KitAssembly, type KitLoadoutIdsLike } from '../../src/game/kit';
import { kitWheelOffsets } from '../../src/game/kit/assembly';
import type { BodyCandidate } from '../../src/gpu/terrain/contracts';
import type { LiquidQuery } from '../../src/game/liquids';

/** A planet centre far below the origin: gravity is uniform −Y to within 1e-9 over a scenario. */
export const FLAT_PLANET_CENTER: V3 = [0, -100000, 0];
export const TICK = 1 / 60;
export const DEG = Math.PI / 180;

/** The 12 legacy-mapped loadouts (plan Appendix A), including the over-budget grip/rail/heavy build. */
export const LEGACY_LOADOUTS: readonly Loadout[] = (['scout', 'grip'] as const).flatMap(tracks => (['mortar', 'cannon', 'rail'] as const)
  .flatMap(barrel => (['light', 'heavy'] as const).map(armor => Object.freeze({ tracks, barrel, armor }))));
export const DEFAULT: Loadout = LEGACY_LOADOUTS[0];
export const HEAVY: Loadout = { tracks: 'grip', barrel: 'cannon', armor: 'heavy' };
export const loadoutName = (l: Loadout) => `${l.tracks}/${l.barrel}/${l.armor}`;

// ---- small pure math (tests only; the sim has its own) ------------------------------------------------------------------
export const qmul = (a: Q4, b: Q4): Q4 => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const axisAngle = (axis: V3, angle: number): Q4 => {
  const n = Math.hypot(...axis), s = Math.sin(angle / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};
export function rotateV(v: V3, q: Q4): V3 {
  const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Pitch (nose up positive) and roll against `ref`, plus up·ref; degrees. */
export function tilt(t: Pick<TankState, 'rotation'>, ref: V3 = [0, 1, 0]): { pitch: number; roll: number; upDot: number } {
  const clampUnit = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    pitch: Math.asin(clampUnit(dot3(rotateV([0, 0, 1], t.rotation), ref))) / DEG,
    roll: Math.asin(clampUnit(dot3(rotateV([1, 0, 0], t.rotation), ref))) / DEG,
    upDot: dot3(rotateV([0, 1, 0], t.rotation), ref),
  };
}
/** Yaw rate about the tank's up axis (rad/s; driver-right negative), from the synced TankState. */
export const yawRate = (t: TankState) => t.yawVelocity;
export const horizontal = (p: V3) => Math.hypot(p[0], p[2]);

export interface TankOptions { loadout?: Loadout; kit?: KitLoadoutIdsLike; position: V3; rotation?: Q4; velocity?: V3 }
export function makeTank(id: number, o: TankOptions): TankState {
  const tank: TankState = {
    id: id as TankState['id'], position: [...o.position], rotation: [...(o.rotation ?? [0, 0, 0, 1])], velocity: [...(o.velocity ?? [0, 0, 0])], heading: 0, turretYaw: 0, barrelPitch: .75,
    power: .5, health: 100, charge: 1, movement: 7, recoil: 0, suspension: [.5, .5, .5, .5], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0],
    trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [0, 0], yawVelocity: 0, wheelSuspension: Array(8).fill(.5), treadContacts: Array(18).fill(-.5),
    loadout: { ...(o.loadout ?? DEFAULT) },
  };
  if (o.kit) tank.kit = { ...o.kit };
  return tank;
}
export const kitOf = (t: TankState): KitAssembly => assembleKit(tankKit(t));
/** Height of the tank root above flat ground at rest (the kit's support plane), e.g. 0.5 for kit v1. */
export const rideHeight = (t: TankState) => -kitWheelOffsets(kitOf(t))[0][1];

export interface Crater { depth: number; rim: number; rimSlopeDeg: number; radius: number; lift: number }

export class VehicleWorld {
  readonly tanks: TankState[] = [];
  readonly bridge: ResidentTanks;
  private readonly statics: BodyCandidate[] = [];
  private readonly inputs: DriveInput[] = [];
  private constructor(readonly physics: StructuralPhysics, liquid?: LiquidQuery) { this.bridge = new ResidentTanks(physics, liquid); }
  static async create(planetCenter: V3 = FLAT_PLANET_CENTER, liquid?: LiquidQuery): Promise<VehicleWorld> { return new VehicleWorld(await testPhysics(planetCenter), liquid); }

  /** Stage one more static terrain trimesh (all statics are re-staged together; unchanged ones are kept). */
  addTrimesh(vertices: ArrayLike<number>, indices: ArrayLike<number>): void {
    this.statics.push({ id: -1 - this.statics.length, regions: [], center: [0, 0, 0],
      colliders: [{ kind: 'trimesh', regionIds: [], volume: 0, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) }] });
    this.physics.stage(this.statics, []).commit();
  }
  /** A height field y = f(x, z) over a square grid, as one static trimesh (upward-facing triangles). */
  addHeightfield(f: (x: number, z: number) => number, o: { size?: number; cells?: number; center?: [number, number] } = {}): void {
    const size = o.size ?? 18, n = o.cells ?? 120, [cx, cz] = o.center ?? [0, 0], h = size / n, positions: number[] = [], indices: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const x = cx - size / 2 + i * h, z = cz - size / 2 + j * h; positions.push(x, f(x, z), z); }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
    this.addTrimesh(positions, indices);
  }
  /** A large plane through the origin, tilted about Z by `slopeDeg` (downhill is +X); returns its normal and the
   * cross-slope tank orientation (facing +Z). */
  addPlane(o: { slopeDeg?: number; size?: number } = {}): { normal: V3; rotation: Q4 } {
    const slope = (o.slopeDeg ?? 0) * DEG, s = (o.size ?? 400) / 2, q = axisAngle([0, 0, 1], slope);
    const corners = ([[-s, -s], [s, -s], [s, s], [-s, s]] as const).flatMap(([x, z]) => rotateV([x, 0, z], q));
    this.addTrimesh(corners, [0, 2, 1, 0, 3, 2]);
    return { normal: rotateV([0, 1, 0], q), rotation: q };
  }
  /** Flat ground, then a pitch-up ramp of `angleDeg` over `length` along +Z from z = start, then a plateau. */
  addRamp(angleDeg: number, o: { start?: number; length?: number; width?: number } = {}): { top: number; end: number } {
    const start = o.start ?? 3, length = o.length ?? 5, w = (o.width ?? 40) / 2, angle = angleDeg * DEG;
    const top = Math.sin(angle) * length, end = start + Math.cos(angle) * length;
    const profile: [number, number][] = [[-100, 0], [start, 0], [end, top], [end + 100, top]], positions: number[] = [], indices: number[] = [];
    for (const [z, y] of profile) positions.push(-w, y, z, w, y, z);
    for (let k = 0; k < profile.length - 1; k++) { const a = 2 * k; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    this.addTrimesh(positions, indices);
    return { top, end };
  }
  /** A spherical crater in flat ground at the origin: sphere of `radius` whose centre sits `lift` above the surface. */
  addCrater(radius: number, lift: number, o: { size?: number; cells?: number } = {}): Crater {
    const rim2 = radius * radius - lift * lift;
    this.addHeightfield((x, z) => { const r2 = x * x + z * z; return r2 < rim2 ? Math.min(0, lift - Math.sqrt(radius * radius - r2)) : 0; }, { size: o.size ?? 18, cells: o.cells ?? 120 });
    return { depth: radius - lift, rim: Math.sqrt(rim2), rimSlopeDeg: Math.atan2(Math.sqrt(rim2), lift) / DEG, radius, lift };
  }
  /** The game's impact crater (`craterProfile`, plan §4.3) for a blast of `blastRadius` on flat ground at the origin. */
  addLiftedCrater(blastRadius: number): Crater {
    const cut = craterProfile([0, 0, 0], [0, 1, 0], blastRadius);
    return this.addCrater(cut.radius, cut.center[1]);
  }

  addTank(o: TankOptions): TankState { const tank = makeTank(this.tanks.length, o); this.tanks.push(tank); return tank; }
  /** One fixed tick: inputs by tank id (a single input applies to tank 0). */
  step(input?: DriveInput | readonly DriveInput[]): void {
    for (let i = 0; i < this.tanks.length; i++) this.inputs[i] = Array.isArray(input) ? (input as DriveInput[])[i] ?? IDLE : i === 0 && input ? input as DriveInput : IDLE;
    this.bridge.beforeStep(this.tanks, this.inputs, TICK); this.physics.step(); this.bridge.afterStep(this.tanks, TICK);
  }
  run(ticks: number, input: (tick: number) => DriveInput | readonly DriveInput[] = () => IDLE, each?: (tick: number) => void): void {
    for (let i = 0; i < ticks; i++) { this.step(input(i)); each?.(i); }
  }
  dispose(): void { this.physics.dispose(); }
}
export const IDLE: DriveInput = Object.freeze({ throttle: 0, steer: 0 });

/** Build a world, run `body`, always dispose. */
export async function withWorld<T>(body: (w: VehicleWorld) => T | Promise<T>, planetCenter: V3 = FLAT_PLANET_CENTER): Promise<T> {
  const world = await VehicleWorld.create(planetCenter);
  try { return await body(world); } finally { world.dispose(); }
}
/** A tank resting on flat ground at the origin (root 0.1 above its ride height), facing +Z. */
export function flatTank(w: VehicleWorld, loadout: Loadout = DEFAULT, position: V3 = [0, 0, 0], rotation: Q4 = [0, 0, 0, 1]): TankState {
  const tank = w.addTank({ loadout, position: [0, 0, 0], rotation });
  const lift = rideHeight(tank) + .1, up = rotateV([0, 1, 0], rotation);
  tank.position = [position[0] + up[0] * lift, position[1] + up[1] * lift, position[2] + up[2] * lift];
  return tank;
}

// ---- drivability scenarios shared by tests/vehicle-drivability.test.ts ------------------------------------------------
const FULL: DriveInput = Object.freeze({ throttle: 1, steer: 0 });
const massOf = (t: TankState) => kitOf(t).massProps.mass;
const round = (v: number, d = 2) => Number.isFinite(v) ? +v.toFixed(d) : v;

/** Settle 2 s, full throttle 2 s (worst |pitch|, time to 90 % of top speed), release 1.5 s (worst |pitch| while braking). */
export async function launchAndBrake(loadout: Loadout) {
  return withWorld(w => {
    w.addPlane(); const t = flatTank(w, loadout);
    w.run(120);
    const speed = kitOf(t).stats.speed;
    let launchPitch = 0, t90 = NaN, brakePitch = 0;
    w.run(120, () => FULL, i => { launchPitch = Math.max(launchPitch, Math.abs(tilt(t).pitch)); if (Number.isNaN(t90) && t.velocity[2] > .9 * speed) t90 = (i + 1) * TICK; });
    const z0 = t.position[2];
    w.run(90, () => IDLE, () => { brakePitch = Math.max(brakePitch, Math.abs(tilt(t).pitch)); });
    return { launchPitch: round(launchPitch, 1), brakePitch: round(brakePitch, 1), t90: round(t90), stop: round(t.position[2] - z0) };
  });
}
/** Drive at full throttle onto a ramp of `angleDeg` (5 u long, from z = 3) and onto its plateau. */
export async function rampClimb(loadout: Loadout, angleDeg: number, ticks = 420) {
  return withWorld(w => {
    const ramp = w.addRamp(angleDeg), t = flatTank(w, loadout);
    w.run(60);
    let maxPitch = 0, flipped = false, topAt = NaN;
    w.run(ticks, () => FULL, i => {
      const a = tilt(t); maxPitch = Math.max(maxPitch, a.pitch); if (a.upDot < .1) flipped = true;
      if (Number.isNaN(topAt) && t.position[2] > ramp.end + 1 && t.position[1] > ramp.top) topAt = (i + 1) * TICK;
    });
    return { maxPitch: round(maxPitch, 1), flipped, topAt: round(topAt) };
  });
}
/** A sideways shove of `speed` u/s (through TankState.velocity, as blasts and recoil arrive) on flat ground. */
export async function sideSlide(loadout: Loadout, speed: number) {
  return withWorld(w => {
    w.addPlane(); const t = flatTank(w, loadout);
    w.run(120);
    t.velocity = [t.velocity[0] + speed, t.velocity[1], t.velocity[2]];
    let maxRoll = 0;
    w.run(240, () => IDLE, () => { maxRoll = Math.max(maxRoll, Math.abs(tilt(t).roll)); });
    return { maxRoll: round(maxRoll, 1), upDot: round(tilt(t).upDot, 3) };
  });
}
/** Largest cross-slope (5° steps from 30°) on which a parked tank stays wheels-down for 4 s; Infinity if ≥ 75°. */
export async function crossSlopeTip(loadout: Loadout, from = 30, to = 75) {
  for (let angle = from; angle <= to; angle += 5) {
    const ok = await withWorld(w => {
      const { normal, rotation } = w.addPlane({ slopeDeg: angle }), t = w.addTank({ loadout, position: [0, 0, 0], rotation });
      const lift = rideHeight(t) + .05; t.position = [normal[0] * lift, normal[1] * lift, normal[2] * lift];
      w.run(240);
      return tilt(t, normal).upDot > .8;
    });
    if (!ok) return angle;
  }
  return Infinity;
}
/** The in-game blast: exposure 1 gives Δv = 25 / mass along normalize(1, 0.5, 0), at the COM. */
export async function blast(loadout: Loadout) {
  return withWorld(w => {
    w.addPlane(); const t = flatTank(w, loadout);
    w.run(120);
    const dv = 25 / massOf(t), n = Math.hypot(1, .5);
    t.velocity = [t.velocity[0] + dv / n, t.velocity[1] + dv * .5 / n, t.velocity[2]];
    let maxRoll = 0;
    w.run(240, () => IDLE, () => { maxRoll = Math.max(maxRoll, Math.abs(tilt(t).roll)); });
    return { maxRoll: round(maxRoll, 1), upDot: round(tilt(t).upDot, 3) };
  });
}
/** Neutral pivot (full steer, no throttle) for 1.5 s: mean |yaw rate| over the last 0.5 s. */
export async function pivot(loadout: Loadout, steer = 1) {
  return withWorld(w => {
    w.addPlane(); const t = flatTank(w, loadout);
    w.run(60);
    let sum = 0;
    w.run(90, () => ({ throttle: 0, steer }), i => { if (i >= 60) sum += t.yawVelocity; });
    return { yawRate: round(sum / 30), maxRoll: round(Math.abs(tilt(t).roll), 1) };
  });
}
/** Full throttle 1 s, then full throttle + full steer 2 s: mean |yaw rate| over the last 0.5 s and the worst roll. */
export async function drivingTurn(loadout: Loadout, steer = 1) {
  return withWorld(w => {
    w.addPlane(); const t = flatTank(w, loadout);
    w.run(60); w.run(60, () => FULL);
    let sum = 0, maxRoll = 0;
    w.run(120, () => ({ throttle: 1, steer }), i => { maxRoll = Math.max(maxRoll, Math.abs(tilt(t).roll)); if (i >= 90) sum += t.yawVelocity; });
    return { yawRate: round(sum / 30), maxRoll: round(maxRoll, 1) };
  });
}
/** Start at the bottom of a crater and drive out at full throttle: the time until the tank is 1 u beyond the rim
 * and back at surface level (NaN if trapped), and whether it ever flipped. */
export async function craterEscape(loadout: Loadout, crater: (w: VehicleWorld) => Crater, ticks = 600, idle = 0) {
  return withWorld(w => {
    const c = crater(w), t = w.addTank({ loadout, position: [0, 0, 0] });
    t.position = [0, -c.depth + rideHeight(t) + .12, 0];
    w.run(120);
    let escapedAt = NaN, flipped = false, maxPitch = 0, minUp = 1;
    w.run(ticks, () => FULL, i => {
      const a = tilt(t); if (a.upDot < .1) flipped = true; maxPitch = Math.max(maxPitch, Math.abs(a.pitch)); minUp = Math.min(minUp, a.upDot);
      if (Number.isNaN(escapedAt) && horizontal(t.position) > c.rim + 1 && t.position[1] > -.1) escapedAt = (i + 1) * TICK;
    });
    w.run(idle, undefined, () => { minUp = Math.min(minUp, tilt(t).upDot); });
    return { escapedAt: round(escapedAt), flipped, maxPitch: round(maxPitch, 1), minUp: round(minUp, 3), rimSlopeDeg: round(c.rimSlopeDeg, 1), depth: round(c.depth),
      finalUpDot: round(tilt(t).upDot, 3) };
  });
}
/** A tank dropped onto flat ground in `rotation` (e.g. upside down), left to settle for 1 s; then `selfRight` is
 * pressed for one tick (or never, with `press = false`). Returns the time from the press (or from the drop) until the
 * tank is wheels-down and at rest, NaN if it never gets there within `ticks`. */
export async function selfRight(loadout: Loadout, rotation: Q4, o: { press?: boolean; ticks?: number } = {}) {
  return withWorld(w => {
    w.addPlane(); const t = w.addTank({ loadout, position: [0, 1.4, 0], rotation });
    w.run(60);
    const settled = tilt(t).upDot;
    let uprightAt = NaN, maxHeight = 0;
    w.run(o.ticks ?? 360, i => ({ throttle: 0, steer: 0, selfRight: o.press !== false && i === 0 }), i => {
      maxHeight = Math.max(maxHeight, t.position[1]);
      const resting = Math.hypot(...t.velocity) < .3 && Math.abs(t.yawVelocity) < .5;
      if (tilt(t).upDot > .95 && resting && t.trackContact[0] > .2 && t.trackContact[1] > .2) { if (Number.isNaN(uprightAt)) uprightAt = (i + 1) * TICK; }
      else uprightAt = NaN;
    });
    return { settledUpDot: round(settled, 3), uprightAt: round(uprightAt), finalUpDot: round(tilt(t).upDot, 3), maxHeight: round(maxHeight) };
  });
}
/** Released 3 u above flat ground with a roll of `rollDeg` and no input: the roll when the tracks first touch down. */
export async function airDrop(loadout: Loadout, rollDeg: number) {
  return withWorld(w => {
    w.addPlane(); const t = w.addTank({ loadout, position: [0, 3 + rideHeight({ ...makeTank(0, { loadout, position: [0, 0, 0] }) }), 0], rotation: axisAngle([0, 0, 1], rollDeg * DEG) });
    let landingRoll = NaN;
    w.run(180, () => IDLE, () => { if (Number.isNaN(landingRoll) && t.trackContact[0] + t.trackContact[1] > 0) landingRoll = Math.abs(tilt(t).roll); });
    return { landingRoll: round(landingRoll, 1), finalUpDot: round(tilt(t).upDot, 3) };
  });
}
/** A static axis-aligned box (closed trimesh) from `min` to `max`. */
export function addBox(w: VehicleWorld, min: V3, max: V3): void {
  const [a, b, c] = min, [d, e, f] = max;
  const v = [a, b, c, d, b, c, d, e, c, a, e, c, a, b, f, d, b, f, d, e, f, a, e, f];
  w.addTrimesh(v, [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
}
/** Full throttle into a vertical wall 3 u ahead for 4 s, then 2 s idle: worst pitch and up·Y, the deepest penetration
 * into static geometry (tunnelling), and the final attitude. */
export async function wallPress(loadout: Loadout) {
  return withWorld(w => {
    w.addPlane(); addBox(w, [-10, -1, 3], [10, 3, 5]); const t = flatTank(w, loadout);
    w.run(30);
    let maxPitch = 0, minUp = 1, deepest = 0, reached = -Infinity;
    w.run(240, () => FULL, () => {
      const a = tilt(t); maxPitch = Math.max(maxPitch, Math.abs(a.pitch)); minUp = Math.min(minUp, a.upDot);
      deepest = Math.max(deepest, staticPenetration(w, t)); reached = Math.max(reached, t.position[2]);
    });
    w.run(120);
    return { maxPitch: round(maxPitch, 1), minUp: round(minUp, 3), penetration: round(deepest, 3), reached: round(reached), finalUpDot: round(tilt(t).upDot, 3), finalSpeed: round(Math.hypot(...t.velocity), 3) };
  });
}
/** The deepest penetration (≥ 0) of a tank's colliders into fixed (static) bodies, from Rapier's contact manifolds. */
export function staticPenetration(w: VehicleWorld, tank: TankState): number {
  const body = w.bridge.bodyOf(tank.id), world = w.physics.world;
  let deepest = 0;
  if (body) for (let i = 0; i < body.numColliders(); i++) {
    const collider = body.collider(i);
    world.contactPairsWith(collider, other => {
      if (!other.parent()?.isFixed()) return;
      world.contactPair(collider, other, manifold => { for (let k = 0; k < manifold.numContacts(); k++) deepest = Math.max(deepest, -manifold.contactDist(k)); });
    });
  }
  return deepest;
}
/** `pusher` drives at full throttle nose-to-nose into an idle `pushed` tank for 3 s (optionally pinning it against a
 * wall), then reverses for 2.5 s: how far each moved along +Z, the worst attitude, the pushed tank's deepest penetration
 * into static geometry, and how far the pusher backed away. */
export async function pushContest(pusher: Loadout, pushed: Loadout, o: { wallAt?: number } = {}) {
  return withWorld(w => {
    w.addPlane();
    if (o.wallAt !== undefined) addBox(w, [-10, -1, o.wallAt], [10, 3, o.wallAt + 2]);
    const a = flatTank(w, pusher, [0, 0, 0]), b = flatTank(w, pushed, [0, 0, 2.2], axisAngle([0, 1, 0], Math.PI));
    w.run(60);
    const a0 = a.position[2], b0 = b.position[2];
    let minUp = 1, intoWall = 0;
    w.run(180, () => [FULL, IDLE], () => { minUp = Math.min(minUp, tilt(a).upDot, tilt(b).upDot); intoWall = Math.max(intoWall, staticPenetration(w, b)); });
    const pushedAt = a.position[2];
    w.run(150, () => [{ throttle: -1, steer: 0 }, IDLE], () => { minUp = Math.min(minUp, tilt(a).upDot, tilt(b).upDot); });
    return { pusherMoved: round(pushedAt - a0), pushedMoved: round(b.position[2] - b0), gap: round(b.position[2] - a.position[2]), minUp: round(minUp, 3),
      intoWall: round(intoWall, 3), reversed: round(pushedAt - a.position[2]) };
  });
}
/** \`rammer\` accelerates from 7 u away at full throttle into an idle \`target\` facing it, and keeps pushing for 4 s:
 * both tanks' worst pitch, whether the rammer ends perched on the target, and both final attitudes. */
export async function ram(rammer: Loadout, target: Loadout) {
  return withWorld(w => {
    w.addPlane();
    const a = flatTank(w, rammer, [0, 0, 0]), b = flatTank(w, target, [0, 0, 7], axisAngle([0, 1, 0], Math.PI));
    w.run(30);
    let maxPitch = 0, targetPitch = 0, minUp = 1;
    w.run(300, () => [FULL, IDLE], () => {
      maxPitch = Math.max(maxPitch, Math.abs(tilt(a).pitch)); targetPitch = Math.max(targetPitch, Math.abs(tilt(b).pitch)); minUp = Math.min(minUp, tilt(a).upDot, tilt(b).upDot);
    });
    const perched = a.position[1] - rideHeight(a) > .25;
    w.run(120);
    return { maxPitch: round(maxPitch, 1), targetPitch: round(targetPitch, 1), minUp: round(minUp, 3), perched, finalPitch: round(Math.abs(tilt(a).pitch), 1),
      finalUp: [round(tilt(a).upDot, 3), round(tilt(b).upDot, 3)] };
  });
}
/** The brief's capture opening on flat ground: `rammer` drives at full throttle for 3 s into an idle `target` 7 u ahead
 * (ramming it at top speed, then pressing nose to nose), then holds full throttle with full `steer` for 2 s. Returns
 * the centre distance when the turn starts, the rammer's net heading change over the turn (rad, left positive), the
 * target's, both tanks' worst pitch and the worst up·Y of either. */
export async function pushTurn(rammer: Loadout, target: Loadout, steer = -1) {
  return withWorld(w => {
    w.addPlane();
    const a = flatTank(w, rammer, [0, 0, 0]), b = flatTank(w, target, [0, 0, 7], axisAngle([0, 1, 0], Math.PI));
    w.run(30);
    let maxPitch = 0, targetPitch = 0, minUp = 1;
    const watch = () => { maxPitch = Math.max(maxPitch, Math.abs(tilt(a).pitch)); targetPitch = Math.max(targetPitch, Math.abs(tilt(b).pitch)); minUp = Math.min(minUp, tilt(a).upDot, tilt(b).upDot); };
    w.run(180, () => [FULL, IDLE], watch);
    const pressed = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
    let turned = 0, targetTurned = 0, ha = a.heading, hb = b.heading;
    const wrap = (d: number) => Math.atan2(Math.sin(d), Math.cos(d));
    w.run(120, () => [{ throttle: 1, steer }, IDLE], () => { watch(); turned += wrap(a.heading - ha); targetTurned += wrap(b.heading - hb); ha = a.heading; hb = b.heading; });
    return { pressed: round(pressed), turned: round(turned), targetTurned: round(targetTurned), maxPitch: round(maxPitch, 1), targetPitch: round(targetPitch, 1), minUp: round(minUp, 3) };
  });
}
