/**
 * Kit interference validation, exercised by tests/kit-interference.test.ts.
 *
 * Convex SAT on the parts' validation pieces with an AABB prefilter (geometry/convex.ts), a seated-pair
 * allowlist (ring in deck, mantlet in cheek, stub axles in their hubs, spring ends, hinge pins, the tube in its
 * sleeve), and sweeps decomposed by slot pairs so every legal assembly is covered quickly:
 *   A  hull × gear       — every per-side suspension extreme (3^4 per side), three belt phases (links, wheels,
 *                          arms, bogies, springs, rollers, sprocket, idler and tensioner vs the hull and each other)
 *   B  hull × turret     — yaw 0..360 in 2° steps: turret body, utility base and head (joint extremes), hatch
 *                          (shut and open) and mantlet vs the hull
 *   C  turret × weapon   — pitch over the joint range in 1° steps, recoil 0 and full, vs turret, hatch, head
 *   D  weapon × hull     — every yaw (2°), pitch from pitchLimits(yaw).min to max in 1° steps, recoil 0 and full,
 *                          vs the hull and the rest running gear
 * plus proxy containment (every non-cosmetic visual vertex within 5 mm of a proxy or the running envelope),
 * mass (COM y ≤ −0.20), static tip ≥ 60° and pitch-over ≥ 55°.
 */
import type { V3 } from '../contracts';
import { kitContext, kitGeometry, type KitGeometry } from './build';
import { KitError, legalKitLoadouts } from './catalog';
import { Placed, axisBound, boxDistance, boxesOverlap, segmentBoxDistance, penetration, type Convex } from './geometry/convex';
import { gjkDistance } from './geometry/gjk';
import { collisionPieceId, collisionShapesKey } from './geometry/signature';
import { DEG, applyDir, fromQuat, invertRigid, mat4, mul, type Mat4, type Vec3 } from './geometry/math';
import type { GroupId, InstancedGroup, KitContext, RigidGroup } from './parts/types';
import { INSTANCED_GROUPS } from './parts/types';
import { PERISCOPE_RANGE } from './parts/utilities/periscope';
import { WHIP } from './parts/utilities/antenna';
import { createRigPose, poseJoints, poseRig, restState, type RigPose, type RigState } from './rig';
import { BELT_SHOE, SUSPENSION, gearRig } from './running';
import { BELT_GROUND_CLEARANCE } from './belt';
import { GROUND_Y, RING_FRAME } from './sockets';
import { assembleKit, kitRunningEnvelope } from './assembly';
import type { KitAssembly, KitLoadout } from './types';

/** Overlaps deeper than this fail (brief: 1 mm). */
export const OVERLAP_TOLERANCE = 0.001;
/** Visual vertices may lie at most this far outside the proxies (brief: 5 mm). */
export const CONTAINMENT_TOLERANCE = 0.005;

export interface KitOverlap {
  a: string; b: string; depth: number;
  /** Intersection of the two pieces' AABBs (tank frame), for the sandbox's red boxes. */
  min: V3; max: V3;
  state: string;
}

interface PieceRef { group: GroupId; index: number; piece: Placed; tag: string }

// ---------------------------------------------------------------------------------------------
// Pair rules
// ---------------------------------------------------------------------------------------------

const RUNNING: ReadonlySet<GroupId> = new Set(INSTANCED_GROUPS);
const UTILITY_BASE = new Set(['antenna-mount', 'radar-mast', 'periscope-housing', 'smoke']);

/**
 * Instances per side for an instanced group (instances are ordered side 0 then side 1; links use the
 * running.ts linkSlot order instead, which no pair rule depends on: every link pair is checked).
 */
function perSide(ctx: KitContext, group: InstancedGroup): number {
  return gearRig(ctx.gear).layout.counts[group] / 2;
}

/**
 * Whether a pair of pieces must be checked. Same rigid group, same instanced group (except road wheels, which
 * interleave on the Crawler), the coaxial tube-in-sleeve slide and the seated pairs are skipped.
 */
