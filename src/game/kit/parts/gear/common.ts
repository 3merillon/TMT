/**
 * Running-gear prototype builders (W1-KIT). Every repeated part is built once in its own local frame for the
 * +X side (outboard = +x) and posed by the rig (rig.ts):
 * - links: x across the belt, y outward from the belt loop, z along the travel direction, origin on the belt
 *   centre line;
 * - wheels / hubs / sprockets / idlers / rollers: turned about local X, origin at the axle;
 * - arms (torsion) and tensioners: pivot at the origin, the arm runs toward −z to its wheel / idler axle;
 * - bogies (grip) and rockers (crawler): beam centred on the pivot, wheel stubs outboard at z = ±rockerHalf;
 * - springs: a unit-height coil along +y (the rig scales it to the bracket gap).
 * Arms, rockers, bogies and tensioners live in thin x slabs between the lower hull side and the wheels
 * (x ∈ [lowerHalfWidth + 2 mm, wheel inner face − 2 mm]); the ones that span the belt height stay inside the
 * belt edge so no joint state can bring them into the links.
 */
import { EDGE, box, cylinder, gear, lathe, latheHullFaces, loft, mm, prism, rx, rz, tr, type Shape } from '../../geometry/shapes';
import type { Vec3 } from '../../geometry/math';
import { MAT_ID } from '../../types';
import type { GearSpec, GroupShapes, KitContext } from '../types';

/** Belt link section (belt-centre-line relative): inner face, top of the sole, top of the grouser. */
export const LINK_SECTION = Object.freeze({ inner: -0.018, sole: 0.012, grouser: 0.025, lengthFraction: 0.92 });
/** Wheel stub clearance and slab gap. */
const GAP = 0.002;

/** Square bolt head seated in a wheel cover; its back face is buried in the plate. */
function wheelBolt(s: Shape, x: number, y: number, z: number, half: number): void {
  loft(s, null, [x - .006, x + .006].map(at => [[at, y - half, z - half], [at, y + half, z - half], [at, y + half, z + half], [at, y - half, z + half]] as Vec3[]), { caps: [false, true] });
}

/** X slabs (+X side, absolute |x|) for the suspension members of a gear. */
export function gearSlabs(ctx: KitContext): { arm: [number, number]; rocker: [number, number]; wheelInner: number } {
  const g = ctx.gear;
  const wheelInner = Math.min(...g.wheels.map(w => g.halfSpacing + w.dx - w.width / 2));
  const lo = ctx.lowerHalfWidth + GAP;
  return { arm: [lo, ctx.beltInner - GAP], rocker: [ctx.beltInner + GAP, wheelInner - GAP], wheelInner };
}

export function buildLink(s: Shape, g: GearSpec, pitch: number): void {
  s.tag = 'link';
  s.material(MAT_ID.darkSteel);
  const hw = g.width * 0.49, hz = pitch * LINK_SECTION.lengthFraction / 2, { inner, sole, grouser } = LINK_SECTION;
  if (s.detail <= 0.3) {
    // LOD2: the outer face of a double-pitch link (LOD2 draws every other link; running.ts linkSlot).
    const hz2 = pitch * (1 + LINK_SECTION.lengthFraction) / 2;
    s.mb.poly([[-hw, sole, -hz2], [hw, sole, -hz2], [hw, sole, hz2], [-hw, sole, hz2]], EDGE.none, [0, 1, 0]);
    return;
  }
  if (s.detail < 0.99) {
    // LOD1: the outer face and the two lateral faces (the ends hide against the neighbours).
    const w = g.width * 0.49, top = grouser, bot = inner;
    // Rubber contact faces remain readable at the middle LOD, without extra geometry.
    if (g.wheelStyle === 'disc' || g.wheelStyle === 'aether') s.material(MAT_ID.rubber);
    s.mb.poly([[-w, top, -hz], [w, top, -hz], [w, top, hz], [-w, top, hz]], EDGE.none, [0, 1, 0]);
    s.material(MAT_ID.darkSteel);
    for (const x of [-w, w]) s.mb.poly([[x, bot, -hz], [x, top, -hz], [x, top, hz], [x, bot, hz]], EDGE.soft, [Math.sign(x), 0, 0]);
    return;
  }
  // A thin rolled steel backing supports the contact pad. Avoid tiny bevel bands on every repeated shoe;
  // those triangles are spent on the much more visible rounded wheel silhouettes.
  const profile: [number, number][] = [[inner, -hz], [inner, hz], [sole, hz], [sole, -hz]];
  prism(s, null, 'x', profile, -hw, hw, 0);
  s.material(MAT_ID.gunmetal);
  // The grouser is welded to the sole. Omit its buried bottom cap instead of
  // repeating two hidden triangles on every track shoe.
  const padded = g.wheelStyle === 'disc' || g.wheelStyle === 'aether' || g.wheelStyle === 'forge';
  const forge = g.wheelStyle === 'forge';
  const gw = g.width * (padded && !forge ? .34 : .48), gz = pitch * (g.wheelStyle === 'aether' ? .31 : padded ? .25 : .11);
  if (padded && !forge) s.material(MAT_ID.rubber);
  // Pads sit on a wider steel shoe: its exposed side margins carry the pins and protect the rubber edges.
  loft(s, null, [sole, grouser].map(y => [[-gw, y, -gz], [gw, y, -gz], [gw, y, gz], [-gw, y, gz]] as Vec3[]), { caps: [false, true] });
  if (forge) {
    // Flush rubber insert recessed into the broad steel grouser. A tiny separation avoids coplanar sampling.
    s.material(MAT_ID.rubber);
    const rw = g.width * .31, rz = gz * .8, y = grouser + .00005;
    s.mb.poly([[-rw, y, -rz], [rw, y, -rz], [rw, y, rz], [-rw, y, rz]], EDGE.soft, [0, 1, 0]);
  }
}

