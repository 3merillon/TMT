/**
 * Tanks on the engine (plan §5.3 kit contract, §5.4 part-mesh path). Replaces the three `tank-visual.ts`.
 *
 * - Per kit key and LOD, `buildKitMesh(assembleKit(tankKit(t)), lod)` is turned into `scene.meshes.create` calls once and
 *   cached (W0 LODs share arrays, so identical arrays share one mesh). Rigid parts keep their joint-frame geometry;
 *   repeated parts (belt links, road wheels, hubs, end gears) are created WITHOUT their baked sub-instances and get one
 *   scene instance each, because their matrices change every frame. `prebuild` makes every LOD of every tank of a match
 *   at load, so neither a first sighting nor a first LOD switch builds geometry during play.
 * - Per tank and frame, a `KitPoser` produces joint and instance matrices; model = tank world × joint (× instance affine).
 *   The TankState passed to it is smoothed first (tank-visual's release filter on tread contacts and suspension and
 *   its TrackPhaseClock belt prediction), because posing itself is stateless. Joints, running gear and the world matrix
 *   whose inputs are bit-identical to the last frame keep their instance matrices (a parked tank rewrites nothing).
 * - objectId per tank (10 + id), LOD by projected size (with hysteresis), team tint as the paint albedo (matId 0).
 * - Fog of war (docs/visibility-architecture.md): an enemy is drawn only while the simulation says the team sees it,
 *   dissolving in over ENEMY_FADE.in s and out over ENEMY_FADE.out s. Its parts no team sensor can see are veiled by the
 *   engine (`fogged` → the G-buffer veil bit), never clipped. Wrecks are not secrets: they stay drawn and veiled.
 * - Combat scars and the lamp glass of a destroyed tank are written into the existing meshes' surface blocks
 *   (`partMeshes.updateSurface`); the tank's instances restart their motion history as rebuilt meshes' instances did.
 * - Vehicle debug: the rigid collision boxes (`tankHullBoxes`) as debug lines (replaces tank-debug.ts).
 * - SDF shadows: per kit key, one distance-field brick per rigid group (hull, turret, gun; engine sdf-casters.ts) baked
 *   from the lowest LOD in the pose of the tank that first needs it; per tank and frame the three are placed at the
 *   group joints. They exist only while the tank is drawn, so a tank hidden in fog casts nothing that would betray it.
 * - Track stamps for the Surface Memory Cube: one oriented patch per loaded belt per frame, the belt's ground run between
 *   its end stations, with the grouser bars anchored to the ground through the belt phase.
 */
import type { InstanceHandle, MeshDesc, MeshHandle, SceneRegistry } from '../../engine';
import type { SdfCasterHandle, SdfCasterInstance } from '../../engine/passes/sdf/sdf-casters';
import type { SmcStamp } from '../../engine/scene';
import type { SimInterpolation } from '../api/extensions';
import type { GameSnapshot, ImpactEvent, Q4, TankState, V3 } from '../contracts';
import type { TankSurfaceMark } from '../../engine/contracts';
import { defaultAppearance, type TankAppearance } from '../meta/cosmetics';
import { currentVehicleAppearance } from '../workshop/sandbox';
import { tankSurface } from './tank-surface';
import { paintedMesh } from './paint-atlas';
import { onlineVehicleAppearance } from './online-appearance';
import { damageStage, wreckPresence } from './vehicle-damage';
import { vehicleFailureMask, MODULE_DISABLED, weaponOperational } from '../rules/vehicle-damage';
import { vehiclePartMissing } from '../rules/vehicle-parts';
import { fractureArmor, armorSplinters } from './armor-fracture';
import { campaignModel, type CampaignModel } from './campaign-models';
import { DRAGONFLY_ROTOR, DRAGONFLY_TAIL_ROTOR } from './dragonfly-model';
import { componentMeshes } from './component-meshes';
import { componentStage } from '../realtime/components';
import { rotY, rotX, mul as multiplyMatrix } from '../kit/geometry/math';
import { SEARCHLIGHT_MOUNT } from '../realtime/fixtures';
import { VehicleLights } from './vehicle-lights';
import { reactiveArmorMeshes } from './reactive-armor-mesh';
import { RailEnergy } from './rail-energy';
import { assembleKit, buildKitMesh, kitInstanceSource, tankKit, type KitAssembly, type KitPresentationHints, type PartMesh } from '../kit';
import { hypot3, hypot4 } from '../kit/geometry/hypot';
import { KitPoser, POSED_GEAR, POSED_JOINTS } from '../kit/pose';
import { tankHullBoxes } from '../tank-collision';
import { sweepTrack, type TrackTrail } from './track-stamps';
import { meshBounds, rayMeshDistance, type MeshPickWork } from './mesh-pick';
import type { ScreenRect } from './trajectory-readout';

type Mat4 = Float64Array;

/** Predict only between authoritative motor samples, with a short bounded horizon (port of tank-visual's clock).
 * Direction clamps prevent a late sample from making a moving belt roll backwards. */
export class TrackPhaseClock {
  private source = NaN;
  private phase = 0;
  private age = 0;
  private speed = 0;
  update(source: number, speed: number, dt: number): number {
    if (!Number.isFinite(this.source)) { this.source = source; this.phase = source; this.speed = speed; return source; }
    const changed = source !== this.source;
    if (changed) { this.source = source; this.age = 0; } else this.age = Math.min(.05, this.age + Math.max(0, dt));
    const predicted = source + speed * this.age;
    if (Math.abs(speed) < 1e-5) {
      if ((changed && Math.abs(this.speed) < 1e-5) || Math.abs(source - this.phase) > .25) this.phase = source;
    } else this.phase = speed > 0 ? Math.max(this.phase, predicted) : Math.min(this.phase, predicted);
    this.speed = speed;
    return this.phase;
  }
}

export function srgbToLinear(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

/** Paint per tank id: the player green, then warm opponent colours. */
export const TEAM_PAINT = [0x9fc8a5, 0xd79b7a, 0xc7b36a, 0x8fa9d6, 0xc98fb8, 0x9cc7c4, 0xd6a36b, 0xa9a9a9];

// ───────────────────────────── matrices ─────────────────────────────
export function composeTRS(position: readonly number[], q: readonly number[], out: Mat4 = new Float64Array(16)): Mat4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy); out[3] = 0;
  out[4] = 2 * (xy - wz); out[5] = 1 - 2 * (xx + zz); out[6] = 2 * (yz + wx); out[7] = 0;
  out[8] = 2 * (xz + wy); out[9] = 2 * (yz - wx); out[10] = 1 - 2 * (xx + yy); out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}
