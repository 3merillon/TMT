/**
 * Hull construction: a narrow scout tub with independent walkways, a stepped medium crew compartment,
 * and a broad siege body with a steep armored bow. Ring and running-gear interfaces are shared; each
 * structural front profile and shoulder construction remains distinct. Fenders follow the selected gear.
 */
import { EDGE, bolts, box, cylinder, lathe, loft, mm, prism, rx, sweep, tr, type Shape } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { transformConvex } from '../../geometry/convex';
import { KIT_FLAG } from '../../geometry/mesh';
import { BELLY_Y, DECK_Y, RING_COLLAR_MARGIN, RING_FRAME, SPONSON_UNDERSIDE } from '../../sockets';
import { MAT_ID } from '../../types';
import { gearSlabs } from '../gear/common';
import { hubDrop } from '../../running';
import type { HullSpec, KitContext } from '../types';

/** Legacy slope retained for callers describing the original kit. New bodies use hullFrontProfile. */
export const GLACIS_SLOPE = -Math.tan(32 * Math.PI / 180);

/** Structural front section (z, y), rear to nose. These are deliberately different constructions. */
export function hullFrontProfile(spec: HullSpec): readonly (readonly [number, number])[] {
  if (spec.frontProfile) return spec.frontProfile;
  if ((spec.archetype ?? spec.id) === 'skiff') return [[spec.deckFront, DECK_Y], [0.4, 0.04], spec.nose];
  if ((spec.archetype ?? spec.id) === 'warden') return [[spec.deckFront, DECK_Y], [0.39, 0.08], [0.65, 0.08], spec.nose];
  return [[spec.deckFront, DECK_Y], spec.nose];
}
export function glacisSlope(spec: HullSpec, z: number): number {
  const profile = hullFrontProfile(spec);
  let i = 0; while (i < profile.length - 2 && z > profile[i + 1][0]) i++;
  return (profile[i + 1][1] - profile[i][1]) / (profile[i + 1][0] - profile[i][0]);
}
export function glacisY(spec: HullSpec, z: number): number {
  const profile = hullFrontProfile(spec);
  let i = 0; while (i < profile.length - 2 && z > profile[i + 1][0]) i++;
  return profile[i][1] + (z - profile[i][0]) * glacisSlope(spec, z);
}
export function glacisZ(spec: HullSpec, y: number): number {
  const p = hullFrontProfile(spec);
  for (let i = 0; i + 1 < p.length; i++) if (p[i][1] >= y && p[i + 1][1] <= y && p[i][1] !== p[i + 1][1]) return p[i][0] + (y - p[i][1]) * (p[i + 1][0] - p[i][0]) / (p[i + 1][1] - p[i][1]);
  return p[p.length - 1][0];
}

/** Fender plate thickness and the default drop of the bent front lip. */
export const FENDER_T = 0.016;
export const FENDER_LIP = 0.05;
/** How far the flat fenders reach past the end-wheel axles, as a fraction of the wheel radius. */
export const FENDER_OVERHANG = 0.5;

/**
 * z extents of the flat fenders over the track ends: past the sprocket axle at the front and past the idler axle at
 * its rearmost tensioner position at the rear. With the front lip (fenderReach) they stay inside the belt's length,
 * so no fender protrudes past the tracks at bumper height: the belt ends (at the end-wheel height) are the first
 * contact in a head-on collision, as in kit v1, rather than a lip 0.6 above the ground (fix round 2; see
 * tests/kit-proxies.test.ts "contact reach").
 */
export function fenderSpan(ctx: KitContext): { front: number; rear: number } {
  const g = ctx.gear;
  return { front: g.sprocket.z + FENDER_OVERHANG * g.sprocket.r, rear: g.idler.z - g.tensioner.travel - FENDER_OVERHANG * g.idler.r };
}

/** Front z of the fender lip (the largest lip: FENDER_LIP), for the collision proxy. */
export function fenderReach(ctx: KitContext): number {
  return fenderSpan(ctx).front + FENDER_LIP * 0.9 + FENDER_T * 0.4;
}

