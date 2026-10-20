/**
 * The solver chassis collider set, derived from the kit assembly (W1-PHY; plan §5.3). Pure and cached per assembly.
 *
 * - Hull-frame proxies (hull, glacis, fenders, …) become round cuboids, so edges slide over lips instead of snagging.
 * - The raised end gears (sprocket and idler, from `running`, which `KitAssembly.proxies` does not carry; CC-003)
 *   become round cuboids of gear radius + belt.
 * - The maximum-compression stops (`kitBumpStops`) become Z-aligned capsules with the same bottom and length.
 * - Turret- and cradle-frame proxies are articulated: re-posed from turretYaw / barrelPitch, and placed in a
 *   collision group that ignores static terrain, so the barrel can never pole-vault the hull.
 * Road wheels are not colliders: the suspension's ball casts own ordinary wheel contact.
 */
import type { Q4, V3 } from '../contracts';
import type { KitAssembly } from '../kit/types';
import { assembleKit, kitBumpStops } from '../kit/assembly';
import { CONTACT_GEOMETRY } from './tuning';
import { quatAxisAngle, quatMul, rotateInto, vec, type Quat, type Vec } from './vec';

export type ChassisParent = 'hull' | 'turret' | 'cradle';
export interface ChassisShape {
  readonly kind: 'box' | 'capsule'; readonly parent: ChassisParent; readonly source: string;
  /** Rest pose in the parent joint frame (hull-frame shapes: the hull frame). */
  readonly center: Readonly<V3>; readonly rotation: Readonly<Q4>;
  /** box: outer half extents and edge rounding; capsule: radius and segment half length along its local Y. */
  readonly half: Readonly<V3>; readonly border: number; readonly radius: number; readonly halfHeight: number;
}

const IDENTITY: Q4 = [0, 0, 0, 1];
const Y_TO_Z: Q4 = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // +90° about X: a capsule's Y axis onto Z
const rounded = (half: Readonly<V3>) => Math.min(CONTACT_GEOMETRY.border, CONTACT_GEOMETRY.borderShare * Math.min(half[0], half[1], half[2]));
const box = (parent: ChassisParent, source: string, center: Readonly<V3>, half: Readonly<V3>, rotation: Readonly<Q4> = IDENTITY, round = true): ChassisShape =>
  Object.freeze({ kind: 'box', parent, source, center: Object.freeze([...center] as V3), rotation: Object.freeze([...rotation] as Q4), half: Object.freeze([...half] as V3),
    border: round ? rounded(half) : 0, radius: 0, halfHeight: 0 });

const shapeCache = new WeakMap<KitAssembly, readonly ChassisShape[]>();
/** Hull-frame shapes first (static on the body), then the articulated turret and cradle shapes. */
export function chassisShapes(kit: KitAssembly): readonly ChassisShape[] {
  let shapes = shapeCache.get(kit);
  if (shapes) return shapes;
  // Accessories are cosmetic. Their authored proxy envelopes still serve kit validation and picking,
  // but combat contacts use the original antenna envelope so swapping a dish cannot change ramming.
  if (kit.loadout.utility !== 'antenna') {
    shapes = chassisShapes(assembleKit({ ...kit.loadout, utility: 'antenna' }));
    shapeCache.set(kit, shapes); return shapes;
  }
  const out: ChassisShape[] = [], articulated: ChassisShape[] = [];
  kit.proxies.forEach(({ box: proxy, parent }, i) => {
    const shape = box(parent, `proxy${i}`, proxy.center, proxy.half, proxy.rotation, parent === 'hull');
    (parent === 'hull' ? out : articulated).push(shape);
  });
  const { running } = kit, halfWidth = running.trackWidth / 2;
  for (const side of [1, -1] as const) for (const [name, gear] of [['sprocket', running.sprocket], ['idler', running.idler]] as const) {
    const half = gear.r + CONTACT_GEOMETRY.endGearBelt;
    out.push(box('hull', `${name}${side > 0 ? 'L' : 'R'}`, [side * running.halfSpacing, gear.y, gear.z], [halfWidth, half, half]));
  }
  kitBumpStops(kit).forEach((stop, i) => {
    const radius = Math.min(stop.half[0] * 2, stop.half[1]), halfHeight = Math.max(0, stop.half[2] - radius);
    const rotation = stop.rotation ? [0, 0, 0, 0] as Q4 : Y_TO_Z;
    if (stop.rotation) { const q = quatMul({ x: 0, y: 0, z: 0, w: 1 }, toQuat(stop.rotation), toQuat(Y_TO_Z)); rotation[0] = q.x; rotation[1] = q.y; rotation[2] = q.z; rotation[3] = q.w; }
    out.push(Object.freeze({ kind: 'capsule', parent: 'hull', source: `bumpStop${i}`, center: Object.freeze([...stop.center] as V3), rotation: Object.freeze(rotation),
      half: Object.freeze([...stop.half] as V3), border: 0, radius, halfHeight }));
  });
  shapes = Object.freeze([...out, ...articulated]);
  shapeCache.set(kit, shapes);
  return shapes;
}
const toQuat = (q: Readonly<Q4>): Quat => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