export function checkedPair(ctx: KitContext, a: PieceRef, b: PieceRef): boolean {
  if (a.group === b.group) {
    if (a.group !== 'wheels') return false;
    return a.index !== b.index;
  }
  const pair = (x: GroupId, y: GroupId) => (a.group === x && b.group === y) || (a.group === y && b.group === x);
  const pick = (g: GroupId) => (a.group === g ? a : b);
  if (pair('cradle', 'barrel')) return false;
  if (pair('wheels', 'hubs') || pair('hubs', 'links') || pair('hubs', 'hull')) return false; // hubs are render-only
  // Seated: ring in deck, mantlet in cheek, hinge pins, utility pivot.
  if (pair('hull', 'turret') && pick('hull').tag === 'ring-collar' && pick('turret').tag === 'turret-ring') return false;
  if (pair('cradle', 'turret') && pick('cradle').tag === 'mantlet' && (pick('turret').tag === 'cheek' || pick('turret').tag === 'yoke')) return false;
  if (pair('hatch', 'turret') && (pick('turret').tag === 'cupola' || pick('turret').tag === 'hatch-ring')) return false;
  if (pair('head', 'turret') && UTILITY_BASE.has(pick('turret').tag)) return false;
  // Running gear seats (same side, related stations).
  if (RUNNING.has(a.group) && RUNNING.has(b.group)) {
    const g = ctx.gear;
    const side = (r: PieceRef) => Math.floor(r.index / perSide(ctx, r.group as InstancedGroup));
    const local = (r: PieceRef) => r.index % perSide(ctx, r.group as InstancedGroup);
    if (side(a) !== side(b)) return true;
    const la = local(a), lb = local(b);
    const is = (x: GroupId, y: GroupId, fn: (ix: number, iy: number) => boolean) => pair(x, y) && fn(local(a.group === x ? a : b), local(a.group === x ? b : a));
    if (g.suspension === 'torsion' && is('arms', 'wheels', (i, w) => i === w)) return false;
    if (g.suspension === 'rocker' && is('arms', 'bogies', (i, r) => i === r)) return false;
    if (g.suspension === 'rocker' && is('bogies', 'wheels', (r, w) => Math.floor(w / 2) === r)) return false;
    if (g.suspension === 'bogie' && is('bogies', 'wheels', (b2, w) => Math.floor(w / 2) === b2)) return false;
    if (is('springs', 'bogies', (s2, b2) => s2 === b2)) return false;
    if (is('tensioners', 'idlers', () => true)) return false;
    void la; void lb;
  }
  if (pair('springs', 'hull') && pick('hull').tag === 'gear-mount') return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Posed pieces
// ---------------------------------------------------------------------------------------------

function groupPieces(geo: KitGeometry, group: GroupId): Convex[] {
  return (geo.groups.get(group) ?? []).flatMap(s => s.hulls);
}

/** Every validation piece of an assembly placed for one rig state (reusable across states). */
export class PosedKit {
  readonly ctx: KitContext;
  readonly geo: KitGeometry;
  readonly pose: RigPose = createRigPose();
  readonly refs: PieceRef[] = [];
  private readonly byGroup = new Map<GroupId, PieceRef[]>();

  constructor(readonly assembly: KitAssembly, groups?: readonly GroupId[]) {
    this.ctx = kitContext(assembly.loadout);
    this.geo = kitGeometry(this.ctx, 0);
    const counts = gearRig(this.ctx.gear).layout.counts;
    for (const group of ['hull', 'turret', 'hatch', 'cradle', 'barrel', 'head'] as RigidGroup[]) {
      if (groups && !groups.includes(group)) continue;
      const list = groupPieces(this.geo, group).map((c): PieceRef => ({ group, index: 0, piece: new Placed(c), tag: c.tag }));
      this.byGroup.set(group, list); this.refs.push(...list);
    }
    for (const group of INSTANCED_GROUPS) {
      if (groups && !groups.includes(group)) continue;
      if (group === 'hubs') continue;
      const protos = groupPieces(this.geo, group), list: PieceRef[] = [];
      for (let i = 0; i < counts[group]; i++) for (const c of protos) list.push({ group, index: i, piece: new Placed(c), tag: c.tag });
      this.byGroup.set(group, list); this.refs.push(...list);
    }
  }

  group(g: GroupId): readonly PieceRef[] { return this.byGroup.get(g) ?? []; }

  /** Place every piece for `state`. */
  place(state: RigState): this {
    poseRig(this.ctx, state, this.pose);
    for (const r of this.refs) {
      const m = RUNNING.has(r.group) ? this.pose.instances[r.group as InstancedGroup][r.index] : this.pose.joints[r.group as RigidGroup];
      r.piece.set(m);
    }
    return this;
  }

  /** All checked overlaps deeper than the tolerance at the placed state. */
  overlaps(state = '', groupsA?: readonly GroupId[], groupsB?: readonly GroupId[]): KitOverlap[] {
    const out: KitOverlap[] = [];
    const A = groupsA ? groupsA.flatMap(g => this.group(g)) : this.refs;
    const B = groupsB ? groupsB.flatMap(g => this.group(g)) : null;
    const same = !B;
    const listB = B ?? this.refs;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      for (let j = same ? i + 1 : 0; j < listB.length; j++) {
        const b = listB[j];
        if (!boxesOverlap(a.piece.box, b.piece.box, OVERLAP_TOLERANCE)) continue;
        if (!checkedPair(this.ctx, a, b)) continue;
        const depth = penetration(a.piece, b.piece, OVERLAP_TOLERANCE);
        if (depth > OVERLAP_TOLERANCE) out.push(overlapRecord(a, b, depth, state));
      }
    }
    return out;
  }
}

function overlapRecord(a: PieceRef, b: PieceRef, depth: number, state: string): KitOverlap {
  const min: V3 = [0, 0, 0], max: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) { min[k] = Math.max(a.piece.box[k], b.piece.box[k]); max[k] = Math.min(a.piece.box[k + 3], b.piece.box[k + 3]); }
  return { a: `${a.group}${RUNNING.has(a.group) ? `#${a.index}` : ''}:${a.tag}`, b: `${b.group}${RUNNING.has(b.group) ? `#${b.index}` : ''}:${b.tag}`, depth, min, max, state };
}

/** Overlaps of one assembly at one rig state (sandbox, focused tests). */
export function overlapsAt(a: KitAssembly, state: RigState, label = ''): KitOverlap[] {
  return new PosedKit(a).place(state).overlaps(label);
}

// ---------------------------------------------------------------------------------------------
// Sweeps (decomposed by slot pairs)
// ---------------------------------------------------------------------------------------------

/**
 * Terrain under each belt that explains a suspension pattern (what the game's tread contacts give poseKit):
 * piecewise linear through the bottoms of the road wheels' belt circles, less the belt's ground clearance, so
 * the lower run meets every wheel. `wheelY` per TankState side (0 = +X), rear → front.
 */
export function groundThroughWheels(ctx: KitContext, wheelY: readonly [ArrayLike<number>, ArrayLike<number>]): NonNullable<RigState['ground']> {
  const g = ctx.gear, rig = gearRig(g), n = g.wheels.length;
  const side = (y: ArrayLike<number>) => {
    const c = rig.wheelCentres(y, new Float64Array(n * 2)), pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([c[i * 2], c[i * 2 + 1] - (g.wheels[i].radius + BELT_SHOE) - BELT_GROUND_CLEARANCE]);
    pts.sort((p, q) => p[0] - q[0]);
    return (z: number) => {
      if (z <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) if (z <= pts[i][0]) { const t = (z - pts[i - 1][0]) / Math.max(1e-9, pts[i][0] - pts[i - 1][0]); return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t; }
      return pts[pts.length - 1][1];
    };
  };
  return [side(wheelY[0]), side(wheelY[1])];
}

export interface SweepOptions {
  /** Yaw step (default 2°) and pitch step (default 1°). */
  yawStep?: number;
  pitchStep?: number;
  /** Per-side suspension samples (default droop / nominal / compression → 3^4 combinations). */
  suspension?: readonly number[];
  /** Belt phases as fractions of the link pitch. */
  phases?: readonly number[];
  /** Stop collecting after this many overlaps. */
  limit?: number;
  /** Deflection levels per station for the neighbouring-station grid of sweep A (default NEIGHBOUR_LEVELS; 0 skips it). */
  neighbourLevels?: number;
}

/**
 * Sweep A's neighbouring-station grid: each pair of adjacent stations over this many evenly spaced deflections from
 * full droop to full compression (the other stations at rest). Wheels on trailing arms travel fore–aft
 * (L(1 − cos θ)), so two neighbours come closest between the extremes (a fully drooped wheel next to a
 * half-drooped one), which the 3^4 extremes miss.
 */
export const NEIGHBOUR_LEVELS = 7;

export interface SweepReport { overlaps: KitOverlap[]; states: number; ms: number }

