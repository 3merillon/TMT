/** Blender-authored room loaded through the production part-mesh renderer, plus a constrained service lift. */
import type { InstanceHandle, LightHandle, MeshDesc, MeshHandle, SceneRegistry, Vec3 } from '../../engine';
import type { InteriorOccluder } from '../../engine/scene/interior';
import type { WorkshopTextureSpec } from '../../engine/materials/workshop-textures';
import { IDENTITY, transform, WorkshopGeometry } from './geometry';
import { fanRotorMesh, liftDeckMesh, liftFoundationMesh } from './fixtures';
import { WorkshopGauge, type PressureGaugeSpec } from './gauge';
import { WorkshopLift } from './lift';
import { decodeQuantizedRoomMesh, inflateRoomMesh, type RoomMeshSpec } from './mesh-codec';
import { liftControlPanelMesh, liftPushbuttonMesh, LIFT_BUTTON_POINTS } from './control-panel';
import { WORKSHOP_LIFT_CONTROL_POINT } from './dimensions';
import { WORKSHOP_STEAM_VALVES } from './atmospherics';
import { WorkshopLamps } from './lamps';
import { workshopAsset, workshopManifest } from './assets';

export type { RoomMeshSpec } from './mesh-codec';
export interface RoomManifest {
  version: number; meshes: RoomMeshSpec[]; fanRotor?: RoomMeshSpec[]; pressureGauge?: PressureGaugeSpec; textures?: WorkshopTextureSpec[]; occluders?: InteriorOccluder[]; steamVent?: Vec3;
  /** Packaged file names; older packages use the fixed names in workshop-textures.ts and workshop-reflection.ts. */
  surfaces?: string[]; gaugeFace?: string; reflection?: { size: number; faces: string[] };
}
export interface RoomData { manifest: RoomManifest; meshes: MeshDesc[]; fanRotor?: MeshDesc[] }

export function decodeRoomMesh(spec: RoomMeshSpec, buffer: ArrayBuffer): MeshDesc {
  const n = spec.vertexCount, m = spec.indexCount;
  if (!Number.isInteger(n) || n < 3 || n > 3000000 || !Number.isInteger(m) || m < 3 || m % 3 !== 0 || m > 6000000 || buffer.byteLength !== n * 40 + m * 4) throw new Error(`Invalid workshop mesh: ${spec.file}`);
  const positions = new Float32Array(buffer, 0, n * 3), normals = new Float32Array(buffer, n * 12, n * 3);
  const partLocal = new Float32Array(buffer, n * 24, n * 3), attrs = new Uint32Array(buffer, n * 36, n), indices = new Uint32Array(buffer, n * 40, m);
  if (indices.some(v => v >= n) || positions.some(v => !Number.isFinite(v)) || normals.some(v => !Number.isFinite(v)) || partLocal.some(v => !Number.isFinite(v))) throw new Error(`Corrupt workshop mesh: ${spec.file}`);
  return { positions, normals, partLocal, attrs, indices, label: `workshop:${spec.file}` };
}
export async function loadWorkshopRoom(signal?: AbortSignal, manifest?: RoomManifest): Promise<RoomData> {
  manifest ??= await workshopManifest(signal);
  if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.meshes) || !manifest.meshes.length || manifest.meshes.length > 128) throw new Error('Unsupported workshop room format.');
  const decode = async (spec: RoomMeshSpec) => {
    if (!/^[a-z0-9._-]+\.(bin|wmesh)$/i.test(spec.file) || (spec.encoding !== undefined && spec.encoding !== 'quant16-gzip')) throw new Error('Invalid room asset path.');
    const bytes = await (await workshopAsset(spec.file, signal)).arrayBuffer();
    return spec.encoding === 'quant16-gzip' ? decodeQuantizedRoomMesh(spec, await inflateRoomMesh(spec, bytes, signal)) : decodeRoomMesh(spec, bytes);
  };
  if (manifest.fanRotor && (!Array.isArray(manifest.fanRotor) || manifest.fanRotor.length > 16)) throw new Error('Invalid fan asset collection.');
  const [meshes, fanRotor] = await Promise.all([Promise.all(manifest.meshes.map(decode)), Promise.all((manifest.fanRotor ?? []).map(decode))]);
  return { manifest, meshes, fanRotor };
}

