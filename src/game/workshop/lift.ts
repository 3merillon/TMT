/** Fixed-length, screw-driven scissor mechanism. All pivots share one constrained solution. */
import type { InstanceHandle, MeshDesc, Vec3 } from '../../engine';
import { basis, chain, cross, norm, rotX, rotZ, translate } from '../kit/geometry/math';
import { bolts, box, cylinder, lathe, Shape } from '../kit/geometry/shapes';
import { shapeMesh, transform, WorkshopGeometry } from './geometry';
import { WORKSHOP_LIFT_MAX } from './dimensions';

export const SCISSOR_LENGTH = 2.1;
export const SCISSOR_FIXED_X = -1.06;
export const SCISSOR_BOTTOM_Y = .20;
export const SCISSOR_TOP_Y = .50;
export const SCISSOR_PLANE_GAP = .10;
const SIDES = [-1.10, 1.10];
const SCREW_PITCH = .06;

export function solveScissorLift(height: number) {
  const rise = SCISSOR_TOP_Y + height - SCISSOR_BOTTOM_Y;
  if (!Number.isFinite(height) || height < 0 || height > WORKSHOP_LIFT_MAX) throw new Error('Lift height exceeds its mechanical travel.');
  const span = Math.sqrt(SCISSOR_LENGTH ** 2 - rise ** 2);
  const restSpan = Math.sqrt(SCISSOR_LENGTH ** 2 - (SCISSOR_TOP_Y - SCISSOR_BOTTOM_Y) ** 2);
  return { height, rise, span, sliderX: SCISSOR_FIXED_X + span, angle: Math.atan2(rise, span),
    center: [SCISSOR_FIXED_X + span / 2, SCISSOR_BOTTOM_Y + rise / 2] as const,
    screwAngle: -(span - restSpan) / SCREW_PITCH * Math.PI * 2 };
}

const shape = () => { const s = new Shape(); s.noHull = true; return s; };
/** Separate link plates with bored eyes; local X is the common pin axis and local Z the link length. */
export function scissorLinkMesh(): MeshDesc {
  const s = shape();
  box(s.material(0), translate(0, 0, SCISSOR_LENGTH / 2), [.042, .105, SCISSOR_LENGTH - .13], .012);
  for (const sign of [-1, 1]) box(s.material(1), translate(sign * .026, 0, SCISSOR_LENGTH / 2), [.012, .063, SCISSOR_LENGTH - .40], .004);
  for (const z of [0, SCISSOR_LENGTH / 2, SCISSOR_LENGTH]) {
    lathe(s.material(1), chain(translate(0, 0, z), rotZ(-Math.PI / 2)), [[.026, -.025], [.070, -.025], [.082, -.015], [.082, .015], [.070, .025], [.026, .025], [.026, -.025]], 28, { caps: [false, false] });
    lathe(s.material(4), chain(translate(0, 0, z), rotZ(-Math.PI / 2)), [[.023, -.027], [.035, -.027], [.035, .027], [.023, .027], [.023, -.027]], 24, { caps: [false, false] });
  }
  for (const z of [.21, SCISSOR_LENGTH - .21]) bolts(s.material(7), null, [[.035, 0, z]], [1, 0, 0], .014, .009);
  return shapeMesh(s, 'workshop:fixed-length-scissor-link');
}

/** Actual continuous trapezoidal thread. The shaft rotates; the bronze nut and carriage translate. */
function screwMesh(): MeshDesc {
  const s = shape(), lo = -1.13, hi = 1.22, radius = .022;
  cylinder(s.material(7), null, [lo, 0, 0], [hi, 0, 0], radius, 24);
  const turns = (hi - lo - .12) / SCREW_PITCH, segments = Math.ceil(turns * 24);
  s.material(3);
  for (let i = 0; i < segments; i++) {
    const section = (t: number, dx: number, r: number): Vec3 => { const a = t * turns * Math.PI * 2; return [lo + .06 + t * turns * SCREW_PITCH + dx, Math.cos(a) * r, Math.sin(a) * r]; };
    for (const side of [-1, 1]) s.mb.poly([section(i / segments, side * .009, radius), section((i + 1) / segments, side * .009, radius), section((i + 1) / segments, side * .004, .031), section(i / segments, side * .004, .031)], 40);
    s.mb.poly([section(i / segments, -.004, .031), section((i + 1) / segments, -.004, .031), section((i + 1) / segments, .004, .031), section(i / segments, .004, .031)], 40);
  }
  return shapeMesh(s, 'workshop:trapezoidal-lift-screw');
}