/** Road wheel tyre (rubber) about local X, outboard face at +x. */
export function buildTyre(s: Shape, radius: number, width: number, style: GearSpec['wheelStyle']): void {
  s.tag = 'wheel';
  s.material(MAT_ID.rubber);
  const hw = width / 2, inner = radius * (style === 'spoked' ? 0.8 : 0.82), c = 0.014;
  const hull: [number, number][] = [[radius - c, -hw], [radius, -hw + c], [radius, hw - c], [radius - c, hw]];
  if (s.detail <= 0.3) {
    // Below fourteen projected tank pixels, the belt supplies the crown silhouette. Only the visible
    // outboard disc is needed; drawing sixteen buried tyre cylinders would spend most of this LOD's budget.
    s.mb.poly(Array.from({ length: 6 }, (_, i) => [hw, Math.cos(i * Math.PI / 3) * radius, Math.sin(i * Math.PI / 3) * radius] as Vec3), EDGE.none, [1, 0, 0]);
    return;
  }
  // Annular tyre with chamfered shoulders; the solid wheel is the validation piece.
  // Twenty-four sides make the silhouette round. The buried inner cylindrical wall is omitted;
  // one continuous rear shoulder also replaces two tiny bands hidden behind the suspension.
  const A = rz(-Math.PI / 2);
  if (s.fine) {
    // The recessed inboard annulus needs fewer sectors; the exposed crown and outer shoulder remain 24-sided.
    lathe(s, A, [[inner, -hw], hull[1]], 12, { caps: [false, false], hullProfile: null });
    lathe(s, A, [...hull.slice(1), [inner, hw]], 24, { caps: [false, false], hullProfile: hull });
  } else lathe(s, A, [[inner, -hw], [radius, -hw], [radius, hw], [inner, hw]], 12, { caps: [false, false], hullProfile: hull });
}

