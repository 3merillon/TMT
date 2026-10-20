/** Five serial axes: pedestal yaw, shoulder, elbow, wrist pitch, and wrist yaw. */
import type { InstanceHandle, SceneRegistry, Vec3 } from '../../engine';
import type { SdfCasterHandle, SdfCasterInstance } from '../../engine/passes/sdf/sdf-casters';
import { basis, chain, cross, lookAlong, norm, rotX, rotZ, translate } from '../kit/geometry/math';
import { box, cylinder, lathe, Shape } from '../kit/geometry/shapes';
import { add, lerp, shapeMesh, sub, transform, WorkshopGeometry } from './geometry';
import { WorkshopGripper, type ServiceContact } from './gripper';

export interface RobotPose {
  shoulder: Vec3; elbow: Vec3; wrist: Vec3; tip: Vec3;
  yaw: number; shoulderAngle: number; elbowAngle: number; wristPitch: number; wristYaw: number; roll: number;
  reachable: boolean;
}
export const ROBOT_BASE: Vec3 = [-2.65, 0, -1.0];
// Folded behind the rear-left corner: the tool clears the full lift stroke and the closed return-trolley roof.
export const ROBOT_PARK: Vec3 = [-2.0, 2.40, -2.2];
export const ROBOT_UPPER = 2.2, ROBOT_FORE = 2.1, ROBOT_WRIST = .48;
export function solveRobot(target: Vec3, roll = 0, base: Vec3 = ROBOT_BASE): RobotPose {
  const shoulder = add(base, [0, .96, 0]);
  const wanted = add(target, [0, ROBOT_WRIST, 0]), delta = sub(wanted, shoulder), rawDistance = Math.hypot(...delta);
  const distance = Math.min(ROBOT_UPPER + ROBOT_FORE - .002, Math.max(Math.abs(ROBOT_UPPER - ROBOT_FORE) + .002, rawDistance));
  const yaw = Math.atan2(delta[0], delta[2]);
  const radial: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
  const elevation = Math.atan2(delta[1], Math.hypot(delta[0], delta[2]));
  const shoulderAngle = elevation + Math.acos(Math.max(-1, Math.min(1, (ROBOT_UPPER ** 2 + distance ** 2 - ROBOT_FORE ** 2) / (2 * ROBOT_UPPER * distance))));
  const elbow = add(shoulder, [radial[0] * ROBOT_UPPER * Math.cos(shoulderAngle), ROBOT_UPPER * Math.sin(shoulderAngle), radial[2] * ROBOT_UPPER * Math.cos(shoulderAngle)]);
  const wrist = add(shoulder, delta.map(v => v * distance / Math.max(rawDistance, .00001)) as Vec3);
  const fore = sub(wrist, elbow), foreAngle = Math.atan2(fore[1], fore[0] * radial[0] + fore[2] * radial[2]);
  return { shoulder, elbow, wrist, tip: add(wrist, [0, -ROBOT_WRIST, 0]), yaw, shoulderAngle,
    elbowAngle: foreAngle - shoulderAngle, wristPitch: -Math.PI / 2 - foreAngle, wristYaw: -yaw, roll, reachable: Math.abs(distance - rawDistance) < .003 };
}

