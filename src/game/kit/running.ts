/**
 * Running-gear rig (W1-KIT): from the 4 physics station heights per side to every repeated part's pose.
 *
 * - Scout (torsion): each wheel trails its arm; arm angle = asin((y − y0)/L), so the wheel follows the arc
 *   (its z moves by L(1 − cos α), ≤ 3 cm) while the physics station stays vertical.
 * - Grip (bogie): the bogie pivot sits at the mean height of its two stations, the beam tilts by
 *   asin(Δy / 2h) and the volute spring spans the pivot to its hull bracket.
 * - Crawler (rocker): each station is a level rocker (two interleaved wheels) carried by a trailing arm.
 * - Belt: road wheels (belt radius = r + shoe), return rollers, sprocket and the tensioned idler (belt.ts).
 *
 * Instance order in every group: side 0 = the −X belt (driver-right), then side 1 = +X; rear → front.
 * Links are the exception (see `linkSlot`): every other link of both belts first, then the rest, so LOD2 draws
 * the first half as double-pitch links from the same pose buffer.
 * TankState sides: 0 = driver-left (+X), 1 = driver-right (−X); `wheelY` uses the state order.
 * Posing is stateless: identical inputs give identical outputs whatever was posed before.
 */
import { Belt } from './belt';
import { LINK_SECTION, gearSlabs } from './parts/gear/common';
import type { GearSpec, InstancedGroup, KitContext } from './parts/types';
import { clamp, mul, rotX, rotY, rotZ, scaleM, translate, type Mat4 } from './geometry/math';

/** Belt circle radius over a road wheel / roller = its rim radius + shoe. */
export const BELT_SHOE = 0.025;
/** Clearance added to half a link's length for the belt's notch rule (Belt.linkReach). */
export const LINK_REACH_CLEARANCE = 0.004;
/** How far a visual wheel's hub sits below its physics station centre: the station radius minus the wheel's. */
export const hubDrop = (g: GearSpec, w: GearSpec['wheels'][number]): number => g.wheelRadius - w.radius;
/** Suspension travel limits (kit v1 physics: droop 0.12, compression 0.085, 0.4 per unit of wheelSuspension). */
export const SUSPENSION = Object.freeze({ droop: 0.12, compression: 0.085, scale: 0.4 });

/**
 * Buffer slot of link `i` (0 … linkCount − 1 along the belt from its phase origin) of mesh side `meshSide`
 * (0 = −X belt): the even links of side 0, the even links of side 1, then the odd links of side 0 and side 1.
 */
export function linkSlot(linkCount: number, meshSide: 0 | 1, i: number): number {
  const even = Math.ceil(linkCount / 2), odd = linkCount - even;
  return i % 2 === 0 ? meshSide * even + i / 2 : 2 * even + meshSide * odd + (i - 1) / 2;
}
/** Link instances LOD2 draws: the leading even-link slots of both belts (`linkSlot`). */
export function lod2LinkInstances(linkCount: number): number { return 2 * Math.ceil(linkCount / 2); }

export interface GearLayout {
  spec: GearSpec;
  /** Station z per side (rear → front). */
  stationZ: readonly number[];
  linkCount: number;
  pitch: number;
  /** Instance counts per group (both sides). */
  counts: Readonly<Record<InstancedGroup, number>>;
  /** Highest belt top surface over the suspension extremes. */
  topRunY: number;
}

export interface SideInput {
  /** Four station wheel-centre heights (rear → front). */
  y: ArrayLike<number>;
  /** Belt phase (cumulative travel, metres). */
  phase: number;
  /** Terrain height under the belt at z (local y), or null. */
  ground?: ((z: number) => number) | null;
}

const stationZ = (g: GearSpec) => [0, 1, 2, 3].map(i => (i / 3 * 2 - 1) * g.halfLength);

function wheelCount(g: GearSpec): number { return g.wheels.length; }

/** The arm and rocker slab centres of a build context (contexts are cached and frozen). */
const memberSlabs = new WeakMap<KitContext, { armX: number; rockX: number }>();

/** The arm and rocker slab centres (x) of a build context. */
export function memberSlabX(ctx: KitContext): { armX: number; rockX: number } {
  let slabs = memberSlabs.get(ctx);
  if (!slabs) { const s = gearSlabs(ctx); memberSlabs.set(ctx, slabs = { armX: (s.arm[0] + s.arm[1]) / 2, rockX: (s.rocker[0] + s.rocker[1]) / 2 }); }
  return slabs;
}

