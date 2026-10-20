/**
 * `pitchLimits(yaw)` solver (W1-KIT, brief design rule): for every 1° of turret yaw, bisect the lowest gun
 * pitch at which the gun (mantlet, sleeve, tube at recoil 0 and full) keeps ≥ 3 mm from the hull pieces
 * (hull, deck, fenders, exhausts, stowage). The table holds one value per 2° (the max of the three
 * neighbouring 1° samples plus 0.5°) and is interpolated linearly, so the limit is continuous in yaw and
 * conservative between samples. The table is then slope-limited to PITCH_MAX_SLOPE (an
 * upper envelope, so it only ever raises the limit): the gun lifts over a stack or a cupola over a few degrees
 * of traverse instead of snapping, including where the new stepped front profiles meet their fenders.
 * The turret's joint range clamps it; the
 * maximum is the turret's.
 * Gun-over-deck auto elevation: posing clamps the displayed pitch to this range (pose.ts).
 */
import { Placed, axisBound, boxesOverlap, segmentBoxDistance, type AxisBound, type Convex } from './geometry/convex';
import { gjkDistance } from './geometry/gjk';
import { DEG, translate, type Mat4 } from './geometry/math';
import { kitGeometry } from './build';
import { collisionShapesKey } from './geometry/signature';
import type { KitContext } from './parts/types';
import { RING_FRAME } from './sockets';

export const PITCH_CLEARANCE = 0.003;
export const PITCH_MARGIN = 0.5 * DEG;
export const PITCH_TABLE_STEP = 2 * DEG;
/** Front aiming arc (± yaw) retaining the selected hull's full physical depression clearance. */
export const FRONT_ARC = 12 * DEG;
/** Largest change of the depression limit per unit of turret yaw (rad/rad). */
export const PITCH_MAX_SLOPE = 3;

export interface PitchTable { min: Float64Array; turretMin: number; turretMax: number; geometric: Float64Array }

const tables = new Map<string, PitchTable>();

function collect(ctx: KitContext, group: 'hull' | 'cradle' | 'barrel'): Convex[] {
  const shapes = kitGeometry(ctx, 0).groups.get(group) ?? [];
  return shapes.flatMap(s => s.hulls);
}

/** Gun pieces (cradle frame) placed for a turret yaw and gun pitch, tested against the hull pieces. */
export class GunClearance {
  private readonly hull: Placed[];
  private readonly gun: Placed[];
  private readonly recoiled: Placed[];
  private readonly travel: number;
  /** The gun's reach from the trunnion and its largest radius (for the relevance prefilter). */
  private readonly reach: number;
  private readonly sweepReach: number;
  private readonly radius: number;
  private readonly m = new Float64Array(16);
  private readonly recoilFrame = new Float64Array(16);
  private lastYaw = NaN;
  private sy = 0;
  private cy = 1;
  private readonly bounds: AxisBound[];
  private readonly recoiledBounds: AxisBound[];
  private readonly sweepRadii: number[];
  private readonly recoiledSweepRadii: number[];
  private readonly pa = new Float64Array(3);
  private readonly pb = new Float64Array(3);
  constructor(private readonly ctx: KitContext) {
    const I = translate(0, 0, 0);
    this.hull = collect(ctx, 'hull').map(c => new Placed(c).set(I));
    const cradle = collect(ctx, 'cradle'), barrel = collect(ctx, 'barrel');
    this.gun = [...cradle, ...barrel].map(c => new Placed(c));
    this.recoiled = barrel.map(c => new Placed(c));
    this.bounds = [...cradle, ...barrel].map(axisBound);
    this.recoiledBounds = barrel.map(axisBound);
    this.travel = ctx.weapon.recoilTravel;
    const sweepRadius = (b: AxisBound) => Math.hypot(Math.max(Math.abs(b.z0), Math.abs(b.z1)) + this.travel, b.r);
    this.sweepRadii = this.bounds.map(sweepRadius);
    this.recoiledSweepRadii = this.recoiledBounds.map(sweepRadius);
    // A sphere about the trunnion must enclose radial offsets as well as the
    // axial tube length, including the rearward recoil endpoint.
    this.sweepReach = Math.max(...this.bounds.map(b => Math.hypot(Math.max(Math.abs(b.z0), Math.abs(b.z1)), b.r)),
      ...this.recoiledBounds.map(b => Math.hypot(Math.max(Math.abs(b.z0 - this.travel), Math.abs(b.z1 - this.travel)), b.r)));
    let reach = 0, radius = 0;
    for (const c of [...cradle, ...barrel]) {
      reach = Math.max(reach, Math.abs(c.box[2]), Math.abs(c.box[5]));
      radius = Math.max(radius, Math.abs(c.box[0]), Math.abs(c.box[3]), Math.abs(c.box[1]), Math.abs(c.box[4]));
    }
    this.reach = reach; this.radius = radius;
    // Radius of the forward parts (sleeve and tube), excluding the rotation-invariant mantlet.
    this.frontRadius = Math.max(...[...cradle.filter(c => c.tag !== 'mantlet'), ...barrel].map(c => axisBound(c).r));
  }
  private readonly frontRadius: number;