/** Clock for the reports' `ms` (injected by the caller: kit code never reads the wall clock). */
let now: () => number = () => 0;
export function setValidatorClock(clock: () => number): void { now = clock; }

function headStates(ctx: KitContext): [number, number][] {
  switch (ctx.utility.head) {
    case 'spring2': { const t = WHIP.maxTilt; return [[0, 0], [t, 0], [-t, 0], [0, t], [0, -t], [t * 0.7, t * 0.7], [-t * 0.7, -t * 0.7]]; }
    case 'spin': return Array.from({ length: 12 }, (_, i) => [i / 12 * Math.PI * 2, 0] as [number, number]);
    case 'pitch': return [[PERISCOPE_RANGE[0], 0], [0, 0], [PERISCOPE_RANGE[1], 0]];
    default: return [[0, 0]];
  }
}

function suspensionCombos(ctx: KitContext, samples: readonly number[]): number[][] {
  const y0 = ctx.gear.wheelY0, out: number[][] = [];
  for (const a of samples) for (const b of samples) for (const c of samples) for (const d of samples) out.push([y0 + a, y0 + b, y0 + c, y0 + d]);
  return out;
}

/** A: hull × running gear over the suspension extremes and belt phases, then the neighbouring-station grid. */
export function sweepRunningGear(a: KitAssembly, opts: SweepOptions = {}): SweepReport {
  return sweepRunningGearVariants([a], opts);
}

/** The same suspension poses against several hulls: gear transforms and internal pairs are shared exactly. */
function sweepRunningGearVariants(variants: readonly KitAssembly[], opts: SweepOptions): SweepReport {
  const a = variants[0], internalMemo = new Map<string, KitOverlap[]>();
  const t0 = now(), kit = new PosedKit(a, ['hull', ...INSTANCED_GROUPS]), ctx = kit.ctx, state = restState(ctx);
  const samples = opts.suspension ?? [-SUSPENSION.droop, 0, SUSPENSION.compression];
  const phases = opts.phases ?? [0, 0.34, 0.67];
  const pitch = gearRig(ctx.gear).layout.pitch, rest = state.wheelY[0];
  const overlaps: KitOverlap[] = [];
  let states = 0;
  // Per mesh side: the running pieces and the hull pieces that can reach them (static, placed once).
  kit.place(state);
  const hullRefs = variants.flatMap(variant => {
    const other = variant === a ? kit : new PosedKit(variant, ['hull']);
    if (other !== kit) for (const ref of other.group('hull')) ref.piece.set(mat4());
    return other.group('hull').map(ref => ({ ref, key: `${variant.loadout.hull}.${ctx.gear.id}.${other.ctx.ringClass}` }));
  });
  const distinctHulls = new Map<number, typeof hullRefs[number]>();
  for (const h of hullRefs) {
    const key = collisionPieceId(h.ref.piece.src), previous = distinctHulls.get(key);
    if (previous) previous.key += `|${h.key}`;
    else distinctHulls.set(key, { ...h });
  }
  const sides: { running: PieceRef[]; hull: { ref: PieceRef; key: string }[] }[] = [0, 1].map(side => ({
    // The matrix origin identifies the belt even for links, whose even/odd
    // instances are interleaved across both sides rather than stored in halves.
    running: INSTANCED_GROUPS.filter(g => g !== 'hubs').flatMap(g => kit.group(g).filter(r => (kit.pose.instances[g][r.index][12] < 0 ? 0 : 1) === side)),
    hull: [...distinctHulls.values()].filter(({ ref: r }) => (side === 0 ? r.piece.box[0] < -0.2 : r.piece.box[3] > 0.2) && r.piece.box[1] < 0.2),
  }));
  // The suspension is planar in Y/Z. Every part's X interval stays fixed under
  // wheel travel, bogie rocking and belt phase, so discard impossible X pairs once.
  const hullPairs = new Map<PieceRef, typeof hullRefs>();
  for (const { running, hull } of sides) for (const x of running) hullPairs.set(x, hull.filter(h => x.piece.box[0] < h.ref.piece.box[3] - OVERLAP_TOLERANCE && h.ref.piece.box[0] < x.piece.box[3] - OVERLAP_TOLERANCE));
  const test = (x: PieceRef, y: PieceRef, label: string, target = overlaps, variant = '') => {
    if (!boxesOverlap(x.piece.box, y.piece.box, OVERLAP_TOLERANCE) || !checkedPair(ctx, x, y)) return;
    const depth = penetration(x.piece, y.piece, OVERLAP_TOLERANCE);
    if (depth > OVERLAP_TOLERANCE) target.push(overlapRecord(x, y, depth, variant ? `${variant} ${label}` : label));
  };
  const checkedRestSide = new Set<string>();
  const check = (combo: number[], side: 0 | 1, f: number, label: string) => {
    poseRig(ctx, { ...state, wheelY: side === 0 ? [combo, rest] : [rest, combo], phase: [f * pitch, f * pitch] }, kit.pose);
    states += variants.length;
    for (const [sideIndex, { running }] of sides.entries()) {
      // Mesh side 0 is -X; TankState suspension side 0 is +X.
      const stateSide = 1 - sideIndex;
      // Only one suspension side changes. The opposite side repeats its rest
      // suspension at the same belt phase, so its exact pair checks are reusable.
      if (stateSide !== side) {
        const key = `${sideIndex}:${f}`;
        if (checkedRestSide.has(key)) continue;
        checkedRestSide.add(key);
      }
      for (const r of running) r.piece.set(kit.pose.instances[r.group as InstancedGroup][r.index]);
      for (const x of running) for (const h of hullPairs.get(x)!) test(x, h.ref, label, overlaps, h.key);
      // Running-against-running depends on this gear and its exact side pose,
      // never the hull or turret-ring option. Reuse only within this validation run.
      const internalKey = `${ctx.gear.id}:${sideIndex}:${f}:${Array.from(stateSide === side ? combo : rest).join(',')}`;
      const cachedInternal = internalMemo?.get(internalKey);
      if (cachedInternal) { overlaps.push(...cachedInternal.map(o => ({ ...o, state: label }))); continue; }
      const internal: KitOverlap[] = [];
      // Sweep-and-prune preserves every possible AABB intersection while avoiding
      // the quadratic checks between links at opposite ends of a track.
      const ordered = [...running].sort((x, y) => x.piece.box[2] - y.piece.box[2]);
      for (let i = 0; i < ordered.length; i++) {
        const x = ordered[i];
        for (let j = i + 1; j < ordered.length; j++) {
          if (ordered[j].piece.box[2] >= x.piece.box[5] - OVERLAP_TOLERANCE) break;
          test(x, ordered[j], label, internal);
        }
      }
      internalMemo?.set(internalKey, internal);
      overlaps.push(...internal);
    }
    return !!opts.limit && overlaps.length >= opts.limit;
  };
  const deflections = (combo: readonly number[]) => combo.map(v => (v - ctx.gear.wheelY0).toFixed(3)).join(',');
  for (const combo of suspensionCombos(ctx, samples)) for (const side of [0, 1] as const) for (const f of phases) {
    if (check(combo, side, f, `susp[${side}]=${deflections(combo)} phase=${f}`)) return { overlaps, states, ms: now() - t0 };
  }
  const n = opts.neighbourLevels ?? NEIGHBOUR_LEVELS, range = SUSPENSION.droop + SUSPENSION.compression;
  const levels = Array.from({ length: n }, (_, i) => ctx.gear.wheelY0 - SUSPENSION.droop + (n > 1 ? range * i / (n - 1) : 0));
  for (let s0 = 0; s0 < 3; s0++) for (const rear of levels) for (const front of levels) for (const side of [0, 1] as const) {
    const combo = Array.from(rest);
    combo[s0] = rear; combo[s0 + 1] = front;
    if (check(combo, side, 0, `neighbours[${side}]=${deflections(combo)}`)) return { overlaps, states, ms: now() - t0 };
  }
  return { overlaps: dedupe(overlaps), states, ms: now() - t0 };
}