/** Lower hull, upper hull, collar and glacis. Returns key z values for details. */
export function hullBody(s: Shape, ctx: KitContext): { zg: number } {
  const h = ctx.hull, W = ctx.lowerHalfWidth, U = ctx.upperHalfWidth, S = SPONSON_UNDERSIDE;
  const zg = glacisZ(h, S);
  s.tag = 'hull-body';
  s.material(MAT_ID.paint);
  // Lower hull (y, z profile for prism along x).
  // The lower shell is an authored hull for each archetype, not a common extrusion.
  // Recon tapers strongly at both ends; medium keeps a square crew compartment;
  // heavy carries almost its full armor width all the way to the blunt nose.
  const shape = (h.archetype ?? h.id) === 'skiff' ? [0.68, 0.84, 1, 0.82, 0.58]
    : (h.archetype ?? h.id) === 'warden' ? [0.87, 0.98, 1, 0.96, 0.86] : [0.96, 1, 1, 0.99, 0.96];
  const lowerSection = (z: number, bottom: number, top: number, width: number): Vec3[] => [
    [-W * width * 0.84, bottom, z], [W * width * 0.84, bottom, z], [W * width, top, z], [-W * width, top, z],
  ];
  const frontStations = [...new Set([zg, ...hullFrontProfile(h).filter(([z]) => z > zg).map(([z]) => z), h.bellyFront])].sort((a, b) => a - b);
  const lowerSections = [
    lowerSection(h.rear, h.rearLow, S, shape[0]),
    lowerSection(h.bellyRear, BELLY_Y, S, shape[1]),
    ...frontStations.map(z => {
      const f = z < h.bellyFront ? (z - zg) / Math.max(1e-6, h.bellyFront - zg) : (z - h.bellyFront) / (h.nose[0] - h.bellyFront);
      const width = z < h.bellyFront ? shape[2] + (shape[3] - shape[2]) * f : shape[3] + (shape[4] - shape[3]) * f;
      const bottom = z <= h.bellyFront ? BELLY_Y : BELLY_Y + (h.nose[1] - 0.008 - BELLY_Y) * f;
      return lowerSection(z, bottom, glacisY(h, z), width);
    }),
  ];
  // Separate convex construction sections keep bounds and the interference model exact.
  for (let i = 0; i + 1 < lowerSections.length; i++) loft(s, null, [lowerSections[i], lowerSections[i + 1]], { edges: [EDGE.chamfer], caps: [i === 0, i === lowerSections.length - 2] });
  // Distinct structural decks. The Skiff has a narrow, bevelled scout boat deck; the
  // Warden has square welded shoulders; the Bastion has broad, thick armor shoulders.
  const shoulder = (h.archetype ?? h.id) === 'skiff' ? 0.94 : (h.archetype ?? h.id) === 'warden' ? 0.96 : 0.98;
  const end = (h.archetype ?? h.id) === 'skiff' ? 0.72 : (h.archetype ?? h.id) === 'warden' ? 0.91 : 0.96;
  const coreWidth = (h.archetype ?? h.id) === 'skiff' ? W : (h.archetype ?? h.id) === 'warden' ? W + 0.035 : U;
  const section = (z: number, y: number, width: number): Vec3[] => [
    [-width, S, z], [width, S, z], [width * shoulder, y, z], [-width * shoulder, y, z],
  ];
  loft(s, null, [
    section(h.upperRear, DECK_Y - ((h.archetype ?? h.id) === 'bastion' ? 0.016 : 0.035), coreWidth * end),
    section(h.upperRear + ((h.archetype ?? h.id) === 'skiff' ? 0.2 : 0.08), DECK_Y, coreWidth),
    section(h.deckFront, DECK_Y, coreWidth),
    section(zg, S + 0.001, coreWidth * ((h.archetype ?? h.id) === 'skiff' ? 0.82 : 0.96)),
  ], { edges: [EDGE.chamfer, EDGE.none, EDGE.chamfer] });
  if ((h.archetype ?? h.id) === 'skiff') {
    // Separate pressed running-board fenders leave a visible open channel alongside
    // the compact crew tub. Narrow bridges explain how those thin decks are held.
    for (const side of [-1, 1]) {
      const inner = W + 0.07, outer = U - 0.025;
      box(s, tr(side * (inner + outer) / 2, S + FENDER_T / 2, (h.upperRear + zg) / 2), [outer - inner, FENDER_T, zg - h.upperRear], 0);
      s.material(MAT_ID.darkSteel);
      for (const z of [-0.43, 0.1]) box(s, tr(side * (W + 0.055), S + 0.008, z), [0.13, 0.014, 0.027], 0);
      s.material(MAT_ID.paint);
    }
  } else if ((h.archetype ?? h.id) === 'warden') {
    // Two lower welded shoulder boxes form a step below the central crew deck.
    // Their clipped front ends are separate from the thin end-wheel fenders.
    for (const side of [-1, 1]) {
      const x0 = side > 0 ? coreWidth - 0.004 : -U, x1 = side > 0 ? U : -coreWidth + 0.004;
      prism(s, null, 'x', [[S, h.upperRear], [DECK_Y - 0.026, h.upperRear + 0.07], [DECK_Y - 0.026, h.deckFront - 0.14], [S, h.deckFront - 0.035]], x0, x1, 0);
    }
  }
  // Turret-ring collar (hull side of the seated ring pair).
  s.tag = 'ring-collar';
  s.material(MAT_ID.darkSteel);
  const rc = ctx.ringRadius + RING_COLLAR_MARGIN;
  // LOD2: the outer band only (the turret hides the rest).
  if (s.coarse) lathe(s, tr(RING_FRAME[0], 0, RING_FRAME[2]), [[rc + 0.012, DECK_Y - 0.004], [rc, RING_FRAME[1]]], 24, { smooth: false, caps: [false, false], hullProfile: null });
  // A closed profile loop: the last band is the annular underside. End caps would put a second disc facing
  // down under the inner wall, wound against it, which opens the collar's shadow volumes.
  else lathe(s, tr(RING_FRAME[0], 0, RING_FRAME[2]), [[rc + 0.012, DECK_Y - 0.004], [rc + 0.012, DECK_Y + 0.006], [rc, RING_FRAME[1]], [rc - 0.03, RING_FRAME[1]], [rc - 0.03, DECK_Y - 0.004], [rc + 0.012, DECK_Y - 0.004]], 24, { smooth: false, caps: [false, false], hullProfile: [[rc + 0.012, DECK_Y - 0.004], [rc + 0.012, DECK_Y + 0.006], [rc, RING_FRAME[1]]] });
  if (s.fine) {
    const n = 10, pts: Vec3[] = [];
    for (let i = 0; i < n; i++) { const a = (i + 0.5) / n * Math.PI * 2; pts.push([Math.cos(a) * (rc + 0.006), DECK_Y + 0.006, RING_FRAME[2] + Math.sin(a) * (rc + 0.006)]); }
    bolts(s, null, pts, [0, 1, 0], 0.007, 0.005);
  }
  s.material(MAT_ID.paint);
  return { zg };
}

