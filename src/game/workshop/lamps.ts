/** Service luminaires: fixed-length articulated links, fork bearings and shared optical/light axes. */
import type { InstanceHandle, LightHandle, MeshDesc, SceneRegistry, Vec3 } from '../../engine';
import { applyPoint, chain, norm, rotX, rotY, scaleM, sub, translate } from '../kit/geometry/math';
import { bolts, box, cylinder, Shape, steppedTube, sweep } from '../kit/geometry/shapes';
import { shapeMesh, transform, WorkshopGeometry } from './geometry';

const solid = () => { const s = new Shape(); s.noHull = true; return s; };
const plate = (s: Shape, p: Vec3, size: Vec3, material = 0) => box(s.material(material), translate(...p), size, .008);
const tube = (s: Shape, a: Vec3, b: Vec3, r: number, mat = 1, segments = 24) => cylinder(s.material(mat), null, a, b, r, segments);

/** +Z is the optical axis, origin is the trunnion. Nothing crosses the reflector aperture. */
export function taskLampHeadMesh(): MeshDesc {
  const s = solid();
  steppedTube(s.material(0), null, [0, 0, -.24], [0, 0, .10], [[.13, 0], [.16, .025], [.17, .10], [.30, .22], [.37, .29], [.38, .31], [.38, .34]], 48, { caps: [true, false] });
  // The reflector returns inside the shell: a real bowl with a rolled brass lip.
  steppedTube(s.material(1), null, [0, 0, -.12], [0, 0, .10], [[.38, .22], [.36, .22], [.359, .207], [.285, .13], [.18, .05], [.08, 0]], 48, { caps: [false, false] });
  steppedTube(s.material(4), null, [0, 0, .097], [0, 0, .124], [[.38, 0], [.39, .007], [.39, .019], [.376, .027], [.356, .027], [.354, .010], [.36, 0]], 48, { caps: [false, false] });
  // Frosted central optic is recessed; concentric baffles break up the old featureless white disk.
  tube(s, [0, 0, -.119], [0, 0, -.103], .105, 5, 32);
  for (const r of [.14, .22, .30]) steppedTube(s.material(3), null, [0, 0, -.10 + r * .54], [0, 0, .1], [[r, 0], [r + .003, .004], [r, .009]], 48, { caps: [false, false] });
  for (const z of [-.205, -.18, -.155]) steppedTube(s.material(1), null, [0, 0, z], [0, 0, z + .01], [[.167, 0], [.178, .004], [.178, .008], [.167, .012]], 32, { caps: [false, false] });
  for (const sign of [-1, 1]) {
    tube(s, [sign * .25, 0, 0], [sign * .431, 0, 0], .066, 1);
    tube(s, [sign * .432, 0, 0], [sign * .447, 0, 0], .079, 4);
    bolts(s.material(3), null, [[sign * .45, 0, 0]], [sign, 0, 0], .034, .013);
  }
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, x = Math.cos(a), y = Math.sin(a);
    bolts(s.material(3), null, [[x * .373, y * .373, .128]], [0, 0, 1], .011, .008);
  }
  tube(s, [0, .075, -.242], [0, .075, -.28], .028, 2);
  return shapeMesh(s, 'workshop:machined-task-lamp');
}

export function taskLampYokeMesh(): MeshDesc {
  const s = solid();
  // Open fork: both cheeks terminate on the head bearings, never through the shade.
  for (const x of [-.413, .413]) {
    plate(s, [x, .145, 0], [.033, .29, .07]);
    tube(s, [x - .022, 0, 0], [x + .022, 0, 0], .087, 0);
  }
  plate(s, [0, .29, 0], [.86, .052, .075]);
  tube(s, [0, .30, 0], [0, .36, 0], .065, 4);
  tube(s, [0, .35, 0], [0, .405, 0], .045, 1);
  return shapeMesh(s, 'workshop:lamp-bearing-fork');
}