function dedupe(list: KitOverlap[]): KitOverlap[] {
  const seen = new Map<string, KitOverlap>();
  for (const o of list) {
    const key = [o.a, o.b].sort().join('|');
    const prev = seen.get(key);
    if (!prev || o.depth > prev.depth) seen.set(key, o);
  }
  return [...seen.values()];
}

/**
 * Pieces of the turret stack (turret frame) against the hull, over the yaw sweep: the hull pieces near the
 * ring are moved into the turret frame per yaw (fewer transforms than the turret's hundreds of cells).
 */
export function sweepTurret(a: KitAssembly, opts: SweepOptions = {}): SweepReport {
  return sweepTurretVariants([a], opts);
}

/** Same turret mechanics: prove each distinct placed stack piece against each
 * distinct hull piece once. Gear widths, weapon-dependent cheeks and every
 * utility pose remain represented; duplicated primitives share their proof. */
function sweepTurretVariants(assemblies: readonly KitAssembly[], opts: SweepOptions = {}): SweepReport {
  const t0 = now(), ctx = kitContext(assemblies[0].loadout), step = opts.yawStep ?? 2 * DEG;
  const overlaps: KitOverlap[] = [];
  let states = 0;
  const turretGroups: GroupId[] = ['turret', 'hatch', 'head', 'cradle'];
  const joints = createRigPose().joints;
  const ringInv = invertRigid(poseJointsAt(ctx, 0, joints).turret);
  type Cell = { ref: PieceRef; placed: Placed; label: string };
  const hulls = new Map<number, Cell>(), stack = new Map<string, Cell>(), seenStacks = new Set<string>();
  let stateWeight = 0;
  for (const assembly of assemblies) {
    const variant = kitContext(assembly.loadout), geo = kitGeometry(variant, 0);
    for (const source of groupPieces(geo, 'hull')) {
      const id = collisionPieceId(source);
      if (!hulls.has(id)) {
        const placed = new Placed(source);
        hulls.set(id, { ref: { group: 'hull', index: 0, piece: placed, tag: source.tag }, placed, label: `${variant.hull.id}/${variant.gear.id}` });
      }
    }
    const hatchStates = variant.turret.hatch ? [0, 1] : [0], heads = headStates(variant);
    stateWeight += hatchStates.length * heads.length;
    const stackKey = JSON.stringify([variant.turret.trunnion, variant.turret.hatch, variant.turret.utility,
      variant.utility.head, variant.utility.headOrigin, heads, ...turretGroups.map(group => collisionShapesKey(geo.groups.get(group) ?? []))]);
    if (seenStacks.has(stackKey)) continue;
    seenStacks.add(stackKey);
    for (const hatch of hatchStates) for (const head of heads) {
      poseJoints(variant, { yaw: 0, pitch: 0, recoil: 0, hatch, head }, joints);
      for (const group of turretGroups) {
        const frame = mul(ringInv, joints[group as RigidGroup]), transform = Array.from(frame).join(',');
        for (const source of groupPieces(geo, group)) {
          const key = `${group}:${collisionPieceId(source)}:${transform}`;
          if (stack.has(key)) continue;
          const placed = new Placed(source).set(frame);
          stack.set(key, { ref: { group, index: 0, piece: placed, tag: source.tag }, placed,
            label: `${variant.weapon.id}/${variant.utility.id} hatch=${hatch} head=${head.map(v => v.toFixed(2)).join(',')}` });
        }
      }
    }
  }
  // Only hull pieces that can reach the turret's swept cylinder.
  let reach = 0, bottom = Infinity;
  for (const { placed } of stack.values()) {
    reach = Math.max(reach, Math.hypot(placed.box[0], placed.box[2]), Math.hypot(placed.box[3], placed.box[5]), Math.hypot(placed.box[0], placed.box[5]), Math.hypot(placed.box[3], placed.box[2]));
    bottom = Math.min(bottom, placed.box[1]);
  }
  const ring = poseJointsAt(ctx, 0, joints).turret;
  const near = [...hulls.values()].filter(h => {
    const b = h.placed.src.box;
    const nx = b[0] > ring[12] ? b[0] - ring[12] : b[3] < ring[12] ? ring[12] - b[3] : 0, nz = b[2] > ring[14] ? b[2] - ring[14] : b[5] < ring[14] ? ring[14] - b[5] : 0;
    return Math.hypot(nx, nz) < reach + 0.01 && b[4] > ring[13] + bottom - 0.01;
  });
  for (let yaw = 0; yaw < Math.PI * 2 - 1e-9; yaw += step) {
    const inv = invertRigid(poseJointsAt(ctx, yaw, joints).turret);
    for (const h of near) h.placed.set(inv);
    states += stateWeight;
      for (const { ref, placed, label } of stack.values()) for (const h of near) {
        if (!boxesOverlap(placed.box, h.placed.box, OVERLAP_TOLERANCE)) continue;
        if (!checkedPair(ctx, ref, h.ref)) continue;
        const depth = penetration(placed, h.placed, OVERLAP_TOLERANCE);
        if (depth > OVERLAP_TOLERANCE) overlaps.push(overlapRecord({ ...ref, piece: placed }, { ...h.ref, piece: h.placed }, depth, `${h.label} yaw=${(yaw / DEG).toFixed(0)} ${label}`));
      }
    if (opts.limit && overlaps.length >= opts.limit) break;
  }
  return { overlaps: dedupe(overlaps), states, ms: now() - t0 };
}

