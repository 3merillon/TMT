/**
 * Smoke dischargers (W1-KIT): two clusters of three launch tubes on brackets, one per turret side, angled
 * forward and up (rigid, turret group; no head joint). The emitter frame is the utility socket.
 */
import { alongZ, bolts, box, cylinder, lathe, mm, rx, ry, sweep, tr } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GroupShapes, KitContext, PartModule, UtilitySpec } from '../types';
import { COSMETIC_UTILITY_MASS, COSMETIC_UTILITY_STATS } from './common';

export const SMOKE_SPEC: UtilitySpec = {
  id: 'smoke', name: 'Smoke dischargers', head: null, headOrigin: [0, 0, 0], sight: 0,
  stats: COSMETIC_UTILITY_STATS,
  massBoxes: COSMETIC_UTILITY_MASS,
};

/** Cluster mount point per turret (turret frame, +X side; mirrored for −X). */
export const SMOKE_MOUNT: Readonly<Record<string, Vec3>> = Object.freeze({
  dome: [0.3, 0.16, -0.12], wedge: [0.3, 0.14, -0.14], cradle: [0.24, 0.05, -0.12],
  aether_crown: [.30, .18, -.14], forge_casemate: [.35, .17, -.19],
});

function build(ctx: KitContext, out: GroupShapes): void {
  const s = out.get('turret'), p = SMOKE_MOUNT[ctx.turret.id];
  s.tag = 'smoke';
  for (const side of [-1, 1]) {
    const base = mm(tr(side * p[0], p[1], p[2]), ry(side * 0.35));
    s.material(MAT_ID.darkSteel);
    box(s, mm(base, tr(side * 0.01, 0, 0)), [0.03, 0.05, 0.1], 0);
    if (s.fine) {
      s.material(MAT_ID.brass);
      bolts(s, base, [[side * .026, -.016, -.032], [side * .026, .016, .032]], [side, 0, 0], .005, .004);
      // Two angle braces carry the launcher rail into the bolted turret-side shoe.
      s.material(MAT_ID.darkSteel);
      for (const z of [-.03, .03]) cylinder(s, base, [0, -.020, z], [side * .036, .004, z], .006, 6, { smooth: false, caps: [false, false] });
    }
    s.material(MAT_ID.gunmetal);
    if (s.coarse) {
      // LOD2: the three launchers read as one block.
      box(s, mm(base, tr(side * 0.03, 0, 0), rx(-0.5), tr(0, 0, 0.035)), [0.028, 0.05, 0.1], 0);
      continue;
    }
    for (let i = 0; i < 3; i++) {
      const m = mm(base, tr(side * 0.03, -0.012 + i * 0.012, -0.03 + i * 0.03), rx(-0.5));
      lathe(s, mm(m, alongZ(0, 0, 0)), [[0.014, 0], [0.014, 0.07], [0.01, 0.07], [0.01, 0.006], [0, 0.006]], 10, { caps: [false, false], hullProfile: [[0.014, 0], [0.014, 0.07]] });
      if (s.fine) {
        s.material(MAT_ID.brass);
        for (const z of [.014, .045]) lathe(s, mm(m, alongZ(0, 0, z)), [[.014, 0], [.017, .0035], [.014, .007]], 6, { caps: [false, false], hullProfile: null });
        s.material(MAT_ID.rubber);
        // The short tied wire needs only one bend between its tube connector and
        // the rail loom; avoid multiple submillimetre rings hidden behind the bank.
        s.with({ cosmetic: true, noHull: true }, () => sweep(s, base, [[side * .03, -.012 + i * .012, -.034 + i * .03], [side * .04, -.025, -.045 + i * .015], [side * .015, -.026, -.045]], .002, 6));
        s.material(MAT_ID.gunmetal);
      }
    }
  }
}

export const SMOKE: PartModule<UtilitySpec> = { spec: SMOKE_SPEC, build };
