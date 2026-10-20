/**
 * `assembleKit` v2 (W1-KIT): every legal Wave-1 loadout assembles from the parametric part modules.
 *
 * - frames: the shared ring socket, the turret's trunnion (at its front face), the muzzle (cradle frame, never
 *   recoils), the shared sensor, the hull's exhaust outlets (+Z out of each pipe) and the turret's utility socket.
 * - running: 4 physics stations per side (TankState.wheelSuspension keeps 8 entries), sprocket, idler, return
 *   rollers, tensioner travel (±0.04 → 0.08 range), the highest top run and the tread-contact stations.
 * - proxies: static boxes in their joint frames. Indices 0–7 keep the kit v1 layout (hull, glacis armour,
 *   fender +X, fender −X, turret, mantlet, sleeve, tube) so legacy readers (tank-collision) keep working;
 *   extra boxes follow. The running-gear envelope and end-gear boxes stay pose-dependent (kitRunningEnvelope).
 * - massProps: from part mass boxes (mass.ts). pitchLimits: pitch.ts. stats: Experience §1.11. Inertia and top
 *   speed keep kit v1's proportions for the vehicle model (handling.ts, the R6 fallback).
 * Assemblies are deep-frozen and cached by key. The non-contract helpers at the bottom serve legacy callers.
 * Pure: no three, no DOM, no clocks.
 */
import type { Loadout, Q4, V3 } from '../contracts';
import { kitContext, kitGeometry } from './build';
import { kitLoadoutFromLegacy, validateKitLoadout } from './catalog';
import { BUMP_STOP, SUPPORT_GROUND_Y, TREAD_STATION_OVERHANG } from './dimensions';
import type { Convex } from './geometry/convex';
import { SPEED_SCALE } from './handling';
import { massProperties } from './mass';
import { hasReactiveArmor, REACTIVE_ARMOR } from './armor';
import { bastionExhaustPath } from './parts/hulls/bastion';
import { fenderReach, fenderSpan, glacisSlope, glacisY, hullFrontProfile } from './parts/hulls/common';
import { skiffExhaustPath } from './parts/hulls/skiff';
import { stackPath } from './parts/hulls/warden';
import { WHIP } from './parts/utilities/antenna';
import { PERISCOPE_RANGE } from './parts/utilities/periscope';
import type { KitContext, RigidGroup } from './parts/types';
import { evalPitchLimits, pitchTable } from './pitch';
import { BELT_SHOE, SUSPENSION, gearRig } from './running';
import { BELLY_Y, DECK_Y, RING_FRAME, SENSOR_POSITION, SPONSON_UNDERSIDE } from './sockets';
import type { Frame, HullBox, JointDef, KitAssembly, KitLoadout, KitPartStats, WheelStation } from './types';