function poseJointsAt(ctx: KitContext, yaw: number, out: RigPose['joints']): RigPose['joints'] {
  poseJoints(ctx, { yaw, pitch: 0, recoil: 0, hatch: 0, head: [0, 0] }, out);
  return out;
}

/** C: the gun against its own turret, hatch and utility head over the joint range (turret frame). */
export function sweepGunTurret(a: KitAssembly, opts: SweepOptions = {}): SweepReport {
  const t0 = now(), kit = new PosedKit(a, ['turret', 'hatch', 'head', 'cradle', 'barrel']), ctx = kit.ctx, step = opts.pitchStep ?? 1 * DEG;
  const overlaps: KitOverlap[] = [];
  let states = 0;
  const joints = createRigPose().joints;
  const ringInv = invertRigid(poseJointsAt(ctx, 0, joints).turret);
  const hatchStates = ctx.turret.hatch ? [0, 1] : [0];
  const [lo, hi] = ctx.turret.elevation;
  // Periscope follows the main gun. The point-defense demonstrator searches on its
  // own actuator, so every gun pitch/recoil must also clear all independent head extremes.
  const heads = ctx.utility.id === 'periscope' ? null : headStates(ctx);
  const turretRefs = kit.group('turret').map(ref => ({ ref, placed: new Placed(ref.piece.src).set(mat4()) }));
  const gunRefs = [...kit.group('cradle'), ...kit.group('barrel')].map(ref => ({ ref, placed: new Placed(ref.piece.src) }));
  type Target = typeof turretRefs[number];
  const hatchPoses = new Map<number, Target[]>(), headPoses = new Map<string, Target[]>(), checkedMoving = new Set<string>();
  const movingPose = (hatch: number, head: readonly [number, number]): { hatchRefs: Target[]; headRefs: Target[]; key: string } => {
    const key = `${head[0]}:${head[1]}`;
    let hatchRefs = hatchPoses.get(hatch), headRefs = headPoses.get(key);
    if (!hatchRefs || !headRefs) {
      poseJoints(ctx, { yaw: 0, pitch: 0, recoil: 0, hatch, head }, joints);
      if (!hatchRefs) { hatchRefs = kit.group('hatch').map(ref => ({ ref, placed: new Placed(ref.piece.src).set(mul(ringInv, joints.hatch)) })); hatchPoses.set(hatch, hatchRefs); }
      if (!headRefs) { headRefs = kit.group('head').map(ref => ({ ref, placed: new Placed(ref.piece.src).set(mul(ringInv, joints.head)) })); headPoses.set(key, headRefs); }
    }
    return { hatchRefs, headRefs, key };
  };
  const checkPairs = (sources: Target[], targets: Target[], label: string): void => {
    for (const g of sources) for (const t of targets) {
      if (!boxesOverlap(g.placed.box, t.placed.box, OVERLAP_TOLERANCE) || !checkedPair(ctx, g.ref, t.ref)) continue;
      const depth = penetration(g.placed, t.placed, OVERLAP_TOLERANCE);
      if (depth > OVERLAP_TOLERANCE) overlaps.push(overlapRecord({ ...g.ref, piece: g.placed }, { ...t.ref, piece: t.placed }, depth, label));
    }
  };
  for (const pitch of pitchSteps(lo, hi, step)) {
    const headAngles = heads ?? [[Math.max(PERISCOPE_RANGE[0], Math.min(PERISCOPE_RANGE[1], pitch)), 0] as [number, number]];
    // Moving bodies depend only on their own actuator: preplace each exact pose,
    // then check the hatch/head cross product once independently of the gun.
    for (const hatch of hatchStates) for (const head of headAngles) {
      const p = movingPose(hatch, head), key = `${hatch}:${p.key}`;
      if (!checkedMoving.has(key)) {
        checkedMoving.add(key);
        const label = `hatch=${hatch} head=${head[0].toFixed(2)}`;
        checkPairs(p.hatchRefs, turretRefs, label); checkPairs(p.headRefs, turretRefs, label);
        checkPairs(p.hatchRefs, p.headRefs, label);
      }
    }
    for (const recoil of [0, 1]) {
      poseJoints(ctx, { yaw: 0, pitch, recoil, hatch: 0, head: [0, 0] }, joints);
      for (const g of gunRefs) g.placed.set(mul(ringInv, joints[g.ref.group as RigidGroup]));
      const label = `pitch=${(pitch / DEG).toFixed(1)} recoil=${recoil}`;
      checkPairs(gunRefs, turretRefs, label);
      for (const hatch of hatchStates) checkPairs(gunRefs, hatchPoses.get(hatch)!, `${label} hatch=${hatch}`);
      for (const head of headAngles) {
        const key = `${head[0]}:${head[1]}`;
        checkPairs(gunRefs, headPoses.get(key)!, `${label} head=${head[0].toFixed(2)}`);
        }
      states += hatchStates.length * headAngles.length;
    }
    if (opts.limit && overlaps.length >= opts.limit) break;
  }
  return { overlaps: dedupe(overlaps), states, ms: now() - t0 };
}

/** lo, lo + step, …, hi (hi always included). */
function pitchSteps(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let p = lo; p < hi - 1e-9; p += step) out.push(p);
  out.push(hi);
  return out;
}

