/** Mags' single-seat gunship: Comanche-inspired chines and integrated engine shoulders.
 * Airframe reference: https://sikorskyarchives.com/home/sikorsky-product-history/helicopter-innovation-era/boeing-sikorsky-rah-66/
 * Exposed drivetrain reference: https://www.bellflight.com/products/bell-ah-1z
 * Glazing and fuselage share their sill stations. */
import { loft, prism, sweep, type Shape } from '../kit/geometry/shapes';
import { add, scale, norm, sub, cross, mul, rotY, rotZ, applyPoint, type Vec3, type Mat4 } from '../kit/geometry/math';
import type { PartMesh } from '../kit/types';
import { shape, finish, plate, shaft, collar, fasteners } from './campaign-machining';

const cache = new Map<number, PartMesh[]>();
// Body station coordinates are mapped to the slender final airframe here; rotor joints use
// the same mapping while the blades retain their circular swept volumes and airfoil sections.
const BODY_HEIGHT = .75;
const boomZ = (z: number) => z < -.90 ? -.90 + (z + .90) * 1.2 : z;
export const DRAGONFLY_ROTOR: Vec3 = [0, 1.00 * BODY_HEIGHT, -.34];
export const DRAGONFLY_TAIL_ROTOR: Vec3 = [.15, .50 * BODY_HEIGHT, boomZ(-2.03)];

function finishAirframe(s: Shape, name: string, lod: 0 | 1 | 2): PartMesh {
  for (let i = 0; i < s.mb.p.length; i += 3) {
    const stretched = s.mb.p[i + 2] < -.90;
    s.mb.p[i + 1] *= BODY_HEIGHT; s.mb.p[i + 2] = boomZ(s.mb.p[i + 2]);
    // Inverse transpose of the station scale; preserve correct lighting on the formed skin.
    const n = norm([s.mb.n[i], s.mb.n[i + 1] / BODY_HEIGHT, s.mb.n[i + 2] / (stretched ? 1.2 : 1)]);
    s.mb.n[i] = n[0]; s.mb.n[i + 1] = n[1]; s.mb.n[i + 2] = n[2];
    const axis = norm([s.mb.axis[i], s.mb.axis[i + 1] * BODY_HEIGHT, s.mb.axis[i + 2] * (stretched ? 1.2 : 1)]);
    s.mb.axis[i] = axis[0]; s.mb.axis[i + 1] = axis[1]; s.mb.axis[i + 2] = axis[2];
  }
  return finish(s, name, 'hull', lod);
}

