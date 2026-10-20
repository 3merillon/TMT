/** Compact magnetic service head with short fingers and a retractable twin-track lifting fixture. */
import type { InstanceHandle, Vec3 } from '../../engine';
import { box, cylinder, gear, lathe, Shape } from '../kit/geometry/shapes';
import { chain, rotX, rotY, translate } from '../kit/geometry/math';
import { add, lerp, shapeMesh, transform, type WorkshopGeometry } from './geometry';

export interface PickupPole { offset: Vec3; normal: Vec3; radius: number }
export interface ServiceContact { mode: 'magnet' | 'fingers' | 'tracks'; poles: PickupPole[]; deployment?: number }
const UP: Vec3 = [0, 1, 0];
export class WorkshopGripper {
  private readonly body: InstanceHandle;
  private readonly poles: InstanceHandle[] = [];
  private readonly plungers: InstanceHandle[] = [];
  private readonly jaws: InstanceHandle[] = [];
  private readonly pads: InstanceHandle[] = [];
  private readonly drives: InstanceHandle[] = [];
  private readonly slides: InstanceHandle[][] = [[], []];
  private readonly feet: InstanceHandle[] = [];
  private readonly stems: InstanceHandle[] = [];
  private readonly adapters: InstanceHandle[] = [];
  private readonly driver: InstanceHandle;
  private readonly socket: InstanceHandle;
  constructor(private readonly g: WorkshopGeometry) {
    const body = new Shape(); body.noHull = true;
    body.material(0); lathe(body, null, [[.018, .045], [.13, .045], [.13, .14], [.018, .14], [.018, .045]], 36, { caps: [false, false] });
    body.material(1); lathe(body, null, [[.018, .14], [.12, .14], [.12, .158], [.018, .158], [.018, .14]], 36, { caps: [false, false] });
    body.material(7); lathe(body, null, [[.014, .158], [.04, .158], [.04, .245], [.014, .245], [.014, .158]], 28, { caps: [false, false] });
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; body.material(4); cylinder(body, null, [Math.cos(a) * .10, .14, Math.sin(a) * .10], [Math.cos(a) * .10, .154, Math.sin(a) * .10], .012, 6); }
    // Open front inspection gearbox: coarse teeth remain visible at normal viewing distance.
    body.material(1); box(body, translate(0, .075, .14), [.18, .14, .035], .01);
    // Radial pneumatic bleed fitting: hex union, turned outlet, recessed dark bore.
    body.material(4); cylinder(body, null, [.10, .12, -.07], [.13, .12, -.07], .014, 20);
    cylinder(body, null, [.13, .12, -.07], [.151, .12, -.07], .022, 6);
    body.material(7); cylinder(body, null, [.151, .12, -.07], [.17, .12, -.07], .014, 20);
    body.material(2); cylinder(body, null, [.1701, .12, -.07], [.1703, .12, -.07], .008, 16);
    this.body = g.addMesh(shapeMesh(body, 'workshop:compact-magnetic-tool-head'));
    for (let i = 0; i < 2; i++) { const cog = new Shape(); cog.noHull = true; cog.material(4); gear(cog, null, i ? .035 : .05, .012, i ? 10 : 14, .018); this.drives.push(g.addMesh(shapeMesh(cog, 'workshop:jaw-drive-pinion'))); }
    const foot = new Shape(); foot.noHull = true; foot.material(1); cylinder(foot, null, [0, 0, 0], [0, 0, 1], 1, 28);
    for (let i = 0; i < 3; i++) {
      this.poles.push(g.addMesh(shapeMesh(foot, 'workshop:contact-pole')));
      this.plungers.push(g.cylinder([0, 0, 0], [0, .1, 0], .012, 7));
    }
    for (let side = 0; side < 2; side++) {
      const finger = new Shape(); finger.noHull = true; finger.material(4); box(finger, null, [.045, .19, .10], .006);
      finger.material(7); cylinder(finger, null, [-.03, .05, 0], [.03, .05, 0], .015, 16);
      this.jaws.push(g.addMesh(shapeMesh(finger, 'workshop:short-service-finger')));
      this.pads.push(g.box([0, 0, 0], [.026, .12, .14], 2));
      for (let stage = 0; stage < 4; stage++) {
        const s = new Shape(); s.noHull = true; s.material(stage % 2 ? 7 : 1);
        const height = .070 - stage * .014, depth = .065 - stage * .013, wall = .005;
        for (const sign of [-1, 1]) {
          box(s, translate(-.16, sign * (height - wall) / 2, 0), [.32, wall, depth], .001);
          box(s, translate(-.16, 0, sign * (depth - wall) / 2), [.32, height - wall * 2, wall], .001);
        }
        this.slides[side].push(g.addMesh(shapeMesh(s, 'workshop:track-fixture-nested-tube')));
      }
      this.feet.push(g.addMesh(shapeMesh(foot, 'workshop:track-contact-pole')));
      this.stems.push(g.cylinder([0, 0, 0], [0, .1, 0], .015, 7));
      this.adapters.push(g.box([0, 0, 0], [.055, .035, .14], 4));
    }
    this.driver = g.cylinder([0, 0, 0], [0, .1, 0], .010, 7);
    const socket = new Shape(); socket.noHull = true; socket.material(7); cylinder(socket, null, [0, 0, 0], [0, .025, 0], .023, 12);
    this.socket = g.addMesh(shapeMesh(socket, 'workshop:visible-fastener-socket'));
  }
  update(tip: Vec3, grip: number, span: number, spin: number, tool: boolean, contact?: ServiceContact): void {
    const mode = contact?.mode ?? 'magnet', deployed = mode === 'tracks' ? contact?.deployment ?? 1 : 0;
    this.g.setTransform(this.body, transform(tip));
    for (let i = 0; i < 2; i++) this.g.setTransform(this.drives[i], Float32Array.from(chain(translate(...add(tip, [i ? .082 : 0, .075, .168])), rotX(Math.PI / 2), rotY((i ? -1.4 : 1) * grip * 6))));
    for (let i = 0; i < 3; i++) {
      const pole = contact?.poles[i] ?? { offset: [(i - 1) * .045, -.055, i === 1 ? .065 : 0] as Vec3, normal: UP, radius: .023 };
      const at = add(tip, [pole.offset[0], tool || mode !== 'magnet' ? .02 : pole.offset[1], pole.offset[2]]), n = pole.normal;
      this.g.setCylinder(this.poles[i], add(at, n.map(v => v * -.002) as Vec3), add(at, n.map(v => v * .013) as Vec3), pole.radius);
      this.g.setCylinder(this.plungers[i], add(tip, [pole.offset[0], .055, pole.offset[2]]), add(at, [0, .014, 0]), .009);
      this.g.visibility(this.poles[i], mode === 'magnet'); this.g.visibility(this.plungers[i], mode === 'magnet');
    }
    const fingerWidth = mode === 'fingers' ? span + (1 - grip) * .15 : .35;
    for (let i = 0; i < 2; i++) {
      const sign = i ? 1 : -1, x = sign * fingerWidth / 2, y = mode === 'fingers' ? -.085 : .07;
      this.g.setTransform(this.jaws[i], transform(add(tip, [x, y, 0])));
      this.g.setBox(this.pads[i], add(tip, [x - sign * .036, y - .01, 0]), [.026, .12, .14]);
      this.g.visibility(this.jaws[i], mode === 'fingers'); this.g.visibility(this.pads[i], mode === 'fingers');
      const pickup = contact?.poles[i] ?? { offset: [sign * span / 2, -.055, 0] as Vec3, normal: UP, radius: .043 };
      const half = .18 + (Math.abs(pickup.offset[0]) - .18) * deployed;
      for (let stage = 0; stage < 4; stage++) {
        const extension = (half - .18) * (stage + 1) / 4;
        this.g.setTransform(this.slides[i][stage], transform(add(tip, [sign * (.18 + extension), .20, sign * .09]), [1, 1, 1], [0, sign < 0 ? Math.PI : 0, 0]));
      }
      const at = add(tip, [sign * half, .13 + (pickup.offset[1] - .13) * deployed, pickup.offset[2] * deployed]);
      const normal = lerp(UP, pickup.normal, deployed), length = Math.hypot(...normal), n = normal.map(v => v / length) as Vec3;
      this.g.setCylinder(this.feet[i], add(at, n.map(v => v * -.002) as Vec3), add(at, n.map(v => v * .015) as Vec3), pickup.radius ?? .043);
      this.g.setCylinder(this.stems[i], add(tip, [sign * half, .20, pickup.offset[2] * deployed]), add(at, [0, .016, 0]), .013);
      this.g.setBox(this.adapters[i], add(tip, [sign * half, .20, sign * .045 + pickup.offset[2] * deployed * .5]), [.055, .035, .15 + Math.abs(pickup.offset[2]) * deployed]);
    }
    const socketY = tool ? -.041 : .015;
    this.g.setCylinder(this.driver, add(tip, [0, .07, 0]), add(tip, [0, socketY + .025, 0]), .010);
    this.g.setTransform(this.socket, transform(add(tip, [0, socketY, 0]), [1, 1, 1], [0, spin, 0]));
  }
}