const IDENTITY: Q4 = [0, 0, 0, 1];
const frame = (position: Readonly<V3>, rotation: Readonly<Q4> = IDENTITY): Frame => ({ position: [...position] as V3, rotation: [...rotation] as Q4 });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !ArrayBuffer.isView(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Stable cache key: `hull.runningGear.turret.weapon.utility`. */
export function kitKey(l: KitLoadout): string {
  return `${l.hull}.${l.runningGear}.${l.turret}.${l.weapon}.${l.utility}${l.armor !== undefined && l.armor !== 'standard' ? `.${l.armor}` : ''}`;
}

/**
 * Index of each v1-layout proxy in `KitAssembly.proxies` (hull/armour/fenders in the hull frame, the turret
 * box in the turret frame, the mantlet/sleeve/tube boxes in the cradle frame).
 */
export const V1_PROXY = Object.freeze({ hull: 0, armor: 1, fender: Object.freeze([2, 3] as const), turret: 4, breech: 5, sleeve: 6, shaft: 7 });

const cache = new Map<string, KitAssembly>();

/** Assemble (and cache by key) a kit loadout. Throws KitError on unknown ids or socket mismatches. */
export function assembleKit(l: KitLoadout): KitAssembly {
  const key = l !== null && typeof l === 'object' ? kitKey(l) : '';
  const cached = cache.get(key);
  if (cached) return cached;
  const loadout = validateKitLoadout(l);
  const assembly = deepFreeze(build(kitKey(loadout), loadout));
  cache.set(key, assembly);
  return assembly;
}

/** v2 stats (Experience §1.11): mass = Σ parts, mobility = √(11/mass), weapon ballistics as kit v1. The top speed
 * carries the R6 fallback scale (handling.ts). */
export function kitStats(ctx: KitContext): KitPartStats {
  const { hull, gear, turret, weapon, utility } = ctx;
  const reactive = hasReactiveArmor(ctx.loadout);
  const mass = hull.stats.mass + gear.stats.mass + turret.stats.mass + weapon.stats.mass + utility.stats.mass + (reactive ? REACTIVE_ARMOR.mass : 0);
  const mobility = Math.sqrt(11 / mass);
  return {
    cost: hull.stats.cost + gear.stats.cost + turret.stats.cost + weapon.stats.cost + utility.stats.cost + (reactive ? REACTIVE_ARMOR.cost : 0),
    mass,
    hp: (hull.stats.hp ?? 0) + turret.hpBonus,
    tempo: (hull.stats.tempo ?? 1) * (turret.stats.tempo ?? 1) * (weapon.stats.tempo ?? 1),
    speed: (gear.stats.speed ?? 0) * mobility * SPEED_SCALE,
    fuel: (gear.stats.fuel ?? 0) * mobility * hull.fuelMul,
    climbDeg: gear.stats.climbDeg ?? 0,
    traction: gear.stats.traction ?? 0,
    lateralTraction: gear.stats.lateralTraction ?? 0,
    minSpeed: weapon.stats.minSpeed ?? 0,
    maxSpeed: weapon.stats.maxSpeed ?? 0,
    blastRadius: weapon.stats.blastRadius ?? 0,
    damage: weapon.stats.damage ?? 0,
    recoil: weapon.stats.recoil ?? 0,
    mitigation: hull.stats.mitigation ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------------------------

type Parent = 'hull' | 'turret' | 'cradle';
interface Box6 { min: V3; max: V3 }
const boxOf = (pieces: readonly Convex[]): Box6 | null => {
  if (!pieces.length) return null;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pieces) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p.box[k]); max[k] = Math.max(max[k], p.box[k + 3]); }
  return { min, max };
};
const toHullBox = (b: Box6, pad = 0.002): HullBox => ({
  center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
  half: [(b.max[0] - b.min[0]) / 2 + pad, (b.max[1] - b.min[1]) / 2 + pad, (b.max[2] - b.min[2]) / 2 + pad],
});
const inBox = (p: Convex, b: HullBox, tol = 0.004): boolean => {
  for (let k = 0; k < 3; k++) if (p.box[k] < b.center[k] - b.half[k] - tol || p.box[k + 3] > b.center[k] + b.half[k] + tol) return false;
  return true;
};

export const UTILITY_BASE_TAGS: ReadonlySet<string> = new Set(['antenna-mount', 'radar-mast', 'periscope-housing', 'smoke']);