type Station = { z: number; w: number; bottom: number; sill: number };
// Nose to tail. The canopy uses this exact lower skin, not an intersecting second hull.
const stations: Station[] = [
  { z: 1.03, w: .035, bottom: -.04, sill: .075 },
  { z: .93, w: .09, bottom: -.10, sill: .15 },
  { z: .74, w: .164, bottom: -.16, sill: .255 },
  { z: .37, w: .19, bottom: -.18, sill: .285 },
  { z: .10, w: .20, bottom: -.18, sill: .31 },
  { z: -.10, w: .225, bottom: -.17, sill: .32 },
  { z: -.40, w: .255, bottom: -.12, sill: .34 },
  { z: -.66, w: .23, bottom: -.06, sill: .35 },
  { z: -.87, w: .142, bottom: .065, sill: .30 },
  { z: -.90, w: .13, bottom: .075, sill: .30 },
];
function station(z: number): Station {
  for (let i = 0; i + 1 < stations.length; i++) {
    const a = stations[i], b = stations[i + 1];
    if (z <= a.z && z >= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      return { z, w: a.w + (b.w - a.w) * t, bottom: a.bottom + (b.bottom - a.bottom) * t, sill: a.sill + (b.sill - a.sill) * t };
    }
  }
  throw new Error(`Dragonfly skin station out of range: ${z}`);
}
function hullRing({ z, w, bottom: b, sill: y }: Station): Vec3[] {
  const chine = b + (y - b) * .48;
  return [[-w, y, z], [-w * 1.17, chine, z], [-w * .52, b, z],
    [w * .52, b, z], [w * 1.17, chine, z], [w, y, z]];
}
/** A point on the sloping armor face; fittings follow the skin instead of a constant-width box. */
function cheek(side: number, z: number, t: number, lift = .002): Vec3 {
  const { w, sill, bottom } = station(z), chine = bottom + (sill - bottom) * .48;
  return [side * (w * (1.17 - .17 * t) + lift), chine + (sill - chine) * t, z];
}
function oval(s: Shape, x: number, y: number, z: number, rx: number, ry: number): Vec3[] {
  return Array.from({ length: s.segs(24, 8) }, (_, i) => {
    const a = i / s.segs(24, 8) * Math.PI * 2; return [x + Math.cos(a) * rx, y + Math.sin(a) * ry, z];
  });
}
/** Smooth formed skin: noncircular cross sections, longitudinal curvature and hard end caps. */
function skin(s: Shape, rings: Vec3[][]): void {
  const rows = rings.length, cols = rings[0].length, base = s.mb.vertexCount;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const p = rings[r][c], around = sub(rings[r][(c + 1) % cols], rings[r][(c + cols - 1) % cols]);
    const along = sub(rings[Math.min(rows - 1, r + 1)][c], rings[Math.max(0, r - 1)][c]);
    const n = norm(cross(around, along)); s.mb.vertex(...p, ...n, 0);
  }
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c < cols; c++) {
    const a = base + r * cols + c, b = base + r * cols + (c + 1) % cols;
    s.mb.quad(a, b, b + cols, a + cols);
  }
  s.mb.poly(rings[0], 96, [0, 0, -1]); s.mb.poly(rings[rows - 1], 96, [0, 0, 1]);
}
/** Flush pane/panel and its seal, inside a continuous painted frame. */
function panel(s: Shape, points: Vec3[], outward: Vec3, material: number, inset = .045): void {
  const center = scale(points.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3), 1 / points.length);
  const n = norm(outward), inner = (t: number, lift: number) => points.map(p => add(add(scale(p, 1 - t), scale(center, t)), scale(n, lift)));
  s.material(0); s.mb.poly(points, 70, n);
  s.material(2); s.mb.poly(inner(inset, .0008), 0, n);
  s.material(material); s.mb.poly(inner(inset + .018, .0016), 0, n);
}
function canopyRing(z: number, roof: number): Vec3[] {
  const { w, sill } = station(z);
  const shoulder = Math.max(sill + .008, roof - .055);
  return [[-w, sill, z], [-w * .86, shoulder, z], [-w * .52, roof, z],
    [w * .52, roof, z], [w * .86, shoulder, z], [w, sill, z]];
}
function airframe(lod: 0 | 1 | 2): PartMesh {
  const s = shape(lod);
  s.material(0); loft(s, null, [...stations].reverse().map(hullRing));
  const canopy = [canopyRing(.10, .57), canopyRing(.37, .55), canopyRing(.74, .27)];
  // One compact forward cockpit, with one roof line and one side access panel per side.
  for (let r = 0; r + 1 < canopy.length; r++) for (let c = 0; c < 5; c++) {
    const a = canopy[r], b = canopy[r + 1];
    panel(s, [a[c], a[c + 1], b[c + 1], b[c]], [c < 2 ? -1 : c > 2 ? 1 : 0, c === 2 ? 1 : .35, .35], 6, c === 2 ? .075 : .045);
  }
  s.material(0); s.mb.poly(canopy[0], 70, [0, 0, -1]); s.mb.poly(canopy[canopy.length - 1], 70, [0, 0, 1]);
  // A single faceted spine carries the transmission. Its straight shoulder lines flow into
  // the engine cassettes; no round gearbox blister is stacked on top of another cowling.
  loft(s, null, [canopyRing(-.90, .34), canopyRing(-.66, .48), canopyRing(-.40, .68), canopyRing(-.10, .59), canopyRing(.10, .57)]);
  if (!s.coarse) panel(s, [[-.067, .589, -.08], [.067, .589, -.08], [.067, .573, .08], [-.067, .573, .08]], [0, 1, 0], 0, .05);
  for (const side of [-1, 1]) {
    for (const z of [.27]) {
      const a = station(z);
      shaft(s, [side * (a.w * .985), a.sill + .035, z - .025], [side * (a.w * .985), a.sill + .035, z + .045], .006, 3, 8);
      if (!s.coarse) for (const dz of [-.10, .11]) {
        const b = station(z + dz);
        shaft(s, [side * (b.w + .003), b.sill + .003, z + dz - .016], [side * (b.w + .003), b.sill + .003, z + dz + .016], .009, 0, 8);
      }
    }
    if (!s.coarse) for (const [z0, z1] of [[-.62, -.43], [-.36, -.12], [-.06, .07], [.14, .34], [.40, .70]]) {
      const p: Vec3[] = [cheek(side, z0, .12), cheek(side, z1, .12), cheek(side, z1, .91), cheek(side, z0, .91)];
      panel(s, p, [side, .1, 0], 0, .018);
      const center = scale(p.reduce((a, q) => add(a, q), [0, 0, 0] as Vec3), .25);
      fasteners(s, p.map(v => add(scale(v, .88), scale(center, .12))), [side, 0, 0], .0045);
    }
    // Flush warning receiver and recessed boarding step, both seated on the armor face.
    panel(s, [cheek(side, .79, .48, .003), cheek(side, .87, .48, .003),
      cheek(side, .87, .81, .003), cheek(side, .79, .81, .003)], [side, .1, 0], 1, .12);
    if (!s.coarse) panel(s, [cheek(side, .26, .18), cheek(side, .36, .18),
      cheek(side, .36, .34), cheek(side, .26, .34)], [side, .1, 0], 2, .12);
  }
  // Faceted nose sensor cassette shares the tip bulkhead. The optics sit behind a raised
  // polygonal rim; no round gimbal, lenses or aerial stalks intersect the nose skin.
  const sensorRing = (z: number, w: number, y0: number, y1: number): Vec3[] =>
    [[-w, y0 + .018, z], [-w * .62, y0, z], [w * .62, y0, z], [w, y0 + .018, z], [w, y1, z], [-w, y1, z]];
  const sensorBack = sensorRing(1.022, .035, -.038, .058), sensorLip = sensorRing(1.055, .030, -.025, .045);
  const sensorBore = sensorRing(1.057, .024, -.018, .038), sensorSeat = sensorRing(1.043, .024, -.018, .038);
  s.material(1); loft(s, null, [sensorBack, sensorLip], { caps: [false, false] });
  loft(s, null, [sensorLip, sensorBore, sensorSeat], { caps: [false, false] });
  s.material(2); s.mb.poly(sensorSeat, 0, [0, 0, 1]);
  for (const [x, r] of [[-.012, .009], [.012, .007]]) {
    collar(s, [x, .012, 1.042], [x, .012, 1.049], r + .003, r, 3, 16);
    shaft(s, [x, .012, 1.044], [x, .012, 1.046], r, 6, 16);
  }
  // Mast bearings and stationary swashplate remain mechanically connected to the spine.
  shaft(s, [0, .56, -.34], [0, 1.00, -.34], .024, 3, 20);
  collar(s, [0, .67, -.34], [0, .71, -.34], .074, .026, 1, 24);
  collar(s, [0, .80, -.34], [0, .826, -.34], .095, .027, 3, 24);
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3, x = Math.cos(a), z = Math.sin(a);
    shaft(s, [x * .07, .60, -.34 + z * .07], [x * .08, .806, -.34 + z * .08], .007, 3, 10);
    collar(s, [x * .07, .595, -.34 + z * .07], [x * .074, .68, -.34 + z * .074], .014, .007, 1, 12);
  }
  return finishAirframe(s, 'dragonfly-fuselage', lod);
}