/** Flat fenders over the track ends, with a bent lip; brackets tie them to the hull. */
export function fenders(s: Shape, ctx: KitContext, zg: number, opts: { lip?: number } = {}): void {
  const h = ctx.hull, U = ctx.upperHalfWidth - ((h.archetype ?? h.id) === 'skiff' ? 0.025 : 0), S = SPONSON_UNDERSIDE, x0 = (h.archetype ?? h.id) === 'skiff' ? ctx.lowerHalfWidth + 0.07 : ctx.beltInner - 0.012, { front, rear } = fenderSpan(ctx);
  s.tag = 'fender';
  s.material(MAT_ID.paint);
  const t = FENDER_T, lip = Math.min(opts.lip ?? FENDER_LIP, FENDER_LIP);
  for (const side of [-1, 1]) {
    const cx = side * (x0 + U) / 2, w = U - x0;
    // The end-wheel envelope is fixed to the hull; the full suspension belt envelope
    // controls the root. Crawler's raised drive gets a high arch, Scout a low tapered
    // nose, Grip a broad two-step pressing. Every underside stays above the swept belt.
    const rootY = Math.max(S, ctx.topRunY + 0.05);
    const endY = Math.max(ctx.gear.sprocket.y + ctx.gear.sprocket.r + 0.085, rootY - (ctx.gear.suspension === 'torsion' ? 0.025 : 0.008));
    const station = (z: number, y: number): Vec3[] => [[cx - w / 2, y, z], [cx + w / 2, y, z], [cx + w / 2, y + t, z], [cx - w / 2, y + t, z]];
    const bendZ = ctx.gear.suspension === 'rocker' ? ctx.gear.sprocket.z - 0.06 : (zg + front) / 2;
    loft(s, null, s.coarse ? [station(zg, rootY), station(front, endY)] : [station(zg, rootY), station(bendZ, rootY), station(front, endY)], { edges: [EDGE.chamfer, EDGE.chamfer] });
    loft(s, null, [
      station(front, endY),
      [[cx - w / 2, endY - lip, front + lip * 0.9], [cx + w / 2, endY - lip, front + lip * 0.9], [cx + w / 2, endY - lip + t * 0.8, front + lip * 0.9 + t * 0.4], [cx - w / 2, endY - lip + t * 0.8, front + lip * 0.9 + t * 0.4]],
    ], { edges: [EDGE.chamfer] });
    // Rear fender.
    const rearY = rootY - (ctx.gear.suspension === 'rocker' ? 0.035 : 0.02);
    loft(s, null, s.coarse ? [station(h.upperRear, rootY), station(rear, rearY)] : [station(h.upperRear, rootY), station((h.upperRear + rear) / 2, rootY), station(rear, rearY)], { edges: [EDGE.chamfer, EDGE.chamfer] });
    // Short reinforced rubber flap, above the idler's entire tensioner sweep. Its
    // resting bend is fixed (no unconstrained spring can kick it into the track).
    s.material(MAT_ID.rubber);
    s.with({ tag: 'mud-flap' }, () => box(s, tr(cx, rearY - 0.018, rear + 0.008), [w * 0.93, 0.052, 0.012], 0));
    s.material(MAT_ID.darkSteel);
    if (!s.coarse) cylinder(s, null, [cx - w * 0.48, rearY, rear + 0.008], [cx + w * 0.48, rearY, rear + 0.008], 0.009, 8);
    s.material(MAT_ID.paint);
    if (s.fine) {
      bolts(s, null, [0.3, 0.6, 0.9].map(f => [cx, S + t, zg + (front - zg) * f] as Vec3), [0, 1, 0]);
      bolts(s, null, [0.3, 0.7].map(f => [cx, S + t, h.upperRear + (rear - h.upperRear) * f] as Vec3), [0, 1, 0]);
    }
  }
}

