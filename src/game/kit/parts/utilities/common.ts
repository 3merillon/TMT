/**
 * Utility builders (W1-KIT). A utility sits on the turret's utility socket (turret frame). Its rigid base is
 * built in the turret group (translated to the socket); its moving head in the `head` group, whose frame
 * origin is `utility socket + spec.headOrigin`.
 */
import { bolts, box, cylinder, lathe, mm, sweep, tr, type Shape } from '../../geometry/shapes';
import { MAT_ID } from '../../types';
import type { Mat4 } from '../../geometry/math';
import type { KitContext, MassBox } from '../types';

/** All utility designs are cosmetic today. The existing antenna ballast is the common gameplay envelope. */
export const COSMETIC_UTILITY_STATS = Object.freeze({ cost: 1, mass: .3 });
export const COSMETIC_UTILITY_MASS: readonly MassBox[] = [{ center: [0, .1, 0], half: [.03, .1, .03], fraction: 1 }];

/** Turret-frame transform of the utility socket. */
export function socketFrame(ctx: KitContext): Mat4 {
  const u = ctx.turret.utility;
  return tr(u[0], u[1], u[2]);
}
/** Turret-frame transform of the head joint origin (rest pose). */
export function headFrame(ctx: KitContext): Mat4 {
  const u = ctx.turret.utility, o = ctx.utility.headOrigin;
  return tr(u[0] + o[0], u[1] + o[1], u[2] + o[2]);
}

/** Machined service flange; all bolt seats land inside the turret's welded utility pad. */
export function serviceBase(s: Shape, m: Mat4, radius = .038): void {
  s.material(MAT_ID.darkSteel);
  lathe(s, m, [[radius * .9, .002], [radius, .007], [radius, .019], [radius * .84, .024]], 12, { smooth: false });
  if (!s.fine) return;
  const d = radius * .59;
  s.material(MAT_ID.chrome);
  bolts(s, m, [[-d, .023, -d], [d, .023, -d], [-d, .023, d], [d, .023, d]], [0, 1, 0], .004, .003);
  s.material(MAT_ID.brass);
  cylinder(s, m, [radius * .7, .011, 0], [radius + .004, .011, 0], .005, 6);
}

/** Ribbed electrical insulator surrounding an uninterrupted central conductor. */
export function insulator(s: Shape, m: Mat4, start: number, end: number, radius: number): void {
  s.material(MAT_ID.paint);
  const profile: [number, number][] = [[radius * .67, start]];
  const ribs = s.fine ? 3 : 2;
  for (let i = 0; i < ribs; i++) {
    const y = start + (end - start) * (i + .5) / ribs, lip = (end - start) / ribs * .20;
    profile.push([radius * .67, y - lip], [radius, y], [radius * .67, y + lip]);
  }
  profile.push([radius * .67, end]);
  lathe(s, m, profile, 8, { caps: [false, false], hullProfile: [[radius, start], [radius, end]] });
}

/** A fixed cable with two actual retaining clips, not a loose unsupported curve. */
export function mastCable(s: Shape, m: Mat4, height: number, side = 1): void {
  if (!s.fine) return;
  s.with({ cosmetic: true, noHull: true }, () => {
    s.material(MAT_ID.rubber);
    sweep(s, m, [[side * .03, .016, -.018], [side * .024, .035, -.017], [side * .020, height * .55, -.017], [side * .012, height, -.012]], .0025, 6, { bend: .006 });
    s.material(MAT_ID.brass);
    for (const y of [height * .35, height * .70]) box(s, mm(m, tr(side * .019, y, -.015)), [.017, .005, .011], 0);
  });
}
