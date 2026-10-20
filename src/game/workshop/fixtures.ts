/** Dimensioned workshop fixtures, authored with the same chamfered CAD primitives as the kit. */
import type { MeshDesc, Vec3 } from '../../engine';
import { bolts, box, cylinder, Shape } from '../kit/geometry/shapes';
import { cross, norm, rotZ, sub, translate } from '../kit/geometry/math';
import { shapeMesh } from './geometry';

const solid = () => { const s = new Shape(); s.noHull = true; return s; };
const plate = (s: Shape, at: Vec3, size: Vec3, mat = 1, bevel = .014) => box(s.material(mat), translate(...at), size, bevel);

/** Open structural base: foundation feet, load-bearing channels, drip tray and an accessible power pack. */
export function liftFoundationMesh(): MeshDesc {
  const s = solid();
  plate(s, [0, .06, 0], [2.78, .065, 3.62], 2, .028);
  for (const x of [-1.4, 1.4]) {
    plate(s, [x, .18, 0], [.24, .24, 3.94], 0, .035);
    plate(s, [x, .10, 0], [.36, .06, 4.02], 1, .02);
  }
  for (const z of [-1.82, 1.82]) plate(s, [0, .2, z], [2.72, .22, .18], 0, .025);
  for (const x of [-1.38, 1.38]) for (const z of [-1.77, 1.77]) {
    plate(s, [x, .055, z], [.48, .09, .46], 2, .035);
    plate(s, [x, .11, z], [.44, .055, .41], 1, .025);
    bolts(s.material(3), null, [[x - .15, .141, z - .14], [x + .15, .141, z + .14]], [0, 1, 0], .028, .017);
  }
  // Sealed pump enclosure, recessed service face, cooling slots, and a guarded pressure dial.
  plate(s, [0, .25, 1.80], [1.35, .34, .32], 0, .04);
  plate(s, [0, .25, 1.975], [1.19, .25, .018], 1, .015);
  for (let i = 0; i < 11; i++) plate(s, [-.46 + i * .066, .24, 1.99], [.027, .115, .012], 2, .003);
  cylinder(s.material(4), null, [.40, .265, 1.987], [.40, .265, 2.02], .086, 32);
  cylinder(s.material(7), null, [.40, .265, 2.02], [.40, .265, 2.025], .067, 32);
  plate(s, [.4, .265, 2.03], [.012, .08, .008], 2, .001);
  for (const x of [-.56, .56]) bolts(s.material(3), null, [[x, .16, 1.992], [x, .34, 1.992]], [0, 0, 1], .014, .009);
  return shapeMesh(s, 'workshop:lift-foundation');
}

/** Welded bearing-bar grating has real apertures. Its top datum is exactly the tank's contact plane y=.65. */
export function liftDeckMesh(): MeshDesc {
  const s = solid();
  for (const x of [-1.33, 1.33]) {
    plate(s, [x, .555, 0], [.105, .15, 3.90], 0, .018);
    plate(s, [x, .486, 0], [.19, .035, 3.90], 1, .008);
    plate(s, [x, .637, 0], [.17, .026, 3.90], 3, .007);
    for (const z of [-1.73, -.86, 0, .86, 1.73]) bolts(s.material(3), null, [[x, .653, z]], [0, 1, 0], .023, .012);
  }
  for (const z of [-1.855, 1.855]) {
    plate(s, [0, .565, z], [2.6, .145, .12], 0, .016);
    plate(s, [0, .637, z], [2.49, .026, .19], 3, .007);
    for (const x of [-1.10, -.55, 0, .55, 1.10]) bolts(s.material(3), null, [[x, .653, z]], [0, 1, 0], .023, .012);
  }
  for (const z of [-1.35, -.65, 0, .65, 1.35]) {
    plate(s, [0, .53, z], [2.57, .08, .055], 1, .006);
    plate(s, [0, .49, z], [2.57, .025, .16], 1, .006);
  }
  // Bearing bars stop at the central panel divider. Transverse ties sit in
  // recessed welded slots: no two visible top faces share the contact plane.
  for (let x = -1.17; x <= 1.171; x += .065) {
    if (Math.abs(x) < .03) continue;
    for (const sign of [-1, 1]) plate(s, [x, .620, sign * .875], [.023, .06, 1.71], 1, .002);
  }
  for (let z = -1.68; z <= 1.681; z += .16) {
    if (Math.abs(z) < .04) continue;
    plate(s, [0, .612, z], [2.42, .020, .022], 3, .002);
  }
  // Four removable grating panel frames, recessed lifting slots and bolted corner gussets.
  for (const sign of [-1, 1]) plate(s, [0, .633, sign * .877], [.035, .034, 1.716], 3, .005);
  plate(s, [0, .633, 0], [2.44, .034, .035], 3, .005);
  for (const x of [-1.12, 1.12]) for (const z of [-1.69, 1.69]) {
    plate(s, [x, .573, z], [.18, .025, .18], 3, .018);
    bolts(s.material(3), null, [[x, .589, z]], [0, 1, 0], .024, .01);
  }
  return shapeMesh(s, 'workshop:lift-grating-deck');
}