function engine(lod: 0 | 1 | 2, side: number): PartMesh {
  const s = shape(lod);
  // A single tapered cassette from the raked intake to the narrow exhaust slot. Broad
  // planar facets replace the overlapping scoop, round nacelle and separate diffuser.
  const section = (cx: number, y: number, z: number, rx: number, ry: number, rake = 0): Vec3[] =>
    [[-1, -.80], [.60, -1], [1, -.45], [1, .52], [.55, 1], [-.70, 1], [-1, .45]].map(([u, v]) =>
      [side * (cx + u * rx), y + v * ry, z + rake * (v + .6 * u)]);
  const back = section(.176, .398, -.94, .063, .048);
  const aft = section(.245, .463, -.66, .091, .089);
  const shoulder = section(.297, .495, -.32, .103, .111);
  const outer = section(.315, .49, .038, .083, .104, -.018);
  const inner = section(.315, .49, .030, .069, .089, -.018);
  const throat = section(.302, .49, -.155, .052, .062);
  s.material(0); loft(s, null, [back, aft, shoulder, outer], { caps: [false, false] });
  // Both sides of the opening are explicit: lip outward, duct walls facing into the bore.
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length, mid = scale(add(inner[i], inner[j]), .5);
    s.material(1); s.mb.poly([outer[i], outer[j], inner[j], inner[i]], 100, [0, 0, 1]);
    s.mb.poly([inner[i], inner[j], throat[j], throat[i]], 0, [side * .302 - mid[0], .49 - mid[1], .06]);
  }
  s.material(2); s.mb.poly(throat, 0, [0, 0, 1]);
  shaft(s, [side * .302, .49, -.153], [side * .302, .49, -.133], .015, 3, 14);
  if (!s.coarse) for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2, p = (r: number, angle: number): Vec3 =>
      [side * (.302 + Math.cos(angle) * r), .49 + Math.sin(angle) * r, -.151];
    s.material(3); s.mb.poly([p(.015, a), p(.042, a + .32), p(.045, a + .57), p(.021, a + .40)], 0, [0, 0, 1]);
  }
  // Rear slit is recessed within the tapered cassette, with heat-resistant liner and vanes.
  const bore = section(.176, .398, -.942, .053, .037), exit = section(.176, .398, -.82, .045, .031);
  for (let i = 0; i < back.length; i++) {
    const j = (i + 1) % back.length, mid = scale(add(bore[i], bore[j]), .5);
    s.material(3); s.mb.poly([back[i], back[j], bore[j], bore[i]], 70, [0, 0, -1]);
    s.material(1); s.mb.poly([bore[i], bore[j], exit[j], exit[i]], 0, [side * .176 - mid[0], .398 - mid[1], -.1]);
  }
  s.material(2); s.mb.poly(exit, 0, [0, 0, -1]);
  if (!s.coarse) {
    for (const u of [-.5, 0, .5]) plate(s, [side * (.176 + u * .046), .398, -.875], [.003, .049, .083], 3, .001);
    // Access seams and vents live on the exact outer facet, avoiding protruding straps.
    for (const [a, b] of [[aft, shoulder], [shoulder, outer]]) {
      const face = [a[2], b[2], b[3], a[3]].map(p => add(p, [side * .001, 0, 0]));
      panel(s, face, [side, 0, 0], 0, .055);
    }
    const point = (u: number, v: number): Vec3 => add(add(scale(aft[3], (1 - u) * (1 - v)), scale(aft[4], (1 - u) * v)),
      add(scale(shoulder[3], u * (1 - v)), scale(shoulder[4], u * v)));
    for (let i = 0; i < 6; i++) {
      const u = .16 + i * .105;
      panel(s, [point(u, .20), point(u + .05, .20), point(u + .05, .78), point(u, .78)], [side, .5, 0], 2, .08);
    }
  }
  fasteners(s, [outer[1], outer[3], outer[5]], [0, 0, 1], .0035);
  return finishAirframe(s, `flight-engine-${side}`, lod);
}