/** Road wheel hub (metal) inside the tyre ring. */
export function buildHub(s: Shape, radius: number, width: number, style: GearSpec['wheelStyle']): void {
  s.tag = 'hub';
  const hw = width / 2, inner = radius * (style === 'spoked' ? 0.8 : 0.82), A = rz(-Math.PI / 2);
  if (s.detail <= 0.3) return;
  s.noHull = true; // the tyre's solid validation piece already covers the whole wheel
  s.material(MAT_ID.paint);
  // The radial hub wall lies inside the tyre. Keep the visible front and back discs, omitting that buried wall.
  const cover = (profile: [number, number][], segments: number) => {
    lathe(s, A, profile.slice(1), segments, { hullProfile: null, caps: [false, false] });
    s.mb.poly(Array.from({ length: 12 }, (_, i) => [profile[0][1], Math.cos(i * Math.PI / 6) * profile[0][0], Math.sin(i * Math.PI / 6) * profile[0][0]] as Vec3), EDGE.rim, [-1, 0, 0]);
  };
  if (s.detail < 0.99) {
    lathe(s, A, [[inner + 0.002, hw * 0.4], [0, hw * 0.5]], 8, { hullProfile: null, caps: [false, false], smooth: false });
    lathe(s, A, [[0, -hw * 0.6], [inner + 0.002, -hw * 0.6]], 8, { hullProfile: null, caps: [false, false], smooth: false });
    s.noHull = false;
    return;
  }
  if (style === 'spoked') {
    // Rim, six spokes and a domed cap: the Christie big-wheel look.
    lathe(s, A, [[inner * .86, -hw * .7], [inner + .002, -hw * .7]], 12, { caps: [false, false], hullProfile: null });
    lathe(s, A, [[inner + .002, hw * .7], [inner * .86, hw * .7]], 18, { caps: [false, false], hullProfile: null });
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      box(s, mm(rx(a), tr(hw * 0.25, 0, inner * 0.5)), [0.016, 0.022, inner * 0.78], 0);
    }
    s.material(MAT_ID.gunmetal);
    lathe(s, A, [[0.05, -hw * 0.55], [0.05, hw * 0.35], [0.03, hw * 0.58], [0, hw * 0.63]], 18, { hullProfile: null });
  } else if (style === 'disc') {
    cover([[inner + .002, -hw * .62], [inner + .002, hw * .5], [inner * .45, hw * .3], [0, hw * .58]], 20);
    s.material(MAT_ID.brass);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      wheelBolt(s, hw * .4, Math.cos(a) * inner * .3, Math.sin(a) * inner * .3, .007);
    }
  } else if (style === 'aether') {
    // Slim convex insulated cover, concentric copper conductor and a small glass axle window.
    cover([[inner + .002, -hw * .5], [inner + .002, hw * .25], [inner * .56, hw * .55], [0, hw * .61]], 20);
    s.material(MAT_ID.brass);
    lathe(s, A, [[inner * .75, hw * .425], [inner * .63, hw * .51]], 20, { hullProfile: null, caps: [false, false] });
    s.material(MAT_ID.glass);
    lathe(s, A, [[inner * .22, hw * .595], [0, hw * .635]], 16, { hullProfile: null, caps: [false, false] });
  } else {
    // Continuous pressed-steel dish; large wheels use smooth eighteen-sided faces, not faceted rings.
    cover([[inner + .002, -hw * .6], [inner + .002, hw * .3], [inner * .4, hw * (style === 'forge' ? .55 : .05)], [0, hw * (style === 'forge' ? .61 : .5)]], 18);
    if (style === 'forge') {
      // Reinforced raised bolt circle is formed in the continuous cover, within the tyre's protected shoulder.
      s.material(MAT_ID.brass);
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2;
        wheelBolt(s, hw * .46, Math.cos(a) * inner * .7, Math.sin(a) * inner * .7, .009);
      }
    }
  }
  s.noHull = false;
}

export function buildSprocket(s: Shape, g: GearSpec): void {
  s.tag = 'sprocket';
  s.material(MAT_ID.gunmetal);
  const toothTip = g.sprocket.r + LINK_SECTION.inner - 0.004, hub = toothTip - 0.016;
  gear(s, rz(-Math.PI / 2), hub, toothTip - hub, g.sprocket.teeth, g.sprocket.width, { hubMat: MAT_ID.darkSteel });
}

export function buildIdler(s: Shape, g: GearSpec): void {
  s.tag = 'idler';
  const r = g.idler.r + LINK_SECTION.inner - 0.004, hw = g.idler.width / 2, A = rz(-Math.PI / 2);
  s.material(MAT_ID.gunmetal);
  if (s.detail <= 0.3) lathe(s, A, [[r, -hw], [r, hw]], 6, { smooth: false, caps: [false, true], hullProfile: null });
  else {
    // Twin rims around a grooved centre (the guide channel) and a hub cap.
    lathe(s, A, [[r * 0.3, -hw], [r - 0.006, -hw], [r, -hw + 0.006], [r, -hw * 0.25], [r * 0.8, -hw * 0.2], [r * 0.8, hw * 0.2], [r, hw * 0.25], [r, hw - 0.006], [r - 0.006, hw], [r * 0.3, hw]], 12, { smooth: false, hullProfile: null });
    s.material(MAT_ID.darkSteel);
    if (s.fine) lathe(s, A, [[0.024, -hw - 0.006], [0.024, hw + 0.006]], 8, { hullProfile: null });
  }
  for (const faces of latheHullFaces([[r, -hw], [r, hw]], s.segs(18, 6))) s.addHull(faces, A);
}