  private cradle(yaw: number, pitch: number): Mat4 {
    const t = this.ctx.turret.trunnion, m = this.m;
    if (yaw !== this.lastYaw) { this.lastYaw = yaw; this.sy = Math.sin(yaw); this.cy = Math.cos(yaw); }
    const sy = this.sy, cy = this.cy, sp = Math.sin(pitch), cp = Math.cos(pitch);
    // T(ring) Ry(yaw) T(trunnion) Rx(-pitch), directly in reusable storage.
    m[0] = cy; m[1] = 0; m[2] = -sy;
    m[4] = -sy * sp; m[5] = cp; m[6] = -cy * sp;
    m[8] = sy * cp; m[9] = sp; m[10] = cy * cp;
    m[12] = RING_FRAME[0] + cy * t[0] + sy * t[2];
    m[13] = RING_FRAME[1] + t[1];
    m[14] = RING_FRAME[2] - sy * t[0] + cy * t[2]; m[15] = 1;
    return m;
  }

  /** Hull pieces the gun can touch at some pitch for this yaw (near its vertical plane, within reach). */
  relevant(yaw: number, clearance = PITCH_CLEARANCE): Placed[] {
    const t = this.ctx.turret.trunnion, s = Math.sin(yaw), c = Math.cos(yaw);
    const T = [RING_FRAME[0] + c * t[0] + s * t[2], RING_FRAME[1] + t[1], RING_FRAME[2] - s * t[0] + c * t[2]];
    const r = this.radius + clearance, L = this.sweepReach + clearance;
    return this.hull.filter(h => {
      const b = h.box;
      const dx = (b[0] + b[3]) / 2 - T[0], dz = (b[2] + b[5]) / 2 - T[2], hx = (b[3] - b[0]) / 2, hz = (b[5] - b[2]) / 2;
      const nc = dx * c - dz * s, nh = hx * Math.abs(c) + hz * Math.abs(s), dMax = dx * s + dz * c + hx * Math.abs(s) + hz * Math.abs(c);
      let dist2 = 0;
      for (let k = 0; k < 3; k++) { const v = Math.max(b[k] - T[k], 0, T[k] - b[k + 3]); dist2 += v * v; }
      return nc - nh <= r && nc + nh >= -r && dMax >= -L && dist2 <= L * L;
    });
  }

  /** Bisect between a blocked pitch and a clear one above it. */
  private refineFrom(yaw: number, blocked: number, clearAbove: number, pieces: readonly Placed[]): number {
    let a = blocked, b = clearAbove;
    for (let n = 0; n < 7; n++) { const mid = (a + b) / 2; if (this.clear(yaw, mid, PITCH_CLEARANCE, pieces)) b = mid; else a = mid; }
    return b;
  }