/** Conservative solids align with the architectural shell; ceilings use a stepped vault envelope. */
export function workshopOccluders(): InteriorOccluder[] {
  const solids: InteriorOccluder[] = [
    { min: [-8, -.8, -10], max: [-1.72, -.015, 10] }, { min: [1.72, -.8, -10], max: [8, -.015, 10] },
    { min: [-1.72, -.8, -10], max: [1.72, -.015, -2.10] }, { min: [-1.72, -.8, 2.10], max: [1.72, -.015, 10] },
    { min: [-1.72, -.85, -2.10], max: [1.72, -.72, 2.10] },
    { min: [-8, 0, -10], max: [-7, 9, 10] }, { min: [7, 0, -10], max: [8, 9, 10] },
    { min: [-7, 0, -10], max: [7, 9, -8.7], fanAperture: true }, { min: [-7, 0, 9], max: [7, 9, 10] },
    { min: [4.25, .1, -4.65], max: [5.35, 2.5, -3.35] },
    { min: [4.45, .1, -2.2], max: [5.7, 1.05, 2.1] },
  ];
  for (let i = 0; i < 14; i++) {
    const x = -7 + i, inner = Math.min(Math.abs(x), Math.abs(x + 1));
    const y = 3.3 + 4.2 * Math.sqrt(Math.max(0, 1 - (inner / 7) ** 2));
    solids.push({ min: [x, y + .05, -8.7], max: [x + 1, 9, 9] });
  }
  return solids;
}

