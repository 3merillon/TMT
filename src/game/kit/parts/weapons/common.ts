/**
 * Weapon builders (W1-KIT). Cradle frame: origin at the trunnion, bore along +Z.
 * - The fixed sleeve (cradle group) starts inside the mantlet and ends at `sleeveEnd`.
 * - The barrel group recoils; its rear tube radius stays ≤ 0.075 through the mantlet, with wider muzzle
 *   and accelerator details forward of the sleeve. Its rear end is at TUBE_TAIL_Z + recoilTravel at rest and
 *   reaches TUBE_TAIL_Z at full recoil, always inside the mantlet (sockets.mantletRadius).
 * - The muzzle frame is at z = barrelLength (it does not recoil).
 */
import { lathe, alongZ, simplifyProfile, type Profile, type Shape } from '../../geometry/shapes';
import { TUBE_TAIL_Z } from '../../sockets';
import { MAT_ID } from '../../types';
import type { KitContext, WeaponSpec } from '../types';

export function tubeStart(w: WeaponSpec): number { return TUBE_TAIL_Z + w.recoilTravel; }

/** The fixed sleeve with a front collar. */
export function sleeve(s: Shape, ctx: KitContext): void {
  const w = ctx.weapon, r = w.sleeveRadius, z0 = ctx.mantletRadius - 0.035, z1 = w.sleeveEnd;
  s.tag = 'sleeve';
  s.material(MAT_ID.gunmetal);
  // LOD2: a plain band (its ends hide in the mantlet and behind the tube).
  const inner = Math.min(r * 0.84, w.tubeRadius + 0.005);
  if (s.coarse) {
    lathe(s, alongZ(0, 0, 0), [[r, z0], [r, z1], [inner, z1]], 12, { caps: [false, false], hullProfile: null });
    return;
  }
  const outer: Profile = [[r * 0.9, z0], [r, z0 + 0.01], [r, z1 - 0.03], [r + 0.008, z1 - 0.025], [r + 0.008, z1 - 0.006], [r * 0.9, z1]];
  // The rear flare and rear annulus are buried inside the mantlet. Keep their
  // collision envelope, but spend the visible geometry on the collar and bore.
  const visible: Profile = s.fine ? outer.slice(1) : [[r, z0], [r, z1 - 0.025], [r + 0.008, z1 - 0.006], [r * 0.9, z1]];
  lathe(s, alongZ(0, 0, 0), [...visible, [inner, z1], [inner, z0]], 16, { rimEdge: 200, caps: [false, false], hullProfile: outer });
}

/** A recoiling tube from its rest start to the muzzle, as a stepped lathe with a dark bore at the muzzle. */
export function tube(s: Shape, w: WeaponSpec, profile: Profile, segments = 18, bands: readonly { from: number; to: number; mat: number }[] = [], opts: { muzzleFace?: boolean } = {}): void {
  s.tag = 'tube';
  s.material(MAT_ID.gunmetal);
  const L = w.barrelLength, b = w.boreRadius;
  const outer = s.coarse ? simplifyProfile(profile, 0.008) : profile;
  // Exterior and annular muzzle. No cap may span the bore, including distant LODs.
  const firstTriangle = s.mb.idx.length;
  lathe(s, alongZ(0, 0, 0), opts.muzzleFace === false ? outer : [...outer, [b, L]], segments, { rimEdge: 200, caps: [false, false], hullProfile: s.coarse ? null : outer });
  // Existing stepped bands carry distinct finishes without coplanar decorative
  // sleeves or duplicate hidden faces. Lathe bands own their vertices at creases.
  for (let i = firstTriangle; i < s.mb.idx.length; i += 3) {
    const tri = s.mb.idx.slice(i, i + 3), z = tri.reduce((sum, v) => sum + s.mb.p[v * 3 + 2], 0) / 3;
    const band = bands.find(band => z >= band.from && z <= band.to);
    if (band) for (const v of tri) s.mb.mat[v] = band.mat;
  }
  // Full depth bore, with inward normals from the descending profile.
  s.with({ noHull: true }, () => {
    s.material(MAT_ID.darkSteel);
    lathe(s, alongZ(0, 0, 0), [[b, L], [b, outer[0][1]], outer[0]], segments, { caps: [false, false], hullProfile: null });
    // A recessed chamber face and seated projectile terminate the view deep inside
    // the tube. The open muzzle and bore remain real geometry; the rear is no longer
    // an accidental view onto the turret skin. Both pieces recoil with the tube.
    const chamber = outer[0][1] + 0.012;
    lathe(s, alongZ(0, 0, 0), [[b, chamber], [0, chamber]], s.coarse ? 6 : 12, { caps: [false, false], hullProfile: null });
    if (!s.coarse) {
      s.material(MAT_ID.brass);
      lathe(s, alongZ(0, 0, 0), [[b * 0.82, chamber + 0.001], [b * 0.67, chamber + b * 0.42], [0, chamber + b * 1.3]], 12, { caps: [false, false], hullProfile: null });
    }
  });
}
