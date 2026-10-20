/**
 * Kit v2 part model (W1-KIT). Each part module (parts/{hulls,gear,turrets,weapons,utilities}/*.ts) exports a
 * spec (dimensions, sockets, mass boxes, stats) and a builder that emits geometry and validation pieces into
 * per-group `Shape`s. Groups are the rigid joints plus the instanced running-gear groups.
 */
import type { Shape } from '../geometry/shapes';
import type { SocketClass } from '../sockets';
import type { GearId, HullId, KitLoadout, KitPartStats, TurretId, UtilityId, WeaponId } from '../types';

export type { GearId, HullId, TurretId, UtilityId, WeaponId };
export type V3Like = [number, number, number];

/** Rigid groups (one joint each). `head` is the utility's moving part (antenna whip, radar head, periscope). */
export type RigidGroup = 'hull' | 'turret' | 'hatch' | 'cradle' | 'barrel' | 'head';
/** Instanced running-gear groups (all posed in the hull frame). `hubs` share the `wheels` instances. */
export type InstancedGroup = 'links' | 'wheels' | 'hubs' | 'sprockets' | 'idlers' | 'rollers' | 'arms' | 'bogies' | 'springs' | 'tensioners';
export type GroupId = RigidGroup | InstancedGroup;
export const RIGID_GROUPS: readonly RigidGroup[] = Object.freeze(['hull', 'turret', 'hatch', 'cradle', 'barrel', 'head']);
export const INSTANCED_GROUPS: readonly InstancedGroup[] = Object.freeze(['links', 'wheels', 'hubs', 'sprockets', 'idlers', 'rollers', 'arms', 'bogies', 'springs', 'tensioners']);

/** A solid box carrying a fraction of a part's mass, in the part's own frame (fractions sum to 1). */
export interface MassBox { center: V3Like; half: V3Like; fraction: number }

export interface PartCommon<Id extends string> {
  id: Id;
  name: string;
  /** Per-part stats (plan §3 / Experience §1.11); only the fields the part contributes are non-zero. */
  stats: Partial<KitPartStats> & { cost: number; mass: number };
  massBoxes: readonly MassBox[];
}

export interface GearSpec extends PartCommon<GearId> {
  /** Track centre-line |x|, belt width, road-wheel station half length. */
  halfSpacing: number;
  width: number;
  halfLength: number;
  /** Physics station wheel radius and rest centre height (4 stations per side). */
  wheelRadius: number;
  wheelY0: number;
  /**
   * Visual road wheels per side, rear→front: station index, z offset from the station, x offset from the track centre,
   * radius, width. A wheel smaller than the station radius rides with its hub lowered by the difference (hubDrop), so
   * its bottom (and the belt under it) stays on the physics station's contact.
   */
  wheels: readonly { station: number; dz: number; dx: number; radius: number; width: number }[];
  suspension: 'torsion' | 'bogie' | 'rocker';
  /** Torsion trailing arm length (pivot ahead of the station, at wheelY0). */
  armLength: number;
  /** Bogie / rocker half span between its two wheels. */
  rockerHalf: number;
  sprocket: { z: number; y: number; r: number; width: number; teeth: number };
  idler: { z: number; y: number; r: number; width: number };
  /** Idler tensioner arm: pivot offset (dz, dy) from the idler's rest centre; ±travel of the idler centre. */
  tensioner: { dz: number; dy: number; travel: number };
  rollers: readonly { z: number; y: number; r: number; width: number }[];
  /** Belt link pitch target (the link count is derived from the rest belt length). */
  linkPitch: number;
  /** Bracket bottom height of bogie springs (grip). */
  springTop: number;
  /** Visual wheel style. */
  wheelStyle: 'spoked' | 'disc' | 'dished' | 'aether' | 'forge';
}

export interface HullSpec extends PartCommon<HullId> {
  /** Shared mechanical architecture; fantasy shells author their own front and proportions. */
  archetype?: 'skiff' | 'warden' | 'bastion';
  frontProfile?: readonly (readonly [number, number])[];
  /** Glacis: from (deckFront, DECK_Y) down to the nose (z, y); lower glacis to (bellyFront, BELLY_Y). */
  deckFront: number;
  nose: [number, number];
  bellyFront: number;
  /** Rear: lower-hull rear plate z (from SPONSON_UNDERSIDE down to rearLow y), belly end z. */
  rear: number;
  rearLow: number;
  bellyRear: number;
  /** Upper hull (full width) rear z and the rear deck chamfer. */
  upperRear: number;
  /** Sponson overhang beyond the track outer edge. */
  overhang: number;
  /** Utility mounts (hull stat; W1 has one utility slot, on the turret). */
  utilityMounts: number;
  /** Exhaust outlets (hull frame): +Z of each frame points out of the pipe. */
  exhaustKind: 'stack' | 'rear';
  /** Fuel multiplier (Skiff +15%). */
  fuelMul: number;
}

export interface TurretSpec extends PartCommon<TurretId> {
  /** Trunnion position (turret frame) at the turret front face. */
  trunnion: V3Like;
  /** Joint elevation range over the front arc (radians). */
  elevation: [number, number];
  mantlet: 'sphere' | 'drum';
  /** Drum mantlet half width. */
  drumHalfWidth: number;
  /** Utility socket (turret frame). */
  utility: V3Like;
  /** Hatch hinge origin (turret frame), hinge axis and open angle; null for none. */
  hatch: { hinge: V3Like; axis: V3Like; open: number } | null;
  /** Turret HP bonus. */
  hpBonus: number;
}

export interface WeaponSpec extends PartCommon<WeaponId> {
  /** Trunnion-to-muzzle length (the muzzle frame is at z = barrelLength in the cradle frame). */
  barrelLength: number;
  /** Tube recoil travel at recoil 1 (only the tube recoils). */
  recoilTravel: number;
  /** Outer radius of the recoiling tube (≤ 0.075) and the visual bore radius. */
  tubeRadius: number;
  boreRadius: number;
  /** Fixed sleeve (cradle frame): radius and forward end. */
  sleeveRadius: number;
  sleeveEnd: number;
}

export interface UtilitySpec extends PartCommon<UtilityId> {
  /** Head joint kind (null: rigid only). */
  head: 'spring2' | 'spin' | 'pitch' | null;
  /** Head joint origin relative to the utility socket (turret frame). */
  headOrigin: V3Like;
  /** Sight bonus etc. are gameplay stats owned by GAME; kept here as documentation. */
  sight: number;
}

/** Everything a builder needs about the whole assembly. */
export interface KitContext {
  loadout: KitLoadout;
  hull: HullSpec;
  gear: GearSpec;
  turret: TurretSpec;
  weapon: WeaponSpec;
  utility: UtilitySpec;
  /** Derived shared dimensions. */
  ringClass: SocketClass;
  ringRadius: number;
  weaponClass: SocketClass;
  mantletRadius: number;
  /** Lower hull half width from the track channel: c − w/2 − 0.015. */
  lowerHalfWidth: number;
  /** Belt inner / outer edge |x|. */
  beltInner: number;
  beltOuter: number;
  /** Upper hull / sponson half width (belt outer edge + overhang). */
  upperHalfWidth: number;
  /** Highest belt top surface over the suspension range (topRunY). */
  topRunY: number;
  /** Trunnion in the hull frame at yaw 0. */
  trunnionHull: V3Like;
}

/** Output shapes per group for one part build. */
export type GroupShapes = { get(group: GroupId): Shape };

export interface PartModule<S> {
  spec: S;
  build(ctx: KitContext, out: GroupShapes): void;
}