const reachCache = new WeakMap<KitAssembly, number>();
/** Radius about the hull origin that holds every chassis collider at any turret yaw and barrel pitch (bounding spheres
 * chained through the turret ring and trunnion frames). Two chassis farther apart than their summed reaches cannot
 * touch. Cached per assembly. */
export function chassisReach(kit: KitAssembly): number {
  let reach = reachCache.get(kit);
  if (reach !== undefined) return reach;
  const norm = (v: Readonly<V3>) => Math.hypot(v[0], v[1], v[2]);
  const ring = norm(kit.frames.turretRing.position), trunnion = norm(kit.frames.trunnion.position);
  reach = 0;
  for (const shape of chassisShapes(kit)) {
    const own = norm(shape.center) + (shape.kind === 'capsule' ? shape.halfHeight + shape.radius : norm(shape.half));
    reach = Math.max(reach, own + (shape.parent === 'hull' ? 0 : ring + (shape.parent === 'cradle' ? trunnion : 0)));
  }
  reachCache.set(kit, reach);
  return reach;
}

/** Reusable articulated-pose evaluator: the turret and cradle joint frames in the hull frame for a given aim. */
export class ArticulationPose {
  readonly turret = { position: vec(), rotation: { x: 0, y: 0, z: 0, w: 1 } as Quat };
  readonly cradle = { position: vec(), rotation: { x: 0, y: 0, z: 0, w: 1 } as Quat };
  private readonly yawAxis: Vec; private readonly pitchAxis: Vec;
  private readonly ringRotation: Quat; private readonly trunnionRotation: Quat;
  private readonly q = { x: 0, y: 0, z: 0, w: 1 } as Quat; private readonly v = vec();
  constructor(private readonly kit: KitAssembly) {
    const axis = (name: string, fallback: V3): Vec => { const a = kit.joints.find(j => j.name === name)?.axis ?? fallback, n = Math.hypot(...a); return vec(a[0] / n, a[1] / n, a[2] / n); };
    this.yawAxis = axis('turret', [0, 1, 0]); this.pitchAxis = axis('cradle', [-1, 0, 0]);
    this.ringRotation = toQuat(kit.frames.turretRing.rotation); this.trunnionRotation = toQuat(kit.frames.trunnion.rotation);
  }
  /** Turret = ring frame · yaw about the turret joint axis; cradle = turret · trunnion frame · pitch about the cradle
   * axis (positive pitch elevates the muzzle). Recoil never moves the colliders. */
  update(turretYaw: number, barrelPitch: number): this {
    const { turret, cradle, kit } = this, ring = kit.frames.turretRing.position, trunnion = kit.frames.trunnion.position;
    quatMul(turret.rotation, this.ringRotation, quatAxisAngle(this.q, this.yawAxis, turretYaw));
    turret.position.x = ring[0]; turret.position.y = ring[1]; turret.position.z = ring[2];
    rotateInto(this.v, turret.rotation, trunnion[0], trunnion[1], trunnion[2]);
    cradle.position.x = ring[0] + this.v.x; cradle.position.y = ring[1] + this.v.y; cradle.position.z = ring[2] + this.v.z;
    quatMul(cradle.rotation, turret.rotation, this.trunnionRotation);
    quatMul(cradle.rotation, cradle.rotation, quatAxisAngle(this.q, this.pitchAxis, barrelPitch));
    return this;
  }
  /** Hull-frame pose of an articulated shape at the last update(). */
  place(shape: ChassisShape, outPosition: Vec, outRotation: Quat): void {
    const frame = shape.parent === 'turret' ? this.turret : this.cradle;
    rotateInto(outPosition, frame.rotation, shape.center[0], shape.center[1], shape.center[2]);
    outPosition.x += frame.position.x; outPosition.y += frame.position.y; outPosition.z += frame.position.z;
    quatMul(outRotation, frame.rotation, toQuat(shape.rotation));
  }
}