/** D: the gun against the hull and the rest running gear, from pitchLimits(yaw).min up (tank frame). */
export function sweepGunHull(a: KitAssembly, opts: SweepOptions = {}): SweepReport {
  const t0 = now(), kit = new PosedKit(a, ['hull', 'cradle', 'barrel', ...INSTANCED_GROUPS]), ctx = kit.ctx, yawStep = opts.yawStep ?? 2 * DEG, pitchStep = opts.pitchStep ?? 1 * DEG;
  kit.place(restState(ctx));
  const overlaps: KitOverlap[] = [];
  let states = 0;
  const statics = [...kit.group('hull'), ...INSTANCED_GROUPS.filter(g => g !== 'hubs').flatMap(g => kit.group(g))];
  const gun = [...kit.group('cradle'), ...kit.group('barrel')];
  // Pair rules depend on piece identity, never on yaw, pitch or recoil.
  const checkedStatics = gun.map(g => new Set(statics.filter(sref => checkedPair(ctx, g, sref))));
  const bounds = gun.map(g => axisBound(g.piece.src));
  const sweepRadii = [0, 1].map(recoil => bounds.map((b, i) => {
    const slide = gun[i].group === 'barrel' ? recoil * ctx.weapon.recoilTravel : 0;
    return Math.hypot(Math.max(Math.abs(b.z0 - slide), Math.abs(b.z1 - slide)), b.r);
  }));
  const reach = Math.max(...sweepRadii[0], ...sweepRadii[1]);
  let radius = 0;
  for (const b of bounds) radius = Math.max(radius, b.r);
  const joints = createRigPose().joints, pa = new Float64Array(3), pb = new Float64Array(3);
  const t = ctx.turret.trunnion;
  for (let yaw = 0; yaw < Math.PI * 2 - 1e-9; yaw += yawStep) {
    // Statics near the gun's vertical plane and within its reach.
    const sy = Math.sin(yaw), cy = Math.cos(yaw), T = [RING_FRAME[0] + cy * t[0] + sy * t[2], RING_FRAME[1] + t[1], RING_FRAME[2] - sy * t[0] + cy * t[2]];
    const near = statics.filter(sref => {
      const b = sref.piece.box;
      const nc = ((b[0] + b[3]) / 2 - T[0]) * cy - ((b[2] + b[5]) / 2 - T[2]) * sy;
      const nh = (b[3] - b[0]) / 2 * Math.abs(cy) + (b[5] - b[2]) / 2 * Math.abs(sy);
      let dist2 = 0;
      for (let k = 0; k < 3; k++) { const v = Math.max(b[k] - T[k], 0, T[k] - b[k + 3]); dist2 += v * v; }
      return nc - nh <= radius + OVERLAP_TOLERANCE && nc + nh >= -radius - OVERLAP_TOLERANCE && dist2 <= (reach + OVERLAP_TOLERANCE) ** 2;
    });
    if (!near.length) continue;
    const { min, max } = a.pitchLimits(yaw);
    const pitches = pitchSteps(min, max, pitchStep);
    const sinLo = Math.sin(min), sinHi = Math.sin(max), cosLo = Math.min(Math.cos(min), Math.cos(max)), cosHi = min <= 0 && max >= 0 ? 1 : Math.max(Math.cos(min), Math.cos(max));
    // The full swept capsule for each individual gun piece is much smaller than
    // the complete weapon's reach. Its Y and forward intervals conservatively
    // enclose both recoil endpoints and every elevation in this yaw's range.
    const pieceStatics = bounds.map((bound, i) => {
      const slide = gun[i].group === 'barrel' ? ctx.weapon.recoilTravel : 0, a = bound.z0 - slide, b = bound.z1;
      const q0 = Math.min(a * cosLo, a * cosHi, b * cosLo, b * cosHi), q1 = Math.max(a * cosLo, a * cosHi, b * cosLo, b * cosHi), r = bound.r + OVERLAP_TOLERANCE;
      const v0 = Math.min(a * sinLo, a * sinHi, b * sinLo, b * sinHi), v1 = Math.max(a * sinLo, a * sinHi, b * sinLo, b * sinHi);
      const box = Float64Array.of(T[0] + Math.min(sy * q0, sy * q1) - r, T[1] + v0 - r, T[2] + Math.min(cy * q0, cy * q1) - r,
        T[0] + Math.max(sy * q0, sy * q1) + r, T[1] + v1 + r, T[2] + Math.max(cy * q0, cy * q1) + r);
      return near.filter(sref => boxesOverlap(box, sref.piece.box, -OVERLAP_TOLERANCE) && checkedStatics[i].has(sref));
    });
    /** Certify an angular interval per piece; negative half-angle requests exact overlaps. */
    const check = (pitch: number, recoil: number, halfAngle: number): boolean => {
      // Only the two gun frames move here. Avoid rebuilding the hull, turret,
      // hatch and utility matrices for every interval in this validator.
      const m = joints.cradle, barrel = joints.barrel, sp = Math.sin(pitch), cp = Math.cos(pitch);
      m[0] = cy; m[1] = 0; m[2] = -sy;
      m[4] = -sy * sp; m[5] = cp; m[6] = -cy * sp;
      m[8] = sy * cp; m[9] = sp; m[10] = cy * cp;
      m[12] = T[0]; m[13] = T[1]; m[14] = T[2]; m[15] = 1;
      barrel.set(m); const travel = recoil * ctx.weapon.recoilTravel;
      barrel[12] -= m[8] * travel; barrel[13] -= m[9] * travel; barrel[14] -= m[10] * travel;
      let ok = true;
      const lo = pitch - Math.max(0, halfAngle), hi = pitch + Math.max(0, halfAngle);
      const s0 = Math.sin(lo), s1 = Math.sin(hi), c0 = Math.min(Math.cos(lo), Math.cos(hi)), c1 = lo <= 0 && hi >= 0 ? 1 : Math.max(Math.cos(lo), Math.cos(hi));
      for (let i = 0; i < gun.length; i++) {
        if (!pieceStatics[i].length) continue;
        const g = gun[i], bound = bounds[i], m = joints[g.group as RigidGroup];
        const slide = g.group === 'barrel' ? recoil * ctx.weapon.recoilTravel : 0;
        const gap = halfAngle > 0 ? sweepRadii[recoil][i] * halfAngle + OVERLAP_TOLERANCE : -1;
        const r = bound.r + Math.max(gap, OVERLAP_TOLERANCE);
        pa[0] = m[8] * bound.z0 + m[12]; pa[1] = m[9] * bound.z0 + m[13]; pa[2] = m[10] * bound.z0 + m[14];
        pb[0] = m[8] * bound.z1 + m[12]; pb[1] = m[9] * bound.z1 + m[13]; pb[2] = m[10] * bound.z1 + m[14];
        const x0 = Math.min(pa[0], pb[0]) - r, x1 = Math.max(pa[0], pb[0]) + r, y0 = Math.min(pa[1], pb[1]) - r, y1 = Math.max(pa[1], pb[1]) + r;
        const z0 = Math.min(pa[2], pb[2]) - r, z1 = Math.max(pa[2], pb[2]) + r;
        // Exact trigonometric intervals bound the swept axis, expanded by the
        // piece's radius. This rejects high arcs without the much larger sphere
        // expansion used by the angular-distance proof below.
        const za = bound.z0 - slide, zb = bound.z1 - slide, sr = bound.r + OVERLAP_TOLERANCE;
        const q0 = Math.min(za * c0, za * c1, zb * c0, zb * c1), q1 = Math.max(za * c0, za * c1, zb * c0, zb * c1);
        const ix0 = T[0] + Math.min(sy * q0, sy * q1) - sr, ix1 = T[0] + Math.max(sy * q0, sy * q1) + sr;
        const iy0 = T[1] + Math.min(za * s0, za * s1, zb * s0, zb * s1) - sr, iy1 = T[1] + Math.max(za * s0, za * s1, zb * s0, zb * s1) + sr;
        const iz0 = T[2] + Math.min(cy * q0, cy * q1) - sr, iz1 = T[2] + Math.max(cy * q0, cy * q1) + sr;
        let placed = false;
        for (const sref of pieceStatics[i]) {
          const hb = sref.piece.box;
          if (hb[0] > ix1 || hb[3] < ix0 || hb[1] > iy1 || hb[4] < iy0 || hb[2] > iz1 || hb[5] < iz0) continue;
          if (hb[0] > x1 || hb[3] < x0 || hb[1] > y1 || hb[4] < y0 || hb[2] > z1 || hb[5] < z0) continue;
          if (segmentBoxDistance(pa, pb, hb) > r) continue;
          if (!placed) { g.piece.set(m, gap <= 0); placed = true; }
          if (gap > 0) {
            // Axis separation bounds convex distance from below. Keep equality
            // for GJK: only a distance strictly beyond the interval gap is safe.
            const b = g.piece.box;
            if (hb[0] > b[3] + gap || hb[3] < b[0] - gap || hb[1] > b[4] + gap || hb[4] < b[1] - gap || hb[2] > b[5] + gap || hb[5] < b[2] - gap) continue;
            if (gjkDistance(g.piece, sref.piece, gap) <= gap) return false;
            continue;
          }
          if (!boxesOverlap(g.piece.box, sref.piece.box, OVERLAP_TOLERANCE)) continue;
          const depth = penetration(g.piece, sref.piece, OVERLAP_TOLERANCE);
          if (depth > OVERLAP_TOLERANCE) { ok = false; overlaps.push(overlapRecord(g, sref, depth, `yaw=${(yaw / DEG).toFixed(0)} pitch=${(pitch / DEG).toFixed(1)} recoil=${recoil}`)); }
        }
      }
      return ok;
    };
    // Certify whole pitch intervals with the same conservative angular-motion
    // bound as before. Clear high elevations can share one proof; uncertain spans
    // split until every original 1° sample is checked exactly.
    const interval = (i: number, j: number): void => {
      const lo = pitches[i], hi = pitches[j], halfAngle = (hi - lo) / 2;
      if (j > i && check((lo + hi) / 2, 0, halfAngle) && check((lo + hi) / 2, 1, halfAngle)) { states += (j - i + 1) * 2; return; }
      if (j - i >= 3) { const mid = Math.floor((i + j) / 2); interval(i, mid); interval(mid + 1, j); return; }
      for (let k = i; k <= j; k++) for (const recoil of [0, 1]) { check(pitches[k], recoil, -1); states++; }
    };
    interval(0, pitches.length - 1);
    if (opts.limit && overlaps.length >= opts.limit) break;
  }
  return { overlaps: dedupe(overlaps), states, ms: now() - t0 };
}