function landingGear(lod: 0 | 1 | 2, side: number): PartMesh {
  const s = shape(lod);
  for (const z of [-.58, .51]) {
    const path: Vec3[] = [[side * .16, .01, z], [side * .29, -.17, z], [side * .40, -.43, z - .03]];
    s.material(3); sweep(s, null, path, .019, 12, { bend: .055 });
    collar(s, [side * .34, -.286, z - .017], [side * .36, -.333, z - .022], .027, .019, 1, 12);
    plate(s, [side * .40, -.445, z - .03], [.065, .04, .08], 1, .008);
  }
  const rail: Vec3[] = [[side * .40, -.43, -.87], [side * .40, -.473, -.74], [side * .40, -.473, .79], [side * .40, -.41, .96], [side * .40, -.34, 1.04]];
  s.material(1); sweep(s, null, rail, .025, 12, { bend: .085 });
  if (!s.coarse) for (const z of [-.52, -.12, .36, .67]) plate(s, [side * .40, -.491, z], [.046, .012, .17], 3, .003);
  return finish(s, `flight-skid-${side}`, 'hull', lod);
}

function weapons(lod: 0 | 1 | 2, side: number): PartMesh {
  const s = shape(lod), x = side * .60;
  const wing = (x: number, front: number, back: number, y: number): Vec3[] => [[x, y, front], [x, y + .025, front - .08], [x, y + .01, back], [x, y - .012, back], [x, y - .015, front - .08]];
  s.material(0); loft(s, null, [wing(side * .21, .13, -.31, .08), wing(side * .73, .00, -.27, .045)]);
  plate(s, [x, -.015, -.10], [.045, .13, .20], 1, .008);
  s.material(0); skin(s, [oval(s, x, -.10, -.42, .075, .075), oval(s, x, -.10, -.36, .096, .096),
    oval(s, x, -.10, .18, .096, .096), oval(s, x, -.10, .22, .085, .085)]);
  collar(s, [x, -.10, .216], [x, -.10, .236], .086, .075, 3, 20);
  shaft(s, [x, -.10, .225], [x, -.10, .228], .075, 1, 20);
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI / 3, r = i === 6 ? 0 : .049, px = x + Math.cos(a) * r, y = -.10 + Math.sin(a) * r;
    collar(s, [px, y, .228], [px, y, .239], .021, .016, 3, 12);
    shaft(s, [px, y, .229], [px, y, .23], .016, 2, 8);
  }
  for (const z of [-.28, .10]) collar(s, [x, -.10, z], [x, -.10, z + .018], .099, .095, 1, 20);
  return finish(s, `flight-pod-${side}`, 'hull', lod);
}

