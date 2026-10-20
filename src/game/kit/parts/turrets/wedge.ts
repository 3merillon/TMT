/**
 * Wedge turret (W1-KIT): welded plates with a low sloped front, cheek blocks flanking a drum mantlet, a raised
 * bustle rack and a roof hatch. Ring M (see sockets.ts), trunnion M–L, best depression: −30° … +62° over the
 * front arc.
 */
import { EDGE, bolts, box, cylinder, grabRail, lathe, loft, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { DEG } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, TurretSpec } from '../types';
import { bearingRace, cutRoofOpening, drumMantlet, hatchLid, hatchSeat, periscopeBlocks, utilityPad } from './common';

const TOP = 0.23, BASE = 0.028, DRUM_HALF = 0.16;
const HATCH = Object.freeze({ x: 0.1, z: -0.1, r: 0.0816 });

export const WEDGE_SPEC: TurretSpec = {
  id: 'wedge', name: 'Wedge turret',
  trunnion: [0, 0.205, 0.28], elevation: [-30 * DEG, 62 * DEG], mantlet: 'drum', drumHalfWidth: DRUM_HALF,
  utility: [-0.14, TOP + 0.013, -0.16],
  hatch: { hinge: [HATCH.x, TOP + 0.014, HATCH.z - HATCH.r * 0.8], axis: [1, 0, 0], open: 100 * DEG },
  hpBonus: 0,
  stats: { cost: 3, mass: 2.0, hp: 0, tempo: 1.0 },
  massBoxes: [{ center: [0, 0.13, -0.08], half: [0.3, 0.1, 0.32], fraction: 1 }],
};

const ring = (y: number, pts: readonly [number, number][]): Vec3[] => pts.map(([x, z]) => [x, y, z] as Vec3);

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret');
  bearingRace(s, ctx);
  s.tag = 'wedge-body';
  s.material(MAT_ID.paint);
  // Central body: front face behind the drum (drum rear at z ≈ 0.27 − R ≥ 0.12).
  loft(s, null, [
    ring(BASE, [[-0.3, -0.26], [0.3, -0.26], [0.3, 0.02], [0.176, 0.104], [-0.176, 0.104], [-0.3, 0.02]]),
    ring(TOP - 0.012, [[-0.26, -0.225], [0.26, -0.225], [0.26, 0.0], [0.155, 0.068], [-0.155, 0.068], [-0.26, 0.0]]),
    ring(TOP, [[-0.248, -0.215], [0.248, -0.215], [0.248, -0.005], [0.148, 0.058], [-0.148, 0.058], [-0.248, -0.005]]),
  ], { edges: [EDGE.none, EDGE.chamfer] });
  cutRoofOpening(s, HATCH.x, HATCH.z, HATCH.r * 0.68, TOP - 0.085);
  utilityPad(s, ctx, () => TOP);
  // Cheeks flanking the drum (inner faces 16 mm outside its end faces).
  s.tag = 'cheek';
  for (const side of [-1, 1]) {
    const xi = DRUM_HALF + 0.016;
    const mk = (y: number, pts: [number, number][]) => ring(y, pts.map(([x, z]) => [side * x, z] as [number, number]));
    const bottom: [number, number][] = [[xi, -0.02], [0.3, 0.0], [0.3, 0.19], [xi, 0.34]];
    // Carry the cheek past the complete trunnion bearing, including its front
    // quadrant. The old sloping edge ended behind the axis at roof height.
    const top: [number, number][] = [[xi, 0.0], [0.26, 0.01], [0.26, 0.22], [xi, 0.33]];
    const b = mk(BASE, bottom), t = mk(0.25, top);
    loft(s, null, side > 0 ? [b, t] : [b.reverse(), t.reverse()], { edges: [EDGE.soft], capEdge: EDGE.chamfer });
    // Trunnion boss on the cheek's inner face (stops 3 mm short of the drum).
    s.material(MAT_ID.darkSteel);
    const tr0 = WEDGE_SPEC.trunnion;
    cylinder(s, null, [side * xi, tr0[1], tr0[2]], [side * (DRUM_HALF + 0.003), tr0[1], tr0[2]], 0.03, 10);
    s.material(MAT_ID.paint);
  }
  // Bustle rack (overhangs the engine deck above the ring plane).
  s.tag = 'bustle';
  loft(s, null, [
    ring(0.06, [[-0.27, -0.44], [0.27, -0.44], [0.29, -0.24], [-0.29, -0.24]]),
    ring(0.21, [[-0.25, -0.425], [0.25, -0.425], [0.27, -0.25], [-0.27, -0.25]]),
  ], { edges: [EDGE.soft], capEdge: EDGE.chamfer });
  if (s.detail >= 0.5) {
    s.material(MAT_ID.darkSteel);
    // Rack rails around the bustle.
    s.with({ tag: 'bustle-rail' }, () => {
      grabRail(s, [[-0.24, 0.239, -0.405], [0.24, 0.239, -0.405]], [[[-0.22, 0.21, -0.405], [-0.22, 0.239, -0.405]], [[0.22, 0.21, -0.405], [0.22, 0.239, -0.405]]]);
    });
  }
  // Roof: hatch ring, periscopes, bolts.
  s.material(MAT_ID.paint);
  s.tag = 'hatch-ring';
  lathe(s, tr(HATCH.x, 0, HATCH.z), [[HATCH.r + 0.01, TOP - 0.004], [HATCH.r + 0.01, TOP + 0.014], [HATCH.r * 0.68, TOP + 0.014], [HATCH.r * 0.68, TOP - 0.085], [0, TOP - 0.085]], 18, { smooth: false, caps: [false, false] });
  hatchSeat(s, HATCH.x, HATCH.z, TOP + .014, HATCH.r * .8, HATCH.r * .68);
  periscopeBlocks(s, [[-0.05, TOP, 0.02], [0.2, TOP, -0.02]]);
  if (s.fine) {
    const pts: Vec3[] = [];
    for (let i = 0; i < 6; i++) pts.push([-0.2 + i * 0.08, TOP, -0.205]);
    bolts(s, null, pts, [0, 1, 0]);
  }
  // Drum mantlet (cradle) and hatch lid.
  drumMantlet(out.get('cradle'), ctx.mantletRadius, DRUM_HALF);
  if (s.detail > 0.3) hatchLid(out.get('hatch'), HATCH.r * 0.8);
}

export const WEDGE: PartModule<TurretSpec> = { spec: WEDGE_SPEC, build };