/** Final drive housings, and the grip's bogie brackets and return-roller stub axles (hull-side mounts). */
function finalDriveCase(s: Shape, ctx: KitContext, side: number): void {
  const g = ctx.gear, W = ctx.lowerHalfWidth, cy = g.sprocket.y, cz = g.sprocket.z;
  const x0 = W * 0.72, x1 = g.halfSpacing - g.sprocket.width / 2 - 0.008;
  const rootZ = Math.min(cz - 0.13, ctx.hull.bellyFront - 0.05);
  const n = s.fine ? 16 : 6, r = 0.068, bore = 0.04;
  const innerIn: Vec3[] = [], innerOut: Vec3[] = [], outerIn: Vec3[] = [], outerOut: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n, ca = Math.cos(a), sa = Math.sin(a), rear = Math.max(0, -sa);
    // A rounded axle collar flows directly into a long tapered hull root. The
    // outside face also draws inward at the tail to stay clear of moving arms.
    const z = cz + r * sa - (cz - rootZ - r) * rear, y = cy + r * ca + rear * 0.035;
    const blend = Math.max(0, Math.min(1, (z - (cz - 0.13)) / 0.09));
    const x = W - 0.004 + (x1 - W + 0.004) * blend;
    outerIn.push([side * x0, y, z]); outerOut.push([side * x, y, z]);
    innerIn.push([side * x0, cy + bore * ca, cz + bore * sa]);
    innerOut.push([side * x1, cy + bore * ca, cz + bore * sa]);
  }
  s.material(MAT_ID.paint);
  if (s.coarse) { loft(s, null, [outerIn, outerOut]); return; }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const front = [outerOut[i], outerOut[j], innerOut[j], innerOut[i]];
    const back = [outerIn[i], outerIn[j], innerIn[j], innerIn[i]];
    const outer = [outerIn[i], outerIn[j], outerOut[j], outerOut[i]];
    const inner = [innerIn[i], innerIn[j], innerOut[j], innerOut[i]];
    s.mb.poly(front, EDGE.soft, [side, 0, 0]);
    s.mb.poly(back, EDGE.soft, [-side, 0, 0]);
    s.mb.poly(outer, EDGE.soft, [0, (outerIn[i][1] + outerIn[j][1]) / 2 - cy, (outerIn[i][2] + outerIn[j][2]) / 2 - cz]);
    s.mb.poly(inner, EDGE.rim, [0, cy - (innerIn[i][1] + innerIn[j][1]) / 2, cz - (innerIn[i][2] + innerIn[j][2]) / 2]);
    s.addHull([front, back, outer, inner, [outerIn[i], outerOut[i], innerOut[i], innerIn[i]], [outerIn[j], outerOut[j], innerOut[j], innerIn[j]]]);
  }
  // The steel shaft remains visible inside the real bore and for 7 mm before
  // the rotating gear hub. It is not painted over or replaced with a solid cap.
  s.material(MAT_ID.gunmetal);
  cylinder(s, null, [side * (x0 - 0.015), cy, cz], [side * (x1 + 0.007), cy, cz], 0.027, 10, { caps: [false, false] });
}