/** The engine rig words of a gear (rust/terrain-core/src/rig.rs Rig::new). */
export function nativeGearWords(g: GearSpec): number[] {
  return [g.suspension === 'torsion' ? 0 : g.suspension === 'bogie' ? 1 : 2, g.halfLength, g.wheelY0, g.armLength, g.rockerHalf, g.wheelRadius, g.halfSpacing,
    g.springTop, g.tensioner.dz, g.tensioner.dy, g.tensioner.travel, g.idler.z, g.idler.y, g.idler.r, g.sprocket.z, g.sprocket.y, g.sprocket.r,
    BELT_SHOE, LINK_SECTION.lengthFraction, LINK_REACH_CLEARANCE, gearRig(g).layout.linkCount,
    g.wheels.length, ...g.wheels.flatMap(w => [w.station, w.dz, w.dx, w.radius]), g.rollers.length, ...g.rollers.flatMap(r => [r.z, r.y, r.r])];
}

/** Per-gear rig: two shared belt solvers and scratch buffers. */
export class GearRig {
  readonly layout: GearLayout;
  private readonly belts: [Belt, Belt];
  private readonly wheelZY: Float64Array;
  private readonly g: GearSpec;
  private readonly z: readonly number[];
  private readonly flipY = rotY(Math.PI);
  private readonly flipZ = rotZ(Math.PI);
  private readonly tmpA = new Float64Array(16);
  private readonly tmpB = new Float64Array(16);
  private readonly tmpC = new Float64Array(16);
  private readonly tmpD = new Float64Array(16);

  constructor(g: GearSpec) {
    this.g = g;
    const z = stationZ(g);
    this.z = z;
    const nW = wheelCount(g);
    this.wheelZY = new Float64Array(nW * 2);
    const circles = this.restCircles();
    const pivot: [number, number] = [g.idler.z + g.tensioner.dz, g.idler.y + g.tensioner.dy];
    this.belts = [new Belt(circles, pivot, g.tensioner.travel), new Belt(circles, pivot, g.tensioner.travel)];
    const nominal = this.belts[0].nominal;
    // An even count per belt, so LOD2's double-pitch links (every other link) tile the loop exactly.
    const linkCount = 2 * Math.round(nominal / g.linkPitch / 2);
    // Ground-lifted spans keep the belt out of notches between wheels that a rigid link cannot enter.
    for (const belt of this.belts) belt.linkReach = nominal / linkCount * LINK_SECTION.lengthFraction * 0.5 + LINK_REACH_CLEARANCE;
    const rollers = g.rollers.length;
    const counts: Record<InstancedGroup, number> = {
      links: linkCount * 2, wheels: nW * 2, hubs: nW * 2, sprockets: 2, idlers: 2, rollers: rollers * 2,
      arms: g.suspension === 'bogie' ? 0 : 8, bogies: g.suspension === 'torsion' ? 0 : (g.suspension === 'bogie' ? 4 : 8),
      springs: g.suspension === 'bogie' ? 4 : 0, tensioners: 2,
    };
    // Highest top run over the extremes (all compressed, all drooped, alternating, rest).
    let top = -Infinity;
    const { droop, compression } = SUSPENSION;
    for (const pattern of [[compression, compression, compression, compression], [0, 0, 0, 0], [-droop, -droop, -droop, -droop], [compression, -droop, compression, -droop], [-droop, compression, -droop, compression], [compression, compression, -droop, -droop], [-droop, -droop, compression, compression]]) {
      const belt = this.belts[0];
      this.solve(belt, { y: pattern.map(d => g.wheelY0 + d), phase: 0 });
      top = Math.max(top, belt.top());
    }
    this.layout = Object.freeze({ spec: g, stationZ: Object.freeze(z), linkCount, pitch: nominal / linkCount, counts: Object.freeze(counts), topRunY: top + LINK_SECTION.grouser });
  }

  private restCircles(): { z: number; y: number; r: number }[] {
    const g = this.g, z = stationZ(g), out: { z: number; y: number; r: number }[] = [];
    for (const w of g.wheels) out.push({ z: z[w.station] + w.dz, y: g.wheelY0 - hubDrop(g, w), r: w.radius + BELT_SHOE });
    for (const r of g.rollers) out.push({ z: r.z, y: r.y, r: r.r });
    out.push({ z: g.sprocket.z, y: g.sprocket.y, r: g.sprocket.r }, { z: g.idler.z, y: g.idler.y, r: g.idler.r });
    return out;
  }