function armMesh(length: number, terminal: boolean): MeshDesc {
  const s = solid();
  // Parallel steel plates straddle each pivot. Cable lies on the outside face.
  const spread = terminal ? .056 : .104;
  for (const z of [-spread, spread]) {
    plate(s, [-length / 2, 0, z], [length, .056, .026]);
    for (const x of [-length, 0]) tube(s, [x, 0, z - .016], [x, 0, z + .016], .061, 0);
  }
  // One shared spindle at the elbow: the distal link fits between the proximal fork.
  for (const x of terminal ? [-length, 0] : [0]) {
    tube(s, [x, 0, -.14], [x, 0, .14], .027, 3);
    tube(s, [x, 0, .124], [x, 0, .14], .045, 4);
    bolts(s.material(1), null, [[x, 0, .143]], [0, 0, 1], .025, .012);
  }
  const cableZ = -spread - .03;
  sweep(s.material(2), null, [[-.06, .025, cableZ], [-length * .4, .052, cableZ], [-length + .06, .025, cableZ]], .009, 8, { bend: .06 });
  for (const x of [-length * .28, -length * .70]) plate(s, [x, .025, cableZ], [.018, .02, .035], 4);
  return shapeMesh(s, 'workshop:paired-lamp-link');
}

export interface TaskLampSpec { anchor: Vec3; side: number; lengths: readonly [number, number]; angles: readonly [number, number]; target: Vec3; size: number; bay: boolean }
export const TASK_LAMPS: readonly TaskLampSpec[] = [
  ...[-1, 1].flatMap(side => [-1.5, 1.5].map(z => ({ anchor: [side * 4.45, 5.15, z] as Vec3, side, lengths: [.52, .40] as const, angles: [-.48, -.38] as const, target: [0, 1.15, 0] as Vec3, size: 1, bay: true }))),
  { anchor: [6.65, 2.85, .6], side: 1, lengths: [1, .79], angles: [.58, -.43], target: [5.65, 1.45, -.65], size: .64, bay: false },
  { anchor: [6.65, 3.1, -4.65], side: 1, lengths: [1.1, .83], angles: [.72, -.20], target: [5.06, 1.7, -5.73], size: .64, bay: false },
];

/** Each link has invariant length. Lift height changes the service aim, not rod scale or joint seating. */
export function taskLampPose(spec: TaskLampSpec, lift: number) {
  const rise = spec.bay ? Math.max(0, Math.min(1.7, lift)) : 0;
  const angles = [spec.angles[0] + rise * .055, spec.angles[1] - rise * .035];
  const points: Vec3[] = [spec.anchor];
  for (let i = 0; i < 2; i++) { const p = points[i], a = angles[i], l = spec.lengths[i]; points.push([p[0] - spec.side * Math.cos(a) * l, p[1] + Math.sin(a) * l, p[2]]); }
  const pivot: Vec3 = [points[2][0], points[2][1] - .40 * spec.size, points[2][2]];
  const target: Vec3 = [spec.target[0], spec.target[1] + rise, spec.target[2]];
  const direction = norm(sub(target, pivot)), yaw = Math.atan2(direction[0], direction[2]);
  const head = chain(translate(...pivot), rotY(yaw), rotX(-Math.asin(direction[1])), scaleM(spec.size, spec.size, spec.size));
  const yoke = chain(translate(...pivot), rotY(yaw), scaleM(spec.size, spec.size, spec.size));
  const emitter = applyPoint(head, 0, 0, .14);
  return { points, pivot, target, direction, emitter, head, yoke, angles };
}

/** Six sealed wall fittings. Ribbed glass, domed cap, protective rails, grounded backplate. */
export function wallLampMesh(): MeshDesc {
  const s = solid();
  plate(s, [0, 0, 0], [.09, .36, .23], 0);
  for (const y of [-.13, .13]) for (const z of [-.075, .075]) bolts(s.material(3), null, [[-.05, y, z]], [-1, 0, 0], .014, .009);
  sweep(s.material(0), null, [[-.05, .06, 0], [-.25, .06, 0], [-.38, .15, 0]], .03, 16, { bend: .045 });
  const c: Vec3 = [-.40, 0, 0];
  steppedTube(s.material(0), translate(...c), [0, -.16, 0], [0, .22, 0], [[.11, 0], [.17, .015], [.18, .035], [.18, .055]], 32);
  steppedTube(s.material(0), translate(...c), [0, .105, 0], [0, .22, 0], [[.19, 0], [.195, .02], [.17, .055], [.075, .095], [.035, .10]], 32);
  tube(s, [-.40, -.102, 0], [-.40, .103, 0], .112, 5, 32);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, x = Math.cos(a), z = Math.sin(a);
    tube(s, [-.40 + x * .116, -.104, z * .116], [-.40 + x * .116, .104, z * .116], .007, 3, 8);
  }
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3, x = Math.cos(a) * .155, z = Math.sin(a) * .155;
    tube(s, [-.40 + x, -.123, z], [-.40 + x, .126, z], .013, 1, 12);
  }
  return shapeMesh(s, 'workshop:guarded-wall-lantern');
}