function tail(lod: 0 | 1 | 2): PartMesh {
  const s = shape(lod);
  s.material(0); skin(s, [oval(s, 0, .36, -2.16, .027, .046), oval(s, 0, .345, -1.90, .043, .065),
    oval(s, 0, .29, -1.43, .072, .095), oval(s, 0, .22, -1.06, .105, .12), oval(s, 0, .205, -.83, .15, .135)]);
  s.material(0); prism(s, null, 'x', [[.33, -2.16], [.93, -2.19], [.95, -2.08], [.43, -1.83], [.30, -1.85]], -.024, .024, .006);
  shaft(s, [-.03, .50, -2.03], [.15, .50, -2.03], .026, 3, 16);
  collar(s, [.025, .50, -2.03], [.075, .50, -2.03], .048, .027, 0, 20);
  // Stabilizer lies forward of the complete tail-rotor sweep, not just the parked blade pose.
  for (const side of [-1, 1]) {
    s.material(0); loft(s, null, [
      [[side * .055, .30, -1.10], [side * .055, .32, -1.17], [side * .055, .30, -1.43], [side * .055, .285, -1.17]],
      [[side * .43, .34, -1.24], [side * .43, .35, -1.28], [side * .43, .34, -1.47], [side * .43, .329, -1.28]],
    ]);
    if (!s.coarse) shaft(s, [side * .09, .312, -1.38], [side * .405, .346, -1.43], .0025, 1, 6);
  }
  if (!s.coarse) {
    for (const [z, y, rx, ry] of [[-1.02, .218, .11, .123], [-1.4, .286, .075, .098], [-1.86, .341, .047, .069]]) {
      const ring = oval(s, 0, y, z, rx, ry); s.material(1); sweep(s, null, [...ring, ring[0]], .0018, 6);
    }
    shaft(s, [0, .15, -1.05], [0, -.02, -1.14], .005, 1, 6);
  }
  plate(s, [0, .945, -2.135], [.037, .018, .055], 5, .006);
  return finishAirframe(s, 'flight-tail', lod);
}