export function gearMounts(s: Shape, ctx: KitContext): void {
  const g = ctx.gear, W = ctx.lowerHalfWidth, c = g.halfSpacing;
  s.tag = 'gear-mount';
  s.material(MAT_ID.darkSteel);
  for (const side of [-1, 1]) {
    finalDriveCase(s, ctx, side);
    if (s.coarse) continue; // The silhouette carrier remains; hidden pivot bolts are subpixel.
    const slabs = gearSlabs(ctx), pivotX = slabs.arm[0] - 0.0005;
    s.material(MAT_ID.darkSteel);
    // Idler pivot housing and the four torsion-bar seats meet the animated members.
    cylinder(s, null, [side * W * 0.62, g.idler.y + g.tensioner.dy, g.idler.z + g.tensioner.dz], [side * pivotX, g.idler.y + g.tensioner.dy, g.idler.z + g.tensioner.dz], 0.031, 8, { caps: [false, true] });
    if (g.suspension !== 'bogie') for (let i = 0; i < 4; i++) {
      const wheel = g.wheels[g.suspension === 'torsion' ? i : i * 2];
      const z = (i / 3 * 2 - 1) * g.halfLength + g.armLength, y = g.wheelY0 - hubDrop(g, wheel);
      if (z > ctx.hull.bellyFront - 0.025) {
        // The forward torsion pivot sits ahead of a clipped scout nose. A diagonal
        // belly saddle carries it; an isolated crosswise cylinder looked like a
        // second loose axle below the final drive. Stop before the moving arm slab.
        const rootZ = ctx.hull.bellyFront - 0.07;
        s.material(MAT_ID.paint);
        prism(s, null, 'x', [[y - 0.037, z + 0.038], [y + 0.037, z + 0.038], [y + 0.09, rootZ], [y - 0.015, rootZ]], side > 0 ? W * 0.62 : -pivotX, side > 0 ? pivotX : -W * 0.62, 0);
        s.material(MAT_ID.darkSteel);
      } else cylinder(s, null, [side * W * 0.62, y, z], [side * pivotX, y, z], 0.032, 8, { caps: [false, true] });
    }
    // Roller stubs.
    for (const roller of g.rollers) {
      cylinder(s, null, [side * (W - 0.02), roller.y, roller.z], [side * (c - roller.width / 2 - 0.003), roller.y, roller.z], 0.016, 10, { caps: [false, true] });
    }
    // Bogie brackets: from the hull side over the bogie, below the belt top run.
    if (g.suspension === 'bogie') {
      const slab = gearSlabs(ctx).rocker;
      for (const zb of [-g.halfLength + g.rockerHalf, g.halfLength - g.rockerHalf]) {
        box(s, tr(side * (W - 0.01 + slab[1]) / 2, (g.springTop - 0.075) / 2, zb), [slab[1] - (W - 0.01), -0.075 - g.springTop, 0.1], 0.006);
      }
    }
  }
}