  /** True when the gun keeps `clearance` from every (given) hull piece at (yaw, pitch). */
  clear(yaw: number, pitch: number, clearance = PITCH_CLEARANCE, pieces: readonly Placed[] = this.hull, halfAngle = 0): boolean {
    const m = this.cradle(yaw, pitch);
    const recoil = this.recoilFrame; recoil.set(m);
    recoil[12] -= m[8] * this.travel; recoil[13] -= m[9] * this.travel; recoil[14] -= m[10] * this.travel;
    const lo = pitch - halfAngle, hi = pitch + halfAngle, s0 = Math.sin(lo), s1 = Math.sin(hi);
    const c0 = Math.min(Math.cos(lo), Math.cos(hi)), c1 = lo <= 0 && hi >= 0 ? 1 : Math.max(Math.cos(lo), Math.cos(hi));
    // Capsule pre-tests (cheap) before placing a piece and running SAT.
    const test = (p: Placed, bound: AxisBound, frame: Mat4, sweepRadius: number): boolean => {
      // Each piece rotates about the trunnion, so a short sleeve needs a much
      // smaller interval margin than the muzzle of a long rail. The radius is an
      // upper bound for every vertex, including the rearward recoil endpoint.
      const gap = clearance + sweepRadius * halfAngle;
      const a = this.pa, b = this.pb, r = bound.r + gap;
      a[0] = frame[8] * bound.z0 + frame[12]; a[1] = frame[9] * bound.z0 + frame[13]; a[2] = frame[10] * bound.z0 + frame[14];
      b[0] = frame[8] * bound.z1 + frame[12]; b[1] = frame[9] * bound.z1 + frame[13]; b[2] = frame[10] * bound.z1 + frame[14];
      const x0 = Math.min(a[0], b[0]) - r, x1 = Math.max(a[0], b[0]) + r, y0 = Math.min(a[1], b[1]) - r, y1 = Math.max(a[1], b[1]) + r, z0 = Math.min(a[2], b[2]) - r, z1 = Math.max(a[2], b[2]) + r;
      const shift = frame === recoil ? this.travel : 0, za = bound.z0 - shift, zb = bound.z1 - shift, sr = bound.r + clearance;
      const q0 = Math.min(za * c0, za * c1, zb * c0, zb * c1), q1 = Math.max(za * c0, za * c1, zb * c0, zb * c1);
      const ix0 = m[12] + Math.min(this.sy * q0, this.sy * q1) - sr, ix1 = m[12] + Math.max(this.sy * q0, this.sy * q1) + sr;
      const iy0 = m[13] + Math.min(za * s0, za * s1, zb * s0, zb * s1) - sr, iy1 = m[13] + Math.max(za * s0, za * s1, zb * s0, zb * s1) + sr;
      const iz0 = m[14] + Math.min(this.cy * q0, this.cy * q1) - sr, iz1 = m[14] + Math.max(this.cy * q0, this.cy * q1) + sr;
      let placed = false;
      for (const h of pieces) {
        const hb = h.box;
        if (hb[0] > ix1 || hb[3] < ix0 || hb[1] > iy1 || hb[4] < iy0 || hb[2] > iz1 || hb[5] < iz0) continue;
        if (hb[0] > x1 || hb[3] < x0 || hb[1] > y1 || hb[4] < y0 || hb[2] > z1 || hb[5] < z0) continue;
        if (segmentBoxDistance(a, b, hb) > r) continue;
        if (!placed) { p.set(frame, false); placed = true; }
        if (!boxesOverlap(p.box, hb, -gap)) continue;
        if (gjkDistance(p, h, gap) <= gap) return false;
      }
      return true;
    };
    for (let i = 0; i < this.gun.length; i++) if (!test(this.gun[i], this.bounds[i], m, this.sweepRadii[i])) return false;
    for (let i = 0; i < this.recoiled.length; i++) if (!test(this.recoiled[i], this.recoiledBounds[i], recoil, this.recoiledSweepRadii[i])) return false;
    return true;
  }