export class WorkshopLamps {
  private readonly g: WorkshopGeometry;
  private readonly lights: LightHandle[] = [];
  private readonly rigs: { spec: TaskLampSpec; links: InstanceHandle[]; head: InstanceHandle; yoke: InstanceHandle; light: LightHandle }[] = [];
  private lastLift = NaN;
  constructor(private readonly scene: SceneRegistry) {
    const g = this.g = new WorkshopGeometry(scene);
    for (const spec of TASK_LAMPS) {
      const { anchor: p } = spec;
      if (spec.bay) {
        g.cylinder([p[0], 6.45, p[2]], p, .032, 1);
        g.cylinder([p[0], 6.40, p[2]], [p[0], 6.48, p[2]], .11, 4);
        g.cylinder([p[0], p[1] - .06, p[2]], [p[0], p[1] + .09, p[2]], .07, 4);
      } else {
        g.box(p, [.095, .30, .23], 0);
        for (const y of [-.11, .11]) for (const z of [-.075, .075]) g.cylinder([p[0] - .06, p[1] + y, p[2] + z], [p[0] - .08, p[1] + y, p[2] + z], .017, 3);
      }
      const links = spec.lengths.map((l, i) => g.addMesh(armMesh(l, i === 1)));
      const head = g.addMesh(taskLampHeadMesh(), undefined, [.72, .53, .30]), yoke = g.addMesh(taskLampYokeMesh());
      const pose = taskLampPose(spec, 0);
      const light = scene.lights.add({ type: 'spot', position: pose.emitter, direction: pose.direction, color: spec.bay && p[2] > 0 ? [.96, .93, .85] : [1, .83, .58], intensity: spec.bay ? p[2] > 0 ? 100 : 64 : 20, range: spec.bay ? 11 : 4, castShadow: !spec.bay || p[2] < 0, innerAngle: .43, outerAngle: .93 });
      this.lights.push(light); this.rigs.push({ spec, links, head, yoke, light });
    }
    for (const side of [-1, 1]) for (const z of [-6, -1, 4.5]) {
      g.addMesh(wallLampMesh(), transform([side * 6.68, 3.18, z], [1, 1, 1], [0, side < 0 ? Math.PI : 0, 0]), [.62, .39, .17]);
      this.lights.push(scene.lights.add({ type: 'point', position: [side * 6.27, 3.18, z], color: [1, .65, .32], intensity: 11, range: 6, castShadow: true }));
    }
    this.update(0);
  }
  update(lift: number): void {
    if (Math.abs(lift - this.lastLift) < .00001) return;
    this.lastLift = lift;
    for (const { spec, links, head, yoke, light } of this.rigs) {
      const pose = taskLampPose(spec, lift);
      for (let i = 0; i < 2; i++) {
        // Link-local -X points from its parent pin to its child pin.
        const forward = norm(sub(pose.points[i], pose.points[i + 1]));
        const angle = Math.atan2(-forward[1], forward[0]);
        const c = Math.cos(angle), s = Math.sin(angle), p = pose.points[i];
        this.g.setTransform(links[i], Float32Array.of(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, ...p, 1));
      }
      this.g.setTransform(head, Float32Array.from(pose.head)); this.g.setTransform(yoke, Float32Array.from(pose.yoke));
      this.scene.lights.update(light, { position: pose.emitter, direction: pose.direction });
    }
  }
  dispose(): void { this.g.dispose(); for (const light of this.lights) this.scene.lights.remove(light); this.lights.length = 0; }
  occludes(origin: Vec3, direction: Vec3, distance: number): boolean { return this.g.occludes(origin, direction, distance); }
}
