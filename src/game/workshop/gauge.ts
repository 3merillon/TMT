/** The authored boiler keeps its original maps; a fitted ivory face replaces only the baked dial. */
import type { InstanceHandle, MeshDesc, Vec3 } from '../../engine';
import { chain, lookAlong, norm, rotZ } from '../kit/geometry/math';
import { cylinder, Shape } from '../kit/geometry/shapes';
import { shapeMesh, WorkshopGeometry } from './geometry';

export interface PressureGaugeSpec { center: Vec3; normal: Vec3; radius: number }

export function gaugeFaceMesh(radius: number): MeshDesc {
  const positions: number[] = [0, 0, 0], normals: number[] = [0, 0, 1], uv: number[] = [.5, .5, 0], indices: number[] = [];
  for (let i = 0; i <= 96; i++) {
    const angle = i * Math.PI * 2 / 96, x = Math.cos(angle), y = Math.sin(angle);
    positions.push(x * radius, y * radius, 0); normals.push(0, 0, 1); uv.push(.5 + x * .5, .5 - y * .5, 0);
    if (i < 96) indices.push(0, i + 1, i + 2);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), partLocal: Float32Array.from(uv),
    attrs: new Uint32Array(positions.length / 3).fill((14 << 16) | (255 << 8)), indices: Uint32Array.from(indices), label: 'workshop:ivory-pressure-dial' };
}

export function gaugeNeedleMesh(radius: number): MeshDesc {
  const s = new Shape().material(2); s.noHull = true;
  // A tapered steel hand has real thickness, a short counterweight and a separate brass spindle.
  const outline: [number, number][] = [[-.012, -.045], [.012, -.045], [.010, .07], [0, radius * .82], [-.010, .07]];
  const back: Vec3[] = outline.map(([x, y]) => [x, y, .008]), front: Vec3[] = outline.map(([x, y]) => [x, y, .013]);
  s.mb.poly(front, 80, [0, 0, 1]); s.mb.poly(back, 80, [0, 0, -1]);
  for (let i = 0; i < outline.length; i++) { const j = (i + 1) % outline.length; s.mb.poly([back[i], back[j], front[j], front[i]], 80); }
  cylinder(s.material(4), null, [0, 0, .007], [0, 0, .023], .023, 32);
  cylinder(s.material(2), null, [0, 0, .023], [0, 0, .026], .008, 16);
  return shapeMesh(s, 'workshop:pressure-needle');
}

export class WorkshopGauge {
  private readonly needle: InstanceHandle;
  private readonly frame;
  constructor(private readonly geometry: WorkshopGeometry, spec: PressureGaugeSpec) {
    this.frame = lookAlong(spec.center, norm(spec.normal));
    geometry.addMesh(gaugeFaceMesh(spec.radius), Float32Array.from(this.frame));
    this.needle = geometry.addMesh(gaugeNeedleMesh(spec.radius), Float32Array.from(this.frame));
  }
  update(time: number, lift: number, reduced: boolean): void {
    // Steam demand slowly lowers pressure, then the regulator recovers. Reduced motion holds a steady reading.
    const phase = (time + 6) % 9, steamDrop = phase < 1.4 ? Math.sin(phase / 1.4 * Math.PI) * 12 : 0;
    const pressure = reduced ? 142 : 142 + Math.sin(time * .43) * 3 - steamDrop - lift * 8;
    const angle = (135 - pressure / 250 * 270) * Math.PI / 180;
    this.geometry.setTransform(this.needle, Float32Array.from(chain(this.frame, rotZ(angle))));
  }
}