// ---------------------------------------------------------------------------------------------
// Proxy containment and mass
// ---------------------------------------------------------------------------------------------

export interface ContainmentReport { worst: number; outside: { group: string; tag: string; distance: number; point: V3 }[]; points: number }

/** Every non-cosmetic visual vertex within CONTAINMENT_TOLERANCE of the proxies (or the running envelope). */
export function checkContainment(a: KitAssembly, states?: readonly RigState[]): ContainmentReport {
  const kit = new PosedKit(a), ctx = kit.ctx;
  const list = states ?? containmentStates(ctx);
  const out: ContainmentReport = { worst: 0, outside: [], points: 0 };
  const p: Vec3 = [0, 0, 0];
  for (const state of list) {
    kit.place(state);
    const joints = kit.pose.joints;
    const boxes = a.proxies.map(({ box, parent }) => {
      const m = parent === 'hull' ? joints.hull : parent === 'turret' ? joints.turret : joints.cradle;
      const local = box.rotation ? mul(m, fromQuat(box.rotation, box.center)) : mul(m, fromQuat([0, 0, 0, 1], box.center));
      const axes = [applyDir(local, 1, 0, 0), applyDir(local, 0, 1, 0), applyDir(local, 0, 0, 1)];
      return { center: [local[12], local[13], local[14]] as Vec3, half: box.half as Vec3, axes };
    });
    for (const env of kitRunningEnvelope(a, state.wheelY)) boxes.push({ center: env.center as Vec3, half: env.half as Vec3, axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
    const runningFirst = [...boxes.slice(a.proxies.length), ...boxes.slice(0, a.proxies.length)];
    for (const r of kit.refs) {
      if (r.piece.src.cosmetic || r.group === 'hubs') continue;
      const pts = r.piece.pts, bounds = r.piece.box, candidates = RUNNING.has(r.group) ? runningFirst : boxes;
      out.points += pts.length / 3;
      const cx = (bounds[0] + bounds[3]) / 2, cy = (bounds[1] + bounds[4]) / 2, cz = (bounds[2] + bounds[5]) / 2;
      const hx = (bounds[3] - bounds[0]) / 2, hy = (bounds[4] - bounds[1]) / 2, hz = (bounds[5] - bounds[2]) / 2;
      // If the complete placed AABB lies in one oriented proxy, all its vertices
      // do too. This is an exact containment proof; uncertain unions still check
      // every vertex against every proxy with the original 5 mm tolerance.
      let contained = false;
      for (const b of candidates) {
        const dx = cx - b.center[0], dy = cy - b.center[1], dz = cz - b.center[2];
        let inside = true;
        for (let k = 0; k < 3; k++) {
          const axis = b.axes[k];
          if (Math.abs(dx * axis[0] + dy * axis[1] + dz * axis[2]) + hx * Math.abs(axis[0]) + hy * Math.abs(axis[1]) + hz * Math.abs(axis[2]) > b.half[k]) { inside = false; break; }
        }
        if (inside) { contained = true; break; }
      }
      if (contained) continue;
      for (let i = 0; i < pts.length; i += 3) {
        p[0] = pts[i]; p[1] = pts[i + 1]; p[2] = pts[i + 2];
        let best = Infinity;
        for (const b of candidates) { const d = boxDistance(p, b.center, b.half, b.axes); if (d < best) { best = d; if (best <= 0) break; } }
        if (best > CONTAINMENT_TOLERANCE) {
          if (out.outside.length < 50) out.outside.push({ group: r.group, tag: r.tag, distance: best, point: [...p] as V3 });
        }
        out.worst = Math.max(out.worst, best);
      }
    }
  }
  return out;
}

function containmentStates(ctx: KitContext): RigState[] {
  const rest = restState(ctx), y0 = ctx.gear.wheelY0;
  const droop = [0, 1, 2, 3].map(() => y0 - SUSPENSION.droop), comp = [0, 1, 2, 3].map(() => y0 + SUSPENSION.compression);
  const out: RigState[] = [rest, { ...rest, wheelY: [droop, droop] }, { ...rest, wheelY: [comp, comp] }];
  if (ctx.turret.hatch) out.push({ ...rest, hatch: 1 });
  for (const head of headStates(ctx)) out.push({ ...rest, head });
  out.push({ ...rest, recoil: 1 });
  return out;
}

export interface MassReport { comY: number; comZ: number; tipDeg: number; pitchOverDeg: number }

/** COM height and static tip / pitch-over angles on flat ground (track outer edge, end road wheels). */
export function massReport(a: KitAssembly): MassReport {
  const ctx = kitContext(a.loadout), g = ctx.gear, [, cy, cz] = a.massProps.com, h = cy - GROUND_Y;
  const edge = g.halfSpacing + g.width / 2;
  const zs = g.wheels.map(w => gearRig(g).layout.stationZ[w.station] + w.dz);
  const front = Math.max(...zs) - cz, rear = cz - Math.min(...zs);
  return { comY: cy, comZ: cz, tipDeg: Math.atan2(edge, h) / DEG, pitchOverDeg: Math.atan2(Math.min(front, rear), h) / DEG };
}

// ---------------------------------------------------------------------------------------------
// Whole-kit validation
// ---------------------------------------------------------------------------------------------

export interface KitValidation { overlaps: KitOverlap[]; states: number; ms: number; assemblies: number; byCheck: Record<string, SweepReport> }

/**
 * Validate every legal assembly, decomposed by physical dependencies. A includes the conditional crew
 * hatch, B batches every legal hull/gear/weapon/utility variant for one turret, C is per turret/weapon/utility,
 * and D is per hull/gear/turret/weapon. Only exactly equal collision geometry may reuse a proof.
 */
export function validateKit(opts: SweepOptions & { checks?: readonly ('A' | 'B' | 'C' | 'D')[] } = {}): KitValidation {
  const t0 = now(), legal = legalKitLoadouts(), checks = new Set(opts.checks ?? ['A', 'B', 'C', 'D']);
  const reports: Record<string, SweepReport> = {};
  const overlaps: KitOverlap[] = [];
  let states = 0;
  const run = (name: string, key: (l: KitLoadout) => string, fn: (a: KitAssembly) => SweepReport) => {
    const seen = new Set<string>();
    for (const l of legal) {
      const k = key(l);
      if (seen.has(k)) continue;
      seen.add(k);
      const r = fn(assembleKit(l));
      reports[`${name}:${k}`] = r;
      states += r.states;
      overlaps.push(...r.overlaps.map(o => ({ ...o, state: `${name} ${k} ${o.state}` })));
    }
  };
  if (checks.has('A')) {
    const seen = new Set<string>(), variants = new Map<string, KitAssembly[]>();
    for (const l of legal) {
      const ctx = kitContext(l), key = `${l.hull}.${l.runningGear}.${ctx.ringClass}.${ctx.turret.hatch ? 'turret-hatch' : 'hull-hatch'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = variants.get(l.runningGear) ?? [];
      list.push(assembleKit(l)); variants.set(l.runningGear, list);
    }
    for (const [gear, list] of variants) {
      const r = sweepRunningGearVariants(list, opts);
      reports[`A:${gear}`] = r; states += r.states;
      overlaps.push(...r.overlaps.map(o => ({ ...o, state: `A ${o.state}` })));
    }
  }
  if (checks.has('B')) {
    const variants = new Map<string, KitAssembly[]>();
    for (const l of legal) {
      const list = variants.get(l.turret) ?? [];
      list.push(assembleKit(l)); variants.set(l.turret, list);
    }
    for (const [turret, list] of variants) {
      const r = sweepTurretVariants(list, opts);
      reports[`B:${turret}`] = r; states += r.states;
      overlaps.push(...r.overlaps.map(o => ({ ...o, state: `B ${turret} ${o.state}` })));
    }
  }
  if (checks.has('C')) run('C', l => `${l.turret}.${l.weapon}.${l.utility}`, a => sweepGunTurret(a, opts));
  if (checks.has('D')) {
    const proofs = new Map<string, SweepReport>(), frames = new Map<string, number>(), frameIds = new Map<string, number>();
    run('D', l => `${l.hull}.${l.runningGear}.${l.turret}.${l.weapon}`, a => {
      const ctx = kitContext(a.loadout), geo = kitGeometry(ctx, 0);
      let frameKey = frames.get(ctx.gear.id);
      if (frameKey === undefined) {
        const pose = poseRig(ctx, restState(ctx), createRigPose());
        const signature = JSON.stringify(INSTANCED_GROUPS.filter(g => g !== 'hubs').map(g => pose.instances[g].map(m => Array.from(m))));
        frameKey = frameIds.get(signature);
        if (frameKey === undefined) { frameKey = frameIds.size; frameIds.set(signature, frameKey); }
        frames.set(ctx.gear.id, frameKey);
      }
      const key = JSON.stringify([ctx.turret.trunnion, ctx.turret.elevation, ctx.weapon.recoilTravel, frameKey,
        ...(['hull', 'cradle', 'barrel', ...INSTANCED_GROUPS.filter(g => g !== 'hubs')] as GroupId[]).map(g => collisionShapesKey(geo.groups.get(g) ?? []))]);
      const previous = proofs.get(key);
      if (previous) return { ...previous, ms: 0 };
      const result = sweepGunHull(a, opts);
      proofs.set(key, result);
      return result;
    });
  }
  return { overlaps, states, ms: now() - t0, assemblies: legal.length, byCheck: reports };
}

export { KitError };
