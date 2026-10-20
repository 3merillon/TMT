/** Human-scale pillar controls with a sealed enclosure, shrouded pushbuttons and cable gland. */
import type { MeshDesc, Vec3 } from '../../engine';
import { bolts, box, cylinder, Shape, sweep } from '../kit/geometry/shapes';
import { translate } from '../kit/geometry/math';
import { WORKSHOP_LIFT_CONTROL_POINT } from './dimensions';
import { shapeMesh } from './geometry';

export const LIFT_BUTTON_POINTS: readonly Vec3[] = [
  [WORKSHOP_LIFT_CONTROL_POINT[0], WORKSHOP_LIFT_CONTROL_POINT[1] + .11, WORKSHOP_LIFT_CONTROL_POINT[2]],
  [WORKSHOP_LIFT_CONTROL_POINT[0], WORKSHOP_LIFT_CONTROL_POINT[1] - .11, WORKSHOP_LIFT_CONTROL_POINT[2]],
];
export function liftControlPanelMesh(): MeshDesc {
  const s = new Shape(); s.noHull = true;
  box(s.material(0), translate(0, .07, -.12), [.31, .72, .14], .026);
  box(s.material(2), translate(0, .06, -.043), [.255, .635, .020], .017);
  for (const y of [-.11, .11]) cylinder(s.material(4), null, [0, y, -.034], [0, y, -.013], .083, 40);
  // Power indicator and a key-operated enable selector are distinct from the two motion controls.
  cylinder(s.material(4), null, [0, .315, -.034], [0, .315, -.008], .032, 24);
  cylinder(s.material(5), null, [0, .315, -.008], [0, .315, -.004], .022, 24);
  cylinder(s.material(3), null, [0, -.23, -.034], [0, -.23, -.006], .032, 24);
  box(s.material(2), translate(0, -.23, -.004), [.011, .040, .006], .002);
  bolts(s.material(7), null, [[-.112, -.23, -.03], [.112, -.23, -.03], [-.112, .33, -.03], [.112, .33, -.03]], [0, 0, 1], .015, .008);
  for (const y of [-.17, .30]) {
    box(s.material(1), translate(0, y, -.23), [.22, .065, .09], .01);
    for (const x of [-.075, .075]) cylinder(s.material(7), null, [x, y, -.185], [x, y, -.175], .016, 12);
  }
  cylinder(s.material(4), null, [0, -.285, -.12], [0, -.365, -.12], .028, 24);
  // A restrained flexible run follows the pillar, bends around its baseplate,
  // and enters a sealed floor conduit outside the steel foot and lift pit.
  sweep(s.material(2), null, [[0, -.365, -.12], [0, -.68, -.12], [.43, -.86, -.12], [.43, -1.18, -.12]], .016, 16, { bend: .085 });
  for (const y of [-.47, -.63]) {
    box(s.material(1), translate(0, y, -.18), [.075, .025, .13], .005);
    bolts(s.material(7), null, [[-.026, y, -.108], [.026, y, -.108]], [0, 0, 1], .009, .007);
  }
  cylinder(s.material(1), null, [.43, -1.145, -.12], [.43, -1.080, -.12], .040, 24);
  cylinder(s.material(4), null, [.43, -1.082, -.12], [.43, -1.068, -.12], .036, 8);
  const mesh = shapeMesh(s, 'workshop:pillar-lift-controller');
  // Enclosure safety-yellow is a separate paint instance; it does not recolour workshop military enamel.
  mesh.attrs = Uint32Array.from(mesh.attrs!, value => ((value >>> 16) & 255) === 18 ? (value & 0xff00ffff) >>> 0 : value);
  return mesh;
}

export function liftPushbuttonMesh(direction: -1 | 1): MeshDesc {
  const s = new Shape(); s.noHull = true;
  cylinder(s.material(2), null, [0, 0, -.012], [0, 0, .006], .068, 40);
  cylinder(s.material(1), null, [0, 0, .006], [0, 0, .014], .055, 40);
  const arrow: Vec3[] = [[-.023, -direction * .015, .015], [.023, -direction * .015, .015], [0, direction * .023, .015]];
  // Low-output backlit symbols remain legible even on the shaded side of the pillar.
  s.material(5); s.mb.poly(direction > 0 ? arrow : [arrow[1], arrow[0], arrow[2]], 0);
  return shapeMesh(s, `workshop:lift-button-${direction > 0 ? 'up' : 'down'}`);
}
