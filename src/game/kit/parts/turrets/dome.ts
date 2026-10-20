/**
 * Dome turret (W1-KIT): a cast dome (lathe) with a round ball mantlet seated in a carved socket, a commander
 * cupola with a hinged hatch, periscope blocks and lifting eyes. Ring M, trunnion S–L (Appendix A needs the
 * rail on it), elevation −15° … +75° over the front arc, +10 HP. The trunnion is kit v1's (0, 0.2, 0.2).
 */
import { bolts, box, cylinder, mm, rx, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { DEG } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, TurretSpec } from '../types';
import { ballTrunnionSeats, bearingRace, cupola, cutRoofOpening, hatchLid, periscopeBlocks, slottedLathe, sphereMantlet, utilityPad } from './common';

const AXIS_Z = 0;
/** Dome outer profile (r, y) about the vertical axis at z = AXIS_Z. */
export const DOME_PROFILE: readonly [number, number][] = [[0.35, 0.028], [0.365, 0.075], [0.356, 0.14], [0.318, 0.205], [0.255, 0.258], [0.165, 0.296], [0.06, 0.316], [0, 0.32]];
const CUPOLA = Object.freeze({ x: 0.13, z: -0.15, r: 0.09, y0: 0.27, h: 0.07 });

export const DOME_SPEC: TurretSpec = {
  id: 'dome', name: 'Dome turret',
  trunnion: [0, 0.2, 0.2], elevation: [-15 * DEG, 75 * DEG], mantlet: 'sphere', drumHalfWidth: 0,
  utility: [-0.15, 0.32, -0.17],
  hatch: { hinge: [CUPOLA.x, CUPOLA.y0 + CUPOLA.h, CUPOLA.z - CUPOLA.r * 0.8], axis: [1, 0, 0], open: 105 * DEG },
  hpBonus: 10,
  stats: { cost: 2, mass: 1.5, hp: 10, tempo: 1.0 },
  massBoxes: [{ center: [0, 0.15, 0], half: [0.3, 0.14, 0.3], fraction: 1 }],
};

/** Dome surface height at a turret-frame (x, z), for seating roof details. */
export function domeHeight(x: number, z: number): number {
  const r = Math.hypot(x, z - AXIS_Z);
  for (let i = DOME_PROFILE.length - 1; i > 0; i--) {
    const [r0, y0] = DOME_PROFILE[i], [r1, y1] = DOME_PROFILE[i - 1];
    if (r >= r0 && r <= r1) return y0 + (y1 - y0) * (r - r0) / (r1 - r0);
  }
  return DOME_PROFILE[0][1];
}

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), t = ctx.turret;
  bearingRace(s, ctx);
  s.tag = 'dome';
  s.material(MAT_ID.paint);
  // Gun slot around the ball mantlet: 7 mm clear of the ball at the sides and behind it.
  slottedLathe(s, AXIS_Z, DOME_PROFILE, 24, { halfWidth: ctx.mantletRadius + 0.007, back: t.trunnion[2] - ctx.mantletRadius - 0.007 });
  cutRoofOpening(s, CUPOLA.x, CUPOLA.z, CUPOLA.r * 0.66, CUPOLA.y0 - 0.07);
  utilityPad(s, ctx, domeHeight);
  ballTrunnionSeats(s, ctx);
  // Cupola, periscopes, lifting eyes, a bolted cheek seam.
  cupola(s, CUPOLA.x, CUPOLA.z, CUPOLA.y0, CUPOLA.r, CUPOLA.h, domeHeight);
  periscopeBlocks(s, [[-0.02, domeHeight(-0.02, 0.06) - 0.01, 0.06]]);
  if (s.detail >= 0.5) {
    s.tag = 'lifting-eye';
    s.material(MAT_ID.darkSteel);
    for (const side of [-1, 1]) {
      const x = side * 0.22, z = -0.02, y = domeHeight(x, z);
      cylinder(s, mm(tr(x, y + 0.012, z), rx(0)), [-0.012, 0, 0], [0.012, 0, 0], 0.012, 8, { smooth: false });
    }
  }
  if (s.fine) {
    s.material(MAT_ID.paint);
    const pts: Vec3[] = [];
    for (let i = 0; i < 10; i++) { const a = (i / 10 - 0.5) * 2.2; pts.push([Math.sin(a) * 0.353, 0.1, AXIS_Z + Math.cos(a) * 0.353]); }
    bolts(s, null, pts.filter(p => p[2] < 0.12 || Math.abs(p[0]) > 0.2), [0, 0, 1]);
  }
  // Mantlet (cradle).
  const c = out.get('cradle');
  sphereMantlet(c, ctx.mantletRadius);
  // Hatch lid (hatch frame).
  if (s.detail > 0.3) hatchLid(out.get('hatch'), CUPOLA.r * 0.8);
  void box;
}

export const DOME: PartModule<TurretSpec> = { spec: DOME_SPEC, build };