function proxies(ctx: KitContext): KitAssembly['proxies'] {
  const geo = kitGeometry(ctx, 0), h = ctx.hull, W = ctx.lowerHalfWidth, U = ctx.upperHalfWidth;
  const pieces = (group: RigidGroup) => (geo.groups.get(group) ?? []).flatMap(s => s.hulls).filter(p => !p.cosmetic);
  const out: { box: HullBox; parent: Parent }[] = [];
  // 0 hull: the lower hull and deck between the track channels.
  out.push({ box: { center: [0, (BELLY_Y + DECK_Y + 0.02) / 2, (h.nose[0] + h.rear) / 2], half: [W + 0.002, (DECK_Y + 0.02 - BELLY_Y) / 2, (h.nose[0] - h.rear) / 2 + 0.004] }, parent: 'hull' });
  // 1 armor follows the actual forward plate. The stepped medium driver's face and
  // shelf are already covered by the main hull; its lower front plate has this box.
  const frontProfile = hullFrontProfile(h), z0 = frontProfile[frontProfile.length - 2][0], z1 = h.nose[0];
  const pitch = Math.atan(-glacisSlope(h, (z0 + z1) / 2)), len = Math.hypot(z1 - z0, glacisY(h, z1) - glacisY(h, z0));
  const thickness = (h.archetype ?? h.id) === 'bastion' ? 0.05 : 0.03;
  const n: V3 = [0, Math.cos(pitch), Math.sin(pitch)];
  const mid: V3 = [0, (glacisY(h, z0) + glacisY(h, z1)) / 2, (z0 + z1) / 2];
  out.push({ box: { center: [mid[0], mid[1] + n[1] * (thickness / 2 - 0.004), mid[2] + n[2] * (thickness / 2 - 0.004)], half: [W, thickness / 2 + 0.004, len / 2], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] }, parent: 'hull' });
  // 2, 3 fenders: the sponson deck and fenders over each track, from the sponson underside up (the belt below
  // them belongs to the running-gear envelope; Bastion's skirts get their own boxes among the extras).
  const span = fenderSpan(ctx), fy0 = SPONSON_UNDERSIDE - 0.075;
  for (const side of [1, -1]) {
    const x0 = W - 0.002, x1 = U + 0.004, zf = fenderReach(ctx) + 0.004, zr = span.rear - 0.004;
    out.push({ box: { center: [side * (x0 + x1) / 2, (fy0 + DECK_Y + 0.01) / 2, (zf + zr) / 2], half: [(x1 - x0) / 2, (DECK_Y + 0.01 - fy0) / 2 + 0.002, (zf - zr) / 2] }, parent: 'hull' });
  }
  // 4 turret (turret frame), minus the utility base (its own box below).
  const turretPieces = pieces('turret'), body = turretPieces.filter(p => !UTILITY_BASE_TAGS.has(p.tag));
  out.push({ box: toHullBox(boxOf(body)!), parent: 'turret' });
  // 5 mantlet, 6 sleeve, 7 tube (cradle frame; the tube at rest, its recoil stays inside these boxes).
  const cradle = pieces('cradle');
  out.push({ box: toHullBox(boxOf(cradle.filter(p => p.tag === 'mantlet'))!), parent: 'cradle' });
  out.push({ box: toHullBox(boxOf(cradle.filter(p => p.tag === 'sleeve'))!), parent: 'cradle' });
  out.push({ box: toHullBox(boxOf(pieces('barrel'))!), parent: 'cradle' });
  // Extras: hull pieces not inside boxes 0–3 (per tag and side), the utility base, hatch and head envelopes.
  const hullBoxes = out.slice(0, 4).map(o => o.box).filter(b => !b.rotation);
  const loose = new Map<string, Convex[]>();
  for (const p of pieces('hull')) {
    if (hullBoxes.some(b => inBox(p, b))) continue;
    const k = `${p.tag}:${p.box[0] + p.box[3] < 0 ? -1 : 1}`;
    let list = loose.get(k); if (!list) { list = []; loose.set(k, list); } list.push(p);
  }
  for (const [, list] of [...loose].sort(([a], [b]) => a.localeCompare(b))) out.push({ box: toHullBox(boxOf(list)!), parent: 'hull' });
  const utilityBase = boxOf(turretPieces.filter(p => UTILITY_BASE_TAGS.has(p.tag)));
  if (utilityBase) out.push({ box: toHullBox(utilityBase), parent: 'turret' });
  if (ctx.turret.hatch && pieces('hatch').length) {
    // Closed and open lids: a box around the hinge covering both (turret frame).
    const hinge = ctx.turret.hatch.hinge, b = boxOf(pieces('hatch'))!, r = Math.max(b.max[2] - b.min[2], b.max[0] - b.min[0]) + 0.01;
    out.push({ box: { center: [hinge[0], hinge[1] + r / 2 - 0.005, hinge[2] + r / 4], half: [(b.max[0] - b.min[0]) / 2 + 0.004, r / 2 + 0.01, r * 0.75 + 0.01] }, parent: 'turret' });
  }
  const head = pieces('head');
  if (head.length) {
    // The head's reach over its whole joint range (spin: a cylinder about y; pitch / spring: a sphere about the pivot).
    const u = ctx.turret.utility, o = ctx.utility.headOrigin;
    let rxz = 0, ryz = 0, xMax = 0, yMin = Infinity, yMax = -Infinity;
    for (const p of head) for (let i = 0; i < p.pts.length; i += 3) {
      const x = p.pts[i], y = p.pts[i + 1], z = p.pts[i + 2];
      rxz = Math.max(rxz, Math.hypot(x, z)); ryz = Math.max(ryz, Math.hypot(y, z)); xMax = Math.max(xMax, Math.abs(x));
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const spin = ctx.utility.head === 'spin', pad = 0.006;
    const box: HullBox = spin
      ? { center: [u[0] + o[0], u[1] + o[1] + (yMin + yMax) / 2, u[2] + o[2]], half: [rxz + pad, (yMax - yMin) / 2 + pad, rxz + pad] }
      : { center: [u[0] + o[0], u[1] + o[1], u[2] + o[2]], half: [Math.max(xMax, ryz * 0.3) + pad, ryz + pad, ryz + pad] };
    out.push({ box, parent: 'turret' });
  }
  return out;
}