export function buildRoller(s: Shape, roller: GearSpec['rollers'][number]): void {
  s.tag = 'roller';
  // 8 mm under the links: rigid shoes crossing a small roller chord a little inside the belt line.
  const r = roller.r + LINK_SECTION.inner - 0.008, hw = roller.width / 2, A = rz(-Math.PI / 2);
  s.material(MAT_ID.rubber);
  const hull: [number, number][] = [[r - 0.004, -hw], [r, -hw + 0.004], [r, hw - 0.004], [r - 0.004, hw]];
  lathe(s, A, s.fine ? [[r * 0.7, -hw], ...hull, [r * 0.7, hw]] : [[r, -hw], [r, hw]], 12, { hullProfile: hull });
  s.material(MAT_ID.gunmetal);
  if (s.detail >= 0.5) s.with({ noHull: true }, () => lathe(s, A, [[0, -hw - 0.004], [r * 0.7, -hw - 0.004], [r * 0.7, hw + 0.004], [0, hw + 0.004]], 10, {}));
}

/**
 * Torsion trailing arm (+X side): pivot boss at the origin spanning the arm slab, the bar running to the axle at
 * (0, 0, −L) and a stub axle out to the wheel's inner face.
 */
export function buildArm(s: Shape, length: number, slab: [number, number], x0: number, stubTo: number): void {
  s.tag = 'arm';
  s.material(MAT_ID.darkSteel);
  const t = slab[1] - slab[0], cx = (slab[0] + slab[1]) / 2 - x0;
  if (!s.fine) { box(s, tr(cx, 0, -length / 2), [t, 0.04, length + 0.04], 0); return; }
  // Boss about X at the pivot.
  cylinder(s, null, [slab[0] - x0, 0, 0], [slab[1] - x0, 0, 0], 0.03, 10, { caps: [false, true] });
  // Tapered bar (a loft of two rectangles).
  const a0: Vec3[] = [[cx - t / 2, -0.022, 0], [cx + t / 2, -0.022, 0], [cx + t / 2, 0.022, 0], [cx - t / 2, 0.022, 0]];
  const a1: Vec3[] = a0.map(p => [p[0], p[1] * 0.75, -length] as Vec3);
  loft(s, null, [a0, a1], { edges: [EDGE.soft] });
  // Axle boss and stub into the wheel hub.
  cylinder(s, null, [slab[0] - x0, 0, -length], [slab[1] - x0, 0, -length], 0.026, 10, { caps: [false, true] });
  s.material(MAT_ID.gunmetal);
  cylinder(s, null, [slab[1] - x0, 0, -length], [stubTo - x0, 0, -length], 0.018, 6, { caps: [false, false] });
}

/** Bogie beam / rocker (+X side): beam centred on the pivot, stubs outboard at z = ±half to the two wheels. */
export function buildRocker(s: Shape, half: number, slab: [number, number], x0: number, stubRear: number, stubFront: number, style?: GearSpec['wheelStyle']): void {
  s.tag = 'bogie';
  s.material(MAT_ID.darkSteel);
  const t = slab[1] - slab[0], cx = (slab[0] + slab[1]) / 2 - x0;
  if (s.fine && (style === 'aether' || style === 'forge')) {
    // Forged taper around the pivot: electrical bogies have a slim waist; heavy rockers have broad ends.
    const taper = style === 'aether' ? [.012, .02, .012] : [.02, .014, .02];
    loft(s, null, [-half - .015, 0, half + .015].map((z, i) => [[cx - t / 2, -taper[i], z], [cx + t / 2, -taper[i], z], [cx + t / 2, taper[i], z], [cx - t / 2, taper[i], z]] as Vec3[]));
  } else box(s, tr(cx, 0, 0), [t, 0.04, half * 2 + 0.03], 0);
  if (!s.fine) return;
  if (style === 'aether') s.material(MAT_ID.brass);
  cylinder(s, null, [slab[0] - x0, 0, 0], [slab[1] - x0, 0, 0], 0.03, style === 'aether' || style === 'forge' ? 12 : 10, { caps: [false, true] });
  s.material(MAT_ID.gunmetal);
  cylinder(s, null, [slab[1] - x0, 0, -half], [stubRear - x0, 0, -half], 0.016, 6, { caps: [false, false] });
  cylinder(s, null, [slab[1] - x0, 0, half], [stubFront - x0, 0, half], 0.016, 6, { caps: [false, false] });
}