  /** Visual wheel centres (z, y) for four station heights. */
  wheelCentres(y: ArrayLike<number>, out: Float64Array = this.wheelZY): Float64Array {
    const g = this.g, z = this.z;
    if (g.suspension === 'torsion') {
      for (let i = 0; i < 4; i++) {
        const a = Math.asin(clamp((y[i] - g.wheelY0) / g.armLength, -1, 1));
        out[i * 2] = z[i] + g.armLength * (1 - Math.cos(a)); out[i * 2 + 1] = y[i];
      }
    } else if (g.suspension === 'bogie') {
      for (let b = 0; b < 2; b++) {
        const ya = y[b * 2], yc = y[b * 2 + 1], zb = (z[b * 2] + z[b * 2 + 1]) / 2, yb = (ya + yc) / 2, h = g.rockerHalf;
        const s = clamp((yc - ya) / (2 * h), -1, 1), c = Math.sqrt(1 - s * s);
        out[b * 4] = zb - h * c; out[b * 4 + 1] = yb - h * s; out[b * 4 + 2] = zb + h * c; out[b * 4 + 3] = yb + h * s;
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const a = Math.asin(clamp((y[i] - g.wheelY0) / g.armLength, -1, 1)), zi = z[i] + g.armLength * (1 - Math.cos(a));
        out[i * 4] = zi - g.rockerHalf; out[i * 4 + 1] = y[i]; out[i * 4 + 2] = zi + g.rockerHalf; out[i * 4 + 3] = y[i];
      }
    }
    for (let i = 0; i < g.wheels.length; i++) out[i * 2 + 1] -= hubDrop(g, g.wheels[i]);
    return out;
  }

  private solve(belt: Belt, input: SideInput): void {
    const centres = this.wheelCentres(input.y);
    belt.update(centres, wheelCount(this.g), input.ground ?? null);
  }

  /** The belt solver used for a mesh side (after `pose`, it holds that side's solution). */
  belt(meshSide: 0 | 1): Belt { return this.belts[meshSide]; }

  /** Link matrices of one mesh side from its seats (y, z, angle per link); x is the belt's centre line. */
  private links(out: Record<InstancedGroup, Mat4[]>, seats: Float64Array, meshSide: 0 | 1, x: number): void {
    const n = this.layout.linkCount, tmpA = this.tmpA, tmpB = this.tmpB, tmpC = this.tmpC;
    for (let i = 0; i < n; i++) putAt(out, 'links', linkSlot(n, meshSide, i), mul(translate(x, seats[i * 3], seats[i * 3 + 1], tmpA), rotX(seats[i * 3 + 2], tmpB), tmpC));
  }

  /** Mesh side sx: a part spinning by `spin` about its axle at (x, y, zz), into tmpC. */
  private turned(sx: number, x: number, y: number, zz: number, spin: number): Mat4 {
    translate(x, y, zz, this.tmpA);
    if (sx > 0) return mul(this.tmpA, rotX(spin, this.tmpB), this.tmpC);
    return mul(this.tmpA, mul(rotX(spin, this.tmpB), this.flipY, this.tmpD), this.tmpC);
  }

  /** Mesh side sx: a member hinged by `angle` at (x, y, zz), into tmpC. */
  private hinged(sx: number, x: number, y: number, zz: number, angle: number): Mat4 {
    translate(x, y, zz, this.tmpA);
    if (sx > 0) return mul(this.tmpA, rotX(angle, this.tmpB), this.tmpC);
    return mul(this.tmpA, mul(this.flipZ, rotX(-angle, this.tmpB), this.tmpD), this.tmpC);
  }