  /**
   * The lowest pitch from which the gun stays clear all the way up to `hi` (scanned down from `hi` in 1°
   * steps, then bisected), or `lo` when it is clear throughout. Windows under overhangs never count.
   */
  lowestClear(yaw: number, lo: number, hi: number): number {
    const pieces = this.relevant(yaw);
    if (!pieces.length) return lo;
    // Conservative geometric pre-bound: the sleeve and tube lie within `rf` of the bore for
    // s ∈ [sNear, reach]; a pitch at which that capsule passes above every relevant piece's top (over the
    // piece's horizontal extent ahead of the trunnion) needs no exact test.
    const t = this.ctx.turret.trunnion, sy = Math.sin(yaw), cy = Math.cos(yaw);
    const Tx = RING_FRAME[0] + cy * t[0] + sy * t[2], Ty = RING_FRAME[1] + t[1], Tz = RING_FRAME[2] - sy * t[0] + cy * t[2];
    const sNear = this.ctx.mantletRadius - 0.04 - this.travel, rf = this.frontRadius + PITCH_CLEARANCE, L = this.reach;
    const extents = pieces.map(h => {
      const b = h.box;
      const center = ((b[0] + b[3]) / 2 - Tx) * sy + ((b[2] + b[5]) / 2 - Tz) * cy;
      const half = (b[3] - b[0]) / 2 * Math.abs(sy) + (b[5] - b[2]) / 2 * Math.abs(cy);
      return { ahead: center - half, far: center + half, top: b[4] };
    });
    const boundClear = (p: number): boolean => {
      const sp = Math.sin(p), cp = Math.cos(p);
      for (const e of extents) {
        if (e.far + rf < sNear * cp - rf) continue; // entirely behind the forward gun parts
        let s: number;
        if (sp <= 0) s = Math.min(L, (e.far + rf * (1 + Math.abs(sp))) / cp);
        else s = Math.min(L, Math.max(sNear, (e.ahead - rf * (1 + sp)) / cp));
        s = Math.max(sNear, s);
        if (Ty + s * sp - rf * cp <= e.top + PITCH_CLEARANCE) return false;
      }
      return true;
    };
    const step = DEG;
    let top = lo;
    for (let p = hi; p > lo - 1e-9; p -= step) { if (!boundClear(Math.max(lo, p))) { top = Math.min(hi, Math.max(lo, p) + step); break; } }
    if (top <= lo) return this.clear(yaw, lo, PITCH_CLEARANCE, pieces) ? lo : this.refineFrom(yaw, lo, lo + step, pieces);
    // Certify intervals using each piece's angular travel bound, splitting an
    // uncertain interval until its original 1° samples can be checked exactly.
    const samples: number[] = [];
    for (let p = top; p > lo - 1e-9; p -= step) samples.push(Math.max(lo, p));
    if (samples[samples.length - 1] > lo) samples.push(lo);
    let clearAt = Math.min(hi, top + step);
    const scan = (i: number, j: number): number | null => {
      const a = samples[j], b = samples[i];
      if (j > i && this.clear(yaw, (a + b) / 2, PITCH_CLEARANCE, pieces, (b - a) / 2)) { clearAt = a; return null; }
      if (j - i >= 3) {
        const mid = Math.floor((i + j) / 2), upper = scan(i, mid);
        return upper ?? scan(mid + 1, j);
      }
      for (let k = i; k <= j; k++) {
        const q = samples[k];
        if (!this.clear(yaw, q, PITCH_CLEARANCE, pieces)) {
          let lo2 = q, hi2 = clearAt;
          for (let n = 0; n < 7; n++) { const mid = (lo2 + hi2) / 2; if (this.clear(yaw, mid, PITCH_CLEARANCE, pieces)) hi2 = mid; else lo2 = mid; }
          return hi2;
        }
        clearAt = q;
      }
      return null;
    };
    return scan(0, samples.length - 1) ?? lo;
  }
}

/** The pitch table for an assembly's (hull, gear, turret, weapon), computed once and cached. */
export function pitchTable(ctx: KitContext): PitchTable {
  const geo = kitGeometry(ctx, 0);
  // A gear's different wheel finish does not change the hull/gun clearance. Reuse
  // only when all actual convex pieces and every joint dimension match exactly.
  const key = JSON.stringify([ctx.turret.trunnion, ctx.turret.elevation, ctx.mantletRadius, ctx.weapon.recoilTravel,
    ...(['hull', 'cradle', 'barrel'] as const).map(group => collisionShapesKey(geo.groups.get(group) ?? []))]);
  let table = tables.get(key);
  if (table) return table;
  const [lo, hi] = ctx.turret.elevation;
  const gun = new GunClearance(ctx);
  const geometric = new Float64Array(360);
  for (let d = 0; d < 360; d++) geometric[d] = gun.lowestClear(d * DEG, lo, hi);
  const n = Math.round(2 * Math.PI / PITCH_TABLE_STEP), min = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = i * 2;
    const g = Math.max(geometric[(d + 359) % 360], geometric[d], geometric[(d + 1) % 360]);
    min[i] = g <= lo + 1e-9 ? lo : Math.min(hi, g + PITCH_MARGIN);
  }
  // Smallest PITCH_MAX_SLOPE-Lipschitz envelope above the physical samples, periodic in yaw.
  const raw = min.slice(), fall = PITCH_MAX_SLOPE * PITCH_TABLE_STEP;
  for (let i = 0; i < n; i++) {
    let v = raw[i];
    for (let j = 0; j < n; j++) { const k = Math.abs(i - j), steps = Math.min(k, n - k); v = Math.max(v, raw[j] - fall * steps); }
    min[i] = Math.min(hi, v);
  }
  table = Object.freeze({ min, turretMin: lo, turretMax: hi, geometric });
  tables.set(key, table);
  return table;
}

/** Evaluate a table at any yaw (continuous, periodic). */
export function evalPitchLimits(table: PitchTable, yaw: number): { min: number; max: number } {
  const n = table.min.length, u = ((yaw / PITCH_TABLE_STEP) % n + n) % n, i = Math.floor(u), f = u - i;
  const a = table.min[i], b = table.min[(i + 1) % n];
  return { min: Math.max(table.turretMin, a + (b - a) * f), max: table.turretMax };
}