/** Cambered sections with pitch, washout and swept tips. Thickness scales with chord. */
function blade(s: Shape, m: Mat4, radius: number, chord: number): void {
  const section = (r: number, c: number, sweepX: number): Vec3[] => {
    const pitch = .10 - r / radius * .055, cone = r * .012;
    const profile = s.coarse ? [[-.50, 0], [0, .065], [.50, 0], [-.08, -.035]]
      : [[-.50, 0], [-.32, .060], [0, .065], [.32, .028], [.50, 0], [.28, -.020], [-.08, -.035], [-.36, -.030]];
    return profile
      .map(([x, y]) => [x * c + sweepX, y * c + x * c * pitch + cone, r] as Vec3);
  };
  s.material(1); loft(s, m, [section(radius * .10, chord * .52, 0), section(radius * .21, chord, 0),
    section(radius * .90, chord * .95, 0), section(radius, chord * .62, -chord * .28)]);
  if (!s.coarse) {
    const a = section(radius * .21, chord, 0), b = section(radius * .90, chord * .95, 0);
    s.material(3); s.mb.poly([a[0], a[1], b[1], b[0]].map(p => applyPoint(m, p[0], p[1] + .0006, p[2])), 0, applyPoint(m, 0, 1, 0));
    const c = section(radius * .955, chord * .77, -chord * .15), d = section(radius * .97, chord * .72, -chord * .19);
    s.mb.poly([c[0], c[2], d[2], d[0]].map(p => applyPoint(m, p[0], p[1] + .001, p[2])), 0, applyPoint(m, 0, 1, 0));
  }
}
function mainRotor(lod: 0 | 1 | 2): PartMesh {
  const s = shape(lod);
  collar(s, [0, -.028, 0], [0, .025, 0], .063, .024, 3, 24);
  shaft(s, [0, -.03, 0], [0, .035, 0], .024, 3, 20);
  // Rotating upper race sits on the fixed lower race. Pitch links attach to this ring.
  collar(s, [0, -.132, 0], [0, -.116, 0], .10, .027, 3, 28);
  shaft(s, [.03, -.025, 0], [.045, -.078, .015], .005, 3, 8);
  shaft(s, [.045, -.078, .015], [.03, -.124, 0], .005, 3, 8);
  for (let i = 0; i < 4; i++) {
    const m = rotY(i * Math.PI / 2), at = (x: number, y: number, z: number) => applyPoint(m, x, y, z);
    // Continuous grip from the hub to the carbon blade root, including a through-bolt.
    s.material(3); prism(s, m, 'y', [[.055, -.034], [.16, -.035], [.25, -.023], [.25, .023], [.16, .035], [.055, .034]], -.013, .013, .003);
    shaft(s, at(0, 0, .045), at(0, 0, .24), .017, 3, 12);
    collar(s, at(0, 0, .135), at(0, 0, .18), .024, .017, 1, 12);
    shaft(s, at(0, -.025, .205), at(0, .025, .205), .010, 3, 10);
    if (!s.coarse) {
      // Pitch horn is fastened to the grip; both rod eyes seat into actual bosses.
      shaft(s, at(0, 0, .18), at(-.055, -.012, .18), .009, 3, 10);
      collar(s, at(-.055, -.025, .18), at(-.055, .001, .18), .012, .005, 1, 12);
      collar(s, at(-.055, -.122, .074), at(-.055, -.101, .074), .011, .005, 1, 12);
      shaft(s, at(-.055, -.027, .18), at(-.055, .003, .18), .0055, 3, 8);
      shaft(s, at(-.055, -.124, .074), at(-.055, -.099, .074), .0055, 3, 8);
      shaft(s, at(-.055, -.112, .074), at(-.055, -.012, .18), .005, 3, 10);
      // Lead/lag damper with a hub clevis and an outboard lug, rather than a floating tube.
      shaft(s, at(.03, 0, .07), at(.03, -.024, .07), .008, 3, 10);
      shaft(s, at(.03, -.024, .07), at(.03, -.018, .13), .009, 1, 10);
      shaft(s, at(.03, -.018, .13), at(.03, -.016, .175), .005, 3, 8);
      shaft(s, at(.03, -.016, .175), at(.02, 0, .175), .008, 3, 10);
      fasteners(s, [at(0, .018, .205)], [0, 1, 0], .008);
    }
    blade(s, m, 1.90, .102);
  }
  return finish(s, 'flight-rotor', 'flight-rotor', lod);
}
function tailRotor(lod: 0 | 1 | 2): PartMesh {
  const s = shape(lod);
  shaft(s, [-.018, 0, 0], [.028, 0, 0], .026, 3, 16);
  for (let i = 0; i < 4; i++) {
    const m = mul(rotZ(Math.PI / 2), rotY(i * Math.PI / 2));
    shaft(s, applyPoint(m, 0, 0, .018), applyPoint(m, 0, 0, .07), .008, 3, 8); blade(s, m, .34, .043);
  }
  return finish(s, 'flight-tail-rotor', 'flight-tail-rotor', lod);
}
export function dragonflyModel(lod: 0 | 1 | 2): PartMesh[] {
  const old = cache.get(lod); if (old) return old;
  const parts = [airframe(lod)];
  for (const side of [-1, 1]) parts.push(engine(lod, side), landingGear(lod, side), weapons(lod, side));
  // This name participates in the existing weapon-failure/debris lifecycle.
  const gun = shape(lod);
  // The adapter penetrates the belly skin. Yaw bearing → yoke → pitch trunnion → receiver.
  plate(gun, [0, -.13, .84], [.16, .06, .20], 0, .014);
  shaft(gun, [0, -.145, .84], [0, -.182, .84], .071, 1, 24);
  collar(gun, [0, -.16, .84], [0, -.178, .84], .082, .061, 3, 24);
  for (const side of [-1, 1]) {
    plate(gun, [side * .059, -.203, .857], [.018, .085, .115], 0, .009);
    collar(gun, [side * .06, -.214, .87], [side * .082, -.214, .87], .027, .014, 3, 16);
    fasteners(gun, [[side * .084, -.214, .87]], [side, 0, 0], .011);
    shaft(gun, [side * .045, -.236, .88], [side * .045, -.236, 1.02], .007, 3, 10);
  }
  shaft(gun, [-.079, -.214, .87], [.079, -.214, .87], .014, 3, 16);
  plate(gun, [0, -.221, .925], [.103, .083, .17], 1, .013);
  collar(gun, [0, -.22, .978], [0, -.22, 1.016], .043, .030, 3, 20);
  fasteners(gun, [[-.06, -.107, .78], [.06, -.107, .78], [-.06, -.107, .90], [.06, -.107, .90]], [0, 1, 0], .007);
  shaft(gun, [-.072, -.214, .89], [-.072, -.214, .978], .019, 1, 16);
  if (!gun.coarse) { gun.material(2); sweep(gun, null, [[.073, -.20, .89], [.10, -.19, .77], [.10, -.13, .67]], .013, 10, { bend: .035 }); }
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3, x = Math.cos(a) * .022, y = -.22 + Math.sin(a) * .022;
    shaft(gun, [x, y, .995], [x, y, 1.28], .009, 3, 10);
    collar(gun, [x, y, 1.26], [x, y, 1.29], .011, .006, 1, 10);
  }
  collar(gun, [0, -.22, 1.15], [0, -.22, 1.17], .035, .029, 1, 16);
  for (let i = 2; i < gun.mb.p.length; i += 3) gun.mb.p[i] -= .12;
  parts.push(finish(gun, 'flight-pod-chin-gun', 'hull', lod), tail(lod), mainRotor(lod), tailRotor(lod));
  cache.set(lod, parts); return parts;
}