interface Side { z: number; links: InstanceHandle[]; centerPin: InstanceHandle; lowerPin: InstanceHandle; upperPin: InstanceHandle; lowerRollers: InstanceHandle[]; upperRollers: InstanceHandle[]; topFixed: InstanceHandle[]; topRails: InstanceHandle[] }

function carriageMesh(): MeshDesc {
  const s = shape();
  box(s.material(1), translate(0, .085, 0), [.13, .060, 1.92], .01);
  for (const z of [-.945, .945]) {
    lathe(s.material(1), chain(translate(0, 0, z), rotX(Math.PI / 2)), [[.023, -.035], [.068, -.035], [.075, -.025], [.075, .025], [.068, .035], [.023, .035], [.023, -.035]], 24, { caps: [false, false] });
    bolts(s.material(3), null, [[-.045, .12, z], [.045, .12, z]], [0, 1, 0], .014, .012);
  }
  for (const z of [-.65, .65]) bolts(s.material(3), null, [[-.046, .12, z], [.046, .12, z]], [0, 1, 0], .014, .012);
  return shapeMesh(s, 'workshop:roller-carriage');
}

export class WorkshopLift {
  private readonly sides: Side[] = [];
  private readonly screws: { handle: InstanceHandle; z: number }[] = [];
  private readonly nuts: { handle: InstanceHandle; z: number }[] = [];
  private readonly lowerCarriage: InstanceHandle;
  private readonly upperCarriage: InstanceHandle;
  private lastHeight = NaN;
  constructor(private readonly g: WorkshopGeometry) {
    const link = scissorLinkMesh();
    for (const z of SIDES) {
      const topFixed: InstanceHandle[] = [], topRails: InstanceHandle[] = [];
      // Fixed-end forks and roller tracks are physically separate from the moving link planes.
      for (const side of [-1, 1]) {
        const zz = z + side * .16;
        g.box([0, .123, zz], [2.58, .035, .10], 1);
        g.box([0, .196, zz + side * .050], [2.58, .16, .018], 1);
        topRails.push(g.box([0, .577, zz], [2.58, .035, .10], 1));
        topRails.push(g.box([0, .504, zz + side * .050], [2.58, .16, .018], 1));
        // Left hinge clevis, fixed at both ground and deck; the right end travels in the guides.
        g.box([SCISSOR_FIXED_X, .174, z + side * .110], [.17, .145, .035], 1);
        topFixed.push(g.box([SCISSOR_FIXED_X, .526, z + side * .110], [.17, .145, .035], 1));
      }
      g.cylinder([SCISSOR_FIXED_X, SCISSOR_BOTTOM_Y, z - .12], [SCISSOR_FIXED_X, SCISSOR_BOTTOM_Y, z + .12], .023, 7);
      topFixed.push(g.cylinder([SCISSOR_FIXED_X, SCISSOR_TOP_Y, z - .12], [SCISSOR_FIXED_X, SCISSOR_TOP_Y, z + .12], .023, 7));
      for (const x of [-1.2, -.6, 0, .6, 1.2]) for (const side of [-1, 1]) g.cylinder([x, .144, z + side * .20], [x, .156, z + side * .20], .018, 3);
      const pin = () => g.cylinder([0, .35, z - .105], [0, .35, z + .105], .023, 7);
      const rollers = () => [-1, 1].map(side => g.cylinder([1, .2, z + side * .16 - .032], [1, .2, z + side * .16 + .032], .059, 3));
      this.sides.push({ z, links: [g.addMesh(link), g.addMesh(link)], centerPin: pin(), lowerPin: pin(), upperPin: pin(), lowerRollers: rollers(), upperRollers: rollers(), topFixed, topRails });
    }
    const carriage = carriageMesh();
    this.lowerCarriage = g.addMesh(carriage);
    this.upperCarriage = g.addMesh(carriage);
    const screw = screwMesh();
    for (const z of [-.65, .65]) {
      this.screws.push({ handle: g.addMesh(screw, transform([0, .20, z])), z });
      for (const x of [-1.15, 1.24]) {
        g.box([x, .169, z], [.12, .145, .145], 1);
        g.cylinder([x - .065, .20, z], [x + .065, .20, z], .045, 4);
      }
      // Geared electric drives are anchored to the base, not stretched by the lift motion.
      g.cylinder([-1.38, .20, z], [-1.23, .20, z], .079, 0);
      g.box([-1.215, .20, z], [.085, .14, .15], 1);
      const nut = shape();
      lathe(nut.material(4), rotZ(-Math.PI / 2), [[.033, -.083], [.073, -.083], [.073, .083], [.033, .083], [.033, -.083]], 8, { caps: [false, false] });
      this.nuts.push({ handle: g.addMesh(shapeMesh(nut, 'workshop:bronze-travelling-nut')), z });
    }
    this.update(0);
  }
  update(height: number): void {
    if (Math.abs(height - this.lastHeight) < 1e-6) return;
    this.lastHeight = height;
    const p = solveScissorLift(height), topY = SCISSOR_TOP_Y + height;
    for (const side of this.sides) {
      const { z } = side;
      const starts: Vec3[] = [[SCISSOR_FIXED_X, SCISSOR_BOTTOM_Y, z - SCISSOR_PLANE_GAP / 2], [p.sliderX, SCISSOR_BOTTOM_Y, z + SCISSOR_PLANE_GAP / 2]];
      const ends: Vec3[] = [[p.sliderX, topY, starts[0][2]], [SCISSOR_FIXED_X, topY, starts[1][2]]];
      starts.forEach((a, i) => {
        const b = ends[i], dir = norm([b[0] - a[0], b[1] - a[1], 0]), lateral: Vec3 = [0, 0, 1];
        this.g.setTransform(side.links[i], Float32Array.from(basis(lateral, cross(dir, lateral), dir, a)));
      });
      this.g.setCylinder(side.centerPin, [p.center[0], p.center[1], z - .105], [p.center[0], p.center[1], z + .105], .023);
      this.g.setCylinder(side.lowerPin, [p.sliderX, SCISSOR_BOTTOM_Y, z - .20], [p.sliderX, SCISSOR_BOTTOM_Y, z + .20], .023);
      this.g.setCylinder(side.upperPin, [p.sliderX, topY, z - .20], [p.sliderX, topY, z + .20], .023);
      for (const [i, sign] of [-1, 1].entries()) {
        this.g.setCylinder(side.lowerRollers[i], [p.sliderX, SCISSOR_BOTTOM_Y, z + sign * .16 - .032], [p.sliderX, SCISSOR_BOTTOM_Y, z + sign * .16 + .032], .059);
        this.g.setCylinder(side.upperRollers[i], [p.sliderX, topY, z + sign * .16 - .032], [p.sliderX, topY, z + sign * .16 + .032], .059);
      }
      // These meshes were authored at their neutral world positions. Translation alone preserves their dimensions.
      for (const handle of [...side.topFixed, ...side.topRails]) {
        // Primitive instances have transforms, so retain their neutral transforms rather than replacing their scale.
        const original = this.original(handle);
        const moved = new Float32Array(original); moved[13] += height; this.g.setTransform(handle, moved);
      }
    }
    this.g.setTransform(this.lowerCarriage, transform([p.sliderX, .20, 0]));
    this.g.setTransform(this.upperCarriage, transform([p.sliderX, topY, 0]));
    for (const screw of this.screws) this.g.setTransform(screw.handle, transform([0, .20, screw.z], [1, 1, 1], [p.screwAngle, 0, 0]));
    for (const nut of this.nuts) this.g.setTransform(nut.handle, transform([p.sliderX, .20, nut.z]));
  }
  private readonly originals = new Map<InstanceHandle, Float32Array>();
  private original(handle: InstanceHandle): Float32Array {
    let m = this.originals.get(handle);
    if (!m) { m = this.g.modelOf(handle); this.originals.set(handle, m); }
    return m;
  }
}