/** A pair of headlights (lathe housings with glass lenses) facing +z. */
export function headlightMounts(ctx: KitContext): Vec3[] {
  const h = ctx.hull, dz = (h.archetype ?? h.id) === 'bastion' ? 0.02 : (h.archetype ?? h.id) === 'warden' ? 0.1 : 0.08;
  const x = (h.archetype ?? h.id) === 'bastion' ? 0.33 : 0.3, z = h.deckFront + dz;
  return [[x, glacisY(h, z) + 0.035, z], [-x, glacisY(h, z) + 0.035, z]];
}

export function headlights(s: Shape, positions: readonly Vec3[]): void {
  if (s.detail <= 0.3) return;
  s.tag = 'lights';
  for (const p of positions) {
    s.material(MAT_ID.darkSteel);
    // Tapered cast pedestal meets the glacis and the lamp cup; no buried bevel faces.
    prism(s, null, 'x', [[p[1] - .044, p[2] - .023], [p[1] - .008, p[2] - .015], [p[1] - .008, p[2] + .009], [p[1] - .040, p[2] + .017]], p[0] - .0175, p[0] + .0175, 0);
    const frame = mm(tr(p[0], p[1], p[2]), rx(Math.PI / 2));
    lathe(s, frame, [[0.018, -0.03], [0.032, -0.018], [0.032, 0.013], [0.027, 0.018], [0.025, 0.012], [0.025, -0.014], [0.018, -0.03]], s.fine ? 16 : 12, { caps: [false, false], hullProfile: [[0.018, -0.03], [0.032, -0.018], [0.032, 0.018]] });
    s.material(MAT_ID.chrome);
    lathe(s, frame, [[0.025, 0.008], [0.010, -0.014], [0, -0.016]], 12, { caps: [false, false], hullProfile: null });
    s.material(MAT_ID.signal, KIT_FLAG.headlight);
    lathe(s, frame, [[0.006, -0.012], [0.006, -0.005], [0, -0.002]], 8, { caps: [false, false], hullProfile: null });
    s.material(MAT_ID.glass, KIT_FLAG.headlight);
    // Seat the glass edge just inside the metal lip. Coinciding with the cup's
    // inner corner gives three triangles the same edge and breaks shadow winding.
    lathe(s, frame, [[0.02525, 0.0115], [0.026, 0.016], [0.017, 0.023], [0, 0.024]], 16, { caps: [false, false], hullProfile: null });
  }
}

/** Tow hooks (bent tubes) at the nose. */
export function towHooks(s: Shape, ctx: KitContext, z: number, y: number): void {
  if (s.detail <= 0.3) return;
  s.tag = 'tow';
  s.material(MAT_ID.darkSteel);
  const x = ctx.lowerHalfWidth - 0.07;
  for (const side of [-1, 1]) {
    sweep(s, null, [[side * x, y + 0.03, z - 0.02], [side * x, y + 0.01, z + 0.04], [side * x, y - 0.035, z + 0.03]], 0.011, 8, { bend: 0.02 });
  }
}