/** Idler tensioner arm (+X side): pivot at the origin, idler axle at (0, 0, −L) with a stub to the idler. */
export function buildTensioner(s: Shape, length: number, slab: [number, number], x0: number, stubTo: number): void {
  s.tag = 'tensioner';
  s.material(MAT_ID.darkSteel);
  const t = slab[1] - slab[0], cx = (slab[0] + slab[1]) / 2 - x0;
  if (!s.fine) { box(s, tr(cx, 0, -length / 2), [t, 0.032, length], 0); return; }
  cylinder(s, null, [slab[0] - x0, 0, 0], [slab[1] - x0, 0, 0], 0.026, 10, { caps: [false, true] });
  box(s, tr(cx, 0, -length / 2), [t, 0.032, length], 0.004);
  cylinder(s, null, [slab[0] - x0, 0, -length], [slab[1] - x0, 0, -length], 0.024, 10, { caps: [false, true] });
  s.material(MAT_ID.gunmetal);
  cylinder(s, null, [slab[1] - x0, 0, -length], [stubTo - x0, 0, -length], 0.016, 8, { caps: [false, false] });
}

export function buildSpring(s: Shape, style?: GearSpec['wheelStyle']): void {
  s.tag = 'spring';
  s.material(MAT_ID.brass);
  // A volute spring read as stacked rings (scaled along y by the rig); one solid validation piece.
  const insulated = style === 'aether', n = s.fine ? (insulated ? 3 : 5) : 1;
  s.with({ noHull: true }, () => {
    if (insulated && s.fine) lathe(s, null, [[.004, 0], [.004, 1]], 10, { hullProfile: null });
    for (let i = 0; i < n; i++) {
      const y0 = (i + 0.1) / n, y1 = (i + 0.9) / n, r = 0.012 - i * 0.0008;
      if (insulated) s.material(MAT_ID.rubber);
      lathe(s, null, [[r * 0.4, y0], [r, y0], [r, y1], [r * 0.4, y1]], insulated ? 14 : 8, { smooth: insulated, hullProfile: null, caps: [false, false] });
    }
  });
  for (const faces of latheHullFaces([[0.012, 0], [0.012, 1]], 8)) s.addHull(faces);
}

/** Emit every running-gear prototype for the context's gear. */
export function buildGear(ctx: KitContext, out: GroupShapes, pitch: number): void {
  const g = ctx.gear, slabs = gearSlabs(ctx);
  buildLink(out.get('links'), g, pitch);
  const w0 = g.wheels[0];
  buildTyre(out.get('wheels'), w0.radius, w0.width, g.wheelStyle);
  buildHub(out.get('hubs'), w0.radius, w0.width, g.wheelStyle);
  buildSprocket(out.get('sprockets'), g);
  buildIdler(out.get('idlers'), g);
  // LOD2 keeps the belt, wheels, sprocket and idler only.
  if (out.get('links').detail <= 0.3) return;
  if (g.rollers.length) buildRoller(out.get('rollers'), g.rollers[0]);
  const c = g.halfSpacing;
  if (g.suspension === 'torsion') {
    buildArm(out.get('arms'), g.armLength, slabs.arm, (slabs.arm[0] + slabs.arm[1]) / 2, c + w0.dx - w0.width / 2 + 0.003);
  } else if (g.suspension === 'bogie') {
    buildRocker(out.get('bogies'), g.rockerHalf, slabs.rocker, (slabs.rocker[0] + slabs.rocker[1]) / 2, slabs.wheelInner + 0.003, slabs.wheelInner + 0.003, g.wheelStyle);
    buildSpring(out.get('springs'), g.wheelStyle);
  } else {
    // Crawler: trailing arms carry rockers; rear stub reaches the outer row, front stub the inner row.
    buildArm(out.get('arms'), g.armLength, slabs.arm, (slabs.arm[0] + slabs.arm[1]) / 2, slabs.rocker[0] + 0.002);
    const rear = g.wheels[0], front = g.wheels[1];
    buildRocker(out.get('bogies'), g.rockerHalf, slabs.rocker, (slabs.rocker[0] + slabs.rocker[1]) / 2, c + rear.dx - rear.width / 2 + 0.003, c + front.dx - front.width / 2 + 0.003, g.wheelStyle);
  }
  const t = g.tensioner;
  buildTensioner(out.get('tensioners'), Math.hypot(t.dz, t.dy), slabs.arm, (slabs.arm[0] + slabs.arm[1]) / 2, c - g.idler.width / 2 + 0.003);
}
