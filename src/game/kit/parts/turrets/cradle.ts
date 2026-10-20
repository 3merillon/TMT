/**
 * Open cradle turret (W1-KIT): a low ring platform with two yoke arms carrying the drum mantlet high, a
 * gunner's seat and a counterweight. Ring S, trunnion S–M, elevation −5° … +88°; fast reload.
 */
import { EDGE, alongX, bolts, box, cylinder, lathe, loft, prism, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { DEG } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, TurretSpec } from '../types';
import { bearingRace, drumMantlet, utilityPad } from './common';

const DRUM_HALF = 0.13, ARM = 0.03, PLATFORM = 0.05;

export const CRADLE_SPEC: TurretSpec = {
  id: 'cradle', name: 'Open cradle',
  trunnion: [0, 0.3, 0.06], elevation: [-5 * DEG, 88 * DEG], mantlet: 'drum', drumHalfWidth: DRUM_HALF,
  utility: [-0.18, PLATFORM + 0.016, -0.24],
  hatch: null,
  hpBonus: 0,
  stats: { cost: 2, mass: 1.0, hp: 0, tempo: 0.95 },
  massBoxes: [{ center: [0, 0.12, -0.02], half: [0.24, 0.12, 0.24], fraction: 1 }],
};

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret');
  bearingRace(s, ctx);
  s.tag = 'platform';
  s.material(MAT_ID.paint);
  lathe(s, null, [[0.27, 0.028], [0.275, 0.04], [0.265, PLATFORM], [0, PLATFORM]], 20, { smooth: false });
  s.tag = 'utility-pad';
  box(s, tr(-0.18, PLATFORM - 0.002, -0.22), [0.094, 0.036, 0.132], 0.004);
  utilityPad(s, ctx, () => PLATFORM);
  // Yoke arms (side plates) rising to the trunnion.
  s.tag = 'yoke';
  const t = CRADLE_SPEC.trunnion;
  for (const side of [-1, 1]) {
    const x0 = side > 0 ? DRUM_HALF + 0.01 : -(DRUM_HALF + 0.01 + ARM), x1 = x0 + ARM;
    // (y, z) profile.
    prism(s, null, 'x', [[PLATFORM - 0.002, -0.15], [PLATFORM - 0.002, 0.16], [t[1] + 0.07, t[2] + 0.07], [t[1] + 0.07, t[2] - 0.08]], x0, x1, 0.008);
    const xo = side * (DRUM_HALF + 0.01 + ARM);
    // A shallow closed bearing housing seats into the yoke, with the journal
    // hidden inside it. Only the recessed service cap is exposed outside.
    s.tag = 'trunnion-housing';
    const xStart = side > 0 ? xo - .003 : xo - .018;
    lathe(s, alongX(xStart, t[1], t[2]), side > 0 ? [[.050, 0], [.050, .012], [.043, .021]] : [[.043, 0], [.050, .009], [.050, .021]], 10, { caps: side > 0 ? [false, true] : [true, false], smooth: false });
    if (!s.coarse) {
      s.material(MAT_ID.darkSteel);
      cylinder(s, null, [side * (DRUM_HALF + .003), t[1], t[2]], [side * (DRUM_HALF + .013), t[1], t[2]], .028, 8, { caps: [false, false] });
      const xCap = side > 0 ? xo + .019 : xo - .019;
      cylinder(s, null, [xCap - side * .002, t[1], t[2]], [xCap, t[1], t[2]], .023, 8, { caps: [false, true] });
      if (s.fine) bolts(s, null, [[xCap, t[1] + .035, t[2]], [xCap, t[1] - .035, t[2]]], [side, 0, 0], .004, .003);
    }
    s.material(MAT_ID.paint);
    s.tag = 'yoke';
  }
  // Gunner's seat and counterweight at the rear.
  s.tag = 'seat';
  s.material(MAT_ID.rubber);
  box(s, tr(0.0, PLATFORM + 0.08, -0.17), [0.14, 0.03, 0.1], 0.01);
  s.material(MAT_ID.darkSteel);
  cylinder(s, null, [0, PLATFORM, -0.17], [0, PLATFORM + 0.065, -0.17], 0.015, 8);
  s.tag = 'counterweight';
  s.material(MAT_ID.paint);
  loft(s, null, [
    [[-0.12, PLATFORM, -0.27], [0.12, PLATFORM, -0.27], [0.12, PLATFORM, -0.21], [-0.12, PLATFORM, -0.21]],
    [[-0.1, PLATFORM + 0.07, -0.26], [0.1, PLATFORM + 0.07, -0.26], [0.1, PLATFORM + 0.07, -0.225], [-0.1, PLATFORM + 0.07, -0.225]],
  ], { edges: [EDGE.chamfer] });
  // Drum mantlet (cradle).
  drumMantlet(out.get('cradle'), ctx.mantletRadius, DRUM_HALF);
  void ({} as Vec3);
}

export const CRADLE: PartModule<TurretSpec> = { spec: CRADLE_SPEC, build };