/** Seven cupped, swept sheet-metal airfoils with a real pitch, closed edges and a bolted rotor hub. */
export function fanRotorMesh(): MeshDesc {
  const rotor = solid();
  for (let blade = 0; blade < 7; blade++) {
    const s = solid().material(3), nr = 18, nc = 8;
    const surface = (u: number, v: number): Vec3 => {
      const r = .22 + 1.23 * u;
      const chord = .19 + .32 * Math.sin(Math.PI * (.14 + .7 * u));
      const sweep = -.10 + .34 * u * u;
      const t = (v - .5) * chord, pitch = .67 - .38 * u;
      return [sweep + t * Math.cos(pitch), r, t * Math.sin(pitch) + .035 * Math.sin(v * Math.PI) * (1 - .4 * u)];
    };
    for (const face of [-1, 1]) {
      const first = s.mb.vertexCount;
      for (let i = 0; i <= nr; i++) for (let j = 0; j <= nc; j++) {
        const u = i / nr, v = j / nc, p = surface(u, v), eps = .001;
        const du = sub(surface(u + eps, v), surface(u - eps, v)), dv = sub(surface(u, v + eps), surface(u, v - eps));
        const n = norm(cross(dv, du));
        s.mb.vertex(p[0] + n[0] * face * .009, p[1] + n[1] * face * .009, p[2] + n[2] * face * .009, n[0] * face, n[1] * face, n[2] * face, j === 0 || j === nc ? 180 : 60);
      }
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
        const q = first + i * (nc + 1) + j;
        if (face > 0) s.mb.quad(q, q + 1, q + nc + 2, q + nc + 1);
        else s.mb.quad(q, q + nc + 1, q + nc + 2, q + 1);
      }
    }
    const sideCount = (nr + 1) * (nc + 1), perimeter: number[] = [];
    for (let j = 0; j <= nc; j++) perimeter.push(j);
    for (let i = 1; i <= nr; i++) perimeter.push(i * (nc + 1) + nc);
    for (let j = nc - 1; j >= 0; j--) perimeter.push(nr * (nc + 1) + j);
    for (let i = nr - 1; i > 0; i--) perimeter.push(i * (nc + 1));
    for (let i = 0; i < perimeter.length; i++) {
      const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length];
      const at = (v: number) => s.mb.p.slice(v * 3, v * 3 + 3) as Vec3;
      s.mb.poly([at(a), at(b), at(b + sideCount), at(a + sideCount)], 180);
    }
    cylinder(s.material(4), null, [0, .3, -.025], [0, .3, .04], .07, 24);
    bolts(s.material(3), null, [[0, .3, .042]], [0, 0, 1], .033, .017);
    rotor.mb.append(s.mb, rotZ(blade * Math.PI * 2 / 7));
  }
  cylinder(rotor.material(1), null, [0, 0, -.12], [0, 0, .10], .28, 48);
  cylinder(rotor.material(3), null, [0, 0, .10], [0, 0, .14], .21, 48);
  bolts(rotor.material(4), null, Array.from({ length: 8 }, (_, i): Vec3 => [Math.cos(i * Math.PI / 4) * .17, Math.sin(i * Math.PI / 4) * .17, .145]), [0, 0, 1], .024, .02);
  return shapeMesh(rotor, 'workshop:pitched-fan-rotor');
}