/** Annular bearing with a real open bore, machined chamfers and six socket fasteners. */
function bearing(s: Shape, x: number, z: number, radius: number, width: number): void {
  const m = chain(translate(x, 0, z), rotZ(-Math.PI / 2)), r = radius, bore = .076;
  s.material(4);
  lathe(s, m, [[bore, -width / 2], [r - .012, -width / 2], [r, -width / 2 + .012], [r, width / 2 - .012], [r - .012, width / 2], [bore, width / 2], [bore, -width / 2]], 28, { caps: [false, false] });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, y = Math.sin(a) * r * .76, zz = z + Math.cos(a) * r * .76;
    s.material(7); cylinder(s, null, [x + width / 2, y, zz], [x + width / 2 + .012, y, zz], .018, 6);
  }
}
/** Nested clevises: upper ears leave .045 m running clearance around the narrower forearm. */
function linkMesh(length: number, fore: boolean): Shape {
  const s = new Shape(); s.noHull = true;
  const spread = fore ? .12 : .23, width = fore ? .052 : .07, r0 = fore ? .17 : .235, r1 = fore ? .135 : .195;
  for (const sign of [-1, 1]) {
    s.material(0); box(s, translate(sign * spread, 0, length / 2), [width, fore ? .18 : .26, length - .23], .02);
    bearing(s, sign * spread, 0, r0, width + .012); bearing(s, sign * spread, length, r1, width + .012);
    // Raised longitudinal web and bolted inspection strip; neither crosses a rotating bearing.
    s.material(1); box(s, translate(sign * (spread + width / 2 + .012), 0, length / 2), [.025, .10, length - .56], .009);
    for (const z of [.32, .62, length - .62, length - .32]) {
      s.material(7); cylinder(s, null, [sign * (spread + width / 2 + .02), 0, z], [sign * (spread + width / 2 + .035), 0, z], .017, 6);
    }
  }
  s.material(1); box(s, translate(0, 0, length * .5), [spread * 2, .10, length - .74], .025);
  return s;
}
export const ACTUATOR_PLANES = [-.54, .44] as const;
export const ACTUATOR_BARREL_END = [1.10, .80] as const;
export const ACTUATOR_ROD_LENGTH = [.83, .69] as const;
export function actuatorMounts(p: RobotPose): [Vec3, Vec3][] {
  const tangent: Vec3 = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];
  const off = (point: Vec3, plane: number) => add(point, tangent.map(v => v * plane) as Vec3);
  return [[off(add(ROBOT_BASE, [0, .53, 0]), ACTUATOR_PLANES[0]), off(lerp(p.shoulder, p.elbow, .60), ACTUATOR_PLANES[0])],
    [off(lerp(p.shoulder, p.elbow, .86), ACTUATOR_PLANES[1]), off(lerp(p.elbow, p.wrist, .57), ACTUATOR_PLANES[1])]];
}
function hydraulicBarrel(end: number): Shape {
  const s = new Shape(); s.noHull = true;
  const m = rotX(Math.PI / 2);
  s.material(1); lathe(s, m, [[.055, .075], [.088, .105], [.088, .16], [.071, .175]], 28);
  s.material(0); lathe(s, m, [[.071, .16], [.071, end - .10]], 32);
  s.material(4); lathe(s, m, [[.071, end - .13], [.088, end - .115], [.088, end - .07], [.068, end - .055], [.068, end - .018], [.050, end]], 32, { caps: [true, false] });
  // Open gland bore and dark wiper ring surround the polished rod rather than cap it.
  s.material(1); lathe(s, m, [[.029, end - .002], [.050, end - .002], [.050, end + .012], [.029, end + .012], [.029, end - .002]], 24, { caps: [false, false] });
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + i * Math.PI / 2, x = Math.cos(angle) * .075, y = Math.sin(angle) * .075;
    s.material(7); cylinder(s, null, [x, y, .115], [x, y, end - .075], .009, 8);
    cylinder(s, null, [x, y, end - .075], [x, y, end - .056], .018, 6);
  }
  // Oil ports terminate on the cap, clear of the polished travel surface.
  s.material(4); cylinder(s, null, [0, .06, .13], [0, .13, .13], .020, 12);
  cylinder(s, null, [0, .06, end - .09], [0, .13, end - .09], .020, 12);
  return s;
}
function clevis(fork: boolean): Shape {
  const s = new Shape(); s.noHull = true;
  for (const x of fork ? [-.066, .066] : [0]) {
    const width = fork ? .03 : .075, m = chain(translate(x, 0, 0), rotZ(-Math.PI / 2));
    s.material(4); lathe(s, m, [[.022, -width / 2], [.059, -width / 2], [.067, -width / 2 + .008], [.067, width / 2 - .008], [.059, width / 2], [.022, width / 2], [.022, -width / 2]], 24, { caps: [false, false] });
    s.material(1); box(s, translate(x, 0, fork ? .077 : -.055), [width - .008, .070, fork ? .16 : .075], .012);
  }
  return s;
}
interface Piston { body: InstanceHandle; rod: InstanceHandle; eyes: InstanceHandle[]; pins: InstanceHandle[]; mounts: InstanceHandle[] }
export class WorkshopRobot {
  private readonly geometry: WorkshopGeometry;
  private readonly upper: InstanceHandle;
  private readonly fore: InstanceHandle;
  private readonly shoulderYoke: InstanceHandle;
  private readonly pins: InstanceHandle[] = [];
  private readonly pistons: Piston[] = [];
  private readonly knuckle: InstanceHandle;
  private readonly yawBearing: InstanceHandle;
  private readonly gripper: WorkshopGripper;
  private readonly shadows: { brick: SdfCasterHandle; instance: SdfCasterInstance; link: 'base' | 'upper' | 'fore' }[] = [];
  pose: RobotPose = solveRobot(ROBOT_PARK);
  get steamDirection(): Vec3 { return [1, 0, 0]; }
  get steamOutlet(): Vec3 { return add(this.pose.tip, [.17, .12, -.07]); }
  constructor(private readonly scene: SceneRegistry) {
    const g = this.geometry = new WorkshopGeometry(scene), b = ROBOT_BASE;
    const base = new Shape(); base.noHull = true;
    base.material(1); box(base, translate(0, .09, 0), [1.0, .18, 1.0], .045);
    base.material(4); lathe(base, null, [[.41, .18], [.46, .22], [.46, .27], [.36, .31], [.31, .35], [.31, .67], [.39, .70], [.39, .76], [.32, .80]], 40);
    base.material(0); lathe(base, null, [[.308, .34], [.308, .64]], 28);
    for (const x of [-.38, .38]) for (const z of [-.38, .38]) { base.material(7); cylinder(base, null, [x, .18, z], [x, .22, z], .039, 6); }
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; base.material(7); cylinder(base, null, [.365 * Math.sin(a), .76, .365 * Math.cos(a)], [.365 * Math.sin(a), .785, .365 * Math.cos(a)], .022, 6); }
    g.addMesh(shapeMesh(base, 'workshop:robot-pedestal'), transform(b), [.16, .25, .22]);
    const yoke = new Shape(); yoke.noHull = true;
    for (const x of [-.345, .345]) { yoke.material(0); box(yoke, translate(x, -.11, 0), [.09, .31, .37], .035); bearing(yoke, x, 0, .25, .108); }
    this.shoulderYoke = g.addMesh(shapeMesh(yoke, 'workshop:robot-yaw-clevis'));
    this.upper = g.addMesh(shapeMesh(linkMesh(ROBOT_UPPER, false), 'workshop:robot-upper-clevis'), undefined, [.18, .29, .25]);
    this.fore = g.addMesh(shapeMesh(linkMesh(ROBOT_FORE, true), 'workshop:robot-fore-clevis'), undefined, [.23, .30, .27]);
    for (let i = 0; i < 3; i++) this.pins.push(g.cylinder(b, add(b, [.8, 0, 0]), .073, 7));
    for (let i = 0; i < 2; i++) this.pistons.push({
      body: g.addMesh(shapeMesh(hydraulicBarrel(ACTUATOR_BARREL_END[i]), `workshop:hydraulic-barrel-${i}`), undefined, [.19, .28, .23]),
      rod: g.cylinder(b, add(b, [0, 1, 0]), .027, 7),
      eyes: [g.addMesh(shapeMesh(clevis(true), 'workshop:hydraulic-base-clevis')), g.addMesh(shapeMesh(clevis(false), 'workshop:hydraulic-rod-eye'))],
      pins: [g.cylinder(b, add(b, [.20, 0, 0]), .021, 7), g.cylinder(b, add(b, [.16, 0, 0]), .021, 7)],
      mounts: [g.box(b, [.2, .08, .12], 1), g.box(b, [.2, .08, .12], 1)],
    });
    const wrist = new Shape(); wrist.noHull = true;
    wrist.material(1); cylinder(wrist, null, [0, -.16, 0], [0, -.03, 0], .055, 28);
    bearing(wrist, 0, 0, .113, .15);
    this.knuckle = g.addMesh(shapeMesh(wrist, 'workshop:wrist-pitch-clevis'));
    const swivel = new Shape(); swivel.noHull = true;
    swivel.material(4); lathe(swivel, null, [[.07, -.095], [.13, -.095], [.145, -.08], [.145, -.025], [.125, 0], [.07, 0], [.07, -.095]], 32, { caps: [false, false] });
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; swivel.material(7); cylinder(swivel, null, [.114 * Math.sin(a), -.098, .114 * Math.cos(a)], [.114 * Math.sin(a), -.11, .114 * Math.cos(a)], .014, 6); }
    this.yawBearing = g.addMesh(shapeMesh(swivel, 'workshop:wrist-yaw-bearing'));
    this.gripper = new WorkshopGripper(g);
    const sdf = scene.get('sdfCasters');
    if (sdf) for (const [link, size] of [['base', [1.0, .85, 1.0]], ['upper', [.55, .26, ROBOT_UPPER]], ['fore', [.31, .18, ROBOT_FORE]]] as const) {
      const hull = new Shape(); hull.noHull = true; box(hull, null, [...size], .04);
      const brick = sdf.create({ positions: Float32Array.from(hull.mb.p), indices: Uint32Array.from(hull.mb.idx), label: `workshop:robot:${link}` });
      if (brick) this.shadows.push({ brick, instance: sdf.add(brick, translate(...b)), link });
    }
    this.update(ROBOT_PARK, 0, .4, 0);
  }
  update(target: Vec3, grip: number, span = .6, spin = 0, toolMode = false, contact?: ServiceContact): void {
    const p = this.pose = solveRobot(target, spin), g = this.geometry;
    const tangent: Vec3 = [Math.cos(p.yaw), 0, -Math.sin(p.yaw)];
    const off = (v: Vec3, amount: number): Vec3 => add(v, tangent.map(k => k * amount) as Vec3);
    const frame = (a: Vec3, b: Vec3) => { const z = norm(sub(b, a)); return Float32Array.from(basis(tangent, norm(cross(z, tangent)), z, a)); };
    this.geometry.setTransform(this.upper, frame(p.shoulder, p.elbow)); this.geometry.setTransform(this.fore, frame(p.elbow, p.wrist));
    this.geometry.setTransform(this.shoulderYoke, transform(p.shoulder, [1, 1, 1], [0, p.yaw, 0]));
    [p.shoulder, p.elbow, p.wrist].forEach((point, i) => { const half = [.40, .29, .175][i]; g.setCylinder(this.pins[i], off(point, -half), off(point, half), .073); });
    actuatorMounts(p).forEach(([a, b], i) => {
      const piston = this.pistons[i], dir = norm(sub(b, a)), along = (origin: Vec3, d: number) => add(origin, dir.map(v => v * d) as Vec3);
      // Barrels have immutable machined dimensions. Only the polished rod translates through its gland.
      g.setTransform(piston.body, frame(a, b));
      g.setCylinder(piston.rod, along(a, ACTUATOR_BARREL_END[i]), along(b, -.055), .027);
      g.setTransform(piston.eyes[0], frame(a, b)); g.setTransform(piston.eyes[1], frame(b, along(b, 1)));
      [a, b].forEach((point, j) => {
        g.setCylinder(piston.pins[j], off(point, -.105), off(point, .105), .021);
        const towardLink = i ? (j ? -.29 : -.17) : .27;
        g.setBeam(piston.mounts[j], off(point, j ? .04 : 0), off(point, towardLink), .075, .105);
      });
    });
    this.geometry.setTransform(this.knuckle, transform(p.wrist, [1, 1, 1], [0, p.yaw, 0]));
    // The visible fifth rotary bearing cancels pedestal yaw; the clamp keeps the part's mounting frame.
    this.geometry.setTransform(this.yawBearing, transform(add(p.tip, [0, .34, 0]), [1, 1, 1], [0, p.yaw + p.wristYaw, 0]));
    this.gripper.update(p.tip, grip, span, spin, toolMode, contact);
    const sdf = this.scene.get('sdfCasters');
    for (const shadow of this.shadows) {
      const a = shadow.link === 'upper' ? p.shoulder : p.elbow, b = shadow.link === 'upper' ? p.elbow : p.wrist;
      sdf?.set(shadow.instance, shadow.link === 'base' ? translate(...add(ROBOT_BASE, [0, .43, 0])) : lookAlong(lerp(a, b, .5), norm(sub(b, a))));
    }
  }
  occludes(origin: Vec3, direction: Vec3, distance: number): boolean { return this.geometry.occludes(origin, direction, distance); }
  dispose(): void {
    this.geometry.dispose(); const sdf = this.scene.get('sdfCasters');
    for (const shadow of this.shadows.splice(0)) { sdf?.remove(shadow.instance); sdf?.destroy(shadow.brick); }
  }
}