/**
 * A swept exhaust with flange at the root and a bore at the outlet; returns the outlet frame data. At LOD2 only
 * a `silhouette` exhaust keeps its main run (a hexagonal tube: the Warden's upright stacks).
 */
export function exhaustPipe(s: Shape, path: readonly Vec3[], radius: number, opts: { silhouette?: boolean } = {}): { outlet: Vec3; dir: Vec3 } {
  s.tag = 'exhaust';
  s.material(MAT_ID.gunmetal);
  if (s.coarse && opts.silhouette) cylinder(s, null, path[0], path[1], radius, 6, { smooth: false, caps: [false, true], hullProfile: null });
  if (s.detail > 0.3) sweep(s, null, path, radius, 10, { bend: radius * 1.6, flange: { radius: radius * 1.55, thickness: 0.012 }, bore: { radius: radius * 0.72, depth: radius * 1.4, mat: MAT_ID.darkSteel } });
  const a = path[path.length - 2], b = path[path.length - 1];
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(...d);
  return { outlet: [...b] as Vec3, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/** One crew access point: an open mount needs a hull hatch; enclosed turrets own it themselves. */
export function hullCrewAccess(s: Shape, ctx: KitContext): void {
  if (ctx.turret.hatch || s.coarse) return;
  const kind = ctx.hull.archetype ?? ctx.hull.id;
  const [x, z, r] = kind === 'skiff' ? [0, ctx.hull.id === 'skiff' ? .32 : .48, .072] : kind === 'warden' ? [.18, .50, .080] : [.35, .22, .090];
  // glacisY describes the front slope only: extrapolating it behind deckFront
  // puts an otherwise flat deck fitting high above the tank.
  const surfaceY = z > ctx.hull.deckFront ? glacisY(ctx.hull, z) : DECK_Y;
  const pitch = z > ctx.hull.deckFront ? Math.atan(-glacisSlope(ctx.hull, z)) : 0;
  const firstVertex = s.mb.vertexCount, firstHull = s.hulls.length;
  s.tag = 'deck-hatch'; s.material(MAT_ID.darkSteel);
  // Closed annular seat: no coincident end caps along the inner lip.
  lathe(s, null, [[r + .008, -.003], [r + .008, .006], [r - .004, .006], [r - .004, -.003], [r + .008, -.003]], 16, { caps: [false, false] });
  s.material(MAT_ID.rubber); lathe(s, null, [[r - .004, .0065], [r - .012, .0065]], 16, { caps: [false, false], hullProfile: null });
  s.material(MAT_ID.paint); lathe(s, null, [[r - .009, .007], [r - .009, .014], [r - .017, .020], [0, .020]], 16, { caps: [true, false], smooth: false });
  s.material(MAT_ID.darkSteel); cylinder(s, null, [-r * .62, .010, -r], [r * .62, .010, -r], .006, 8);
  if (s.fine) {
    for (const side of [-1, 1]) { box(s, tr(side * r * .58, .004, -r), [.013, .019, .020], 0); box(s, tr(side * r * .23, .027, 0), [.009, .014, .012], 0); }
    box(s, tr(0, .035, 0), [r * .55, .007, .012], 0);
    s.material(MAT_ID.brass); cylinder(s, null, [0, .020, r * .70], [0, .029, r * .70], .006, 6); box(s, tr(r * .12, .030, r * .71), [r * .32, .006, .010], 0);
  }
  const m = mm(tr(x, surfaceY, z), rx(pitch)); s.mb.transform(m, firstVertex);
  for (let i = firstHull; i < s.hulls.length; i++) s.hulls[i] = transformConvex(s.hulls[i], m);
  s.material(MAT_ID.paint);
}

/** Box of a given size sitting on the deck. */
export function deckBox(s: Shape, center: Vec3, size: Vec3, bevel = 0.008, tag = 'stowage'): void {
  s.tag = tag;
  box(s, tr(center[0], center[1], center[2]), size, bevel);
}

export { BELLY_Y, DECK_Y, SPONSON_UNDERSIDE };