  /**
   * Pose both sides. `sides[s]` is the TankState side s (0 = +X). Writes tank-local instance matrices into
   * `out[group]` (arrays of Mat4 reused when present).
   */
  pose(ctx: KitContext, sides: readonly [SideInput, SideInput], out: Record<InstancedGroup, Mat4[]>): void {
    const g = this.g, L = this.layout, c = g.halfSpacing, z = this.z, nW = g.wheels.length, nR = g.rollers.length;
    const { armX, rockX } = memberSlabX(ctx), tmpA = this.tmpA, tmpB = this.tmpB, tmpC = this.tmpC, tmpD = this.tmpD;
    for (let meshSide = 0 as 0 | 1; meshSide < 2; meshSide = (meshSide + 1) as 0 | 1) {
      const sx = meshSide === 0 ? -1 : 1, stateSide = sx > 0 ? 0 : 1, input = sides[stateSide];
      const belt = this.belts[meshSide];
      this.solve(belt, input);
      const centres = this.wheelZY;
      // Links.
      const halfShoe = L.pitch * LINK_SECTION.lengthFraction * 0.5;
      this.links(out, belt.seatLinks(input.phase, L.linkCount, halfShoe), meshSide, sx * c);
      // Road wheels and hubs.
      for (let i = 0; i < nW; i++) {
        const w = g.wheels[i], m = this.turned(sx, sx * (c + w.dx), centres[i * 2 + 1], centres[i * 2], input.phase / w.radius);
        putAt(out, 'wheels', meshSide * nW + i, m); putAt(out, 'hubs', meshSide * nW + i, m);
      }
      // Rollers, sprocket, idler.
      for (let i = 0; i < nR; i++) { const r = g.rollers[i]; putAt(out, 'rollers', meshSide * nR + i, this.turned(sx, sx * c, r.y, r.z, input.phase / r.r)); }
      putAt(out, 'sprockets', meshSide, this.turned(sx, sx * c, g.sprocket.y, g.sprocket.z, input.phase / g.sprocket.r));
      const idler = belt.circles[belt.idler];
      putAt(out, 'idlers', meshSide, this.turned(sx, sx * c, idler.y, idler.z, input.phase / g.idler.r));
      // Tensioner arm: from its pivot to the idler axle.
      const pz = g.idler.z + g.tensioner.dz, py = g.idler.y + g.tensioner.dy;
      putAt(out, 'tensioners', meshSide, this.hinged(sx, sx * armX, py, pz, Math.atan2(idler.y - py, -(idler.z - pz))));
      // Suspension members.
      if (g.suspension === 'torsion' || g.suspension === 'rocker') {
        for (let i = 0; i < 4; i++) {
          const a = Math.asin(clamp((input.y[i] - g.wheelY0) / g.armLength, -1, 1));
          putAt(out, 'arms', meshSide * 4 + i, this.hinged(sx, sx * armX, g.wheelY0 - hubDrop(g, g.wheels[g.suspension === 'torsion' ? i : i * 2]), z[i] + g.armLength, a));
        }
      }
      if (g.suspension === 'bogie') {
        for (let b = 0; b < 2; b++) {
          const ya = input.y[b * 2], yc = input.y[b * 2 + 1], zb = (z[b * 2] + z[b * 2 + 1]) / 2, yb = (ya + yc) / 2;
          const tilt = Math.asin(clamp((yc - ya) / (2 * g.rockerHalf), -1, 1));
          putAt(out, 'bogies', meshSide * 2 + b, this.hinged(sx, sx * rockX, yb, zb, -tilt));
          const bottom = yb + 0.03, length = Math.max(0.01, g.springTop - bottom);
          const m = mul(translate(sx * rockX, bottom, zb, tmpA), scaleM(1, length, 1, tmpB), tmpD);
          putAt(out, 'springs', meshSide * 2 + b, sx > 0 ? m : mul(m, this.flipY, tmpC));
        }
      } else if (g.suspension === 'rocker') {
        for (let i = 0; i < 4; i++) {
          const a = Math.asin(clamp((input.y[i] - g.wheelY0) / g.armLength, -1, 1)), zi = z[i] + g.armLength * (1 - Math.cos(a));
          putAt(out, 'bogies', meshSide * 4 + i, this.hinged(sx, sx * rockX, input.y[i], zi, 0));
        }
      }
    }
  }
}

function putAt(out: Record<InstancedGroup, Mat4[]>, group: InstancedGroup, i: number, m: Mat4): void {
  const list = out[group] ??= [];
  if (list[i]) list[i].set(m); else list[i] = new Float64Array(m);
}

const rigs = new Map<string, GearRig>();
/** The shared rig for a gear (belt solvers are reused; poses depend on the inputs only). */
export function gearRig(g: GearSpec): GearRig {
  let rig = rigs.get(g.id);
  if (!rig) { rig = new GearRig(g); rigs.set(g.id, rig); }
  return rig;
}

/** Wheel-centre height for a TankState wheelSuspension value (kit v1 mapping). */
export function stationHeight(g: GearSpec, suspension: number): number {
  return g.wheelY0 + clamp((suspension - 0.5) * SUSPENSION.scale, -SUSPENSION.droop, SUSPENSION.compression);
}
