import { expect, it } from 'vitest';
import { kitContext, kitGeometry } from '../src/game/kit/build';
import { legalKitLoadouts } from '../src/game/kit/catalog';
import { Placed, boxesOverlap } from '../src/game/kit/geometry/convex';
import { gjkDistance } from '../src/game/kit/geometry/gjk';
import { mat4 } from '../src/game/kit/geometry/math';
import { GunClearance, PITCH_CLEARANCE } from '../src/game/kit/pitch';
import { createRigPose, poseJoints } from '../src/game/kit/rig';

it('keeps analytic sweep certificates conservative against independently posed convex geometry', () => {
  const variants = legalKitLoadouts().filter(l => l.utility === 'antenna');
  const selected = variants.filter((_, index) => index % 23 === 0);
  let seed = 94271, certificates = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (const loadout of selected) {
    const ctx = kitContext(loadout), geometry = kitGeometry(ctx, 0), solver = new GunClearance(ctx), joints = createRigPose().joints;
    const hull = geometry.groups.get('hull')!.flatMap(s => s.hulls.map(c => new Placed(c).set(mat4())));
    const gun = (['cradle', 'barrel'] as const).flatMap(group => (geometry.groups.get(group) ?? []).flatMap(s => s.hulls.map(c => ({ group, piece: new Placed(c) }))));
    const exact = (yaw: number, pitch: number): boolean => {
      for (const recoil of [0, 1]) {
        poseJoints(ctx, { yaw, pitch, recoil, hatch: 0, head: [0, 0] }, joints);
        for (const { group, piece } of gun) {
          piece.set(joints[group]);
          for (const target of hull) if (boxesOverlap(piece.box, target.box, -PITCH_CLEARANCE) && gjkDistance(piece, target, PITCH_CLEARANCE) <= PITCH_CLEARANCE) return false;
        }
      }
      return true;
    };
    for (let i = 0; i < 12; i++) {
      const yaw = random() * Math.PI * 2, [min, max] = ctx.turret.elevation;
      const a = min + random() * (max - min), b = min + random() * (max - min), lo = Math.min(a, b), hi = Math.max(a, b);
      const mid = (lo + hi) / 2;
      expect(solver.clear(yaw, mid), `${Object.values(loadout).join('.')} exact pose`).toBe(exact(yaw, mid));
      if (solver.clear(yaw, mid, PITCH_CLEARANCE, undefined, (hi - lo) / 2)) {
        certificates++;
        for (let sample = 0; sample <= 8; sample++) expect(exact(yaw, lo + (hi - lo) * sample / 8), `${loadout.hull}/${loadout.weapon} interval sample ${sample}`).toBe(true);
      }
    }
  }
  expect(certificates).toBeGreaterThan(50);
});