export function mul4(a: ArrayLike<number>, b: ArrayLike<number>, out: Float32Array | Float64Array): void {
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
}
/** Inverse of a rigid mat4 (rotation + translation). */
function invertRigid(m: ArrayLike<number>, out: Float64Array): void {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
  out[3] = 0; out[7] = 0; out[11] = 0; out[15] = 1;
}

/** The rigid groups a tank casts SDF shadows with (one brick each): each joint rides in its group's root frame. */
const CASTER_GROUP: Readonly<Record<string, string>> = {
  hull: 'hull', tensioner: 'hull', turret: 'turret', hatch: 'turret', antenna: 'turret', radar: 'turret', periscope: 'turret',
  cradle: 'cradle', barrel: 'cradle',
  'searchlight-yoke': 'searchlight-yoke', 'searchlight-head': 'searchlight-head',
};
const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const affine = new Float64Array(16);

/** a (mat4) × affine (12 floats: rows of a 3×4) → out. */
function mulAffine(a: ArrayLike<number>, src: Float32Array, index: number, out: Float32Array): void {
  const o = index * 12, b = affine;
  b[0] = src[o]; b[1] = src[o + 4]; b[2] = src[o + 8]; b[3] = 0; b[4] = src[o + 1]; b[5] = src[o + 5]; b[6] = src[o + 9]; b[7] = 0;
  b[8] = src[o + 2]; b[9] = src[o + 6]; b[10] = src[o + 10]; b[11] = 0; b[12] = src[o + 3]; b[13] = src[o + 7]; b[14] = src[o + 11]; b[15] = 1;
  mul4(a, b, out);
}
export function transformPoint(m: ArrayLike<number>, p: readonly number[]): V3 {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function transformDir(m: ArrayLike<number>, d: readonly number[]): V3 {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}
function slerpInto(a: readonly number[], b: readonly number[], t: number, out: number[]): void {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  let k0 = 1 - t, k1 = t * s;
  if (d < 0.9995) { const th = Math.acos(d), sn = Math.sin(th); k0 = Math.sin((1 - t) * th) / sn; k1 = Math.sin(t * th) / sn * s; }
  const q0 = a[0] * k0 + b[0] * k1, q1 = a[1] * k0 + b[1] * k1, q2 = a[2] * k0 + b[2] * k1, q3 = a[3] * k0 + b[3] * k1;
  const l = hypot4(q0, q1, q2, q3) || 1;
  out[0] = q0 / l; out[1] = q1 / l; out[2] = q2 / l; out[3] = q3 / l;
}

/** Angle blend along the shorter arc: a yaw crossing ±π turns through the seam, never the long way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  if (t >= 1) return b;
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

export interface RenderedPose { position: V3; rotation: Q4; turretYaw: number; barrelPitch: number }

/**
 * The rendered root pose of a tank: the SimInterpolation blend (W1-GAME) of its previous and current fixed-tick poses at
 * `alpha`, or the snapshot pose without interpolation. The view uses the same pose for the tank, its follow camera and
 * its label.
 */
export function renderedPose(state: GameSnapshot, tank: TankState, interp?: SimInterpolation): RenderedPose {
  return renderedPoseInto(state, tank, interp, { position: [0, 0, 0], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: 0 });
}

/** `renderedPose` into `out`. */
export function renderedPoseInto(state: GameSnapshot, tank: TankState, interp: SimInterpolation | undefined, out: RenderedPose): RenderedPose {
  const k = state.tanks.indexOf(tank);
  const prev = interp?.prev[k], curr = interp?.curr[k];
  if (!interp || !prev || !curr) {
    for (let i = 0; i < 3; i++) out.position[i] = tank.position[i];
    for (let i = 0; i < 4; i++) out.rotation[i] = tank.rotation[i];
    out.turretYaw = tank.turretYaw; out.barrelPitch = tank.barrelPitch;
    return out;
  }
  const a = Math.min(1, Math.max(0, interp.alpha));
  for (let i = 0; i < 3; i++) out.position[i] = prev.position[i] + (curr.position[i] - prev.position[i]) * a;
  slerpInto(prev.rotation, curr.rotation, a, out.rotation);
  out.turretYaw = lerpAngle(prev.turretYaw, curr.turretYaw, a);
  out.barrelPitch = prev.barrelPitch + (curr.barrelPitch - prev.barrelPitch) * a;
  return out;
}

/** Whether two matrices are equal bit for bit (±0 apart). */
function sameMatrix(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < 16; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// ───────────────────────────── meshes ─────────────────────────────
interface PartSet { part: PartMesh; mesh: MeshHandle; source: { buffer: string; first: number; count: number } | null }
interface MeshSet { key: string; lod: 0 | 1 | 2; parts: PartSet[] }
/** The kit ids an entry was assembled from (a field change re-assembles). */
interface KitIds { hull?: string; runningGear?: string; turret?: string; weapon?: string; utility?: string; armor?: string; tracks?: string; barrel?: string; legacyArmor?: string }
interface TankEntry {
  failureMask: number; detached: Set<string>; geometryDirty: boolean;
  componentHealth: string;
  generation: number; damage: number; model?: CampaignModel;
  appearance: TankAppearance; appearanceRevision: number; scars: Map<string, TankSurfaceMark[]>; surfaceDirty: boolean; headlightsOn: boolean; lights: VehicleLights; reactiveMask: number; rail: RailEnergy;
  id: number; key: string; kit: KitIds; assembly: KitAssembly; lod: 0 | 1 | 2; set: MeshSet | null;
  instances: { handle: InstanceHandle; part: number; sub: number }[];
  poser: KitPoser; world: Mat4; clocks: [TrackPhaseClock, TrackPhaseClock];
  ground: number[]; suspension: number[]; phases: [number, number];
  /** The smoothed state handed to the poser (kept, so a frame allocates no copy of the tank). */
  input: TankState & KitPresentationHints;
  /** The world matrix and presence the instances were last written with (NaN: never). */
  written: Mat4; presenceWritten: number;
  /** Previous loaded belt pose and accumulated longitudinal ground travel. */
  trail: (TrackTrail | null)[];
  visible: boolean; observed: boolean; fogged: boolean; tint: [number, number, number];
  /** SDF caster instances (hull, turret, gun bricks), present only while the tank is drawn. */
  casters: { group: string; instance: SdfCasterInstance }[];
  /** Sim-gated presence 0 … 1 (the dithered dissolve of enemies in fog). */
  presence: number;
}

/** Enemy dissolve durations (s): in when the team starts seeing it, out (within one 10 Hz sim observation) when it stops. */
export const ENEMY_FADE = { in: 0.15, out: 0.1 } as const;

export const TANK_LOD_PIXELS = [72, 14] as const;
/** Grouser pitch used to anchor the SMC bar pattern (tank-visual's link spacing). */
export const TREAD_PITCH = 0.11;
/** Combat scars a vehicle keeps (the oldest group's go first); room for them is reserved in its rigid meshes. */
const SCAR_LIMIT = 24;

export interface TankViewStats { tanks: number; visible: number; instances: number; meshes: number; lods: number[] }

export class TankViews {
  private readonly tanks = new Map<number, TankEntry>();
  private readonly meshSets = new Map<string, MeshSet>();
  private readonly casterBricks = new Map<string, { group: string; handle: SdfCasterHandle }[]>();
  private readonly scratch = new Float32Array(16);
  private readonly joint = new Float64Array(16);
  private readonly world = new Float64Array(16);
  private readonly pickWork: MeshPickWork = { parts: 0, bounds: 0, triangles: 0 };
  private pickMilliseconds = 0;
  /** This frame's rendered poses by snapshot index (`beginFrame` starts a frame). */
  private poses: RenderedPose[] = [];
  private posed: boolean[] = [];
  private poseState: GameSnapshot | null = null;
  private poseInterp: SimInterpolation | undefined;

  constructor(private readonly scene: SceneRegistry,
    private readonly detach?: (mesh: MeshDesc, transform: ArrayLike<number>, tint: V3, velocity: V3) => void) {}

  /** Start a frame: rendered poses are computed at most once each until the next call. */
  beginFrame(state: GameSnapshot, interp?: SimInterpolation): void {
    this.poseState = state; this.poseInterp = interp;
    this.posed.fill(false);
  }

  /** `renderedPose` of a tank of this frame's snapshot, shared by every caller of the frame: read it, never keep it. */
  pose(state: GameSnapshot, tank: TankState, interp?: SimInterpolation): RenderedPose {
    const k = state.tanks.indexOf(tank);
    if (state !== this.poseState || interp !== this.poseInterp || k < 0) return renderedPose(state, tank, interp);
    let pose = this.poses[k];
    if (!pose) this.poses[k] = pose = { position: [0, 0, 0], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: 0 };
    if (!this.posed[k]) { renderedPoseInto(state, tank, interp, pose); this.posed[k] = true; }
    return pose;
  }

  private meshSet(a: KitAssembly, lod: 0 | 1 | 2, tank: TankEntry): MeshSet {
    const key = `${a.key}#${lod}#${tank.id}`;
    let set = this.meshSets.get(key);
    if (set) return set;
    const data = tank.model ? { parts: campaignModel(tank.model, lod) } : buildKitMesh(a, lod), facet = this.scene.get('partMeshes');
    set = {
      key, lod, parts: [...data.parts, ...(tank.model ? [] : reactiveArmorMeshes(a, lod, tank.reactiveMask).map(p => p.mesh)),
        ...(tank.input.components ? componentMeshes(tank.input.components, lod) : [])].map(original => {
        const source = tank.model ? null : kitInstanceSource(a, original);
        const painted = !source && !original.instances && !tank.model ? paintedMesh(original, tank.appearance, a.loadout, original.part, lod) : original;
        // Paint stays anchored to the original surface as damage subdivides and deforms it.
        const part = fractureArmor({ ...original, ...painted } as PartMesh & Pick<MeshDesc, 'paintTexture'>, tank.scars.get(original.part) ?? []);
        // W0 LODs share their arrays: identical geometry shares one engine mesh.
        const desc: MeshDesc = { ...part, tankSurface: this.surface(tank, part.part), instances: source ? undefined : part.instances, label: `tank:${a.key}:${part.part}:${lod}` };
        // Scars land on rigid parts only: those meshes keep room to take them in place.
        const mesh = facet ? facet.create(desc, source || part.instances ? 0 : SCAR_LIMIT) : this.scene.meshes.create(desc);
        return { part, mesh, source };
      }),
    };
    this.meshSets.set(key, set);
    return set;
  }

  /** A part's surface: the paint, the lamp glass (dark once destroyed) and the part's combat scars. */
  private surface(t: TankEntry, part: string) {
    const surface = tankSurface(t.appearance, t.assembly.loadout, undefined, part);
    surface.lights = surface.lights && t.headlightsOn;
    const component = t.input.components?.find(c => `component:${c.id}` === part);
    const damage = component ? damageStage(component.health, component.maxHealth) : t.damage;
    const soot = [1, .8, .57, .34, .13][damage];
    surface.damage = [0, .12, .3, .58, 1][damage];
    surface.colors = surface.colors.map(c => c.map(n => n * soot + (t.damage === 4 ? .018 : 0))) as typeof surface.colors;
    surface.wear = Math.min(1, .42 + t.damage * .14);
    surface.marks!.push(...(t.scars.get(part) ?? []));
    return surface;
  }

  /**
   * Write the surfaces of every built mesh of a tank in place; false when the engine cannot (the caller rebuilds). The
   * instances restart their motion history, as the instances of rebuilt meshes would.
   */
  private refreshSurface(t: TankEntry): boolean {
    const facet = this.scene.get('partMeshes');
    if (!facet) return false;
    for (const lod of [0, 1, 2] as const) {
      const set = this.meshSets.get(`${t.key}#${lod}#${t.id}`);
      if (set) for (const p of set.parts) if (!facet.updateSurface(p.mesh, this.surface(t, p.part.part))) return false;
    }
    for (const i of t.instances) facet.restart(i.handle);
    t.written[0] = NaN;
    return true;
  }

  /** Every LOD of every tank of a match (at match load: no first sighting or LOD switch builds geometry in play). */
  prebuild(state: GameSnapshot): void {
    for (const tank of state.tanks) {
      const t = this.entry(tank);
      const appearanceRevision = onlineVehicleAppearance(tank.id).revision;
      if (appearanceRevision !== t.appearanceRevision) {
        t.appearanceRevision = appearanceRevision; t.appearance = this.appearanceFor(tank); t.geometryDirty = true;
      }
      for (const lod of [0, 1, 2] as const) this.meshSet(t.assembly, lod, t);
    }
  }

  /** The kit's caster bricks (baked once per kit key from the lowest LOD, in this tank's current pose). */
  private bricks(t: TankEntry): { group: string; handle: SdfCasterHandle }[] {
    const casterKey = `${t.assembly.key}:${t.model ?? "tank"}:${t.failureMask}:${t.damage === 4}:${t.input.components?.filter(c => c.health <= 0).map(c => c.id).join(',') ?? ''}`;
    const cached = this.casterBricks.get(casterKey);
    if (cached) return cached;
    const casters = this.scene.get('sdfCasters');
    if (!casters) return [];
    const kitPose = t.poser.pose, pose = kitPose as unknown as Record<string, Float32Array>;
    const soups = new Map<string, { positions: number[]; indices: number[] }>();
    const inv = new Float64Array(16), rel = new Float64Array(16), m = new Float32Array(16);
    for (const part of (t.model ? campaignModel(t.model, 2) : [...buildKitMesh(t.assembly, 2).parts, ...reactiveArmorMeshes(t.assembly, 2).map(p => p.mesh)])) {
      const group = CASTER_GROUP[part.joint] ?? 'hull';
      invertRigid(kitPose.joints.get(group) ?? IDENTITY, inv);
      mul4(inv, kitPose.joints.get(part.joint) ?? IDENTITY, rel);
      const source = t.model ? null : kitInstanceSource(t.assembly, part);
      const count = source ? source.count : part.instances ? part.instances.length / 12 : 1;
      const partIndex = t.set?.parts.findIndex(p => p.part.part === part.part) ?? -1;
      let soup = soups.get(group);
      if (!soup) soups.set(group, soup = { positions: [], indices: [] });
      for (let k = 0; k < count; k++) {
        if (partIndex >= 0 && this.brokenPart(t, partIndex, k)) continue;
        if (source) mulAffine(rel, pose[source.buffer], source.first + k, m);
        else if (part.instances) mulAffine(rel, part.instances, k, m);
        else m.set(rel);
        const base = soup.positions.length / 3;
        for (let v = 0; v < part.positions.length; v += 3) {
          const x = part.positions[v], y = part.positions[v + 1], z = part.positions[v + 2];
          soup.positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        for (const i of part.indices) soup.indices.push(base + i);
      }
    }
    const bricks = [...soups].flatMap(([group, soup]) => {
      const handle = casters.create({ positions: new Float32Array(soup.positions), indices: new Uint32Array(soup.indices), label: `tank:${t.assembly.key}:${group}` });
      return handle ? [{ group, handle }] : [];
    });
    this.casterBricks.set(casterKey, bricks);
    return bricks;
  }

  private dropCasters(t: TankEntry): void {
    const casters = this.scene.get('sdfCasters');
    for (const c of t.casters) casters?.remove(c.instance);
    t.casters = [];
  }

  private dropInstances(t: TankEntry): void {
    for (const i of t.instances) this.scene.instances.remove(i.handle);
    t.instances = [];
    t.set = null;
  }

  private invalidateSurface(t: TankEntry): void {
    this.dropInstances(t);
    for (const [key, set] of this.meshSets) if (key.startsWith(`${t.key}#`) && key.endsWith(`#${t.id}`)) {
      for (const p of set.parts) this.scene.meshes.destroy(p.mesh);
      this.meshSets.delete(key);
    }
  }

  private attach(t: TankEntry, set: MeshSet): void {
    this.dropInstances(t);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    set.parts.forEach((p, part) => {
      const count = p.source ? p.source.count : 1;
      for (let sub = 0; sub < count; sub++) {
        t.instances.push({ part, sub, handle: this.scene.instances.add(p.mesh, { model: identity, tint: t.tint, objectId: (10 + t.id) & 0x1ff,
          fogged: t.fogged, visibility: t.presence }) });
      }
    });
    t.set = set;
    t.written[0] = NaN;
  }

  /** Whether the tank's kit ids are still those its entry was assembled from. */
  private sameKit(t: TankEntry, tank: TankState): boolean {
    const k = tank.kit, l = tank.loadout, s = t.kit;
    return k ? s.hull === k.hull && s.runningGear === k.runningGear && s.turret === k.turret && s.weapon === k.weapon && s.utility === k.utility && s.armor === k.armor
      && s.tracks === undefined
      : s.hull === undefined && s.tracks === l.tracks && s.barrel === l.barrel && s.legacyArmor === l.armor;
  }

  /** Remove tanks that are gone and (re)build changed loadouts; call before update(). */
  private entry(tank: TankState): TankEntry {
    let t = this.tanks.get(tank.id);
    if (t && t.generation === (tank.generation ?? 0) && this.sameKit(t, tank)) return t;
    const kit = tankKit(tank);
    const assembly = assembleKit(kit);
    const k = tank.kit, ids: KitIds = k ? { hull: k.hull, runningGear: k.runningGear, turret: k.turret, weapon: k.weapon, utility: k.utility, armor: k.armor }
      : { tracks: tank.loadout.tracks, barrel: tank.loadout.barrel, legacyArmor: tank.loadout.armor };
    if (t && t.generation === (tank.generation ?? 0) && t.key === assembly.key) { t.kit = ids; return t; }
    if (t) { this.invalidateSurface(t); this.dropCasters(t); t.lights.dispose(); t.rail.dispose(); this.tanks.delete(tank.id); t = undefined; }
    t = {
      failureMask: 0, detached: new Set(), geometryDirty: false,
      model: tank.visualKind, componentHealth: '', generation: tank.generation ?? 0, damage: damageStage(tank.health, tank.maxHealth ?? assembly.stats.hp),
      appearance: this.appearanceFor(tank), appearanceRevision: onlineVehicleAppearance(tank.id).revision,
      scars: new Map(), surfaceDirty: false, headlightsOn: tank.health > 0, lights: new VehicleLights(this.scene, assembly), reactiveMask: tank.reactiveArmor ?? 0, rail: new RailEnergy(this.scene, assembly.loadout.weapon),
      id: tank.id, key: assembly.key, kit: ids, assembly, lod: 0, set: null, instances: [], poser: new KitPoser(assembly), world: new Float64Array(16),
      clocks: [new TrackPhaseClock(), new TrackPhaseClock()], ground: [], suspension: [], phases: [0, 0], trail: [null, null], visible: false, observed: false, fogged: false, presence: 0,
      casters: [], input: { ...tank }, written: new Float64Array(16).fill(NaN), presenceWritten: NaN,
      // Team tint (W1-GAME's TankState.team; team mates share a paint in 2v2); v1 snapshots without teams fall back to the id.
      tint: srgbToLinear(TEAM_PAINT[(tank.team ?? tank.id) % TEAM_PAINT.length]),
    };
    this.tanks.set(tank.id, t);
    return t;
  }

  /**
   * Pose every tank. `pixelsPerUnitAt(p)` gives the on-screen scale at a world point (LOD selection); `visible(tank)` is the
   * observation rule (the observer and currently seen tanks).
   */
  update(state: GameSnapshot, dt: number, visible: (tank: TankState) => boolean, pixelsPerUnitAt: (p: V3) => number,
    interp?: SimInterpolation, fogged: (tank: TankState) => boolean = () => false): void {
    const live = this.live;
    live.clear();
    const release = 1 - Math.exp(-Math.min(Math.max(dt, 0), .1) / .075);
    for (const tank of state.tanks) {
      if (tank.retired) continue;
      live.add(tank.id);
      const t = this.entry(tank);
      const appearanceRevision = onlineVehicleAppearance(tank.id).revision;
      if (appearanceRevision !== t.appearanceRevision) {
        t.appearanceRevision = appearanceRevision; t.appearance = this.appearanceFor(tank); t.geometryDirty = true;
      }
      const hideInFog = fogged(tank);
      const observed = visible(tank);
      // The simulation is the only truth: an enemy in fog is drawn only while the team sees it (wrecks always).
      const target = !hideInFog || observed || tank.health <= 0 ? wreckPresence(tank, state.tick) : 0;
      const rate = Math.max(dt, 0) / (target > t.presence ? ENEMY_FADE.in : ENEMY_FADE.out);
      t.presence = !hideInFog ? target : target > t.presence ? Math.min(target, t.presence + rate) : Math.max(target, t.presence - rate);
      const seen = hideInFog ? t.presence > 0 : observed;
      if (!seen) { if (t.instances.length) this.dropInstances(t); this.dropCasters(t); t.lights.clear(); t.rail.hide(); t.visible = false; t.observed = false; continue; }
      t.visible = true;
      t.observed = observed;
      const fogChanged = t.fogged !== hideInFog;
      t.fogged = hideInFog;
      // Interpolated root pose (W1-GAME passes interp; without it the snapshot pose is used).
      const { position, rotation, turretYaw: yaw, barrelPitch: pitch } = this.pose(state, tank, interp);
      composeTRS(position, rotation, t.world);
      const headlights = tank.health > 0 && (tank.machinery?.engine ?? 1) > MODULE_DISABLED && tank.headlights !== false;
      t.lights.update(t.world, headlights && !tank.searchlight && t.appearance.lights !== false && observed, 1, t.casters.find(c => c.group === 'hull')?.instance.id ?? 0);
      t.lights.searchlight(observed ? tank.searchlight : undefined, t.casters.find(c => c.group === 'searchlight-head')?.instance.id ?? 0);
      const damage = damageStage(tank.health, tank.maxHealth ?? t.assembly.stats.hp);
      if (damage !== t.damage) { t.damage = damage; t.surfaceDirty = true; }
      const componentHealth = tank.components?.map(c => Math.ceil(c.health)).join('/') ?? '';
      if (componentHealth !== t.componentHealth) {
        const failures = (health: string) => health.split('/').map(h => h === '0').join('/');
        if (failures(componentHealth) !== failures(t.componentHealth)) { this.dropCasters(t); t.written[0] = NaN; }
        t.componentHealth = componentHealth; t.input.components = tank.components; t.surfaceDirty = true;
      }
      if (t.geometryDirty || t.reactiveMask !== (tank.reactiveArmor ?? 0)) {
        t.reactiveMask = tank.reactiveArmor ?? 0; t.headlightsOn = headlights;
        this.invalidateSurface(t); t.surfaceDirty = false; t.geometryDirty = false;
      } else if (t.surfaceDirty || t.headlightsOn !== headlights) {
        t.headlightsOn = headlights;
        if (!this.refreshSurface(t)) this.invalidateSurface(t);
        t.surfaceDirty = false;
      }
      // LOD by projected size, with 15 % hysteresis.
      const px = pixelsPerUnitAt(position) * 1.6;
      const want: 0 | 1 | 2 = px > TANK_LOD_PIXELS[0] * (t.lod === 0 ? 0.85 : 1) ? 0 : px > TANK_LOD_PIXELS[1] * (t.lod <= 1 ? 0.85 : 1) ? 1 : 2;
      const set = this.meshSet(t.assembly, want, t);
      if (t.set !== set || fogChanged) { t.lod = want; this.attach(t, set); }
      // tank-visual's release filter: contacts may push up immediately, a departing load releases gradually.
      for (let i = 0; i < tank.treadContacts.length; i++) {
        const req = tank.treadContacts[i];
        t.ground[i] = Number.isFinite(t.ground[i]) ? Math.max(req, t.ground[i] + (req - t.ground[i]) * release) : req;
      }
      for (let i = 0; i < tank.wheelSuspension.length; i++) {
        const req = tank.wheelSuspension[i];
        t.suspension[i] = Number.isFinite(t.suspension[i]) ? Math.max(req, t.suspension[i] + (req - t.suspension[i]) * release) : req;
      }
      for (let side = 0; side < 2; side++) t.phases[side] = t.clocks[side].update(tank.trackPhases[side], tank.trackSpeeds[side], dt);
      // The tank's fields over last frame's; the optional ones the poser reads are copied as well, so one the snapshot
      // dropped reads undefined, as in a fresh copy of the tank.
      const input = Object.assign(t.input, tank);
      input.machinery = tank.machinery;
      input.treadTerrain = tank.treadTerrain; input.hatch = (tank as KitPresentationHints).hatch; input.aiming = (tank as KitPresentationHints).aiming;
      input.time = state.time; input.turretYaw = yaw; input.barrelPitch = pitch; input.trackPhases = t.phases;
      input.treadContacts = t.ground.length === tank.treadContacts.length ? t.ground : t.ground.slice(0, tank.treadContacts.length);
      input.wheelSuspension = t.suspension.length === tank.wheelSuspension.length ? t.suspension : t.suspension.slice(0, tank.wheelSuspension.length);
      let posed = t.poser.update(input);
      if (t.model === 'dragonfly') {
        const running = tank.health > 0 && (tank.machinery?.engine ?? 1) > MODULE_DISABLED;
        const rotor = new Float32Array(rotY(running ? state.time * 35 : .3)); rotor.set(DRAGONFLY_ROTOR, 12);
        t.poser.pose.joints.set('flight-rotor', rotor); posed |= POSED_JOINTS;
        const tail = new Float32Array(rotX(running ? state.time * 54 : .5)); tail.set(DRAGONFLY_TAIL_ROTOR, 12);
        t.poser.pose.joints.set('flight-tail-rotor', tail);
      }
      if (t.model === 'watchtower') {
        const head = new Float32Array(multiplyMatrix(rotY(tank.turretYaw), rotX(SEARCHLIGHT_MOUNT.pitch))); head[13] = SEARCHLIGHT_MOUNT.height;
        const yoke = new Float32Array(rotY(tank.turretYaw)); yoke[13] = SEARCHLIGHT_MOUNT.height;
        t.poser.pose.joints.set('searchlight-yoke', yoke);
        t.poser.pose.joints.set('searchlight-head', head); posed |= POSED_JOINTS;
      }
      if (tank.components?.some(c => c.id === 'core')) {
        const shutter = new Float32Array(IDENTITY); shutter[13] = componentStage(tank) >= 2 ? .55 : 0;
        t.poser.pose.joints.set('machinery-core-shutter', shutter); posed |= POSED_JOINTS;
      }
      const pose = t.poser.pose;
      if (t.assembly.loadout.weapon === 'rail' || t.assembly.loadout.weapon === 'arc_cannon' || t.assembly.loadout.weapon === 'forge_mortar') {
        mul4(t.world, pose.joints.get('barrel')!, this.scratch);
        t.rail.update(this.scratch, dt, state.active === tank.id && state.phase === 'aim', observed && tank.health > 0 && weaponOperational(tank), 10 + t.id);
      }
      const failure = tank.health <= 0 ? 15 : vehicleFailureMask(tank);
      if (failure !== t.failureMask) { t.failureMask = failure; t.written[0] = NaN; this.dropCasters(t); }
      const moved = this.writeInstances(t, posed);
      // SDF shadows: the group bricks at their joints.
      const casters = this.scene.get('sdfCasters');
      if (casters) {
        const fresh = !t.casters.length;
        if (fresh) t.casters = this.bricks(t).map(b => ({ group: b.group, instance: casters.add(b.handle, IDENTITY) }));
        if (fresh || moved || posed & POSED_JOINTS) for (const c of t.casters) {
          const joint = pose.joints.get(c.group);
          if (joint) mul4(t.world, joint, this.joint); else this.joint.set(t.world);
          casters.set(c.instance, this.joint);
        }
      }
    }
    for (const [id, t] of this.tanks) if (!live.has(id)) { this.invalidateSurface(t); this.dropCasters(t); t.lights.dispose(); t.rail.dispose(); this.tanks.delete(id); }
  }
  private readonly live = new Set<number>();
  private appearanceFor(tank: TankState): TankAppearance {
    const online = onlineVehicleAppearance(tank.id);
    if (online.active && online.appearance) return online.appearance;
    if (!online.active && tank.id === 0) return currentVehicleAppearance();
    return { ...defaultAppearance(), finish: { pattern: 'solid', colors: [`#${TEAM_PAINT[(tank.team ?? tank.id) % TEAM_PAINT.length].toString(16).padStart(6, '0')}`, '#394638', '#b8ac83'], scale: 1 } };
  }

  /**
   * Model matrices of a tank's instances: world × joint (× instance affine). A part is rewritten only when an input of
   * its matrix changed (the world, its joint, the running gear) or its instances are new; equal inputs, equal matrices.
   * Returns whether the world moved.
   */
  private writeInstances(t: TankEntry, posed: number): boolean {
    const all = Number.isNaN(t.written[0]), moved = all || !sameMatrix(t.world, t.written);
    const joints = (posed & POSED_JOINTS) !== 0, gear = (posed & POSED_GEAR) !== 0;
    const pose = t.poser.pose, buffers = pose as unknown as Record<string, Float32Array>, parts = t.set!.parts;
    if (moved || joints || gear) {
      let part = -1;
      for (const inst of t.instances) {
        const p = parts[inst.part];
        // The hull joint is the identity in every pose: only the world moves parts that ride on it.
        if (!moved && !(p.source && gear) && !(joints && p.part.joint !== 'hull')) continue;
        if (inst.part !== part) {
          part = inst.part;
          const joint = pose.joints.get(p.part.joint);
          if (joint) mul4(t.world, joint, this.joint); else this.joint.set(t.world);
        }
        if (p.source) mulAffine(this.joint, buffers[p.source.buffer], p.source.first + inst.sub, this.scratch);
        else this.scratch.set(this.joint);
        const missing = this.brokenPart(t, inst.part, inst.sub);
        const key = `${p.part.part}:${inst.sub}`;
        if (missing && !t.detached.has(key)) {
          t.detached.add(key);
          // Sample a broken belt into a bounded set of recognizable links; leave wheels exposed.
          if (!p.source || p.part.part !== 'links' || inst.sub % 6 === 0) {
            const up = normalize([t.world[12], t.world[13], t.world[14]]);
            const kick = normalize([this.scratch[12] - t.world[12] + up[0] * .4, this.scratch[13] - t.world[13] + up[1] * .4, this.scratch[14] - t.world[14] + up[2] * .4]);
            this.detach?.({ ...p.part, instances: undefined, tankSurface: this.surface(t, p.part.part) }, this.scratch, t.tint,
              t.input.velocity.map((v, i) => v + kick[i] * 2.3) as V3);
          }
        } else if (!missing) t.detached.delete(key);
        this.scene.instances.set(inst.handle, this.scratch);
      }
      t.written.set(t.world);
    }
    if (all || !Object.is(t.presence, t.presenceWritten)) {
      for (const inst of t.instances) this.scene.instances.setVisibility(inst.handle, this.brokenPart(t, inst.part, inst.sub) ? 0 : t.presence);
      t.presenceWritten = t.presence;
    }
    return moved;
  }

  private brokenPart(t: TankEntry, part: number, sub: number): boolean {
    const p = t.set!.parts[part], buffer = p.source && (t.poser.pose as unknown as Record<string, Float32Array>)[p.source.buffer];
    return vehiclePartMissing(t.input, p.part.part, p.part.joint, buffer ? buffer[(p.source!.first + sub) * 12 + 3] > 0 : undefined);
  }

  /** World position of the muzzle (for the muzzle flash); null when the tank has no pose yet. */
  muzzle(id: number): { position: V3; forward: V3 } | null {
    const t = this.tanks.get(id);
    if (!t) return null;
    const cradle = t.poser.pose.joints.get('cradle');
    if (!cradle) return null;
    mul4(t.world, cradle, this.world);
    return { position: transformPoint(this.world, t.assembly.frames.muzzle.position), forward: normalize(transformDir(this.world, [0, 0, 1])) };
  }
  fire(id: number): void { this.tanks.get(id)?.rail.fire(); }

  /** Project actual combat contact onto the nearest rendered skin. A sphere hit never becomes a floating decal. */
  impact(event: ImpactEvent): void {
    for (const impact of event.hits ?? []) {
      if (impact.damage <= 0) continue;
      const t = this.tanks.get(impact.tank); if (!t?.observed || !t.set) continue;
      const center: V3 = [t.world[12], t.world[13], t.world[14]];
      const direction = normalize(center.map((v, i) => v - event.position[i]) as V3);
      const eye = event.position.map((v, i) => v - direction[i] * .45) as V3;
      let nearest = impact.direct ? 3.5 : Math.hypot(...center.map((v, i) => v - eye[i])) + 2, chosen: { part: PartSet; hit: { triangle: number; position: V3; normal: V3 } } | null = null;
      const pose = t.poser.pose as unknown as Record<string, Float32Array>;
      for (const [partIndex, p] of t.set.parts.entries()) {
        const joint = t.poser.pose.joints.get(p.part.joint);
        if (joint) mul4(t.world, joint, this.joint); else this.joint.set(t.world);
        const transforms = p.source ? pose[p.source.buffer] : p.part.instances;
        const count = p.source ? p.source.count : transforms ? transforms.length / 12 : 1;
        for (let i = 0; i < count; i++) {
          if (this.brokenPart(t, partIndex, i)) continue;
          if (transforms) mulAffine(this.joint, transforms, (p.source?.first ?? 0) + i, this.scratch); else this.scratch.set(this.joint);
          const hit = { triangle: 0, position: [0, 0, 0] as V3, normal: [0, 1, 0] as V3 };
          const distance = rayMeshDistance(p.part, this.scratch, eye, direction, nearest, undefined, hit);
          if (distance !== null) { nearest = distance; chosen = { part: p, hit }; }
        }
      }
      // Instanced running gear remains excluded. Rigid armor and canopy marks follow their picked skin.
      if (!chosen || chosen.part.source || chosen.part.part.instances) continue;
      const { part, hit } = chosen, material = (part.part.attrs[part.part.indices[hit.triangle]] >>> 16) & 255;
      if (![0, 1, 3, 4, 6, 7].includes(material)) continue;
      const scars = t.scars.get(part.part.part) ?? [];
      const scar: TankSurfaceMark = { position: hit.position, normal: hit.normal, radius: Math.min(.34, .10 + impact.damage * .0025), opacity: .92, softness: .6, color: [.022, .018, .015], damage: impact.direct };
      scars.push(scar);
      if (impact.direct && impact.damage >= 5) {
        const joint = t.poser.pose.joints.get(part.part.joint);
        if (joint) mul4(t.world, joint, this.joint); else this.joint.set(t.world);
        const outward = normalize(transformDir(this.joint, hit.normal));
        for (const shard of armorSplinters(scar)) this.detach?.(shard, this.joint, t.tint,
          t.input.velocity.map((v, i) => v + outward[i] * (1.5 + Math.min(4, impact.damage * .05))) as V3);
        t.geometryDirty = true;
      }
      t.scars.set(part.part.part, scars);
      // Constant per-vehicle storage; prune the oldest group's scar deterministically.
      while ([...t.scars.values()].reduce((sum, items) => sum + items.length, 0) > SCAR_LIMIT) {
        for (const [group, items] of t.scars) if (items.length) { items.shift(); if (!items.length) t.scars.delete(group); break; }
      }
      // Retain the last rendered skin until update so simultaneous impacts can
      // all project onto it. Rebuild its bounded material data once per frame.
      t.surfaceDirty = true;
    }
  }

  beginAimPick(): void { this.pickWork.parts = this.pickWork.bounds = this.pickWork.triangles = this.pickMilliseconds = 0; }
  aimPickStats() { return { ...this.pickWork, milliseconds: this.pickMilliseconds }; }

  /** Frame the selected tank's current rendered parts, including animated turret and running gear. Only the
   * selected visible tank pays this cost; geometry bounds share the picking cache and never visit triangles. */
  screenBounds(id: number, project: (point: V3) => [number, number] | null): ScreenRect | null {
    const t = this.tanks.get(id);
    if (!t?.observed || !t.set) return null;
    const pose = t.poser.pose as unknown as Record<string, Float32Array>;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [partIndex, p] of t.set.parts.entries()) {
      const joint = t.poser.pose.joints.get(p.part.joint);
      if (joint) mul4(t.world, joint, this.joint); else this.joint.set(t.world);
      const transforms = p.source ? pose[p.source.buffer] : p.part.instances;
      const count = p.source ? p.source.count : transforms ? transforms.length / 12 : 1;
      const bounds = meshBounds(p.part);
      for (let sub = 0; sub < count; sub++) {
        if (this.brokenPart(t, partIndex, sub)) continue;
        if (transforms) mulAffine(this.joint, transforms, (p.source?.first ?? 0) + sub, this.scratch);
        else this.scratch.set(this.joint);
        for (let corner = 0; corner < 8; corner++) {
          const point = project(transformPoint(this.scratch, [bounds[corner & 1 ? 3 : 0], bounds[corner & 2 ? 4 : 1], bounds[corner & 4 ? 5 : 2]]));
          if (!point || !point.every(Number.isFinite)) continue;
          left = Math.min(left, point[0]); right = Math.max(right, point[0]);
          top = Math.min(top, point[1]); bottom = Math.max(bottom, point[1]);
        }
      }
    }
    if (!Number.isFinite(left)) return null;
    const width = Math.max(28, right - left + 12), height = Math.max(28, bottom - top + 12);
    return { x: (left + right - width) / 2, y: (top + bottom - height) / 2, width, height };
  }

  /** Exact last-rendered surface: reuse the active LOD and animated joint/instance matrices. Each local AABB is
   * cached; only intersected parts visit triangles. Callers must still supply an observer-visible living tank. */
  pickSurface(id: number, eye: V3, direction: V3, limit: number): number | null {
    const t = this.tanks.get(id);
    if (!t?.observed || !t.set) return null;
    const started = performance.now(), pose = t.poser.pose as unknown as Record<string, Float32Array>;
    let nearest = limit, found = false;
    for (const [partIndex, p] of t.set.parts.entries()) {
      const joint = t.poser.pose.joints.get(p.part.joint);
      if (joint) mul4(t.world, joint, this.joint); else this.joint.set(t.world);
      const transforms = p.source ? pose[p.source.buffer] : p.part.instances;
      const count = p.source ? p.source.count : transforms ? transforms.length / 12 : 1;
      for (let sub = 0; sub < count; sub++) {
        if (this.brokenPart(t, partIndex, sub)) continue;
        if (transforms) mulAffine(this.joint, transforms, (p.source?.first ?? 0) + sub, this.scratch);
        else this.scratch.set(this.joint);
        const distance = rayMeshDistance(p.part, this.scratch, eye, direction, nearest, this.pickWork);
        if (distance !== null) { nearest = distance; found = true; }
      }
    }
    this.pickMilliseconds += performance.now() - started;
    return found ? nearest : null;
  }

  /**
   * Sweep the entire loaded ground run in its belt orientation. Ground travel
   * anchors the grousers; lateral travel smears them into a lighter pressure scuff.
   * Parked contacts keep grass down without accumulating darker paint (MAX blend).
   * `include` limits the sweep to some tanks; the others keep their trails as they are.
   */
  trackStamps(state: GameSnapshot, include?: (tank: TankState) => boolean): SmcStamp[] {
    const out: SmcStamp[] = [];
    for (const tank of state.tanks) {
      if (include && !include(tank)) continue;
      const t = this.tanks.get(tank.id);
      if (!t || !t.observed) { if (t) t.trail = [null, null]; continue; }
      const r = t.assembly.running, w = t.world;
      // The hull's forward axis: transformDir(world, +Z) normalised, term for term.
      const fx = w[0] * 0 + w[4] * 0 + w[8] * 1, fy = w[1] * 0 + w[5] * 0 + w[9] * 1, fz = w[2] * 0 + w[6] * 0 + w[10] * 1, fl = hypot3(fx, fy, fz) || 1;
      const forward: V3 = [fx / fl, fy / fl, fz / fl];
      for (let side = 0; side < 2; side++) {
        const load = tank.trackContact?.[side] ?? 0;
        // Airborne or unloaded belts leave nothing (track-footprints: trackContact and a loaded road wheel).
        const susp = tank.wheelSuspension;
        let loaded = !susp;
        if (susp) for (let i = side * 4; i < Math.min(side * 4 + 4, susp.length); i++) if (susp[i] > 0.005) { loaded = true; break; }
        const stations = Math.max(0, Math.min(4, r.stations.length - side * 4));
        if (load < 0.05 || !loaded || !stations) { t.trail[side] = null; continue; }
        let zMin = Infinity, zMax = -Infinity, y = Infinity, radius = 0;
        for (let i = side * 4; i < side * 4 + stations; i++) { const s = r.stations[i]; zMin = Math.min(zMin, s.z); zMax = Math.max(zMax, s.z); y = Math.min(y, s.y0 - s.radius); radius = Math.max(radius, s.radius); }
        const x = (r.stations[side * 4].side ?? (side === 0 ? 1 : -1)) * r.halfSpacing, z = (zMin + zMax) * 0.5;
        const swept = sweepTrack({ center: [w[0] * x + w[4] * y + w[8] * z + w[12], w[1] * x + w[5] * y + w[9] * z + w[13], w[2] * x + w[6] * y + w[10] * z + w[14]], forward,
          halfLength: (zMax - zMin) * 0.5 + radius * 0.35, halfWidth: r.trackWidth / 2, load }, t.trail[side], TREAD_PITCH);
        for (const stamp of swept.stamps) out.push(stamp);
        t.trail[side] = swept.trail;
      }
    }
    return out;
  }

  /** Debug segments of every visible tank's rigid collision boxes (12 edges per box, world space). */
  debugSegments(state: GameSnapshot): Float32Array {
    const segs: number[] = [];
    const box = new Float64Array(16);
    for (const tank of state.tanks) {
      const t = this.tanks.get(tank.id);
      if (!t || !t.visible) continue;
      let boxes: readonly { center: V3; half: V3; rotation?: Q4 }[];
      try { boxes = tankHullBoxes(tank.loadout, tank); } catch { continue; }
      for (const b of boxes) {
        composeTRS(b.center, b.rotation ?? [0, 0, 0, 1], box);
        mul4(t.world, box, this.world);
        const c = (sx: number, sy: number, sz: number) => transformPoint(this.world, [sx * b.half[0], sy * b.half[1], sz * b.half[2]]);
        const corners = [c(-1, -1, -1), c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)];
        for (const [a, e] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) segs.push(...corners[a], ...corners[e]);
      }
    }
    return new Float32Array(segs);
  }

  stats(): TankViewStats {
    let visible = 0, instances = 0;
    const lods: number[] = [];
    for (const t of this.tanks.values()) { if (t.observed) { visible++; lods.push(t.lod); } instances += t.instances.length; }
    return { tanks: this.tanks.size, visible, instances, meshes: this.meshSets.size, lods };
  }

  /** Detached presentation-only snapshot for the workshop/game acceptance probe. */
  appearanceSnapshot(id = 0): TankAppearance | null {
    const tank = this.tanks.get(id);
    return tank ? structuredClone(tank.appearance) : null;
  }

  clear(): void {
    for (const t of this.tanks.values()) { this.invalidateSurface(t); this.dropCasters(t); t.lights.dispose(); t.rail.dispose(); }
    this.tanks.clear();
  }

  dispose(): void {
    this.clear();
    const casters = this.scene.get('sdfCasters');
    for (const bricks of this.casterBricks.values()) for (const b of bricks) { try { casters?.destroy(b.handle); } catch { /* engine already gone */ } }
    this.casterBricks.clear();
    const destroyed = new Set<number>();
    for (const set of this.meshSets.values()) for (const p of set.parts) {
      if (destroyed.has(p.mesh.id)) continue;
      destroyed.add(p.mesh.id);
      try { this.scene.meshes.destroy(p.mesh); } catch { /* engine already gone */ }
    }
    this.meshSets.clear();
  }
}

function normalize(v: readonly number[]): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