export class WorkshopRoom {
  private readonly meshes: MeshHandle[] = [];
  private readonly instances: InstanceHandle[] = [];
  private readonly lights: LightHandle[] = [];
  private readonly g: WorkshopGeometry;
  private readonly liftGeometry: WorkshopGeometry;
  private readonly controlButtons: InstanceHandle[];
  private readonly controlStates = [-1, -1];
  private readonly deck: InstanceHandle;
  private readonly lift: WorkshopLift;
  private readonly fan: InstanceHandle[];
  private readonly gauge: WorkshopGauge;
  private readonly lamps: WorkshopLamps;
  private lastLift = NaN;
  readonly triangles: number;
  constructor(private readonly scene: SceneRegistry, data: RoomData) {
    this.triangles = [...data.meshes, ...(data.fanRotor ?? [])].reduce((n, mesh) => n + mesh.indices.length / 3, 0);
    data.meshes.forEach((desc, i) => {
      const mesh = scene.meshes.create(desc); this.meshes.push(mesh);
      this.instances.push(scene.instances.add(mesh, { model: IDENTITY, tint: data.manifest.meshes[i].tint, objectId: 60 + i, classId: data.manifest.meshes[i].material === 5 ? 6 : 2 }));
    });
    const g = this.g = new WorkshopGeometry(scene);
    g.addMesh(liftControlPanelMesh(), transform(WORKSHOP_LIFT_CONTROL_POINT), [.62, .40, .045]);
    this.controlButtons = LIFT_BUTTON_POINTS.map((point, index) => g.addMesh(liftPushbuttonMesh(index === 0 ? 1 : -1), transform(point), [.14, .145, .12]));
    for (const { base, tip } of WORKSHOP_STEAM_VALVES) {
      // Small pressure-bleed valves screwed into the existing header collars, with an open outlet bore.
      const neck: Vec3 = [base[0], base[1] + .034, base[2]];
      g.cylinder(base, neck, .028, 4);
      g.cylinder(neck, tip, .018, 4);
      g.cylinder([tip[0], tip[1] - .003, tip[2]], tip, .010, 2);
      g.torus(tip, .014, .004, 4, [Math.PI / 2, 0, 0]);
      g.cylinder(neck, [neck[0], neck[1], neck[2] + .037], .012, 3);
      g.box([neck[0], neck[1], neck[2] + .041], [.063, .012, .009], 4);
    }
    // Recessed mechanism: the authored .65m deck datum meets the floor at its docking stop.
    const liftGeometry = this.liftGeometry = new WorkshopGeometry(scene, [0, -.65, 0]);
    liftGeometry.addMesh(liftFoundationMesh(), IDENTITY, [.13, .19, .17]);
    this.deck = liftGeometry.addMesh(liftDeckMesh(), IDENTITY, [.13, .19, .17]);
    this.lift = new WorkshopLift(liftGeometry);
    // Exposed ventilation blades rotate slowly behind the authored rear guard.
    this.fan = (data.fanRotor?.length ? data.fanRotor : [fanRotorMesh()]).map(mesh => g.addMesh(mesh, transform([0, 4.22, -8.62])));
    this.gauge = new WorkshopGauge(g, data.manifest.pressureGauge ?? { center: [5.052, 2.269, -4.864], normal: [.030, .027, 1], radius: .238 });
    this.lamps = new WorkshopLamps(scene);
    const addLight = (position: Vec3, color: Vec3, intensity: number, range: number, spot = false, shadow = true, target: Vec3 = [0, 1.15, 0]) => {
      const d: Vec3 = target.map((v, i) => v - position[i]) as Vec3, length = Math.hypot(...d);
      this.lights.push(scene.lights.add({ type: spot ? 'spot' : 'point', position, color, intensity, range, castShadow: shadow,
        direction: d.map(v => v / length) as Vec3, innerAngle: .43, outerAngle: .93 }));
    };
    addLight([-1.5, 3.2, -3.7], [.49, .71, 1], 18, 9);
    addLight([0, 4.4, -7.9], [.45, .67, .78], 22, 8);
    addLight([0, 5.12, -10], [.45, .65, .82], 36, 19, false, false);
    addLight([.82, 5.15, -12.9], [.46, .57, .62], 2, 4, false, false);
    addLight([.82, 5.68, -18.0], [.46, .57, .62], 2, 4, false, false);
    addLight([0, 4.84, 8.48], [1, .82, .62], 60, 8, true, true, [0, 1.9, 8.60]);
    // Low-output service lights reveal the mechanism within the pit when the deck rises.
    for (const x of [-1.65, 1.65]) addLight([x, -.25, 0], [.74, .83, .82], 1.2, 3, false, true);
  }
  setLiftButtonState(index: number, highlighted: boolean, pressed: boolean): void {
    const state = Number(highlighted) + 2 * Number(pressed);
    if (this.controlStates[index] === state) return;
    this.controlStates[index] = state;
    const p = LIFT_BUTTON_POINTS[index];
    this.g.setTransform(this.controlButtons[index], transform([p[0], p[1], p[2] - (pressed ? .008 : 0)]));
    this.g.highlight(this.controlButtons[index], highlighted);
  }
  update(lift: number, time: number, reduced: boolean): void {
    if (Math.abs(lift - this.lastLift) > .00001 || !Number.isFinite(this.lastLift)) {
      this.lastLift = lift;
      this.liftGeometry.setTransform(this.deck, transform([0, lift, 0]));
      this.lift.update(lift);
    }
    const a = reduced ? 0 : -time * .18;
    for (const handle of this.fan) this.g.setTransform(handle, transform([0, 4.22, -8.62], [1, 1, 1], [0, 0, a]));
    const interior = this.scene.get('interior');
    if (interior?.fan) interior.fan.angle = a;
    this.gauge.update(time, lift, reduced);
    this.lamps.update(lift);
  }
  occludes(origin: Vec3, direction: Vec3, distance: number): boolean {
    return this.lamps.occludes(origin, direction, distance) || this.g.occludes(origin, direction, distance) || this.liftGeometry.occludes(origin, direction, distance);
  }
  dispose(): void {
    this.g.dispose(); this.liftGeometry.dispose(); this.lamps.dispose();
    for (const h of this.lights) this.scene.lights.remove(h);
    for (const h of this.instances) this.scene.instances.remove(h);
    for (const h of this.meshes) this.scene.meshes.destroy(h);
    this.lights.length = 0; this.instances.length = 0; this.meshes.length = 0;
  }
}