/**
 * The pose-dependent running-gear envelope for proxy containment (the kit counterpart of tank-collision's
 * running-gear boxes): per side, the wheel box from the lower hull side to the belt's outer edge between the
 * lowest and highest wheel ± (r + 0.05), plus end boxes around the sprocket and idler (hull frame).
 */
export function kitRunningEnvelope(a: KitAssembly, wheelY: readonly [ArrayLike<number>, ArrayLike<number>]): HullBox[] {
  const r = a.running, ctx = kitContext(a.loadout), g = ctx.gear, support = g.wheelRadius + 0.05, out: HullBox[] = [];
  for (const [stateSide, side] of [[0, 1], [1, -1]] as const) {
    // From below the lowest wheel to above the highest belt top run (the top run may ride above drooped wheels).
    const ys = Array.from(wheelY[stateSide]), lo = Math.min(...ys) - support, hi = Math.max(Math.max(...ys) + support, ctx.topRunY + 0.005);
    const x0 = ctx.lowerHalfWidth, x1 = r.halfSpacing + r.trackWidth / 2, cx = side * (x0 + x1) / 2, hx = (x1 - x0) / 2;
    const zf = r.sprocket.z + r.sprocket.r + BELT_SHOE, zr = r.idler.z - r.idler.r - BELT_SHOE - g.tensioner.travel;
    out.push({ center: [cx, (lo + hi) / 2, (zf + zr) / 2], half: [hx, (hi - lo) / 2, (zf - zr) / 2] });
    for (const [end, extra] of [[r.sprocket, 0], [r.idler, g.tensioner.travel]] as const) {
      const reach = end.r + BELT_SHOE + 0.05 + extra;
      out.push({ center: [cx, end.y, end.z], half: [hx, reach, reach] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

function exhaustFrames(ctx: KitContext): Frame[] {
  const h = ctx.hull;
  const paths = [-1, 1].map(side => (h.archetype ?? h.id) === 'warden' ? stackPath(side) : (h.archetype ?? h.id) === 'skiff' ? skiffExhaustPath(ctx, side) : bastionExhaustPath(ctx, side));
  return paths.map(path => {
    const a = path[path.length - 2], b = path[path.length - 1], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]);
    const dir: V3 = [d[0] / l, d[1] / l, d[2] / l];
    // Quaternion rotating +Z onto dir.
    const c = dir[2], ax: V3 = [-dir[1], dir[0], 0], s = Math.hypot(ax[0], ax[1]);
    let q: Q4;
    if (s < 1e-9) q = c > 0 ? [0, 0, 0, 1] : [0, 1, 0, 0];
    else { const angle = Math.atan2(s, c), k = Math.sin(angle / 2) / s; q = [ax[0] * k, ax[1] * k, 0, Math.cos(angle / 2)]; }
    return frame(b as V3, q);
  });
}

function build(key: string, loadout: KitLoadout): KitAssembly {
  const ctx = kitContext(loadout), g = ctx.gear, t = ctx.turret, w = ctx.weapon, u = ctx.utility;
  const layout = gearRig(g).layout;
  const z = layout.stationZ;
  // Driver-left (+X, side 1) rear→front, then driver-right: the TankState.wheelSuspension order.
  const stations: WheelStation[] = ([1, -1] as const).flatMap(side => z.map((sz): WheelStation => ({
    side, z: sz, y0: g.wheelY0, radius: g.wheelRadius,
    ...(g.suspension !== 'bogie' ? { arm: { pivot: [side * (ctx.lowerHalfWidth + 0.01), g.wheelY0, sz + g.armLength] as V3, length: g.armLength } } : {}),
  })));
  const joints: JointDef[] = [
    { name: 'hull', parent: '', kind: 'fixed', axis: [0, 1, 0] },
    { name: 'turret', parent: 'hull', kind: 'yaw', axis: [0, 1, 0] },
    { name: 'cradle', parent: 'turret', kind: 'pitch', axis: [-1, 0, 0], limits: [...t.elevation] as [number, number] },
    { name: 'barrel', parent: 'cradle', kind: 'slide', axis: [0, 0, -1], limits: [0, w.recoilTravel] },
  ];
  if (t.hatch) joints.push({ name: 'hatch', parent: 'turret', kind: 'pitch', axis: [-1, 0, 0], limits: [0, t.hatch.open] });
  if (u.head === 'spring2') joints.push({ name: 'antenna', parent: 'turret', kind: 'spring2', axis: [0, 1, 0], limits: [-WHIP.maxTilt, WHIP.maxTilt] });
  if (u.head === 'spin') joints.push({ name: 'radar', parent: 'turret', kind: 'spin', axis: [0, 1, 0] });
  if (u.head === 'pitch') joints.push({ name: 'periscope', parent: 'turret', kind: 'pitch', axis: [-1, 0, 0], limits: [...PERISCOPE_RANGE] as [number, number] });
  // The idler tensioner (informational: poseKit writes it as an instance).
  joints.push({ name: 'tensioner', parent: 'hull', kind: 'pitch', axis: [1, 0, 0], limits: [-g.tensioner.travel, g.tensioner.travel] });
  const mass = massProperties(ctx);
  let table: ReturnType<typeof pitchTable> | null = null;
  const pitchLimits = (yaw: number) => evalPitchLimits(table ??= pitchTable(ctx), yaw);
  const hl = g.halfLength;
  return {
    key, loadout: { ...loadout },
    frames: {
      turretRing: frame(RING_FRAME),
      trunnion: frame(t.trunnion),
      muzzle: frame([0, 0, w.barrelLength]),
      sensor: frame(SENSOR_POSITION),
      exhausts: exhaustFrames(ctx),
      utility: frame(t.utility),
    },
    weapon: { barrelLength: w.barrelLength, recoilTravel: w.recoilTravel, boreRadius: w.boreRadius },
    running: {
      halfSpacing: g.halfSpacing, trackWidth: g.width, stations,
      sprocket: { z: g.sprocket.z, y: g.sprocket.y, r: g.sprocket.r },
      idler: { z: g.idler.z, y: g.idler.y, r: g.idler.r },
      returnRollers: g.rollers.map(r => ({ z: r.z, y: r.y, r: r.r })),
      tensionerTravel: g.tensioner.travel * 2,
      topRunY: layout.topRunY,
      droop: SUSPENSION.droop, compression: SUSPENSION.compression,
      treadStations: [-hl - TREAD_STATION_OVERHANG, -hl, -2 * hl / 3, -hl / 3, 0, hl / 3, 2 * hl / 3, hl, hl + TREAD_STATION_OVERHANG],
    },
    proxies: proxies(ctx),
    massProps: { mass: mass.mass, com: mass.com, inertia: mass.inertia },
    pitchLimits,
    joints,
    stats: kitStats(ctx),
  };
}

// ---------------------------------------------------------------------------------------------
// Non-contract helpers for the legacy call sites
// ---------------------------------------------------------------------------------------------

type Table<T> = Record<string, T | undefined>;
const legacyAssemblies: Table<Table<Table<KitAssembly>>> = Object.create(null);

/** `assembleKit(kitLoadoutFromLegacy(l))` through an allocation-free lookup (hot paths call it per tick). */
export function assembleLegacy(l: Loadout): KitAssembly {
  const hit = legacyAssemblies[l.tracks]?.[l.barrel]?.[l.armor];
  if (hit) return hit;
  const assembly = assembleKit(kitLoadoutFromLegacy(l));
  const byBarrel = legacyAssemblies[l.tracks] ??= Object.create(null) as Table<Table<KitAssembly>>;
  (byBarrel[l.barrel] ??= Object.create(null) as Table<KitAssembly>)[l.armor] = assembly;
  return assembly;
}

interface Derived { wheelOffsets?: readonly V3[]; trackHalfLength?: number; trunnion?: { axisPoint: V3; forward: number } }
const derived = new WeakMap<KitAssembly, Derived>();
const derivedOf = (a: KitAssembly): Derived => { let d = derived.get(a); if (!d) { d = {}; derived.set(a, d); } return d; };

/** Legacy `getWheelOffsets`: [side·halfSpacing, support ground, station z] in `wheelSuspension` order. */
export function kitWheelOffsets(a: KitAssembly): readonly V3[] {
  const d = derivedOf(a);
  return d.wheelOffsets ??= deepFreeze(a.running.stations.map((station): V3 => [station.side * a.running.halfSpacing, SUPPORT_GROUND_Y, station.z]));
}

/** Largest |z| of the road-wheel stations (the gear's half length). */
export function kitTrackHalfLength(a: KitAssembly): number {
  const d = derivedOf(a);
  return d.trackHalfLength ??= Math.max(...a.running.stations.map(station => Math.abs(station.z)));
}

/**
 * The trunnion in the legacy evaluation form: a hull point on the yaw axis plus a distance along the
 * turret's forward direction. Every kit turret keeps its trunnion on the centre plane (x = 0).
 */
export function kitTrunnionPivot(a: KitAssembly): { readonly axisPoint: V3; readonly forward: number } {
  const d = derivedOf(a);
  if (!d.trunnion) {
    const ring = a.frames.turretRing.position, trunnion = a.frames.trunnion.position;
    d.trunnion = Object.freeze({ axisPoint: Object.freeze([ring[0], ring[1] + trunnion[1], ring[2]]) as unknown as V3, forward: trunnion[2] });
  }
  return d.trunnion;
}

/** Rigid maximum-compression stops under each track for the Rapier chassis (fresh boxes per call). */
export function kitBumpStops(a: KitAssembly): HullBox[] {
  return ([-1, 1] as const).map(side => ({ center: [side * a.running.halfSpacing, BUMP_STOP.y, 0], half: [a.running.trackWidth * .5, BUMP_STOP.halfHeight, BUMP_STOP.halfLength] }));
}

/** Belt links per side. */
export function kitLinksPerSide(a: KitAssembly): number {
  return gearRig(kitContext(a.loadout).gear).layout.linkCount;
}

/** The build context of an assembly (specs and derived dimensions). */
export function kitContextOf(a: KitAssembly): KitContext { return kitContext(a.loadout); }
